// Session state for encrypted blocks.
//
// Two things live here, and neither may ever reach the disk:
//
//   1. Decrypted plaintext, keyed by file path + block id. It is deliberately
//      NOT held on the widget instance: CodeMirror rebuilds block widgets
//      whenever the decoration set changes (tab switch, theme change, any edit
//      above), and plaintext hanging off an instance would vanish with it —
//      the same reason ```input block values live in useInputStore.
//
//   2. The plaintext as it was last encrypted, so a save can tell whether the
//      user actually changed anything by comparing the two strings.
//      Re-encrypting unchanged text would draw a fresh nonce, rewrite the
//      block, and hand every other device a conflict in unreadable ciphertext.
//
// The master key is never here. It stays in Rust for the life of the unlock.

import { emit, listen } from "@tauri-apps/api/event";
import { create } from "zustand";

import {
  vaultLock,
  vaultSetTtl,
  vaultStatus,
  type VaultStatus,
} from "../lib/crypto/vault";

/** One decrypted block.
 *
 *  `body` records which ciphertext this entry came from, so a duplicated block
 *  id (the user copied the block) can't serve the wrong text. `saved` is the
 *  plaintext that ciphertext holds and `draft` is what the editor shows now;
 *  they differ exactly when the block needs re-encrypting, which is the whole
 *  "don't rewrite an unchanged block" test. */
export interface SecretEntry {
  body: string;
  saved: string;
  draft: string;
}

/** A pending unlock dialog. Resolved by VaultUnlockModal. */
export interface UnlockRequest {
  workspace: string;
  /** "init" when the workspace has no vault yet and one must be created. */
  mode: "unlock" | "init";
  resolve: (unlocked: boolean) => void;
}

/** Broadcast when one workspace's vault is created, unlocked, locked or
 *  re-keyed. Every webview has its own copy of this store, while Rust keeps
 *  independent sessions keyed by workspace. */
export const VAULT_EVENT = "vault-changed";

/** Asks the main window to lock. Locking has to happen *there* because pending
 *  plaintext lives in its editor, and it must be encrypted back into the
 *  document before the keys go away — the settings window has no editor to
 *  flush, so it can only ask. */
export const VAULT_LOCK_REQUEST = "vault-lock-request";

/** Settings asks every main window to prove its matching workspace buffer is
 * clean, then hold it read-only for one MK rotation operation. */
export const VAULT_ROTATION_PREPARE = "vault-rotation:prepare";
export const VAULT_ROTATION_ACK = "vault-rotation:ack";
export const VAULT_ROTATION_END = "vault-rotation:end";

export interface VaultRotationPrepare {
  operation: string;
  workspace: string;
  targets: string[];
}

export interface VaultRotationAck {
  operation: string;
  window: string;
  matches: boolean;
  ready: boolean;
  reason?: string;
}

export interface VaultRotationEnd {
  operation: string;
  workspace: string;
  reload: boolean;
}

export const secretKey = (filePath: string, blockId: string) =>
  `${filePath} ${blockId}`;

interface VaultStoreState {
  status: VaultStatus | null;
  /** Workspace `status` describes. */
  workspace: string;
  entries: Record<string, SecretEntry>;
  /** Bumped on every change so editor decorations rebuild. */
  rev: number;
  unlockRequest: UnlockRequest | null;

  refresh: (workspace: string) => Promise<VaultStatus | null>;
  /** Open the vault if it isn't already, prompting when needed. Resolves false
   *  when the user backs out. */
  ensureUnlocked: (workspace: string) => Promise<boolean>;
  lock: () => Promise<void>;
  /** Push a new key lifetime down to Rust. 0 disables expiry. */
  setTtlMinutes: (minutes: number) => Promise<void>;
  closeUnlockRequest: (unlocked: boolean) => void;

  remember: (key: string, entry: SecretEntry) => void;
  /** Record a keystroke in the nested editor. Never dispatches a document
   *  transaction — the main buffer keeps holding ciphertext until a flush. */
  setDraft: (key: string, draft: string) => void;
  recall: (key: string, body: string) => SecretEntry | null;
  forget: (key: string) => void;
  /**
   * Drop revealed plaintext that has nothing unsaved in it.
   *
   * Entries with pending edits are deliberately kept: the key going away is
   * not a reason to throw away what someone typed, and that text is already on
   * their screen. They stay open, and the next save asks for the password.
   * Pass a file path to limit it to one note.
   */
  sealClean: (filePath?: string) => void;
  forgetFile: (filePath: string) => void;
}

// One pending re-check, scheduled for the moment the key is due to expire.
// Rust owns an independent expiry worker and drops the key at the deadline
// whether or not anything here fires. This timer exists only so the UI notices
// promptly and stops showing an unlocked padlock.
let expiryTimer: number | undefined;

/** Keep only the entries holding text that has not been encrypted yet. Used by
 *  the explicit hide actions, never by a plain status refresh. */
const keepUnsaved = (
  entries: Record<string, SecretEntry>,
): Record<string, SecretEntry> =>
  Object.fromEntries(
    Object.entries(entries).filter(([, e]) => e.draft !== e.saved),
  );

function scheduleExpiryCheck(status: VaultStatus | null, recheck: () => void) {
  window.clearTimeout(expiryTimer);
  expiryTimer = undefined;
  if (!status || status.locked || status.expiresInSecs === null) return;
  // A second of slack so the re-check lands after Rust considers it expired.
  expiryTimer = window.setTimeout(recheck, (status.expiresInSecs + 1) * 1000);
}

