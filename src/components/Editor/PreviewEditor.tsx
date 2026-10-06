import { tr } from "../../i18n/core.ts";
import { useLanguage } from "../../i18n/react";
import { useEffect, useRef, useState, type ReactNode } from "react";
import { Code2, Columns2, Eye, Image as ImageIcon } from "lucide-react";
import { useAppStore } from "../../store/useAppStore";
import type { PreviewMode } from "../../lib/filePreview";
import { CodeMirrorEditor } from "./CodeMirrorEditor";
import "./svgEditor.css";

export function PreviewEditor({ label, image = false, pending = false, error, stale = false, actions, previewActions, sourceActions, previewTitle, allowSplit = true, defaultMode = "preview", sourceFirst = false, children }: {
  label: string; image?: boolean; pending?: boolean; error?: string | null;
  stale?: boolean; actions?: ReactNode; previewActions?: ReactNode; sourceActions?: ReactNode; previewTitle?: string;
  allowSplit?: boolean; defaultMode?: PreviewMode; sourceFirst?: boolean;
  children: ReactNode | ((mode: PreviewMode, selectMode: (mode: PreviewMode) => void) => ReactNode);
}) {
  useLanguage();
  const presentation = useAppStore(s => s.presentationActive);
  const [mode, setMode] = useState<PreviewMode>(defaultMode);
  const [narrow, setNarrow] = useState(false);
  const [compact, setCompact] = useState(false);
  const host = useRef<HTMLDivElement>(null);
  const visibleMode = presentation ? "preview" : mode;
  useEffect(() => {
    const observer = new ResizeObserver(([entry]) => {
      setNarrow(entry.contentRect.width < 640);
      setCompact(entry.contentRect.width < 240);
    });
    if (host.current) observer.observe(host.current);
    return () => observer.disconnect();
  }, []);
  const modes = [
    { value: "preview", title: previewTitle ?? (image ? tr("图片") : tr("预览")), Icon: image ? ImageIcon : Eye },
    { value: "source", title: tr("源码"), Icon: Code2 },
    { value: "split", title: tr("分屏"), Icon: Columns2 },
  ] as const;
  const orderedModes = sourceFirst ? [modes[1], modes[0], modes[2]] : modes;
  return <div ref={host} className={`svg-editor${narrow ? " preview-editor-narrow" : ""}${compact ? " preview-editor-compact" : ""}`}>
    {!presentation && <div className="svg-editor-toolbar">
      <span className="svg-editor-status" role="status">
        {visibleMode === "split" ? tr("实时预览") : visibleMode === "source" ? tr("{{0}} 源码", { 0: label }) : previewTitle ? tr("{{0}} · 只读", { 0: label }) : tr("{{0}}预览", { 0: label })}
        {pending && tr(" · 更新中…")}
      </span>
      <div className="preview-editor-actions">{actions}{visibleMode !== "source" && previewActions}
        <div className="svg-editor-modes" role="group" aria-label={tr("{{0}} 显示模式", { 0: label })}>
          {orderedModes.filter(({ value }) => allowSplit || value !== "split").map(({ value, title, Icon }) => <button key={value} type="button"
            aria-pressed={mode === value} title={title} aria-label={title} onClick={() => setMode(value)}>
            <Icon size={13} strokeWidth={1.75} /><span>{title}</span>
          </button>)}
        </div>
      </div>
    </div>}
    {!presentation && visibleMode !== "preview" && sourceActions &&
      <div className="preview-editor-source-actions">{sourceActions}</div>}
    {error && <div className="svg-editor-error" role="alert"><span>{error}</span>
      {stale && <span>{tr("当前保留上一次有效预览（已过期）")}</span>}
    </div>}
    <div className={`svg-editor-panes svg-editor-${visibleMode === "preview" ? "image" : visibleMode}`}>
      <div className="svg-editor-source" hidden={visibleMode === "preview"}>
        <CodeMirrorEditor active={visibleMode !== "preview"} />
      </div>
      <div className="svg-editor-preview" hidden={visibleMode === "source"} aria-label={tr("{{0}}预览", { 0: label })}>
        {typeof children === "function" ? children(mode, setMode) : children}
      </div>
    </div>
  </div>;
}
