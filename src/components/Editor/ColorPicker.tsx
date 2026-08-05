import { useRef, useState } from "react";

/**
 * Custom-colour panel shown inside the toolbar's colour menus: a saturation /
 * brightness field over a hue strip, with the hex field kept small underneath.
 * Colour is what the user is choosing, so colour is what the panel is made of.
 */

const clamp01 = (n: number) => Math.min(1, Math.max(0, n));

/** hsv → `#rrggbb`. `h` in degrees, `s`/`v` in 0…1. */
function hsvToHex(h: number, s: number, v: number): string {
  const channel = (n: number) => {
    const k = (n + h / 60) % 6;
    const x = v - v * s * Math.max(0, Math.min(k, 4 - k, 1));
    return Math.round(x * 255)
      .toString(16)
      .padStart(2, "0");
  };
  return `#${channel(5)}${channel(3)}${channel(1)}`;
}

/** `#rgb`/`#rrggbb` → hsv, or null when the text isn't a colour (yet). */
export function hexToHsv(hex: string): { h: number; s: number; v: number } | null {
  const text = hex.trim().toLowerCase();
  const full = /^#[0-9a-f]{3}$/.test(text)
    ? `#${text[1]}${text[1]}${text[2]}${text[2]}${text[3]}${text[3]}`
    : text;
  if (!/^#[0-9a-f]{6}$/.test(full)) return null;
  const r = parseInt(full.slice(1, 3), 16) / 255;
  const g = parseInt(full.slice(3, 5), 16) / 255;
  const b = parseInt(full.slice(5, 7), 16) / 255;
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const d = max - min;
  let h = 0;
  if (d) {
    if (max === r) h = ((g - b) / d) % 6;
    else if (max === g) h = (b - r) / d + 2;
    else h = (r - g) / d + 4;
    h = (h * 60 + 360) % 360;
  }
  return { h, s: max ? d / max : 0, v: max };
}

/** Drag handle drawn on both tracks. */
function Handle({ style }: { style: React.CSSProperties }) {
  return (
    <span
      className="pointer-events-none absolute h-3.5 w-3.5 -translate-x-1/2 -translate-y-1/2 rounded-full border-2 border-white"
      style={{ boxShadow: "0 0 0 1px rgba(0,0,0,0.45)", ...style }}
    />
  );
}

export function ColorPicker({
  initial,
  onBack,
  onSubmit,
}: {
  /** Colour the panel opens on. */
  initial: string;
  onBack: () => void;
  onSubmit: (color: string) => void;
}) {
  const [hsv, setHsv] = useState(
    () => hexToHsv(initial) ?? { h: 0, s: 1, v: 1 },
  );
  // Set while the user is typing in the hex field, so a half-written value
  // isn't overwritten by the one derived from hsv.
  const [typed, setTyped] = useState<string | null>(null);
  const areaRef = useRef<HTMLDivElement>(null);
  const hueRef = useRef<HTMLDivElement>(null);

  const hex = hsvToHex(hsv.h, hsv.s, hsv.v);

  /** Map a pointer event to 0…1 coordinates within `el`. */
  const at = (el: HTMLDivElement | null, e: React.PointerEvent) => {
    const r = el?.getBoundingClientRect();
    if (!r) return null;
    return {
      x: clamp01((e.clientX - r.left) / r.width),
      y: clamp01((e.clientY - r.top) / r.height),
    };
  };

  const dragArea = (e: React.PointerEvent) => {
    const p = at(areaRef.current, e);
    if (!p) return;
    setTyped(null);
    setHsv((prev) => ({ ...prev, s: p.x, v: 1 - p.y }));
  };
  const dragHue = (e: React.PointerEvent) => {
    const p = at(hueRef.current, e);
    if (!p) return;
    setTyped(null);
    setHsv((prev) => ({ ...prev, h: p.x * 360 }));
  };
  // Pointer capture keeps the drag alive past the track's edges without any
  // window-level listeners to clean up.
  const start = (e: React.PointerEvent, drag: (e: React.PointerEvent) => void) => {
    e.currentTarget.setPointerCapture(e.pointerId);
    drag(e);
  };

  return (
    <div className="p-2">
      <div
        ref={areaRef}
        onPointerDown={(e) => start(e, dragArea)}
        onPointerMove={(e) => e.buttons && dragArea(e)}
        className="relative h-[124px] w-full cursor-crosshair rounded-md"
        style={{
          background: `linear-gradient(to top, #000, rgba(0,0,0,0)), linear-gradient(to right, #fff, hsl(${hsv.h} 100% 50%))`,
        }}
      >
        <Handle
          style={{
            left: `${hsv.s * 100}%`,
            top: `${(1 - hsv.v) * 100}%`,
            background: hex,
          }}
        />
      </div>
      <div
        ref={hueRef}
        onPointerDown={(e) => start(e, dragHue)}
        onPointerMove={(e) => e.buttons && dragHue(e)}
        className="relative mt-2 h-3 w-full cursor-pointer rounded-full"
        style={{
          background:
            "linear-gradient(to right, #f00, #ff0, #0f0, #0ff, #00f, #f0f, #f00)",
        }}
      >
        <Handle
          style={{
            left: `${(hsv.h / 360) * 100}%`,
            top: "50%",
            background: `hsl(${hsv.h} 100% 50%)`,
          }}
        />
      </div>

      <div className="mt-2.5 flex items-center gap-2">
        <span
          className="h-7 w-7 shrink-0 rounded-md"
          style={{ background: hex, border: "1px solid var(--border)" }}
        />
        <input
          value={typed ?? hex}
          spellCheck={false}
          onChange={(e) => {
            setTyped(e.target.value);
            const parsed = hexToHsv(e.target.value);
            if (parsed) setHsv(parsed);
          }}
          onBlur={() => setTyped(null)}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              e.preventDefault();
              onSubmit(hex);
            }
          }}
          className="min-w-0 flex-1 rounded-md px-2 py-1 text-sm outline-none"
          style={{
            background: "var(--bg)",
            border: `1px solid ${
              typed !== null && !hexToHsv(typed) ? "#e5484d" : "var(--border)"
            }`,
            color: "var(--text)",
          }}
        />
      </div>

      <div className="mt-2 flex items-center justify-end gap-1.5">
        <button
          onMouseDown={(e) => e.preventDefault()}
          onClick={onBack}
          className="rounded-md px-2.5 py-1 text-sm transition-colors"
          style={{ color: "var(--text-muted)" }}
        >
          返回
        </button>
        <button
          onMouseDown={(e) => e.preventDefault()}
          onClick={() => onSubmit(hex)}
          className="rounded-md px-3 py-1 text-sm font-medium text-white"
          style={{ background: "var(--accent)" }}
        >
          确定
        </button>
      </div>
    </div>
  );
}
