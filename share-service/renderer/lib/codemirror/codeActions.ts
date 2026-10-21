import type { EditorView } from "@codemirror/view";
import { localizeElement } from "../../i18n/dom.ts";
import { tr } from "../../i18n/core.ts";
import { copyText } from "../clipboard";
import { runBlock } from "../codeRun/runBlock";
import { useAppStore } from "../../store/useAppStore";

export interface CodeActionOptions {
  code: string;
  runInfo: string | null;
  language: string;
  lineCount: number;
  fold?: { collapsed: () => boolean; toggle: () => void };
}

type CodeActionIcon = "play" | "panelOpen" | "panelClose" | "copy" | "check" | "collapse" | "expand";

const CODE_ACTION_ICON_PATHS: Record<CodeActionIcon, string[]> = {
  collapse: ["m6 9 6 6 6-6"],
  expand: ["m9 6 6 6-6 6"],
  play: ["M6 3l14 9-14 9V3z"],
  panelOpen: ["M3 3h18v18H3z", "M15 3v18", "m7 9 3 3-3 3"],
  panelClose: ["M3 3h18v18H3z", "M15 3v18", "m10 9-3 3 3 3"],
  copy: [
    "M10 8h9a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2h-9a2 2 0 0 1-2-2v-9a2 2 0 0 1 2-2z",
    "M4 16a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2",
  ],
  check: ["m4 12 5 5L20 6"],
};

function setCodeActionIcon(button: HTMLButtonElement, icon: CodeActionIcon): void {
  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  svg.setAttribute("viewBox", "0 0 24 24");
  svg.setAttribute("aria-hidden", "true");
  svg.setAttribute("focusable", "false");
  for (const d of CODE_ACTION_ICON_PATHS[icon]) {
    const path = document.createElementNS("http://www.w3.org/2000/svg", "path");
    path.setAttribute("d", d);
    svg.append(path);
  }
  button.replaceChildren(svg);
}

function setRunPanelButtonState(button: HTMLButtonElement, open: boolean): void {
  const label = () => open ? tr("隐藏代码运行面板") : tr("打开代码运行面板");
  localizeElement(button, "title", label);
  localizeElement(button, "ariaLabel", label);
  setCodeActionIcon(button, open ? "panelClose" : "panelOpen");
}

const CODE_ACTION_CLEANUPS = new WeakMap<HTMLElement, () => void>();

/** Shared toolbar for document code lines and code inside HTML widgets. */
export function createCodeActions(view: EditorView, options: CodeActionOptions): HTMLElement {
  const wrap = document.createElement("div");
  wrap.className = "cm-md-code-header";
  wrap.contentEditable = "false";
  const cleanups: (() => void)[] = [];
  let active = true;
  CODE_ACTION_CLEANUPS.set(wrap, () => {
    active = false;
    cleanups.forEach(cleanup => cleanup());
  });
  // Don't let a press move the editor cursor or steal focus.
  wrap.addEventListener("mousedown", (e) => e.preventDefault());

  const toggle = document.createElement(options.fold ? "button" : "span");
  toggle.className = "cm-md-code-meta";
  const language = document.createElement("span");
  language.className = "cm-md-code-language";
  const languageNames: Record<string, string> = { javascript: "JavaScript", typescript: "TypeScript", python: "Python", json: "JSON", html: "HTML", css: "CSS", sql: "SQL" };
  localizeElement(language, "textContent", () => languageNames[options.language] || options.language || tr("代码块"));
  const count = document.createElement("span");
  count.className = "cm-md-code-count";
  localizeElement(count, "textContent", () => tr("{{0}} 行", { 0: options.lineCount }));
  if (toggle instanceof HTMLButtonElement && options.fold) {
    toggle.type = "button";
    toggle.classList.add("cm-md-code-fold-btn");
    const fold = options.fold;
    const refresh = () => {
      const label = () => fold.collapsed() ? tr("展开代码块") : tr("折叠代码块");
      localizeElement(toggle, "title", label);
      localizeElement(toggle, "ariaLabel", label);
      toggle.setAttribute("aria-expanded", String(!fold.collapsed()));
      setCodeActionIcon(toggle, fold.collapsed() ? "expand" : "collapse");
      toggle.append(language, count);
    };
    refresh();
    toggle.addEventListener("click", () => {
      fold.toggle();
      if (active) refresh();
    });
  } else toggle.append(language, count);
  wrap.append(toggle);
  const actions = document.createElement("div");
  actions.className = "cm-md-code-actions";
  wrap.append(actions);

  if (options.runInfo !== null) {
    const run = document.createElement("button");
    run.type = "button";
    run.className = "cm-md-code-action-btn cm-md-run-btn";
    localizeElement(run, "title", () => tr("运行代码块"));
    localizeElement(run, "ariaLabel", () => tr("运行代码块"));
    setCodeActionIcon(run, "play");
    run.addEventListener("click", (e) => {
      e.preventDefault();
      // runBlock resolves the fence's `in=…` against the document first, so
      // the click carries the block's parameters with it.
      void runBlock(view, options.runInfo ?? "", options.code);
    });

    const output = document.createElement("button");
    output.type = "button";
    output.className = "cm-md-code-action-btn";
    setRunPanelButtonState(output, useAppStore.getState().runPanelOpen);
    output.addEventListener("click", (e) => {
      e.preventDefault();
      useAppStore.getState().toggleRunPanel();
    });
    actions.append(run, output);

    const unsubscribe = useAppStore.subscribe((state, previous) => {
      if (state.runPanelOpen !== previous.runPanelOpen) {
        setRunPanelButtonState(output, state.runPanelOpen);
      }
    });
    cleanups.push(unsubscribe);
  }

  const btn = document.createElement("button");
  btn.type = "button";
  btn.className = "cm-md-code-action-btn";
  localizeElement(btn, "title", () => tr("复制代码"));
  localizeElement(btn, "ariaLabel", () => tr("复制代码"));
  setCodeActionIcon(btn, "copy");
  btn.addEventListener("click", (e) => {
    e.preventDefault();
    void copyText(options.code)
      .then(() => {
        if (!active) return;
        useAppStore.getState().showToast(tr("已复制到剪贴板"), "success");
        localizeElement(btn, "title", () => tr("已复制"));
        localizeElement(btn, "ariaLabel", () => tr("已复制"));
        setCodeActionIcon(btn, "check");
        btn.classList.add("cm-md-code-action-done");
        const timer = window.setTimeout(() => {
          localizeElement(btn, "title", () => tr("复制代码"));
          localizeElement(btn, "ariaLabel", () => tr("复制代码"));
          setCodeActionIcon(btn, "copy");
          btn.classList.remove("cm-md-code-action-done");
        }, 1200);
        cleanups.push(() => window.clearTimeout(timer));
      })
      .catch(() => useAppStore.getState().showToast(tr("复制失败"), "error"));
  });
  actions.append(btn);
  return wrap;
}

export function destroyCodeActions(dom: HTMLElement) {
  CODE_ACTION_CLEANUPS.get(dom)?.();
  CODE_ACTION_CLEANUPS.delete(dom);
}
