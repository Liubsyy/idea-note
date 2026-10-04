/** Build an isolated preview copy. The user's source is never rewritten. */
export function buildHtmlPreview(source: string, baseUrl: string, token: string): string {
  const doc = new DOMParser().parseFromString(source, "text/html");
  doc.querySelectorAll("base, meta[http-equiv]").forEach(node => {
    if (node.tagName === "BASE" || /^(content-security-policy|refresh)$/i.test(node.getAttribute("http-equiv") ?? "")) node.remove();
  });
  // Explicit remote origins only: a blanket http: policy would also expose
  // Tauri's http://asset.localhost mapping on Windows.
  const origins = new Set<string>();
  const consider = (raw: string) => {
    try {
      const url = new URL(raw, "https://invalid.localhost");
      const host = url.hostname.replace(/\.+$/, "");
      if (!/^https?:$/.test(url.protocol) || host === "localhost" || host.endsWith(".localhost")) return;
      origins.add(url.origin);
    } catch { /* relative/invalid URLs are handled by the scoped base */ }
  };
  for (const match of source.matchAll(/https?:\/\/[^\s"'<>`\\)]+/gi)) consider(match[0]);
  doc.querySelectorAll("[src], [href]").forEach(el => {
    const value = el.getAttribute("src") ?? el.getAttribute("href") ?? "";
    if (value.startsWith("//")) consider(`https:${value}`);
  });
  const root = new URL(baseUrl);
  root.pathname = `/${root.pathname.split("/")[1]}/`;
  const resources = [root.href, ...origins].join(" ");
  const csp = doc.createElement("meta");
  csp.httpEquiv = "Content-Security-Policy";
  csp.content = `default-src 'none'; script-src 'unsafe-inline' ${resources}; style-src 'unsafe-inline' ${resources}; img-src data: blob: ${resources}; font-src data: ${resources}; media-src data: blob: ${resources}; connect-src ${resources}; base-uri ${root.href}; form-action 'none'; frame-src 'none'; object-src 'none'`;
  const base = doc.createElement("base");
  base.href = baseUrl;
  const charset = doc.createElement("meta");
  charset.setAttribute("charset", "utf-8");
  const script = doc.createElement("script");
  script.textContent = `(() => {
    const send = (message) => parent.postMessage({type:'idea-note-preview', token:${JSON.stringify(token)}, message:String(message).slice(0,600)}, '*');
    addEventListener('error', event => {
      if (event.target !== window) send('资源加载失败：' + (event.target.getAttribute?.('src') || event.target.getAttribute?.('href') || event.target.tagName));
      else send('脚本错误：' + event.message + (event.lineno ? '（第 ' + event.lineno + ' 行）' : ''));
    }, true);
    addEventListener('unhandledrejection', event => send('脚本错误：' + String(event.reason)));
    addEventListener('securitypolicyviolation', event => send('预览已阻止不允许的资源：' + event.blockedURI));
    addEventListener('load', () => parent.postMessage({type:'idea-note-preview-ready', token:${JSON.stringify(token)}}, '*'), {once:true});
  })();`;
  doc.head.prepend(charset, csp, base, script);
  return `<!doctype html>\n${doc.documentElement.outerHTML}`;
}
