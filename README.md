# Evidence for oll4com/spaceapp#61

This is the evidence for the pull request from `New2thisshit:submit/otlp-61`, commit `133ac05b1901ba8273f6565c3dcf0a3a336bae87` (tree `a6c17eafefc40a0c1c9d86d0dffb216165e6e517`). It is not code.

| File | What it is |
|---|---|
| `jaeger-trace-screenshot.png` | Jaeger UI showing trace `4c938dc351129ef2d7457dfb1423b488`: the API request, then `codexAppServerTurnWorkflow`, then activity attempt 1 (`FAILED`, `TOOL_UNAVAILABLE`) and attempt 2 (`COMPLETED`) |
| `jaeger-trace.json` | The unchanged response body of the local Jaeger `/api/traces/4c938dc351129ef2d7457dfb1423b488`. SHA-256 `815b35d707250d3c120f60f25d87ddb23d15c533aa1a060dc139bc04118115fc` |
| `run-jaeger-acceptance.mjs` | The synthetic acceptance script that produced it. SHA-256 `6c05b3bca25e7e5084864c1252e821c970343ff349ef678d5cf65cb44d4a8873` |

## How it was captured

- **When:** 19 October 2026, 19:40 UTC.
- **Code:** commit `133ac05`.
- **Setup:**
  - Jaeger all-in-one (`jaegertracing/all-in-one:latest`), with OTLP/HTTP on `127.0.0.1:4318`;
  - the Temporal SDK test server;
  - Node 22.23.3 on Linux (WSL2).
- **What the script does:**
  - starts the production API observability hooks and the production `workflows.ts` with the worker tracing interceptor;
  - uses an activity stub that fails attempt 1 with `TOOL_UNAVAILABLE` and completes attempt 2.

**Command**, run from a new folder:

```sh
SPACEAPP_REPO=<checkout> SPACE_OTEL_EXPORTER_OTLP_ENDPOINT=http://127.0.0.1:4318 \
SPACEAPP_JAEGER_URL=http://127.0.0.1:16686 \
node --import <checkout>/node_modules/tsx/dist/loader.mjs ./run-jaeger-acceptance.mjs
```

The script exited 0. Its assertions, all checked against the raw Jaeger response:

- exactly 4 spans in one trace;
- the API span is the root;
- the workflow's parent is the API span;
- both attempts are children of the workflow;
- attempt 1 is `FAILED` with `TOOL_UNAVAILABLE`, and attempt 2 is `COMPLETED`;
- the synthetic prompt, error and output strings are absent.

**About the timestamps.** Spans take their times from different clocks: the API's process time origin, the worker's wall clock and Temporal's workflow clock. In this capture the API clock lagged by about 2 s, so the workflow bar appears to start late and outlast the request. Parent IDs are unaffected.
