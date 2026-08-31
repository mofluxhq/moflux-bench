# Security policy

## Reporting a vulnerability

Please use the repository's private GitHub security-advisory workflow instead of opening a public issue. Include the affected file or component, reproduction steps, impact, and any suggested mitigation. Do not include live credentials or proprietary Tyr/Latchflo images in the report.

## Scope

This repository contains a local synthetic benchmark harness. Tyr and Latchflo are proprietary components referenced only through user-supplied image names and local tokens. The example Docker configuration binds control-plane and Tyr ports to loopback, but it is not production hardening guidance.

The benchmark intentionally trusts `x-priority` in its controlled local Tyr configuration. Do not copy that setting into an untrusted deployment without authenticating and authorizing the caller.

Since MoFlux Bench 0.22.0, result JSON preserves Tyr rejection capacity snapshots. The harness does not copy request bodies or identity tokens into those records, but admission-class names, pool names, grant IDs, controller epochs, limits, and live capacity state are operational metadata. Treat benchmark result files as telemetry and review them before publishing results produced against non-synthetic deployments.

## Supported versions

Security fixes are applied to the latest released version of the benchmark harness. Historical curated results are evidence files and are not supported runtime artifacts.
