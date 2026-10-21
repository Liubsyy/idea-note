// Current values of ```input blocks' controls.
//
// Values live in memory only, and deliberately so: the note stores *defaults*,
// the store stores *what the user is trying right now*. Writing every slider
// frame back into the document would flood the undo stack and turn a git diff
// into noise. 固化为默认值 is the explicit way to move a value into the file.
//
// Keyed by file path + block id, so two notes (and two blocks in one note)
// don't share state, and a value survives switching tabs.

import { create } from "zustand";

import type { InputSchema, InputValue } from "../lib/inputs/schema";
import { defaultValues } from "../lib/inputs/schema";

export const inputKey = (filePath: string, blockId: string) =>
  `${filePath} ${blockId}`;

interface InputState {
  /** Overrides only — a field the user hasn't touched isn't in here. */
  values: Record<string, Record<string, InputValue>>;
  /** Bumped on every change; `watch` blocks subscribe to this. */
  rev: number;
  /** The block whose value changed last, so a watcher knows what to re-run. */
  lastChanged: string | null;
  set: (key: string, name: string, value: InputValue) => void;
  reset: (key: string) => void;
  clearFile: (filePath: string) => void;
}

export const useInputStore = create<InputState>((set) => ({
  values: {},
  rev: 0,
  lastChanged: null,

  set: (key, name, value) =>
    set((s) => ({
      values: { ...s.values, [key]: { ...(s.values[key] ?? {}), [name]: value } },
      rev: s.rev + 1,
      lastChanged: key,
    })),

  reset: (key) =>
    set((s) => {
      if (!s.values[key]) return s;
      const values = { ...s.values };
      delete values[key];
      return { values, rev: s.rev + 1, lastChanged: key };
    }),

  clearFile: (filePath) =>
    set((s) => {
      const prefix = `${filePath} `;
      const values = Object.fromEntries(
        Object.entries(s.values).filter(([k]) => !k.startsWith(prefix)),
      );
      return { values, rev: s.rev + 1, lastChanged: null };
    }),
}));

/** The schema's defaults with the user's overrides applied. */
export function valuesFor(
  key: string,
  schema: InputSchema,
): Record<string, InputValue> {
  const stored = useInputStore.getState().values[key] ?? {};
  const out = defaultValues(schema);
  for (const field of schema.fields) {
    if (field.name in stored) out[field.name] = stored[field.name];
  }
  return out;
}
