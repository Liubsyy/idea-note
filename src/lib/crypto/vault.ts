// Typed wrappers around the vault / block commands in src-tauri/src/crypto.rs.
//
// Nothing here ever holds key material: the master key stays in Rust for the
// life of the session, and these calls trade plaintext for ciphertext across
// the IPC boundary. If a function in this file ever grows a return type
// containing a key, that is the bug.

import { invoke } from "@tauri-apps/api/core";

/** Error codes crypto.rs returns as bare strings, for switching on. Anything
 *  else is an IO or parse detail meant for a toast. */
export type VaultErrorCode =
  | "locked"
  | "unknown_key"
  | "tampered"
  | "bad_format"
  | "wrong_secret"
  | "not_initialized"
  | "already_initialized";

const CODES = new Set<string>([
  "locked",
  "unknown_key",
  "tampered",
  "bad_format",
  "wrong_secret",
  "not_initialized",
  "already_initialized",
]);

/** The error code in a rejected command, or null when it failed for some other
 *  reason (a broken vault.json, a disk error). */
export function vaultErrorCode(error: unknown): VaultErrorCode | null {
  const text = typeof error === "string" ? error : String(error ?? "");
  return CODES.has(text) ? (text as VaultErrorCode) : null;
}

/** A readable message for any vault failure, code or not. */
export function vaultErrorMessage(error: unknown): string {
  const code = vaultErrorCode(error);
  switch (code) {
    case "locked":
      return "加密内容已上锁，请先解锁。";
    case "unknown_key":
      return "这个块由其他密钥加密，当前口令打不开。";
    case "tampered":
      return "这个块已损坏或被篡改，无法解密。";
    case "bad_format":
      return "加密块格式无法识别。";
    case "wrong_secret":
      return "口令或恢复码不正确。";
    case "not_initialized":
      return "当前工作区还没有设置加密口令。";
    case "already_initialized":
      return "当前工作区已经设置过加密口令。";
    default:
      return typeof error === "string" ? error : String(error ?? "未知错误");
  }
}

export interface SlotInfo {
  id: string;
  kind: "password" | "recovery" | string;
  label: string;
  keyId: string;
  createdAt: number;
}

export interface VaultStatus {
  initialized: boolean;
  locked: boolean;
  activeKeyId: string;
  slots: SlotInfo[];
  /** -1 = drop the key as soon as the work needing it is done, 0 = never,
   *  >0 = minutes of disuse. */
  ttlMinutes: number;
  /** Seconds left on that timer, so the UI can schedule one re-check instead
   *  of polling. Null while locked or when expiry is off. */
  expiresInSecs: number | null;
}

export interface EncryptResult {
  body: string;
  keyId: string;
  v: number;
}

export interface EncryptedBlock extends EncryptResult {
  blockId: string;
}

export interface DecryptResult {
  plaintext: string;
}

export const vaultStatus = (workspace: string) =>
  invoke<VaultStatus>("vault_status", { workspace });

export const vaultInit = (workspace: string, password: string) =>
  invoke<{ recoveryCode: string }>("vault_init", { workspace, password });

/** `secret` is either the password or the recovery code — crypto.rs tries every
 *  slot, so the caller doesn't have to know which one the user typed. */
export const vaultUnlock = (workspace: string, secret: string) =>
  invoke<void>("vault_unlock", { workspace, secret });

export const vaultLock = () => invoke<void>("vault_lock");

/** Change how long the key may sit in memory. -1 = immediate, 0 = never. */
export const vaultSetTtl = (minutes: number) =>
  invoke<void>("vault_set_ttl", { minutes });

export const vaultChangePassword = (
  workspace: string,
  oldSecret: string,
  newPassword: string,
) => invoke<void>("vault_change_password", { workspace, oldSecret, newPassword });

export const secretEncrypt = (blockId: string, plaintext: string) =>
  invoke<EncryptResult>("secret_encrypt", { blockId, plaintext });

/** Encrypt several blocks in one command. A save is one operation to the user
 *  and has to be one operation to the key as well: with "立即过期" the key is
 *  dropped when a command finishes, so per-block calls would mean one password
 *  prompt per block for a single Ctrl+S. */
export const secretEncryptBatch = (
  blocks: { blockId: string; plaintext: string }[],
) => invoke<EncryptedBlock[]>("secret_encrypt_batch", { blocks });

/** Fields are passed structurally, not as markdown: the Rust side rebuilds the
 *  AAD from these three values and never sees a fence line. */
export const secretDecrypt = (args: {
  v: number;
  keyId: string;
  blockId: string;
  body: string;
}) => invoke<DecryptResult>("secret_decrypt", args);
