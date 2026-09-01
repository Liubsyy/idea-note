import { useEffect, useRef, useState } from "react";
import { Maximize2, Minus, Plus, RotateCcw, X } from "lucide-react";

import {
  PRESENTATION_SCALE_DEFAULT,
  PRESENTATION_SCALE_MAX,
  PRESENTATION_SCALE_MIN,
  PRESENTATION_SCALE_STEP,
  isDraftPath,
  useAppStore,
} from "../../store/useAppStore";
import { basename } from "../../lib/fs";
import { SyncToast } from "../Toast";

const HIDE_AFTER_MS = 2500;

/** Floating controls for the immersive current-file presentation. */
export function PresentationControls() {
  const activeFilePath = useAppStore((s) => s.activeFilePath);
  const scale = useAppStore((s) => s.presentationScale);
  const setScale = useAppStore((s) => s.setPresentationScale);
  const exit = useAppStore((s) => s.exitPresentation);
  const [visible, setVisible] = useState(true);
  const timerRef = useRef<number | undefined>(undefined);

  useEffect(() => {
    const reveal = () => {
      setVisible(true);
      window.clearTimeout(timerRef.current);
      timerRef.current = window.setTimeout(() => setVisible(false), HIDE_AFTER_MS);
    };
    reveal();
    window.addEventListener("mousemove", reveal, { passive: true });
    window.addEventListener("keydown", reveal, true);
    return () => {
      window.clearTimeout(timerRef.current);
      window.removeEventListener("mousemove", reveal);
      window.removeEventListener("keydown", reveal, true);
    };
  }, []);

  return (
    <div
      className={`pointer-events-none fixed inset-x-0 top-0 z-[70] flex justify-center px-4 pt-4 transition-all duration-200 ${
        visible ? "translate-y-0 opacity-100" : "-translate-y-3 opacity-0"
      }`}
      aria-hidden={!visible}
    >
      <div
        className={`flex min-w-0 items-center gap-1 rounded-xl px-2 py-1.5 shadow-xl backdrop-blur-xl ${
          visible ? "pointer-events-auto" : "pointer-events-none"
        }`}
        style={{
          color: "var(--text)",
          background: "color-mix(in srgb, var(--toolbar-bg) 92%, transparent)",
          border: "1px solid var(--border)",
        }}
      >
        <Maximize2 size={15} className="ml-1 shrink-0" style={{ color: "var(--accent)" }} />
        <span className="max-w-[40vw] truncate px-2 text-sm font-medium">
          {isDraftPath(activeFilePath)
            ? "未命名"
            : activeFilePath
              ? basename(activeFilePath)
              : "演示"}
        </span>
        <span className="mx-1 h-5 w-px" style={{ background: "var(--border)" }} />
        <ControlButton
          title="缩小（⌘/Ctrl -）"
          disabled={scale <= PRESENTATION_SCALE_MIN}
          onClick={() => setScale(scale - PRESENTATION_SCALE_STEP)}
        >
          <Minus size={15} />
        </ControlButton>
        <span className="w-12 select-none text-center text-xs tabular-nums" style={{ color: "var(--text-muted)" }}>
          {Math.round(scale * 100)}%
        </span>
        <ControlButton
          title="放大（⌘/Ctrl +）"
          disabled={scale >= PRESENTATION_SCALE_MAX}
          onClick={() => setScale(scale + PRESENTATION_SCALE_STEP)}
        >
          <Plus size={15} />
        </ControlButton>
        <ControlButton
          title="重置缩放（⌘/Ctrl 0）"
          disabled={scale === PRESENTATION_SCALE_DEFAULT}
          onClick={() => setScale(PRESENTATION_SCALE_DEFAULT)}
        >
          <RotateCcw size={14} />
        </ControlButton>
        <span className="mx-1 h-5 w-px" style={{ background: "var(--border)" }} />
        <div className="relative">
          <ControlButton title="退出演示（Esc）" onClick={exit}>
            <X size={16} />
          </ControlButton>
          <SyncToast />
        </div>
      </div>
    </div>
  );
}

function ControlButton({
  title,
  disabled = false,
  onClick,
  children,
}: {
  title: string;
  disabled?: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      title={title}
      disabled={disabled}
      onClick={onClick}
      className="flex h-7 w-7 items-center justify-center rounded-md transition-colors disabled:cursor-default disabled:opacity-30"
      onMouseEnter={(e) => {
        if (!disabled) e.currentTarget.style.background = "var(--hover)";
      }}
      onMouseLeave={(e) => (e.currentTarget.style.background = "transparent")}
    >
      {children}
    </button>
  );
}
