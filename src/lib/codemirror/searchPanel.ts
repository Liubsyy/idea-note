// Typora/VSCode-style find & replace bar for the editor, built on
// @codemirror/search with a custom Chinese-language panel that follows the
// app's CSS variables instead of the library's default look.

import type { EditorState } from "@codemirror/state";
import { keymap, EditorView, type Panel, type ViewUpdate } from "@codemirror/view";
import {
  search,
  searchKeymap,
  SearchQuery,
  getSearchQuery,
  setSearchQuery,
  openSearchPanel,
  closeSearchPanel,
  findNext,
  findPrevious,
  replaceNext,
  replaceAll,
  highlightSelectionMatches,
} from "@codemirror/search";

// openSearchWithReplace needs to reach the live panel instance for the view
// it was invoked on; panels register themselves here while mounted.
const panels = new WeakMap<EditorView, FindPanel>();

/** Open the search panel with the replace row expanded (⌥⌘F). */
export function openSearchWithReplace(view: EditorView): boolean {
  openSearchPanel(view);
  panels.get(view)?.setReplaceVisible(true);
  return true;
}

const icons = {
  chevronRight:
    '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="9 18 15 12 9 6"/></svg>',
  chevronDown:
    '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="6 9 12 15 18 9"/></svg>',
  arrowUp:
    '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="12" y1="19" x2="12" y2="5"/><polyline points="5 12 12 5 19 12"/></svg>',
  arrowDown:
    '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="12" y1="5" x2="12" y2="19"/><polyline points="19 12 12 19 5 12"/></svg>',
  close:
    '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>',
  // Option toggles, matching the global-search panel's lucide icons.
  caseSensitive:
    '<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="m3 15 4-8 4 8"/><path d="M4 13h6"/><circle cx="18" cy="12" r="3"/><path d="M21 9v6"/></svg>',
  wholeWord:
    '<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="7" cy="12" r="3"/><path d="M10 9v6"/><circle cx="17" cy="12" r="3"/><path d="M14 7v8"/><path d="M22 17v1c0 .5-.5 1-1 1H3c-.5 0-1-.5-1-1v-1"/></svg>',
  regex:
    '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M17 3v10"/><path d="m12.67 5.5 8.66 5"/><path d="m12.67 10.5 8.66-5"/><path d="M9 17a2 2 0 0 0-2-2H5a2 2 0 0 0-2 2v2a2 2 0 0 0 2 2h2a2 2 0 0 0 2-2v-2z"/></svg>',
};

function iconButton(title: string, svg: string, onClick: () => void) {
  const b = document.createElement("button");
  b.className = "cm-find-btn";
  b.title = title;
  b.innerHTML = svg;
  b.addEventListener("click", onClick);
  return b;
}

function toggleButton(title: string, svg: string, onToggle: () => void) {
  const b = document.createElement("button");
  b.className = "cm-find-toggle";
  b.title = title;
  b.innerHTML = svg;
  b.addEventListener("click", () => {
    b.classList.toggle("active");
    onToggle();
  });
  return b;
}

function textButton(label: string, onClick: () => void) {
  const b = document.createElement("button");
  b.className = "cm-find-text-btn";
  b.textContent = label;
  b.addEventListener("click", onClick);
  return b;
}

class FindPanel implements Panel {
  dom: HTMLElement;
  top = true;

  private searchField: HTMLInputElement;
  private replaceField: HTMLInputElement;
  private countEl: HTMLElement;
  private modeBtn: HTMLButtonElement;
  private replaceRow: HTMLElement;
  private caseBtn: HTMLButtonElement;
  private regexBtn: HTMLButtonElement;
  private wordBtn: HTMLButtonElement;

  constructor(private view: EditorView) {
    panels.set(view, this);

    this.searchField = document.createElement("input");
    this.searchField.className = "cm-find-field";
    this.searchField.placeholder = "查找";
    this.searchField.setAttribute("main-field", "true");
    this.searchField.addEventListener("input", () => {
      this.commit();
      this.jumpToFirstMatch();
    });
    this.searchField.addEventListener("keydown", (e) => {
      if (e.key === "Enter") {
        e.preventDefault();
        (e.shiftKey ? findPrevious : findNext)(this.view);
      } else if (e.key === "Escape") {
        e.preventDefault();
        closeSearchPanel(this.view);
        this.view.focus();
      }
    });

    this.replaceField = document.createElement("input");
    this.replaceField.className = "cm-find-field";
    this.replaceField.placeholder = "替换为";
    this.replaceField.addEventListener("input", () => this.commit());
    this.replaceField.addEventListener("keydown", (e) => {
      if (e.key === "Enter") {
        e.preventDefault();
        replaceNext(this.view);
      } else if (e.key === "Escape") {
        e.preventDefault();
        closeSearchPanel(this.view);
        this.view.focus();
      }
    });

    this.caseBtn = toggleButton("区分大小写", icons.caseSensitive, () => this.onQueryChanged());
    this.regexBtn = toggleButton("正则表达式", icons.regex, () => this.onQueryChanged());
    this.wordBtn = toggleButton("全字匹配", icons.wholeWord, () => this.onQueryChanged());

    this.countEl = document.createElement("span");
    this.countEl.className = "cm-find-count";

    this.modeBtn = iconButton("切换替换", icons.chevronRight, () =>
      this.setReplaceVisible(this.replaceRow.style.display === "none"),
    );
    this.modeBtn.classList.add("cm-find-mode");

    const searchRow = document.createElement("div");
    searchRow.className = "cm-find-row";
    searchRow.append(
      this.searchField,
      this.caseBtn,
      this.wordBtn,
      this.regexBtn,
      this.countEl,
      iconButton("上一个 (⇧↵)", icons.arrowUp, () => findPrevious(this.view)),
      iconButton("下一个 (↵)", icons.arrowDown, () => findNext(this.view)),
      iconButton("关闭 (Esc)", icons.close, () => {
        closeSearchPanel(this.view);
        this.view.focus();
      }),
    );

    this.replaceRow = document.createElement("div");
    this.replaceRow.className = "cm-find-row";
    this.replaceRow.style.display = "none";
    this.replaceRow.append(
      this.replaceField,
      textButton("替换", () => replaceNext(this.view)),
      textButton("全部替换", () => replaceAll(this.view)),
    );

    const rows = document.createElement("div");
    rows.className = "cm-find-rows";
    rows.append(searchRow, this.replaceRow);

    this.dom = document.createElement("div");
    this.dom.className = "cm-find-panel";
    // Keep clicks on panel chrome from collapsing the editor selection.
    this.dom.addEventListener("mousedown", (e) => {
      if (!(e.target instanceof HTMLInputElement)) e.preventDefault();
    });
    this.dom.append(this.modeBtn, rows);
  }

