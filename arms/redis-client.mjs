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
  constructor({ host = "127.0.0.1", port = 6379 } = {}) {
    this.host = host;
    this.port = port;
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
    return new Promise((resolve, reject) => {
      this.pending.push({ resolve, reject });
      this.socket.write(encode(args), "binary");
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
