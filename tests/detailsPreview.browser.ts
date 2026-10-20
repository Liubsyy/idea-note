import { EditorState, Compartment } from '@codemirror/state';
import { EditorView } from '@codemirror/view';
import { markdown } from '@codemirror/lang-markdown';
import { mockIPC, mockWindows } from '@tauri-apps/api/mocks';
import '../src/styles/globals.css';
import '../src/lib/codemirror/editor.css';
import { cmTheme } from '../src/lib/codemirror/theme';
import { detailsBlock } from '../src/lib/codemirror/detailsBlock';
import readme from '../README.md?raw';

mockIPC((command) => {
  if (command === 'git_proxy_load') return '';
  if (command === 'sync_config_load') return '{}';
  return null;
}, { shouldMockEvents: true });
mockWindows('main');
const { htmlPreview } = await import('../src/lib/codemirror/htmlPreview');
const { applyLanguage } = await import('../src/i18n/core');
applyLanguage('zh-CN');
const host = document.getElementById('test-editor')!;
const report = document.getElementById('test-result')!;
const passed: string[] = [];
function check(ok: unknown, message: string) {
  if (!ok) throw new Error(message);
  passed.push(message);
}
const tick = () => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
const closed = '<details>\n<summary>Closed block</summary>\nHidden content\n</details>';
const opened = '<details open>\n<summary>Open block</summary>\nVisible content\n</details>';
const source = `${closed}\n\n${opened}\n\n<div>Other HTML</div>\n\nOutside\n`;
const readOnly = new Compartment();
const view = new EditorView({ parent: host, state: EditorState.create({
  doc: source, extensions: [markdown({ extensions: [detailsBlock] }), cmTheme, htmlPreview, readOnly.of(EditorState.readOnly.of(false))],
}) });
const firstDetails = () => host.querySelector<HTMLDetailsElement>('details')!;
function reveal() {
  host.querySelector<HTMLButtonElement>('.cm-md-details-source')!.click();
}
function toggle() {
  const summary = firstDetails().querySelector('summary')!;
  const press = new MouseEvent('mousedown', { bubbles: true, cancelable: true, button: 0 });
  summary.dispatchEvent(press);
  check(!press.defaultPrevented, 'summary press keeps native default behavior');
  summary.click();
}
try {
  await tick();
  check(host.querySelectorAll('details').length === 2, 'details render even with the initial caret inside');
  check(!firstDetails().open, 'details without open starts collapsed');
  check(host.querySelectorAll('details')[1].open, 'details with open starts expanded');
  check(host.querySelectorAll('.cm-md-details-source').length === 2, 'each block offers one source button');
  const sourceButton = host.querySelector<HTMLButtonElement>('.cm-md-details-source')!;
  check(sourceButton.getBoundingClientRect().right <= firstDetails().getBoundingClientRect().left,
    'source button sits in the left gutter');
  toggle(); await tick();
  check(firstDetails().open, 'summary expands content without revealing source');
  const retained = firstDetails();
  view.dispatch({ selection: { anchor: source.indexOf('Hidden') } }); await tick();
  check(firstDetails() === retained && firstDetails().open, 'selection inside preserves rendered block and open state');
  view.dispatch({ changes: { from: 0, insert: 'Prefix\n\n' } }); await tick();
  check(firstDetails() === retained && firstDetails().open, 'edits before a block preserve its DOM and open state');
  toggle(); await tick();
  check(!firstDetails().open, 'summary collapses content');
  check(view.state.doc.toString() === `Prefix\n\n${source}`, 'summary toggles do not change the note');
  reveal(); await tick();
  check(host.querySelectorAll('details').length === 1, 'source button explicitly reveals only its own block');
  check(view.state.selection.main.head === view.state.doc.toString().indexOf('<details>'), 'source button uses the updated document offset');
  let position = view.state.doc.toString().indexOf('Hidden');
  view.dispatch({ changes: { from: position, to: position + 6, insert: 'Edited' }, selection: { anchor: position + 6 } });
  await tick();
  check(host.querySelectorAll('details').length === 1, 'source remains visible while editing inside');
  view.dispatch({ selection: { anchor: view.state.doc.toString().indexOf('Outside') } }); await tick();
  check(host.querySelectorAll('details').length === 2 && firstDetails().textContent?.includes('Edited content'), 'leaving source returns to the updated preview');
  check(host.querySelector('.cm-md-html:not(.cm-md-details)')?.textContent === 'Other HTML', 'other HTML still renders normally');
  view.dispatch({ selection: { anchor: view.state.doc.toString().indexOf('Other HTML') } }); await tick();
  check(!host.querySelector('.cm-md-html:not(.cm-md-details)'), 'other HTML retains its selection-to-source behavior');
  reveal(); await tick();
  view.dispatch({ effects: readOnly.reconfigure(EditorState.readOnly.of(true)) }); await tick();
  check(host.querySelectorAll('details').length === 2 && !host.querySelector('.cm-md-details-source'), 'read-only mode restores preview and hides source controls');
  toggle(); await tick();
  check(firstDetails().open, 'read-only details still expand');
  toggle(); await tick();
  check(!firstDetails().open, 'read-only details still collapse');
  view.dispatch({ effects: readOnly.reconfigure(EditorState.readOnly.of(false)) }); await tick();
  check(host.querySelectorAll('.cm-md-details-source').length === 2, 'returning to edit mode restores source controls');
  applyLanguage('en');
  check(host.querySelector('.cm-md-details-source')?.getAttribute('aria-label') === 'Show collapsible block source', 'source label updates when language changes');

  // Reproduce the reported README with the actual editor and its production
  // parser/plugins, not only an isolated HTML widget or a Markdown-it render.
  view.destroy();
  const { createElement } = await import('react');
  const { createRoot } = await import('react-dom/client');
  const { CodeMirrorEditor } = await import('../src/components/Editor/CodeMirrorEditor');
  const { useAppStore } = await import('../src/store/useAppStore');
  const { getActiveView } = await import('../src/lib/codemirror/activeView');
  const featureList = readme.slice(readme.indexOf('## 功能特性') + '## 功能特性'.length, readme.indexOf('更新日志详见')).trim();
  const featuresSource = `<details>\n<summary><h2>功能特性</h2></summary>\n\n${featureList}\n\n</details>\n\n更新日志详见 CHANGELOG.md\n\n## 安装\n\n`;
  useAppStore.setState({ activeFilePath: '/fixtures/README.md', content: featuresSource, mdViewMode: 'live', presentationActive: false });
  const root = createRoot(host);
  root.render(createElement(CodeMirrorEditor));
  for (let i = 0; i < 100 && !getActiveView(); i++) await tick();
  const editor = getActiveView()!;
  check(!!editor, 'production editor mounts for the real README section');
  await tick();
  const featureDetails = firstDetails();
  const featureSummary = featureDetails.querySelector('summary')!;
  const featureHeading = featureSummary.querySelector('h2')!;
  const regularHeading = host.querySelector<HTMLElement>('.cm-line.cm-md-h2')!;
  check(!!regularHeading, 'README section includes a normal Markdown h2 for comparison');
  check(getComputedStyle(featureHeading).fontSize === getComputedStyle(regularHeading).fontSize &&
    getComputedStyle(featureHeading).fontWeight === getComputedStyle(regularHeading).fontWeight,
    'summary h2 renders at the same size and weight as a Markdown h2');
  check(getComputedStyle(featureSummary).lineHeight === getComputedStyle(regularHeading).lineHeight,
    'summary heading and disclosure marker use the normal heading line height');
  const headingSize = parseFloat(getComputedStyle(featureHeading).fontSize);
  host.style.setProperty('--editor-heading-scale', '1.2'); await tick();
  check(Math.abs(parseFloat(getComputedStyle(featureHeading).fontSize) - headingSize * 1.2) < 0.1,
    'summary headings follow the editor heading scale setting');
  host.style.removeProperty('--editor-heading-scale'); await tick();
  check(featureDetails.querySelectorAll('li').length === 8, 'all eight README features are inside the same details element');
  check(!featureDetails.open, 'README features default to collapsed');
  const collapsedHeight = featureDetails.getBoundingClientRect().height;
  featureDetails.querySelector('summary')!.click(); await tick();
  check(featureDetails.open && featureDetails.getBoundingClientRect().height > collapsedHeight + 100,
    'expanding the README reveals the feature list and increases its height');
  check(parseFloat(getComputedStyle(featureHeading).fontSize) === headingSize, 'expanding details preserves summary heading typography');
  check(getComputedStyle(featureDetails.querySelector('ul')!).listStyleType === 'disc', 'expanded Markdown lists keep their bullets');
  featureDetails.querySelector('summary')!.click(); await tick();
  check(!featureDetails.open && featureDetails.getBoundingClientRect().height === collapsedHeight,
    'collapsing the README hides the whole list again');
  check(host.textContent?.includes('更新日志详见') && host.textContent?.includes('安装'), 'content following the details remains outside it');
  reveal(); await tick();
  check(!host.querySelector('details'), 'README source button reveals the complete block');
  const lastFeature = editor.state.doc.toString().indexOf('中英文界面');
  editor.dispatch({ selection: { anchor: lastFeature } }); await tick();
  check(!host.querySelector('details'), 'moving into the final README feature keeps full source mode');
  editor.dispatch({ selection: { anchor: featuresSource.indexOf('安装') } }); await tick();
  check(firstDetails().querySelectorAll('li').length === 8, 'leaving complete README source restores all features in preview');

  const nested = '<details>\n<summary>Outer</summary>\n\n- **One**\n\n<details open>\n<summary>Inner</summary>\n\n| A | B |\n| --- | --- |\n| 1 | 2 |\n\n</details>\n\n```html\n</details>\n```\n\nTail\n\n</details>\n\n# Outside';
  editor.dispatch({ changes: { from: 0, to: editor.state.doc.length, insert: nested }, selection: { anchor: 0 } }); await tick();
  check(host.querySelectorAll('details').length === 2 && firstDetails().querySelectorAll('table').length === 1,
    'nested details and Markdown tables render inside one outer widget');
  check(!host.querySelector('.cm-md-table-block'), 'inner tables do not create competing editor widgets');
  check(firstDetails().textContent?.includes('Tail') && host.textContent?.includes('Outside'), 'code example closing tags do not truncate the block');
  firstDetails().querySelector('summary')!.click(); await tick();
  check(firstDetails().open, 'nested content can be expanded');
  editor.dispatch({ changes: { from: 0, to: editor.state.doc.length, insert: '<details>\n<summary>Safe</summary>\n\n<img src="x" onerror="alert(1)">\n\n<script>alert(1)</script>\n\n</details>' }, selection: { anchor: 0 } }); await tick();
  check(!firstDetails().querySelector('script') && !firstDetails().querySelector('[onerror]'), 'Markdown rendered inside details is sanitized');
  const levels = [1, 2, 3, 4, 5, 6];
  const outsideHeadings = levels.map(level => `${'#'.repeat(level)} Outside ${level}`).join('\n\n');
  const bodyHeadings = levels.map(level => `<h${level}>HTML ${level}</h${level}>\n\nBody\n\n${'#'.repeat(level)} Markdown ${level}\n\nBody`).join('\n\n');
  const headingSource = `${outsideHeadings}\n\n<details open>\n<summary><h2>Heading typography</h2></summary>\n\n${bodyHeadings}\n\n<details open>\n<summary><h3>Nested title</h3></summary>\n\n<h2>Nested body heading</h2>\n\nBody\n\n</details>\n\n</details>\n\nEnd`;
  editor.dispatch({ changes: { from: 0, to: editor.state.doc.length, insert: headingSource }, selection: { anchor: headingSource.length } }); await tick();
  const typography = (element: Element) => {
    const style = getComputedStyle(element);
    return [style.fontSize, style.fontWeight, style.lineHeight, style.color, style.borderBottomWidth].join('|');
  };
  const checkBodyHeadings = (label: string) => {
    for (const level of levels) {
      const outside = host.querySelector(`.cm-line.cm-md-h${level}`)!;
      const inside = [...firstDetails().querySelectorAll(`h${level}.cm-md-details-heading`)];
      check(!!outside && inside.length >= 2 && inside.every(heading => typography(heading) === typography(outside)),
        `${label}: HTML and Markdown h${level} inside details match outside heading typography`);
    }
  };
  checkBodyHeadings('default');
  const bodyHeading = firstDetails().querySelector<HTMLElement>('h2.cm-md-details-heading')!;
  const originalSize = parseFloat(getComputedStyle(bodyHeading).fontSize);
  check(parseFloat(getComputedStyle(bodyHeading).marginTop) > 0 && parseFloat(getComputedStyle(bodyHeading).marginBottom) > 0,
    'body headings have visible spacing above and below');
  host.style.setProperty('--editor-heading-scale', '1.2');
  host.style.setProperty('--editor-strong-font-weight', '800'); await tick();
  checkBodyHeadings('custom scale and weight');
  check(Math.abs(parseFloat(getComputedStyle(bodyHeading).fontSize) - originalSize * 1.2) < 0.1,
    'body headings follow the editor heading scale');
  const normalMargin = parseFloat(getComputedStyle(bodyHeading).marginTop);
  document.documentElement.classList.add('editor-compact'); await tick();
  checkBodyHeadings('compact');
  check(parseFloat(getComputedStyle(bodyHeading).marginTop) < normalMargin, 'compact mode reduces body heading spacing');
  document.documentElement.classList.remove('editor-compact');
  host.style.removeProperty('--editor-heading-scale');
  host.style.removeProperty('--editor-strong-font-weight');
  check(!firstDetails().querySelector('summary .cm-md-details-heading'), 'summary headings keep their existing inherited typography');
  firstDetails().querySelector('summary')!.click(); await tick();
  firstDetails().querySelector('summary')!.click(); await tick();
  checkBodyHeadings('after collapse and reopen');
  // A collapsed note fits the scroller. Expanding it must not activate the
  // editor's usual "stick to document bottom" behavior when its height grows.
  host.style.height = '320px';
  editor.scrollDOM.style.height = '320px';
  const longDetails = '<details>\n<summary><h2>Long section</h2></summary>\n\n' +
    Array.from({ length: 120 }, (_, i) => `Paragraph ${i + 1}`).join('\n\n') + '\n\n</details>\n';
  editor.dispatch({ changes: { from: 0, to: editor.state.doc.length, insert: longDetails }, selection: { anchor: longDetails.length } });
  editor.focus();
  editor.requestMeasure(); await tick(); await tick();
  const longSummary = firstDetails().querySelector('summary')!;
  const summaryTop = longSummary.getBoundingClientRect().top;
  longSummary.click(); await tick(); await tick();
  check(Math.abs(longSummary.getBoundingClientRect().top - summaryTop) < 2 && editor.scrollDOM.scrollTop < 2,
    'expanding a long section keeps its title in place instead of jumping to the bottom');
  host.style.height = '';
  editor.scrollDOM.style.height = '';
  // The README ends with a short details block after a tall command table.
  // Unlike a details-only document, it can reach the scroller's bottom with
  // the summary still visible in the lower half of the viewport.
  host.style.height = '640px';
  editor.scrollDOM.style.height = '640px';
  // Retain the reproduction when the scratch block is removed from README.
  const readmeWithDetails = readme.trimEnd().endsWith('</details>') ? readme
    : readme + '\n\n<details>\n<summary><h2>折叠块标题</h2></summary>\n\n' +
      Array.from({ length: 14 }, () => '在这里输入内容111').join('\n\n') + '\n\n</details>\n';
  const readmeDetailsFrom = readmeWithDetails.lastIndexOf('<details>');
  check(readmeWithDetails.indexOf('### 常用命令') < readmeDetailsFrom, 'README fixture ends with details after the command table');
  editor.dispatch({ changes: { from: 0, to: editor.state.doc.length, insert: readmeWithDetails },
    selection: { anchor: readmeWithDetails.length } });
  editor.focus();
  editor.dispatch({ effects: EditorView.scrollIntoView(readmeDetailsFrom, { y: 'start', yMargin: 360 }) });
  for (let i = 0; i < 10; i++) await tick();
  const readmeSummary = host.querySelectorAll('details')[host.querySelectorAll('details').length - 1].querySelector('summary')!;
  editor.scrollDOM.scrollTop = editor.scrollDOM.scrollHeight;
  for (let i = 0; i < 5; i++) await tick();
  for (let i = 0; i < 4; i++) {
    const before = readmeSummary.getBoundingClientRect().top;
    readmeSummary.click();
    for (let n = 0; n < 5; n++) await tick();
    const after = readmeSummary.getBoundingClientRect().top;
    check(Math.abs(after - before) < 2,
      `README toggle ${i + 1} keeps the summary in place (${before.toFixed(1)} → ${after.toFixed(1)})`);
  }
  check(editor.state.doc.toString() === readmeWithDetails && editor.state.selection.main.head === readmeWithDetails.length,
    'keeping the viewport stable preserves README content and the editor selection');
  host.style.height = '';
  editor.scrollDOM.style.height = '';
  const { Toolbar } = await import('../src/components/Editor/Toolbar');
  const { undo, isolateHistory } = await import('@codemirror/commands');
  const toolbarHost = document.createElement('div');
  host.before(toolbarHost);
  const toolbarRoot = createRoot(toolbarHost);
  toolbarRoot.render(createElement(Toolbar));
  applyLanguage('zh-CN'); await tick();
  const contentMenu = () => toolbarHost.querySelector<HTMLButtonElement>('button[title="内容块"]')!;
  const insertDetails = () => document.querySelector<HTMLButtonElement>('button[title^="折叠块"]')!;
  contentMenu().click(); await tick();
  check(!!insertDetails() && document.body.textContent?.includes('普通代码块') && document.body.textContent?.includes('加密内容块'),
    'content blocks menu groups collapsible, plain code, interactive and encrypted blocks');
  contentMenu().click(); await tick();
  for (const [doc, from, to] of [
    ['', 0, 0],
    ['BeforeSelectedAfter', 6, 14],
    ['Before\n\n- **One**\n- Two\n\nAfter', 8, 23],
  ] as const) {
    editor.dispatch({ changes: { from: 0, to: editor.state.doc.length, insert: doc },
      selection: { anchor: from, head: to }, annotations: isolateHistory.of('full') });
    contentMenu().click(); await tick();
    insertDetails().click(); await tick();
    const inserted = editor.state.doc.toString();
    check(editor.state.sliceDoc(editor.state.selection.main.from, editor.state.selection.main.to) === '折叠块标题',
      'insertion selects the title for immediate editing');
    check(inserted.includes(`<summary>折叠块标题</summary>\n\n${doc.slice(from, to) || '在这里输入内容'}\n\n</details>`),
      'insertion preserves selected content or supplies a localized placeholder');
    check(!host.querySelector('details'), 'new block source is visible while editing the selected title');
    editor.dispatch({ selection: { anchor: editor.state.doc.length } }); await tick();
    check(!!firstDetails() && !firstDetails().open, 'leaving the inserted block renders a collapsed preview');
    firstDetails().querySelector('summary')!.click(); await tick();
    check(firstDetails().open, 'inserted block expands on click');
    undo(editor); await tick();
    check(editor.state.doc.toString() === doc, 'one undo restores the original document and wrapped content');
  }
  applyLanguage('en'); await tick();
  check(!!toolbarHost.querySelector('button[title="Content blocks"]'), 'toolbar block label follows the interface language');
  toolbarRoot.unmount(); toolbarHost.remove();
  editor.dispatch({ changes: { from: 0, to: editor.state.doc.length, insert: featuresSource }, selection: { anchor: 0 } }); await tick();
  applyLanguage('zh-CN');
  report.textContent = `PASS: ${passed.length} checks\n${passed.join('\n')}`;
  if (new URLSearchParams(location.search).has('scroll') || new URLSearchParams(location.search).has('readme')) {
    const useReadme = new URLSearchParams(location.search).has('readme');
    report.style.height = '120px';
    report.style.overflow = 'auto';
    report.style.whiteSpace = 'pre-wrap';
    host.style.height = useReadme ? '640px' : '320px';
    editor.scrollDOM.style.height = useReadme ? '640px' : '320px';
    const prefix = Array.from({ length: 25 }, (_, i) => `Before ${i + 1}`).join('\n\n') + '\n\n';
    const manualSource = useReadme ? readmeWithDetails : prefix + longDetails + '\n## Following\n';
    editor.dispatch({ changes: { from: 0, to: editor.state.doc.length, insert: manualSource }, selection: { anchor: manualSource.length } });
    editor.focus();
    editor.dispatch({ effects: EditorView.scrollIntoView(useReadme ? readmeDetailsFrom : prefix.length, { y: 'end' }) });
    await tick(); await tick();
    const summary = host.querySelectorAll('details')[host.querySelectorAll('details').length - 1].querySelector('summary')!;
    const status = () => {
      report.textContent = `Scroll regression fixture\nscrollTop=${editor.scrollDOM.scrollTop}, height=${editor.scrollDOM.clientHeight}, scrollHeight=${editor.scrollDOM.scrollHeight}\nsummaryTop=${summary.getBoundingClientRect().top}, windowY=${window.scrollY}, selection=${editor.state.selection.main.head}`;
    };
    summary.parentElement!.addEventListener('toggle', () => requestAnimationFrame(() => requestAnimationFrame(status)));
    status();
  }
} catch (error) {
  report.textContent = `FAIL: ${String(error)}\n${passed.join('\n')}`;
  throw error;
}
