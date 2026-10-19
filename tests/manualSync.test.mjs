import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import vm from 'node:vm';
import ts from 'typescript';
import { i18nDependency } from './i18nHarness.mjs';

const compiled = ts.transpileModule(readFileSync(new URL('../src/lib/git.ts', import.meta.url), 'utf8'), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
}).outputText;

function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), 'idea-note-manual-sync-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const env = { ...process.env, GIT_CONFIG_GLOBAL: join(root, 'gitconfig'), GIT_CONFIG_NOSYSTEM: '1', GIT_TERMINAL_PROMPT: '0' };
  function run(dir, args) {
    const result = spawnSync('git', args, { cwd: dir, env, encoding: 'utf8' });
    if (result.error) throw result.error;
    return { code: result.status, stdout: result.stdout, stderr: result.stderr };
  }
  function git(dir, ...args) {
    const result = run(dir, args);
    assert.equal(result.code, 0, `${args.join(' ')}: ${result.stderr}`);
    return result.stdout;
  }
  const remote = join(root, 'remote.git'), local = join(root, 'local'), peer = join(root, 'peer');
  git(root, 'init', '--bare', '--initial-branch=main', remote);
  git(root, 'init', '--initial-branch=main', local);
  for (const dir of [local]) {
    git(dir, 'config', 'user.name', 'Sync Test');
    git(dir, 'config', 'user.email', 'sync-test@example.test');
  }
  mkdirSync(join(local, 'notes'));
  const selected = 'notes/笔记 [草稿].md', unchecked = 'unchecked.md', untracked = 'new file.md';
  writeFileSync(join(local, selected), 'base\n');
  writeFileSync(join(local, unchecked), 'original unchecked\n');
  git(local, 'add', '.');
  git(local, 'commit', '-m', 'base');
  git(local, 'remote', 'add', 'origin', remote);
  git(local, 'push', '-u', 'origin', 'main');
  git(root, 'clone', remote, peer);
  git(peer, 'config', 'user.name', 'Sync Test');
  git(peer, 'config', 'user.email', 'sync-test@example.test');
  const exports = {};
  vm.runInNewContext(compiled, { exports, require(name) {
    if (name.includes('/i18n/')) return i18nDependency(name);
    assert.equal(name, '@tauri-apps/api/core');
    return { invoke: async (command, { dir, args, path, content }) => {
      if (command === 'read_file') return readFileSync(path, 'utf8');
      if (command === 'write_file') return writeFileSync(path, content);
      assert.equal(command, 'git_run');
      return run(dir, args);
    } };
  } });
  return { git, api: exports, local, peer, selected, unchecked, untracked };
}

for (const conflict of [false, true]) {
  test(`manual commit and sync preserve unchecked edits and untracked files (${conflict ? 'conflicted' : 'clean'} merge)`, async t => {
    const { git, api, local, peer, selected, unchecked, untracked } = fixture(t);
    writeFileSync(join(local, selected), 'local change\n');
    writeFileSync(join(local, unchecked), 'private unchecked edit\n');
    writeFileSync(join(local, untracked), 'private untracked file\n');
    // Work from a subdirectory to exercise root-relative paths during conflict handling.
    const workspace = join(local, 'notes');
    assert.equal(await api.commitSelected(workspace, [selected], 'selected change'), true);
    if (conflict) writeFileSync(join(peer, selected), 'remote change\n');
    else writeFileSync(join(peer, 'remote.md'), 'remote addition\n');
    git(peer, 'add', '.');
    git(peer, 'commit', '-m', 'remote change');
    git(peer, 'push');

    const result = await api.syncWorkspace(workspace, undefined, undefined, undefined, false);
    assert.equal(result.ok, true, result.message);
    assert.equal(readFileSync(join(local, unchecked), 'utf8'), 'private unchecked edit\n');
    assert.equal(readFileSync(join(local, untracked), 'utf8'), 'private untracked file\n');
    assert.equal(git(local, 'show', `HEAD:${unchecked}`), 'original unchecked\n');
    assert.ok(!git(local, 'ls-tree', '-r', '--name-only', 'HEAD').split('\n').includes(untracked));
    assert.deepEqual(Array.from(result.conflictFiles), conflict ? [selected] : []);
    assert.equal(git(local, 'diff', '--name-only').trim(), unchecked);
    assert.equal(git(local, 'diff', '--cached', '--name-only'), '');
    assert.equal(git(local, 'rev-parse', 'HEAD'), git(peer, 'ls-remote', 'origin', 'refs/heads/main').split('\t')[0] + '\n');
    if (conflict) {
      const committed = git(local, 'show', `HEAD:${selected}`);
      assert.match(committed, /<<<<<<< HEAD/);
      assert.match(committed, /local change/);
      assert.match(committed, /remote change/);
    }
  });
}

