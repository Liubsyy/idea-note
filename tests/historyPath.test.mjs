import assert from 'node:assert/strict';
import { i18nDependency } from './i18nHarness.mjs';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import ts from 'typescript';
import { relativePathWithinWorkspace } from '../src/lib/workspacePath.ts';

test('external paths never become an empty or accidental project-relative file path', () => {
  const root = 'D:/Dev/CodexProject/idea-note';
  for (const path of ['C:/note.md', 'D:/note.md', `${root}-other/readme.md`, `${root}/../secret.md`,
    '/tmp/note.md', 'draft:untitled', 'readme.md']) {
    assert.equal(relativePathWithinWorkspace(root, path), null, path);
  }
  assert.equal(relativePathWithinWorkspace(root, root), '');
});
test('absolute history paths handle Windows separators/case, normalization, root workspaces and UNC', () => {
  assert.equal(relativePathWithinWorkspace('D:\\Dev\\Notes\\', 'd:/dev/notes/doc/../中文 笔记.md'), '中文 笔记.md');
  assert.equal(relativePathWithinWorkspace('D:/', 'd:/note.md'), 'note.md');
  assert.equal(relativePathWithinWorkspace('/', '/note.md'), 'note.md');
  assert.equal(relativePathWithinWorkspace('\\\\server\\share\\notes', '//SERVER/share/notes/a.md'), 'a.md');
  assert.equal(relativePathWithinWorkspace('\\\\server\\share\\notes', '//server/share/notes-other/a.md'), null);
  assert.equal(relativePathWithinWorkspace('/home/notes', '/home/Notes/a.md'), null);
  assert.equal(relativePathWithinWorkspace('/home/notes', '/home/notes/name .md'), 'name .md');
});

const compiled = ts.transpileModule(readFileSync(new URL('../src/lib/git.ts', import.meta.url), 'utf8'), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
}).outputText;
function gitHarness() {
  const calls = [];
  const exports = {};
  vm.runInNewContext(compiled, { exports, require: name => {
    if (name.includes('/i18n/')) return i18nDependency(name);
    assert.equal(name, '@tauri-apps/api/core');
    return { invoke: async (command, args) => { calls.push({command, ...args}); return {code:0,stdout:'',stderr:''}; } };
  } });
  return { calls, git: exports };
}
test('file history rejects empty, root, absolute and traversal paths before querying Git', async () => {
  const {git,calls} = gitHarness();
  for (const path of ['', '.', '../x.md', 'a/../b.md', 'D:/x.md', '/tmp/x.md', '\\server\\x', 'a//b'])
    await assert.rejects(git.listFileHistory('D:/project', path), /有效文件路径/);
  assert.equal(calls.length,0);
});
test('file history and working changes use literal paths, including glob-looking filenames', async () => {
  const {git,calls} = gitHarness();
  await git.listFileHistory('D:/project/sub', 'doc/[draft]*.md');
  await git.listWorkingChanges('D:/project/sub', 'doc/[draft]*.md');
  for (const call of calls) {
    assert.equal(call.dir,'D:/project/sub');
    assert.ok(call.args.includes('--literal-pathspecs'));
    assert.equal(call.args.at(-1),'./doc/[draft]*.md');
  }
});
