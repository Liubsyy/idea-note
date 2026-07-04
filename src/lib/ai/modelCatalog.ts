import { fetch } from "@tauri-apps/plugin-http";
import type { AiProvider } from "./types";

const joinUrl = (base: string, path: string) => base.replace(/\/+$/, "") + path;

function uniqueSorted(ids: string[]): string[] {
  return Array.from(new Set(ids.map((id) => id.trim()).filter(Boolean))).sort((a, b) =>
    a.localeCompare(b),
  );
}

function modelIdsFromResponse(data: unknown): string[] {
  const items = Array.isArray((data as any)?.data) ? (data as any).data : [];
  return uniqueSorted(items.map((item: any) => (typeof item?.id === "string" ? item.id : "")));
}

export async function fetchUpstreamModels({
  provider,
  baseUrl,
  apiKey,
}: {
  provider: AiProvider;
  baseUrl: string;
  apiKey: string;
}): Promise<string[]> {
  const url =
    provider === "anthropic" ? joinUrl(baseUrl, "/v1/models") : joinUrl(baseUrl, "/models");
  const headers: Record<string, string> =
    provider === "anthropic" ? { "anthropic-version": "2023-06-01" } : {};
  if (apiKey) {
    if (provider === "anthropic") headers["x-api-key"] = apiKey;
    else headers.Authorization = `Bearer ${apiKey}`;
  }

  const res = await fetch(url, { method: "GET", headers });
  if (!res.ok) throw new Error(`HTTP ${res.status}: ${await res.text()}`);
  return modelIdsFromResponse(await res.json());
}
