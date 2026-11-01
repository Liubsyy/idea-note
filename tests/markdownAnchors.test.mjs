import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';
import ts from 'typescript';
import { EditorState } from '@codemirror/state';
import * as language from '@codemirror/language';
import { markdown } from '@codemirror/lang-markdown';
import { EditorView, ViewPlugin } from '@codemirror/view';
import { findMarkdownAnchorLine } from '../src/lib/markdownAnchors.ts';
import { i18nDependency } from './i18nHarness.mjs';

test('Chinese, English, encoded fragments and both heading styles resolve source lines', () => {
  const source = '# 前言\r\n\r\n## 安装\r\n\r\n### Hello, World! ###\r\n\r\nSetext 标题\r\n---';
  for (const [fragment, line] of [
    ['#安装', 3], ['#%E5%AE%89%E8%A3%85', 3], ['#hello-world', 5],
    ['#Hello-World', 5], ['#setext-标题', 7], ['#', 1],
  ]) assert.equal(findMarkdownAnchorLine(source, fragment), line, fragment);
  assert.equal(findMarkdownAnchorLine('', '#'), 1);
});

test('inline formatting, links, images, entities and escapes use readable heading text', () => {
  const source = '## **安装** [应用](https://example.com) `v2` ![图标](icon.png) &amp; <em>使用</em> \\_ok\\_';
  assert.equal(findMarkdownAnchorLine(source, '#安装-应用-v2-图标-使用-_ok_'), 1);
  assert.equal(findMarkdownAnchorLine('## 八、表格（GFM）', '#八表格gfm'), 1);
});

test('duplicate headings have unique suffixes even when a literal suffix already exists', () => {
  const source = '# 安装\n\n## 安装-1\n\n### 安装\n\n#### 安装\n\n## 安装-1';
  for (const [fragment, line] of [
    ['#安装', 1], ['#安装-1', 3], ['#安装-2', 5], ['#安装-3', 7], ['#安装-1-1', 9],
  ]) assert.equal(findMarkdownAnchorLine(source, fragment), line, fragment);
});

test('code fences, indented code and HTML examples do not claim real heading anchors', () => {
  const source = [
    '````md', '```md', '# 安装', '```', '````', '',
    '~~~md', '# 安装', '~~~', '', '    # 安装', '',
    '<!--', '# 安装', '-->', '', '<pre>', '# 安装', '</pre>', '',
    '# 安装', '', '> ## 引用标题', '', '- ### 列表标题',
  ].join('\n');
  assert.equal(findMarkdownAnchorLine(source, '#安装'), 21);
  assert.equal(findMarkdownAnchorLine(source, '#安装-1'), null);
  assert.equal(findMarkdownAnchorLine(source, '#引用标题'), 23);
  assert.equal(findMarkdownAnchorLine(source, '#列表标题'), 25);
});

test('unknown and malformed fragments safely leave the document alone', () => {
  for (const fragment of ['#不存在', '#%E0%A4%A', 'https://example.com/#安装', 'note.md#安装'])
    assert.equal(findMarkdownAnchorLine('# 安装', fragment), null);
});

const calls = [];
let activeView = null;
let clickHandlers;
const store = {
  activeFilePath: 'D:/notes/sub/note.md', workspacePath: 'D:/notes',
  openFile: async path => calls.push(['file', path]),
  showToast: (...args) => calls.push(['toast', ...args]),
};
const dependencies = {
  '@codemirror/language': language,
  '@codemirror/view': {
    ViewPlugin,
    EditorView: {
      scrollIntoView: EditorView.scrollIntoView,
      domEventHandlers: handlers => { clickHandlers = handlers; return []; },
    },
  },
  '@tauri-apps/plugin-opener': { openUrl: async url => calls.push(['url', url]) },
  '../../store/useAppStore': { isDraftPath: path => path.startsWith('draft:'), useAppStore: { getState: () => store } },
  '../fs': {
    fileStat: async path => { calls.push(['stat', path]); return !path.endsWith('missing.md'); },
    pathIsDir: async path => { calls.push(['dir', path]); return path.endsWith('/folder'); },
  },
  '../markdownAnchors': { findMarkdownAnchorLine },
  './activeView': { getActiveView: () => activeView },
};
const exports = {};
vm.runInNewContext(ts.transpileModule(readFileSync(new URL('../src/lib/codemirror/linkClick.ts', import.meta.url), 'utf8'), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
}).outputText, { exports, require: name => {
  if (name.includes('/i18n/')) return i18nDependency(name);
  assert.ok(name in dependencies, `unexpected dependency: ${name}`);
  return dependencies[name];
} });

