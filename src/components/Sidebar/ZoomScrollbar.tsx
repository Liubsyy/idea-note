import { useEffect, useRef } from "react";

/** Track width; mirrors `*::-webkit-scrollbar { width: 9px }` in globals.css. */
const TRACK_WIDTH = 9;
/** Keeps the thumb grabbable in very long lists. */
const MIN_THUMB_HEIGHT = 24;
/** Same idle delay as the native auto-hiding scrollbar. */
const HIDE_DELAY_MS = 800;

let gutterReserved: boolean | null = null;

/**
 * Whether a scrollbar takes layout space here (classic) or floats over the
 * content (macOS overlay scrollbars, which depend on a system setting). The
 * stand-in scrollbar follows whichever the native one does, so switching zoom
 * never reflows the list. Measured once, lazily, so app CSS is already applied.
 */
export function scrollbarReservesGutter(): boolean {
  if (gutterReserved === null) {
    const probe = document.createElement("div");
    probe.style.cssText =
      "position:absolute;top:-9999px;width:100px;height:100px;overflow-y:scroll";
    document.body.appendChild(probe);
    gutterReserved = probe.offsetWidth - probe.clientWidth > 0;
    probe.remove();
  }
  return gutterReserved;
}

/**
 * Scrolling and a stand-in scrollbar for a list that had to give up both.
 *
 * The sidebar list switches to `overflow:hidden` under macOS page zoom (see
 * `Sidebar`) so WebKit keeps it out of a composited layer and its text stays
 * crisp. Such a box still scrolls when `scrollTop` is assigned, but it draws no
 * scrollbar and — importantly — emits no `scroll` events, so both the wheel
 * handling and the thumb it drives live here: every write to `scrollTop` goes
 * through `scrollTo`, which repaints the thumb itself.
 *
 * The track sits where the native scrollbar would: inside the gutter the list
 * reserves via `pr-[9px]` when scrollbars are classic, over the content when
 * they are overlays. Only the thumb takes pointer events, so it intercepts a
 * click exactly where the native thumb would have.
 */
export function ZoomScrollbar({
  targetRef,
  enabled,
}: {
  targetRef: React.RefObject<HTMLDivElement | null>;
  enabled: boolean;
}) {
  const trackRef = useRef<HTMLDivElement>(null);
  const thumbRef = useRef<HTMLDivElement>(null);
  const hideTimer = useRef<number | undefined>(undefined);

  useEffect(() => {
    const target = targetRef.current;
    const track = trackRef.current;
    const thumb = thumbRef.current;
    if (!enabled || !target || !track || !thumb) return;

    let dragging = false;

    const sync = () => {
      const { scrollHeight, clientHeight, scrollTop } = target;
      const range = scrollHeight - clientHeight;
      // Nothing to scroll: hide the track so it can't be grabbed.
      track.style.visibility = range > 0 ? "visible" : "hidden";
      if (range <= 0) return;
      const trackHeight = track.clientHeight;
      const thumbHeight = Math.max(
        MIN_THUMB_HEIGHT,
        Math.round((clientHeight / scrollHeight) * trackHeight),
      );
      const progress = Math.min(1, Math.max(0, scrollTop / range));
      thumb.style.height = `${thumbHeight}px`;
      thumb.style.transform = `translateY(${(trackHeight - thumbHeight) * progress}px)`;
    };

    const hideSoon = () => {
      window.clearTimeout(hideTimer.current);
      hideTimer.current = window.setTimeout(() => {
        if (!dragging) track.classList.remove("is-scrolling");
      }, HIDE_DELAY_MS);
    };

    /** The only path that moves the list, so the thumb can never fall behind. */
    const scrollTo = (top: number, left = target.scrollLeft) => {
      target.scrollTop = top;
      target.scrollLeft = left;
      sync();
      track.classList.add("is-scrolling");
      hideSoon();
    };

    // React registers `onWheel` as passive, so this has to be attached by hand
    // to be able to preventDefault.
    const onWheel = (e: WheelEvent) => {
      if (target.scrollHeight <= target.clientHeight) return;
      e.preventDefault();
      scrollTo(target.scrollTop + e.deltaY, target.scrollLeft + e.deltaX);
    };

    // Dragging maps pointer travel back onto the remaining scroll range.
    const onPointerDown = (e: PointerEvent) => {
      if (e.button !== 0) return;
      const travel = track.clientHeight - thumb.offsetHeight;
      if (travel <= 0) return;
      e.preventDefault();
      const startY = e.clientY;
      const startScrollTop = target.scrollTop;
      const ratio = (target.scrollHeight - target.clientHeight) / travel;
      dragging = true;
      track.classList.add("is-scrolling");
      thumb.setPointerCapture(e.pointerId);
      const onMove = (move: PointerEvent) => {
        scrollTo(startScrollTop + (move.clientY - startY) * ratio);
      };
      const onUp = () => {
        dragging = false;
        thumb.removeEventListener("pointermove", onMove);
        thumb.removeEventListener("pointerup", onUp);
        thumb.removeEventListener("pointercancel", onUp);
        hideSoon();
      };
      thumb.addEventListener("pointermove", onMove);
      thumb.addEventListener("pointerup", onUp);
      thumb.addEventListener("pointercancel", onUp);
    };

    target.addEventListener("wheel", onWheel, { passive: false });
    thumb.addEventListener("pointerdown", onPointerDown);
    // The list resizes with the sidebar; its content changes on refresh, mode
    // switches and folder expansion, none of which go through `scrollTo`.
    const resize = new ResizeObserver(sync);
    resize.observe(target);
    const mutations = new MutationObserver(sync);
    mutations.observe(target, { childList: true, subtree: true });
    sync();

    return () => {
      window.clearTimeout(hideTimer.current);
      target.removeEventListener("wheel", onWheel);
      thumb.removeEventListener("pointerdown", onPointerDown);
      resize.disconnect();
      mutations.disconnect();
    };
  }, [enabled, targetRef]);

  if (!enabled) return null;
  return (
    <div
      ref={trackRef}
      className="zoom-scrollbar"
      style={{ width: TRACK_WIDTH }}
      aria-hidden="true"
    >
      <div ref={thumbRef} className="zoom-scrollbar-thumb" />
    </div>
  );
}
