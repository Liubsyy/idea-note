// Shared parsing and runner selection; native persistence stays desktop-side.
export * from "../../../share-service/renderer/lib/codeRun/runners.ts";
import { defaultCodeRunConfig, normalize, type CodeRunConfig } from "../../../share-service/renderer/lib/codeRun/runners.ts";
import { invoke } from "@tauri-apps/api/core";

export async function loadCodeRunConfig(): Promise<CodeRunConfig> {
  try {
    const raw = await invoke<string>("code_runners_load");
    return normalize(JSON.parse(raw));
  } catch {
    return defaultCodeRunConfig();
  }
}

export async function saveCodeRunConfig(config: CodeRunConfig): Promise<void> {
  await invoke("code_runners_save", { json: JSON.stringify(config, null, 2) });
}
