import assert from "node:assert/strict";
import test from "node:test";

import {
  canonicalAad,
  docFromString,
  formatInlineSecret,
  formatSecretAttrs,
  formatSecretBlock,
  newBlockId,
  parseSecretAttrs,
  scanSecretBlocks,
  scanSecrets,
  wrapBody,
} from "../src/lib/crypto/secretBlock.ts";

/* ------------------------------ attributes ------------------------------ */

test("parses the canonical fence", () => {
  assert.deepEqual(parseSecretAttrs("secret {v=1, key=k1, id=b9f3a2c}"), {
    v: 1,
    keyId: "k1",
    id: "b9f3a2c",
    extras: [],
  });
});

test("attribute order and spacing do not change the AAD", () => {
  const tight = parseSecretAttrs("secret {v=1,key=k1,id=b9f3a2c}");
  const loose = parseSecretAttrs("secret {  id = b9f3a2c ,  key = k1 ,  v = 1  }");
  assert.equal(canonicalAad(tight), "v=1|key=k1|id=b9f3a2c");
  assert.equal(canonicalAad(loose), canonicalAad(tight));
});

test("unknown attributes are preserved, not dropped", () => {
  // A newer build may add display-only attributes. Re-encrypting a block must
  // not silently delete them — but they are not authenticated either.
  const meta = parseSecretAttrs("secret {v=1, key=k1, id=b9f3a2c, hint=银行卡}");
  assert.deepEqual(meta.extras, ["hint=银行卡"]);
  assert.equal(canonicalAad(meta), "v=1|key=k1|id=b9f3a2c");
  assert.equal(
    formatSecretAttrs(meta),
    "secret {v=1, key=k1, id=b9f3a2c, hint=银行卡}",
  );
});

test("rejects anything that would make the AAD ambiguous", () => {
  const bad = [
    "secret {key=k1, id=b9f3a2c}", // no v
    "secret {v=1, id=b9f3a2c}", // no key
    "secret {v=1, key=k1}", // no id
    "secret {v=1, v=2, key=k1, id=b9f3a2c}", // duplicate
    "secret {v=1, key=k1, id=b9f3a2c", // unterminated
    "secret {v=1, key=k1, id=b9f3a2c} extra", // trailing junk
    "secret {v=1, key=k1, id=b9f3a2c, watch}", // bare flag
    "secret {v=x, key=k1, id=b9f3a2c}", // non-numeric version
    "secret {v=0, key=k1, id=b9f3a2c}", // versions start at 1
    "secret {v=1, key=k 1, id=b9f3a2c}", // space in an ident
    "secret {v=1, key=k1, id=9f3a2c}", // ids must start with a letter
    "secret", // no attributes at all
    "python {v=1, key=k1, id=b9f3a2c}", // not a secret fence
  ];
  for (const info of bad) {
    assert.equal(parseSecretAttrs(info), null, info);
  }
});

test("a higher format version parses but is reported as-is", () => {
  // Parsing must not reject v=2 outright: the caller decides it cannot handle
  // the version and leaves the block untouched, rather than treating a future
  // note as corrupt.
  assert.equal(parseSecretAttrs("secret {v=2, key=k1, id=b9f3a2c}").v, 2);
});

/* --------------------------------- body --------------------------------- */

test("wraps and re-flattens ciphertext without changing it", () => {
  const body = "A".repeat(250);
  const wrapped = wrapBody(body);
  assert.deepEqual(
    wrapped.split("\n").map((l) => l.length),
    [96, 96, 58],
  );
  assert.equal(wrapped.replace(/\n/g, ""), body);
  // Re-wrapping an already-wrapped body is idempotent.
  assert.equal(wrapBody(wrapped), wrapped);
});

test("formats a complete block", () => {
  const meta = { v: 1, keyId: "k1", id: "b9f3a2c", extras: [] };
  assert.equal(
    formatSecretBlock(meta, "AAAA"),
    "```secret {v=1, key=k1, id=b9f3a2c}\nAAAA\n```",
  );
});

/* -------------------------------- scanning ------------------------------ */

