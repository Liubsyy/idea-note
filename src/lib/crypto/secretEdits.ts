// Moving edits from the nested plaintext editors back into the document.
//
// The main buffer holds ciphertext at all times. Typing inside an unlocked
// block writes to useVaultStore only; nothing reaches the document — and so
// nothing reaches the disk, the undo history or git — until a flush runs.
// Flushes happen when a nested editor loses focus and when the note is saved.
//
// The one rule that matters here: a block whose plaintext is unchanged is left
// completely alone. Re-encrypting it would draw a fresh nonce and rewrite the
// line, so an untouched note would come back dirty after every save and two
// devices editing different notes would still collide — in ciphertext neither
// of them can read.

import type { EditorView } from "@codemirror/view";

import { getActiveView } from "../codemirror/activeView";
import {
  formatInlineSecret,
  formatSecretBlock,
  scanSecrets,
  wrapBody,
  type SecretInfo,
  type SecretMeta,
} from "./secretBlock.ts";
import { secretEncryptBatch, vaultErrorCode } from "./vault";
import { secretKey, useVaultStore } from "../../store/useVaultStore";

/* --------------------------- nested view registry ------------------------ */

// Mounted plaintext editors, so a flush can put the caret back where it was.
// Rewriting a block replaces its decoration, which destroys and rebuilds the
// widget — without this, saving with Ctrl+S while typing inside a block would
// drop focus out of it mid-sentence.
const nested = new Map<string, EditorView>();

export const registerNestedView = (key: string, view: EditorView) => {
  nested.set(key, view);
};

export const unregisterNestedView = (key: string, view: EditorView) => {
  if (nested.get(key) === view) nested.delete(key);
};

/** Focus an already mounted plaintext editor. Newly inserted secret blocks
 *  use this to put the user straight into the empty encrypted area. */
export const focusSecretEditor = (key: string): boolean => {
  const view = nested.get(key);
  if (!view) return false;
  view.focus();
  return true;
};

/** Body text compared the way the document stores it, so re-wrapping alone
 *  never counts as a change. */
const sameBody = (a: string, b: string) => wrapBody(a) === wrapBody(b);

/** The secret an entry belongs to: same id *and* same ciphertext, because a
 *  copied one shares its id with the original. Blocks and inline spans are
 *  looked up the same way — the entry never knew which shape it came from. */
function findSecret(
  secrets: SecretInfo[],
  blockId: string,
  body: string,
): SecretInfo | null {
  return (
    secrets.find((s) => s.meta?.id === blockId && sameBody(s.body, body)) ?? null
  );
}

/** Put a secret back in the shape it was written in. Re-encrypting must never
 *  turn a chip into a card or the other way round: the shape is the author's
 *  choice, not the cipher's. */
const serialise = (secret: SecretInfo, meta: SecretMeta, body: string): string =>
  secret.kind === "inline"
    ? formatInlineSecret(meta, body)
    : formatSecretBlock(meta, body);

/** What a flush did. `blocked` counts edits still waiting for a key. */
export interface FlushResult {
  written: number;
  blocked: number;
}

export interface FlushOptions {
  /**
   * Whether a locked vault may interrupt with the password dialog.
   *
   * False on the incidental flushes — losing focus shouldn't demand a password,
   * which under "立即过期" would mean a prompt every time the caret leaves a
   * block. The edit stays safe in the store either way; the deliberate flushes
   * (save, switching note, switching view mode) are the ones allowed to ask.
   */
  prompt?: boolean;
}

/**
 * Encrypt every edited block back into the document, in one transaction.
 *
 * Blocks are encrypted in a single command, not one call each: a save is one
 * operation to the user and has to be one operation to the key as well.
 */
export async function flushSecretEdits(
  filePath: string,
  view: EditorView | null = getActiveView(),
  { prompt = false }: FlushOptions = {},
): Promise<FlushResult> {
  const none: FlushResult = { written: 0, blocked: 0 };
  if (!view || !filePath) return none;
  const { entries, workspace } = useVaultStore.getState();
  if (!workspace) return none;
  const prefix = `${filePath} `;
  const dirty = Object.entries(entries).filter(
    ([key, entry]) => key.startsWith(prefix) && entry.draft !== entry.saved,
  );
  if (dirty.length === 0) return none;

  const secrets = scanSecrets(view.state.doc);
  const pending: { key: string; blockId: string; plaintext: string; block: SecretInfo }[] =
    [];

  for (const [key, entry] of dirty) {
    const blockId = key.slice(prefix.length);
    const block = findSecret(secrets, blockId, entry.body);
    // The secret is gone (the user deleted it) — drop the edit rather than
    // resurrecting text they removed.
    if (!block?.meta) continue;
    pending.push({ key, blockId, plaintext: entry.draft, block });
  }
  if (pending.length === 0) return none;

  let encrypted;
  try {
    encrypted = await secretEncryptBatch(
      workspace,
      pending.map(({ blockId, plaintext }) => ({ blockId, plaintext })),
    );
  } catch (error) {
    if (vaultErrorCode(error) !== "locked") throw error;
    // The key expired between the edit and this flush. Ask for it only when the
    // caller said it may; otherwise leave the edits dirty — they are still in
    // the store, and the next deliberate flush will offer to encrypt them.
    if (!prompt) return { written: 0, blocked: pending.length };
    const unlocked = await useVaultStore.getState().ensureUnlocked(workspace);
    if (!unlocked) return { written: 0, blocked: pending.length };
    encrypted = await secretEncryptBatch(
      workspace,
      pending.map(({ blockId, plaintext }) => ({ blockId, plaintext })),
    );
  }

  const byId = new Map(encrypted.map((e) => [e.blockId, e]));
  const changes: { from: number; to: number; insert: string }[] = [];
  const rewritten: { key: string; body: string; draft: string }[] = [];
  for (const { key, blockId, plaintext, block } of pending) {
    const result = byId.get(blockId);
    if (!result || !block.meta) continue;
    changes.push({
      from: block.from,
      to: block.to,
      insert: serialise(
        block,
        { ...block.meta, v: result.v, keyId: result.keyId },
        result.body,
      ),
    });
    rewritten.push({ key, body: result.body, draft: plaintext });
  }
  if (changes.length === 0) return none;

  // Record where the caret was before the rebuild tears the nested editors down.
  const focusedKey = [...nested.entries()].find(([, v]) => v.hasFocus)?.[0];
  const focusedAt = focusedKey ? nested.get(focusedKey)!.state.selection.main : null;

  changes.sort((a, b) => a.from - b.from);
  view.dispatch({ changes });

  const { remember } = useVaultStore.getState();
  for (const { key, body, draft } of rewritten) {
    remember(key, { body, saved: draft, draft });
  }

  if (focusedKey && focusedAt) {
    // The replacement decoration mounts a new nested view synchronously during
    // dispatch, so by now the map already points at it.
    const remounted = nested.get(focusedKey);
    if (remounted) {
      const max = remounted.state.doc.length;
      remounted.dispatch({
        selection: {
          anchor: Math.min(focusedAt.anchor, max),
          head: Math.min(focusedAt.head, max),
        },
      });
      remounted.focus();
    }
  }
  return { written: changes.length, blocked: pending.length - changes.length };
}

/** Flush first, then drop the keys: locking must never discard plaintext the
 *  user typed but hasn't encrypted yet. */
export async function lockVault(filePath: string): Promise<void> {
  try {
    await flushSecretEdits(filePath, undefined, { prompt: true });
  } finally {
    await useVaultStore.getState().lock();
  }
}

export { secretKey };
