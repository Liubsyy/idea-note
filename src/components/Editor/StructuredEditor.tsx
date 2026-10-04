import { useEffect, useRef, useState } from "react";
import { AlignLeft } from "lucide-react";
import { isolateHistory } from "@codemirror/commands";
import { useAppStore } from "../../store/useAppStore";
import { formatStructured, type StructuredKind } from "../../lib/structuredPreview";
import { getActiveView } from "../../lib/codemirror/activeView";
import { PreviewEditor } from "./PreviewEditor";
import { FormattedCodeView } from "./FormattedCodeView";

export function StructuredEditor({ kind }: { kind: StructuredKind }) {
  const content = useAppStore(s => s.content);
  const [result, setResult] = useState(() => formatStructured(content, kind));
  const [pending, setPending] = useState(false);
  const [formatError, setFormatError] = useState<string | null>(null);
  const parsed = useRef(content);
  useEffect(() => {
    setFormatError(null);
    if (content === parsed.current) { setPending(false); return; }
    setPending(true);
    const timer = setTimeout(() => {
      const next = formatStructured(content, kind);
      setResult(previous => next.error ? { ...previous, error: next.error } : next);
      parsed.current = content;
      setPending(false);
    }, 300);
    return () => clearTimeout(timer);
  }, [content, kind]);

  const formatSource = () => {
    const view = getActiveView();
    if (!view || view.state.readOnly) return;
    const source = view.state.doc.toString();
    const next = formatStructured(source, kind);
    setFormatError(next.error);
    if (next.text === null) return;
    if (next.text === source) {
      useAppStore.getState().showToast("源码格式已规范", "success");
      return;
    }
    view.dispatch({
      changes: { from: 0, to: view.state.doc.length, insert: next.text },
      annotations: isolateHistory.of("full"),
      userEvent: "input.format",
    });
    view.focus();
  };

  return <PreviewEditor label={kind.toUpperCase()} previewTitle="格式化视图" allowSplit={false}
    pending={pending} error={formatError ?? result.error} stale={result.text !== null}
    sourceActions={<button type="button" className="structured-format-source" onClick={formatSource}
      title="格式化源码（可撤销，保存后写入文件）" aria-label="格式化源码">
      <AlignLeft size={13} /><span>格式化源码</span>
    </button>}>
    {result.text !== null ? <FormattedCodeView text={result.text} kind={kind} /> :
      <div className="svg-editor-placeholder">修正源码后将自动显示格式化视图</div>}
  </PreviewEditor>;
}
