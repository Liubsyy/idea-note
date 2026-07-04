import type { AiModel } from "./types";

const SEP = "::";

export function modelIdsOf(model: AiModel): string[] {
  const ids = model.models?.length ? model.models : [model.model];
  return Array.from(new Set(ids.map((id) => id.trim()).filter(Boolean)));
}

export function modelSelectionKey(configId: string, modelId: string): string {
  return `${encodeURIComponent(configId)}${SEP}${encodeURIComponent(modelId)}`;
}

export function modelSelectionLabel(config: AiModel, modelId: string): string {
  return modelIdsOf(config).length === 1 ? config.label : `${config.label} · ${modelId}`;
}

export function firstModelSelection(models: AiModel[]): string | null {
  const first = models[0];
  if (!first) return null;
  const modelId = modelIdsOf(first)[0];
  return modelId ? modelSelectionKey(first.id, modelId) : first.id;
}

export function resolveModelSelection(models: AiModel[], selection: string | null): AiModel | null {
  if (!selection) return null;
  const direct = models.find((m) => m.id === selection);
  if (direct) return { ...direct, model: modelIdsOf(direct)[0] ?? direct.model };

  const [rawConfigId, rawModelId] = selection.split(SEP);
  if (!rawConfigId || !rawModelId) return null;

  let configId = "";
  let modelId = "";
  try {
    configId = decodeURIComponent(rawConfigId);
    modelId = decodeURIComponent(rawModelId);
  } catch {
    return null;
  }

  const config = models.find((m) => m.id === configId);
  if (!config || !modelIdsOf(config).includes(modelId)) return null;
  return { ...config, model: modelId };
}
