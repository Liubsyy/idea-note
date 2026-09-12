import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';
import ts from 'typescript';
import * as stateApi from '@codemirror/state';
import * as viewApi from '@codemirror/view';

class Element {
  children = [];
  listeners = new Map();
  classList = { add() {}, toggle() {} };
  addEventListener(type, callback) { this.listeners.set(type, callback); }
  setAttribute() {}
  prepend(child) { this.children.unshift(child); }
  fire(type, extra = {}) {
    this.listeners.get(type)?.({ button: 0, preventDefault() {}, stopPropagation() {}, ...extra });
  }
}

const opened = [];
const dependencies = {
  '@codemirror/state': stateApi,
  '@codemirror/view': viewApi,
  './inlineHtml': {},
  './linkClick': { openLinkTargetSafe: (url) => opened.push(url) },
  './markdownActions': { openResourcePrompt() {} },
};
const exports = {};
vm.runInNewContext(ts.transpileModule(
  readFileSync(new URL('../src/lib/codemirror/resourcePreview.ts', import.meta.url), 'utf8'),
  { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } },
).outputText, {
  exports,
  require: (name) => {
    assert.ok(name in dependencies, `unexpected dependency: ${name}`);
    return dependencies[name];
  },
  document: { createElement: () => new Element() },
});
const { bindResourcePreview, resourceSourceField, setResourceSource, resourceFileIcon, isResourceLink } = exports;
const { EditorState, Compartment } = stateApi;

test('clicks select the Markdown range repeatedly; only the source button reveals it', () => {
  const doc = 'before\n[file](assets/report.pdf)\nafter';
  const range = { from: 7, to: doc.lastIndexOf('\n') };
  const view = {
    state: EditorState.create({ doc, extensions: [resourceSourceField] }),
    dispatch(spec) { this.state = this.state.update(spec).state; },
    focus() {},
  };
  const wrap = new Element();
  bindResourcePreview(wrap, view, range, 'assets/report.pdf', '资源文件', false);
  for (let n = 0; n < 3; n++) {
    wrap.fire('mousedown');
    assert.equal(view.state.sliceDoc(view.state.selection.main.from, view.state.selection.main.to), '[file](assets/report.pdf)');
    assert.equal(view.state.field(resourceSourceField), null);
  }
  wrap.children[0].fire('click');
  assert.equal(view.state.field(resourceSourceField).from, range.from);
  assert.equal(view.state.selection.main.empty, true);
  wrap.fire('mousedown', { ctrlKey: true });
  assert.equal(opened.at(-1), 'assets/report.pdf');
});

test('source tracks edits before and inside a resource and closes after selecting other text', () => {
  let state = EditorState.create({ doc: 'before\n[x](a.pdf)\nafter', extensions: [resourceSourceField] });
  state = state.update({ effects: setResourceSource.of({ from: 7, to: 17 }), selection: { anchor: 9 } }).state;
  state = state.update({ changes: { from: 0, insert: 'new\n' } }).state;
  assert.equal(state.field(resourceSourceField).from, 11);
  assert.equal(state.field(resourceSourceField).to, 21);
  state = state.update({ changes: { from: 13, insert: 'title' } }).state;
  assert.equal(state.field(resourceSourceField).to, 26);
  state = state.update({ selection: { anchor: state.doc.length } }).state;
  assert.equal(state.field(resourceSourceField), null);
});

test('double click opens the editor once, without revealing source or changing the document', () => {
  const doc = '[file](assets/report.pdf)';
  let edits = 0;
  const view = {
    state: EditorState.create({ doc, extensions: [resourceSourceField] }),
    dispatch(spec) { this.state = this.state.update(spec).state; },
    focus() {},
  };
  const wrap = new Element();
  bindResourcePreview(wrap, view, { from: 0, to: doc.length }, 'assets/report.pdf', '资源文件', false, () => edits++);
  wrap.fire('mousedown', { detail: 1 });
  assert.equal(edits, 0);
  wrap.fire('mousedown', { detail: 2 });
  wrap.fire('dblclick');
  assert.equal(edits, 1);
  assert.equal(view.state.field(resourceSourceField), null);
  assert.equal(view.state.doc.toString(), doc);
  const readonly = new Element();
  view.state = EditorState.create({ doc, extensions: [resourceSourceField, EditorState.readOnly.of(true)] });
  bindResourcePreview(readonly, view, { from: 0, to: doc.length }, 'assets/report.pdf', '资源文件', false, () => edits++);
  readonly.fire('mousedown', { detail: 2 });
  readonly.fire('dblclick');
  assert.equal(edits, 1);
});

test('read-only preview closes source and omits the editing button', () => {
  const lock = new Compartment();
  let state = EditorState.create({ doc: '[x](a.pdf)', extensions: [resourceSourceField, lock.of([])] });
  state = state.update({ effects: setResourceSource.of({ from: 0, to: state.doc.length }) }).state;
  state = state.update({ effects: lock.reconfigure(EditorState.readOnly.of(true)) }).state;
  assert.equal(state.field(resourceSourceField), null);
  const wrap = new Element();
  bindResourcePreview(wrap, { state }, { from: 0, to: state.doc.length }, 'a.pdf', '资源文件', false);
  assert.equal(wrap.children.length, 0);
});

test('common extensions have distinct icons; case, query, encoding and unknown files work', () => {
  const cases = {
    '<files/报告.PDF>': 'pdf', 'report.docx': 'document', 'budget.XLSX': 'spreadsheet',
    'slides.pptx': 'presentation', 'archive.tar.gz': 'archive', 'photo.png': 'image',
    'recording.mp3': 'audio', 'movie.mp4': 'video', 'main.py': 'code',
    'config.yaml': 'config', 'readme.md': 'text', 'report%2Epdf?download=1#page=2': 'pdf',
    'C:\\files\\report.pdf': 'pdf', 'unknown.xyz': 'file', 'LICENSE': 'file',
  };
  const icons = new Map();
  for (const [path, kind] of Object.entries(cases)) {
    const icon = resourceFileIcon(path);
    assert.equal(icon.kind, kind, path);
    icons.set(kind, icon.svg);
  }
  assert.equal(new Set(icons.values()).size, icons.size);
});

test('local files use resource previews while web links and anchors remain ordinary links', () => {
  for (const path of ['assets/report.pdf', '<assets/a b.zip>', 'C:\\files\\a.xlsx', '/tmp/unknown', '../README.md'])
    assert.equal(isResourceLink(path), true, path);
  for (const path of ['https://example.com', 'mailto:a@example.com', '#heading', '//example.com/page', 'www.example.com', ''])
    assert.equal(isResourceLink(path), false, path);
});
