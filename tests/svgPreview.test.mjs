import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import vm from "node:vm";
import ts from "typescript";

const code = ts.transpileModule(readFileSync(new URL("../src/lib/svgPreview.ts", import.meta.url), "utf8"), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
}).outputText;

// Controlled image completion and time expose races that a fast real decode
// rarely hits. XML parsing itself is tested in svgEditor.browser.html.
function setup() {
  const timers = new Map(), images = [], urls = new Map(), revoked = [], changes = [];
  let timerId = 0, urlId = 0;
  const exports = {};
  vm.runInNewContext(code, {
    exports, Blob,
    DOMParser: class {
      parseFromString(source) {
        return {
          querySelector: () => source === "invalid" ? { textContent: "unclosed element" } : null,
          documentElement: { localName: "svg", namespaceURI: "http://www.w3.org/2000/svg" },
        };
      }
    },
    Image: class { constructor() { images.push(this); } },
    URL: {
      createObjectURL(blob) { const url = `blob:${++urlId}`; urls.set(url, blob); return url; },
      revokeObjectURL(url) { revoked.push(url); },
    },
    setTimeout(fn, delay) { const id = ++timerId; timers.set(id, { fn, delay }); return id; },
    clearTimeout(id) { timers.delete(id); },
  });
  return {
    preview: exports.createSvgPreview(state => changes.push(state)),
    images, urls, revoked, changes, timers,
    state: () => changes.at(-1),
    tick() { const pending = [...timers.values()]; timers.clear(); pending.forEach(({ fn }) => fn()); },
  };
}

test("rapid typing renders only the latest source after the debounce", async () => {
  const t = setup();
  t.preview.update("first");
  t.preview.update("second");
  t.preview.update("latest");
  assert.equal(t.images.length, 0);
  assert.equal(t.timers.size, 1);
  assert.equal([...t.timers.values()][0].delay, 300);
  t.tick();
  assert.equal(t.images.length, 1);
  assert.equal(await t.urls.get(t.images[0].src).text(), "latest");
  t.images[0].onload();
  assert.equal(t.state().src, t.images[0].src);
  assert.equal(t.state().pending, false);
  t.preview.dispose();
});

test("old in-flight images cannot replace a newer preview", () => {
  const t = setup();
  t.preview.update("old", true);
  const staleLoad = t.images[0].onload;
  t.preview.update("new", true);
  t.images[1].onload();
  const current = t.state().src;
  staleLoad();
  assert.equal(t.state().src, current);
  assert.ok(t.revoked.includes(t.images[0].src));
  t.preview.dispose();
});

test("syntax errors and image decode failures retain the last good image, then recover", () => {
  const t = setup();
  t.preview.update("good", true);
  t.images[0].onload();
  const good = t.state().src;
  t.preview.update("invalid", true);
  assert.equal(t.state().src, good);
  assert.match(t.state().error, /语法错误/);
  t.preview.update("bad-image", true);
  t.images[1].onerror();
  assert.equal(t.state().src, good);
  assert.match(t.state().error, /无法渲染/);
  assert.ok(!t.revoked.includes(good));
  t.preview.update("fixed", true);
  t.images[2].onload();
  assert.equal(t.state().error, null);
  assert.notEqual(t.state().src, good);
  assert.ok(t.revoked.includes(good));
  t.preview.dispose();
});

test("a late image error cannot replace the newer validation result", () => {
  const t = setup();
  t.preview.update("old", true);
  const staleError = t.images[0].onerror;
  t.preview.update("invalid", true);
  const error = t.state().error;
  staleError();
  assert.equal(t.state().error, error);
  t.preview.dispose();
});

test("unmount cancels timers, ignores callbacks, and revokes all object URLs", () => {
  const t = setup();
  t.preview.update("good", true);
  t.images[0].onload();
  t.preview.update("in-flight", true);
  const late = t.images[1].onload;
  t.preview.dispose();
  const count = t.changes.length;
  late();
  t.preview.update("after unmount");
  assert.equal(t.changes.length, count);
  assert.deepEqual(new Set(t.revoked), new Set(t.urls.keys()));
  const scheduled = setup();
  scheduled.preview.update("pending");
  scheduled.preview.dispose();
  scheduled.tick();
  assert.equal(scheduled.images.length, 0);
});
