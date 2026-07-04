// Minimal SSE reader shared by the AI providers. Reads a streaming Response
// body line by line and yields each `data:` payload string. Stops at the
// OpenAI-style `[DONE]` sentinel. Event names / ids are ignored — both the
// Anthropic and OpenAI streams carry everything we need in the data JSON.

/** Yield each `data:` payload from an SSE response body. */
export async function* sseData(res: Response): AsyncGenerator<string> {
  const body = res.body;
  if (!body) throw new Error("响应没有可读的流式 body");

  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buf = "";

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });

      let nl: number;
      while ((nl = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, nl).replace(/\r$/, "");
        buf = buf.slice(nl + 1);
        if (!line.startsWith("data:")) continue; // blank lines, comments, event:
        const data = line.slice(5).trimStart();
        if (data === "[DONE]") return;
        if (data) yield data;
      }
    }
  } finally {
    reader.releaseLock();
  }
}
