import assert from 'node:assert/strict';
import test from 'node:test';
import { parseAllDocuments } from 'yaml';
import { formatStructured } from '../src/lib/structuredPreview.ts';
import { filePreviewKind } from '../src/lib/filePreview.ts';

function formatted(source, kind) {
  const result = formatStructured(source, kind);
  assert.equal(result.error, null);
  assert.notEqual(result.text, null);
  return result.text;
}
test('file types remain case insensitive', () => {
  for (const [path, kind] of [['a.HTM','html'], ['a.JSON','json'], ['a.YML','yaml'], ['a.yaml','yaml'], ['a.SVG','svg'], ['a.md',null], ['a.png',null]])
    assert.equal(filePreviewKind(path), kind);
});
test('JSON changes only whitespace and retains exact numeric/string lexemes and duplicate keys', () => {
  const source = '{"big":900719925474099312345,"decimal":1.234567890123456789,"zero":-0,"exp":1e999,"escaped":"\\u4f60","same":1,"same":2}';
  const output = formatted(source, 'json');
  assert.ok(output.includes('\n  "big":'));
  assert.equal(output.replace(/\s/g, ''), source);
  assert.equal(formatted(output, 'json'), output);
  for (const scalar of ['false','null','"hello"','[]','{}']) assert.equal(formatted(scalar, 'json'), scalar);
});
test('invalid JSON never produces replacement text and reports location', () => {
  for (const source of ['', '{"x":1,}', '// comment\n{}', '[1,,2]']) {
    assert.equal(formatStructured(source,'json').text, null);
    assert.ok(formatStructured(source,'json').error);
  }
  assert.match(formatStructured('{\n"a":\n}', 'json').error, /第 3 行/);
});
test('YAML retains comments, aliases, tags, multi-documents and numeric precision', () => {
  const source = '# comment\nroot: &root\n    self: *root\n    n: 900719925474099312345\n    decimal: 1.234567890123456789\n    zero: -0\n    tag: !custom hello\n---\n- yes\n- null\n';
  const output = formatted(source,'yaml');
  for (const token of ['# comment','&root','*root','900719925474099312345','1.234567890123456789','-0','!custom hello','---']) assert.ok(output.includes(token),token);
  assert.equal(parseAllDocuments(output).length,2);
  assert.equal(formatted(output,'yaml'),output);
});
test('YAML rejects errors and preserves empty/comment-only documents', () => {
  for (const source of ['a: [','a: 1\na: 2','a: *missing']) {
    assert.equal(formatStructured(source,'yaml').text,null);
    assert.ok(formatStructured(source,'yaml').error);
  }
  for (const source of ['', '# just a comment\n', '  \n']) assert.equal(formatted(source,'yaml'),source);
});
test('YAML preserves block string contents and document directives', () => {
  const source = '%YAML 1.1\n---\nx: yes\nmessage: |+\n  hello\n\n---\nx: no\n';
  const output = formatted(source,'yaml');
  assert.deepEqual(parseAllDocuments(output).map(d=>d.toJS()), parseAllDocuments(source).map(d=>d.toJS()));
});
test('formatters preserve CRLF and handle large documents', () => {
  for(const kind of ['json','yaml']) {
    const output=formatted(kind==='json' ? '{\r\n"x":1}' : 'x:   1\r\n', kind);
    assert.ok(output.includes('\r\n'));
    assert.ok(!/(?<!\r)\n/.test(output));
  }
  const source=`[${Array.from({length:10000},(_,i)=>i).join(',')}]`;
  assert.deepEqual(JSON.parse(formatted(source,'json')),JSON.parse(source));
});
