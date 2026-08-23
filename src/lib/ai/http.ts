import { fetch as tauriFetch } from "@tauri-apps/plugin-http";

type TauriRequestInit = NonNullable<Parameters<typeof tauriFetch>[1]>;

function requestUrl(input: URL | Request | string): URL | null {
  try {
    return new URL(input instanceof Request ? input.url : input.toString());
  } catch {
    return null;
  }
}

function isLoopback(input: URL | Request | string): boolean {
  const hostname = requestUrl(input)?.hostname.toLowerCase();
  if (!hostname) return false;

  const unbracketed = hostname.replace(/^\[|\]$/g, "");
  return (
    unbracketed === "localhost" ||
    unbracketed.endsWith(".localhost") ||
    unbracketed === "::1" ||
    /^127(?:\.\d{1,3}){3}$/.test(unbracketed)
  );
}

/**
 * Use Tauri's native HTTP client while avoiding its synthetic WebView Origin
 * on loopback calls. In packaged Windows builds that origin is
 * `http://tauri.localhost`, which Ollama rejects with HTTP 403. An explicitly
 * empty Origin is removed by tauri-plugin-http's `unsafe-headers` feature.
 */
export function fetch(
  input: URL | Request | string,
  init?: TauriRequestInit,
): Promise<Response> {
  if (!isLoopback(input)) return tauriFetch(input, init);

  const headers = new Headers(
    init?.headers ?? (input instanceof Request ? input.headers : undefined),
  );
  headers.set("Origin", "");
  return tauriFetch(input, { ...init, headers });
}
