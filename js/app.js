import { Platform, compile } from "../src/index.js";
import { $, h, esc, fmt, toast, Loop, bindLoop, LogView, Kpis, Chart, fit, css, hexA } from "./pro.js";

const SRC = `// runs for real in your browser (strict mode, isolated scope)
function handler(event, context) {
  const { width = 4000, height = 3000, max = 1024 } = event;
  const k = Math.min(1, max / Math.max(width, height));
  return {
    body: { width: Math.round(width * k), height: Math.round(height * k),
            vm: context.vm, cold: context.cold, version: context.version },
    ms: 40 + Math.random() * 60,   // simulated I/O time
  };
}`;
$("#code").value = SRC;
const P = new Platform({ hosts: 4, hostMem: 6144, seed: 3, keepAlive: 12 });
P.tenant("acme", { concurrency: 120, rps: 2000 }); P.tenant("globex", { concurrency: 25, rps: 150 });
const FN = [
  { name: "checkout-api", tenant: "acme", runtime: "node20", memory: 256, base: 22 },
  { name: "resize-image", tenant: "acme", runtime: "node20", memory: 1024, base: 5, handler: compile(SRC) },
  { name: "pdf-render", tenant: "acme", runtime: "java21", memory: 1536, base: 1.6, handler: () => ({ ms: 350 + Math.random() * 300 }) },
  { name: "ml-score", tenant: "globex", runtime: "python312", memory: 512, base: 9, handler: () => ({ ms: 60 + Math.random() * 40 }) },
];
for (const f of FN) P.deploy(f);
const COLOR = { "checkout-api": "#00d2ff", "resize-image": "#7c5cff", "pdf-render": "#ffb547", "ml-score": "#22e3a1" };
const log = new LogView($("#log"), 200); let coldN = 0;
P.on((e) => {
  if (e.type === "cold") { if (++coldN % 3 === 1 || e.kind === "cold") log.html(`<span class="${e.kind === "cold" ? "warn" : "acc"}">${e.kind === "cold" ? "COLD" : "RESTORE"}</span> ${e.fn} <span class="dim">${e.vm} on ${e.host} · ${e.ms.toFixed(0)}ms</span>`); }
  else if (e.type === "throttle") { if (Math.random() < 0.15) log.html(`<span class="bad">429</span> ${e.fn} <span class="dim">${e.why}</span>`); }
  else if (e.type === "vm-stop") { if (e.why !== "keep-alive expired" || Math.random() < 0.3) log.html(`<span class="dim">STOP ${e.vm} ${e.fn} · ${e.why}</span>`); }
  else if (e.type === "deploy") log.html(`<span class="ok">DEPLOY</span> ${e.fn} <span class="acc">v${e.version}</span>`);
  else if (e.type === "snapshot") log.html(`<span class="acc">SNAPSHOT</span> ${e.fn} v${e.version} <span class="dim">memory image saved</span>`);
  else if (e.type === "prewarm") { if (Math.random() < 0.4) log.html(`<span class="ok">PREWARM</span> ${e.fn} <span class="dim">${e.vm}</span>`); }
});
const kp = new Kpis($("#kpis"), [
  { key: "rps", label: "Calls / s", tone: "acc" }, { key: "cold", label: "Cold starts", fmt: (v) => (v * 100).toFixed(1) + "%" }, { key: "p99", label: "p99 latency", fmt: (v) => v.toFixed(0) + "ms" },
  { key: "thr", label: "Throttled" }, { key: "vms", label: "MicroVMs" }, { key: "cost", label: "Cost (GB-s)", fmt: (v) => "$" + v.toFixed(4) },
]);
const ch1 = new Chart($("#ch1"), { series: [{ label: "p50", color: "--accent" }, { label: "p99", color: "#ff5c8a" }], min: 0, points: 120, fmtY: (v) => v.toFixed(0) });
const ch2 = new Chart($("#ch2"), { series: [{ label: "busy", color: "--accent" }, { label: "warm idle", color: "#22e3a1" }, { label: "booting", color: "#ffb547" }], min: 0, points: 120, area: false, fmtY: (v) => v.toFixed(0) });

