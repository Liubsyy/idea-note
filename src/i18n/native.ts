import { isTauri } from "@tauri-apps/api/core";
import { emit, listen } from "@tauri-apps/api/event";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { applyLanguage, isAppLanguage, LANGUAGE_EVENT, readLanguage, subscribeLanguage, tr } from "./core";

/** Tauri events cover webviews where localStorage storage events are not delivered. */
export async function initializeNativeLanguage(): Promise<void> {
  if (!isTauri()) return;
  await listen<unknown>(LANGUAGE_EVENT, ({ payload }) => {
    if (isAppLanguage(payload)) applyLanguage(payload);
  });
  applyLanguage(readLanguage());
  window.addEventListener(LANGUAGE_EVENT, (event) => {
    const language = (event as CustomEvent).detail;
    if (isAppLanguage(language)) void emit(LANGUAGE_EVENT, language).catch(console.error);
  });
  const updateTitle = () => {
    const win = getCurrentWindow();
    if (win.label === "settings") void win.setTitle(tr("设置")).catch(console.error);
  };
  subscribeLanguage(updateTitle);
  updateTitle();
}
