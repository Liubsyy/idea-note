import { useEffect, useRef, useState } from "react";
import { KeyRound } from "lucide-react";
import { useAppStore } from "../store/useAppStore";

export function GitCredentialModal() {
  const prompt = useAppStore((s) => s.gitCredentialPrompt);
  const closeGitCredentialPrompt = useAppStore((s) => s.closeGitCredentialPrompt);

  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [remember, setRemember] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const usernameRef = useRef<HTMLInputElement>(null);
  const passwordRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (!prompt) return;
    setUsername(prompt.defaultUsername);
    setPassword("");
    setRemember(true);
    setError(null);
    const id = requestAnimationFrame(() => {
      (prompt.defaultUsername ? passwordRef : usernameRef).current?.focus();
    });
    return () => cancelAnimationFrame(id);
  }, [prompt]);

  if (!prompt) return null;

  const submit = () => {
    const user = username.trim();
    if (!user) {
      setError("请填写用户名");
      usernameRef.current?.focus();
      return;
    }
    if (!password) {
      setError("请填写访问令牌或密码");
      passwordRef.current?.focus();
      return;
    }
    prompt.onSubmit({ username: user, password, remember });
  };

  return (
    <div
      className="fixed inset-0 z-[70] flex items-start justify-center"
      style={{ background: "rgba(0,0,0,0.35)" }}
      onMouseDown={closeGitCredentialPrompt}
    >
      <div
        className="mt-28 w-[420px] max-w-[calc(100vw-32px)] rounded-xl p-4"
        style={{
          background: "var(--bg-elev)",
          border: "1px solid var(--border)",
          boxShadow: "0 12px 40px var(--shadow)",
        }}
        onMouseDown={(e) => e.stopPropagation()}
      >
        <div className="mb-3 flex items-center gap-2">
          <KeyRound size={16} style={{ color: "var(--accent)" }} />
          <div className="min-w-0">
            <div className="text-sm font-semibold" style={{ color: "var(--text)" }}>
              远程仓库凭据
            </div>
            <div className="truncate text-[11px]" style={{ color: "var(--text-muted)" }}>
              {prompt.remoteUrl}
            </div>
          </div>
        </div>

        <div className="mb-3 text-[12px]" style={{ color: "var(--text-muted)" }}>
          {prompt.message}。请输入 HTTPS 仓库用户名和访问令牌。
        </div>

        <div className="space-y-2">
          <label className="block">
            <div className="mb-1 text-[12px]" style={{ color: "var(--text-soft)" }}>
              用户名
            </div>
            <input
              ref={usernameRef}
              value={username}
              onChange={(e) => setUsername(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") {
                  e.preventDefault();
                  passwordRef.current?.focus();
                } else if (e.key === "Escape") {
                  e.preventDefault();
                  closeGitCredentialPrompt();
                }
              }}
              className="w-full rounded-md px-2.5 py-1.5 text-sm outline-none"
              style={{
                background: "var(--bg)",
                border: "1px solid var(--border)",
                color: "var(--text)",
              }}
            />
          </label>

          <label className="block">
            <div className="mb-1 text-[12px]" style={{ color: "var(--text-soft)" }}>
              访问令牌 / 密码
            </div>
            <input
              ref={passwordRef}
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") {
                  e.preventDefault();
                  submit();
                } else if (e.key === "Escape") {
                  e.preventDefault();
                  closeGitCredentialPrompt();
                }
              }}
              className="w-full rounded-md px-2.5 py-1.5 text-sm outline-none"
              style={{
                background: "var(--bg)",
                border: `1px solid ${error ? "#e5484d" : "var(--border)"}`,
                color: "var(--text)",
              }}
            />
          </label>

          <label className="flex select-none items-center gap-2 pt-1 text-[12px]" style={{ color: "var(--text-soft)" }}>
            <input
              type="checkbox"
              checked={remember}
              onChange={(e) => setRemember(e.target.checked)}
            />
            保存到系统 Git 凭据管理器
          </label>
        </div>

        {error && (
          <div className="mt-2 text-xs" style={{ color: "#e5484d" }}>
            {error}
          </div>
        )}

        <div className="mt-4 flex justify-end gap-2">
          <button
            onClick={closeGitCredentialPrompt}
            className="rounded-md px-3 py-1.5 text-sm transition-colors"
            style={{ color: "var(--text-muted)" }}
          >
            取消
          </button>
          <button
            onClick={submit}
            className="rounded-md px-3 py-1.5 text-sm font-medium text-white"
            style={{ background: "var(--accent)" }}
          >
            重试
          </button>
        </div>
      </div>
    </div>
  );
}
