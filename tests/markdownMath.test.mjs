import assert from 'node:assert/strict';
import test from 'node:test';
import MarkdownIt from 'markdown-it';
import { addMathRules } from '../share-service/renderer/lib/markdownMath.ts';

const md = new MarkdownIt({ html: true });
addMathRules(md);

test('shared widget and PDF math renders inline, display, and table formulas', () => {
  const html = md.render(String.raw`Inline $x^2$.

$$
x = \frac{1}{2}
$$

| Formula |
| --- |
| $y^2$ |`);
  assert.equal((html.match(/class="katex"/g) ?? []).length, 3);
  assert.match(html, /katex-display/);
  assert.match(html, /<math/);
  assert.doesNotMatch(html, /katex-error/);
});

test('currency, escaped dollars, and formulas inside code remain literal', () => {
  const prose = md.render(String.raw`Cost $5 and $6; escaped \$literal.`);
  assert.doesNotMatch(prose, /katex/);
  assert.match(prose, /Cost \$5 and \$6; escaped \$literal/);
  const code = md.render('`$x$`\n\n```tex\n$$x$$\n```');
  assert.doesNotMatch(code, /katex/);
  assert.match(code, /<code>\$x\$<\/code>/);
  assert.match(code, /\$\$x\$\$/);
});

test('invalid formulas keep a readable error without aborting the note', () => {
  const html = md.render(String.raw`$\frac{1}{$

Still readable.`);
  assert.match(html, /katex-error/);
  assert.match(html, /Still readable/);
});
