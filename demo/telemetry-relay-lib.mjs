import { createServer } from "node:http";

const DEFAULT_MAX_BODY_BYTES = 2 * 1024 * 1024;

function text(res, status, body) {
  res.writeHead(status, {
    "content-type": "text/plain; charset=utf-8",
    "content-length": Buffer.byteLength(body),
  });
  res.end(body);
}

function metricMetadataKey(line) {
  const match = /^#\s+(HELP|TYPE)\s+([^\s]+)\s+/.exec(line);
  return match ? `${match[1]}:${match[2]}` : null;
}

export function mergePrometheusSnapshots(snapshots) {
  const metadata = new Map();
  const samples = [];

  for (const snapshot of snapshots) {
    for (const rawLine of snapshot.split(/\r?\n/)) {
      const line = rawLine.trim();
      if (!line) continue;
      const key = metricMetadataKey(line);
      if (key) {
        if (!metadata.has(key)) metadata.set(key, line);
        continue;
      }
      if (line.startsWith("#")) continue;
      samples.push(line);
    }
  }

  return [...metadata.values(), ...samples].join("\n") + "\n";
}

export function createTelemetryRelayServer({ maxBodyBytes = DEFAULT_MAX_BODY_BYTES } = {}) {
  const snapshots = new Map();
  let rejectedIngests = 0;

  return createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://127.0.0.1");

    if (req.method === "GET" && url.pathname === "/healthz") {
      return text(res, 200, "ok\n");
    }

    if (req.method === "DELETE" && url.pathname === "/metrics") {
      snapshots.clear();
      res.writeHead(204).end();
      return;
    }

    if (req.method === "POST" && url.pathname === "/ingest") {
      const run = url.searchParams.get("run")?.trim() ?? "";
      if (!run || run.length > 200) {
        rejectedIngests += 1;
        return text(res, 400, "missing or invalid run key\n");
      }

      const chunks = [];
      let bytes = 0;
      let tooLarge = false;
      req.on("data", (chunk) => {
        bytes += chunk.length;
        if (bytes > maxBodyBytes) {
          tooLarge = true;
          req.destroy();
          return;
        }
        chunks.push(chunk);
      });
      req.on("end", () => {
        if (tooLarge) {
          rejectedIngests += 1;
          return;
        }
        const body = Buffer.concat(chunks).toString("utf8");
        if (!body.includes("# TYPE") || !body.includes("bench_")) {
          rejectedIngests += 1;
          return text(res, 400, "body is not benchmark Prometheus exposition\n");
        }
        snapshots.set(run, body);
        res.writeHead(204).end();
      });
      req.on("error", () => {
        rejectedIngests += 1;
      });
      return;
    }

    if (req.method === "GET" && url.pathname === "/metrics") {
      const body = mergePrometheusSnapshots(snapshots.values());
      const own = [
        "# HELP bench_telemetry_relay_snapshots Number of retained benchmark run snapshots.",
        "# TYPE bench_telemetry_relay_snapshots gauge",
        `bench_telemetry_relay_snapshots ${snapshots.size}`,
        "# HELP bench_telemetry_relay_rejected_ingests_total Invalid telemetry payloads rejected by the relay.",
        "# TYPE bench_telemetry_relay_rejected_ingests_total counter",
        `bench_telemetry_relay_rejected_ingests_total ${rejectedIngests}`,
        "",
      ].join("\n");
      res.writeHead(200, {
        "content-type": "text/plain; version=0.0.4; charset=utf-8",
        "content-length": Buffer.byteLength(body + own),
      });
      res.end(body + own);
      return;
    }

    text(res, 404, "not found\n");
  });
}
