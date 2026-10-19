import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';
import ts from 'typescript';
import { i18nDependency } from './i18nHarness.mjs';

async function mountDialog() {
  const slots = [], effects = [], listeners = new Map();
  let slot = 0, effectSlot = 0;
  const pending = [];
  const discards = [];
  const candidates = {
    changes: [{ path: 'other.md', status: 'M' }, { path: 'changed.md', status: 'M' }],
    untracked: ['new.md'],
  };
  const state = {
    manualSyncOpen: true, workspacePath: '/repo', gitInfo: null, syncState: 'idle', confirm: null,
    setManualSyncOpen: value => { state.manualSyncOpen = value; },
    flushActiveTab: async () => {},
    openConfirm: request => { state.confirm = request; },
    closeConfirm: () => { state.confirm = null; },
    discardHistoryChanges: async files => {
      discards.push(...files);
      const paths = new Set(files.map(file => file.path));
      candidates.changes = candidates.changes.filter(file => !paths.has(file.path));
      candidates.untracked = candidates.untracked.filter(path => !paths.has(path));
    },
  };
  const store = Object.assign(select => select(state), { getState: () => state });
  const jsx = (type, props) => ({ type, props });
  const exports = {};
  const dependencies = {
    'react/jsx-runtime': { jsx, jsxs: jsx, Fragment: 'Fragment' },
    react: {
      useState(initial) {
        const index = slot++;
        if (!(index in slots)) slots[index] = typeof initial === 'function' ? initial() : initial;
        return [slots[index], value => { slots[index] = typeof value === 'function' ? value(slots[index]) : value; }];
      },
      useMemo: compute => compute(), useRef: () => ({ current: null }),
      useEffect(callback, deps) {
        const index = effectSlot++, previous = effects[index];
        if (!previous || deps.some((dep, i) => dep !== previous.deps[i])) {
          pending.push(() => { previous?.cleanup?.(); effects[index] = { deps, cleanup: callback() }; });
        }
      },
    },
    'react-dom': { createPortal: content => content },
    'lucide-react': {},
    '../store/useAppStore': { useAppStore: store },
    '../i18n/react': { useLanguage() {} },
    '../lib/git': {
      syncCommitMessage: () => 'sync: timestamp',
      listCommitCandidates: async () => candidates,
    },
    './WorkingChangePreview': { WorkingChangePreview: 'Preview' },
  };
  vm.runInNewContext(ts.transpileModule(readFileSync(new URL('../src/components/ManualSyncDialog.tsx', import.meta.url), 'utf8'), {
    fileName: 'ManualSyncDialog.tsx', compilerOptions: {
      module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX,
    },
  }).outputText, {
    exports, document: { body: {} },
    window: {
      innerWidth: 800, innerHeight: 600,
      addEventListener: (name, callback) => listeners.set(name, callback),
      removeEventListener: (name, callback) => { if (listeners.get(name) === callback) listeners.delete(name); },
    },
    require(name) {
      if (name.endsWith('/i18n/core.ts')) return i18nDependency('core');
      assert.ok(name in dependencies, name);
      return dependencies[name];
    },
  });
  function render() {
    slot = effectSlot = 0;
    const tree = exports.ManualSyncDialog();
    while (pending.length) pending.shift()();
    const nodes = [];
    function visit(node) {
      if (!node || typeof node !== 'object') return;
      nodes.push(node);
      for (const child of [node.props?.children].flat(Infinity)) visit(child);
    }
    visit(tree);
    return {
      preview: nodes.find(node => node.type === 'Preview'),
      fileCheckbox: nodes.find(node => node.type === 'label' && node.props.title === 'changed.md')
        ?.props.children.find(child => child?.type === 'input'),
      message: nodes.find(node => node.type === 'textarea'),
      filename: path => nodes.find(node => node.type === 'button' && node.props.children === path),
      row: path => nodes.find(node => node.props?.title === path && node.props.onContextMenu),
      menuItem: nodes.find(node => node.props?.role === 'menuitem'),
    };
  }
  render();
  await new Promise(setImmediate);
  return { render, state, listeners, discards };
}

