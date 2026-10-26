import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { Platform, compile } from "../src/index.js";
import { runIsolated } from "../src/node/vm-runner.js";

const drive = (p, name, n, gap) => { const res = []; for (let i = 0; i < n; i++) { p.invoke(name, {}, (r) => res.push(r)); p.advance(gap); } p.advance(5); return res; };
test("first call is cold, following calls are warm", () => {
  const p = new Platform({ snapshots: false, prewarm: false }); p.deploy({ name: "f" });
  const r = drive(p, "f", 10, 1); assert.equal(r[0].kind, "cold"); assert.ok(r.slice(1).every((x) => x.kind === "warm")); assert.ok(r[0].latency > r[1].latency * 3);
});
test("snapshots make cold starts much cheaper than full boots", () => {
  const a = new Platform({ snapshots: false, prewarm: false }), b = new Platform({ snapshots: true, prewarm: false });
  a.deploy({ name: "f", runtime: "java21", memory: 1024 }); b.deploy({ name: "f", runtime: "java21", memory: 1024 }); b.advance(1);
  assert.ok(b.coldStart(b.fns.get("f")) * 5 < a.coldStart(a.fns.get("f")));
  const r = drive(b, "f", 1, 0.1); assert.equal(r[0].kind, "restored");
});
test("keep-alive expiry tears down idle VMs", () => {
  const p = new Platform({ keepAlive: 2, prewarm: false }); p.deploy({ name: "f" }); drive(p, "f", 1, 0.1);
  assert.equal(p.vms.length, 0); // drive advanced 5s > keepAlive
});
test("concurrency limits and tenant rate limits throttle with 429", () => {
  const p = new Platform({ prewarm: false }); p.tenant("acme", { concurrency: 3, rps: 1000 }); p.deploy({ name: "slow", tenant: "acme", handler: () => ({ ms: 500 }) });
  const out = []; for (let i = 0; i < 6; i++) p.invoke("slow", {}, (r) => out.push(r.status)); p.advance(3);
  assert.equal(out.filter((s) => s === 429).length, 3);
  const q = new Platform({ prewarm: false }); q.tenant("t", { rps: 5 }); q.deploy({ name: "g", tenant: "t" }); const st = []; for (let i = 0; i < 20; i++) q.invoke("g", {}, (r) => st.push(r.status)); q.advance(2);
  assert.ok(st.filter((s) => s === 429).length >= 14);
});
test("bin packing places VMs best-fit and evicts LRU idle VMs when full", () => {
  const p = new Platform({ hosts: 1, hostMem: 1024, prewarm: false, keepAlive: 999 });
  for (const n of ["a", "b", "c", "d"]) { p.deploy({ name: n, memory: 256 }); p.invoke(n); p.advance(2); }
  assert.equal(p.vms.length, 4); p.deploy({ name: "e", memory: 256 }); p.invoke("e"); p.advance(2);
  assert.equal(p.stats.evicted, 1); assert.ok(!p.vms.some((v) => v.fn === "a"), "oldest idle VM evicted");
});
test("new version retires old VMs; timeouts and handler errors", () => {
  const p = new Platform({ prewarm: false }); p.deploy({ name: "f" }); drive(p, "f", 2, 0.5);
  p.deploy({ name: "f", handler: () => { throw new Error("boom"); } }); const r = drive(p, "f", 1, 0.5)[0];
  assert.equal(r.status, 500); assert.ok(p.vms.every((v) => v.version === 2));
  p.deploy({ name: "t", timeout: 1, handler: () => ({ ms: 5000 }) }); assert.equal(drive(p, "t", 1, 0.1)[0].status, 504);
});
test("predictive pre-warm reduces cold starts under steady load", () => {
  const run = (prewarm) => { const p = new Platform({ prewarm, snapshots: false, seed: 4 }); p.deploy({ name: "api" }); for (let i = 0; i < 600; i++) { for (let k = 0; k < 4; k++) p.invoke("api"); p.advance(0.05); } return p.stats.cold; };
  assert.ok(run(true) <= run(false));
});
test("handlers run for real: compile() and the node:vm isolate", () => {
  const src = readFileSync(new URL("../examples/resize.js", import.meta.url), "utf8");
  assert.deepEqual(compile(src)({ width: 2000, height: 1000, max: 500 }, {}).body, { width: 500, height: 250, scale: 0.25 });
  const r = runIsolated(src, { width: 800, height: 600 }); assert.equal(r.result.body.width, 800); assert.match(r.logs[0], /resizing 800x600/);
  assert.throws(() => runIsolated("function handler(){ while(true){} }", {}, { timeoutMs: 50 }), /timed out/);
  assert.throws(() => runIsolated("function handler(){ return eval('1') }"), /Code generation from strings disallowed|EvalError/);
});
