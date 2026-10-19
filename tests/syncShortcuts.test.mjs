import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';
import ts from 'typescript';
import { i18nDependency } from './i18nHarness.mjs';

function load(platform) {
  function module(path, dependencies) {
    const exports = {};
    vm.runInNewContext(ts.transpileModule(readFileSync(new URL(`../${path}`, import.meta.url), 'utf8'), {
      compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
    }).outputText, {
      exports, navigator: { platform },
      require(name) {
        if (name.includes('/i18n/')) return i18nDependency('core');
        assert.ok(name in dependencies, name);
        return dependencies[name];
      },
    });
    return exports;
  }
  const keys = module('src/lib/codemirror/keybindings.ts', {
    '@codemirror/view': { keymap: { of: value => value } },
    '@codemirror/commands': { defaultKeymap: [], historyKeymap: [] },
    '@codemirror/search': { searchKeymap: [] },
    './markdownActions': { MARKDOWN_ACTIONS: {} }, './searchPanel': {},
  });
  const handler = module('src/lib/syncShortcuts.ts', {
    './codemirror/keybindings': keys,
    './fs': { isImageFile: path => /\.(png|jpe?g|gif|svg)$/i.test(path) },
  }).handleSyncShortcut;
  return { keys, handler };
}

function fixture(overrides = {}) {
  const calls = [];
  const state = {
    workspacePath: '/repo', gitInfo: { isRepo: true }, editorKeybindings: {},
    presentationActive: false, loadingWorkspace: null, prompt: null, confirm: null,
    gitCredentialPrompt: null, history: null, manualSyncOpen: false, branchManagerOpen: false,
    syncState: 'idle', branchTaskBusy: false, vaultRotationBusy: false, activeFilePath: null,
    syncNow: async () => { calls.push('syncNow'); },
    setManualSyncOpen: open => { assert.equal(open, true); calls.push('manualSync'); },
    openHistory: () => calls.push('openHistory'),
    setBranchManagerOpen: open => { assert.equal(open, true); calls.push('branchManager'); },
    ...overrides,
  };
  return { calls, state };
}
function event(platform, letter, shiftKey = false, overrides = {}) {
  return {
    key: shiftKey ? letter.toUpperCase() : letter, code: `Key${letter.toUpperCase()}`,
    metaKey: platform === 'MacIntel', ctrlKey: platform !== 'MacIntel', altKey: true, shiftKey,
    target: null, defaultPrevented: false, isComposing: false, repeat: false, stopped: false,
    preventDefault() { this.defaultPrevented = true; },
    stopPropagation() { this.stopped = true; },
    ...overrides,
  };
}

for (const platform of ['MacIntel', 'Win32', 'Linux x86_64']) {
  test(`all four defaults work and avoid registered conflicts on ${platform}`, () => {
    const { keys, handler } = load(platform);
    const used = new Set();
    for (const command of [...keys.APP_COMMANDS, ...keys.EDITOR_COMMANDS]) {
      const normalized = keys.canonicalKey(keys.effectiveKey(command, {}));
      assert.ok(!used.has(normalized), `${command.id}: ${normalized}`);
      used.add(normalized);
    }
    for (const [id, letter, shift] of [['syncNow', 's', false], ['manualSync', 's', true], ['openHistory', 'y', false], ['branchManager', 'b', false]]) {
      const { state, calls } = fixture();
      const key = event(platform, letter, shift);
      // Option can change the typed character; the physical key still matches.
      if (platform === 'MacIntel') key.key = 'ß';
      assert.equal(handler(key, state), true);
      assert.deepEqual(calls, [id]);
      assert.equal(key.defaultPrevented, true);
      assert.equal(key.stopped, true);
      assert.ok(keys.commandKeyLabel(id, {}));
    }
  });
}

test('rebinding takes effect immediately, updates menu labels, and restoring defaults restores the old key', () => {
  const { keys, handler } = load('MacIntel');
  const { state, calls } = fixture({ editorKeybindings: { manualSync: 'Mod-Shift-j' } });
  assert.equal(handler(event('MacIntel', 's', true), state), false);
  assert.equal(handler(event('MacIntel', 'j', true, { altKey: false }), state), true);
  assert.equal(keys.commandKeyLabel('manualSync', state.editorKeybindings), '⌘⇧J');
  delete state.editorKeybindings.manualSync;
  assert.equal(handler(event('MacIntel', 's', true), state), true);
  assert.equal(handler(event('MacIntel', 'j', true, { altKey: false }), state), false);
  assert.deepEqual(calls, ['manualSync', 'manualSync']);
});

test('modals, missing repositories, workspace changes, composition and repeated keys do not trigger actions', () => {
  const { handler } = load('Win32');
  for (const overrides of [
    { workspacePath: null }, { gitInfo: null }, { gitInfo: { isRepo: false } },
    { presentationActive: true }, { loadingWorkspace: '/next' }, { prompt: {} }, { confirm: {} },
    { gitCredentialPrompt: {} }, { history: {} }, { manualSyncOpen: true },
    { branchManagerOpen: true }, { vaultRotationBusy: true }, { syncState: 'syncing' }, { branchTaskBusy: true },
  ]) {
    const { state, calls } = fixture(overrides);
    const key = event('Win32', 's');
    assert.equal(handler(key, state), false);
    assert.equal(key.defaultPrevented, false);
    assert.equal(calls.length, 0);
  }
  for (const flags of [{ defaultPrevented: true }, { isComposing: true }, { repeat: true }]) {
    const { state, calls } = fixture();
    assert.equal(handler(event('Win32', 's', false, flags), state), false);
    assert.equal(calls.length, 0);
  }
});

test('text fields and terminals keep their keys while the main editor can run configured commands', () => {
  const { handler } = load('Win32');
  for (const target of [
    { closest: selector => selector.includes('input') ? {} : null },
    { closest: selector => selector.includes('.xterm') ? {} : null },
    { closest: selector => selector.includes('[role=dialog]') ? {} : null },
    { closest: selector => selector === '[contenteditable=true]' ? { closest: () => null } : null },
  ]) {
    const { state, calls } = fixture();
    assert.equal(handler(event('Win32', 's', false, { target }), state), false);
    assert.equal(calls.length, 0);
  }
  const { state, calls } = fixture();
  const editor = { closest: selector => selector === '[contenteditable=true]' ? { closest: () => ({}) } : null };
  assert.equal(handler(event('Win32', 's', false, { target: editor }), state), true);
  assert.deepEqual(calls, ['syncNow']);
});

test('history shortcuts follow the menu availability for text and image files', () => {
  const { handler } = load('Win32');
  const { state, calls } = fixture({ activeFilePath: '/repo/image.png' });
  assert.equal(handler(event('Win32', 'y'), state), false);
  state.activeFilePath = '/repo/note.md';
  assert.equal(handler(event('Win32', 'y'), state), true);
  assert.deepEqual(calls, ['openHistory']);
});