function editor(doc, readOnly = false) {
  const transactions = [];
  const view = {
    state: EditorState.create({ doc, selection: { anchor: 1 }, extensions: [markdown(), EditorState.readOnly.of(readOnly)] }),
    dispatch(spec) {
      const transaction = this.state.update(spec);
      transactions.push(transaction);
      this.state = transaction.state;
    },
  };
  return { view, transactions };
}

test('anchor navigation only scrolls; live and read-only notes keep content and selection', async () => {
  for (const readOnly of [false, true]) {
    const doc = '[下载应用](#安装)\n\n## 安装\n\n内容';
    const { view, transactions } = editor(doc, readOnly);
    activeView = view;
    const selection = view.state.selection;
    calls.length = 0;
    // This public entry point is also used by rendered table-cell links.
    await exports.openLinkTarget('<#%E5%AE%89%E8%A3%85>');
    assert.equal(transactions.length, 1);
    const transaction = transactions[0];
    assert.equal(transaction.docChanged, false);
    assert.equal(transaction.selection, undefined);
    assert.equal(view.state.selection, selection);
    assert.equal(view.state.doc.toString(), doc);
    assert.equal(transaction.effects[0].value.range.head, doc.indexOf('## 安装'));
    assert.equal(transaction.effects[0].value.y, 'start');
    assert.deepEqual(calls, []);
    await exports.openLinkTarget('#不存在');
    assert.equal(transactions.length, 1);
    await exports.openLinkTarget('#');
    assert.equal(transactions[1].effects[0].value.range.head, 0);
  }
  activeView = null;
  await exports.openLinkTarget('#安装');
});

test('anchors use the current editor document after edits, even if store content is stale', async () => {
  const { view, transactions } = editor('# 安装');
  view.dispatch({ changes: { from: 0, insert: '新增内容\n\n' } });
  activeView = view;
  await exports.openLinkTarget('#安装');
  assert.equal(transactions[1].effects[0].value.range.head, '新增内容\n\n'.length);
});

test('plain clicks keep editing; only Ctrl/Cmd plus left click follows the anchor', () => {
  const { view, transactions } = editor('[下载应用](#安装)\n\n## 安装');
  view.posAtCoords = () => 3;
  activeView = view;
  let prevented = 0;
  const event = { button: 0, ctrlKey: false, metaKey: false, clientX: 0, clientY: 0, preventDefault() { prevented++; } };
  assert.equal(clickHandlers.mousedown(event, view), false);
  assert.equal(clickHandlers.mousedown({ ...event, ctrlKey: true, button: 2 }, view), false);
  assert.equal(transactions.length, 0);
  for (const modifier of ['ctrlKey', 'metaKey'])
    assert.equal(clickHandlers.mousedown({ ...event, [modifier]: true }, view), true);
  assert.equal(transactions.length, 2);
  assert.equal(prevented, 2);
});

test('web, email, phone and bare www links retain their destinations including fragments', async () => {
  for (const [raw, expected] of [
    ['https://example.com/#安装', 'https://example.com/#安装'],
    ['http://example.com/#install', 'http://example.com/#install'],
    ['<mailto:a@example.com>', 'mailto:a@example.com'], ['tel:12345', 'tel:12345'],
    ['www.example.com/#install', 'https://www.example.com/#install'],
  ]) {
    calls.length = 0;
    await exports.openLinkTarget(raw);
    assert.deepEqual(calls, [['url', expected]]);
  }
});

test('file links retain relative paths, URL decoding, fragment stripping and existing errors', async () => {
  for (const [raw, expected] of [
    ['../other.md#安装', 'D:/notes/other.md'],
    ['<assets/a%20b.pdf#page=2>', 'D:/notes/sub/assets/a b.pdf'],
    ['C:\\files\\a.md', 'C:/files/a.md'],
  ]) {
    calls.length = 0;
    await exports.openLinkTarget(raw);
    assert.deepEqual(calls, [['dir', expected], ['stat', expected], ['file', expected]]);
  }
  for (const raw of ['missing.md', 'folder']) {
    calls.length = 0;
    await exports.openLinkTarget(raw);
    assert.equal(calls.at(-1)[0], 'toast');
    assert.ok(!calls.some(call => call[0] === 'file'));
  }
});
