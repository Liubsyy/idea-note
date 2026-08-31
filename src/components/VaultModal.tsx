import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { KeyRound, Lock, X } from "lucide-react";

import { emit } from "@tauri-apps/api/event";

import { VAULT_EVENT, useVaultStore } from "../store/useVaultStore";
import { vaultInit, vaultUnlock, vaultErrorMessage } from "../lib/crypto/vault";

/**
 * Unlocking a workspace's encrypted content, and setting it up the first time.
 *
 * The setup path has one rule that isn't negotiable: the recovery code is shown
 * exactly once, and the user has to confirm they saved it before the dialog
 * will close. Losing both the password and the code means the notes are gone —
 * there is no reset, no backup key and nobody to appeal to — so the moment of
 * generating it is the only chance to make that concrete.
 */
export function VaultModal() {
  const request = useVaultStore((s) => s.unlockRequest);
  const close = useVaultStore((s) => s.closeUnlockRequest);
  const refresh = useVaultStore((s) => s.refresh);

  const [secret, setSecret] = useState("");
  const [confirmSecret, setConfirmSecret] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [recoveryCode, setRecoveryCode] = useState<string | null>(null);
  const [acknowledged, setAcknowledged] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (!request) return;
    setSecret("");
    setConfirmSecret("");
    setError(null);
    setBusy(false);
    setRecoveryCode(null);
    setAcknowledged(false);
    const timer = window.setTimeout(() => inputRef.current?.focus(), 30);
    return () => window.clearTimeout(timer);
  }, [request]);

  useEffect(() => {
    if (!request) return;
    const onKey = (e: KeyboardEvent) => {
      // Escape can't dismiss the recovery-code step: that is the one screen
      // where closing early loses something unrecoverable.
      if (e.key === "Escape" && !recoveryCode) close(false);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [request, recoveryCode, close]);

  if (!request) return null;
  const isInit = request.mode === "init";

  const cancel = () => {
    if (recoveryCode) return;
    close(false);
  };

  const submit = async () => {
    if (busy) return;
    setError(null);
    if (isInit && secret !== confirmSecret) {
      setError("两次输入的口令不一致。");
      return;
    }
    setBusy(true);
    try {
      if (isInit) {
        const { recoveryCode: code } = await vaultInit(request.workspace, secret);
        await refresh(request.workspace);
        emit(VAULT_EVENT, { workspace: request.workspace }).catch(() => {});
        // Stay open on the recovery code; the promise resolves when it's saved.
        setRecoveryCode(code);
        setBusy(false);
        return;
      }
      await vaultUnlock(request.workspace, secret);
      await refresh(request.workspace);
      emit(VAULT_EVENT, { workspace: request.workspace }).catch(() => {});
      close(true);
    } catch (e) {
      setError(vaultErrorMessage(e));
      setBusy(false);
    }
  };

  const finishInit = () => {
    if (!acknowledged) return;
    setRecoveryCode(null);
    close(true);
  };

  const title = recoveryCode
    ? "请保存恢复码"
    : isInit
      ? "为这个工作区设置加密口令"
      : "解锁加密内容";

  const modal = (
    <div
      className="fixed inset-0 z-[60] flex items-start justify-center backdrop-blur-sm"
      style={{ background: "rgba(0,0,0,0.32)" }}
      onMouseDown={cancel}
    >
      <div
        className="mt-32 w-[420px] rounded-xl p-4"
        style={{
          maxWidth: "calc(100% - 32px)",
          background: "var(--bg-elev)",
          border: "1px solid var(--border)",
          boxShadow: "0 18px 54px var(--shadow)",
        }}
        onMouseDown={(e) => e.stopPropagation()}
      >
        <div className="flex items-start gap-3">
          <div
            className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg"
            style={{
              background: "color-mix(in srgb, var(--accent) 14%, transparent)",
              color: "var(--accent)",
            }}
          >
            {recoveryCode ? <KeyRound size={18} /> : <Lock size={18} />}
          </div>
          <div className="min-w-0 flex-1">
            <div className="text-sm font-semibold" style={{ color: "var(--text)" }}>
              {title}
            </div>
            <p
              className="m-0 mt-1 text-sm leading-relaxed"
              style={{ color: "var(--text-soft)" }}
            >
              {recoveryCode
                ? "忘记口令时，这串恢复码是唯一的入口。抄到密码管理器或纸上，它只显示这一次。"
                : isInit
                  ? "口令用来保护这个工作区里的加密内容。它不会被存到任何地方，也无法找回——所以请选一个你不会忘的。"
                  : "输入口令或恢复码，即可查看和编辑这篇笔记里的加密内容。"}
            </p>
          </div>
          {!recoveryCode && (
            <button
              onClick={cancel}
              className="flex h-7 w-7 shrink-0 items-center justify-center rounded-md transition-colors"
              style={{ color: "var(--text-muted)" }}
              title="取消"
            >
              <X size={15} />
            </button>
          )}
        </div>

        {recoveryCode ? (
          <>
            <div
              className="mt-4 select-all rounded-lg px-3 py-3 text-center text-sm tracking-[0.14em]"
              style={{
                background: "var(--code-bg)",
                border: "1px solid var(--border)",
                color: "var(--text)",
                fontFamily: "var(--font-mono, monospace)",
              }}
            >
              {recoveryCode}
            </div>
            <label
              className="mt-3 flex cursor-pointer items-start gap-2 text-xs leading-relaxed"
              style={{ color: "var(--text-soft)" }}
            >
              <input
                type="checkbox"
                className="mt-0.5"
                checked={acknowledged}
                onChange={(e) => setAcknowledged(e.target.checked)}
              />
              <span>
                我已经保存好恢复码。我明白同时丢失口令和恢复码，这些加密内容将永远无法恢复。
              </span>
            </label>
          </>
        ) : (
          <div className="mt-4 flex flex-col gap-2">
            <input
              ref={inputRef}
              type="password"
              value={secret}
              disabled={busy}
              placeholder={isInit ? "设置口令" : "口令或恢复码"}
              onChange={(e) => setSecret(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") void submit();
              }}
              className="w-full rounded-md px-3 py-2 text-sm outline-none transition-opacity"
              style={{
                background: "var(--bg)",
                border: "1px solid var(--border)",
                color: "var(--text)",
                opacity: busy ? 0.6 : 1,
              }}
            />
            {isInit && (
              <input
                type="password"
                value={confirmSecret}
                disabled={busy}
                placeholder="再次输入口令"
                onChange={(e) => setConfirmSecret(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") void submit();
                }}
                className="w-full rounded-md px-3 py-2 text-sm outline-none"
                style={{
                  background: "var(--bg)",
                  border: "1px solid var(--border)",
                  color: "var(--text)",
                }}
              />
            )}
          </div>
        )}

        {busy && !recoveryCode && (
          <div className="mt-3">
            <div
              className="h-[2px] w-full overflow-hidden rounded-full"
              style={{ background: "var(--border)" }}
            >
              <div className="vault-progress h-full w-1/3 rounded-full" />
            </div>
            <div className="mt-2 text-[11px]" style={{ color: "var(--text-muted)" }}>
              正在派生密钥…整个过程依赖内存和计算，难以暴力破解
            </div>
          </div>
        )}

        {error && (
          <div className="mt-3 text-xs" style={{ color: "#e5484d" }}>
            {error}
          </div>
        )}

        <div className="mt-5 flex justify-end gap-2">
          {!recoveryCode && (
            <button
              onClick={cancel}
              disabled={busy}
              className="rounded-md px-3.5 py-1.5 text-sm transition-colors"
              style={{ color: "var(--text-muted)" }}
            >
              取消
            </button>
          )}
          <button
            onClick={() => (recoveryCode ? finishInit() : void submit())}
            disabled={busy || (recoveryCode ? !acknowledged : !secret)}
            className="rounded-md px-3.5 py-1.5 text-sm font-medium text-white transition-opacity"
            style={{
              background: "var(--accent)",
              opacity:
                busy || (recoveryCode ? !acknowledged : !secret) ? 0.55 : 1,
            }}
          >
            {busy ? "校验中…" : recoveryCode ? "完成" : isInit ? "设置口令" : "解锁"}
          </button>
        </div>
      </div>
    </div>
  );

  return createPortal(modal, document.body);
}
