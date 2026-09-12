import assert from "node:assert/strict";
import test from "node:test";
import { DirectoryTree } from "../src/lib/directoryTree.ts";

const folder = (path) => ({ name: path.split(/[\\/]/).at(-1), path, is_dir: true, children: null });
const file = (path) => ({ ...folder(path), is_dir: false });
const deferred = () => {
  let resolve;
  const promise = new Promise((r) => { resolve = r; });
  return { promise, resolve };
};

test("opening a workspace reads only its root; deep links load ancestors on demand", async () => {
  const calls = [];
  const disk = {
    "/ws": [folder("/ws/a"), folder("/ws/untouched")],
    "/ws/a": [folder("/ws/a/b"), file("/ws/a/README.md")],
    "/ws/a/b": [],
  };
  const tree = new DirectoryTree("/ws", async (path) => { calls.push(path); return disk[path]; });
  await tree.load("/ws");
  assert.deepEqual(calls, ["/ws"]);
  assert.equal(tree.snapshot()[0].children, null);
  await tree.load("/ws/a/b");
  assert.deepEqual(calls, ["/ws", "/ws/a", "/ws/a/b"]);
  assert.deepEqual(tree.snapshot()[0].children[0].children, []);
  assert.equal(tree.snapshot()[0].children[1].name, "README.md");
  assert.equal(tree.snapshot()[1].children, null);
});

test("deduplicates in-flight requests and retries after a disk error", async () => {
  let count = 0;
  const result = deferred();
  const tree = new DirectoryTree("/ws", async () => { count++; return result.promise; });
  const a = tree.load("/ws"), b = tree.load("/ws");
  result.resolve([]);
  await Promise.all([a, b]);
  assert.equal(count, 1);
  await tree.load("/ws");
  assert.equal(count, 1);

  let fail = true;
  const retry = new DirectoryTree("/ws", async () => { if (fail) throw Error("disk error"); return []; });
  await assert.rejects(retry.load("/ws"), /disk error/);
  fail = false;
  assert.deepEqual(await retry.load("/ws"), []);
});

test("a disposed workspace cannot publish late results or start queued disk reads", async () => {
  const gates = Array.from({ length: 4 }, deferred);
  const calls = [];
  const tree = new DirectoryTree("/old", async (path) => {
    if (path === "/old") return [];
    calls.push(path);
    return gates[calls.length - 1].promise;
  });
  await tree.load("/old");
  const requests = Array.from({ length: 10 }, (_, i) => tree.load(`/old/${i}`));
  const results = Promise.allSettled(requests);
  await new Promise(setImmediate);
  assert.equal(calls.length, 4);
  tree.dispose();
  const fresh = new DirectoryTree("/new", async () => [file("/new/current.md")]);
  await fresh.load("/new");
  gates.forEach((gate) => gate.resolve([file("/old/stale.md")]));
  assert.ok((await results).every((r) => r.status === "rejected"));
  assert.equal(calls.length, 4);
  assert.equal(fresh.snapshot()[0].name, "current.md");
});

test("Windows drive roots retain the absolute root during ancestor loading", async () => {
  const calls = [];
  const tree = new DirectoryTree("D:\\", async (path) => { calls.push(path); return []; });
  await tree.load("D:\\notes\\sub");
  assert.deepEqual(calls, ["D:\\", "D:\\notes", "D:\\notes\\sub"]);
  await assert.rejects(tree.load("E:\\outside"), /当前项目/);
});
