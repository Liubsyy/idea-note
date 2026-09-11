import { useEffect, useMemo, useRef } from "react";
import { useAppStore, isDraftPath } from "../../store/useAppStore";
import { isMarkdownFile } from "../../lib/fs";
import { getActiveView } from "../../lib/codemirror/activeView";
import { paginate, type PageRange } from "../../lib/presentation/paginate";
import { presentationBreaks, PRESENTATION_LAYOUT_EVENT } from "../../lib/presentation/breaks";
import "../../styles/presentation.css";

/** Page the existing read-only editor. Both presentation modes use the same
 * widgets, image resolution, highlighting, theme, and live document state. */
export function SlidePresentation() {
  const content = useAppStore((s) => s.content);
  const path = useAppStore((s) => s.activeFilePath) ?? "";
  const docKey = useAppStore((s) => s.docKey);
  // These settings recreate the underlying EditorView; reattach pagination
  // when that happens, including a same-path reload from disk.
  const editorLineNumbers = useAppStore((s) => s.editorLineNumbers);
  const editorKeybindings = useAppStore((s) => s.editorKeybindings);
  const vaultRotationBusy = useAppStore((s) => s.vaultRotationBusy);
  const scale = useAppStore((s) => s.presentationScale);
  const page = useAppStore((s) => s.presentationPage);
  const count = useAppStore((s) => s.presentationPageCount);
  const breaks = useMemo(() => isMarkdownFile(path) || isDraftPath(path)
    ? presentationBreaks(content) : [], [content, path]);
  const scheduleRef = useRef<(() => void) | null>(null);
  const breaksRef = useRef(breaks);
  breaksRef.current = breaks;

  useEffect(() => {
    const view = getActiveView();
    const scroller = view?.scrollDOM ?? document.querySelector<HTMLElement>("[data-presentation-scroll]");
    if (!scroller) return;
    const previousClip = scroller.style.clipPath;
    const previousScroll = scroller.scrollTop;
    let disposed = false;
    let frame = 0;
    const measureKey = {};

    const read = () => {
      if (disposed) return null;
      const height = scroller.clientHeight;
      if (height <= 0) return null;
      const padding = view?.documentPadding ?? { top: 0, bottom: 0 };
      const total = view ? Math.max(0, view.contentHeight - padding.top - padding.bottom) : scroller.scrollHeight;
      const blocks: PageRange[] = [];
      const boundaries: PageRange[] = [];
      if (view) {
        const length = view.state.doc.length;
        for (const range of breaksRef.current) {
          boundaries.push({
            from: view.lineBlockAt(Math.min(range.from, length)).top,
            to: range.to >= length ? total : view.lineBlockAt(range.to).top,
          });
        }
        // CodeMirror's height map covers the whole document, including blocks
        // not mounted in its virtual viewport. Loaded widget sizes refine it.
        for (let pos = 0; pos <= length;) {
          const block = view.lineBlockAt(pos);
          blocks.push({ from: block.top, to: block.bottom });
          if (block.to >= length) break;
          pos = block.to + 1;
        }
        // For long wrapped lines, keep individual visible text lines intact.
        const origin = view.documentTop;
        const walker = document.createTreeWalker(view.contentDOM, NodeFilter.SHOW_TEXT);
        const range = document.createRange();
        let node: Node | null;
        while ((node = walker.nextNode())) {
          if (!node.textContent?.trim()) continue;
          range.selectNodeContents(node);
          for (const rect of Array.from(range.getClientRects())) {
            if (rect.height > 0) blocks.push({ from: rect.top - origin, to: rect.bottom - origin });
          }
        }
      }
      return { pages: paginate(total, height, boundaries, blocks), height, paddingTop: padding.top };
    };

    const write = (layout: ReturnType<typeof read>) => {
      if (disposed || !layout) return;
      const store = useAppStore.getState();
      if (store.presentationPageCount !== layout.pages.length)
        store.setPresentationPageCount(layout.pages.length);
      const current = layout.pages[Math.min(store.presentationPage, layout.pages.length - 1)];
      scroller.style.clipPath = `inset(0 0 ${Math.max(0, layout.height - (current.to - current.from))}px 0)`;
      const top = current.from + layout.paddingTop;
      if (Math.abs(scroller.scrollTop - top) > 0.5) scroller.scrollTop = top;
    };

    const schedule = () => {
      if (disposed || frame) return;
      frame = requestAnimationFrame(() => {
        frame = 0;
        if (disposed) return;
        if (view) view.requestMeasure({ key: measureKey, read, write });
        else write(read());
      });
    };
    scheduleRef.current = schedule;
    const observer = new ResizeObserver(schedule);
    observer.observe(scroller);
    if (view) observer.observe(view.contentDOM);
    scroller.addEventListener("load", schedule, true);
    scroller.addEventListener("error", schedule, true);
    scroller.addEventListener("scroll", schedule, { passive: true });
    window.addEventListener(PRESENTATION_LAYOUT_EVENT, schedule);
    void document.fonts?.ready.then(schedule);
    schedule();
    return () => {
      disposed = true;
      scheduleRef.current = null;
      cancelAnimationFrame(frame);
      observer.disconnect();
      scroller.removeEventListener("load", schedule, true);
      scroller.removeEventListener("error", schedule, true);
      scroller.removeEventListener("scroll", schedule);
      window.removeEventListener(PRESENTATION_LAYOUT_EVENT, schedule);
      scroller.style.clipPath = previousClip;
      scroller.scrollTop = previousScroll;
    };
  }, [path, docKey, editorLineNumbers, editorKeybindings, vaultRotationBusy]);

  useEffect(() => { scheduleRef.current?.(); }, [page, scale, breaks]);

  useEffect(() => {
    let lastPageAt = -Infinity;
    const onWheel = (event: WheelEvent) => {
      if (event.ctrlKey || event.metaKey || event.altKey || event.shiftKey ||
          event.deltaY === 0 || Math.abs(event.deltaX) > Math.abs(event.deltaY)) return;
      if (!(event.target instanceof Element) || !event.target.closest(".presentation-editor")) return;
      if (event.target.closest("input, select, textarea, [contenteditable=true], [role=slider], [role=spinbutton]")) return;
      const store = useAppStore.getState();
      if (!store.presentationActive || store.presentationMode !== "slides") return;

      // Own vertical scrolling before editor widgets can scroll the page away
      // from its measured boundary. Limit rapid wheel events to one page turn.
      event.preventDefault();
      event.stopPropagation();
      const now = performance.now();
      if (now - lastPageAt < 400) return;
      lastPageAt = now;
      store.setPresentationPage(store.presentationPage + (event.deltaY > 0 ? 1 : -1));
    };
    window.addEventListener("wheel", onWheel, { capture: true, passive: false });
    return () => window.removeEventListener("wheel", onWheel, true);
  }, []);

  return (
    <div className="slide-footer" aria-label="分页演示" aria-live="polite">
      <span>← / → 或滚轮翻页 · 空格下一页 · Esc 退出</span>
      <span>{page + 1} / {count}</span>
    </div>
  );
}
