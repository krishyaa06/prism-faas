// Serverless orchestrator on a virtual clock: function registry with versions/aliases, MicroVM fleet with
// best-fit bin packing, warm pools with keep-alive, cold starts vs snapshot restores, per-tenant quotas,
// throttling, predictive pre-warming and GB-second billing.
import { Heap } from "./lib/heap.js";
import { rng } from "./lib/rng.js";

export const COLD = { boot: 0.125, runtime: { node20: 0.18, python312: 0.24, java21: 0.9 }, perMB: 0.00012, restore: 0.018 };
let vmSeq = 0;
export class Platform {
  constructor({ hosts = 4, hostMem = 8192, seed = 1, keepAlive = 30, snapshots = true, prewarm = true, accountConcurrency = 200 } = {}) {
    this.r = rng(seed); this.now = 0; this.q = new Heap((a, b) => a.at - b.at || a.s - b.s); this.s = 0;
    this.hosts = Array.from({ length: hosts }, (_, i) => ({ id: `host-${i + 1}`, mem: hostMem, vms: [] }));
    this.fns = new Map(); this.tenants = new Map(); this.vms = []; this.lat = []; this.listeners = [];
    Object.assign(this, { keepAlive, snapshots, prewarm, accountConcurrency });
    this.stats = { invocations: 0, cold: 0, restored: 0, warm: 0, throttled: 0, errors: 0, gbSeconds: 0, evicted: 0 };
  }
  on(fn) { this.listeners.push(fn); } emit(e) { for (const l of this.listeners) l(e); }
  at(d, fn) { this.q.push({ at: this.now + d, s: this.s++, fn }); }
  advance(dt) { const end = this.now + dt; while (this.q.size && this.q.peek().at <= end) { const t = this.q.pop(); this.now = t.at; t.fn(); } this.now = end; this.reap(); }

