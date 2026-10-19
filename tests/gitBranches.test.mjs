import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import vm from 'node:vm';
import ts from 'typescript';
import { i18nDependency } from './i18nHarness.mjs';

function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), 'idea-note-branches-'));
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
    return result.stdout.trim();
  }
  const remote = join(root, 'remote.git'), seed = join(root, 'seed'), local = join(root, 'local');
  git(root, 'init', '--bare', '--initial-branch=main', remote);
  git(root, 'init', '--initial-branch=main', seed);
  git(seed, 'config', 'user.name', 'Branch Test');
  git(seed, 'config', 'user.email', 'branch@example.test');
  mkdirSync(join(seed, 'notes'));
  writeFileSync(join(seed, 'notes', 'note.md'), 'base\n');
  git(seed, 'add', '.');
  git(seed, 'commit', '-m', '基础笔记');
  git(seed, 'remote', 'add', 'origin', remote);
  git(seed, 'push', '-u', 'origin', 'main');
  git(seed, 'branch', 'feature/reading');
  git(seed, 'push', 'origin', 'feature/reading');
  git(root, 'clone', remote, local);
  git(local, 'config', 'user.name', 'Branch Test');
  git(local, 'config', 'user.email', 'branch@example.test');
  function load(path, dependencies) {
    const exports = {};
    vm.runInNewContext(ts.transpileModule(readFileSync(new URL(`../${path}`, import.meta.url), 'utf8'), {
      compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
    }).outputText, { exports, require(name) {
      if (name.includes('/i18n/')) return i18nDependency('core');
      assert.ok(name in dependencies, name);
      return dependencies[name];
    } });
    return exports;
  }
  const core = load('src/lib/git.ts', { '@tauri-apps/api/core': { invoke: async (command, { dir, args }) => {
    assert.equal(command, 'git_run');
    return run(dir, args);
  } } });
  return { root, local, git, api: load('src/lib/gitBranches.ts', { './git': core }) };
}

test('lists local and remote branches, tracking and subjects without origin/HEAD aliases', async t => {
  const { local, api } = fixture(t);
  const result = await api.listBranches(join(local, 'notes'));
  assert.equal(result.current, 'main');
  assert.equal(result.dirty, false);
  const main = result.branches.find(branch => branch.name === 'main');
  assert.equal(main.current, true);
  assert.equal(main.subject, '基础笔记');
  assert.equal(main.upstream, 'refs/remotes/origin/main');
  assert.ok(result.branches.some(branch => branch.name === 'origin/feature/reading' && branch.remote));
  assert.ok(!result.branches.some(branch => branch.name === 'origin/HEAD'));
});

test('creates, switches, renames, and deletes merged local branches without changing existing commits', async t => {
  const { local, api, git } = fixture(t);
  const head = git(local, 'rev-parse', 'HEAD');
  await api.createBranch(local, 'feature/笔记', 'HEAD', false);
  assert.equal(git(local, 'branch', '--show-current'), 'main');
  await api.switchBranch(local, 'refs/heads/feature/笔记');
  await api.renameBranch(local, 'feature/笔记', 'feature/renamed');
  assert.equal(git(local, 'branch', '--show-current'), 'feature/renamed');
  await assert.rejects(api.deleteBranch(local, 'feature/renamed'), /不能删除当前分支/);
  await api.switchBranch(local, 'refs/heads/main');
  await api.deleteBranch(local, 'feature/renamed');
  assert.ok(!(await api.listBranches(local)).branches.some(branch => branch.name === 'feature/renamed'));
  assert.equal(git(local, 'rev-parse', 'HEAD'), head);
});

test('checking out a remote branch creates a tracking branch and reuses it on later switches', async t => {
  const { local, api, git } = fixture(t);
  await api.switchBranch(local, 'refs/remotes/origin/feature/reading');
  assert.equal(git(local, 'branch', '--show-current'), 'feature/reading');
  assert.equal(git(local, 'rev-parse', '--abbrev-ref', '@{upstream}'), 'origin/feature/reading');
  await api.switchBranch(local, 'refs/heads/main');
  await api.switchBranch(local, 'refs/remotes/origin/feature/reading');
  assert.equal(git(local, 'branch', '--show-current'), 'feature/reading');
  await api.createBranch(local, 'other-name', 'refs/remotes/origin/main', true);
  assert.equal(git(local, 'rev-parse', '--abbrev-ref', '@{upstream}'), 'origin/main');
});

test('switching or creating-and-switching refuses uncommitted and untracked edits without losing them', async t => {
  const { local, api, git } = fixture(t);
  writeFileSync(join(local, 'notes', 'note.md'), 'private edit\n');
  writeFileSync(join(local, 'new.md'), 'private new file\n');
  const before = git(local, 'status', '--porcelain');
  await assert.rejects(api.switchBranch(local, 'refs/remotes/origin/feature/reading'), /未提交的更改/);
  await assert.rejects(api.createBranch(local, 'must-not-exist'), /未提交的更改/);
  assert.equal(git(local, 'branch', '--show-current'), 'main');
  assert.equal(git(local, 'status', '--porcelain'), before);
  assert.equal(readFileSync(join(local, 'notes', 'note.md'), 'utf8'), 'private edit\n');
  assert.equal(readFileSync(join(local, 'new.md'), 'utf8'), 'private new file\n');
  assert.ok(!(await api.listBranches(local)).branches.some(branch => branch.name === 'must-not-exist'));
  await api.createBranch(local, 'metadata-only', 'HEAD', false);
  assert.equal(git(local, 'branch', '--show-current'), 'main');
});

test('invalid names, duplicate names, missing refs and remote/local name collisions are rejected', async t => {
  const { local, api, git } = fixture(t);
  for (const name of ['--force', 'HEAD', '@{-1}', 'bad name', 'a..b', 'a.lock']) {
    await assert.rejects(api.createBranch(local, name, 'HEAD', false));
  }
  await assert.rejects(api.createBranch(local, 'main', 'HEAD', false));
  await assert.rejects(api.switchBranch(local, 'refs/heads/missing'), /不存在/);
  await api.createBranch(local, 'feature/reading', 'HEAD', false);
  await assert.rejects(api.switchBranch(local, 'refs/remotes/origin/feature/reading'), /同名本地分支/);
  await assert.rejects(api.renameBranch(local, 'feature/reading', 'main'));
  assert.equal(git(local, 'branch', '--show-current'), 'main');
});

test('unmerged branches and branches in another worktree cannot be deleted', async t => {
  const { root, local, api, git } = fixture(t);
  await api.createBranch(local, 'unmerged');
  writeFileSync(join(local, 'only-on-branch.md'), 'keep this commit\n');
  git(local, 'add', '.');
  git(local, 'commit', '-m', 'unmerged work');
  await api.switchBranch(local, 'refs/heads/main');
  await assert.rejects(api.deleteBranch(local, 'unmerged'), /尚未合并/);
  assert.ok((await api.listBranches(local)).branches.some(branch => branch.name === 'unmerged'));
  git(local, 'worktree', 'add', '-b', 'in-use', join(root, 'other-worktree'));
  await assert.rejects(api.deleteBranch(local, 'in-use'));
  assert.ok((await api.listBranches(local)).branches.find(branch => branch.name === 'in-use').worktree);
});

test('unborn repositories report their branch and reject creating without a commit', async t => {
  const { root, local, api, git } = fixture(t);
  const unborn = join(root, 'unborn');
  git(local, 'init', '--initial-branch=main', unborn);
  assert.equal((await api.listBranches(unborn)).current, 'main');
  await assert.rejects(api.createBranch(unborn, 'another'), /先完成一次提交/);
});
