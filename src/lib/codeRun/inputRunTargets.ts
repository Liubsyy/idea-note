import type { Text } from "@codemirror/state";
import { isCloseFenceFor, openingFenceOf, parseFenceInfo } from "./fenceAttrs";
import { resolveRunner, type CodeRunConfig } from "./runners";

/** Runnable code bound to input controls, in document order. */
export interface InputRunTarget { inputId: string; info: string; code: string }

export function inputRunTargets(doc: Text, config: CodeRunConfig) {
  const targets: InputRunTarget[] = [];
  if (!config.enabled) return targets;
  for (let line = 1; line <= doc.lines;) {
    const opening = openingFenceOf(doc.line(line).text);
    if (!opening) { line++; continue; }
    let end = line + 1;
    while (end <= doc.lines && !isCloseFenceFor(doc.line(end).text, opening)) end++;
    const { lang, attrs } = parseFenceInfo(opening.info);
    if (attrs.input?.kind === "block" && end > line + 1 && resolveRunner(lang, config)) {
      const code = doc.sliceString(doc.line(line + 1).from, doc.line(end - 1).to);
      if (code.trim()) targets.push({ inputId: attrs.input.name, info: opening.info, code });
    }
    line = end + 1;
  }
  return targets;
}
