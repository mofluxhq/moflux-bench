# Contributing

Thanks for helping improve `moflux-bench`.

## Development setup

Use Node.js 22 or newer. The public benchmark code has no runtime npm dependencies.

```bash
npm ci
npm run verify:all
```

Docker Compose v2 is required only for the public walkthrough and the licensed MoFlux presenter. The licensed stack is pinned to Tyr 0.20.0, Latchflo 0.7.0, async-bulkhead-llm 3.14.0, and async-bulkhead-ts 1.0.1. Tyr and Latchflo images are proprietary and are not accepted as repository contributions.

## Pull requests

Keep changes narrowly scoped and include a regression for behavior changes. Benchmark changes must preserve the distinction between generated output and curated evidence:

- Generated runs belong under `results/runs/` and remain ignored.
- Evidence intended for review belongs under `results/curated/` and must include methodology and provenance.
- Do not commit `.env` files, credentials, licensed images, private registry information, absolute local paths, or generated Docker state.
- Do not describe a configuration fingerprint as an identical request replay unless the trace hash and planned logical request counts also match.

Run `npm run verify:all` before opening a pull request. CI runs the same hygiene, syntax, regression, and simulator checks on every push and pull request.

## Reporting benchmark results

Do not publish a single run as representative evidence. Use at least five seeds, report medians with spread, retain raw paired evidence, and disclose synthetic-provider and real-clock limitations. Runs with `generator_saturated_total > 0` are invalid.