const shots = [];
function drawFleet() {
  const { ctx, w, h: H } = fit($("#fleet")); ctx.clearRect(0, 0, w, H);
  const narrow = w < 600, gw = narrow ? 0 : 110, hs = P.hosts, rows = narrow ? hs.length : 2, cols = narrow ? 1 : 2;
  const top = 34, pad = 12, hw = (w - gw - pad * (cols + 1)) / cols, hh = (H - top - 18 - pad * (rows + 1) - (narrow ? 50 : 0)) / rows, gy = narrow ? 0 : H / 2;
  // gateway
  const gx = narrow ? w / 2 : 52, gyy = narrow ? top + 10 : gy;
  ctx.fillStyle = hexA(css("--accent"), 0.14); ctx.strokeStyle = css("--accent"); ctx.beginPath(); ctx.roundRect(gx - 40, gyy - 18, 80, 36, 10); ctx.fill(); ctx.stroke();
  ctx.fillStyle = "#e8ecfa"; ctx.font = "600 11px JetBrains Mono, monospace"; ctx.textAlign = "center"; ctx.textBaseline = "middle"; ctx.fillText("gateway", gx, gyy);
  const pos = new Map();
  hs.forEach((host, i) => {
    const x = narrow ? pad : gw + pad + (i % 2) * (hw + pad), y = narrow ? top + 50 + i * (hh + pad) : top + pad + Math.floor(i / 2) * (hh + pad);
    const used = host.vms.reduce((s, v) => s + v.mem, 0);
    ctx.fillStyle = "#0d1430"; ctx.strokeStyle = "#2a3560"; ctx.lineWidth = 1; ctx.beginPath(); ctx.roundRect(x, y, hw, hh, 12); ctx.fill(); ctx.stroke();
    ctx.textAlign = "left"; ctx.fillStyle = "#c9d1f0"; ctx.font = "600 11px JetBrains Mono, monospace"; ctx.fillText(host.id, x + 12, y + 16);
    ctx.fillStyle = "#5f6884"; ctx.font = "10px JetBrains Mono, monospace"; ctx.fillText(`${(used / 1024).toFixed(1)} / ${(host.mem / 1024).toFixed(0)} GB · ${host.vms.length} VMs`, x + 90, y + 16);
    ctx.fillStyle = "#ffffff10"; ctx.fillRect(x + 12, y + 26, hw - 24, 3); ctx.fillStyle = used / host.mem > 0.85 ? "#ff5c8a" : css("--accent"); ctx.fillRect(x + 12, y + 26, (hw - 24) * used / host.mem, 3);
    // VMs as tiles: lay out in rows; width ∝ memory
    const unit = (hw - 24) / (host.mem / 128) * 2, rowH = 18; let cx = x + 12, cy = y + 38;
    for (const vm of host.vms) {
      const vw = Math.max(8, (vm.mem / 256) * unit * 0.5 * 2) - 2; if (cx + vw > x + hw - 12) { cx = x + 12; cy += rowH + 4; } if (cy + rowH > y + hh - 6) break;
      const col = COLOR[vm.fn] || "#8d94ad";
      if (vm.state === "busy") { ctx.fillStyle = col; ctx.shadowColor = col; ctx.shadowBlur = 8; }
      else if (vm.state === "booting") { ctx.fillStyle = hexA(col, 0.25 + 0.35 * Math.abs(Math.sin(P.now * 8 + cx))); }
      else ctx.fillStyle = hexA(col, 0.16);
      ctx.beginPath(); ctx.roundRect(cx, cy, vw, rowH, 4); ctx.fill(); ctx.shadowBlur = 0;
      if (vm.state !== "busy") { ctx.strokeStyle = hexA(col, 0.6); ctx.lineWidth = 1; ctx.stroke(); }
      pos.set(vm.id, [cx + vw / 2, cy + rowH / 2]); cx += vw + 4;
    }
  });
  // request particles
  for (let i = shots.length - 1; i >= 0; i--) { const s = shots[i], p = pos.get(s.vm); if (!p) { shots.splice(i, 1); continue; } s.k += 0.06; if (s.k >= 1) { shots.splice(i, 1); continue; } const x = gx + (p[0] - gx) * s.k, y = gyy + (p[1] - gyy) * s.k; ctx.fillStyle = s.col; ctx.beginPath(); ctx.arc(x, y, s.cold ? 3.5 : 2, 0, 7); ctx.fill(); }
  // legend
  let lx = narrow ? 12 : gw + 12; ctx.font = "10px JetBrains Mono, monospace"; ctx.textAlign = "left";
  for (const [n, c] of Object.entries(COLOR)) { ctx.fillStyle = c; ctx.fillRect(lx, H - 12, 10, 8); ctx.fillStyle = "#8d94ad"; ctx.fillText(n, lx + 14, H - 8); lx += ctx.measureText(n).width + 28; if (lx > w - 60) break; }
}
P.on((e) => { if ((e.type === "done" && Math.random() < 0.35) || e.type === "cold") shots.push({ vm: e.vm, k: 0, col: COLOR[e.fn], cold: e.type === "cold" }); if (shots.length > 160) shots.shift(); });

