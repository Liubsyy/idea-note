// Read/write the AI model list. The file is owned by Rust (app config dir,
// `ai-models.json`) — this is the only place the frontend touches it, so the
// on-disk format / encryption can change here alone. See `ai_models_load` /
// `ai_models_save` in src-tauri/src/lib.rs.

import { invoke } from "@tauri-apps/api/core";
import type { AiModel, AiProvider } from "./types";

function isProvider(v: unknown): v is AiProvider {
  return v === "openai" || v === "anthropic";
}

function isModel(v: unknown): v is AiModel {
  if (!v || typeof v !== "object") return false;
  const m = v as Record<string, unknown>;
  return (
    typeof m.id === "string" &&
    typeof m.label === "string" &&
    isProvider(m.provider) &&
    typeof m.baseUrl === "string" &&
    typeof m.apiKey === "string" &&
    typeof m.model === "string" &&
    (m.models === undefined ||
      (Array.isArray(m.models) && m.models.every((id) => typeof id === "string")))
  );
}

/** Load and validate the configured models (empty array on any problem). */
export async function loadModels(): Promise<AiModel[]> {
  try {
    const raw = await invoke<string>("ai_models_load");
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.filter(isModel) : [];
  } catch {
    return [];
  }
}

/** Persist the whole model list. */
export async function saveModels(models: AiModel[]): Promise<void> {
  await invoke("ai_models_save", { json: JSON.stringify(models, null, 2) });
}
