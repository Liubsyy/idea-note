import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import test from "node:test";
import vm from "node:vm";
import ts from "typescript";

function load(path, dependencies = {}, globals = {}) {
  const source = readFileSync(new URL(`../${path}`, import.meta.url), "utf8");
  const code = ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  const exports = {};
  vm.runInNewContext(code, {
    exports, DOMException, AbortController, console, crypto: { randomUUID },
    localStorage: { getItem: () => null },
    require(name) {
      assert.ok(name in dependencies, `unexpected dependency: ${name}`);
      return dependencies[name];
    },
    ...globals,
  });
  return exports;
}

const cancellation = load("src/lib/ai/cancellation.ts");
function deferred() {
  let resolve, reject;
  const promise = new Promise((ok, fail) => { resolve = ok; reject = fail; });
  return { promise, resolve, reject };
}
async function until(check) {
  for (let i = 0; i < 100 && !check(); i++) await Promise.resolve();
  assert.ok(check(), "asynchronous stage not reached");
}
async function promptly(promise) {
  let timer;
  try {
    return await Promise.race([
      promise,
      new Promise((_, reject) => { timer = setTimeout(() => reject(new Error("cancellation waited for work")), 1000); }),
    ]);
  } finally { clearTimeout(timer); }
}
function client(send) {
  return load("src/lib/ai/client.ts", {
    "./openai": { send }, "./anthropic": { send }, "./cancellation": cancellation,
  });
}
const searchCall = { id: "search-1", name: "search_notes", args: { query: "test" } };

test("stop releases a pending tool and completes batched history without starting later tools", async () => {
  const search = deferred();
  let started = 0;
  const controller = new AbortController();
  const history = [];
  const driver = client(async () => ({ text: "", toolCalls: [searchCall, { id: "delete-2", name: "delete_file", args: {} }] }));
  const task = driver.runChat({}, history, [], "", { signal: controller.signal }, {
    onTextDelta() {}, onTextDone() {}, onToolCall: () => { started++; return search.promise; },
  });
  await until(() => started === 1);
  controller.abort();
  await promptly(assert.rejects(task, { name: "AbortError" }));
  assert.equal(started, 1);
  assert.equal(history.length, 3);
  assert.equal(history[1].toolCallId, "search-1");
  assert.equal(history[2].toolCallId, "delete-2");
  const snapshot = JSON.stringify(history);
  search.resolve("late search results");
  await Promise.resolve();
  await Promise.resolve();
  assert.equal(JSON.stringify(history), snapshot);
});

test("completed tool results survive cancellation of a later tool", async () => {
  const controller = new AbortController();
  const history = [];
  let calls = 0;
  const driver = client(async () => ({ text: "", toolCalls: [
    { ...searchCall, id: "first" }, { ...searchCall, id: "second" },
  ] }));
  const task = driver.runChat({}, history, [], "", { signal: controller.signal }, {
    onTextDelta() {}, onTextDone() {},
    onToolCall: async () => { if (++calls === 1) return "completed result"; return new Promise(() => {}); },
  });
  await until(() => calls === 2);
  controller.abort();
  await promptly(assert.rejects(task, { name: "AbortError" }));
  assert.equal(history[1].result, "completed result");
  assert.match(history[2].result, /已停止/);
});

test("stop releases an unresponsive provider and ignores its late text and rejection", async () => {
  const response = deferred();
  let emit;
  const controller = new AbortController();
  const deltas = [];
  const history = [];
  const driver = client((...args) => { emit = args[5]; return response.promise; });
  const task = driver.runChat({}, history, [], "", { signal: controller.signal }, {
    onTextDelta: (text) => deltas.push(text), onTextDone() {}, onToolCall() { throw new Error("unexpected tool"); },
  });
  emit("before");
  controller.abort();
  await promptly(assert.rejects(task, { name: "AbortError" }));
  emit("after");
  response.reject(new Error("late network failure"));
  await Promise.resolve();
  assert.deepEqual(deltas, ["before"]);
  assert.equal(history.length, 0);
});

function searchBridge(invoke) {
  return load("src/lib/fs.ts", {
    "@tauri-apps/api/core": { invoke }, "@tauri-apps/plugin-dialog": {},
    "./ai/cancellation": cancellation,
  });
}

test("stop before registration completes still cleans up the ID and never scans", async () => {
  const registration = deferred();
  const registered = new Set();
  const calls = [];
  const bridge = searchBridge(async (command, args) => {
    calls.push(command);
    if (command === "prepare_note_search") { await registration.promise; registered.add(args.requestId); }
    if (command === "cancel_note_search") registered.delete(args.requestId);
    if (command === "search_notes") throw new Error("scan must not start");
  });
  const controller = new AbortController();
  const task = bridge.searchNotes("/notes", "test", controller.signal);
  controller.abort();
  await promptly(assert.rejects(task, { name: "AbortError" }));
  registration.resolve();
  await until(() => calls.filter((c) => c === "cancel_note_search").length === 2);
  assert.equal(registered.size, 0);
  assert.ok(!calls.includes("search_notes"));
});

test("a running search receives cancellation for its own ID while another search completes", async () => {
  const pending = new Map();
  const cancelled = [];
  const bridge = searchBridge(async (command, args) => {
    if (command === "cancel_note_search") cancelled.push(args.requestId);
    if (command === "search_notes") {
      const work = deferred();
      pending.set(args.query, { ...work, id: args.requestId });
      return work.promise;
    }
  });
  const controller = new AbortController();
  const first = bridge.searchNotes("/notes", "first", controller.signal);
  const second = bridge.searchNotes("/notes", "second");
  await until(() => pending.size === 2);
  controller.abort();
  await promptly(assert.rejects(first, { name: "AbortError" }));
  assert.deepEqual(cancelled, [pending.get("first").id]);
  pending.get("second").resolve(["second result"]);
  assert.deepEqual(await second, ["second result"]);
  pending.get("first").reject(new Error("cancelled in Rust"));
  await Promise.resolve();
});

