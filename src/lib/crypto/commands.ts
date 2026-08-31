// The user-facing actions on encrypted content: insert a new empty block,
// encrypt a selection as a block or inline span, and lock the vault.
//
// Each one is deliberately whole-line or whole-span. A secret is an atomic
// unit in the document — half of one is not a thing that can exist — so these
// commands refuse anything that would produce a partial one rather than trying
// to be clever about it.
//
// There is deliberately no "turn this back into plain text" command. Writing
// plaintext into the main buffer is the one thing this feature exists to
// prevent, and a menu entry that does it on a keystroke is a bigger hazard
// than the convenience is worth. Revealing a secret and copying out of its
// editor does the same job, out of one block at a time and only ever with the
// text on screen.

import type { EditorView } from "@codemirror/view";

import { getActiveView } from "../codemirror/activeView";
import { requestSecretRefresh } from "../codemirror/secretBlock";
import {
  formatInlineSecret,
  formatSecretBlock,
  newBlockId,
  scanSecrets,
  type SecretInfo,
} from "./secretBlock.ts";
import { focusSecretEditor, lockVault } from "./secretEdits";
import { secretEncrypt, vaultErrorMessage } from "./vault";
import { secretKey, useVaultStore } from "../../store/useVaultStore";
import { useAppStore } from "../../store/useAppStore";

const toast = (message: string, tone: "success" | "error" = "success") => {
  useAppStore.getState().showToast(message, tone);
};

const workspaceOf = () => useAppStore.getState().workspacePath ?? "";
const filePathOf = () => useAppStore.getState().activeFilePath ?? "";

/**
 * Insert a new, empty encrypted block at the caret and open its nested editor.
 *
 * Unlike `encryptSelection`, this deliberately ignores selected text. The
 * toolbar is an insertion affordance; converting existing content remains an
 * explicit action in the editor's context menu.
 */
export async function insertSecretBlock(view: EditorView): Promise<void> {
  const workspace = workspaceOf();
  const filePath = filePathOf();
  if (!workspace || !filePath || view.state.readOnly) return;

  const unlocked = await useVaultStore.getState().ensureUnlocked(workspace);
  if (!unlocked) return;

  const blockId = newBlockId();
  try {
    const result = await secretEncrypt(workspace, blockId, "");

    // Unlocking and encryption are asynchronous. Never insert into an editor
    // the user has since closed or into a different note that became active.
    if (
      !view.dom.isConnected ||
      view.state.readOnly ||
      getActiveView() !== view ||
      filePathOf() !== filePath
    )
      return;

    const block = formatSecretBlock(
      { v: result.v, keyId: result.keyId, id: blockId, extras: [] },
      result.body,
    );
    const state = view.state;
    const at = state.selection.main.head;
    const line = state.doc.lineAt(at);
    const onEmptyLine = at === line.from && line.text.trim() === "";
    const lead = onEmptyLine ? "" : "\n";
    const insert = `${lead}${block}\n`;
    const key = secretKey(filePath, blockId);

    // Remember the empty plaintext before the document change so the block is
    // born expanded instead of briefly flashing as a locked card.
    useVaultStore.getState().remember(key, {
      body: result.body,
      saved: "",
      draft: "",
    });
    view.dispatch({
      changes: { from: at, insert },
      selection: { anchor: at + insert.length },
      userEvent: "input",
    });

    // Decoration/widget mounting is synchronous in the normal path. Keep one
    // animation-frame fallback for browsers that defer the DOM update.
    if (!focusSecretEditor(key))
      window.requestAnimationFrame(() => focusSecretEditor(key));
  } catch (error) {
    toast(vaultErrorMessage(error), "error");
  }
}

/** Secrets a selection genuinely overlaps. Strict, so a selection ending
 *  exactly where one starts is not treated as containing it. */
const overlapping = (
  secrets: SecretInfo[],
  from: number,
  to: number,
): SecretInfo[] => secrets.filter((b) => b.from < to && b.to > from);

