// One menu row that opens a nested panel to its right.
//
// Shared by the sidebar's file menu and the editor's context menu so the two
// behave identically — the awkward parts here are all about pointers, and
// solving them twice is how the two menus drift apart.

import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { ChevronRight } from "lucide-react";

/** Menu row that reveals a nested panel to the right while hovered. */
export function SubMenuItem({
  label,
  children,
  disabled = false,
}: {
  label: string;
  children: React.ReactNode;
  disabled?: boolean;
}) {
  // The panel is portaled to <body> with fixed coordinates — rendered in
  // place it would be clipped by the sidebar's overflow and sit under the
  // sidebar/editor divider. A short close delay keeps it open while the
  // pointer crosses the 2px overlap between the row and the panel.
  const [pos, setPos] = useState<{ top: number; left: number } | null>(null);
  const rowRef = useRef<HTMLDivElement>(null);
  const closeTimer = useRef<number | undefined>(undefined);
  const show = () => {
    if (disabled) return;
    window.clearTimeout(closeTimer.current);
    const r = rowRef.current?.getBoundingClientRect();
    if (r) {
      setPos({ top: r.top, left: Math.min(r.right - 2, window.innerWidth - 150) });
    }
  };
  const hide = () => {
    closeTimer.current = window.setTimeout(() => setPos(null), 120);
  };
  useEffect(() => () => window.clearTimeout(closeTimer.current), []);

  return (
    <div ref={rowRef} onMouseEnter={show} onMouseLeave={hide}>
      <button
        disabled={disabled}
        className="flex w-full items-center justify-between px-3 py-1.5 text-left transition-colors"
        style={{
          color: "var(--text)",
          background: pos ? "var(--hover)" : "transparent",
          opacity: disabled ? 0.4 : 1,
          cursor: disabled ? "default" : undefined,
        }}
      >
        {label}
        <ChevronRight size={13} style={{ color: "var(--text-muted)" }} />
      </button>
      {pos &&
        createPortal(
          <div
            data-menu-panel="true"
            className="fixed z-[70] w-36 overflow-y-auto overscroll-contain rounded-lg py-1 text-sm shadow-lg"
            style={{
              top: pos.top,
              left: pos.left,
              maxHeight: `calc(100vh - ${pos.top + 8}px)`,
              background: "var(--bg-elev)",
              border: "1px solid var(--border)",
              boxShadow: "0 8px 24px var(--shadow)",
            }}
            onMouseEnter={show}
            onMouseLeave={hide}
          >
            {children}
          </div>,
          document.body,
        )}
    </div>
  );
}
