// Node-only: run handler source inside a fresh V8 context with a CPU timeout and memory-free globals.
import vm from "node:vm";
export function runIsolated(source, event = {}, { timeoutMs = 1000, context = {} } = {}) {
  const sandbox = { module: { exports: {} }, console: { log: (...a) => logs.push(a.join(" ")) }, JSON, Math, Date };
  const logs = []; sandbox.exports = sandbox.module.exports; vm.createContext(sandbox, { codeGeneration: { strings: false, wasm: false } });
  const t0 = process.hrtime.bigint();
  new vm.Script(source, { filename: "handler.js" }).runInContext(sandbox, { timeout: timeoutMs });
  const fn = sandbox.module.exports.handler || sandbox.handler; if (typeof fn !== "function") throw new Error("source must define handler(event, context)");
  sandbox.__ev = event; sandbox.__ctx = context;
  const result = new vm.Script("handler(__ev, __ctx)").runInContext(Object.assign(sandbox, { handler: fn }), { timeout: timeoutMs });
  return { result, logs, ms: Number(process.hrtime.bigint() - t0) / 1e6 };
}
