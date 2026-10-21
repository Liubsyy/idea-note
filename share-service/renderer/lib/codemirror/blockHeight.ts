// Measured heights for live-preview block widgets, shared by the table, math,
// mermaid and inline-HTML renderers.
//
// CodeMirror throws away a block widget's height as soon as its decoration
// changes — a rebuilt widget that `eq()` rejects is enough, even when the DOM
// underneath is reused unchanged — and falls back to `WidgetType.
// estimatedHeight` until the next measure pass. Left at the default that
// estimate is a single line, so a tall widget momentarily collapses inside the
// height map. One transaction survives that, because the scroll anchor is read
// before the collapse; two in the same frame do not. A click that moves the
// caret out of a table cell dispatches exactly two, and the second anchors the
// scroll position against the collapsed height — re-measuring then shifts the
// viewport by the widget's full height.
//
// Reporting what the block last measured keeps the estimate honest, so the
// anchor — and with it the scroll position — stays put. The value is only ever
// a starting point: CodeMirror overwrites it with the real height on the next
// measure, so a stale or mismatched entry costs nothing beyond the behaviour we
// had before.

/** Last laid-out height in pixels, keyed by widget kind + document offset. */
const heights = new Map<string, number>();

/**
 * Offsets shift as the document is edited, so keys go stale and pile up. Past
 * this many the map is dropped whole; every mounted widget records itself again
 * on its next reflow.
 */
const MAX_ENTRIES = 512;

/** Key builder: kinds are namespaced so two widgets can share an offset. */
export const blockHeightKey = (kind: string, from: number): string =>
  `${kind}:${from}`;

/** Height to report from `estimatedHeight`, or -1 when nothing was measured. */
export const estimatedBlockHeight = (key: string): number =>
  heights.get(key) ?? -1;

// One observer for every tracked widget: the key is re-read on each callback
// because a reused DOM node (the table keeps its own across rebuilds) moves
// through the document as text above it changes.
const tracked = new WeakMap<Element, () => string | null>();
let observer: ResizeObserver | null = null;

function record(el: Element): void {
  const key = tracked.get(el)?.();
  if (!key) return;
  const height = el.getBoundingClientRect().height;
  // A widget is built before it is inserted, where every box is 0x0.
  if (height <= 0) return;
  if (heights.size >= MAX_ENTRIES && !heights.has(key)) heights.clear();
  heights.set(key, height);
}

/** Follow `el`'s height for as long as it is on screen. */
export function trackBlockHeight(el: HTMLElement, key: () => string | null): void {
  tracked.set(el, key);
  if (!observer)
    observer = new ResizeObserver((entries) => {
      for (const entry of entries) record(entry.target);
    });
  observer.observe(el);
}

/** Stop following `el`; call from the widget's `destroy`. */
export function untrackBlockHeight(el: HTMLElement): void {
  tracked.delete(el);
  observer?.unobserve(el);
}