/**
 * Wrap the selection in a new encrypted block and leave that block sealed. The
 * workspace key keeps its existing TTL: sealing one block is a display/privacy
 * action, not a request to lock the whole vault.
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

  // Tested against the whole-line range, not the selection: that is what will
  // be swallowed, so a chip sitting elsewhere on the same line counts.
  const wholeLines = (r: { from: number; to: number }) => ({
    from: view.state.doc.lineAt(r.from).from,
    to: view.state.doc.lineAt(r.to).to,
  });
  const clash = (r: { from: number; to: number }) =>
    overlapping(scanSecrets(view.state.doc), r.from, r.to).length > 0;
  if (clash(wholeLines(range))) {
    toast("选区所在的行里已经有加密内容，请先把它移出选区。", "error");
    return;
  }

  const unlocked = await useVaultStore.getState().ensureUnlocked(workspace);
  if (!unlocked) return;

  // Re-read the document: unlocking is async and the user may have typed.
  const { from, to } = wholeLines(view.state.selection.main);
  if (clash({ from, to })) {
    toast("选区所在的行里已经有加密内容，请先把它移出选区。", "error");
    return;
  }
  const plaintext = view.state.doc.sliceString(from, to);
  if (!plaintext.trim()) {
    toast("空白内容无需加密。");
    return;
  }

  const blockId = newBlockId();
  try {
    const result = await secretEncrypt(workspace, blockId, plaintext);
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
    // A block is revealed only when its plaintext is remembered in the session
    // store. Deliberately not remembering this new plaintext makes the card
    // render sealed, while leaving the workspace MK and its TTL untouched.
    requestSecretRefresh(view);
    toast("选中内容已加密，该加密块已上锁。");
  } catch (error) {
    toast(vaultErrorMessage(error), "error");
  }
}

/**
 * Wrap the selection in an inline secret and leave it sealed.
 *
 * The counterpart to `encryptSelection`, and deliberately a separate command
 * rather than a guess: for a selection that happens to be one short line both
 * shapes are reasonable, and choosing wrong for the user means an undo and a
 * second try. The selection is used exactly as given — no line growing, which
 * is the entire difference between the two shapes.
 */
export async function encryptInlineSelection(view: EditorView): Promise<void> {
  const workspace = workspaceOf();
  if (!workspace) return;

  const range = view.state.selection.main;
  if (range.empty) {
    toast("请先选中要加密的内容。");
    return;
  }

  // An inline replace decoration may not cross a line break, so a span that
  // did would be unrenderable the moment it was written.
  const oneLine = (r: { from: number; to: number }) =>
    view.state.doc.lineAt(r.from).number === view.state.doc.lineAt(r.to).number;
  if (!oneLine(range)) {
    toast("行内加密只能用于同一行内的选区，跨行请用「加密选区」。", "error");
    return;
  }
  const clash = (r: { from: number; to: number }) =>
    overlapping(scanSecrets(view.state.doc), r.from, r.to).length > 0;
  if (clash(range)) {
    toast("选区里已经包含加密内容，请先把它移出选区。", "error");
    return;
  }

  const unlocked = await useVaultStore.getState().ensureUnlocked(workspace);
  if (!unlocked) return;

  // Re-read the document: unlocking is async and the user may have typed.
  const live = view.state.selection.main;
  if (live.empty || !oneLine(live) || clash(live)) {
    toast("选区已经变了，请重新选中再试。", "error");
    return;
  }
  const plaintext = view.state.doc.sliceString(live.from, live.to);
  if (!plaintext.trim()) {
    toast("空白内容无需加密。");
    return;
  }

  const blockId = newBlockId();
  try {
    const result = await secretEncrypt(workspace, blockId, plaintext);
    view.dispatch({
      changes: {
        from: live.from,
        to: live.to,
        insert: formatInlineSecret(
          { v: result.v, keyId: result.keyId, id: blockId, extras: [] },
          result.body,
        ),
      },
      // Park the caret after the new chip; it cannot sit inside one.
      selection: { anchor: live.from },
    });
    // Not remembering the plaintext is what makes the chip render sealed,
    // while leaving the workspace key and its TTL untouched — same as the
    // block command.
    requestSecretRefresh(view);
    toast("选中内容已加密为行内，该内容已上锁。");
  } catch (error) {
    toast(vaultErrorMessage(error), "error");
  }
}

/** Lock the vault now. Pending edits are encrypted first — locking must never
 *  be the thing that loses someone's writing. */
export async function lockNow(view?: EditorView): Promise<void> {
  await lockVault(filePathOf());
  if (view) requestSecretRefresh(view);
  toast("加密内容已上锁。");
}
