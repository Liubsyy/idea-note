import { Facet, type EditorState } from "@codemirror/state";

/** Presentation locks source editing but still lets the audience use controls
 * and explicitly run code. Ordinary read-only preview keeps both disabled. */
export const presentationInteraction = Facet.define<boolean, boolean>({
  combine: (values) => values.some(Boolean),
});

export function canInteract(state: EditorState): boolean {
  return !state.readOnly || state.facet(presentationInteraction);
}
