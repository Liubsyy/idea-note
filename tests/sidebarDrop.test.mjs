import assert from "node:assert/strict";
import test from "node:test";
import { createSidebarDropFeedback, sidebarDropTarget } from "../src/lib/sidebarDrop.ts";

// Minimal attribute-based DOM for hit testing and decoration lifecycle checks.
class Element {
  constructor(attrs = {}, parent = null) {
    this.attrs = { ...attrs };
    this.parent = parent;
    this.children = [];
    this.style = {};
    this.offsetWidth = 260;
    this.offsetHeight = 42;
    parent?.children.push(this);
  }
  getAttribute(name) { return this.attrs[name] ?? null; }
  setAttribute(name, value) { this.attrs[name] = value; }
  removeAttribute(name) { delete this.attrs[name]; }
  matches(selector) {
    return selector.split(", ").some((part) => part.slice(1, -1) in this.attrs);
  }
  closest(selector) {
    return this.matches(selector) ? this : this.parent?.closest(selector) ?? null;
  }
  querySelectorAll(selector) {
    return this.children.flatMap((child) => [
      ...(child.matches(selector) ? [child] : []), ...child.querySelectorAll(selector),
    ]);
  }
  appendChild(child) { child.parent = this; this.children.push(child); }
  remove() { this.parent.children = this.parent.children.filter((child) => child !== this); }
}

function tree(root = "/notes") {
  const sidebar = new Element({ "data-sidebar": "true" });
  const list = new Element({ "data-sidebar-drop-root": root }, sidebar);
  const folder = new Element({ "data-tree-dir": `${root}/资料` }, list);
  const file = new Element({ "data-tree-parent": `${root}/资料` }, list);
  return { sidebar, list, folder, file };
}

test("folder icon drops into that folder", () => {
  const { folder } = tree();
  const icon = new Element({}, folder);
  assert.deepEqual(sidebarDropTarget(icon), { dir: "/notes/资料", element: folder });
});

test("file drops use and highlight its parent folder", () => {
  const { folder, file } = tree();
  assert.deepEqual(sidebarDropTarget(file), { dir: "/notes/资料", element: folder });
});

test("empty list and root files copy into the workspace root", () => {
  const list = new Element({ "data-sidebar-drop-root": "/notes" });
  const emptyMessage = new Element({}, list);
  const rootFile = new Element({ "data-tree-parent": "/notes" }, list);
  for (const el of [list, emptyMessage, rootFile]) {
    assert.deepEqual(sidebarDropTarget(el), { dir: "/notes", element: list });
  }
});

test("toolbar, search, outline, no workspace and outside the window are not targets", () => {
  const { sidebar } = tree();
  for (const el of [null, sidebar, new Element({}, sidebar),
    new Element({ "data-sidebar-drop-root": "" }), new Element({ "data-tree-dir": "/elsewhere" })]) {
    assert.equal(sidebarDropTarget(el), null);
  }
});

test("folded folder chains target their deepest displayed directory", () => {
  const { folder } = tree();
  folder.setAttribute("data-tree-dir", "/notes/资料/2026/九月");
  assert.equal(sidebarDropTarget(folder).dir, "/notes/资料/2026/九月");
});

test("Windows paths and names containing CSS special characters remain intact", () => {
  const dir = 'C:\\Notes\\资料 [草稿] "一"';
  const list = new Element({ "data-sidebar-drop-root": "C:\\Notes" });
  const folder = new Element({ "data-tree-dir": dir }, list);
  const file = new Element({ "data-tree-parent": dir }, list);
  assert.deepEqual(sidebarDropTarget(file), { dir, element: folder });
});

test("copy badge follows the pointer, switches highlights and cleans up completely", (t) => {
  const body = new Element();
  const originalDocument = globalThis.document;
  const originalWindow = globalThis.window;
  globalThis.document = { body, createElement: () => new Element() };
  globalThis.window = { innerWidth: 800, innerHeight: 600 };
  t.after(() => {
    if (originalDocument === undefined) delete globalThis.document;
    else globalThis.document = originalDocument;
    if (originalWindow === undefined) delete globalThis.window;
    else globalThis.window = originalWindow;
  });
  const { list, folder } = tree();
  const feedback = createSidebarDropFeedback();
  feedback.show(sidebarDropTarget(folder), { x: 100, y: 150 }, 2);
  assert.equal(folder.getAttribute("data-native-drop-target"), "true");
  assert.equal(body.children.length, 1);
  const badge = body.children[0];
  assert.equal(badge.textContent, "松开以拷贝 2 个项目到「资料」");
  assert.deepEqual(badge.style, { left: "118px", top: "170px" });

  feedback.show(sidebarDropTarget(list), { x: 790, y: 590 }, 1);
  assert.equal(folder.getAttribute("data-native-drop-target"), null);
  assert.equal(list.getAttribute("data-native-drop-target"), "true");
  assert.equal(body.children.length, 1);
  assert.equal(badge.textContent, "松开以拷贝到「notes」");
  assert.deepEqual(badge.style, { left: "532px", top: "550px" });

  feedback.clear();
  feedback.clear();
  assert.equal(list.getAttribute("data-native-drop-target"), null);
  assert.equal(body.children.length, 0);
});