test('a merge blocked by unchecked edits preserves them and keeps the selected local commit', async t => {
  const { git, api, local, peer, selected, unchecked } = fixture(t);
  writeFileSync(join(local, selected), 'selected change\n');
  writeFileSync(join(local, unchecked), 'private unchecked edit\n');
  await api.commitSelected(local, [selected], 'selected change');
  const localCommit = git(local, 'rev-parse', 'HEAD');
  writeFileSync(join(peer, unchecked), 'remote change to unchecked file\n');
  git(peer, 'add', '.');
  git(peer, 'commit', '-m', 'remote change');
  git(peer, 'push');

  const result = await api.syncWorkspace(local, undefined, undefined, undefined, false);
  assert.equal(result.ok, false);
  assert.equal(git(local, 'rev-parse', 'HEAD'), localCommit);
  assert.equal(git(local, 'show', `HEAD:${unchecked}`), 'original unchecked\n');
  assert.equal(readFileSync(join(local, unchecked), 'utf8'), 'private unchecked edit\n');
  assert.equal(git(local, 'diff', '--cached', '--name-only'), '');
  assert.equal(git(local, 'status', '--porcelain').trim(), `M ${unchecked}`);
});

test('ignore creates .gitignore at the repository root and matches only selected files and folders', async t => {
  const { git, api, local } = fixture(t);
  const ignored = 'notes/临时 [草稿].txt', other = 'notes/临时 草.txt';
  writeFileSync(join(local, ignored), 'ignore this\n');
  writeFileSync(join(local, other), 'keep this\n');
  mkdirSync(join(local, 'cache data'));
  writeFileSync(join(local, 'cache data', 'cache.txt'), 'cache\n');

  await api.ignoreUntracked(join(local, 'notes'), [ignored, 'cache data']);
  assert.equal(readFileSync(join(local, '.gitignore'), 'utf8'), '/notes/临时 \\[草稿\\].txt\n/cache data\n');
  const remaining = git(local, 'ls-files', '--others', '--exclude-standard', '-z').split('\0').filter(Boolean);
  assert.deepEqual(remaining, [other]);
  assert.ok(git(local, 'ls-files', '-z').split('\0').includes('.gitignore'));
});

test('ignore preserves existing rules, avoids duplicates, and leaves tracked files tracked', async t => {
  const { git, api, local, selected } = fixture(t);
  writeFileSync(join(local, '.gitignore'), '# existing rules\r\n/cache');
  await api.ignoreUntracked(local, [selected]);
  const expected = '# existing rules\r\n/cache\n/notes/笔记 \\[草稿\\].md\n';
  assert.equal(readFileSync(join(local, '.gitignore'), 'utf8'), expected);
  await api.ignoreUntracked(local, [selected]);
  assert.equal(readFileSync(join(local, '.gitignore'), 'utf8'), expected);
  git(local, '--literal-pathspecs', 'ls-files', '--error-unmatch', '--', selected);
  assert.equal(git(local, 'show', `HEAD:${selected}`), 'base\n');
});

test('change preview reads edited, added, deleted and renamed files without changing Git state', async t => {
  const { git, api, local, selected } = fixture(t);
  const workspace = join(local, 'notes');
  const cases = [];
  writeFileSync(join(local, selected), 'current edited content\n');
  const editedStatus = git(local, 'status', '--porcelain', '-z');
  const edited = await api.readWorkingChange(workspace, { path: selected, status: 'M' });
  assert.equal(edited.oldText, 'base\n');
  assert.equal(edited.newText, 'current edited content\n');
  assert.equal(git(local, 'status', '--porcelain', '-z'), editedStatus);
  const added = 'notes/new file.md';
  writeFileSync(join(local, added), 'new content\n');
  cases.push([{ path: added, status: 'A' }, '', 'new content\n']);
  const deleted = 'unchecked.md';
  rmSync(join(local, deleted));
  cases.push([{ path: deleted, status: 'D' }, 'original unchecked\n', '']);
  const renamed = 'notes/renamed [草稿].md';
  git(local, 'mv', '--', selected, renamed);
  cases.push([{ path: renamed, oldPath: selected, status: 'R' }, 'base\n', 'current edited content\n']);
  const beforeStatus = git(local, 'status', '--porcelain', '-z');
  const beforeIndex = git(local, 'diff', '--cached', '--binary');
  for (const [file, oldText, newText] of cases) {
    const result = await api.readWorkingChange(workspace, file);
    assert.equal(result.oldText, oldText);
    assert.equal(result.newText, newText);
  }
  assert.equal(git(local, 'status', '--porcelain', '-z'), beforeStatus);
  assert.equal(git(local, 'diff', '--cached', '--binary'), beforeIndex);
  await assert.rejects(api.readWorkingChange(local, { path: 'missing.md', status: 'M' }), /ENOENT/);
});

