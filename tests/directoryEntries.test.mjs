import { i18nDependency } from './i18nHarness.mjs';
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import test from "node:test";
import vm from "node:vm";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import ts from "typescript";

const require = createRequire(import.meta.url);
function load(file, dependencies = {}) {
  const exports = {};
  const code = ts.transpileModule(readFileSync(new URL(file, import.meta.url), "utf8"), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX },
  }).outputText;
  vm.runInNewContext(code, { exports, require: (name) => dependencies[name] ?? (name.includes('/i18n/') ? i18nDependency(name) : require(name)) });
  return exports;
}
const batch = load("../src/components/DirectoryEntries.tsx");
const file = (path) => ({ name: path.split("/").at(-1), path, is_dir: false });
const entries = (path, count) => Array.from({ length: count }, (_, i) => file(`${path}/${i}.txt`));
const folder = (path, children) => ({ ...file(path), is_dir: true, children });
const state = {
  workspacePath: "/ws", selectedPath: null, selectedPaths: [], compactSidebar: false,
  expanded: {}, openFile() {}, openFolder() {}, setExpanded() {}, loadDirectory() {}, newFile() {},
};
const store = { useAppStore: (select) => select(state) };
const fs = {
  dirname: (path) => path.slice(0, path.lastIndexOf("/")),
  isMarkdownFile: () => false, isImageFile: () => false,
  findNode: (nodes, path) => nodes.find((node) => node.path === path),
};
const { FileTree } = load("../src/components/Sidebar/FileTree.tsx", {
  "../../lib/fs": fs, "../../store/useAppStore": store, "../DirectoryEntries": batch,
  "./treeDrag": { useTreeDrag: () => null, TreeDragProvider: ({ children }) => children },
});
const { FolderView } = load("../src/components/Editor/FolderView.tsx", {
  "../../lib/fs": fs, "../../store/useAppStore": store, "../DirectoryEntries": batch,
});

test("a restored file tree renders only 1000 of 31887 files, including nested directories", () => {
  const files = entries("/ws/deps", 31887);
  const before = files.slice();
  state.expanded = { "/ws/deps": true };
  const html = renderToStaticMarkup(React.createElement(FileTree, {
    nodes: [folder("/ws/deps", files)], onContextMenu() {},
  }));
  assert.equal((html.match(/data-tree-path=/g) ?? []).length, 1001); // folder + first batch
  assert.ok(html.includes('data-tree-path="/ws/deps/999.txt"'));
  assert.ok(!html.includes('data-tree-path="/ws/deps/1000.txt"'));
  assert.ok(html.includes("显示更多"));
  assert.deepEqual(files, before); // Hidden entries remain available to other actions.

  const root = renderToStaticMarkup(React.createElement(FileTree, { nodes: files, onContextMenu() {} }));
  assert.equal((root.match(/data-tree-path=/g) ?? []).length, 1000);
});

test("clicking a large folder also limits the right-pane listing", () => {
  state.tree = [folder("/ws/deps", entries("/ws/deps", 31887))];
  const html = renderToStaticMarkup(React.createElement(FolderView, { path: "/ws/deps" }));
  assert.equal((html.match(/\.txt<\/span>/g) ?? []).length, 1000);
  assert.ok(html.includes("显示更多"));
});

// Drive the actual button handlers with a controlled hook slot; JSX and output
// still use React. This does not depend on a browser or add a test-only runtime.
function mountedBatch(count) {
  let stateValue;
  const { DirectoryEntries } = load("../src/components/DirectoryEntries.tsx", {
    "../i18n/react": { useLanguage: () => "zh-CN" },
    react: { useState(initial) {
      stateValue ??= initial;
      return [stateValue, (update) => { stateValue = update(stateValue); }];
    } },
  });
  let files = entries("/ws", count), visible = [];
  const render = () => {
    const element = DirectoryEntries({ directory: "/ws", entries: files, children: (items) => { visible = items; return null; } });
    return element.type(element.props);
  };
  function find(element, type) {
    if (!element || typeof element !== "object") return undefined;
    if (element.type === type) return element;
    return React.Children.toArray(element.props?.children).map((child) => find(child, type)).find(Boolean);
  }
  return {
    render, visible: () => visible,
    more: () => find(render(), "button")?.props.onClick(),
    hasMore: () => !!find(render(), "button"),
    replace: (count) => { files = entries("/ws", count); },
  };
}

test("each click adds 1000 entries, keeps their order and stops at a partial final batch", () => {
  const list = mountedBatch(3501);
  list.render();
  assert.equal(list.visible().length, 1000);
  for (const expected of [2000, 3000, 3501]) {
    list.more(); list.render();
    assert.equal(list.visible().length, expected);
    assert.equal(list.visible()[0].path, "/ws/0.txt");
    assert.equal(list.visible().at(-1).path, `/ws/${expected - 1}.txt`);
  }
  assert.equal(list.hasMore(), false);
  assert.match(renderToStaticMarkup(list.render()), /已全部显示/);
});

test("small directories have no footer; independent directories start at 1000", () => {
  for (const count of [0, 1, 999, 1000]) {
    const list = mountedBatch(count);
    assert.equal(renderToStaticMarkup(list.render()), "");
    assert.equal(list.visible().length, count);
  }
  const a = mountedBatch(5000), b = mountedBatch(5000);
  a.more(); a.render(); b.render();
  assert.equal(a.visible().length, 2000);
  assert.equal(b.visible().length, 1000);
  a.replace(500); a.render();
  assert.equal(a.visible().length, 500);
  assert.equal(a.hasMore(), false);
});

test("directory identity remounts the batch and the footer preserves sidebar selection", () => {
  const props = { entries: entries("/ws", 1001), children: () => null };
  const first = batch.DirectoryEntries({ ...props, directory: "/ws/a" });
  const next = batch.DirectoryEntries({ ...props, directory: "/ws/b" });
  assert.notEqual(first.key, next.key);
  const content = mountedBatch(1001).render();
  const footer = React.Children.toArray(content.props.children).find((child) => child.type === "div");
  let stopped = false;
  footer.props.onClick({ stopPropagation() { stopped = true; } });
  assert.equal(stopped, true);
});
