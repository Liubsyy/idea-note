import { EditorState } from '@codemirror/state';
import { EditorView } from '@codemirror/view';
import { markdown } from '@codemirror/lang-markdown';
import { foldedRanges } from '@codemirror/language';
import { mockIPC, mockWindows } from '@tauri-apps/api/mocks';
import '../src/styles/globals.css';
import '../src/lib/codemirror/editor.css';
import { cmTheme, cmHighlighting } from '../src/lib/codemirror/theme';

const runRequests: Record<string, unknown>[] = [];
mockIPC((command, args) => {
  if (command === 'git_proxy_load') return '';
  if (command === 'sync_config_load') return '{}';
  if (command === 'code_run_start') {
    runRequests.push(args as Record<string, unknown>);
    // Verify the real execution pipeline without starting a native process.
    throw new Error('Test backend: execution intercepted');
  }
  return null;
}, { shouldMockEvents: true });
mockWindows('main');
await import('../src/lib/share/renderRuntime');
const { livePreview, defaultComponentFoldEffects } = await import('../src/lib/codemirror/livePreview');
const { applyLanguage } = await import('../src/i18n/core');
const { useAppStore } = await import('../src/store/useAppStore');
let copied = '';
Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText: async (text: string) => { copied = text; } } });
applyLanguage('zh-CN');
const host = document.getElementById('test-editor')!;
const report = document.getElementById('test-result')!;
const passed: string[] = [];
function check(ok: unknown, message: string) {
  if (!ok) throw new Error(message);
  passed.push(message);
}
const tick = () => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
function button(label: string) {
  const button = host.querySelector<HTMLButtonElement>(`button[aria-label="${label}"]`);
  if (!button) throw new Error(`Missing button: ${label}`);
  button.click();
}
const source = '# 示例\n\n```javascript\nconst a = 1;\nconsole.log(a);\n```\n\n~~~text\nsecond\nblock\n~~~\n\n    indented\n    code\n';
const view = new EditorView({ parent: host, state: EditorState.create({
  doc: source, extensions: [markdown(), cmTheme, cmHighlighting, livePreview],
}) });
try {
  await tick();
  check(host.querySelectorAll('.cm-md-code-fold-btn').length === 3, 'all ordinary code blocks offer folding');
  const firstFold = host.querySelector('.cm-md-code-fold-btn')!.getBoundingClientRect();
  const firstLine = host.querySelector('.cm-code-first')!.getBoundingClientRect();
  check(firstFold.left - firstLine.left < 15, 'fold control is on the left');
  const firstHeader = host.querySelector('.cm-md-code-header')!;
  const originalActions = [...firstHeader.querySelectorAll<HTMLButtonElement>('.cm-md-code-actions button')];
  check(originalActions[0].getAttribute('aria-label') === '运行代码块' &&
    originalActions[1].getAttribute('aria-label')?.includes('代码运行面板') &&
    originalActions[2].getAttribute('aria-label') === '复制代码', 'code actions retain run, panel, copy order');
  check(originalActions.every(action => action.textContent === '' && getComputedStyle(action).borderTopWidth === '1px' && action.getBoundingClientRect().width === 26),
    'code actions retain their original bordered icon button style');
  check(firstHeader.querySelector('.cm-md-code-language')?.textContent === 'JavaScript', 'expanded header shows language');
  check(firstHeader.querySelector('.cm-md-code-count')?.textContent === '2 行', 'expanded header shows line count');
  const expandedHeight = firstLine.height;
  check(expandedHeight > firstHeader.getBoundingClientRect().height, 'header has separate space above code');
  button('折叠代码块'); await tick();
  check(foldedRanges(view.state).size === 1, 'collapse hides a code range');
  check(host.querySelectorAll('.cm-md-code-fold-btn').length === 3, 'folded block keeps exactly one toolbar');
  check(host.querySelector('.cm-md-code-meta')?.textContent === 'JavaScript2 行', 'collapsed header retains language and line count');
  check(host.querySelector('.cm-code-collapsed')!.getBoundingClientRect().height <= 43, 'collapsed block only occupies header height');
  check(view.state.doc.toString() === source, 'fold leaves Markdown unchanged');
  check(!!host.querySelector('button[aria-label="复制代码"]'), 'copy remains available');
  button('复制代码'); await tick();
  check(copied === 'const a = 1;\nconsole.log(a);', 'collapsed copy includes the full body');
  const panelWasOpen = useAppStore.getState().runPanelOpen;
  button(panelWasOpen ? '隐藏代码运行面板' : '打开代码运行面板'); await tick();
  check(useAppStore.getState().runPanelOpen !== panelWasOpen, 'collapsed output action remains functional');
  button('展开代码块'); await tick();
  check(foldedRanges(view.state).size === 0, 'toolbar expands block');
  button('折叠代码块'); await tick();
  host.querySelector<HTMLButtonElement>('.cm-md-code-meta')!.click(); await tick();
  check(foldedRanges(view.state).size === 0, 'summary expands block');
  button('折叠代码块'); await tick();
  view.dispatch({ changes: { from: 0, insert: 'prefix\n' } }); await tick();
  check(foldedRanges(view.state).size === 1, 'fold tracks edits before block');
  button('展开代码块'); await tick();
  check(foldedRanges(view.state).size === 0, 'expand uses updated positions');
  button('折叠代码块'); await tick();
  view.dispatch({ selection: { anchor: view.state.doc.toString().indexOf('console.log') + 1 } }); await tick();
  check(foldedRanges(view.state).size === 0, 'navigating into hidden code reveals it');
  view.focus();
  button('折叠代码块'); await tick();
  check(![...host.querySelectorAll('.cm-line')].some(line => line.textContent?.includes('```') && getComputedStyle(line).display !== 'none'), 'folding focused code also hides fences');
  view.setState(EditorState.create({ doc: source, extensions: [markdown(), cmTheme, cmHighlighting, livePreview, EditorState.readOnly.of(true), EditorView.editable.of(false)] }));
  await tick(); button('折叠代码块'); await tick();
  check(foldedRanges(view.state).size === 1, 'read-only preview can fold');
  check(view.state.doc.toString() === source, 'read-only folding preserves source');
  check(!host.querySelector('button[aria-label="运行代码块"]'), 'read-only preview hides run action');
  applyLanguage('en'); await tick();
  check(host.querySelector('.cm-md-code-count')?.textContent === '2 lines', 'folded metadata follows language changes');
  applyLanguage('zh-CN');
  view.setState(EditorState.create({ doc: source, extensions: [markdown(), cmTheme, cmHighlighting, livePreview] }));
  host.style.width = '400px'; await tick();
  const narrowHeader = host.querySelector('.cm-md-code-header')!;
  const metaRect = narrowHeader.querySelector('.cm-md-code-meta')!.getBoundingClientRect();
  const actionRect = narrowHeader.querySelector('.cm-md-code-actions')!.getBoundingClientRect();
  check(metaRect.right <= actionRect.left, 'metadata and actions do not overlap in a narrow editor');
  host.style.width = '';

  // Exercise actual React editor remounts, as used by note-tab switching.
  view.destroy();
  const { createElement } = await import('react');
  const { createRoot } = await import('react-dom/client');
  const { CodeMirrorEditor } = await import('../src/components/Editor/CodeMirrorEditor');
  const { getActiveView } = await import('../src/lib/codemirror/activeView');
  function Fixture() {
    const docKey = useAppStore(state => state.docKey);
    return createElement(CodeMirrorEditor, { key: docKey });
  }
  const root = createRoot(host);
  const noteA = '/fixtures/folding-session-a.md';
  const noteB = '/fixtures/folding-session-b.md';
  async function switchNote(path: string, content = source) {
    const previous = getActiveView();
    useAppStore.setState({ activeFilePath: path, content, docKey: useAppStore.getState().docKey + 1 });
    for (let i = 0; i < 100; i++) {
      await tick();
      if (getActiveView() && getActiveView() !== previous) return getActiveView()!;
    }
    throw Error('Editor did not remount');
  }
  useAppStore.setState({ activeFilePath: noteA, content: source, mdViewMode: 'live', presentationActive: false });
  root.render(createElement(Fixture));
  for (let i = 0; i < 100 && !getActiveView(); i++) await tick();
  const editorA = getActiveView()!;
  check(!!editorA, 'session fixture mounts the real note editor');
  editorA.dispatch({ selection: { anchor: source.indexOf('console.log') + 1 } });
  button('折叠代码块'); await tick();
  const editorB = await switchNote(noteB);
  check(foldedRanges(editorB.state).size === 0, 'a different note starts expanded');
  host.querySelectorAll<HTMLButtonElement>('.cm-md-code-fold-btn')[1].click(); await tick();
  const restoredA = await switchNote(noteA);
  check(foldedRanges(restoredA.state).size === 1, 'switching back restores the first note fold');
  check(host.querySelector('.cm-md-code-fold-btn')?.getAttribute('aria-expanded') === 'false', 'saved cursor inside the fold does not reopen it');
  const restoredB = await switchNote(noteB);
  check(foldedRanges(restoredB.state).size === 1, 'each note keeps an independent fold');
  check(host.querySelectorAll('.cm-md-code-fold-btn')[1].getAttribute('aria-expanded') === 'false', 'second note restores its own block');
  button('展开代码块'); await tick();
  await switchNote(noteA);
  check(foldedRanges((await switchNote(noteB)).state).size === 0, 'explicit expansion replaces the cached folded state');
  const beforeEdit = await switchNote(noteA);
  beforeEdit.dispatch({ changes: { from: 0, insert: 'prefix\n' } }); await tick();
  await switchNote(noteB);
  check(foldedRanges((await switchNote(noteA, 'prefix\n' + source)).state).size === 1, 'mapped fold positions survive switching after editing');
  useAppStore.setState({ mdViewMode: 'source' }); await tick(); await tick();
  check(!host.querySelector('.cm-md-code-header'), 'source mode shows the full Markdown');
  await switchNote(noteB);
  await switchNote(noteA, 'prefix\n' + source);
  useAppStore.setState({ mdViewMode: 'live' }); await tick(); await tick();
  check(foldedRanges(getActiveView()!.state).size === 1, 'source mode and note switching preserve preview folds');
  await switchNote(noteB);
  check(foldedRanges((await switchNote(noteA, '# externally changed\n' + source)).state).size === 0, 'externally changed content does not reuse stale fold positions');
  check(useAppStore.getState().content === '# externally changed\n' + source, 'fold restoration never modifies note content');
  const componentSource = [
    '# Component', '', '```input {id=demo}', 'amount: number = 3', '```', '',
    '```javascript {in=demo, out=text}', 'console.log(3);', '```', '',
    '```javascript', 'console.log("ordinary");', '```', '',
  ].join('\n');
  const componentPath = '/fixtures/folding-component.md';
  const componentView = await switchNote(componentPath, componentSource);
  check(foldedRanges(componentView.state).size === 1, 'component source defaults to collapsed');
  check(host.querySelectorAll('.cm-md-code-fold-btn')[0].getAttribute('aria-expanded') === 'false', 'component header remains available while collapsed');
  check(host.querySelectorAll('.cm-md-code-fold-btn')[1].getAttribute('aria-expanded') === 'true', 'ordinary runnable code stays expanded');
  check(!!host.querySelector('input[type="number"]'), 'component input controls stay visible');
  check(host.textContent?.includes('尚未运行'), 'component output placeholder stays visible');
  const inputRun = host.querySelector<HTMLButtonElement>('.cm-md-input-run')!;
  check(inputRun?.previousElementSibling?.textContent === '重置', 'input run button appears immediately after reset');
  const { useInputStore, inputKey } = await import('../src/store/useInputStore');
  const originalConfig = useAppStore.getState().codeRunConfig;
  useAppStore.setState({ codeRunConfig: { ...originalConfig, enabled: true, confirmEveryRun: false } });
  useInputStore.getState().set(inputKey(componentPath, 'demo'), 'amount', 7);
  await tick();
  host.querySelector<HTMLButtonElement>('.cm-md-input-run')!.click();
  for (let i = 0; i < 100 && runRequests.length < 1; i++) await tick();
  check(runRequests.length === 1 && (runRequests[0].env as Record<string, string>).amount === '7', 'input run uses current control values');
  host.querySelector<HTMLButtonElement>('.cm-md-code-header .cm-md-run-btn')!.click();
  for (let i = 0; i < 100 && runRequests.length < 2; i++) await tick();
  check(runRequests.length === 2 && ['code', 'env', 'cwd', 'command', 'args'].every(key => JSON.stringify(runRequests[0][key]) === JSON.stringify(runRequests[1][key])),
    'input run and code run send identical execution arguments');
  useAppStore.setState({ codeRunConfig: { ...originalConfig, confirmEveryRun: true }, confirm: null });
  await tick(); host.querySelector<HTMLButtonElement>('.cm-md-input-run')!.click(); await tick();
  check(useAppStore.getState().confirm?.title === '运行代码块' && runRequests.length === 2, 'input run honors the existing confirmation setting');
  useAppStore.getState().closeConfirm();
  useAppStore.setState({ codeRunConfig: { ...originalConfig, enabled: false } }); await tick(); await tick();
  check(!host.querySelector('.cm-md-input-run'), 'disabling runners removes the input run button');
  useAppStore.setState({ codeRunConfig: originalConfig }); await tick(); await tick();
  button('展开代码块'); await tick();
  await switchNote(noteB);
  check(foldedRanges((await switchNote(componentPath, componentSource)).state).size === 0, 'manual component expansion overrides the default on return');
  useAppStore.setState({ mdViewMode: 'source' }); await tick(); await tick();
  await switchNote('/fixtures/folding-component-source-first.md', componentSource);
  check(!host.querySelector('.cm-md-code-header'), 'component source mode remains fully visible');
  useAppStore.setState({ mdViewMode: 'readonly' }); await tick(); await tick();
  check(foldedRanges(getActiveView()!.state).size === 1, 'first read-only preview applies component defaults');
  check(!host.querySelector('.cm-md-input-run'), 'read-only mode does not offer input execution');

  useAppStore.setState({ mdViewMode: 'live', codeRunConfig: { ...originalConfig, confirmEveryRun: false } });
  const multiCode = componentSource + '\n```javascript {in=demo, out=text}\nconsole.log("second");\n```\n\n```javascript {in=other}\nconsole.log("unrelated");\n```\n';
  await switchNote('/fixtures/input-run-multiple.md', multiCode);
  const picker = host.querySelector<HTMLSelectElement>('.cm-md-input-run-target')!;
  check(picker?.options.length === 2, 'multiple targets include only code bound to this input');
  picker.value = '1';
  const previousRuns = runRequests.length;
  host.querySelector<HTMLButtonElement>('.cm-md-input-run')!.click();
  for (let i = 0; i < 100 && runRequests.length === previousRuns; i++) await tick();
  check(runRequests.length === previousRuns + 1 && runRequests.at(-1)?.code === 'console.log("second");', 'input run executes only the selected bound block');
  useAppStore.setState({ codeRunConfig: originalConfig });

  const fence = (info: string, code = 'example') => ['```' + info, code, '```', ''].join('\n');
  const classificationDoc = [
    fence('python {out=auto}'), fence('python {in=file:data.csv}'), fence('python {watch}'),
    fence('python {run=open}'), fence('python {run=manual}'), fence('python {unknown=value}'),
    fence('python {out=invalid}'), fence('mermaid {out=text}'), fence('input {id=demo, out=text}'),
    fence('secret {out=text}'), ['````markdown', fence('python {out=text}'), '````'].join('\n'),
  ].join('\n');
  const classification = EditorState.create({ doc: classificationDoc, extensions: [markdown()] });
  check(defaultComponentFoldEffects(classification).length === 4, 'only recognized component attributes fold code; controls, diagrams and quoted examples are excluded');

  const smallNote = fence('text', 'abc');
  const checksumPath = '/fixtures/fold-checksum.md';
  await switchNote(checksumPath, smallNote);
  button('折叠代码块'); await tick();
  await switchNote(noteB);
  check(foldedRanges((await switchNote(checksumPath, fence('text', 'abd'))).state).size === 0,
    'same-length external edits invalidate saved fold positions');
  const oldestPath = '/fixtures/fold-cache-oldest.md';
  const recentPath = '/fixtures/fold-cache-recent.md';
  await switchNote(oldestPath, smallNote);
  button('折叠代码块'); await tick();
  await switchNote(recentPath, smallNote);
  button('折叠代码块'); await tick();
  for (let i = 0; i < 99; i++) {
    const editor = await switchNote(`/fixtures/fold-cache-${i}.md`, smallNote);
    editor.dispatch({ selection: { anchor: 0 } });
  }
  check(foldedRanges((await switchNote(recentPath, smallNote)).state).size === 1,
    'recent fold state survives at the 100-note cache limit');
  check(foldedRanges((await switchNote(oldestPath, smallNote)).state).size === 0,
    'least recently used state is evicted beyond 100 notes');

  // Wrapped code must never wrap its line-number pseudo-element, even past 999.
  const longCode = Array.from({ length: 1005 }, (_, i) => `value_${i + 1} = "${'long text '.repeat(8)}"`).join('\n');
  host.style.width = '400px';
  const longView = await switchNote('/fixtures/code-line-numbers.md', fence('python', longCode));
  longView.scrollDOM.style.height = '400px';
  longView.requestMeasure();
  for (const number of [99, 100, 999, 1000]) {
    const line = longView.state.doc.line(number + 1);
    longView.dispatch({ effects: EditorView.scrollIntoView(line.from, { y: 'center' }) });
    let row: HTMLElement | null = null;
    for (let attempt = 0; attempt < 100; attempt++) {
      await tick();
      row = host.querySelector<HTMLElement>(`.cm-code-line[data-ln="${number}"]`);
      if (row) break;
    }
    check(!!row, `line ${number} renders in a long code block`);
    const numberStyle = getComputedStyle(row!, '::before');
    const rowStyle = getComputedStyle(row!);
    const measure = document.createElement('canvas').getContext('2d')!;
    measure.font = `${numberStyle.fontSize} ${numberStyle.fontFamily}`;
    check(['nowrap', 'pre'].includes(numberStyle.whiteSpace) && parseFloat(numberStyle.width) >= measure.measureText(String(number)).width - 0.5,
      `line ${number} fits without wrapping`);
    const gutterEnd = parseFloat(numberStyle.width) + parseFloat(numberStyle.paddingLeft) + parseFloat(numberStyle.paddingRight);
    check(parseFloat(rowStyle.paddingLeft) > gutterEnd, `line ${number} stays clear of code text`);
  }
  check(host.querySelector('.cm-code-line')?.style.getPropertyValue('--cm-code-line-digits') === '4', 'all lines reserve a consistent four-digit gutter');
  host.style.width = '';
  report.textContent = `PASS: ${passed.length} checks\n${passed.join('\n')}`;
} catch (error) {
  report.textContent = `FAIL: ${String(error)}\n${passed.join('\n')}`;
  throw error;
}