test("finds blocks and hands back their exact body range", () => {
  const text = [
    "# 标题",
    "",
    "```secret {v=1, key=k1, id=b9f3a2c}",
    "QUJD",
    "REVG",
    "```",
    "",
    "尾巴",
  ].join("\n");
  const doc = docFromString(text);
  const blocks = scanSecretBlocks(doc);
  assert.equal(blocks.length, 1);
  assert.equal(blocks[0].body, "QUJD\nREVG");
  assert.equal(text.slice(blocks[0].bodyFrom, blocks[0].bodyTo), "QUJD\nREVG");
  assert.equal(
    text.slice(blocks[0].from, blocks[0].to),
    "```secret {v=1, key=k1, id=b9f3a2c}\nQUJD\nREVG\n```",
  );
});

test("a secret fence nested in a longer fence is not a block", () => {
  // The documentation fence owns everything up to its own closer, exactly as
  // scanInputBlocks treats it.
  const doc = docFromString(
    [
      "````markdown",
      "```secret {v=1, key=k1, id=b9f3a2c}",
      "QUJD",
      "```",
      "````",
    ].join("\n"),
  );
  assert.deepEqual(scanSecretBlocks(doc), []);
});

test("an unreadable fence is reported, never skipped", () => {
  // The block still has to be found so the editor can show "damaged" and leave
  // the bytes alone; dropping it here is how a note gets silently rewritten.
  const doc = docFromString(["```secret {v=1, key=k1}", "QUJD", "```"].join("\n"));
  const blocks = scanSecretBlocks(doc);
  assert.equal(blocks.length, 1);
  assert.equal(blocks[0].meta, null);
  assert.equal(blocks[0].body, "QUJD");
});

test("handles an empty block and a tilde fence", () => {
  const empty = scanSecretBlocks(
    docFromString(["```secret {v=1, key=k1, id=b9f3a2c}", "```"].join("\n")),
  );
  assert.equal(empty.length, 1);
  assert.equal(empty[0].body, "");

  const tilde = scanSecretBlocks(
    docFromString(["~~~secret {v=1, key=k1, id=b9f3a2c}", "QUJD", "~~~"].join("\n")),
  );
  assert.equal(tilde.length, 1);
  assert.equal(tilde[0].body, "QUJD");
});

test("an unclosed block still ends at the last line", () => {
  const doc = docFromString(["```secret {v=1, key=k1, id=b9f3a2c}", "QUJD"].join("\n"));
  const blocks = scanSecretBlocks(doc);
  assert.equal(blocks.length, 1);
  assert.equal(blocks[0].body, "QUJD");
});

test("scans several blocks in one note", () => {
  const doc = docFromString(
    [
      "```secret {v=1, key=k1, id=baaa111}",
      "QQ",
      "```",
      "中间",
      "```python",
      "print('secret')",
      "```",
      "```secret {v=1, key=k2, id=bbbb222}",
      "Ug",
      "```",
    ].join("\n"),
  );
  const blocks = scanSecretBlocks(doc);
  assert.deepEqual(
    blocks.map((b) => b.meta.id),
    ["baaa111", "bbbb222"],
  );
  assert.deepEqual(
    blocks.map((b) => b.meta.keyId),
    ["k1", "k2"],
  );
});

/* --------------------------------- ids ---------------------------------- */

test("generated ids satisfy the fence-attribute ident rule", () => {
  for (let i = 0; i < 200; i++) {
    const id = newBlockId();
    assert.match(id, /^b[0-9a-f]{16}$/);
    assert.equal(parseSecretAttrs(`secret {v=1, key=k1, id=${id}}`).id, id);
  }
});

/* ------------------------------ inline spans ---------------------------- */

test("an inline span round-trips through the same attribute parser", () => {
  const meta = { v: 1, keyId: "k1", id: "b7c1f2a", extras: [] };
  const span = formatInlineSecret(meta, "sT3nQ_-Ab");
  assert.equal(span, "`secret {v=1, key=k1, id=b7c1f2a} sT3nQ_-Ab`");
  const [found] = scanSecrets(docFromString(span));
  assert.equal(found.kind, "inline");
  assert.deepEqual(found.meta, meta);
  assert.equal(found.body, "sT3nQ_-Ab");
});

