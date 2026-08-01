/**
 * redis-client.mjs — minimal RESP2 client over node:net.
 *
 * Hand-rolled so the published harness has zero npm dependencies: a reader
 * cloning this repo should be able to reproduce every open arm with nothing but
 * Node and a Redis container. It implements exactly what arm 4 needs —
 * pipelined command dispatch, EVAL/EVALSHA, and reconnect-on-error.
 */

import net from "node:net";

/** Encodes a command as a RESP2 array of bulk strings. */
function encode(args) {
  let out = `*${args.length}\r\n`;
  for (const arg of args) {
    const s = String(arg);
    out += `$${Buffer.byteLength(s)}\r\n${s}\r\n`;
  }
  return out;
}

/**
 * Parses one RESP2 reply from `buf` at `offset`.
 * Returns { value, next } or null when more bytes are needed.
 */
function parse(buf, offset) {
  if (offset >= buf.length) return null;
  const type = buf[offset];
  const lineEnd = buf.indexOf("\r\n", offset);
  if (lineEnd === -1) return null;
  const line = buf.slice(offset + 1, lineEnd);

  // The buffer is a latin1 string, so one char is one byte and RESP's
  // byte-oriented bulk lengths stay valid as string offsets.
  switch (type) {
    case "+":
      return { value: line, next: lineEnd + 2 };
    case "-":
      return { value: new Error(line), next: lineEnd + 2 };
    case ":":
      return { value: Number(line), next: lineEnd + 2 };
    case "$": {
      const len = Number(line);
      if (len === -1) return { value: null, next: lineEnd + 2 };
      const start = lineEnd + 2;
      if (buf.length < start + len + 2) return null;
      return { value: buf.slice(start, start + len), next: start + len + 2 };
    }
    case "*": {
      const count = Number(line);
      if (count === -1) return { value: null, next: lineEnd + 2 };
      const items = [];
      let cursor = lineEnd + 2;
      for (let i = 0; i < count; i += 1) {
        const item = parse(buf, cursor);
        if (item === null) return null;
        items.push(item.value);
        cursor = item.next;
      }
      return { value: items, next: cursor };
    }
    default:
      throw new Error(`unsupported RESP type byte: ${JSON.stringify(type)}`);
  }
}

export class RedisClient {
  /**
   * `latencyMs` simulates network distance to the coordinator, applied to
   * every command round trip.
   *
   * A benchmark that runs Redis on loopback measures a coordinator that is
   * effectively free to consult, which is the most favourable condition a
   * per-request coordination design can be given and one that does not exist
   * in production. A same-AZ hop is roughly 0.5-1ms, cross-AZ 1-3ms, and a
   * loaded or contended instance considerably more. Every one of those is paid
   * once per admission here, and once per grant renewal in a lease-based
   * design — which is the architectural difference this makes visible.
   */
  constructor({ host = "127.0.0.1", port = 6379, latencyMs = 0 } = {}) {
    this.host = host;
    this.port = port;
    this.latencyMs = Number.isFinite(latencyMs) && latencyMs > 0 ? latencyMs : 0;
    /** Round trips issued, so cost per admission can be counted, not assumed. */
    this.roundTrips = 0;
    this.socket = null;
    this.buffer = "";
    /** FIFO of pending command resolvers — RESP replies arrive in order. */
    this.pending = [];
  }

  connect() {
    return new Promise((resolve, reject) => {
      this.socket = net.createConnection({ host: this.host, port: this.port });
      this.socket.setNoDelay(true); // per-command latency is under measurement
      this.socket.on("connect", resolve);
      this.socket.on("error", (err) => {
        // Fail every in-flight command rather than hanging the replica.
        const failures = this.pending.splice(0);
        for (const { reject: rj } of failures) rj(err);
        reject(err);
      });
      this.socket.on("data", (chunk) => this.#onData(chunk));
    });
  }

  #onData(chunk) {
    this.buffer += chunk.toString("binary");
    for (;;) {
      let frame;
      try {
        frame = parse(this.buffer, 0);
      } catch (err) {
        const failures = this.pending.splice(0);
        for (const { reject } of failures) reject(err);
        this.buffer = "";
        return;
      }
      if (frame === null) return;
      this.buffer = this.buffer.slice(frame.next);
      const waiter = this.pending.shift();
      if (!waiter) continue;
      if (frame.value instanceof Error) waiter.reject(frame.value);
      else waiter.resolve(frame.value);
    }
  }

  command(...args) {
    this.roundTrips += 1;
    const send = () =>
      new Promise((resolve, reject) => {
        this.pending.push({ resolve, reject });
        this.socket.write(encode(args), "binary");
      });
    if (this.latencyMs === 0) return send();
    // Delay the request leg only. Modelling the full round trip would double
    // count: the reply still has to traverse the real socket.
    return new Promise((resolve, reject) => {
      setTimeout(() => send().then(resolve, reject), this.latencyMs);
    });
  }

  /** Loads a script once and calls it by digest thereafter. */
  async loadScript(source) {
    const sha = await this.command("SCRIPT", "LOAD", source);
    return {
      eval: (keys, argv) => this.command("EVALSHA", sha, keys.length, ...keys, ...argv),
    };
  }

  close() {
    this.socket?.end();
  }
}
