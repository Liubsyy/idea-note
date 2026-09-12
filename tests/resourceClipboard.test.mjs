import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';
import ts from 'typescript';
import * as stateApi from '@codemirror/state';
import * as language from '@codemirror/language';
import * as viewApi from '@codemirror/view';
import { markdown, markdownLanguage } from '@codemirror/lang-markdown';

function load(path, dependencies) {
  const exports = {};
  vm.runInNewContext(ts.transpileModule(readFileSync(new URL(path, import.meta.url), 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText, { exports, require: (name) => {
    assert.ok(name in dependencies, `unexpected dependency: ${name}`);
    return dependencies[name];
  } });
  return exports;
}
const imageSyntax = load('../src/lib/imageSyntax.ts', {});
const imageAt = load('../src/lib/codemirror/imageAt.ts', {
  '@codemirror/language': language, '../imageSyntax': imageSyntax,
});
const resourceSourceField = stateApi.StateField.define({ create: () => null, update: (v) => v });
const calls = [];
const store = { activeFilePath: 'D:/notes/note.md', workspacePath: 'D:/notes' };
const clipboard = load('../src/lib/codemirror/resourceClipboard.ts', {
  '@codemirror/state': stateApi, '@codemirror/view': viewApi, '@codemirror/language': language,
  '../clipboard': {
    copyText: async (value) => calls.push(['text', value]),
    copyFileToClipboard: async (value) => calls.push(['file', value]),
    copyImageToClipboard: async (value) => calls.push(['image', value]),
  },
  '../fs': { dirname: (path) => path.slice(0, path.lastIndexOf('/')) },
  '../imageSyntax': imageSyntax,
  '../../store/useAppStore': { isDraftPath: (p) => p.startsWith('draft:'), useAppStore: { getState: () => store } },
  './imageAt': imageAt,
  './resourcePreview': { resourceSourceField, isResourceLink: (s) => !/^https?:/.test(s) },
});
const { selectedClipboardResource, resolveClipboardFilePath, copyEditorSelection } = clipboard;
function state(doc, selection = { anchor: 0, head: doc.length }, preview = true) {
  return stateApi.EditorState.create({ doc, selection, extensions: [
    markdown({ base: markdownLanguage }), ...(preview ? [resourceSourceField] : []),
  ] });
}

test('copy uses image pixels or actual file paths, while text-only preserves exact source', async () => {
  for (const [doc, kind, url] of [
    ['![photo](assets/photo.png)', 'image', 'assets/photo.png'],
    ['![photo](assets/a b.png =300x200)', 'image', 'assets/a b.png'],
    ['<img src="assets/photo.png" width="100">', 'image', 'assets/photo.png'],
    ['[report](<assets/annual report.pdf> "title")', 'file', 'D:/notes/assets/annual report.pdf'],
    ['[image file](assets/photo.png)', 'file', 'D:/notes/assets/photo.png'],
  ]) {
    const view = { state: state(doc) };
    await copyEditorSelection(view);
    assert.deepEqual(calls.at(-1), [kind, url]);
    await copyEditorSelection(view, true);
    assert.deepEqual(calls.at(-1), ['text', doc]);
  }
});

test('ordinary text, mixed selections, code, partial selections and source mode copy text', async () => {
  for (const doc of ['plain text', 'text ![photo](a.png)', '`![photo](a.png)`', '[web](https://example.com)']) {
    const view = { state: state(doc) };
    assert.equal(selectedClipboardResource(view.state), null);
    await copyEditorSelection(view);
    assert.deepEqual(calls.at(-1), ['text', doc]);
  }
  assert.equal(selectedClipboardResource(state('![photo](a.png)', {anchor:2, head:5})), null);
  assert.equal(selectedClipboardResource(state('![photo](a.png)', undefined, false)), null);
  const doc = '```md\n![photo](a.png)\n```';
  assert.equal(selectedClipboardResource(state(doc, {anchor:6, head:21})), null);
});

test('file paths resolve against the note, with spaces, fragments, drives and UNC roots', () => {
  assert.equal(resolveClipboardFilePath('<../files/a%20b.pdf#page=2>', 'D:/notes/sub'), 'D:/notes/files/a b.pdf');
  assert.equal(resolveClipboardFilePath('C:\\files\\a.zip', null), 'C:/files/a.zip');
  assert.equal(resolveClipboardFilePath('\\\\server\\share\\sub\\..\\file.zip', null), '//server/share/file.zip');
  assert.equal(resolveClipboardFilePath('../a.pdf', '/notes/sub'), '/notes/a.pdf');
  assert.throws(() => resolveClipboardFilePath('a.pdf', null));
});

test('revealed source copies text while read-only rendered images still copy pixels', () => {
  const doc = '![photo](a.png)';
  const base = { doc, selection: {anchor:0, head:doc.length} };
  const source = stateApi.EditorState.create({ ...base, extensions: [
    markdown(), resourceSourceField.init(() => ({from:0, to:doc.length})),
  ] });
  assert.equal(selectedClipboardResource(source), null);
  const readonly = stateApi.EditorState.create({ ...base, extensions: [
    markdown(), resourceSourceField, stateApi.EditorState.readOnly.of(true),
  ] });
  assert.equal(selectedClipboardResource(readonly).kind, 'image');
});

test('unsaved notes use the workspace to resolve copied attachments', async () => {
  store.activeFilePath = 'draft:1';
  await copyEditorSelection({ state: state('[file](assets/a.zip)') });
  assert.deepEqual(calls.at(-1), ['file', 'D:/notes/assets/a.zip']);
  store.activeFilePath = 'D:/notes/note.md';
});
