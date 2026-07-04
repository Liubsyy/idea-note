import { useEffect, useState } from "react";
import { AlertTriangle, AppWindow, X } from "lucide-react";
import { useAppStore } from "../store/useAppStore";

/**
 * App-level confirmation dialog for destructive actions (delete). Replaces
 * window.confirm, which is unreliable in Tauri's WKWebView.
 */
export function ConfirmModal() {
  const confirm = useAppStore((s) => s.confirm);
  const closeConfirm = useAppStore((s) => s.closeConfirm);

  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!confirm) return;
    setError(null);
    setBusy(false);
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") closeConfirm();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [confirm, closeConfirm]);

  if (!confirm) return null;
  const hasAltAction = Boolean(confirm.altLabel && confirm.onAlt);

  const run = async (action: () => void | Promise<void>) => {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      await action();
      closeConfirm();
    } catch (e) {
      setError(typeof e === "string" ? e : (e as Error)?.message ?? "操作失败");
      setBusy(false);
    }
  };

  return (
    <div
      className="fixed inset-0 z-[60] flex items-start justify-center backdrop-blur-sm"
      style={{ background: "rgba(0,0,0,0.32)" }}
      onMouseDown={closeConfirm}
    >
      <div
        className="mt-32 w-[360px] max-w-[calc(100vw-32px)] rounded-xl p-4"
        style={{
          background: "var(--bg-elev)",
          border: "1px solid var(--border)",
          boxShadow: "0 18px 54px var(--shadow)",
        }}
        onMouseDown={(e) => e.stopPropagation()}
      >
        <div className="flex items-start gap-3">
          <div
            className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg"
            style={{
              background: confirm.tone === "primary"
                ? "color-mix(in srgb, var(--accent) 14%, transparent)"
                : "rgba(229, 72, 77, 0.12)",
              color: confirm.tone === "primary" ? "var(--accent)" : "#e5484d",
            }}
          >
            {confirm.tone === "primary" ? (
              <AppWindow size={18} />
            ) : (
              <AlertTriangle size={18} />
            )}
          </div>
          <div className="min-w-0 flex-1">
            <div className="text-sm font-semibold" style={{ color: "var(--text)" }}>
              {confirm.title}
            </div>
            <p className="m-0 mt-1 text-sm leading-relaxed" style={{ color: "var(--text-soft)" }}>
              {confirm.message}
            </p>
          </div>
          <button
            onClick={closeConfirm}
            className="flex h-7 w-7 shrink-0 items-center justify-center rounded-md transition-colors"
            style={{ color: "var(--text-muted)" }}
            title="取消"
            onMouseEnter={(e) => {
              e.currentTarget.style.background = "var(--hover)";
              e.currentTarget.style.color = "var(--text)";
            }}
            onMouseLeave={(e) => {
              e.currentTarget.style.background = "transparent";
              e.currentTarget.style.color = "var(--text-muted)";
            }}
          >
            <X size={15} />
          </button>
        </div>
        {error && (
          <div className="mt-3 text-xs" style={{ color: "#e5484d" }}>
            {error}
          </div>
        )}
        <div className="mt-5 flex justify-end gap-2">
          <button
            onClick={closeConfirm}
            disabled={busy}
            className="rounded-md px-3.5 py-1.5 text-sm transition-colors"
            style={{ color: "var(--text-muted)" }}
            onMouseEnter={(e) => (e.currentTarget.style.background = "var(--hover)")}
            onMouseLeave={(e) => (e.currentTarget.style.background = "transparent")}
          >
            取消
          </button>
          {hasAltAction && (
            <button
              onClick={() => run(confirm.onAlt!)}
              disabled={busy}
              className="rounded-md px-3.5 py-1.5 text-sm font-medium transition-colors"
              style={{
                color: "var(--text)",
                border: "1px solid var(--border)",
                opacity: busy ? 0.6 : 1,
              }}
              onMouseEnter={(e) => (e.currentTarget.style.background = "var(--hover)")}
              onMouseLeave={(e) => (e.currentTarget.style.background = "transparent")}
            >
              {confirm.altLabel}
            </button>
          )}
          <button
            onClick={() => run(confirm.onConfirm)}
            disabled={busy}
            className="rounded-md px-3.5 py-1.5 text-sm font-medium text-white transition-opacity"
            style={{
              background: confirm.tone === "primary" ? "var(--accent)" : "#e5484d",
              opacity: busy ? 0.6 : 1,
            }}
          >
            {confirm.confirmLabel}
          </button>
        </div>
      </div>
    </div>
  );
}
