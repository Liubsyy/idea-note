import test from 'node:test';
import assert from 'node:assert/strict';
import { redactSecrets, resourceReferences, replaceResources, stripHtmlComments } from '../share-service/renderer/snapshot.ts';

test('sharing strips fenced and inline encrypted bytes and metadata without touching ordinary code',()=>{
  const source='before\n```secret {v=1,key=k1,id=b1}\nCIPHER_DO_NOT_UPLOAD\n```\ntext `secret {v=1,key=k1,id=b2} INLINE_CIPHER` after\n```js\nconsole.log(1)\n```';
  const result=redactSecrets(source);
  assert.ok(!result.includes('CIPHER'));assert.ok(!result.includes('key=k1'));assert.ok(result.includes('console.log(1)'));assert.equal(result.match(/加密内容未公开/g).length,2);
});
test('unknown and unterminated secret blocks are also redacted',()=>{
  const result=redactSecrets('~~~secret {v=99,broken}\nUNKNOWN_CIPHER');assert.equal(result,'加密内容未公开');
});
test('resource collection preserves external links and ignores code examples',()=>{
  const source='![pic](<assets/my image.png> =300x200)\n[report](files/report.pdf)\n[remote](https://example.com)\n<img src="assets/icon.svg" width="100">\n`![example](secret.png)`\n```md\n[code](not-uploaded.pdf)\n```';
  const refs=resourceReferences(source);
  assert.deepEqual(refs.map(r=>r.source),['assets/my image.png','files/report.pdf','assets/icon.svg']);
  const urls=new Map(refs.map((r,i)=>[r.source,`/api/v1/public/${'a'.repeat(32)}/assets/${String(i).repeat(32)}`]));
  const replaced=replaceResources(source,refs,urls);assert.ok(replaced.includes('=300x200'));assert.ok(replaced.includes('https://example.com'));assert.ok(replaced.includes('[code](not-uploaded.pdf)'));
});
test('reference-style destinations and HTML CSS URLs are included',()=>{
  const source='![x][img]\n\n[img]: <assets/图 1.png>\n<div style="background-image:url(assets/a.png)"><a href="report.pdf">Report</a></div>';
  assert.deepEqual(resourceReferences(source).map(r=>r.source),['assets/图 1.png','assets/a.png','report.pdf']);
});
test('code examples inside HTML disclosures and raw code tags never upload resources',()=>{
  const source='<details>\n<summary>Examples</summary>\n\n```md\n![example](private.png)\n```\n\n`[inline](private.pdf)`\n\n![real](assets/public.png)\n\n<pre><code>&lt;img src="private.svg"&gt;</code></pre>\n<!-- ![hidden](comment.png) -->\n</details>';
  assert.deepEqual(resourceReferences(source).map(r=>r.source),['assets/public.png']);
});
test('reference definitions that no link or image uses are never attachments',()=>{
  const source='![chart][Pic  One] and [full report][report], [collapsed][] and [shortcut]\n\n`[in-code]` <!-- [in-comment] -->\n\n[pic one]: assets/chart.png\n[REPORT]: files/report.pdf\n[collapsed]: files/c.pdf\n[shortcut]: files/s.pdf\n[orphan]: ../../.aws/credentials\n[in-code]: ../.env\n[in-comment]: ~/.ssh/id_rsa';
  assert.deepEqual(resourceReferences(source).map(r=>r.source),['assets/chart.png','files/report.pdf','files/c.pdf','files/s.pdf']);
  assert.deepEqual(resourceReferences('<details>\n<summary>More</summary>\n\n![inside][img]\n</details>\n\n[img]: assets/in-details.png\n[unused]: secret.key').map(r=>r.source),['assets/in-details.png']);
});
test('HTML comments are stripped from published Markdown but code examples keep them',()=>{
  const source='a <!-- inline --> b\n\n<!-- block ![h](x.png) --> visible after\n\n```html\n<!-- fenced example -->\n```\n\n`<!-- inline example -->`\n\n<details>\n<summary>S</summary>\n<!-- in details -->\n\n```md\n<!-- details example -->\n```\n</details>\n\n<div>\n<!-- unterminated\nhidden</div>\n\nliteral <!-- not a comment';
  const {markdown,removed}=stripHtmlComments(source);
  assert.equal(removed,4);
  for(const hidden of ['inline -->','block','in details','unterminated','hidden</div>'])assert.ok(!markdown.includes(hidden),hidden);
  for(const kept of ['a  b','visible after','<!-- fenced example -->','`<!-- inline example -->`','<!-- details example -->','literal <!-- not a comment'])assert.ok(markdown.includes(kept),kept);
  assert.deepEqual(stripHtmlComments('no comments'),{markdown:'no comments',removed:0});
});
