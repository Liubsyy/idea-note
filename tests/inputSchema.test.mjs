import assert from "node:assert/strict";
import test from "node:test";

import { coerce, literalOf, parseInputBlock } from "../src/lib/inputs/schema.ts";

/** Parse one field line, asserting the block had no errors. */
const field = (line) => {
  const schema = parseInputBlock(line);
  assert.deepEqual(schema.errors, []);
  assert.equal(schema.fields.length, 1);
  return schema.fields[0];
};

const errorOf = (line) => {
  const schema = parseInputBlock(line);
  assert.equal(schema.fields.length, 0, "expected the line to be rejected");
  return schema.errors[0].message;
};

test("date / time / datetime keep their literal as the value", () => {
  assert.equal(field('start: date = "2026-01-01"').value, "2026-01-01");
  assert.equal(field("start: date = 2026-01-01").value, "2026-01-01");
  assert.equal(field('alarm: time = "09:30"').value, "09:30");
  assert.equal(field('alarm: time = "09:30:15"').value, "09:30:15");
  assert.equal(
    field('due: datetime = "2026-01-31T18:00"').value,
    "2026-01-31T18:00",
  );
});

test("a datetime written with a space is normalized to T", () => {
  assert.equal(field('due: datetime = "2026-01-31 18:00"').value, "2026-01-31T18:00");
});

test("no default means an empty picker", () => {
  assert.equal(field("start: date").value, "");
  assert.equal(field("due: datetime").value, "");
});

test("impossible moments are line errors, not silent fallbacks", () => {
  assert.match(errorOf("start: date = 2026-13-01"), /不是合法的日期，应形如 2026-01-31/);
  assert.match(errorOf("start: date = 2026-02-30"), /不是合法的日期，应形如 2026-01-31/);
  assert.match(errorOf("start: date = 2026-1-1"), /不是合法的日期，应形如 2026-01-31/);
  assert.match(errorOf("alarm: time = 25:00"), /不是合法的时间，应形如 09:30/);
  assert.match(errorOf("alarm: time = 09:70"), /不是合法的时间，应形如 09:30/);
  assert.match(errorOf("due: datetime = 2026-01-31"), /不是合法的日期时间/);
});

test("a bad line only skips itself", () => {
  const schema = parseInputBlock(
    ["start: date = 2026-13-01", 'end: date = "2026-03-31"'].join("\n"),
  );
  assert.equal(schema.errors.length, 1);
  assert.deepEqual(
    schema.fields.map((f) => f.name),
    ["end"],
  );
});

test("min / max take a date literal, step stays numeric", () => {
  const f = field('end: date = "2026-03-31" {min: 2026-01-01, max: 2026-12-31}');
  assert.equal(f.min, "2026-01-01");
  assert.equal(f.max, "2026-12-31");
  assert.equal(field('alarm: time = "09:30" {step: 1800}').step, 1800);
  // A bound that isn't a real date is treated as if it were never written.
  assert.equal(field('end: date = "2026-03-31" {min: 2026-02-30}').min, null);
});

test("date and friends are never inferred", () => {
  assert.equal(field("start = 2026-01-01").type, "text");
  assert.equal(field("start: date = 2026-01-01").type, "date");
});

test("coerce accepts an empty picker and rejects nonsense", () => {
  const f = field('start: date = "2026-01-01"');
  assert.equal(coerce(f, "2026-06-15"), "2026-06-15");
  assert.equal(coerce(f, ""), "");
  assert.equal(coerce(f, "not-a-date"), "2026-01-01");
});

test("固化为默认值 writes a quoted literal back", () => {
  const f = field('start: date = "2026-01-01"');
  assert.equal(literalOf(f, "2026-06-15"), '"2026-06-15"');
});

test("the existing types still parse", () => {
  assert.equal(field("amount: number = 100 {min: 0, max: 50}").value, 50);
  assert.equal(field("enabled = true").type, "bool");
  assert.equal(field("years: select = [10, 20, 30] {default: 30}").value, 30);
  assert.equal(field('data: file = "./x.csv" {as: csv}').as, "csv");
});
