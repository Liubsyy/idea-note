// Real Settings and CodeMirror with mocked native I/O; no user notes are accessed.
import React from 'react';
import { createRoot } from 'react-dom/client';
import { mockIPC, mockWindows } from '@tauri-apps/api/mocks';
import { EditorView } from '@codemirror/view';
import { openSearchPanel } from '@codemirror/search';
import { undoDepth } from '@codemirror/commands';
import '../src/styles/globals.css';

mockWindows('settings');
mockIPC(async command => {
  if (command === 'sync_config_load') return '{}';
  if (command === 'git_proxy_load') return '';
  if (command === 'ai_models_load') return [];
  if (command === 'git_run') return { code: 0, stdout: 'git version 2.0', stderr: '' };
  return null;
}, { shouldMockEvents: true });

const result = document.getElementById('test-result')!;
const host = document.getElementById('root')!;
const delay = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
const check = (value: unknown, label: string) => { if (!value) throw Error(label); };
async function until(check: () => unknown) {
  for (let i = 0; i < 120; i++) { if (check()) return; await delay(25); }
  throw Error('Timed out waiting for UI');
}
try {
  const locale = await import('../src/i18n/core');
  locale.changeLanguage('zh-CN');
  const { SettingsWindow } = await import('../src/components/SettingsWindow');
  const { CodeMirrorEditor } = await import('../src/components/Editor/CodeMirrorEditor');
  const { useAppStore } = await import('../src/store/useAppStore');
  const { getActiveView } = await import('../src/lib/codemirror/activeView');
  const original = '# 用户笔记\n\nKeep this 中文 content.\n\n```python\nprint(1)\n```\n';
  useAppStore.setState({ activeFilePath: 'draft:language-test', content: original, isDirty: true });
  const editorHost = document.createElement('div');
  editorHost.style.cssText = 'position:fixed;left:-3000px;top:0;width:800px;height:500px';
  document.body.append(editorHost);
  createRoot(editorHost).render(<CodeMirrorEditor />);
  createRoot(host).render(<SettingsWindow />);
  await until(() => host.querySelector('select[aria-label="语言 / Language"]') && getActiveView());
  const editor = getActiveView()!;
  editor.dispatch({ changes: { from: 0, insert: 'Unsaved edit\n' }, selection: { anchor: 5 } });
  openSearchPanel(editor);
  const search = editorHost.querySelector<HTMLInputElement>('.cm-find-field')!;
  search.value = '中文';
  search.dispatchEvent(new Event('input', { bubbles: true }));
  const doc = editor.state.doc.toString(), selection = editor.state.selection.main.anchor;
  const history = undoDepth(editor.state);
  const switchLanguage = async (language: string) => {
    const select = host.querySelector<HTMLSelectElement>('select[aria-label="语言 / Language"]')!;
    select.value = language;
    select.dispatchEvent(new Event('change', { bubbles: true }));
    await delay(80);
  };
  await switchLanguage('en');
  check(host.textContent?.includes('Appearance') && host.textContent?.includes('Interface zoom'), 'English settings');
  check(!host.textContent?.includes('经典（'), 'English built-in theme names');
  check(search.placeholder === 'Find' && search.value === '中文', 'Search chrome updates, query remains intact');
  check(getActiveView() === editor && EditorView.findFromDOM(editor.contentDOM) === editor, 'Editor is not remounted');
  check(editor.state.doc.toString() === doc && editor.state.selection.main.anchor === selection, 'Unsaved note and selection preserved');
  check(undoDepth(editor.state) === history, 'Undo history preserved');
  check(locale.readLanguage() === 'en' && document.documentElement.lang === 'en', 'Saved preference and HTML language');
  const nav = [...host.querySelectorAll('nav button')];
  for (const button of nav) {
    (button as HTMLButtonElement).click();
    await delay(80);
    const content = host.querySelector('section')?.textContent ?? '';
    check(!/\p{Script=Han}/u.test(content.replaceAll('语言 / Language', '').replaceAll('简体中文', '')), `Untranslated settings: ${content}`);
  }
  (nav[0] as HTMLButtonElement).click();
  await delay(40);
  await switchLanguage('zh-CN');
  check(host.textContent?.includes('外观') && search.placeholder === '查找', 'Switch back to Chinese');
  check(editor.state.doc.toString() === doc, 'Note preserved after round trip');
  await switchLanguage('en');
  result.textContent = 'PASS: all 9 settings sections; English ↔ Chinese; saved preference; editor identity, unsaved text, selection, undo history, and search query preserved.';
  result.style.background = '#166534';
} catch (error) {
  result.textContent = 'FAIL: ' + String(error);
  result.style.background = '#991b1b';
  console.error(error);
}
