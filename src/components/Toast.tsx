import { useEffect, useState } from "react";
import { AlertCircle, CheckCircle2 } from "lucide-react";
import { useAppStore } from "../store/useAppStore";

/** How long a toast stays up before fading: errors linger longer. */
const DURATION = { success: 2600, error: 5000 } as const;
const EXIT_MS = 220;

/**
 * Sync-result bubble anchored under the title-bar sync button — render it
 * inside a `position: relative` wrapper around the button. Drops down on
 * entry, fades back up on exit; auto-dismisses, and a click dismisses early.
 * Keyed by `toast.id` so a re-trigger while visible restarts animation+timer.
 */
export function SyncToast() {
  const toast = useAppStore((s) => s.toast);
  const dismissToast = useAppStore((s) => s.dismissToast);
  const [leaving, setLeaving] = useState(false);

  useEffect(() => {
    if (!toast) return;
    setLeaving(false);
    const hide = setTimeout(() => setLeaving(true), DURATION[toast.tone]);
    return () => clearTimeout(hide);
  }, [toast]);

  // Unmount only after the exit animation has played.
  useEffect(() => {
    if (!leaving) return;
    const remove = setTimeout(dismissToast, EXIT_MS);
    return () => clearTimeout(remove);
  }, [leaving, dismissToast]);

  if (!toast) return null;
  const isError = toast.tone === "error";
  const tint = isError ? "#e5484d" : "var(--accent)";

  return (
    <div
      key={toast.id}
      className={`absolute right-0 top-full z-50 mt-1.5 ${leaving ? "toast-out" : "toast-in"}`}
    >
      <div
        onClick={() => setLeaving(true)}
        className="flex w-max max-w-[min(360px,calc(100vw-24px))] items-center gap-1.5 rounded-lg px-3 py-1.5 text-xs"
        style={{
          background: "var(--bg-elev)",
          border: "1px solid var(--border)",
          boxShadow: "0 8px 28px var(--shadow)",
          color: "var(--text)",
        }}
      >
        <span className="shrink-0" style={{ color: tint }}>
          {isError ? <AlertCircle size={14} /> : <CheckCircle2 size={14} />}
        </span>
        <span>{toast.message}</span>
      </div>
    </div>
  );
}
