import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import ts from 'typescript';
import { JSDOM } from 'jsdom';
import createDOMPurify from 'dompurify';
import MarkdownIt from 'markdown-it';

const { window } = new JSDOM('', { url: 'http://tauri.localhost' });
const { document } = window;
const purifier = createDOMPurify(window);
const runtime = { untrustedContent: false };
const resolved = [];
let shared = false;
const cache = new Map();
function load(relative, dependencies) {
  const filename = new URL(relative, import.meta.url);
  if (cache.has(filename.href)) return cache.get(filename.href);
  const exports = {};
  vm.runInNewContext(ts.transpileModule(readFileSync(filename, 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText, {
    exports, window, document,
    require: (name) => {
      if (Object.hasOwn(dependencies, name)) return dependencies[name];
      throw new Error(`Unexpected dependency: ${name}`);
    },
  });
  cache.set(filename.href, exports);
  return exports;
}
const imagePath = load('../src/lib/imagePath.ts', {
  '@tauri-apps/api/core': { convertFileSrc: (path) => /^[a-z]:\//i.test(path)
    ? `http://asset.localhost/${encodeURIComponent(path)}`
    : `asset://localhost${encodeURI(path)}` },
  '../store/useAppStore': { useAppStore: { getState: () => ({ activeFilePath: 'D:/notes/note.md' }) } },
  './fs': { dirname: (path) => path.slice(0, path.lastIndexOf('/')) },
});
const resolve = (src) => {
  resolved.push(src);
  return shared
    ? /^(?:https?:\/\/|data:image\/)/i.test(src) ? src : ''
    : imagePath.toDisplaySrc(src);
};
const imageSyntax = load('../share-service/renderer/lib/imageSyntax.ts', {});
const inlineHtml = load('../share-service/renderer/lib/codemirror/inlineHtml.ts', {
  dompurify: { default: purifier },
  '../../runtime': { renderRuntime: runtime },
  '../imagePath': { toDisplaySrc: resolve },
  '../imageSyntax': imageSyntax,
});
const { renderOutput } = load('../share-service/renderer/lib/codeRun/renderOutput.ts', {
  '../../i18n/dom.ts': { localizeElement() {} },
  '../../i18n/core.ts': { tr: (text) => text },
  'markdown-it': { default: MarkdownIt },
  '../codemirror/diagram': { renderMermaidSvg() { throw new Error('Not used'); } },
  '../codemirror/inlineHtml': inlineHtml,
  '../imagePath': { toDisplaySrc: resolve },
});

function render(type, data, onSettle) {
  resolved.length = 0;
  shared = false;
  runtime.untrustedContent = false;
  const host = document.createElement('div');
  renderOutput(host, { type, data }, onSettle);
  return host;
}

for (const type of ['markdown', 'html']) {
  for (const path of ['C:/Users/用户/AppData/Local/Temp/QR image.png', 'D:\\二维码\\clipboard.png']) {
    test(`${type} preserves Windows clipboard image paths: ${path}`, () => {
      const content = type === 'markdown'
        ? `![二维码](<${path}>)\n\n检测到 **1** 个二维码。`
        : `<img src="${path}" alt="二维码"><p>检测到 1 个二维码。</p>`;
      const host = render(type, content);
      const image = host.querySelector('img');
      assert.ok(image);
      assert.equal(image.getAttribute('src'), `http://asset.localhost/${encodeURIComponent(path.replace(/\\/g, '/'))}`);
      assert.equal(image.alt, '二维码');
      assert.match(host.textContent, /检测到 1 个二维码/);
    });
  }

  test(`${type} keeps relative, macOS, HTTP and inline images`, () => {
    for (const path of ['./assets/chart.png', '/tmp/chart.png', 'https://example.com/chart.png', 'data:image/png;base64,iVBORw0KGgo=']) {
      const host = render(type, type === 'markdown' ? `![chart](${path})` : `<img src="${path}">`);
      const image = host.querySelector('img');
      assert.ok(image.hasAttribute('src'), path);
      assert.equal(image.getAttribute('src'), resolve(path));
    }
  });

  test(`${type} still removes scripts, event handlers and dangerous URL schemes`, () => {
    const host = render(type, '<script>globalThis.compromised=true</script>\n\n'
      + '<img src="C:/tmp/a.png" onerror="alert(1)">'
      + '<img src="javascript:alert(1)"><img src="java&#x09;script:alert(1)">'
      + '<a href="javascript:alert(1)">bad link</a><iframe src="https://example.com"></iframe>');
    assert.equal(host.querySelector('script,iframe,[onerror]'), null);
    for (const image of [...host.querySelectorAll('img')].slice(1))
      assert.equal(image.getAttribute('src'), null);
    assert.equal(host.querySelector('a').getAttribute('href'), null);
    assert.ok(resolved.every((src) => !/script:/i.test(src)));
  });

  test(`${type} remeasures the result after image load or failure`, () => {
    let settled = 0;
    const host = render(type, '<img src="C:/tmp/clipboard.png">', () => settled++);
    const image = host.querySelector('img');
    image.dispatchEvent(new window.Event('load'));
    image.dispatchEvent(new window.Event('error'));
    assert.equal(settled, 2);
  });
}

test('shared results cannot turn Windows paths into local file access', () => {
  const host = document.createElement('div');
  shared = true;
  runtime.untrustedContent = true;
  try {
    renderOutput(host, { type: 'markdown', data: '![private](C:/Users/secret.png)' });
    const image = host.querySelector('img');
    assert.ok(!image.getAttribute('src'));
    assert.equal(host.querySelector('script'), null);
  } finally {
    shared = false;
    runtime.untrustedContent = false;
  }
});