test('change preview treats HEAD as empty before the first commit', async t => {
  const { git, api, local } = fixture(t);
  const unborn = join(local, 'unborn');
  git(local, 'init', '--initial-branch=main', unborn);
  writeFileSync(join(unborn, 'first.md'), 'first note\n');
  const result = await api.readWorkingChange(unborn, { path: 'first.md', status: 'A' });
  assert.equal(result.oldText, '');
  assert.equal(result.newText, 'first note\n');
});

test('discard from a subdirectory restores only the exact selected path', async t => {
  const { git, api, local, selected, unchecked } = fixture(t);
  const decoy = 'notes/笔记 草.md';
  writeFileSync(join(local, decoy), 'decoy base\n');
  git(local, '--literal-pathspecs', 'add', '--', decoy);
  git(local, 'commit', '-m', 'add similar filename');
  writeFileSync(join(local, selected), 'discard this\n');
  writeFileSync(join(local, decoy), 'keep decoy edit\n');
  writeFileSync(join(local, unchecked), 'keep other edit\n');
  const head = git(local, 'rev-parse', 'HEAD');
  await api.discardWorkingChanges(join(local, 'notes'), [{ path: selected, status: 'M' }]);
  assert.equal(readFileSync(join(local, selected), 'utf8'), 'base\n');
  assert.equal(readFileSync(join(local, decoy), 'utf8'), 'keep decoy edit\n');
  assert.equal(readFileSync(join(local, unchecked), 'utf8'), 'keep other edit\n');
  assert.equal(git(local, 'rev-parse', 'HEAD'), head);
});

for (const action of ['deleted', 'renamed', 'added', 'untracked']) {
  test(`discard handles a ${action} file while preserving other edits`, async t => {
    const { git, api, local, selected, unchecked } = fixture(t);
    writeFileSync(join(local, unchecked), 'keep other edit\n');
    let file;
    if (action === 'deleted') {
      rmSync(join(local, selected));
      file = { path: selected, status: 'D' };
    } else if (action === 'renamed') {
      const renamed = 'notes/renamed [草稿].md';
      git(local, 'mv', '--', selected, renamed);
      file = { path: renamed, oldPath: selected, status: 'R' };
    } else {
      const path = 'notes/new [草稿].md';
      writeFileSync(join(local, path), 'new content\n');
      if (action === 'added') git(local, '--literal-pathspecs', 'add', '--', path);
      file = { path, status: 'A' };
    }
    await api.discardWorkingChanges(join(local, 'notes'), [file]);
    assert.equal(readFileSync(join(local, selected), 'utf8'), 'base\n');
    if (action !== 'deleted') assert.equal(existsSync(join(local, file.path)), false);
    assert.equal(readFileSync(join(local, unchecked), 'utf8'), 'keep other edit\n');
    assert.equal(git(local, 'diff', '--cached', '--name-only'), '');
  });
}

test('discard before the first commit removes only the selected new file', async t => {
  const { git, api, local } = fixture(t);
  const unborn = join(local, 'unborn');
  git(local, 'init', '--initial-branch=main', unborn);
  mkdirSync(join(unborn, 'notes'));
  const path = 'notes/new [草稿].md';
  writeFileSync(join(unborn, path), 'discard new file\n');
  writeFileSync(join(unborn, 'keep.md'), 'keep new file\n');
  git(unborn, '--literal-pathspecs', 'add', '-N', '--', path);
  await api.discardWorkingChanges(join(unborn, 'notes'), [{ path, status: 'A' }]);
  assert.equal(existsSync(join(unborn, path)), false);
  assert.equal(readFileSync(join(unborn, 'keep.md'), 'utf8'), 'keep new file\n');
  assert.equal(git(unborn, 'ls-files', '-z'), '');
});
