import { fetch as tauriFetch } from "@tauri-apps/plugin-http";

type TauriRequestInit = NonNullable<Parameters<typeof tauriFetch>[1]>;

/**
 * Use Tauri's native HTTP client as a server-to-server AI client. The plugin
 * otherwise adds the WebView's synthetic `http://tauri.localhost` Origin in
 * packaged Windows builds; Ollama rejects it with HTTP 403 even when Ollama is
 * exposed through a remote reverse proxy. An explicitly empty Origin is
 * removed by tauri-plugin-http's `unsafe-headers` feature.
 */
export function fetch(
  input: URL | Request | string,
  init?: TauriRequestInit,
): Promise<Response> {
  const headers = new Headers(
    init?.headers ?? (input instanceof Request ? input.headers : undefined),
  );
  headers.set("Origin", "");
  return tauriFetch(input, { ...init, headers });
}