  mount() {
    // mount() runs inside the update that opens the panel, so it must not
    // dispatch — only mirror the state's query (openSearchPanel already
    // seeded it from the selection) into the fields.
    const q = getSearchQuery(this.view.state);
    this.searchField.value = q.search;
    this.replaceField.value = q.replace;
    this.caseBtn.classList.toggle("active", q.caseSensitive);
    this.regexBtn.classList.toggle("active", q.regexp);
    this.wordBtn.classList.toggle("active", q.wholeWord);
    this.refreshCount();
    this.searchField.focus();
    this.searchField.select();
  }

  update(update: ViewUpdate) {
    if (
      update.docChanged ||
      update.selectionSet ||
      update.transactions.some((tr) => tr.effects.some((e) => e.is(setSearchQuery)))
    ) {
      this.refreshCount();
    }
  }

  destroy() {
    panels.delete(this.view);
  }

  setReplaceVisible(visible: boolean) {
    this.replaceRow.style.display = visible ? "" : "none";
    this.modeBtn.innerHTML = visible ? icons.chevronDown : icons.chevronRight;
    if (visible) this.replaceField.focus();
  }

  private buildQuery() {
    return new SearchQuery({
      search: this.searchField.value,
      replace: this.replaceField.value,
      caseSensitive: this.caseBtn.classList.contains("active"),
      regexp: this.regexBtn.classList.contains("active"),
      wholeWord: this.wordBtn.classList.contains("active"),
    });
  }

  private commit() {
    const query = this.buildQuery();
    this.searchField.classList.toggle("invalid", !!query.search && !query.valid);
    this.view.dispatch({ effects: setSearchQuery.of(query) });
    this.refreshCount();
  }

  private onQueryChanged() {
    this.commit();
    this.jumpToFirstMatch();
    this.searchField.focus();
  }

  /** Select the first match at/after the cursor (wrapping) as the user types. */
  private jumpToFirstMatch() {
    const { state } = this.view;
    const query = this.buildQuery();
    if (!query.search || !query.valid) return;
    let cursor = query.getCursor(state, state.selection.main.from);
    let item = cursor.next();
    if (item.done) {
      cursor = query.getCursor(state, 0);
      item = cursor.next();
      if (item.done) return;
    }
    this.view.dispatch({
      selection: { anchor: item.value.from, head: item.value.to },
      effects: EditorView.scrollIntoView(item.value.from, { y: "center" }),
    });
  }

  private refreshCount() {
    const { state } = this.view;
    const query = getSearchQuery(state);
    if (!query.search) {
      this.countEl.textContent = "";
      return;
    }
    if (!query.valid) {
      this.countEl.textContent = "无效";
      return;
    }
    const { total, current } = countMatches(query, state);
    this.countEl.textContent =
      total === 0 ? "无结果" : current ? `${current}/${total}` : `${total} 个匹配`;
  }
}

function countMatches(query: SearchQuery, state: EditorState) {
  const sel = state.selection.main;
  const cursor = query.getCursor(state);
  let total = 0;
  let current = 0;
  for (let item = cursor.next(); !item.done && total < 10_000; item = cursor.next()) {
    total++;
    if (item.value.from === sel.from && item.value.to === sel.to) current = total;
  }
  return { total, current };
}

/**
 * Editor search support: ⌘F find, ⌥⌘F find-and-replace, ↵/⇧↵ or ⌘G/⇧⌘G to
 * step through matches, Esc to close. Other occurrences of the selected text
 * are highlighted passively.
 */
export const editorSearch = [
  search({ top: true, createPanel: (view) => new FindPanel(view) }),
  highlightSelectionMatches(),
  keymap.of([{ key: "Mod-Alt-f", run: openSearchWithReplace }, ...searchKeymap]),
];
