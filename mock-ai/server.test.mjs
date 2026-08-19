import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { createMockAiServer, selectAnswer } from "./server.mjs";

let server;
let baseUrl;

before(async () => {
  server = await createMockAiServer();
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  baseUrl = `http://127.0.0.1:${address.port}`;
});

after(async () => {
  await new Promise((resolve, reject) =>
    server.close((cause) => (cause ? reject(cause) : resolve())),
  );
});

test("按关键词选择固定回答", () => {
  const config = {
    rules: [{ keywords: ["你好"], answer: "固定回答" }],
    fallback: "默认回答",
  };
  assert.equal(selectAnswer("你好呀", config), "固定回答");
  assert.equal(selectAnswer("未知问题", config), "默认回答");
});

test("返回模型列表", async () => {
  const response = await fetch(`${baseUrl}/v1/models`);
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.data[0].id, "idea-note-test");
});

test("返回普通聊天结果", async () => {
  const response = await fetch(`${baseUrl}/v1/chat/completions`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      model: "idea-note-test",
      messages: [{ role: "user", content: "请总结这篇笔记" }],
    }),
  });
  const body = await response.json();
  assert.match(body.choices[0].message.content, /项目目标/);
});

test("返回 OpenAI 兼容的流式聊天结果", async () => {
  const response = await fetch(`${baseUrl}/v1/chat/completions`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      model: "idea-note-test",
      messages: [{ role: "user", content: "下一步做什么" }],
      stream: true,
    }),
  });
  assert.match(response.headers.get("content-type"), /text\/event-stream/);
  const text = await response.text();
  assert.match(text, /建议的下一步/);
  assert.match(text, /data: \[DONE\]/);
});
