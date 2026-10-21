import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import ts from 'typescript';
import { JSDOM } from 'jsdom';
import createDOMPurify from 'dompurify';

// Real DOMPurify on jsdom, real runtime and sanitizer sources; only the image
// helpers that sanitizeHtml never calls are stubbed.
const { window } = new JSDOM('<!doctype html><body></body>');
function load(path, dependencies) {
  const module = { exports: {} };
  vm.runInNewContext(ts.transpileModule(readFileSync(new URL(path, import.meta.url), 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText, { module, exports: module.exports, require: name => {
    assert.ok(name in dependencies, `unexpected dependency: ${name}`);
    return dependencies[name];
  } });
  return module.exports;
}
const runtime = load('../renderer/runtime.ts', {});
const { sanitizeHtml } = load('../renderer/lib/codemirror/inlineHtml.ts', {
  dompurify: { default: createDOMPurify(window) },
  '../../runtime': runtime,
  '../imagePath': { toDisplaySrc: src => src },
  '../imageSyntax': {},
});
const parse = html => { const template = window.document.createElement('template'); template.innerHTML = html; return template.content; };
// A leading <style> is hoisted out of the body by the parser anyway; the
// attack places it after other content.
const sample = '<p style="color:red" onclick="alert(1)">note</p><style>body{display:none}</style><form action="/api/v1/admin/logout"><input name="password"><select><option>a</option></select><textarea></textarea><button>Go</button></form><img src="https://example.com/a.png" onerror="alert(1)"><script>alert(1)</script>';
const formControls = ['form', 'input', 'select', 'option', 'textarea', 'button'];

test('desktop notes keep page styles and form controls, never scripts', () => {
  runtime.configureRenderRuntime({ untrustedContent: false });
  const out = parse(sanitizeHtml(sample));
  for (const tag of ['style', ...formControls]) assert.ok(out.querySelector(tag), tag);
  assert.equal(out.querySelector('script'), null);
  assert.equal(out.querySelector('p').getAttribute('onclick'), null);
  assert.equal(out.querySelector('img').getAttribute('onerror'), null);
});

test('shared documents lose page-wide styles and form controls but keep formatting', () => {
  runtime.configureRenderRuntime({ untrustedContent: true });
  const out = parse(sanitizeHtml(sample + '<svg><style>*{pointer-events:none}</style><circle r="4"/></svg><details><summary>more</summary><b>bold</b></details>'));
  for (const tag of ['style', 'script', ...formControls]) assert.equal(out.querySelector(tag), null, tag);
  assert.equal(out.querySelector('p').textContent, 'note');
  assert.equal(out.querySelector('p').getAttribute('style'), 'color:red');
  assert.equal(out.querySelector('img').getAttribute('src'), 'https://example.com/a.png');
  assert.ok(out.querySelector('circle') && out.querySelector('details summary') && out.querySelector('b'));
});

test('Mermaid SVG keeps foreignObject labels and diagram CSS, loses active content', () => {
  const svg = '<svg id="mermaid-1" xmlns="http://www.w3.org/2000/svg"><style>#mermaid-1 .node rect{fill:#eee}</style>' +
    '<g class="node"><rect width="10" height="10"/><foreignObject width="80" height="24"><div xmlns="http://www.w3.org/1999/xhtml" style="display:inline-block"><span class="nodeLabel">Start</span><input value="x"></div></foreignObject>' +
    '<text dominant-baseline="middle" onclick="alert(1)">t</text></g><a href="javascript:alert(1)"><text>x</text></a><script>alert(1)</script></svg>';
  for (const untrusted of [false, true]) {
    runtime.configureRenderRuntime({ untrustedContent: untrusted });
    const clean = sanitizeHtml(svg, 'svg'), out = parse(clean);
    assert.match(out.querySelector('style')?.textContent ?? '', /#mermaid-1 \.node rect/);
    const label = out.querySelector('.nodeLabel');
    assert.equal(label?.textContent, 'Start');
    assert.equal(label.parentElement.parentElement.localName, 'foreignObject');
    assert.equal(out.querySelector('text').getAttribute('dominant-baseline'), 'middle');
    assert.equal(out.querySelector('text').getAttribute('onclick'), null);
    assert.equal(out.querySelector('script'), null);
    assert.doesNotMatch(clean, /javascript:/);
    assert.equal(Boolean(out.querySelector('input')), !untrusted);
  }
  // The HTML profile is not suitable for Mermaid: it drops the labels.
  runtime.configureRenderRuntime({ untrustedContent: false });
  assert.equal(parse(sanitizeHtml(svg)).querySelector('.nodeLabel'), null);
});

test('only the share viewer opts into the untrusted profile', () => {
  // The desktop never configures it, so its notes keep the default.
  assert.equal(load('../renderer/runtime.ts', {}).renderRuntime.untrustedContent, false);
  assert.match(readFileSync(new URL('../renderer/viewer.ts', import.meta.url), 'utf8'), /configureRenderRuntime\(\{\s*untrustedContent:\s*true\b/);
});