export const useVaultStore = create<VaultStoreState>((set, get) => ({
  status: null,
  workspace: "",
  entries: {},
  rev: 0,
  unlockRequest: null,

  refresh: async (workspace) => {
    if (!workspace) {
      set({ status: null, workspace: "" });
      return null;
    }
    try {
      const status = await vaultStatus(workspace);
      set((s) => ({
        status,
        workspace,
        rev: s.rev + 1,
        // The key expiring does NOT take back what is already on screen.
        //
        // "The vault is locked" and "this block should be hidden" are two
        // different facts, and conflating them broke immediate expiry outright:
        // there the key is gone the instant it is used, so a revealed block was
        // wiped a moment after it appeared. Hiding plaintext is driven by
        // explicit actions instead — sealing a block, locking by hand, closing
        // the note. Switching workspace still drops everything: those entries
        // belong to another vault.
        ...(workspace !== s.workspace ? { entries: {} } : {}),
      }));
      scheduleExpiryCheck(status, () => {
        void get().refresh(workspace);
      });
      return status;
    } catch {
      // A broken vault.json is reported where it is acted on, not here — this
      // path runs on every workspace open and must stay quiet.
      set({ status: null, workspace });
      return null;
    }
  },

  ensureUnlocked: async (workspace) => {
    if (!workspace) return false;
    const status = await get().refresh(workspace);
    if (status && !status.locked) return true;
    // One dialog at a time: a second block asking while the first is open would
    // orphan the earlier promise.
    if (get().unlockRequest) return false;
    return new Promise<boolean>((resolve) => {
      set({
        unlockRequest: {
          workspace,
          mode: status?.initialized ? "unlock" : "init",
          resolve,
        },
      });
    });
  },

  setTtlMinutes: async (minutes) => {
    await vaultSetTtl(minutes);
    const { workspace } = get();
    if (workspace) await get().refresh(workspace);
  },

  lock: async () => {
    window.clearTimeout(expiryTimer);
    const { workspace } = get();
    if (!workspace) return;
    await vaultLock(workspace);
    // Callers flush first, but the user may have declined the password prompt.
    // Their text stays.
    set((s) => ({ entries: keepUnsaved(s.entries), rev: s.rev + 1 }));
    if (workspace) await get().refresh(workspace);
    emit(VAULT_EVENT, { workspace }).catch(() => {});
  },

  closeUnlockRequest: (unlocked) => {
    const request = get().unlockRequest;
    if (!request) return;
    set({ unlockRequest: null });
    request.resolve(unlocked);
  },

  remember: (key, entry) =>
    set((s) => ({ entries: { ...s.entries, [key]: entry }, rev: s.rev + 1 })),

  setDraft: (key, draft) =>
    set((s) => {
      const entry = s.entries[key];
      if (!entry || entry.draft === draft) return s;
      // `rev` is deliberately not bumped: it drives editor rebuilds, and
      // rebuilding on every keystroke would tear down the nested editor the
      // user is typing in.
      return { entries: { ...s.entries, [key]: { ...entry, draft } } };
    }),

  recall: (key, body) => {
    const entry = get().entries[key];
    // A block id can legitimately appear twice (the user copied the block), so
    // the ciphertext has to match too — otherwise one of them would show the
    // other's plaintext.
    if (!entry || entry.body !== body) return null;
    return entry;
  },

  sealClean: (filePath) =>
    set((s) => {
      const prefix = filePath ? `${filePath} ` : null;
      const entries = Object.fromEntries(
        Object.entries(s.entries).filter(
          ([key, entry]) =>
            (prefix !== null && !key.startsWith(prefix)) ||
            entry.draft !== entry.saved,
        ),
      );
      return { entries, rev: s.rev + 1 };
    }),

  forget: (key) =>
    set((s) => {
      if (!(key in s.entries)) return s;
      const { [key]: _dropped, ...entries } = s.entries;
      return { entries, rev: s.rev + 1 };
    }),

  forgetFile: (filePath) =>
    set((s) => {
      const prefix = `${filePath} `;
      const entries = Object.fromEntries(
        Object.entries(s.entries).filter(([k]) => !k.startsWith(prefix)),
      );
      return { entries, rev: s.rev + 1 };
    }),
}));

// Re-read the status whenever any window changes it (the sender receives its
// own event too — a harmless extra read, same as the other config broadcasts).
listen<{ workspace?: string }>(VAULT_EVENT, ({ payload }) => {
  const { workspace, refresh } = useVaultStore.getState();
  // An event from another project window must not perturb this window's
  // session or UI. Missing payload remains a compatibility-wide refresh.
  if (workspace && (!payload.workspace || payload.workspace === workspace))
    void refresh(workspace);
}).catch(() => {});

/** Whether the vault is open right now — for render paths that can't await. */
export const vaultUnlocked = (): boolean => {
  const { status } = useVaultStore.getState();
  return status !== null && status.initialized && !status.locked;
};

/** Secret drafts do not mark the outer editor dirty, so workspace-wide
 * maintenance must ask this store separately. */
export const hasPendingSecretEdits = (): boolean =>
  Object.values(useVaultStore.getState().entries).some(
    (entry) => entry.draft !== entry.saved,
  );
