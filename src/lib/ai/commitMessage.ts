// One-shot AI commit-message generation for git sync. Reads the staged diff,
// asks the configured model (no tools, no streaming UI) and returns a cleaned
// single message. AI mode is strict: generation failures abort the sync so the
// user sees the problem instead of silently committing a timestamp fallback.

import type { AiModel, ChatMsg } from "./types";
import * as openai from "./openai";
import * as anthropic from "./anthropic";
import { collectStagedChanges } from "../git";

/** Hard cap so a hung API can't stall an (auto-)sync indefinitely. */
const TIMEOUT_MS = 120_000;

const BASE_PROMPT = `你是笔记应用的 git 提交信息生成器。根据下面的暂存区改动，生成一条简洁的中文提交信息，概括本次对笔记的新增、修改或删除。
要求：
- 只输出提交信息本身，不要任何解释、引号或代码块
- 默认输出一行，不超过 50 字`;

/** Strip code fences / surrounding quotes the model may wrap the message in. */
function cleanMessage(text: string): string {
  let s = text.trim();
  s = s.replace(/^```[^\n]*\n?/, "").replace(/\n?```$/, "").trim();
  if (/^["'“「『]/.test(s) && /["'”」』]$/.test(s)) s = s.slice(1, -1).trim();
  // Safety cap: git subjects/bodies beyond this are almost certainly rambling.
  return s.length > 500 ? s.slice(0, 500) : s;
}

/**
 * Generate a commit message from the currently staged changes. `convention`
 * is the user's natural-language commit spec (设置 → 远程同步 → 提交规范),
 * appended to the prompt verbatim; empty means "just summarize".
 */
export async function generateCommitMessage(
  model: AiModel,
  dir: string,
  convention: string,
): Promise<string> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const { stat, diff } = await collectStagedChanges(dir);
    if (!stat && !diff.trim()) throw new Error("暂存区没有可用于生成提交文案的改动");

    const spec = convention.trim();
    const system = spec
      ? `${BASE_PROMPT}\n\n用户的提交规范（优先于以上默认格式，严格遵守）：\n${spec}`
      : BASE_PROMPT;
    const history: ChatMsg[] = [
      { role: "user", content: `变更概览：\n${stat}\n\n变更内容：\n${diff}` },
    ];

    const provider = model.provider === "anthropic" ? anthropic : openai;
    const { text } = await provider.send(
      model,
      history,
      [],
      system,
      { thinkingLevel: "low", signal: controller.signal },
      () => {},
    );
    const message = cleanMessage(text);
    if (!message) throw new Error("模型返回了空的提交文案");
    return message;
  } catch (cause) {
    if (controller.signal.aborted) {
      throw new Error(`AI 提交文案生成超时（${TIMEOUT_MS / 1000} 秒）`);
    }
    const detail = cause instanceof Error ? cause.message : String(cause);
    throw new Error(`AI 提交文案生成失败：${detail}`);
  } finally {
    clearTimeout(timer);
  }
}
