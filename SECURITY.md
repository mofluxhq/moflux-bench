# Security policy

## Reporting a vulnerability

Please use the repository's private GitHub security-advisory workflow instead of opening a public issue. Include the affected file or component, reproduction steps, impact, and any suggested mitigation. Do not include live credentials or proprietary Tyr/Latchflo images in the report.

## Scope

This repository contains a local synthetic benchmark harness. Tyr and Latchflo are proprietary components referenced only through user-supplied image names and local tokens. The example Docker configuration binds control-plane and Tyr ports to loopback, but it is not production hardening guidance.

The benchmark intentionally trusts `x-priority` in its controlled local Tyr configuration. Do not copy that setting into an untrusted deployment without authenticating and authorizing the caller.

## Supported versions

Security fixes are applied to the latest released version of the benchmark harness. Historical curated results are evidence files and are not supported runtime artifacts.