test("the two shapes produce the same AAD", () => {
  // Same key, same block id, same payload: an inline span and a fenced block
  // are one format in two presentations, so moving ciphertext between them is
  // a text edit rather than a re-encryption.
  const meta = { v: 1, keyId: "k1", id: "b7c1f2a", extras: [] };
  const inline = scanSecrets(docFromString(formatInlineSecret(meta, "QUJD")))[0];
  const block = scanSecrets(docFromString(formatSecretBlock(meta, "QUJD")))[0];
  assert.equal(canonicalAad(inline.meta), canonicalAad(block.meta));
});

test("inline ciphertext is never wrapped", () => {
  const body = "A".repeat(400);
  const span = formatInlineSecret(
    { v: 1, keyId: "k1", id: "b7c1f2a", extras: [] },
    body,
  );
  assert.equal(span.includes("\n"), false);
  assert.equal(scanSecrets(docFromString(span))[0].body, body);
});

test("finds several spans on one line with exact ranges", () => {
  const text =
    "卡号 `secret {v=1, key=k1, id=baaa111} QQ` 与密码 `secret {v=1, key=k2, id=bbbb222} Ug` 完。";
  const found = scanSecrets(docFromString(text));
  assert.deepEqual(
    found.map((s) => s.meta.id),
    ["baaa111", "bbbb222"],
  );
  for (const span of found) {
    assert.equal(text.slice(span.bodyFrom, span.bodyTo), span.body);
    assert.equal(
      text.slice(span.from, span.to),
      formatInlineSecret(span.meta, span.body),
    );
  }
});

test("blocks and spans come back in document order", () => {
  const doc = docFromString(
    [
      "前 `secret {v=1, key=k1, id=baaa111} QQ` 中",
      "```secret {v=1, key=k1, id=bbbb222}",
      "Ug",
      "```",
      "后 `secret {v=1, key=k1, id=bccc333} Vw`",
    ].join("\n"),
  );
  assert.deepEqual(
    scanSecrets(doc).map((s) => [s.kind, s.meta.id]),
    [
      ["inline", "baaa111"],
      ["block", "bbbb222"],
      ["inline", "bccc333"],
    ],
  );
  // The block-only view is unchanged for every existing caller.
  assert.deepEqual(
    scanSecretBlocks(doc).map((b) => b.meta.id),
    ["bbbb222"],
  );
});

test("a span written inside a fence is an example, not a secret", () => {
  // Same protection the block scanner already gives a nested ```secret: the
  // fence owns its lines, so documentation about the format is just text.
  const doc = docFromString(
    [
      "```markdown",
      "`secret {v=1, key=k1, id=baaa111} QQ`",
      "```",
      "```secret {v=1, key=k1, id=bbbb222}",
      "`secret {v=1, key=k1, id=bccc333} Ug`",
      "```",
    ].join("\n"),
  );
  assert.deepEqual(
    scanSecrets(doc).map((s) => [s.kind, s.meta.id]),
    [["block", "bbbb222"]],
  );
});

test("a double-backtick span is left alone", () => {
  // ``…`` is delimited by two backticks, so a single-backtick match inside one
  // is a slice of something larger — treating it as a secret would replace
  // text the user wrote as literal source.
  const doc = docFromString("``secret {v=1, key=k1, id=baaa111} QQ``");
  assert.deepEqual(scanSecrets(doc), []);
});

test("malformed spans stay ordinary inline code", () => {
  const bad = [
    "`secret {v=1, key=k1} QQ`", // no id
    "`secret {v=1, key=k1, id=9aaa111} QQ`", // id must start with a letter
    "`secret {v=1, key=k1, id=baaa111} QQ+/=`", // not base64url
    "`secret {v=1, key=k1, id=baaa111}`", // no body
    "`secret {v=1, key=k1, id=baaa111} QQ", // unterminated span
    "`python {v=1, key=k1, id=baaa111} QQ`", // not a secret
  ];
  for (const text of bad) {
    assert.deepEqual(scanSecrets(docFromString(text)), [], text);
  }
});

test("unknown attributes survive an inline round-trip", () => {
  const doc = docFromString("`secret {v=1, key=k1, id=baaa111, hint=卡} QQ`");
  const [found] = scanSecrets(doc);
  assert.deepEqual(found.meta.extras, ["hint=卡"]);
  assert.equal(
    formatInlineSecret(found.meta, found.body),
    "`secret {v=1, key=k1, id=baaa111, hint=卡} QQ`",
  );
});
