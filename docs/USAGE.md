# Prism FaaS — Usage

## Install

```bash
npm install github:krishyaa06/prism-faas
# or run the CLI directly
npx github:krishyaa06/prism-faas --help
```

## JavaScript API

```js
import { Platform, compile } from "prism-faas";

const p = new Platform({ hosts: 4, hostMem: 8192, keepAlive: 30, snapshots: true });
p.tenant("acme", { concurrency: 100, rps: 500 });

p.deploy({
  name: "resize", tenant: "acme", runtime: "node20", memory: 1024, timeout: 10,
  handler: compile(`function handler(e) { return { body: { ok: true, w: e.w / 2 } } }`),
});

p.invoke("resize", { w: 4000 }, (r) => console.log(r.status, r.kind, r.result));
p.advance(2);                       // virtual seconds
console.log(p.stats, p.percentile(0.99));

// Node: real isolation with a CPU timeout
import { runIsolated } from "prism-faas/src/node/vm-runner.js";
runIsolated(source, { w: 4000 }, { timeoutMs: 500 });
```

| Export | What it does |
|---|---|
| `new Platform({ hosts, hostMem, keepAlive, snapshots, prewarm, accountConcurrency, seed })` | Orchestrator on a virtual clock |
| `platform.tenant(name, { concurrency, rps })` | Tenant quotas |
| `platform.deploy({ name, tenant, runtime, memory, timeout, reserved, maxConcurrency, handler })` | Register a new version |
| `platform.invoke(name, event, cb)` | `cb({ status, latency, kind: cold/restored/warm, vm, result })` |
| `platform.advance(dt)` | Advance virtual time |
| `platform.coldStart(fn)` · `percentile(p, since, fn)` · `utilization()` · `stats` | Metrics |
| `compile(source)` | Browser-safe handler compiler |
| `runIsolated(source, event, { timeoutMs })` | Node-only `node:vm` isolate (`src/node/vm-runner.js`) |

## CLI

```bash
$ npx github:krishyaa06/prism-faas run examples/resize.js --event '{"width":4000,"height":3000}'
$ npx github:krishyaa06/prism-faas load --rps 120 --seconds 60 --runtime java21
$ npx github:krishyaa06/prism-faas load --no-snapshots --no-prewarm
$ npx github:krishyaa06/prism-faas compare --runtime java21
```

| Command | Description |
|---|---|
| `faas run <handler.js> [--event json] [--timeout ms]` | Execute a handler in an isolated context |
| `faas load [--rps] [--seconds] [--runtime] [--memory] [--no-snapshots] [--no-prewarm]` | Bursty load test with latency, cold starts and cost |
| `faas compare [--runtime]` | Baseline vs snapshots vs pre-warm |

## Live simulator

Open [https://krishyaa06.github.io/prism-faas/](https://krishyaa06.github.io/prism-faas/) or serve the repo root locally (`npx serve .`). The simulator imports the same modules from `src/`.
