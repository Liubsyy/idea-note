/** Pure readiness check shared by every editor window before an MK migration.
 * Secret drafts live outside the outer document, so all three flags matter. */
export function vaultRotationBlockReason({
  isDirty,
  saving,
  pendingSecretEdits,
}: {
  isDirty: boolean;
  saving: boolean;
  pendingSecretEdits: boolean;
}): string | null {
  if (saving) return "文件仍在保存中";
  if (isDirty) return "存在未保存的编辑";
  if (pendingSecretEdits) return "存在尚未写回的加密块草稿";
  return null;
}
