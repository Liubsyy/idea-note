import assert from 'node:assert/strict';
import test from 'node:test';
import { paginate } from '../src/lib/presentation/paginate.ts';
import { presentationBreaks } from '../src/lib/presentation/breaks.ts';

test('long content uses screen height with a partial final page', () => {
  assert.deepEqual(paginate(1250, 500), [{from:0,to:500},{from:500,to:1000},{from:1000,to:1250}]);
});
test('manual boundaries end a page early then restart screen pagination', () => {
  assert.deepEqual(paginate(1600, 500, [240, 1300]), [{from:0,to:240},{from:240,to:740},{from:740,to:1240},{from:1240,to:1300},{from:1300,to:1600}]);
});
test('leading, trailing and consecutive breaks do not create empty pages', () => {
  assert.deepEqual(paginate(600, 500, [0, 200, 200, 600, 900, NaN]), [{from:0,to:200},{from:200,to:600}]);
});
test('text blocks move intact to the next page when they fit on a screen', () => {
  assert.deepEqual(paginate(800, 500, [], [{from:440,to:600}]), [{from:0,to:440},{from:440,to:800}]);
});
test('oversized blocks split on visual lines without losing content', () => {
  assert.deepEqual(paginate(900, 500, [], [{from:0,to:900},{from:490,to:510}]), [{from:0,to:490},{from:490,to:900}]);
});
test('overlapping blocks and manual breaks always make progress', () => {
  const pages = paginate(1000, 500, [100, 900], [{from:100,to:570},{from:450,to:700},{from:80,to:550}]);
  assert.equal(pages[0].from, 0);
  assert.equal(pages.at(-1).to, 1000);
  pages.forEach((page, i) => {
    assert.ok(page.to > page.from && page.to - page.from <= 500);
    if (i) assert.equal(page.from, pages[i - 1].to);
  });
});
test('empty content and invalid geometry keep one safe page', () => {
  assert.deepEqual(paginate(0, 500), [{from:0,to:0}]);
  assert.deepEqual(paginate(100, 0), [{from:0,to:0}]);
});
test('page separators and surrounding whitespace are skipped', () => {
  assert.deepEqual(paginate(1000, 500, [{from:150,to:210}]), [{from:0,to:150},{from:210,to:710},{from:710,to:1000}]);
});
test('real Markdown breaks are found without modifying source', () => {
  const source = '# Intro\n\nShort page\n\n---\n\n# Next';
  const [range] = presentationBreaks(source);
  assert.equal(source.slice(range.from, range.to), '\n---\n\n');
  assert.equal(source.slice(range.to), '# Next');
});
test('code examples, table separators, setext headings and nested rules are not breaks', () => {
  const source = '```markdown\n---\n```\n\n| a | b |\n| --- | --- |\n| 1 | 2 |\n\nTitle\n---\n\n> ---\n\n- item\n\n  ---';
  assert.deepEqual(presentationBreaks(source), []);
});
test('frontmatter delimiters are not presentation breaks', () => {
  const source = '---\ntitle: Demo\n---\n# Intro\n\n---\n\nNext';
  assert.equal(presentationBreaks(source).length, 1);
  assert.equal(source.slice(presentationBreaks(source)[0].to), 'Next');
});
test('nested longer code fences stay intact', () => {
  assert.deepEqual(presentationBreaks('````markdown\n```python\n---\n```\n````'), []);
});
