import { tr } from "../i18n/core.ts";
export interface SvgPreviewState {
  src: string | null;
  error: string | null;
  pending: boolean;
}

/** Validate XML before attempting an image decode; never inject SVG into the DOM. */
export function svgValidationError(source: string): string | null {
  const doc = new DOMParser().parseFromString(source, "image/svg+xml");
  const error = doc.querySelector("parsererror");
  if (error) {
    const detail = error.textContent?.replace(/\s+/g, " ").trim().slice(0, 180);
    return tr("SVG 语法错误{{0}}", { 0: detail ? `：${detail}` : tr("，请检查标签和属性") });
  }
  if (doc.documentElement.localName !== "svg" ||
      doc.documentElement.namespaceURI !== "http://www.w3.org/2000/svg") {
    return tr("根元素必须是 <svg>，并包含 xmlns=\"http://www.w3.org/2000/svg\"");
  }
  return null;
}

/** Debounce edits, preload before swapping, and ignore stale image callbacks. */
export function createSvgPreview(onChange: (state: SvgPreviewState) => void) {
  let state: SvgPreviewState = { src: null, error: null, pending: false };
  let timer: ReturnType<typeof setTimeout> | undefined;
  let pending: { image: HTMLImageElement; url: string } | undefined;
  let generation = 0;
  let disposed = false;
  let lastSource: string | undefined;

  const publish = (patch: Partial<SvgPreviewState>) => {
    state = { ...state, ...patch };
    onChange(state);
  };
  const cancelPending = () => {
    clearTimeout(timer);
    if (pending) {
      pending.image.onload = pending.image.onerror = null;
      URL.revokeObjectURL(pending.url);
      pending = undefined;
    }
  };

  return {
    update(source: string, immediate = false) {
      if (disposed || source === lastSource) return;
      lastSource = source;
      const current = ++generation;
      cancelPending();
      publish({ pending: true });
      const render = () => {
        if (disposed || current !== generation) return;
        const error = svgValidationError(source);
        if (error) {
          publish({ error, pending: false });
          return;
        }
        const url = URL.createObjectURL(new Blob([source], { type: "image/svg+xml;charset=utf-8" }));
        const image = new Image();
        pending = { image, url };
        image.onload = () => {
          if (disposed || current !== generation) return;
          pending = undefined;
          image.onload = image.onerror = null;
          const previous = state.src;
          publish({ src: url, error: null, pending: false });
          if (previous) URL.revokeObjectURL(previous);
        };
        image.onerror = () => {
          if (disposed || current !== generation) return;
          cancelPending();
          publish({ error: tr("SVG 无法渲染，请检查图片尺寸和内容"), pending: false });
        };
        image.src = url;
      };
      if (immediate) render();
      else timer = setTimeout(render, 300);
    },
    dispose() {
      disposed = true;
      generation++;
      cancelPending();
      if (state.src) URL.revokeObjectURL(state.src);
    },
  };
}
