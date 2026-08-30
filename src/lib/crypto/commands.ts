// The three user-facing actions on encrypted content: encrypt a selection,
// decrypt a block back into plain text, and lock the vault.
//
// Each one is deliberately whole-line and whole-block. A secret block is an
// atomic unit in the document — half of one is not a thing that can exist —
// so these commands refuse anything that would produce a partial block rather
// than trying to be clever about it.

import type { EditorView } from "@codemirror/view";

import { requestSecretRefresh } from "../codemirror/secretBlock";
import {
  formatSecretBlock,
  newBlockId,
  scanSecretBlocks,
  type SecretBlockInfo,
} from "./secretBlock.ts";
import { flushSecretEdits, lockVault } from "./secretEdits";
import { secretEncrypt, vaultErrorMessage } from "./vault";
import { secretKey, useVaultStore } from "../../store/useVaultStore";
import { useAppStore } from "../../store/useAppStore";

const toast = (message: string, tone: "success" | "error" = "success") => {
  useAppStore.getState().showToast(message, tone);
};

const workspaceOf = () => useAppStore.getState().workspacePath ?? "";
const filePathOf = () => useAppStore.getState().activeFilePath ?? "";

/** Blocks a selection genuinely overlaps. Strict, so a selection ending exactly
 *  where a block starts is not treated as containing it. */
const blocksOverlapping = (
  blocks: SecretBlockInfo[],
  from: number,
  to: number,
): SecretBlockInfo[] => blocks.filter((b) => b.from < to && b.to > from);

/**
 * The block a caret or selection sits on.
 *
 * Edges count here, unlike `blocksOverlapping`: a secret block is an atomic
 * widget, so a collapsed caret can only ever land *at* its boundary, never
 * inside it. A strict test would mean the 解密 command could never fire from a
 * plain cursor.
 */
const blockAt = (
  blocks: SecretBlockInfo[],
  from: number,
  to: number,
): SecretBlockInfo[] => blocks.filter((b) => b.from <= from && b.to >= to);

/**
 * Wrap the selection in a new encrypted block.
 *
 * The range is grown to whole lines first: a fenced block has to start and end
 * on its own line, so encrypting half a paragraph would otherwise leave the
 * fence markers stranded mid-sentence.
 */
export async function encryptSelection(view: EditorView): Promise<void> {
  const workspace = workspaceOf();
  if (!workspace) return;

  const range = view.state.selection.main;
  if (range.empty) {
    toast("请先选中要加密的内容。");
    return;
  }

  const blocks = scanSecretBlocks(view.state.doc);
  if (blocksOverlapping(blocks, range.from, range.to).length > 0) {
    toast("选区里已经包含加密块，请先把它移出选区。", "error");
    return;
  }

  const unlocked = await useVaultStore.getState().ensureUnlocked(workspace);
  if (!unlocked) return;

  // Re-read the document: unlocking is async and the user may have typed.
  const live = view.state.selection.main;
  const startLine = view.state.doc.lineAt(live.from);
  const endLine = view.state.doc.lineAt(live.to);
  const from = startLine.from;
  const to = endLine.to;
  const plaintext = view.state.doc.sliceString(from, to);
  if (!plaintext.trim()) {
    toast("空白内容无需加密。");
    return;
  }

  const blockId = newBlockId();
  try {
    const result = await secretEncrypt(blockId, plaintext);
    view.dispatch({
      changes: {
        from,
        to,
        insert: formatSecretBlock(
          { v: result.v, keyId: result.keyId, id: blockId, extras: [] },
          result.body,
        ),
      },
      // Park the caret ahead of the new block; it cannot sit inside one.
      selection: { anchor: from },
    });
    useVaultStore.getState().remember(secretKey(filePathOf(), blockId), {
      body: result.body,
      saved: plaintext,
      draft: plaintext,
    });
    requestSecretRefresh(view);
  } catch (error) {
    toast(vaultErrorMessage(error), "error");
  }
}

/**
 * Turn an encrypted block back into ordinary text.
 *
 * Only works on a block that is already decrypted — there is no path here that
 * writes plaintext the user hasn't seen.
 */
export async function decryptSelectedBlock(view: EditorView): Promise<void> {
  const filePath = filePathOf();
  // Anything typed in the block has to reach the document before it is
  // replaced, or the un-flushed edit is what gets thrown away.
  await flushSecretEdits(filePath, view);

  const range = view.state.selection.main;
  const blocks = scanSecretBlocks(view.state.doc);
  const touched = blockAt(blocks, range.from, range.to);
  const block = touched.length === 1 ? touched[0] : null;
  if (!block?.meta) {
    toast(
      touched.length > 1
        ? "选区里有多个加密块，请一次解密一个。"
        : "请把光标或选区放在要解密的加密块上。",
    );
    return;
  }

  const key = secretKey(filePath, block.meta.id);
  const entry = useVaultStore.getState().recall(key, block.body);
  if (!entry) {
    toast("这个块还没有解锁，无法解密。", "error");
    return;
  }

  view.dispatch({
    changes: { from: block.from, to: block.to, insert: entry.draft },
    selection: { anchor: block.from },
  });
  // Only this block's plaintext is dropped: other blocks in the note may still
  // be open and their drafts are not this command's business.
  useVaultStore.getState().forget(key);
  requestSecretRefresh(view);
}

/** Lock the vault now. Pending edits are encrypted first — locking must never
 *  be the thing that loses someone's writing. */
export async function lockNow(view?: EditorView): Promise<void> {
  await lockVault(filePathOf());
  if (view) requestSecretRefresh(view);
  toast("加密内容已上锁。");
}

/** Whether the caret currently sits on exactly one decrypted block — drives
 *  the enabled state of the 解密 menu item. */
export function decryptableBlockAt(view: EditorView): boolean {
  const range = view.state.selection.main;
  const touched = blockAt(scanSecretBlocks(view.state.doc), range.from, range.to);
  if (touched.length !== 1 || !touched[0].meta) return false;
  const key = secretKey(filePathOf(), touched[0].meta.id);
  return useVaultStore.getState().recall(key, touched[0].body) !== null;
}
