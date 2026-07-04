import { useEffect, useRef, useState } from "react";
import { useAppStore } from "../store/useAppStore";

/**
 * App-level text-input dialog used for naming files/folders and renaming.
 * Replaces window.prompt, which Tauri's WKWebView does not implement.
 */
export function PromptModal() {
  const prompt = useAppStore((s) => s.prompt);
  const closePrompt = useAppStore((s) => s.closePrompt);

  const [value, setValue] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (!prompt) return;
    setValue(prompt.defaultValue);
    setError(null);
    setBusy(false);
    // Focus and select after the input has mounted.
    const id = requestAnimationFrame(() => {
      inputRef.current?.focus();
      inputRef.current?.select();
    });
    return () => cancelAnimationFrame(id);
  }, [prompt]);

  if (!prompt) return null;

  const submit = async () => {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      await prompt.onSubmit(value);
      closePrompt();
    } catch (e) {
      setError(typeof e === "string" ? e : (e as Error)?.message ?? "操作失败");
      setBusy(false);
    }
  };

  return (
    <div
      className="fixed inset-0 z-[60] flex items-start justify-center"
      style={{ background: "rgba(0,0,0,0.35)" }}
      onMouseDown={closePrompt}
    >
      <div
        className="mt-32 w-80 rounded-xl p-4"
        style={{
          background: "var(--bg-elev)",
          border: "1px solid var(--border)",
          boxShadow: "0 12px 40px var(--shadow)",
        }}
        onMouseDown={(e) => e.stopPropagation()}
      >
        <div
          className="mb-3 text-sm font-semibold"
          style={{ color: "var(--text)" }}
        >
          {prompt.title}
        </div>
        <input
          ref={inputRef}
          value={value}
          onChange={(e) => setValue(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              e.preventDefault();
              submit();
            } else if (e.key === "Escape") {
              e.preventDefault();
              closePrompt();
            }
          }}
          className="w-full rounded-md px-2.5 py-1.5 text-sm outline-none"
          style={{
            background: "var(--bg)",
            border: `1px solid ${error ? "#e5484d" : "var(--border)"}`,
            color: "var(--text)",
          }}
        />
        {error && (
          <div className="mt-1.5 text-xs" style={{ color: "#e5484d" }}>
            {error}
          </div>
        )}
        <div className="mt-4 flex justify-end gap-2">
          <button
            onClick={closePrompt}
            className="rounded-md px-3 py-1.5 text-sm transition-colors"
            style={{ color: "var(--text-muted)" }}
          >
            取消
          </button>
          <button
            onClick={submit}
            disabled={busy}
            className="rounded-md px-3 py-1.5 text-sm font-medium text-white transition-opacity"
            style={{ background: "var(--accent)", opacity: busy ? 0.6 : 1 }}
          >
            确定
          </button>
        </div>
      </div>
    </div>
  );
}
