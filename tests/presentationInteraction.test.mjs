import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';
import ts from 'typescript';
import { Compartment, EditorState } from '@codemirror/state';
import { canInteract, presentationInteraction } from '../src/lib/codemirror/interaction.ts';
import * as fenceAttrs from '../src/lib/codeRun/fenceAttrs.ts';

const compiled = ts.transpileModule(
  readFileSync(new URL('../src/lib/codemirror/autoRuns.ts', import.meta.url), 'utf8'),
  { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } },
).outputText;

function harness(presenting = true) {
  const interaction = new Compartment();
  const view = { state: EditorState.create({
    doc: '```python {in=params, run=watch|open}\nprint(1)\n```',
    extensions: [EditorState.readOnly.of(true), interaction.of(presentationInteraction.of(presenting))],
  }) };
  const calls = [];
  const timers = new Map();
  let nextTimer = 0;
  let onInput;
  const dependencies = {
    '@codemirror/view': { ViewPlugin: { fromClass: (plugin) => plugin } },
    '../../store/useInputStore': { useInputStore: { subscribe(callback) {
      onInput = callback;
      return () => { onInput = null; };
    } } },
    '../../store/useAppStore': { useAppStore: { getState: () => ({
      activeFilePath: '/note.md', docKey: 1, codeRunConfig: { enabled: true },
    }) } },
    '../../store/useRunStore': { runKey: (path, code) => path + code },
    '../codeRun/runBlock': { runBlock: (...args) => { calls.push(args); } },
    '../codeRun/runners': { resolveRunner: () => ({}) },
    '../codeRun/fenceAttrs': fenceAttrs,
    './livePreview': { codeRunnersChanged: {} },
    './interaction': { canInteract },
  };
  const exports = {};
  vm.runInNewContext(compiled, {
    exports,
    require: (name) => {
      assert.ok(name in dependencies, `unexpected dependency: ${name}`);
      return dependencies[name];
    },
    setTimeout: (callback) => { timers.set(++nextTimer, callback); return nextTimer; },
    clearTimeout: (id) => timers.delete(id),
  });
  const plugin = new exports.autoRuns(view);
  return {
    calls, plugin, view,
    change: (key = '/note.md params') => onInput?.({ rev: 1, lastChanged: key }, { rev: 0 }),
    flush: () => { const pending = [...timers.values()]; timers.clear(); pending.forEach((cb) => cb()); },
    exit: () => { view.state = view.state.update({ effects: interaction.reconfigure([]) }).state; },
  };
}

test('presentation keeps source read-only while allowing component interactions', () => {
  const h = harness();
  assert.equal(h.view.state.readOnly, true);
  assert.equal(canInteract(h.view.state), true);
  h.exit();
  assert.equal(h.view.state.readOnly, true);
  assert.equal(canInteract(h.view.state), false);
  assert.equal(canInteract(EditorState.create()), true);
});

test('presentation input changes rerun the bound code once after debounce', () => {
  const h = harness();
  assert.equal(h.calls.length, 0, 'entering presentation must not fire run=open');
  h.change();
  h.change();
  h.change();
  assert.equal(h.calls.length, 0);
  h.flush();
  assert.equal(h.calls.length, 1);
  assert.equal(h.calls[0][2], 'print(1)');
  assert.equal(h.calls[0][3].auto, true);
});

test('ordinary read-only preview and changes from other blocks do not execute code', () => {
  const readonly = harness(false);
  readonly.change();
  readonly.flush();
  assert.equal(readonly.calls.length, 0);
  const presenting = harness();
  presenting.change('/other.md params');
  presenting.flush();
  presenting.change('/note.md unrelated');
  presenting.flush();
  assert.equal(presenting.calls.length, 0);
});

test('pending watch cannot execute after returning to read-only or destroying the view', () => {
  for (const action of ['exit', 'destroy']) {
    const h = harness();
    h.change();
    if (action === 'exit') h.exit();
    else h.plugin.destroy();
    h.flush();
    assert.equal(h.calls.length, 0);
  }
});
