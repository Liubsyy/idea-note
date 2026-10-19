import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';
import ts from 'typescript';
import { i18nDependency } from './i18nHarness.mjs';

const locale = i18nDependency('core');
const moduleUrl = new URL('../src/lib/ai/commitMessage.ts', import.meta.url);

function loadGenerator(send) {
  const exports = {};
  vm.runInNewContext(ts.transpileModule(readFileSync(moduleUrl, 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText, {
    exports, AbortController, setTimeout, clearTimeout,
    require(name) {
      if (name.includes('/i18n/')) return locale;
      if (name.endsWith('?raw')) {
        return { default: readFileSync(new URL(name.slice(0, -4), moduleUrl), 'utf8') };
      }
      if (name === './openai' || name === './anthropic') return { send };
      if (name === '../git') return {
        collectStagedChanges: async () => ({ stat: 'notes.md | 1 +', diff: '+new note' }),
      };
      throw new Error(`Unexpected dependency: ${name}`);
    },
  });
  return exports.generateCommitMessage;
}

test('AI generation uses the full bundled guide for the current interface language', async () => {
  const calls = [];
  const generate = loadGenerator(async (...args) => {
    calls.push(args);
    return { text: 'docs: update notes' };
  });
  try {
    // Reuse the loaded generator so a language switch must take effect without a reload.
    for (const language of ['zh-CN', 'en']) {
      locale.applyLanguage(language);
      assert.equal(await generate({ provider: 'openai' }, '/notes', '  '), 'docs: update notes');
      const [, history, , system] = calls.at(-1);
      const guide = readFileSync(new URL(language === 'en'
        ? '../GIT_COMMIT_GUIDE.en.md' : '../GIT_COMMIT_GUIDE.md', import.meta.url), 'utf8').trim();
      assert.ok(system.endsWith(guide));
      assert.match(system, /<type>\(<scope>\): <subject>/);
      assert.ok(history[0].content.includes('+new note'));
      if (language === 'en') assert.ok(!/\p{Script=Han}/u.test(system));
    }
  } finally { locale.applyLanguage('zh-CN'); }
});

test('custom guidelines are appended with priority over the built-in guide for both providers', async () => {
  const systems = [];
  const generate = loadGenerator(async (_model, _history, _tools, system) => {
    systems.push(system);
    return { text: 'Notes: updated' };
  });
  const custom = 'Start with Notes: and preserve {{0}} verbatim';
  try {
    for (const language of ['zh-CN', 'en']) {
      locale.applyLanguage(language);
      await generate({ provider: language === 'en' ? 'anthropic' : 'openai' }, '/notes', ` ${custom} `);
      const system = systems.at(-1);
      assert.match(system, /<type>\(<scope>\): <subject>/);
      assert.ok(system.includes(language === 'en' ? 'override the defaults above' : '优先于以上默认格式'));
      assert.ok(system.endsWith(custom));
    }
  } finally { locale.applyLanguage('zh-CN'); }
});
