import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import vm from "node:vm";
import ts from "typescript";

// Exercise the actual launch/stop orchestration with controlled IPC timing.
// The desktop bridge and stores are replaced so no webview or process is needed.
const compiled = ts.transpileModule(
  readFileSync(new URL("../src/lib/codeRun/run.ts", import.meta.url), "utf8"),
  { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } },
).outputText;

function deferred() {
  let resolve;
  const promise = new Promise((done) => { resolve = done; });
  return { promise, resolve };
}

function harness({ listenerGate, startGate, stopError } = {}) {
  const calls = [];
  const events = new Map();
  const toasts = [];
  const runner = { command: "bash", args: [], ext: ".sh", env: {}, timeoutMs: 30000 };
  const runStore = {
    records: [],
    start(record) { this.records.push(record); },
    finish(id, result) { Object.assign(this.records.find((r) => r.runId === id), result); },
    fail(id, error) { Object.assign(this.records.find((r) => r.runId === id), { status: "error", error }); },
    append() {},
  };
  const appStore = {
    codeRunConfig: { confirmEveryRun: false, maxOutputKb: 200 },
    workspacePath: "/notes",
    runPanelOpen: true,
    showToast(message) { toasts.push(message); },
  };
  const dependencies = {
    "@tauri-apps/api/core": {
      async invoke(command, args) {
        calls.push({ command, args });
        if (command === "code_run_start") await startGate?.promise;
        if (command === "code_run_stop" && stopError) throw new Error(stopError);
      },
    },
    "@tauri-apps/api/event": {
      async listen(event, handler) {
        await listenerGate?.promise;
        events.set(event, handler);
        return () => events.delete(event);
      },
    },
    "../../store/useAppStore": { useAppStore: { getState: () => appStore } },
    "../../store/useRunStore": { useRunStore: { getState: () => runStore }, runKey: () => "block" },
    "../fs": { dirname: () => "/notes" },
    "./runners": { resolveRunner: () => runner, fenceLang: () => "bash" },
  };
  const exports = {};
  vm.runInNewContext(compiled, {
    exports,
    require(name) {
      assert.ok(name in dependencies, `unexpected dependency: ${name}`);
      return dependencies[name];
    },
    setInterval: () => 1,
    clearInterval() {},
  });
  return {
    ...exports, calls, events, toasts, runStore,
    start: () => exports.startRun({ filePath: "/notes/test.md", info: "bash", code: "npm run tauri build" }),
  };
}

async function until(check) {
  for (let i = 0; i < 30 && !check(); i++) await Promise.resolve();
  assert.ok(check(), "expected asynchronous stage was not reached");
}

test("stop before listeners are ready cancels without starting a process", async () => {
  const listenerGate = deferred();
  const app = harness({ listenerGate });
  const launching = app.start();
  app.stopRun(1);
  listenerGate.resolve();
  await launching;
  assert.equal(app.calls.length, 0);
  assert.equal(app.runStore.records[0].status, "killed");
  assert.equal(app.events.size, 0);
});

test("stop during backend startup is delivered once registration completes", async () => {
  const startGate = deferred();
  const app = harness({ startGate });
  const launching = app.start();
  await until(() => app.calls.length === 1);
  app.stopRun(1);
  assert.equal(app.calls.length, 1);
  startGate.resolve();
  await launching;
  assert.equal(app.calls[1].command, "code_run_stop");
  assert.equal(app.calls[1].args.id, 1);
  assert.equal(app.runStore.records[0].status, "running");
  app.events.get("code:exit:1")({ payload: { code: 1, killed: true, timedOut: false, truncated: false, ms: 500 } });
  assert.equal(app.runStore.records[0].status, "killed");
  assert.equal(app.events.size, 0);
});

test("an exit before the start response does not send a late stop", async () => {
  const startGate = deferred();
  const app = harness({ startGate });
  const launching = app.start();
  await until(() => app.calls.length === 1);
  app.stopRun(1);
  app.events.get("code:exit:1")({ payload: { code: 0, killed: false, timedOut: false, truncated: false, ms: 1 } });
  startGate.resolve();
  await launching;
  assert.equal(app.calls.length, 1);
  assert.equal(app.runStore.records[0].status, "done");
});

test("a failed stop is visible and does not claim the process has stopped", async () => {
  const app = harness({ stopError: "access denied" });
  await app.start();
  app.stopRun(1);
  await until(() => app.toasts.length === 1);
  assert.match(app.toasts[0], /access denied/);
  assert.equal(app.runStore.records[0].status, "running");
});
