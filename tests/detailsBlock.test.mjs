import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { parser, GFM } from '@lezer/markdown';
import { detailsBlock } from '../src/lib/codemirror/detailsBlock.ts';

const markdown = parser.configure([GFM, detailsBlock]);
function blocks(source) {
  const result = [];
  markdown.parse(source).iterate({ enter(node) {
    if (node.node.parent?.name === 'Document') {
      result.push({ name: node.name, source: source.slice(node.from, node.to) });
      return false;
    }
  } });
  return result;
}

test('README feature list wrapped in details stays in one complete HTML block across blank lines', () => {
  const readme = readFileSync(new URL('../README.md', import.meta.url), 'utf8');
  const body = readme.slice(readme.indexOf('## 功能特性') + '## 功能特性'.length, readme.indexOf('更新日志详见')).trim();
  const source = `<details>\n<summary><h2>功能特性</h2></summary>\n\n${body}\n\n</details>`;
  const features = blocks(source).filter(block => block.source.startsWith('<details>\n<summary><h2>功能特性</h2>'));
  assert.equal(features.length, 1);
  assert.equal(features[0].source, source);
  assert.ok(features[0].source.includes('- **中英文界面**'));
});

test('nested details and Markdown tables stay inside the outer block', () => {
  const source = '<details>\n<summary>Outer</summary>\n\n<details open>\n<summary>Inner</summary>\n\n| A | B |\n| --- | --- |\n| 1 | 2 |\n\n</details>\n\nTail\n\n</details>\n\n## Outside';
  const result = blocks(source);
  assert.deepEqual(result.map(block => block.name), ['HTMLBlock', 'ATXHeading2']);
  assert.equal(result[0].source, source.slice(0, source.lastIndexOf('</details>') + 10));
});

test('code examples, comments, and raw-text HTML do not close details early', () => {
  for (const body of [
    '```html\n</details>\n```',
    '~~~~html\n</details>\n~~~\n~~~~',
    '<!--\n</details>\n-->',
    'An example: `</details>`.',
    '<pre>\n</details>\n</pre>',
  ]) {
    const source = `<details>\n<summary>Examples</summary>\n\n${body}\n\nStill inside\n\n</details>\n\n# Outside`;
    const result = blocks(source);
    assert.deepEqual(result.map(block => block.name), ['HTMLBlock', 'ATXHeading1'], body);
    assert.ok(result[0].source.endsWith('Still inside\n\n</details>'), body);
  }
});

test('separate details stay independent; tags in fenced/indented code stay code', () => {
  const detail = '<DETAILS open title="a > b">\n<SUMMARY>Title</SUMMARY>\n\nBody\n\n</DETAILS>';
  assert.deepEqual(blocks(`${detail}\n\n${detail}`).map(block => block.source), [detail, detail]);
  assert.deepEqual(blocks('```html\n<details>\n\n</details>\n```').map(block => block.name), ['FencedCode']);
  assert.deepEqual(blocks('    <details>\n\n    </details>').map(block => block.name), ['CodeBlock']);
});
