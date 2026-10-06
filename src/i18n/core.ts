import en from "./en.ts";

export type AppLanguage = "zh-CN" | "en";
export const LANGUAGE_KEY = "idea-note.language";
export const LANGUAGE_EVENT = "idea-note-language-changed";
export const LANGUAGE_OPTIONS = [
  { value: "zh-CN", label: "简体中文" },
  { value: "en", label: "English" },
] as const;

export function isAppLanguage(value: unknown): value is AppLanguage {
  return value === "zh-CN" || value === "en";
}

export function resolveSystemLanguage(locale?: string): AppLanguage {
  return /^zh(?:[-_]|$)/i.test(locale?.trim() ?? "") ? "zh-CN" : "en";
}

export function readLanguage(): AppLanguage {
  try {
    const saved = localStorage.getItem(LANGUAGE_KEY);
    if (isAppLanguage(saved)) return saved;
  } catch { /* Storage can be unavailable in browser previews. */ }
  return typeof window === "undefined" ? "zh-CN" : resolveSystemLanguage(navigator.language);
}

let language = readLanguage();
const listeners = new Set<() => void>();
export const currentLanguage = () => language;
export function subscribeLanguage(listener: () => void): () => void {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

/** Apply without persisting or broadcasting, including events from another window. */
export function applyLanguage(next: AppLanguage): void {
  if (typeof document !== "undefined") document.documentElement.lang = next;
  if (next === language) return;
  language = next;
  for (const listener of listeners) listener();
}

/** Save before changing the UI so a storage failure cannot silently lose the preference. */
export function changeLanguage(next: AppLanguage): void {
  if (!isAppLanguage(next)) return;
  localStorage.setItem(LANGUAGE_KEY, next);
  applyLanguage(next);
  window.dispatchEvent(new CustomEvent(LANGUAGE_EVENT, { detail: next }));
}

/** Chinese source strings are stable keys; interpolate once so user data stays verbatim. */
export function translate(
  locale: AppLanguage,
  key: string,
  values: Record<string, unknown> = {},
): string {
  const text = locale === "en" && Object.prototype.hasOwnProperty.call(en, key)
    ? (en as Record<string, string>)[key] : key;
  return text.replace(/\{\{(\w+)\}\}/g, (placeholder, name: string) =>
    Object.prototype.hasOwnProperty.call(values, name) ? String(values[name]) : placeholder,
  );
}

export function tr(key: string, values?: Record<string, unknown>): string {
  return translate(language, key, values);
}

applyLanguage(language);
if (typeof window !== "undefined") {
  window.addEventListener("storage", (event) => {
    if (event.key === LANGUAGE_KEY || event.key === null) applyLanguage(readLanguage());
  });
}
