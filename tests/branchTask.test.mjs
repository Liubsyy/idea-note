import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';
import ts from 'typescript';
import { i18nDependency } from './i18nHarness.mjs';

const source = ts.createSourceFile('useAppStore.ts', readFileSync(new URL('../src/store/useAppStore.ts', import.meta.url), 'utf8'), ts.ScriptTarget.Latest, true);
let action;
function visit(node) {
  if (ts.isPropertyAssignment(node) && node.name.getText(source) === 'runBranchTask') action = node.initializer.getText(source);
  ts.forEachChild(node, visit);
}
visit(source);
assert.ok(action);
const code = ts.transpileModule(`exports.run = ${action};`, {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
}).outputText;

function harness(overrides = {}) {
  const calls = [];
  const state = {
    workspacePath: '/repo', syncState: 'idle', branchTaskBusy: false, vaultRotationBusy: false,
    activeFilePath: '/repo/note.md', openTabs: ['/repo/note.md', '/repo/deleted.md', 'draft:1'],
    content: 'old content', isDirty: false, docKey: 1, lastSyncAt: 123,
    flushActiveTab: async () => { calls.push('save'); },
    refreshTree: async () => { calls.push('tree'); },
    refreshGitInfo: async () => { calls.push('gitInfo'); },
    openFile: async path => { calls.push(path); state.content = 'new branch content'; },
    ...overrides,
  };
  const exports = {};
  vm.runInNewContext(code, {
    exports, get: () => state,
    set: update => Object.assign(state, typeof update === 'function' ? update(state) : update),
    tr: i18nDependency('core').tr, emptyFormats: {},
    isDraftPath: path => path.startsWith('draft:'),
    fileStat: async path => path === '/repo/note.md' ? { size: 1 } : null,
  });
  return { state, calls, run: exports.run };
}

test('branch switches save first, reload the editor and remove missing tabs without changing sync time', async () => {
  const { run, state, calls } = harness();
  await run(async dir => {
    assert.equal(dir, '/repo');
    assert.equal(state.branchTaskBusy, true);
    assert.equal(calls[0], 'save');
    return true;
  });
  assert.deepEqual(calls, ['save', 'tree', '/repo/note.md', 'gitInfo']);
  assert.deepEqual(Array.from(state.openTabs), ['/repo/note.md', 'draft:1']);
  assert.equal(state.content, 'new branch content');
  assert.equal(state.lastSyncAt, 123);
  assert.equal(state.branchTaskBusy, false);
});

test('metadata-only operations preserve the editor; failed tasks release the busy flag', async () => {
  const { run, state, calls } = harness();
  await run(async () => false);
  assert.deepEqual(calls, ['save', 'gitInfo']);
  assert.equal(state.content, 'old content');
  await assert.rejects(run(async () => { throw new Error('dirty tree'); }), /dirty tree/);
  assert.equal(state.branchTaskBusy, false);
});

test('branch tasks cannot overlap sync, another branch task, or key rotation', async () => {
  for (const overrides of [{ syncState: 'syncing' }, { branchTaskBusy: true }, { vaultRotationBusy: true }]) {
    const { run, calls } = harness(overrides);
    await assert.rejects(run(async () => { assert.fail('must not run'); }), /稍后重试/);
    assert.equal(calls.length, 0);
  }
});
