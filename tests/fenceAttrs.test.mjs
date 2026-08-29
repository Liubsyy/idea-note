import assert from "node:assert/strict";
import test from "node:test";

import {
  isCloseFenceFor,
  openingFenceOf,
} from "../src/lib/codeRun/fenceAttrs.ts";

test("a shorter nested fence does not close an outer documentation fence", () => {
  const outer = openingFenceOf("````markdown");
  assert.deepEqual(outer, { char: "`", length: 4, info: "markdown" });
  assert.equal(isCloseFenceFor("```input {id=params}", outer), false);
  assert.equal(isCloseFenceFor("```", outer), false);
  assert.equal(isCloseFenceFor("````", outer), true);
  assert.equal(isCloseFenceFor("`````", outer), true);
});

test("a fence closes only with the same marker character", () => {
  const outer = openingFenceOf("~~~~markdown");
  assert.ok(outer);
  assert.equal(isCloseFenceFor("~~~~", outer), true);
  assert.equal(isCloseFenceFor("````", outer), false);
});
