import { EditorState, Compartment } from '@codemirror/state';
import { EditorView } from '@codemirror/view';
import { markdown } from '@codemirror/lang-markdown';
import { mockIPC, mockWindows } from '@tauri-apps/api/mocks';
import '../src/styles/globals.css';
import '../src/lib/codemirror/editor.css';
import { cmTheme } from '../src/lib/codemirror/theme';
import { detailsBlock } from '../src/lib/codemirror/detailsBlock';
import readme from '../README.md?raw';

const openedUrls: string[] = [];
const runRequests: Record<string, unknown>[] = [];
let copiedCode = '';
Object.defineProperty(navigator, 'clipboard', { configurable: true, value: {
  writeText: async (text: string) => { copiedCode = text; },
} });
mockIPC((command, args) => {
  if (command === 'code_run_start') {
    runRequests.push(args as Record<string, unknown>);
    throw new Error('Test backend: execution intercepted');
  }
  if (command === 'plugin:opener|open_url') {
    openedUrls.push(String(args.url));
    return null;
  }
  if (command === 'git_proxy_load') return '';
  if (command === 'sync_config_load') return '{}';
  return null;
}, { shouldMockEvents: true });
mockWindows('main');
await import('../src/lib/share/renderRuntime');
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
  const featureList = readme.match(/## 功能特性\n([\s\S]*?)(?=\n## )/)?.[1] ?? '';
  const featureRows = [...featureList.matchAll(/^- \*\*(.+?)\*\*：(.+)$/gm)].map(row => `| **${row[1]}** | ${row[2]} |`).join('\n');
  check(!!featureRows, 'actual README feature list is available');
  const featureBlock = `<details>\n<summary><h2>功能特性</h2></summary>\n\n| 功能 | 说明 |\n| --- | --- |\n${featureRows}\n\n</details>`;
  const featuresSource = `${featureBlock}\n\n更新日志详见 CHANGELOG.md\n\n## 安装\n\n`;
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
  check(featureDetails.querySelectorAll('tbody tr').length === 8, 'all eight README feature rows are inside the same details element');
  check(!featureDetails.open, 'README features default to collapsed');
  const collapsedHeight = featureDetails.getBoundingClientRect().height;
  featureDetails.querySelector('summary')!.click(); await tick();
  check(featureDetails.open && featureDetails.getBoundingClientRect().height > collapsedHeight + 100,
    'expanding the README reveals the feature list and increases its height');
  check(parseFloat(getComputedStyle(featureHeading).fontSize) === headingSize, 'expanding details preserves summary heading typography');
  check(getComputedStyle(featureDetails.querySelector('table')!).borderCollapse === 'collapse', 'expanded Markdown table keeps its layout');
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
  check(firstDetails().querySelectorAll('tbody tr').length === 8, 'leaving complete README source restores all features in preview');

  const nested = '<details>\n<summary>Outer</summary>\n\n- **One**\n\n<details open>\n<summary>Inner</summary>\n\n| A | B |\n| --- | --- |\n| 1 | 2 |\n\n</details>\n\n```html\n</details>\n```\n\nTail\n\n</details>\n\n# Outside';
  editor.dispatch({ changes: { from: 0, to: editor.state.doc.length, insert: nested }, selection: { anchor: 0 } }); await tick();
  check(host.querySelectorAll('details').length === 2 && firstDetails().querySelectorAll('table').length === 1,
    'nested details and Markdown tables render inside one outer widget');
  check(!host.querySelector('.cm-md-table-block'), 'inner tables do not create competing editor widgets');
  check(firstDetails().textContent?.includes('Tail') && host.textContent?.includes('Outside'), 'code example closing tags do not truncate the block');
  firstDetails().querySelector('summary')!.click(); await tick();
  check(firstDetails().open, 'nested content can be expanded');
  // Exercise Markdown inside the actual production widget, including forms
  // that previously lost their styling or bypassed the editor's renderers.
  const richSource = [
    '<details open>', '<summary><h3>Markdown coverage</h3></summary>',
    '```javascript', 'const count = 42;', 'console.log("<details>");', '```', '',
    '```unknown-language', 'plain <code> & text', '```', '',
    '    indented <code> & text', '',
    'Inline `code`, **bold**, *italic*, ~~deleted~~, [local](./README.md), and [external](https://example.test/details).', '',
    '> Quoted text', '',
    '> [!HIGHLIGHT color=green]', '> Highlighted `value`', '',
    '- [ ] Pending', '- [x] Done', '',
    '- First', '  - Nested', '', '1. Ordered', '',
    '| Left | Right |', '| :--- | ---: |', '| A | B |', '',
    String.raw`$x^2$ and escaped \$dollars, currency $5 and $6.`, '',
    '$$', String.raw`x = \frac{1}{2}`, '$$', '',
    '```mermaid', 'graph TD', 'A[Start] --> B[End]', '```', '',
    '![](<data:image/png;base64,iVBORw0KGgo=> =120x80)', '',
    '---', '', '<details open>', '<summary>Nested block</summary>',
    '**Nested Markdown**', '</details>', '</details>', '', '# Outside',
  ].join('\n');
  editor.dispatch({ changes: { from: 0, to: editor.state.doc.length, insert: richSource }, selection: { anchor: richSource.length } });
  await tick();
  const rich = firstDetails();
  const javascript = rich.querySelector<HTMLElement>('code.language-javascript')!;
  for (let i = 0; i < 200 && (!javascript.querySelector('span') || !rich.querySelector('.cm-md-details-mermaid svg')); i++) await tick();
  check(javascript.textContent === 'const count = 42;\nconsole.log("<details>");\n', 'code fences preserve every character and do not create nested HTML');
  check(!!javascript.querySelector('span') && getComputedStyle(javascript.querySelector('span')!).color !== getComputedStyle(javascript).color,
    'fenced code receives the same syntax highlighting as the editor');
  const pre = javascript.parentElement!;
  check(parseFloat(getComputedStyle(pre).paddingLeft) > 0 && getComputedStyle(pre.parentElement!).backgroundColor !== 'rgba(0, 0, 0, 0)' && getComputedStyle(pre).whiteSpace === 'pre',
    'code blocks have a visible background, padding, and preserved whitespace');
  check(rich.querySelector('code.language-unknown-language')?.textContent === 'plain <code> & text\n', 'unknown languages retain readable escaped code');
  check([...rich.querySelectorAll('pre > code')].some(code => code.textContent === 'indented <code> & text\n'), 'indented code blocks render as code');
  check(!!rich.querySelector('p code.cm-md-code') && parseFloat(getComputedStyle(rich.querySelector('p code.cm-md-code')!).paddingLeft) > 0, 'inline code receives its normal code pill');
  check(getComputedStyle(rich.querySelector('em')!).fontStyle === 'italic' && getComputedStyle(rich.querySelector('s, del')!).textDecorationLine.includes('line-through'), 'italic and strikethrough remain visible');
  check(parseFloat(getComputedStyle(rich.querySelector('blockquote')!).borderLeftWidth) > 0, 'blockquotes retain their quote border');
  check(!!rich.querySelector('blockquote.cm-md-details-highlight') && !rich.textContent?.includes('[!HIGHLIGHT'), 'highlight blocks hide their marker and retain color');
  const checkboxes = [...rich.querySelectorAll<HTMLInputElement>('input[type="checkbox"]')];
  check(checkboxes.length === 2 && !checkboxes[0].checked && checkboxes[1].checked && checkboxes.every(input => input.disabled), 'task lists display their checked state without changing the note');
  check(!!rich.querySelector('ul ul') && !!rich.querySelector('ol') && !!rich.querySelector('td[style*="right"]'), 'nested lists, ordered lists, and table alignment render');
  check(rich.querySelectorAll('.katex').length === 2 && !!rich.querySelector('.katex-display') && !rich.querySelector('.katex-error') && !!rich.querySelector('math'), 'inline and display math render through KaTeX');
  check(rich.textContent?.includes('currency $5 and $6'), 'currency remains prose rather than accidental math');
  check(!!rich.querySelector('.cm-md-details-mermaid svg') && rich.querySelector('.cm-md-details-mermaid')?.textContent?.includes('Start'), 'Mermaid fences render as a diagram with readable labels');
  check(rich.querySelector<HTMLElement>('img')?.style.width === '120px' && rich.querySelector<HTMLElement>('img')?.style.height === '80px', 'sized Markdown images retain dimensions');
  check(!!rich.querySelector('hr') && rich.querySelectorAll('details').length === 1 && !!rich.querySelector('details strong'), 'horizontal rules and nested Markdown work without extra blank lines');
  const localLink = rich.querySelector<HTMLAnchorElement>('a[href="./README.md"]')!;
  const plainClick = new MouseEvent('click', { bubbles: true, cancelable: true });
  localLink.dispatchEvent(plainClick);
  check(plainClick.defaultPrevented && localLink.classList.contains('cm-md-link'), 'widget links use editor styling and cannot navigate the webview directly');
  const externalLink = rich.querySelector<HTMLAnchorElement>('a[href="https://example.test/details"]')!;
  externalLink.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, ctrlKey: true }));
  await tick();
  check(openedUrls.includes('https://example.test/details'), 'Ctrl-click on a widget link uses the system opener');
  rich.querySelector('summary')!.click(); await tick();
  rich.querySelector('summary')!.click(); await tick();
  check(editor.state.doc.toString() === richSource && !!firstDetails().querySelector('.cm-md-details-mermaid svg'), 'collapse and reopen preserve source, code, and rendered diagrams');
  const shell = pre.parentElement!;
  check(shell.classList.contains('cm-md-details-code') && !!shell.querySelector('.cm-md-code-header'), 'code inside details uses the shared code toolbar');
  check(shell.querySelector('.cm-md-code-language')?.textContent === 'JavaScript' && shell.querySelector('.cm-md-code-count')?.textContent?.includes('2'), 'embedded toolbar shows language and line count');
  const copyCode = () => shell.querySelector<HTMLButtonElement>('.cm-md-code-actions button:last-child')!.click();
  copyCode(); await tick();
  check(copiedCode === 'const count = 42;\nconsole.log("<details>");', 'embedded copy copies the full code body without fences or toolbar text');
  check(!!shell.querySelector('.cm-md-code-action-done'), 'embedded copy shows success feedback');
  const foldCode = () => shell.querySelector<HTMLButtonElement>('.cm-md-code-fold-btn')!.click();
  foldCode(); await tick();
  check(pre.hidden && rich.open && shell.querySelector('.cm-md-code-fold-btn')?.getAttribute('aria-expanded') === 'false', 'code folds independently without collapsing its parent details');
  copyCode(); await tick();
  check(copiedCode.includes('console.log') && pre.hidden, 'folded code can still be copied in full');
  const panelWasOpen = useAppStore.getState().runPanelOpen;
  shell.querySelectorAll<HTMLButtonElement>('.cm-md-code-actions button')[1].click(); await tick();
  check(useAppStore.getState().runPanelOpen !== panelWasOpen, 'embedded output button toggles the existing run panel');
  const originalConfig = useAppStore.getState().codeRunConfig;
  useAppStore.setState({ codeRunConfig: { ...originalConfig, confirmEveryRun: true }, confirm: null });
  await tick(); await tick();
  shell.querySelector<HTMLButtonElement>('.cm-md-run-btn')!.click(); await tick();
  const confirmation = useAppStore.getState().confirm;
  check(!!confirmation && runRequests.length === 0, 'embedded run honors confirmation before native execution');
  confirmation!.onConfirm();
  useAppStore.getState().closeConfirm();
  for (let i = 0; i < 100 && !runRequests.length; i++) await tick();
  check(runRequests.length === 1 && runRequests[0].code === 'const count = 42;\nconsole.log("<details>");', 'embedded run sends only the snippet through the existing execution pipeline');
  useAppStore.setState({ codeRunConfig: { ...originalConfig, enabled: false } });
  await tick(); await tick();
  check(!shell.querySelector('.cm-md-run-btn') && pre.hidden && firstDetails() === rich, 'runner settings refresh controls while preserving details and code folds');
  useAppStore.setState({ codeRunConfig: originalConfig });
  await tick(); await tick();
  check(!!shell.querySelector('.cm-md-run-btn'), 'reenabling runners restores the embedded run action');
  foldCode(); await tick();
  check(!pre.hidden && shell.querySelector('.cm-md-code-fold-btn')?.getAttribute('aria-expanded') === 'true', 'embedded code expands again');
  const unknownShell = rich.querySelector('code.language-unknown-language')!.closest('.cm-md-details-code')!;
  check(!unknownShell.querySelector('.cm-md-run-btn') && unknownShell.querySelectorAll('.cm-md-code-actions button').length === 1, 'unknown languages provide copy without offering execution');
  host.style.width = '400px'; await tick();
  const embeddedHeader = shell.querySelector('.cm-md-code-header')!;
  check(embeddedHeader.querySelector('.cm-md-code-meta')!.getBoundingClientRect().right <= embeddedHeader.querySelector('.cm-md-code-actions')!.getBoundingClientRect().left, 'embedded toolbar actions fit in a narrow editor');
  host.style.width = '';
  check(editor.state.doc.toString() === richSource, 'copy, run, and folding leave the note unchanged');
  useAppStore.setState({ mdViewMode: 'readonly' }); await tick(); await tick();
  const readonlyShell = firstDetails().querySelector('.cm-md-details-code')!;
  check(!readonlyShell.querySelector('.cm-md-run-btn') && !!readonlyShell.querySelector('.cm-md-code-actions button'), 'read-only embedded code retains copy and hides execution');
  readonlyShell.querySelector<HTMLButtonElement>('.cm-md-code-actions button:last-child')!.click(); await tick();
  check(copiedCode === 'const count = 42;\nconsole.log("<details>");', 'read-only embedded copy remains functional');
  readonlyShell.querySelector<HTMLButtonElement>('.cm-md-code-fold-btn')!.click(); await tick();
  check(readonlyShell.querySelector<HTMLPreElement>('pre')!.hidden, 'read-only embedded code can still fold');
  useAppStore.setState({ mdViewMode: 'live' }); await tick(); await tick();
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
  check(readmeWithDetails.indexOf('<summary><h3>常用命令</h3></summary>') < readmeDetailsFrom, 'README fixture ends with details after the command table');
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
  if (new URLSearchParams(location.search).has('markdown')) {
    report.textContent = `PASS: ${passed.length} checks — collapsible Markdown preview`;
    host.style.height = '800px';
    editor.scrollDOM.style.height = '800px';
    editor.dispatch({ changes: { from: 0, to: editor.state.doc.length, insert: richSource }, selection: { anchor: richSource.length } });
    editor.dispatch({ effects: EditorView.scrollIntoView(0, { y: 'start' }) });
  }
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