let burst = 0, acc = 0, lastInv = 0, lastThr = 0, lastCold = 0, lastDone = 0;
function traffic(dt) {
  const b = burst > 0 ? 8 : 1; burst = Math.max(0, burst - dt);
  for (const f of FN) { const lam = f.base * (f.name === "checkout-api" ? b : 1 + (b - 1) * 0.3) * (1 + 0.4 * Math.sin(P.now / 5 + f.base)) * dt; let n = Math.floor(lam) + (Math.random() < lam % 1 ? 1 : 0); for (; n > 0; n--) P.invoke(f.name, { width: 3000 + Math.random() * 2000, height: 2000 }); }
}
function render() {
  const s = P.stats; drawFleet();
  $("#fns tbody").innerHTML = [...P.fns.values()].map((f) => `<tr><td><span style="color:${COLOR[f.name]}">●</span> <b>${f.name}</b><br><small class="dim">${f.tenant}</small></td><td>${f.runtime}</td><td class="r">${f.memory}MB</td><td><span class="pill dim">v${f.version}</span>${f.snapshot ? ' <span class="pill acc">snap</span>' : ""}</td><td class="r">${f.rate.toFixed(1)}/s</td><td class="r">${P.vms.filter((v) => v.fn === f.name).length}</td><td class="r">${P.coldStart(f) * 1000 | 0}ms</td><td class="r">${f.inflight}</td></tr>`).join("");
}
const loop = new Loop((dt) => {
  traffic(dt); P.advance(dt); acc += dt;
  if (acc >= 0.25) {
    const s = P.stats, done = s.cold + s.restored + s.warm, cold = s.cold + s.restored;
    kp.set({ rps: (s.invocations - lastInv) / acc, cold: (cold - lastCold) / Math.max(1, done - lastDone) * 0.3 + (kp.cur.cold ?? 0) * 0.7, p99: P.percentile(0.99, P.now - 3), thr: s.throttled, vms: P.vms.length, cost: s.gbSeconds * 0.0000166667 + s.invocations / 1e6 * 0.2 });
    ch1.push(P.percentile(0.5, P.now - 2), P.percentile(0.99, P.now - 2));
    ch2.push(P.vms.filter((v) => v.state === "busy").length, P.vms.filter((v) => v.state === "idle").length, P.vms.filter((v) => v.state === "booting").length);
    lastInv = s.invocations; lastCold = cold; lastDone = done; acc = 0; render();
  } else drawFleet();
});
bindLoop(loop, $("#sim"));
$("#burst").onclick = () => { burst = 4; toast("8× burst on checkout-api for 4s"); };
$("#ver").onclick = () => { const f = P.fns.get("checkout-api"); P.deploy({ ...FN[0], handler: f.handler }); toast("checkout-api v" + P.fns.get("checkout-api").version + " — old VMs drain, new ones cold start"); };
$("#snap").onclick = (e) => { P.snapshots = !P.snapshots; e.target.classList.toggle("on", P.snapshots); for (const f of P.fns.values()) f.snapshot = P.snapshots; toast(P.snapshots ? "Snapshot restore on (~20–50ms starts)" : "Full boots: runtime init on every cold start"); };
$("#pre").onclick = (e) => { P.prewarm = !P.prewarm; e.target.classList.toggle("on", P.prewarm); };
$("#ka").oninput = (e) => { P.keepAlive = +e.target.value; $("#kao").textContent = e.target.value + "s"; };
$("#inv").onclick = () => {
  let ev; try { ev = JSON.parse($("#ev").value); } catch { return toast("Event must be valid JSON"); }
  try { const handler = compile($("#code").value); const f = P.fns.get("resize-image"); if (f.handler.toString() !== handler.toString()) P.deploy({ ...FN[1], handler }); }
  catch (e) { $("#out").innerHTML = `<div class="bad">compile error: ${esc(e.message)}</div>`; return; }
  const t0 = P.now; P.invoke("resize-image", ev, (r) => { $("#out").innerHTML = `<div><span class="${r.status === 200 ? "ok" : "bad"}">${r.status}</span> <span class="dim">${r.kind || ""} · ${((r.latency ?? 0) * 1000).toFixed(0)}ms · ${r.vm || ""}</span></div><pre style="margin:6px 0 0;white-space:pre-wrap">${esc(JSON.stringify(r.result ?? r.error, null, 2))}</pre>`; });
  if (!loop.running) loop.start();
};
P.advance(1); for (let i = 0; i < 40; i++) { traffic(0.1); P.advance(0.1); }
render(); loop.start(); setTimeout(() => $("#inv").click(), 800); setTimeout(() => $("#burst").click(), 2500);
addEventListener("resize", render);
