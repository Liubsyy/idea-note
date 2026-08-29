// One entry point for "run this fenced block", used by the run button and by
// the `watch` auto-recompute.
//
// It sits between the editor and run.ts because everything a parameterised
// block needs — reading the fence's attributes, resolving `in=…` against the
// document, deciding whether the output panel should pop open — is the same
// work whoever asked for the run.

import type { EditorView } from "@codemirror/view";

import { useAppStore } from "../../store/useAppStore";
import { collectInputs } from "../inputs/collect";
import { parseFenceInfo } from "./fenceAttrs";
import { startRun, startAutoRun } from "./run";

export interface RunBlockOptions {
  /** A trigger fired this run (`run=watch` / `run=open`) rather than a click on
   *  运行. It asks for confirmation once per session instead of once per run. */
  auto?: boolean;
}

/**
 * Run `code`, feeding it whatever its fence's `in=…` points at.
 *
 * A binding that can't be resolved (missing input block, file outside the
 * workspace, unreadable CSV) stops the run and says so: handing the script a
 * silently empty environment would produce a plausible-looking wrong answer,
 * which is worse than no answer.
 */
export async function runBlock(
  view: EditorView,
  info: string,
  code: string,
  options: RunBlockOptions = {},
): Promise<void> {
  const app = useAppStore.getState();
  const filePath = app.activeFilePath;
  const { attrs } = parseFenceInfo(info);

  let env: Record<string, string> | undefined;
  let inputs: Record<string, unknown> | null = null;
  let summary = "";

  if (attrs.input) {
    const collected = await collectInputs(
      view.state.doc,
      attrs.input,
      filePath ?? "",
      app.workspacePath,
    );
    if ("error" in collected) {
      app.showToast(collected.error, "error");
      return;
    }
    env = collected.ok.env;
    inputs = collected.ok.inputs;
    summary = collected.ok.summary;
  }

  const start = options.auto ? startAutoRun : startRun;
  await start({
    filePath,
    info,
    code,
    env,
    inputs,
    inputSummary: summary,
    declaredOut: attrs.outExplicit ? attrs.out : attrs.outAuto ? "auto" : null,
    // A block that renders its result in the note already shows it; don't cover
    // the note with the output panel as well. `out=auto` counts: it names no
    // type up front, but it does promise a result card, so it gets the same
    // quiet treatment as a concrete `out=`.
    reveal: !attrs.outExplicit && !attrs.outAuto,
  });
}
