// OpenAI-compatible Chat Completions client (OpenAI, DeepSeek, Kimi, OpenRouter,
// Ollama, …). Requests go through tauri-plugin-http so they bypass the
// WKWebview CORS sandbox. `baseUrl` should include the version segment, e.g.
// "https://api.openai.com/v1".

import { fetch } from "@tauri-apps/plugin-http";
import type { AiModel, ChatMsg, OnTextDelta, ProviderOptions, ProviderReply, ThinkingLevel, ToolCall, ToolDef } from "./types";
import { sseData } from "./sse";

const joinUrl = (base: string, path: string) => base.replace(/\/+$/, "") + path;

function safeParse(s: unknown): Record<string, unknown> {
  if (typeof s !== "string" || !s) return {};
  try {
    return JSON.parse(s);
  } catch {
    return {};
  }
}

function toMessages(system: string, history: ChatMsg[]): unknown[] {
  const out: unknown[] = [{ role: "system", content: system }];
  for (const m of history) {
    if (m.role === "user") {
      out.push({ role: "user", content: m.content });
    } else if (m.role === "assistant") {
      const msg: Record<string, unknown> = { role: "assistant", content: m.content || null };
      if (m.toolCalls?.length) {
        msg.tool_calls = m.toolCalls.map((tc) => ({
          id: tc.id,
          type: "function",
          function: { name: tc.name, arguments: JSON.stringify(tc.args ?? {}) },
        }));
      }
      out.push(msg);
    } else {
      out.push({ role: "tool", tool_call_id: m.toolCallId, content: m.result });
    }
  }
  return out;
}

function reasoningEffort(level: ThinkingLevel): "low" | "medium" | "high" {
  if (level === "low") return "low";
  if (level === "medium") return "medium";
  return "high";
}

export async function send(
  model: AiModel,
  history: ChatMsg[],
  tools: ToolDef[],
  system: string,
  options: ProviderOptions,
  onTextDelta: OnTextDelta,
): Promise<ProviderReply> {
  const body: Record<string, unknown> = {
    model: model.model,
    messages: toMessages(system, history),
    reasoning_effort: reasoningEffort(options.thinkingLevel),
    stream: true,
  };
  // OpenAI rejects an empty tools array — omit it for tool-less calls
  // (e.g. commit-message generation).
  if (tools.length > 0) {
    body.tools = tools.map((t) => ({
      type: "function",
      function: { name: t.name, description: t.description, parameters: t.parameters },
    }));
    body.tool_choice = "auto";
  }

  const res = await fetch(joinUrl(model.baseUrl, "/chat/completions"), {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Accept: "text/event-stream",
      Authorization: `Bearer ${model.apiKey}`,
    },
    body: JSON.stringify(body),
    signal: options.signal,
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}: ${await res.text()}`);

  let text = "";
  // Tool calls accumulate by index: the first chunk carries id/name, the rest
  // append fragments of the function.arguments JSON string.
  const partials: { id: string; name: string; args: string }[] = [];

  for await (const data of sseData(res)) {
    const chunk = JSON.parse(data) as any;
    const delta = chunk?.choices?.[0]?.delta;
    if (!delta) continue;

    if (typeof delta.content === "string" && delta.content) {
      text += delta.content;
      onTextDelta(delta.content);
    }
    for (const tc of delta.tool_calls ?? []) {
      const i = tc.index ?? 0;
      const p = partials[i] ?? (partials[i] = { id: "", name: "", args: "" });
      if (tc.id) p.id = tc.id;
      if (tc.function?.name) p.name = tc.function.name;
      if (tc.function?.arguments) p.args += tc.function.arguments;
    }
  }

  const toolCalls: ToolCall[] = partials
    .filter(Boolean)
    .map((p) => ({ id: p.id, name: p.name, args: safeParse(p.args) }));
  return { text, toolCalls };
}
