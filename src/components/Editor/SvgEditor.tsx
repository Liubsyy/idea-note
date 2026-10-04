import { useEffect, useRef, useState } from "react";

import { useAppStore } from "../../store/useAppStore";
import { createSvgPreview, type SvgPreviewState } from "../../lib/svgPreview";
import { PreviewEditor } from "./PreviewEditor";
import { ImageView } from "./ImageView";
import "./svgEditor.css";

export function SvgEditor({ path }: { path: string }) {
  const content = useAppStore((s) => s.content);
  const presentationActive = useAppStore((s) => s.presentationActive);
  const presentationScale = useAppStore((s) => s.presentationScale);

  const [preview, setPreview] = useState<SvgPreviewState>({ src: null, error: null, pending: true });
  const renderer = useRef<ReturnType<typeof createSvgPreview> | null>(null);


  useEffect(() => {
    const next = createSvgPreview(setPreview);
    renderer.current = next;
    next.update(useAppStore.getState().content, true);
    return () => { next.dispose(); renderer.current = null; };
  }, []);
  useEffect(() => { renderer.current?.update(content); }, [content]);
  return <PreviewEditor label="SVG 图片" image pending={preview.pending} error={preview.error} stale={!!preview.src}>
    {preview.src ? <ImageView path={path} src={preview.src}
      presentationScale={presentationActive ? presentationScale : undefined} /> :
      <div className="svg-editor-placeholder">{preview.pending ? "正在渲染…" : "暂无可用预览"}</div>}
  </PreviewEditor>;
}
