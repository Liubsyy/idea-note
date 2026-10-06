import { tr } from "../../i18n/core.ts";
import { useLanguage } from "../../i18n/react";
import { useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { LoaderCircle, RefreshCw } from "lucide-react";
import { useAppStore } from "../../store/useAppStore";
import { buildHtmlPreview } from "../../lib/htmlPreviewDocument";
import { PreviewEditor } from "./PreviewEditor";

interface PreviewSession { sessionId: string; baseUrl: string }

/** Mount only after selecting preview/split. Source mode owns no resource session. */
export function HtmlEditor({ path }: { path: string }) {
  useLanguage();
  const [refresh, setRefresh] = useState(0);
  return <PreviewEditor label="HTML" defaultMode="source" sourceFirst previewActions={
    <button type="button" className="preview-editor-refresh" title={tr("刷新预览")} aria-label={tr("刷新预览")}
      onClick={() => setRefresh(n => n + 1)}><RefreshCw size={14} /></button>
  }>
    {(mode, selectMode) => mode === "source" ?
      <div className="svg-editor-placeholder">{tr("点击预览或分屏后加载页面")}</div> :
      <HtmlPreview key={`${path}:${refresh}`} path={path} onCancel={() => selectMode("source")}
        onRetry={() => setRefresh(n => n + 1)} />}
  </PreviewEditor>;
}

function HtmlPreview({ path, onCancel, onRetry }: { path: string; onCancel: () => void; onRetry: () => void }) {
  useLanguage();
  const content = useAppStore(s => s.content);
  const workspace = useAppStore(s => s.workspacePath);
  const frame = useRef<HTMLIFrameElement>(null);
  const [session, setSession] = useState<PreviewSession | null>(null);
  const [previewDocument, setPreviewDocument] = useState<{ html: string; token: string } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(true);
  const [slow, setSlow] = useState(false);
  const expectedToken = useRef<string | null>(null);
  const rendered = useRef(false);

  useEffect(() => {
    let disposed = false;
    let current: PreviewSession | null = null;
    setSession(null);
    setPreviewDocument(null);
    setPending(true);
    setError(null);
    expectedToken.current = null;
    const close = (s: PreviewSession) => void invoke("close_preview_session", { sessionId: s.sessionId }).catch(() => {});
    void invoke<PreviewSession>("create_preview_session", { path, workspaceRoot: workspace }).then(next => {
      if (disposed) { close(next); return; }
      current = next;
      setSession(next);
    }).catch(reason => {
      if (!disposed) { setError(tr("无法加载预览资源：{{0}}", { 0: String(reason) })); setPending(false); }
    });
    return () => { disposed = true; expectedToken.current = null; if (current) close(current); };
  }, [path, workspace]);

  useEffect(() => {
    if (!session) return;
    setPending(true);
    setSlow(false);
    setError(null);
    // Invalidate the old document immediately, even during the debounce window.
    expectedToken.current = null;
    let firstPaint = 0, secondPaint = 0;
    const timer = setTimeout(() => {
      // Let the loading surface paint before synchronous DOM parsing and navigation.
      firstPaint = requestAnimationFrame(() => {
        secondPaint = requestAnimationFrame(() => {
          try {
            const token = crypto.randomUUID();
            const html = buildHtmlPreview(content, session.baseUrl, token);
            expectedToken.current = token;
            setPreviewDocument({ html, token });
            rendered.current = true;
          } catch (reason) {
            setError(tr("无法渲染预览：{{0}}", { 0: String(reason) }));
            setPending(false);
          }
        });
      });
    }, rendered.current ? 300 : 0);
    return () => {
      clearTimeout(timer);
      cancelAnimationFrame(firstPaint);
      cancelAnimationFrame(secondPaint);
      expectedToken.current = null;
    };
  }, [content, session]);

  useEffect(() => {
    if (!pending) { setSlow(false); return; }
    const timer = setTimeout(() => setSlow(true), 8000);
    return () => clearTimeout(timer);
  }, [pending, previewDocument?.token]);

  useEffect(() => {
    const receive = (event: MessageEvent) => {
      if (!expectedToken.current || event.source !== frame.current?.contentWindow ||
          event.data?.token !== expectedToken.current) return;
      if (event.data.type === "idea-note-preview-ready") setPending(false);
      else if (event.data.type === "idea-note-preview" && typeof event.data.message === "string")
        setError(event.data.message.slice(0, 600));
    };
    window.addEventListener("message", receive);
    return () => window.removeEventListener("message", receive);
  }, []);

  return <div className="html-preview-container" aria-busy={pending}>
    {error && <div className="svg-editor-error" role="alert">{error}</div>}
    <div className="html-preview-stage">
      {previewDocument && <iframe key={previewDocument.token} ref={frame} className="html-file-preview" title={tr("HTML 页面预览")}
        sandbox="allow-scripts" referrerPolicy="no-referrer" srcDoc={previewDocument.html} />}
      {pending && <div className="html-preview-loading">
        <LoaderCircle className="html-preview-spinner" size={26} aria-hidden="true" />
        <span role="status">{slow ? tr("页面加载较慢，仍在等待资源…") : tr("正在加载预览…")}</span>
        <div className="html-preview-loading-actions">
          <button type="button" onClick={onCancel}>{tr("返回源码")}</button>
          {slow && <button type="button" onClick={onRetry}>{tr("重试加载")}</button>}
        </div>
      </div>}
      {!pending && !previewDocument && <div className="html-preview-loading">
        <span>{tr("预览未能加载")}</span>
        <div className="html-preview-loading-actions">
          <button type="button" onClick={onCancel}>{tr("返回源码")}</button>
          <button type="button" onClick={onRetry}>{tr("重试加载")}</button>
        </div>
      </div>}
    </div>
  </div>;
}
