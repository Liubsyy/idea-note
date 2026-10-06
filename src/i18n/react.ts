import { useSyncExternalStore } from "react";
import { currentLanguage, subscribeLanguage } from "./core";

/** Subscribe without remounting components or losing drafts and editor selections. */
export function useLanguage() {
  return useSyncExternalStore(subscribeLanguage, currentLanguage, currentLanguage);
}
