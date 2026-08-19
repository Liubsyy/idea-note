import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

const DEFAULT_PORT = 11435;
const MODEL_ID = "idea-note-test";
const MAX_BODY_BYTES = 1024 * 1024;
const responsesPath = fileURLToPath(new URL("./responses.json", import.meta.url));

function json(res, status, value) {
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Access-Control-Allow-Origin": "*",
  });
  res.end(JSON.stringify(value));
}

function error(res, status, message) {
  json(res, status, { error: { message, type: "mock_server_error" } });
}

async function readJson(req) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > MAX_BODY_BYTES) throw new Error("请求体不能超过 1 MB");
    chunks.push(chunk);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}");
  } catch {
    throw new Error("请求体不是有效的 JSON");
  }
}

function latestUserText(messages) {
  if (!Array.isArray(messages)) return "";
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (message?.role !== "user") continue;
    if (typeof message.content === "string") return message.content.trim();
    if (Array.isArray(message.content)) {
      return message.content
        .filter((part) => part?.type === "text" && typeof part.text === "string")
        .map((part) => part.text)
        .join("\n")
        .trim();
    }
  }
  return "";
}

export function selectAnswer(input, config) {
  const normalized = input.toLocaleLowerCase();
  const rule = config.rules.find((item) =>
    item.keywords.some((keyword) => normalized.includes(keyword.toLocaleLowerCase())),
  );
  return rule?.answer ?? config.fallback;
}

function completion(answer) {
  return {
    id: `chatcmpl-test-${Date.now()}`,
    object: "chat.completion",
    created: Math.floor(Date.now() / 1000),
    model: MODEL_ID,
    choices: [
      {
        index: 0,
        message: { role: "assistant", content: answer },
        finish_reason: "stop",
      },
    ],
    usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
  };
}

function streamCompletion(res, answer) {
  res.writeHead(200, {
    "Content-Type": "text/event-stream; charset=utf-8",
    "Cache-Control": "no-cache",
    Connection: "keep-alive",
    "Access-Control-Allow-Origin": "*",
  });

  const id = `chatcmpl-test-${Date.now()}`;
  const parts = answer.match(/[\s\S]{1,8}/gu) ?? [answer];
  for (const content of parts) {
    const chunk = {
      id,
      object: "chat.completion.chunk",
      created: Math.floor(Date.now() / 1000),
      model: MODEL_ID,
      choices: [{ index: 0, delta: { content }, finish_reason: null }],
    };
    res.write(`data: ${JSON.stringify(chunk)}\n\n`);
  }
  res.write("data: [DONE]\n\n");
  res.end();
}

export async function createMockAiServer() {
  const config = JSON.parse(await readFile(responsesPath, "utf8"));

  return createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", "http://localhost");

    if (req.method === "OPTIONS") {
      res.writeHead(204, {
        "Access-Control-Allow-Origin": "*",
        "Access-Control-Allow-Headers": "Authorization, Content-Type",
        "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
      });
      res.end();
      return;
    }

    if (req.method === "GET" && url.pathname === "/health") {
      json(res, 200, { status: "ok", service: "idea-note-test-ai" });
      return;
    }

    if (req.method === "GET" && url.pathname === "/v1/models") {
      json(res, 200, {
        object: "list",
        data: [{ id: MODEL_ID, object: "model", owned_by: "idea-note" }],
      });
      return;
    }

    if (req.method === "POST" && url.pathname === "/v1/chat/completions") {
      try {
        const body = await readJson(req);
        const input = latestUserText(body.messages);
        if (!input) {
          error(res, 400, "messages 中缺少用户问题");
          return;
        }
        const answer = selectAnswer(input, config);
        if (body.stream === true) streamCompletion(res, answer);
        else json(res, 200, completion(answer));
      } catch (cause) {
        error(res, 400, cause instanceof Error ? cause.message : String(cause));
      }
      return;
    }

    error(res, 404, "接口不存在");
  });
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const requestedPort = Number.parseInt(process.env.MOCK_AI_PORT ?? "", 10);
  const port = Number.isInteger(requestedPort) && requestedPort > 0 ? requestedPort : DEFAULT_PORT;
  const server = await createMockAiServer();
  server.listen(port, "127.0.0.1", () => {
    console.log(`Idea Note 测试 AI 已启动：http://127.0.0.1:${port}/v1`);
    console.log(`模型 ID：${MODEL_ID}（API Key 可留空）`);
  });
}
