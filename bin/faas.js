#!/usr/bin/env node
import { readFileSync } from "node:fs";
import { Platform } from "../src/index.js";
import { runIsolated } from "../src/node/vm-runner.js";
import { c, table, header, fail, spark } from "../src/lib/cli.js";

const [cmd, ...rest] = process.argv.slice(2);
const flag = (n, d) => { const i = rest.indexOf("--" + n); return i >= 0 ? rest[i + 1] : d; };
const has = (n) => rest.includes("--" + n);
const pos = rest.filter((x, i) => !x.startsWith("--") && !(rest[i - 1] || "").startsWith("--"));
const HELP = `${c.bold("faas")} — Prism FaaS serverless orchestrator

  faas run <handler.js> [--event '{"width":4000}'] [--timeout 1000]
                                 execute a handler in an isolated V8 context
  faas load [--rps 120] [--seconds 60] [--runtime node20] [--memory 512] [--no-snapshots] [--no-prewarm]
                                 simulate bursty traffic, report cold starts, latency, cost
  faas compare [--runtime java21] compare baseline vs snapshots vs pre-warm
`;
const avg = (a) => (a.length ? a.reduce((x, y) => x + y, 0) / a.length : 0);
function load({ rps = 120, seconds = 60, runtime = "node20", memory = 512, snapshots = true, prewarm = true, seed = 7 }) {
  const p = new Platform({ hosts: 6, hostMem: 16384, snapshots, prewarm, seed, keepAlive: 20 }); p.tenant("acme", { concurrency: 400, rps: 5000 });
  p.deploy({ name: "api", tenant: "acme", runtime, memory }); p.deploy({ name: "thumbs", tenant: "acme", runtime, memory: memory * 2, handler: () => ({ ms: 180 + Math.random() * 120 }) });
  p.advance(1); const dt = 0.05, curve = [];
  for (let t = 0; t < seconds; t += dt) { const burst = Math.sin(t / 7) > 0.6 ? 4 : 1, lam = rps * burst * dt; let n = Math.floor(lam) + (Math.random() < lam % 1 ? 1 : 0); while (n--) p.invoke(Math.random() < 0.8 ? "api" : "thumbs"); p.advance(dt); if (Math.round(t / dt) % 20 === 0) curve.push(p.vms.length); }
  p.advance(5); const s = p.stats, done = s.cold + s.restored + s.warm;
  return { p, s, done, coldPct: (s.cold + s.restored) / Math.max(1, done), p50: p.percentile(0.5, 0, "api"), p99: p.percentile(0.99, 0, "api"), p999: p.percentile(0.999, 0, "api"), coldMs: avg(p.lat.filter((x) => x.startup).map((x) => x.startup)), cost: s.gbSeconds * 0.0000166667 + (s.invocations / 1e6) * 0.2, curve };
}
try {
  if (!cmd || cmd === "-h" || cmd === "--help") console.log(HELP);
  else if (cmd === "run") {
    const f = pos[0] || fail("usage: faas run <handler.js>"), ev = JSON.parse(flag("event", "{}"));
    const r = runIsolated(readFileSync(f, "utf8"), ev, { timeoutMs: +flag("timeout", 1000), context: { vm: "vm-local", fn: f } });
    console.log(header(f, `isolated V8 context · ${r.ms.toFixed(2)}ms`) + "\n"); for (const l of r.logs) console.log(c.dim("  log │ ") + l); console.log(JSON.stringify(r.result, null, 2));
  } else if (cmd === "load") {
    const o = { rps: +flag("rps", 120), seconds: +flag("seconds", 60), runtime: flag("runtime", "node20"), memory: +flag("memory", 512), snapshots: !has("no-snapshots"), prewarm: !has("no-prewarm") };
    const r = load(o); console.log(header("load test", `${o.rps} rps base · bursts ×4 · ${o.seconds}s · ${o.runtime} ${o.memory}MB`) + "\n");
    console.log(table([["invocations", r.s.invocations.toLocaleString()], ["served", r.done.toLocaleString()], ["cold + restored", `${r.s.cold} + ${r.s.restored} (${(r.coldPct * 100).toFixed(2)}%)`], ["throttled (429)", r.s.throttled], ["api p50 / p99 / p99.9", `${r.p50.toFixed(1)} / ${r.p99.toFixed(1)} / ${r.p999.toFixed(1)}ms`], ["avg cold start", r.coldMs.toFixed(1) + "ms"], ["peak VMs", Math.max(...r.curve)], ["VM count", spark(r.curve)], ["GB-seconds", r.s.gbSeconds.toFixed(1)], ["est. cost", "$" + r.cost.toFixed(4)]]));
  } else if (cmd === "compare") {
    const runtime = flag("runtime", "java21"), rows = [];
    for (const [label, snapshots, prewarm] of [["baseline", false, false], ["snapshots", true, false], ["pre-warm", false, true], ["snapshots + pre-warm", true, true]]) { const r = load({ runtime, snapshots, prewarm, seconds: 120 }); rows.push([label, (r.coldPct * 100).toFixed(2) + "%", r.coldMs.toFixed(0) + "ms", r.p99.toFixed(1) + "ms", (r.p999 > 500 ? c.red : r.p999 > 150 ? c.yellow : c.green)(r.p999.toFixed(1) + "ms"), Math.max(...r.curve), "$" + r.cost.toFixed(4)]); }
    console.log(header("cold-start strategies", `${runtime} · bursty traffic · 120s`) + "\n"); console.log(table(rows, { head: ["strategy", "cold %", "cold start", "api p99", "api p99.9", "peak VMs", "cost"] }));
  } else fail(`unknown command "${cmd}"\n\n${HELP}`);
} catch (e) { fail(e.message); }
