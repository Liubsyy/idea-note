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
  const [values, setValues] = useState<Record<string, string>>({});
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [actionBusy, setActionBusy] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (!prompt) return;
    setValue(prompt.defaultValue);
    setValues(
      Object.fromEntries(
        (prompt.fields ?? []).map((field) => [
          field.name,
          field.defaultValue,
        ]),
      ),
    );
    setError(null);
    setBusy(false);
    setActionBusy(null);
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
      await prompt.onSubmit(value, values);
      closePrompt();
    } catch (e) {
      setError(typeof e === "string" ? e : (e as Error)?.message ?? "操作失败");
      setBusy(false);
    }
  };

  const runFieldAction = async (
    field: NonNullable<typeof prompt.fields>[number],
  ) => {
    if (!field.onAction || actionBusy) return;
    setActionBusy(field.name);
    setError(null);
    try {
      const nextValue = await field.onAction();
      if (nextValue) {
        setValues((prev) => ({
          ...prev,
          [field.name]: nextValue,
        }));
      }
    } catch (e) {
      setError(typeof e === "string" ? e : (e as Error)?.message ?? "操作失败");
    } finally {
      setActionBusy(null);
    }
  };

  return (
    <div
      className="fixed inset-0 z-[60] flex items-start justify-center"
      style={{ background: "rgba(0,0,0,0.35)" }}
      onMouseDown={closePrompt}
    >
      <div
        className="mt-32 rounded-xl p-4"
        style={{
          width: prompt.fields?.length
            ? "min(420px, calc(100vw - 32px))"
            : "20rem",
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
        {prompt.fields?.length ? (
          <div className="space-y-3">
            {prompt.fields.map((field, index) => (
              <div key={field.name}>
                <div
                  className="mb-1 text-xs"
                  style={{ color: "var(--text-soft)" }}
                >
                  {field.label}
                </div>
                <div className="flex gap-2">
                  <input
                    ref={index === 0 ? inputRef : undefined}
                    value={values[field.name] ?? ""}
                    placeholder={field.placeholder}
                    onChange={(e) =>
                      setValues((prev) => ({
                        ...prev,
                        [field.name]: e.target.value,
                      }))
                    }
                    onKeyDown={(e) => {
                      if (e.key === "Enter") {
                        e.preventDefault();
                        submit();
                      } else if (e.key === "Escape") {
                        e.preventDefault();
                        closePrompt();
                      }
                    }}
                    className="min-w-0 flex-1 rounded-md px-2.5 py-1.5 text-sm outline-none"
                    style={{
                      background: "var(--bg)",
                      border: `1px solid ${
                        error ? "#e5484d" : "var(--border)"
                      }`,
                      color: "var(--text)",
                    }}
                  />
                  {field.actionLabel && field.onAction && (
                    <button
                      type="button"
                      disabled={actionBusy === field.name}
                      onClick={() => runFieldAction(field)}
                      className="shrink-0 rounded-md px-2.5 py-1.5 text-sm transition-colors"
                      style={{
                        background: "var(--bg)",
                        border: "1px solid var(--border)",
                        color: "var(--text-soft)",
                        opacity: actionBusy === field.name ? 0.65 : 1,
                      }}
                    >
                      {field.actionLabel}
                    </button>
                  )}
                </div>
              </div>
            ))}
          </div>
        ) : (
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
        )}
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
