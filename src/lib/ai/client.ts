// Provider-agnostic chat driver. Runs the tool-calling loop: ask the model
// (streaming text via SSE), run any requested tools (via the caller's
// `onToolCall`), feed results back, repeat until the model answers without
// tool calls.

import type { AiModel, ChatMsg, ProviderOptions, ToolCall, ToolDef } from "./types";
import * as openai from "./openai";
import * as anthropic from "./anthropic";

export interface RunHooks {
  /** Called with each streamed assistant text fragment. */
  onTextDelta: (delta: string) => void;
  /** Called when one round's assistant text is complete (close the bubble). */
  onTextDone: () => void;
  /** Execute one tool call (apply to editor, handle approval) and return the
   *  result string that gets sent back to the model. */
  onToolCall: (call: ToolCall) => Promise<string>;
}

/** Guard against a model that keeps calling tools forever. */
const MAX_ROUNDS = 20;

/**
 * Drive a full assistant turn. `history` is mutated in place with the new
 * assistant + tool messages so the caller can persist it for multi-turn.
 */
export async function runChat(
  model: AiModel,
  history: ChatMsg[],
  tools: ToolDef[],
  system: string,
  options: ProviderOptions,
  hooks: RunHooks,
): Promise<void> {
  const provider = model.provider === "anthropic" ? anthropic : openai;

  for (let round = 0; round < MAX_ROUNDS; round++) {
    // The signal aborts an in-flight fetch; this check also stops the loop
    // when the user hits stop while a tool (e.g. a pending approval) ran.
    if (options.signal?.aborted) throw new DOMException("已停止", "AbortError");
    const { text, toolCalls } = await provider.send(
      model,
      history,
      tools,
      system,
      options,
      hooks.onTextDelta,
    );
    history.push({
      role: "assistant",
      content: text,
      toolCalls: toolCalls.length ? toolCalls : undefined,
    });
    if (text.trim()) hooks.onTextDone();
    if (!toolCalls.length) return;

    for (const call of toolCalls) {
      // Stop may fire between batched tool calls — skip the rest immediately,
      // or a later destructive call could pop a fresh approval card.
      if (options.signal?.aborted) throw new DOMException("已停止", "AbortError");
      const result = await hooks.onToolCall(call);
      history.push({ role: "tool", toolCallId: call.id, name: call.name, result });
    }
  }

  hooks.onTextDelta("（已达到本轮工具调用次数上限，已停止。）");
  hooks.onTextDone();
}