test('double-click preview preserves selections and message, and Escape closes only the preview', async () => {
  const { render, state, listeners } = await mountDialog();
  let ui = render();
  ui.fileCheckbox.props.onChange();
  ui.message.props.onChange({ target: { value: 'My commit message' } });
  ui = render();
  ui.filename('changed.md').props.onClick({ detail: 1 });
  assert.equal(render().preview, undefined);
  ui.filename('changed.md').props.onDoubleClick();
  ui = render();
  assert.equal(ui.preview.props.file.path, 'changed.md');
  assert.equal(ui.fileCheckbox.props.checked, false);
  assert.equal(ui.message.props.value, 'My commit message');
  listeners.get('keydown')({ key: 'Escape' });
  ui = render();
  assert.equal(ui.preview, undefined);
  assert.equal(state.manualSyncOpen, true);
  assert.equal(ui.fileCheckbox.props.checked, false);
  assert.equal(ui.message.props.value, 'My commit message');
  ui.filename('new.md').props.onDoubleClick();
  ui = render();
  assert.equal(ui.preview.props.file.path, 'new.md');
  assert.equal(ui.preview.props.file.status, 'A');
  ui.preview.props.onClose();
  assert.equal(render().message.props.value, 'My commit message');
});

test('discard requires confirmation, preserves the form, and warns before deleting new files', async () => {
  const { render, state, listeners, discards } = await mountDialog();
  const event = { preventDefault() {}, stopPropagation() {}, clientX: 790, clientY: 590 };
  let ui = render();
  ui.fileCheckbox.props.onChange();
  ui.message.props.onChange({ target: { value: 'Keep my message' } });
  ui.row('other.md').props.onContextMenu(event);
  assert.equal(discards.length, 0);
  render().menuItem.props.onClick();
  assert.equal(discards.length, 0);
  assert.match(state.confirm.message, /other.md/);
  assert.match(state.confirm.message, /HEAD/);
  render();
  // ConfirmModal can clear the store before ManualSyncDialog's Escape listener runs.
  state.closeConfirm();
  listeners.get('keydown')({ key: 'Escape' });
  assert.equal(state.manualSyncOpen, true);
  assert.equal(discards.length, 0);
  ui = render();
  assert.equal(ui.fileCheckbox.props.checked, false);
  ui.row('other.md').props.onContextMenu(event);
  render().menuItem.props.onClick();
  await state.confirm.onConfirm();
  state.closeConfirm();
  ui = render();
  assert.equal(discards.length, 1);
  assert.equal(discards[0].path, 'other.md');
  assert.equal(ui.filename('other.md'), undefined);
  assert.equal(ui.fileCheckbox.props.checked, false);
  assert.equal(ui.message.props.value, 'Keep my message');
  ui.row('new.md').props.onContextMenu(event);
  render().menuItem.props.onClick();
  assert.match(state.confirm.message, /删除这个文件/);
  assert.equal(discards.length, 1);
  await state.confirm.onConfirm();
  state.closeConfirm();
  ui = render();
  assert.equal(discards[1].path, 'new.md');
  assert.equal(ui.filename('new.md'), undefined);
  assert.equal(ui.message.props.value, 'Keep my message');
});

test('failed discard keeps the confirmation retryable and preserves the form', async () => {
  const { render, state } = await mountDialog();
  const ui = render();
  ui.message.props.onChange({ target: { value: 'Retry message' } });
  ui.row('changed.md').props.onContextMenu({ preventDefault() {}, stopPropagation() {}, clientX: 10, clientY: 10 });
  render().menuItem.props.onClick();
  state.discardHistoryChanges = async () => { throw new Error('permission denied'); };
  await assert.rejects(state.confirm.onConfirm(), /permission denied/);
  assert.ok(state.confirm);
  assert.ok(render().filename('changed.md'));
  assert.equal(render().message.props.value, 'Retry message');
});
