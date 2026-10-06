import { subscribeLanguage } from "./core.ts";

type Property = "textContent" | "title" | "placeholder" | "ariaLabel";
const bindings = new WeakMap<Element, Map<Property, () => string>>();
const marker = "data-idea-note-i18n";

/** Explicit bindings for application-owned CodeMirror chrome, never note content.
 * Weak keys avoid retaining discarded widgets; language changes update only live nodes.
 * Updating labels in place preserves nested encrypted editors, inputs, and selection. */
export function localizeElement<T extends Element>(element: T, property: Property & keyof T, value: () => string): void {
  let properties = bindings.get(element);
  if (!properties) {
    properties = new Map();
    bindings.set(element, properties);
    element.setAttribute(marker, "");
  }
  properties.set(property, value);
  Reflect.set(element, property, value());
}

subscribeLanguage(() => {
  if (typeof document === "undefined") return;
  document.querySelectorAll(`[${marker}]`).forEach((element) => {
    bindings.get(element)?.forEach((value, property) => Reflect.set(element, property, value()));
  });
});
