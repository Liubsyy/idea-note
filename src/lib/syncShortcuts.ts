import type { useAppStore } from "../store/useAppStore";
import { matchesAppCommand, SYNC_COMMANDS } from "./codemirror/keybindings";
import { isImageFile } from "./fs";

type State = ReturnType<typeof useAppStore.getState>;
type SyncShortcutState = Pick<State,
  "workspacePath" | "gitInfo" | "editorKeybindings" | "presentationActive" | "loadingWorkspace" |
  "prompt" | "confirm" | "gitCredentialPrompt" | "history" | "manualSyncOpen" | "branchManagerOpen" |
  "syncState" | "branchTaskBusy" | "vaultRotationBusy" | "activeFilePath" |
  "syncNow" | "setManualSyncOpen" | "openHistory" | "setBranchManagerOpen"
>;

/** Capture before the editor keymap, while leaving text fields and modals alone. */
export function handleSyncShortcut(event: KeyboardEvent, state: SyncShortcutState): boolean {
  if (event.defaultPrevented || event.isComposing || event.repeat || state.presentationActive ||
    state.loadingWorkspace || !state.workspacePath || !state.gitInfo?.isRepo ||
    state.prompt || state.confirm || state.gitCredentialPrompt || state.history ||
    state.manualSyncOpen || state.branchManagerOpen || state.vaultRotationBusy) return false;
  const target = event.target as HTMLElement | null;
  if (target?.closest("input, textarea, select, .xterm, [role=dialog], [role=alertdialog]")) return false;
  const editable = target?.closest("[contenteditable=true]");
  if (editable && !editable.closest(".cm-editor")) return false;
  const command = SYNC_COMMANDS.find((item) => matchesAppCommand(item.id, event, state.editorKeybindings));
  if (!command) return false;
  if (command.id !== "openHistory" && (state.syncState === "syncing" || state.branchTaskBusy)) return false;
  if (command.id === "openHistory" && state.activeFilePath && isImageFile(state.activeFilePath)) return false;
  event.preventDefault();
  event.stopPropagation();
  switch (command.id) {
    case "syncNow": void state.syncNow(); break;
    case "manualSync": state.setManualSyncOpen(true); break;
    case "openHistory": state.openHistory(); break;
    case "branchManager": state.setBranchManagerOpen(true); break;
  }
  return true;
}
