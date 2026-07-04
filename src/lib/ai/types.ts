// Shared AI types. The `ChatMsg` / `ToolCall` shapes are a *normalized*
// representation of a conversation that is independent of the provider wire
// format — `openai.ts` and `anthropic.ts` convert to/from their own formats.

export type AiProvider = "openai" | "anthropic";
export type ThinkingLevel = "low" | "medium" | "high" | "xhigh" | "max";

/**
 * A configured model the user can chat with. Persisted (plaintext for now) to
 * `ai-models.json` in the app config dir via the Rust `ai_models_save` command;
 * keep `src/lib/ai/config.ts` the single read/write choke point so the storage
 * can later move to the OS keychain without touching callers.
 */
export interface AiModel {
  id: string;
  /** Display name shown in the picker, e.g. "DeepSeek". */
  label: string;
  provider: AiProvider;
  /** API base, e.g. "https://api.openai.com/v1" or "https://api.anthropic.com". */
  baseUrl: string;
  /** Secret API key (plaintext on disk for now). */
  apiKey: string;
  /** The model id sent to the API, e.g. "gpt-4o" / "claude-sonnet-4-5". */
  model: string;
  /** All model IDs available under this config. `model` is the default/first. */
  models?: string[];
}

/** A model's request for the app to run a tool. `args` is the parsed JSON input. */
export interface ToolCall {
  id: string;
  name: string;
  args: Record<string, unknown>;
}

/** One turn in the normalized conversation history sent to a provider. */
export type ChatMsg =
  | { role: "user"; content: string }
  | { role: "assistant"; content: string; toolCalls?: ToolCall[] }
  | { role: "tool"; toolCallId: string; name: string; result: string };

/** A tool the model may call. `parameters` is a JSON-schema object. */
export interface ToolDef {
  name: string;
  description: string;
  parameters: object;
}

/** The normalized result a provider returns from one request round. */
export interface ProviderReply {
  text: string;
  toolCalls: ToolCall[];
}

/** Called with each streamed assistant text fragment as it arrives. */
export type OnTextDelta = (delta: string) => void;

export interface ProviderOptions {
  thinkingLevel: ThinkingLevel;
  /** Aborts the in-flight HTTP request when the user hits stop. */
  signal?: AbortSignal;
}
