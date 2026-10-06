import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';
import ts from 'typescript';
import { i18nDependency } from './i18nHarness.mjs';

const { translate, resolveSystemLanguage, isAppLanguage } = i18nDependency('core');
const en = i18nDependency('en').default;

test('only Chinese and English are supported; system locales fall back predictably', () => {
  for (const locale of ['zh', 'zh-CN', 'zh_TW', 'zh-Hant-HK', ' ZH-cn ']) assert.equal(resolveSystemLanguage(locale), 'zh-CN');
  for (const locale of ['en', 'en-US', 'ja-JP', 'de-DE', '', undefined]) assert.equal(resolveSystemLanguage(locale), 'en');
  assert.ok(isAppLanguage('en') && isAppLanguage('zh-CN'));
  assert.ok(!isAppLanguage('zh-TW') && !isAppLanguage(null));
});

test('all catalog entries preserve interpolation parameters and contain English text', () => {
  const placeholders = text => [...new Set(text.match(/\{\{\w+\}\}/g) ?? [])].sort();
  for (const [key, value] of Object.entries(en)) {
    assert.ok(value.trim(), key);
    assert.ok(!/\p{Script=Han}/u.test(value), key);
    assert.deepEqual(placeholders(value), placeholders(key), key);
    assert.equal(translate('zh-CN', key), key);
  }
});

test('interpolation preserves paths, markup, dollars, and nested placeholder-like user text verbatim', () => {
  const path = 'D:\\我的笔记\\{{1}} $& <script>.md';
  assert.equal(translate('en', '无法删除「{{0}}」', { 0: path }), `Could not delete “${path}”`);
  assert.equal(translate('en', 'unknown {{0}}', { 0: path }), `unknown ${path}`);
  assert.equal(translate('en', 'toString'), 'toString');
  assert.equal(translate('zh-CN', '第 {{0}} 行：{{1}}', { 0: 0, 1: '' }), '第 0 行：');
});

test('language persists, restores, synchronizes storage events, and does not publish on failed save', () => {
  const saved = new Map();
  const events = new Map();
  const document = { documentElement: { lang: '' } };
  const window = {
    addEventListener: (name, fn) => events.set(name, fn),
    dispatchEvent: (event) => events.get(event.type)?.(event),
  };
  let failSave = false;
  const localStorage = {
    getItem: key => saved.get(key) ?? null,
    setItem: (key, value) => { if (failSave) throw Error('disk full'); saved.set(key, value); },
  };
  const load = () => {
    const exports = {};
    vm.runInNewContext(ts.transpileModule(readFileSync(new URL('../src/i18n/core.ts', import.meta.url), 'utf8'), {
      compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
    }).outputText, {
      exports, document, window, localStorage, navigator: { language: 'zh-CN' },
      CustomEvent: class { constructor(type, options) { this.type = type; this.detail = options.detail; } },
      require: () => ({ default: en }),
    });
    return exports;
  };
  const app = load();
  assert.equal(app.currentLanguage(), 'zh-CN');
  let notifications = 0;
  const unsubscribe = app.subscribeLanguage(() => notifications++);
  app.changeLanguage('en');
  assert.equal(document.documentElement.lang, 'en');
  assert.equal(app.readLanguage(), 'en');
  assert.equal(notifications, 1);
  assert.equal(load().currentLanguage(), 'en');
  app.changeLanguage('en');
  assert.equal(notifications, 1);
  failSave = true;
  assert.throws(() => app.changeLanguage('zh-CN'), /disk full/);
  assert.equal(app.currentLanguage(), 'en');
  failSave = false;
  saved.set(app.LANGUAGE_KEY, 'zh-CN');
  // Each loaded webview receives the same storage event independently.
  events.get('storage')({ key: app.LANGUAGE_KEY });
  assert.equal(document.documentElement.lang, 'zh-CN');
  unsubscribe();
});

test('every literal translation key used in application code has an English entry', () => {
  function scan(dir) {
    for (const item of readdirSync(dir, { withFileTypes: true })) {
      const file = `${dir}/${item.name}`;
      if (item.isDirectory()) { if (item.name !== 'i18n') scan(file); continue; }
      if (!/\.tsx?$/.test(file)) continue;
      const sf = ts.createSourceFile(file, readFileSync(file, 'utf8'), ts.ScriptTarget.Latest, true);
      function visit(node) {
        if (ts.isCallExpression(node) && node.expression.getText(sf) === 'tr' && ts.isStringLiteral(node.arguments[0])) {
          assert.ok(Object.hasOwn(en, node.arguments[0].text), `${file}: ${node.arguments[0].text}`);
        }
        ts.forEachChild(node, visit);
      }
      visit(sf);
    }
  }
  scan(new URL('../src', import.meta.url).pathname.replace(/^\/(\w:)/, '$1'));
});

test('localized component templates still execute and emit valid protocol JSON', () => {
  const locale = i18nDependency('core');
  const exports = {};
  vm.runInNewContext(ts.transpileModule(readFileSync(new URL('../src/lib/codeRun/componentTemplate.ts', import.meta.url), 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText, { exports, require: () => locale });
  try {
    for (const language of ['zh-CN', 'en']) {
      locale.applyLanguage(language);
      for (const out of ['text', 'markdown', 'html', 'mermaid', 'json', 'table', 'image']) {
        const snippet = exports.buildComponentSnippet({ lang: 'node', source: 'input', name: 'params', out, placement: 'above' });
        const code = snippet.match(/```node[^\n]*\n([\s\S]*?)\n```/)[1];
        const lines = [];
        vm.runInNewContext(code, { console: { log: value => lines.push(value) }, process: { env: { amount: '42' } } });
        const result = JSON.parse(lines.at(-1));
        assert.notEqual(result, undefined);
        if (out === 'table') assert.equal(result.rows[0][1], 42);
        if (language === 'en') assert.ok(!/\p{Script=Han}/u.test(snippet));
      }
    }
  } finally { locale.applyLanguage('zh-CN'); }
});
