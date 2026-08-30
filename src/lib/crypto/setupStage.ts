/**
 * Which part of the vault setup UI should be visible.
 *
 * A freshly returned recovery code must win over the backend's initialized
 * status: vault_init writes vault.json before it returns, so the next status
 * refresh already says "initialized" even though the user has not yet had a
 * chance to save the one-time code.
 */
export type VaultSetupStage = "loading" | "recovery" | "setup" | "ready";

export function vaultSetupStage(
  initialized: boolean | null,
  recoveryCode: string | null,
): VaultSetupStage {
  if (recoveryCode !== null) return "recovery";
  if (initialized === null) return "loading";
  return initialized ? "ready" : "setup";
}
