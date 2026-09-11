import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { ChevronDown, GalleryVerticalEnd, Maximize2, Presentation } from "lucide-react";
import { useAppStore, type PresentationMode } from "../../store/useAppStore";

export function PresentationMenu() {
  const [position, setPosition] = useState<{ top: number; left: number } | null>(null);
  const buttonRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!position) return;
    menuRef.current?.querySelector<HTMLButtonElement>("button")?.focus();
    const closeOutside = (e: MouseEvent) => {
      if (!menuRef.current?.contains(e.target as Node) && !buttonRef.current?.contains(e.target as Node))
        setPosition(null);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        e.stopPropagation();
        setPosition(null);
        buttonRef.current?.focus();
      }
    };
    const close = () => setPosition(null);
    document.addEventListener("mousedown", closeOutside);
    document.addEventListener("keydown", onKey, true);
    window.addEventListener("resize", close);
    return () => {
      document.removeEventListener("mousedown", closeOutside);
      document.removeEventListener("keydown", onKey, true);
      window.removeEventListener("resize", close);
    };
  }, [position]);

  const open = () => {
    if (position) return setPosition(null);
    const rect = buttonRef.current?.getBoundingClientRect();
    if (rect) setPosition({ top: rect.bottom + 5, left: Math.max(8, Math.min(rect.right - 240, window.innerWidth - 248)) });
  };
  const choose = (mode: PresentationMode) => {
    setPosition(null);
    useAppStore.getState().enterPresentation(mode);
  };

  return <>
    <button
      ref={buttonRef}
      type="button"
      title="演示当前文件"
      aria-label="演示当前文件"
      aria-haspopup="menu"
      aria-expanded={!!position}
      onMouseDown={(e) => e.stopPropagation()}
      onClick={open}
      onKeyDown={(e) => {
        if (e.key === "ArrowDown") { e.preventDefault(); open(); }
      }}
      className="flex h-7 items-center gap-0.5 rounded-md px-1 transition-colors hover:bg-[var(--hover)]"
      style={{ color: position ? "var(--accent)" : "var(--text-muted)", background: position ? "var(--active)" : undefined }}
    >
      <Presentation size={16} /><ChevronDown size={10} />
    </button>
    {position && createPortal(
      <div
        ref={menuRef}
        role="menu"
        aria-label="演示方式"
        className="fixed z-[80] w-60 rounded-lg p-1 shadow-xl"
        style={{ ...position, background: "var(--bg-elev)", border: "1px solid var(--border)", color: "var(--text)" }}
        onKeyDown={(e) => {
          if (!["ArrowDown", "ArrowUp", "Home", "End"].includes(e.key)) return;
          e.preventDefault();
          const buttons = Array.from(menuRef.current?.querySelectorAll<HTMLButtonElement>("button") ?? []);
          const index = buttons.indexOf(document.activeElement as HTMLButtonElement);
          const next = e.key === "Home" ? 0 : e.key === "End" ? buttons.length - 1 : (index + (e.key === "ArrowDown" ? 1 : -1) + buttons.length) % buttons.length;
          buttons[next]?.focus();
        }}
      >
        <button role="menuitem" className="flex w-full items-center gap-2.5 rounded-md px-3 py-2 text-left hover:bg-[var(--hover)] focus:bg-[var(--hover)] focus:outline-none" onClick={() => choose("fullscreen")}>
          <Maximize2 size={17} />
          <span className="flex-1"><span className="block text-sm">全屏演示</span><span className="block text-xs text-[var(--text-muted)]">连续滚动阅读当前文件</span></span>
          <span className="text-xs text-[var(--text-muted)]">F5</span>
        </button>
        <button role="menuitem" className="flex w-full items-center gap-2.5 rounded-md px-3 py-2 text-left hover:bg-[var(--hover)] focus:bg-[var(--hover)] focus:outline-none" onClick={() => choose("slides")}>
          <GalleryVerticalEnd size={17} />
          <span><span className="block text-sm">分页演示</span><span className="block text-xs text-[var(--text-muted)]">按屏幕分页，--- 可提前换页</span></span>
        </button>
      </div>, document.body,
    )}
  </>;
}
