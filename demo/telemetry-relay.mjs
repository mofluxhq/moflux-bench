#!/usr/bin/env node
import { createTelemetryRelayServer } from "./telemetry-relay-lib.mjs";

const args = new Map();
for (const arg of process.argv.slice(2)) {
  const match = /^--([^=]+)=(.*)$/.exec(arg);
  if (match) args.set(match[1], match[2]);
}

const host = args.get("host") ?? "0.0.0.0";
const port = Number(args.get("port") ?? 8200);
if (!Number.isInteger(port) || port < 0 || port > 65535) {
  throw new Error("--port must be an integer from 0 to 65535");
}

const server = createTelemetryRelayServer();
await new Promise((resolve, reject) => {
  server.once("error", reject);
  server.listen(port, host, resolve);
});
const address = server.address();
const shownPort = address && typeof address !== "string" ? address.port : port;
console.log(`benchmark telemetry relay listening on ${host}:${shownPort}`);

for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, () => {
    server.close(() => process.exit(0));
  });
}
