// npm run dev:preview-tests, then open this page (?auto=1 runs assertions).
import React from 'react';
import { createRoot } from 'react-dom/client';
import { mockIPC, mockWindows } from '@tauri-apps/api/mocks';
import '../src/styles/globals.css';

const host = document.getElementById('test-editor')!;
const result = document.getElementById('test-result')!;
const activity = document.getElementById('activity')!;
const delay = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
let creates = 0, closes = 0, executions = 0, beats = 0;
let sessionDelay = 700, failNext = false;
const updateActivity = () => { activity.textContent = `创建会话 ${creates} · 释放 ${closes} · 执行脚本 ${executions} · 心跳 ${beats}`; };
mockWindows('main');
mockIPC(async cmd => {
  if (cmd === 'create_preview_session') {
    const sessionId = String(++creates);
    const reject = failNext;
    failNext = false;
    updateActivity();
    await delay(sessionDelay);
    if (reject) throw new Error('测试：预览资源暂时无法读取');
    return { sessionId, baseUrl: `${location.origin}/tests/preview-fixtures/` };
  }
  if (cmd === 'close_preview_session') { closes++; updateActivity(); }
  if (cmd === 'sync_config_load') return '{}';
  if (cmd === 'git_proxy_load') return '';
  return null;
}, { shouldMockEvents: true });
window.addEventListener('message', event => {
  if (event.source !== host.querySelector('iframe')?.contentWindow || event.data?.type !== 'slow-preview-fixture') return;
  if (event.data.event === 'executed') executions++;
  if (event.data.event === 'heartbeat') beats++;
  updateActivity();
});
const { useAppStore } = await import('../src/store/useAppStore');
const { HtmlEditor } = await import('../src/components/Editor/HtmlEditor');
const { getActiveView } = await import('../src/lib/codemirror/activeView');
useAppStore.setState({ workspacePath: null });
const root = createRoot(host);
function Fixture() {
  const key = useAppStore(s => s.docKey);
  return <HtmlEditor key={key} path="/fixtures/slow.html" />;
}
function openExample(wait = 9000) {
  useAppStore.setState(s => ({ activeFilePath: '/fixtures/slow.html', docKey: s.docKey + 1, isDirty: false,
    content: `<html><body><h1>慢资源测试</h1><p id="slow-result">资源等待中</p><script src="./assets/slow.js?delay=${wait}&run=${s.docKey}"></script></body></html>` }));
  root.render(<Fixture />);
}
function check(value: unknown, label: string): asserts value { if (!value) throw new Error(label); }
async function until(predicate: () => unknown, label: string, timeout = 6000) {
  const start = performance.now();
  while (performance.now() - start < timeout) { if (predicate()) return; await delay(25); }
  throw new Error(`Timed out: ${label}`);
}
function click(label: string) {
  const button = [...host.querySelectorAll('button')].find(b => b.textContent === label || b.getAttribute('aria-label') === label);
  check(button, `missing ${label}`); button.click();
}
const loaded = () => host.querySelector('.html-preview-container')?.getAttribute('aria-busy') === 'false';
async function run() {
  document.querySelectorAll<HTMLButtonElement>('body > div:first-child button').forEach(b => { b.disabled = true; });
  const passed: string[] = [];
  try {
    sessionDelay = 600;
    openExample(1800);
    await until(() => getActiveView(), 'source mounted');
    const initialCreates = creates, initialExec = executions;
    const view = getActiveView()!;
    view.dispatch({ changes: { from: 0, insert: '<!-- source edit -->' } });
    await delay(400);
    check(creates === initialCreates && executions === initialExec && !host.querySelector('iframe'), 'source must not create a session, frame or execute JS');
    check(!host.querySelector('[aria-label="刷新预览"]'), 'source mode cannot refresh hidden preview');
    passed.push('default source and edits never execute');

    const oldCloses = closes;
    click('预览');
    await until(() => host.querySelector('.html-preview-spinner'), 'initial loading animation');
    const spinner = host.querySelector('.html-preview-spinner')!;
    check(getComputedStyle(spinner).animationName === 'html-preview-spin', 'loading animation configured');
    click('返回源码');
    await until(() => getActiveView() && !host.querySelector('iframe'), 'cancel loading');
    await until(() => closes > oldCloses, 'late session released');
    check(executions === initialExec, 'cancelled initialization cannot execute');
    passed.push('cancel during session creation releases late result');

    sessionDelay = 20;
    click('分屏');
    await until(() => host.querySelector('iframe') && host.querySelector('.html-preview-spinner'), 'slow script waiting');
    // A forged or previous-document completion message must not dismiss loading.
    window.postMessage({ type: 'idea-note-preview-ready', token: 'old-token' }, '*');
    await delay(180);
    check(!loaded(), 'untrusted ready ignored');
    const frame = host.querySelector('iframe');
    const started = performance.now();
    click('预览');
    await until(() => !getActiveView(), 'responsive mode switch during load');
    check(performance.now() - started < 600 && frame === host.querySelector('iframe'), 'mode switch remains responsive and preserves in-flight frame');
    await until(() => loaded() && executions > initialExec, 'slow external script completes');
    check(!host.querySelector('.html-preview-spinner'), 'spinner disappears after real frame load');
    const beforeBeat = beats;
    await until(() => beats > beforeBeat, 'script heartbeat');
    click('源码'); await until(() => !host.querySelector('iframe'), 'source destroys frame');
    const stopped = beats;
    await delay(300);
    check(beats === stopped, 'hidden scripts do not continue running');
    passed.push('slow resource animation, responsive switch, completion and script cleanup');

    const beforeRetry = executions;
    failNext = true;
    click('预览');
    await until(() => host.querySelector('[role="alert"]'), 'session failure');
    check(loaded() && !host.querySelector('.html-preview-spinner'), 'failure ends loading');
    click('重试加载');
    await until(() => loaded() && executions > beforeRetry, 'retry succeeds');
    passed.push('resource session failure and retry');

    openExample(9000);
    await until(() => getActiveView(), 'new source');
    click('预览');
    await until(() => host.textContent?.includes('页面加载较慢'), 'long wait feedback', 8800);
    check(host.textContent?.includes('重试加载') && host.querySelector('.html-preview-spinner'), 'long wait offers retry and keeps animation');
    click('返回源码'); await until(() => !host.querySelector('iframe'), 'cancel slow external request');
    passed.push('long loading notice and cancellation');

    useAppStore.setState(s => ({ docKey: s.docKey + 1, content: '<img src="./assets/missing.png"><h1>failure remains visible</h1>' }));
    await until(() => getActiveView(), 'error fixture source');
    click('预览');
    await until(() => loaded() && host.querySelector('[role="alert"]')?.textContent?.includes('资源加载失败'), 'resource error finishes loading');
    passed.push('failed subresource keeps page and diagnostic');
    result.textContent = `PASS (${passed.length} groups): ${passed.join('; ')}`;
    document.title = 'PASS — HTML lazy loading';
  } catch (error) {
    result.textContent = `FAIL after ${passed.join('; ')}: ${String(error)}`;
    document.title = 'FAIL — HTML lazy loading';
    console.error(error);
  } finally {
    document.querySelectorAll<HTMLButtonElement>('body > div:first-child button').forEach(b => { b.disabled = false; });
  }
}
document.getElementById('slow-example')!.onclick = () => { failNext = false; openExample(); };
document.getElementById('error-example')!.onclick = () => { failNext = true; openExample(); };
document.getElementById('run-tests')!.onclick = () => { void run(); };
openExample();
if (new URLSearchParams(location.search).has('auto')) void run();