  tenant(name, { concurrency = 100, rps = 500 } = {}) { const t = { name, concurrency, rps, tokens: rps, last: 0, inflight: 0 }; this.tenants.set(name, t); return t; }
  deploy({ name, tenant = "default", memory = 256, timeout = 10, runtime = "node20", reserved = 0, maxConcurrency = 50, handler = null, codeSize = 2 }) {
    if (!this.tenants.has(tenant)) this.tenant(tenant);
    const prev = this.fns.get(name), version = (prev?.version || 0) + 1;
    const fn = { name, tenant, memory, timeout, runtime, reserved, maxConcurrency, handler, codeSize, version, aliases: { ...(prev?.aliases || {}), latest: version }, inflight: 0, rate: 0, arrivals: 0, snapshot: false, lastP: 0 };
    this.fns.set(name, fn); this.emit({ type: "deploy", fn: name, version });
    // retire VMs from the old version (they finish in-flight work first)
    for (const vm of [...this.vms]) if (vm.fn === name && vm.version !== version) { if (vm.state === "idle") this.kill(vm, "new version"); else vm.retire = true; }
    if (this.snapshots) this.at(0.4, () => { fn.snapshot = true; this.emit({ type: "snapshot", fn: name, version }); });
    return fn;
  }
  coldStart(fn) { const rt = COLD.runtime[fn.runtime] ?? 0.2; return fn.snapshot ? COLD.boot * 0.1 + COLD.restore + fn.memory * COLD.perMB * 0.2 : COLD.boot + rt + fn.codeSize * 0.02 + fn.memory * COLD.perMB; }
  /** best-fit: host with the least free memory that still fits */
  place(mem) { let best = null, bf = Infinity; for (const h of this.hosts) { const free = h.mem - h.vms.reduce((s, v) => s + v.mem, 0); if (free >= mem && free - mem < bf) { bf = free - mem; best = h; } } return best; }
  evictOne(mem) { // LRU idle VM eviction to make room
    const idle = this.vms.filter((v) => v.state === "idle").sort((a, b) => a.idleSince - b.idleSince);
    for (const v of idle) { this.kill(v, "evicted"); this.stats.evicted++; const h = this.place(mem); if (h) return h; } return null;
  }
  spawn(fn, reason) {
    const host = this.place(fn.memory) || this.evictOne(fn.memory); if (!host) return null;
    const vm = { id: `vm-${(++vmSeq).toString(36)}`, fn: fn.name, version: fn.version, mem: fn.memory, host: host.id, state: "booting", born: this.now, uses: 0, idleSince: this.now, restored: fn.snapshot, reason };
    host.vms.push(vm); this.vms.push(vm); return vm;
  }
  kill(vm, why) { vm.state = "dead"; const h = this.hosts.find((x) => x.id === vm.host); h.vms = h.vms.filter((v) => v !== vm); this.vms = this.vms.filter((v) => v !== vm); this.emit({ type: "vm-stop", vm: vm.id, fn: vm.fn, why }); }
  takeToken(t) { const el = this.now - t.last; t.tokens = Math.min(t.rps, t.tokens + el * t.rps); t.last = this.now; if (t.tokens < 1) return false; t.tokens -= 1; return true; }
  /** Invoke a function. cb receives { status, latency, cold, vm, result } */
  invoke(name, payload = {}, cb = () => {}) {
    const fn = this.fns.get(name); if (!fn) return cb({ status: 404, error: "function not found" });
    const t = this.tenants.get(fn.tenant), t0 = this.now; this.stats.invocations++; fn.arrivals++;
    const total = this.vms.filter((v) => v.state === "busy" || v.state === "booting").length;
    if (!this.takeToken(t)) return this.throttle(fn, cb, "tenant rate limit");
    if (fn.inflight >= fn.maxConcurrency) return this.throttle(fn, cb, "function concurrency");
    if (t.inflight >= t.concurrency) return this.throttle(fn, cb, "tenant concurrency");
    if (total >= this.accountConcurrency) return this.throttle(fn, cb, "account concurrency");
    let vm = this.vms.filter((v) => v.fn === name && v.version === fn.version && v.state === "idle" && !v.retire).sort((a, b) => b.idleSince - a.idleSince)[0]; // MRU keeps the pool small
    let startup = 0, kind = "warm";
    if (!vm) { vm = this.spawn(fn, "invoke"); if (!vm) return this.throttle(fn, cb, "no capacity"); startup = this.coldStart(fn); kind = vm.restored ? "restored" : "cold"; }
    fn.inflight++; t.inflight++; vm.state = startup ? "booting" : "busy";
    const run = () => {
      vm.state = "busy"; vm.uses++; vm.started = this.now;
      let result = null, status = 200, dur;
      try { const out = fn.handler ? fn.handler(payload, { fn: name, version: fn.version, vm: vm.id, cold: kind !== "warm" }) : null; result = out?.body ?? out; dur = out?.ms != null ? out.ms / 1000 : 0.012 + this.r.exp(1 / 0.012); }
      catch (e) { status = 500; result = { error: e.message }; dur = 0.005; this.stats.errors++; }
      if (dur > fn.timeout) { dur = fn.timeout; status = 504; result = { error: `timed out after ${fn.timeout}s` }; }
      this.at(dur, () => {
        fn.inflight--; t.inflight--; fn.svc = (fn.svc ?? dur) * 0.95 + dur * 0.05; vm.state = "idle"; vm.idleSince = this.now; const latency = this.now - t0;
        this.stats.gbSeconds += (fn.memory / 1024) * (dur + (kind === "warm" ? 0 : startup)); this.stats[kind]++;
        this.lat.push({ t: this.now, ms: latency * 1000, kind, fn: name, startup: kind === "warm" ? 0 : startup * 1000 }); if (this.lat.length > 40000) this.lat.splice(0, 10000);
        if (vm.retire) this.kill(vm, "new version");
        this.emit({ type: "done", fn: name, kind, ms: latency * 1000, status, vm: vm.id }); cb({ status, latency, kind, vm: vm.id, result });
      });
    };
    if (startup) { this.emit({ type: "cold", fn: name, kind, ms: startup * 1000, vm: vm.id, host: vm.host }); this.at(startup, run); } else run();
  }
  throttle(fn, cb, why) { this.stats.throttled++; this.emit({ type: "throttle", fn: fn.name, why }); cb({ status: 429, error: `throttled: ${why}` }); }
  /** keep-alive expiry + reserved/predictive warm pool */
  reap() {
    for (const vm of [...this.vms]) if (vm.state === "idle" && this.now - vm.idleSince > this.keepAlive) this.kill(vm, "keep-alive expired");
    if (this.now - (this._lastScale || 0) < 0.5) return; const dt = this.now - (this._lastScale || 0); this._lastScale = this.now;
    for (const fn of this.fns.values()) {
      fn.rate = fn.rate * 0.7 + (fn.arrivals / dt) * 0.3; fn.arrivals = 0;
      // predictive: remember recent peaks (decaying) so recurring bursts find warm capacity
      fn.peak = Math.max((fn.peak || 0) * Math.pow(0.99, dt / 0.5), fn.rate);
      const svc = fn.svc || 0.05, want = Math.max(fn.reserved, this.prewarm ? Math.ceil(fn.peak * svc * 1.3) : 0);
      const have = this.vms.filter((v) => v.fn === fn.name && v.version === fn.version && !v.retire).length;
      for (let i = have; i < Math.min(want, fn.maxConcurrency); i++) { const vm = this.spawn(fn, "prewarm"); if (!vm) break; this.emit({ type: "prewarm", fn: fn.name, vm: vm.id }); this.at(this.coldStart(fn), () => { if (vm.state === "booting") { vm.state = "idle"; vm.idleSince = this.now; } }); }
    }
  }
  percentile(p, since = 0, fn = null) { const a = this.lat.filter((x) => x.t >= since && (!fn || x.fn === fn)).map((x) => x.ms).sort((x, y) => x - y); return a.length ? a[Math.min(a.length - 1, Math.floor(p * a.length))] : 0; }
  utilization() { const tot = this.hosts.reduce((s, h) => s + h.mem, 0); return this.vms.reduce((s, v) => s + v.mem, 0) / tot; }
}
/** Browser-safe sandboxed handler compiler (strict mode, no outer scope). In Node, prefer src/node/vm-runner.js. */
export function compile(source) {
  // eslint-disable-next-line no-new-func
  const factory = new Function("\"use strict\"; const module = { exports: {} }; const exports = module.exports;\n" + source + "\n;return module.exports.handler || (typeof handler === 'function' ? handler : null);");
  const h = factory(); if (typeof h !== "function") throw new Error("source must define handler(event, context)"); return h;
}