function createStore(initializer) {
  let state;
  const get = () => state;
  const set = (patch) => { state = { ...state, ...(typeof patch === "function" ? patch(state) : patch) }; };
  state = initializer(set, get);
  return { getState: get, setState: set };
}

function chatHarness(send, toolOverrides = {}) {
  const appState = { aiModels: [{}], aiSessionHistoryLimit: 50, workspacePath: "/notes", activeFilePath: null };
  const persistence = [];
  const tools = { TOOL_DEFS: [], isEditTool: () => false, ...toolOverrides };
  const { useChatStore: store } = load("src/store/useChatStore.ts", {
    zustand: { create: createStore },
    "@tauri-apps/api/core": { invoke: async (command, args) => { persistence.push({ command, args }); return "null"; } },
    "./useAppStore": { useAppStore: { getState: () => appState, subscribe() {} } },
    "../lib/fs": { basename: (path) => path.split("/").pop() },
    "../lib/ai/client": client(send),
    "../lib/ai/cancellation": cancellation,
    "../lib/ai/modelSelection": { resolveModelSelection: () => ({}), firstModelSelection: () => "model" },
    "../lib/ai/tools": tools,
  });
  store.setState({ sessions: ["one", "two"].map((id) => ({
    id, title: id, modelId: "model", mode: "ask", thinkingLevel: "default",
    useOpenFile: false, archived: false, items: [], history: [],
  })), activeSessionId: "one" });
  return { store, persistence };
}

test("store stops immediately, preserves cancelled cards, and isolates the next turn and other sessions", async () => {
  const oldSearch = deferred();
  const nextResponse = deferred();
  let providerCalls = 0;
  let toolSignal;
  const { store } = chatHarness(async () => {
    if (++providerCalls === 1) return { text: "", toolCalls: [searchCall] };
    return nextResponse.promise;
  }, { runSearch: (_args, signal) => { toolSignal = signal; return oldSearch.promise; } });
  const first = store.getState().sendMessage("one", "find notes");
  await until(() => !!toolSignal);
  const other = store.getState().sendMessage("two", "other session");
  store.getState().stopSending("one");
  assert.ok(toolSignal.aborted);
  await promptly(first);
  assert.ok(!store.getState().sendingSessionIds.includes("one"));
  assert.ok(store.getState().sendingSessionIds.includes("two"));
  const getFirst = () => store.getState().sessions.find((s) => s.id === "one");
  assert.equal(getFirst().items.find((i) => i.kind === "tool").status, "cancelled");
  const next = store.getState().sendMessage("one", "new request");
  const snapshot = JSON.stringify(getFirst());
  oldSearch.resolve({ ok: true, hits: ["late result"] });
  for (let i = 0; i < 10; i++) await Promise.resolve();
  assert.equal(JSON.stringify(getFirst()), snapshot);
  assert.ok(store.getState().sendingSessionIds.includes("one"));
  nextResponse.resolve({ text: "new answer", toolCalls: [] });
  await Promise.all([next, other]);
  assert.equal(getFirst().history.at(-1).content, "new answer");
});

test("approval followed by stop in the same tick cannot apply an edit", async () => {
  let applied = 0;
  const { store } = chatHarness(async () => ({ text: "", toolCalls: [{ id: "edit-1", name: "edit_open_file", args: {} }] }), {
    isEditTool: () => true,
    prepareEdit: () => ({ ok: true, before: "before", after: "after", summary: "edit", diff: {} }),
    applyContent: () => { applied++; },
  });
  const task = store.getState().sendMessage("one", "edit");
  const card = () => store.getState().sessions[0].items.find((i) => i.kind === "tool");
  await until(() => !!card());
  store.getState().resolvePendingEdit(card().id, true);
  store.getState().stopSending("one");
  await promptly(task);
  assert.equal(applied, 0);
  assert.equal(card().status, "cancelled");
});

test("deleting a session during search does not recreate it when results arrive", async () => {
  const search = deferred();
  let started = false;
  const { store } = chatHarness(async () => ({ text: "", toolCalls: [searchCall] }), {
    runSearch: () => { started = true; return search.promise; },
  });
  const task = store.getState().sendMessage("one", "find");
  await until(() => started);
  store.getState().deleteSession("one");
  await promptly(task);
  search.resolve({ ok: true, hits: [] });
  for (let i = 0; i < 10; i++) await Promise.resolve();
  assert.ok(!store.getState().sessions.some((s) => s.id === "one"));
});

test("cancelling creation prevents follow-up writes and navigation after the native create returns", async () => {
  const created = deferred();
  const followUps = [];
  const appState = {
    workspacePath: "/notes",
    refreshTree: async () => followUps.push("refresh"),
    openFile: async () => followUps.push("open"),
  };
  const tools = load("src/lib/ai/tools.ts", {
    diff: {}, "./types": {}, "../codemirror/activeView": {},
    "../../store/useAppStore": { useAppStore: { getState: () => appState } },
    "./componentGuide": { GUIDE_TOPICS: [] }, "../workspacePath": {},
    "./cancellation": cancellation,
    "../fs": { createFile: () => created.promise, writeFile: async () => followUps.push("write") },
  });
  const controller = new AbortController();
  const creating = tools.createNote({ name: "note.md", content: "text" }, controller.signal);
  controller.abort();
  created.resolve("/notes/note.md");
  await assert.rejects(creating, { name: "AbortError" });
  assert.deepEqual(followUps, []);
});
