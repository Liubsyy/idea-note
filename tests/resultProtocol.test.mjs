import assert from "node:assert/strict";
import test from "node:test";

import { parseComponentOutput } from "../src/lib/codeRun/resultProtocol.ts";

test("explicit out uses the last non-empty stdout line as bare JSON data", () => {
  assert.deepEqual(
    parseComponentOutput('开始计算\n"graph TD; A --> B"\n', "mermaid"),
    {
      result: { type: "mermaid", data: "graph TD; A --> B" },
      error: null,
    },
  );
});

test("explicit json accepts every JSON value", () => {
  for (const [raw, data] of [
    ["null", null],
    ["true", true],
    ["42", 42],
    ['"text"', "text"],
    ['[1,"two"]', [1, "two"]],
    ['{"ok":true}', { ok: true }],
  ]) {
    assert.deepEqual(parseComponentOutput(raw, "json"), {
      result: { type: "json", data },
      error: null,
    });
  }
});

test("self-describing output ignores logs and ordinary JSON", () => {
  const stdout = [
    "开始",
    '{"log":true}',
    '{"idea_note_result":{"type":"text","data":"完成"}}',
  ].join("\n");
  assert.deepEqual(parseComponentOutput(stdout, null), {
    result: { type: "text", data: "完成" },
    error: null,
  });
});

test("the last self-describing result wins", () => {
  const stdout = [
    '{"idea_note_result":{"type":"text","data":"旧"}}',
    "日志",
    '{"idea_note_result":{"type":"markdown","data":"**新**"}}',
  ].join("\n");
  assert.deepEqual(parseComponentOutput(stdout, null), {
    result: { type: "markdown", data: "**新**" },
    error: null,
  });
});

test("a bare block without an envelope stays ordinary output", () => {
  assert.deepEqual(parseComponentOutput('日志\n{"ok":true}', null), {
    result: null,
    error: null,
  });
  assert.deepEqual(parseComponentOutput("::out mermaid\ngraph TD", null), {
    result: null,
    error: null,
  });
});

test("text-like component types require strings", () => {
  for (const type of ["text", "markdown", "html", "mermaid"]) {
    const parsed = parseComponentOutput("{}", type);
    assert.equal(parsed.result, null);
    assert.match(parsed.error, /必须是 JSON 字符串/);
  }
});

test("table requires matching columns and JSON rows", () => {
  const valid = '{"columns":["姓名","分数"],"rows":[["张三",95],["李四",88]]}';
  assert.deepEqual(parseComponentOutput(valid, "table"), {
    result: {
      type: "table",
      data: {
        columns: ["姓名", "分数"],
        rows: [["张三", 95], ["李四", 88]],
      },
    },
    error: null,
  });
  assert.match(
    parseComponentOutput('{"columns":["a","b"],"rows":[[1]]}', "table")
      .error,
    /等长/,
  );
});

test("image accepts one path or a non-empty path array", () => {
  assert.deepEqual(parseComponentOutput('"./chart.png"', "image"), {
    result: { type: "image", data: "./chart.png" },
    error: null,
  });
  assert.deepEqual(parseComponentOutput('["a.png","b.png"]', "image"), {
    result: { type: "image", data: ["a.png", "b.png"] },
    error: null,
  });
  assert.match(parseComponentOutput("[]", "image").error, /非空路径/);
});

test("invalid JSON and invalid envelopes report protocol errors", () => {
  assert.match(parseComponentOutput("not-json", "text").error, /不是合法/);
  assert.match(
    parseComponentOutput('{"idea_note_result":null}', null).error,
    /必须是包含 type 和 data 的对象/,
  );
  assert.match(
    parseComponentOutput(
      '{"idea_note_result":{"type":"chart","data":{}}}',
      null,
    ).error,
    /不支持的组件类型/,
  );
  assert.match(
    parseComponentOutput('{"idea_note_result":{"type":"text"}}', null).error,
    /缺少 data/,
  );
});
