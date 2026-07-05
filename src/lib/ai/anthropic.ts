// Anthropic native Messages API client. Requests go through tauri-plugin-http
// (server-to-server, so no browser CORS / no dangerous-direct-browser header
// needed). `baseUrl` is the host root, e.g. "https://api.anthropic.com".

import { fetch } from "@tauri-apps/plugin-http";
import type { AiModel, ChatMsg, OnTextDelta, ProviderOptions, ProviderReply, ToolCall, ToolDef } from "./types";
import { sseData } from "./sse";

const joinUrl = (base: string, path: string) => base.replace(/\/+$/, "") + path;

/**
 * Ask for a generous reply budget by default. `max_tokens` is mandatory on
 * this API and capped per model; instead of hardcoding each model's cap we
 * parse it out of the "max_tokens: X > Y" 400 error once and retry, so every
 * model runs at its own maximum.
 */
const DEFAULT_MAX_TOKENS = 64000;
const learnedMaxTokens = new Map<string, number>();

/**
 * Convert normalized history to Anthropic message blocks. Consecutive `tool`
 * messages must be folded into a single user message of tool_result blocks,
 * placed right after the assistant message that requested them.
 */
function toMessages(history: ChatMsg[]): unknown[] {
  const out: unknown[] = [];
  let toolResults: unknown[] = [];
  const flush = () => {
    if (toolResults.length) {
      out.push({ role: "user", content: toolResults });
      toolResults = [];
    }
  };

  for (const m of history) {
    if (m.role === "tool") {
      toolResults.push({ type: "tool_result", tool_use_id: m.toolCallId, content: m.result });
      continue;
    }
    flush();
    if (m.role === "user") {
      out.push({ role: "user", content: m.content });
    } else {
      const blocks: unknown[] = [];
      if (m.content) blocks.push({ type: "text", text: m.content });
      for (const tc of m.toolCalls ?? []) {
        blocks.push({ type: "tool_use", id: tc.id, name: tc.name, input: tc.args ?? {} });
      }
      out.push({ role: "assistant", content: blocks });
    }
  }
  flush();
  return out;
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
    system,
    messages: toMessages(history),
    output_config: { effort: options.thinkingLevel },
    stream: true,
  };
  // Omit tools entirely on tool-less calls (e.g. commit-message generation);
  // some compatible gateways reject an empty tools array.
  if (tools.length > 0) {
    body.tools = tools.map((t) => ({ name: t.name, description: t.description, input_schema: t.parameters }));
  }

  const doFetch = (maxTokens: number) =>
    fetch(joinUrl(model.baseUrl, "/v1/messages"), {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "text/event-stream",
        "x-api-key": model.apiKey,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({ ...body, max_tokens: maxTokens }),
      signal: options.signal,
    });

  let res = await doFetch(learnedMaxTokens.get(model.model) ?? DEFAULT_MAX_TOKENS);
  if (res.status === 400) {
    const errText = await res.text();
    const m = /max_tokens:\s*\d+\s*>\s*(\d+)/.exec(errText);
    if (!m) throw new Error(`HTTP 400: ${errText}`);
    learnedMaxTokens.set(model.model, parseInt(m[1], 10));
    res = await doFetch(learnedMaxTokens.get(model.model)!);
  }
  if (!res.ok) throw new Error(`HTTP ${res.status}: ${await res.text()}`);

  let text = "";
  const toolCalls: ToolCall[] = [];
  // The tool_use block currently being streamed (input arrives as JSON text).
  let openTool: { id: string; name: string; json: string } | null = null;

  for await (const data of sseData(res)) {
    const ev = JSON.parse(data) as any;
    switch (ev.type) {
      case "content_block_start":
        if (ev.content_block?.type === "tool_use") {
          openTool = { id: ev.content_block.id, name: ev.content_block.name, json: "" };
        }
        break;
      case "content_block_delta":
        if (ev.delta?.type === "text_delta") {
          text += ev.delta.text;
          onTextDelta(ev.delta.text);
        } else if (ev.delta?.type === "input_json_delta" && openTool) {
          openTool.json += ev.delta.partial_json;
        }
        break;
      case "content_block_stop":
        if (openTool) {
          let args: Record<string, unknown> = {};
          try {
            if (openTool.json) args = JSON.parse(openTool.json);
          } catch {
            /* malformed tool input — send empty args, the tool will report the error */
          }
          toolCalls.push({ id: openTool.id, name: openTool.name, args });
          openTool = null;
        }
        break;
      case "error":
        throw new Error(ev.error?.message ?? "流式响应出错");
    }
  }

  return { text, toolCalls };
}
