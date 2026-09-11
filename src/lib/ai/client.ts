// Provider-agnostic chat driver. Runs the tool-calling loop: ask the model
// (streaming text via SSE), run any requested tools (via the caller's
// `onToolCall`), feed results back, repeat until the model answers without
// tool calls.

import type { AiModel, ChatMsg, ProviderOptions, ToolCall, ToolDef } from "./types";
import * as openai from "./openai";
import * as anthropic from "./anthropic";
import { abortable, throwIfAborted } from "./cancellation";

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
    throwIfAborted(options.signal);
    const { text, toolCalls } = await abortable(options.signal, () => provider.send(
      model,
      history,
      tools,
      system,
      options,
      (delta) => { if (!options.signal?.aborted) hooks.onTextDelta(delta); },
    ));
    throwIfAborted(options.signal);
    history.push({
      role: "assistant",
      content: text,
      toolCalls: toolCalls.length ? toolCalls : undefined,
    });
    if (text.trim()) hooks.onTextDone();
    if (!toolCalls.length) {
      throwIfAborted(options.signal);
      return;
    }

    let completed = 0;
    try {
      for (const call of toolCalls) {
        throwIfAborted(options.signal);
        const result = await abortable(options.signal, () => hooks.onToolCall(call));
        throwIfAborted(options.signal);
        history.push({ role: "tool", toolCallId: call.id, name: call.name, result });
        completed++;
      }
    } catch (error) {
      // Every advertised tool call needs a result before the next user turn.
      // Preserve completed tools and close the interrupted/unstarted calls;
      // never claim that an in-flight write was rolled back by cancellation.
      for (const call of toolCalls.slice(completed)) {
        history.push({
          role: "tool", toolCallId: call.id, name: call.name,
          result: options.signal?.aborted
            ? "用户已停止本轮操作。未返回执行结果；已发生的修改不会自动撤销，请重新确认状态。"
            : "本轮工具执行中断，未获得执行结果。",
        });
      }
      throw error;
    }
  }

  hooks.onTextDelta("（已达到本轮工具调用次数上限，已停止。）");
  hooks.onTextDone();
}
