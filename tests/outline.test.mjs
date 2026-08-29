import assert from "node:assert/strict";
import test from "node:test";

import { extractOutline } from "../src/lib/outline.ts";

test("nested shorter fences do not leak code comments into the outline", () => {
  const markdown = [
    "# 可交互组件规范",
    "",
    "````markdown",
    "```python {out=markdown}",
    "# 使用 out=markdown 时，这只是 Python 注释",
    "print('result')",
    "```",
    "````",
    "",
    "## 整体语法",
  ].join("\n");

  assert.deepEqual(extractOutline(markdown), [
    { level: 1, text: "可交互组件规范", line: 0 },
    { level: 2, text: "整体语法", line: 9 },
  ]);
});

test("a fence closes only with the same character and sufficient length", () => {
  const markdown = [
    "# 开始",
    "~~~~markdown",
    "```",
    "# 仍在围栏内",
    "~~~~~",
    "## 结束",
  ].join("\n");

  assert.deepEqual(extractOutline(markdown), [
    { level: 1, text: "开始", line: 0 },
    { level: 2, text: "结束", line: 5 },
  ]);
});

test("a fence-like line with info cannot close an active fence", () => {
  const markdown = [
    "# 开始",
    "````markdown",
    "````python",
    "# 仍在围栏内",
    "````",
    "## 结束",
  ].join("\n");

  assert.deepEqual(extractOutline(markdown), [
    { level: 1, text: "开始", line: 0 },
    { level: 2, text: "结束", line: 5 },
  ]);
});
