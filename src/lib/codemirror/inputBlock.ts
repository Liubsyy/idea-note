// Controls for ```input blocks.
//
// Same shape as the table / math / mermaid renderers: a StateField (block
// decorations may not come from a ViewPlugin) replaces the fenced block with a
// widget while the selection is elsewhere, and gets out of the way — showing
// the raw DSL — as soon as the cursor lands inside it.
//
// What is different here is that the widget is *stateful*. Values live in
// useInputStore, not in the document, so moving a slider never touches the
// text: no transaction, no undo entry, no git diff. That also means the
// decoration is NOT rebuilt while the user drags — the DOM the field created
// stays mounted, which is the only way a drag can survive at all.

import { EditorState, Range, StateField } from "@codemirror/state";
import {
  Decoration,
  DecorationSet,
  EditorView,
  WidgetType,
} from "@codemirror/view";

import {
  blockHeightKey,
  estimatedBlockHeight,
  trackBlockHeight,
  untrackBlockHeight,
} from "./blockHeight";
import { scanInputBlocks, type InputBlockInfo } from "../inputs/sources";
import {
  coerce,
  isMoment,
  literalOf,
  type InputField,
  type InputValue,
} from "../inputs/schema";
import { inputKey, useInputStore, valuesFor } from "../../store/useInputStore";
import { useAppStore } from "../../store/useAppStore";

const el = <K extends keyof HTMLElementTagNameMap>(
  tag: K,
  className?: string,
): HTMLElementTagNameMap[K] => {
  const node = document.createElement(tag);
  if (className) node.className = className;
  return node;
};

/** Interactive controls must keep their own clicks: CodeMirror would otherwise
 *  move the caret into the block and collapse the widget mid-drag. */
const isControl = (target: EventTarget | null): boolean =>
  target instanceof HTMLElement &&
  target.closest("input, select, button, textarea, label") !== null;

/* --------------------------- 固化为默认值 ------------------------------- */

/** Split the trailing `{…}` off a field line, keeping the exact text of both. */
function splitLine(line: string): { head: string; opts: string | null } {
  const open = line.indexOf("{");
  const close = line.lastIndexOf("}");
  if (open < 0 || close < open) return { head: line, opts: null };
  return { head: line.slice(0, open), opts: line.slice(open, close + 1) };
}

/** Set `default: value` inside an existing `{…}`, or add the braces. */
function withDefault(opts: string | null, literal: string): string {
  if (!opts) return ` {default: ${literal}}`;
  const body = opts.slice(1, -1);
  const entries = body.split(",").map((e) => e.trim()).filter(Boolean);
  const i = entries.findIndex((e) => /^default\s*[:=]/i.test(e));
  if (i >= 0) entries[i] = `default: ${literal}`;
  else entries.push(`default: ${literal}`);
  return `{${entries.join(", ")}}`;
}

/**
 * Write the current values back into the block's source as its new defaults.
 *
 * A `select` keeps its list of options and gets a `{default: …}` instead —
 * replacing `[20, 25, 30]` with `30` would silently turn a dropdown into a
 * number field.
 */
function pinDefaults(view: EditorView, block: InputBlockInfo, key: string): void {
  // Only fields the user actually changed are rewritten: touching the others
  // would reformat lines nobody edited, and turn 固化 into a diff of the whole
  // block instead of the one value it is about.
  const changed = useInputStore.getState().values[key] ?? {};
  if (Object.keys(changed).length === 0) return;
  const values = valuesFor(key, block.schema);
  const byName = new Map(block.schema.fields.map((f) => [f.name, f]));
  const lines = block.source.split("\n").map((line) => {
    const name = line.trim().match(/^([A-Za-z_][A-Za-z0-9_]*)/)?.[1];
    const field = name ? byName.get(name) : undefined;
    if (!field || !(field.name in changed)) return line;
    const literal = literalOf(field, values[field.name]);
    const { head, opts } = splitLine(line);
    if (field.type === "select") return head.replace(/\s*$/, " ") + withDefault(opts, literal);
    const eq = head.indexOf("=");
    const lhs = eq >= 0 ? head.slice(0, eq) : `${head.replace(/\s*$/, "")} `;
    return `${lhs}= ${literal}${opts ? ` ${opts}` : ""}`;
  });

  // The body sits between the two fence lines; replace exactly that.
  const doc = view.state.doc;
  const openLine = doc.lineAt(block.from);
  const closeLine = doc.lineAt(block.to);
  if (closeLine.number <= openLine.number + 1) return;
  view.dispatch({
    changes: {
      from: doc.line(openLine.number + 1).from,
      to: doc.line(closeLine.number - 1).to,
      insert: lines.join("\n"),
    },
  });
  useInputStore.getState().reset(key);
}

/* -------------------------------- controls ------------------------------ */

interface ControlHandle {
  /** Push a value in from the store (an outside reset, another widget). */
  sync: (value: InputValue) => void;
}

/** Never write into the control the user is holding: assigning `.value` to a
 *  focused field can move the caret, and re-setting a slider mid-drag fights
 *  the pointer. The control that caused the change is already up to date. */
const idle = (node: HTMLElement): boolean => document.activeElement !== node;

function buildControl(
  field: InputField,
  value: InputValue,
  onChange: (value: InputValue) => void,
): { node: HTMLElement; handle: ControlHandle } {
  const row = el("div", "cm-md-input-control");

  if (field.type === "bool") {
    const box = document.createElement("input");
    box.type = "checkbox";
    box.checked = value === true;
    box.addEventListener("change", () => onChange(box.checked));
    row.append(box);
    return {
      node: row,
      handle: {
        sync: (v) => {
          if (idle(box)) box.checked = v === true;
        },
      },
    };
  }

  if (field.type === "select") {
    const select = document.createElement("select");
    for (const option of field.options) {
      const item = document.createElement("option");
      item.value = String(option);
      item.textContent = String(option);
      select.append(item);
    }
    select.value = String(value);
    select.addEventListener("change", () => onChange(coerce(field, select.value)));
    row.append(select);
    return {
      node: row,
      handle: {
        sync: (v) => {
          if (idle(select)) select.value = String(v);
        },
      },
    };
  }

  if (field.type === "number") {
    const number = document.createElement("input");
    number.type = "number";
    number.value = String(value);
    if (field.min !== null) number.min = String(field.min);
    if (field.max !== null) number.max = String(field.max);
    if (field.step !== null) number.step = String(field.step);

    let slider: HTMLInputElement | null = null;
    if (field.slider) {
      slider = document.createElement("input");
      slider.type = "range";
      slider.min = String(field.min ?? 0);
      slider.max = String(field.max ?? 100);
      slider.step = String(field.step ?? 1);
      slider.value = String(value);
      slider.addEventListener("input", () => {
        number.value = slider!.value;
        onChange(coerce(field, Number(slider!.value)));
      });
      row.append(slider);
    }
    // Typing is not clamped — with `min: 1000`, clamping on every keystroke
    // would rewrite "5" to "1000" before the user reaches "50000". The value is
    // brought into range when the field is committed (blur / Enter).
    const commit = (clamp: boolean) => {
      const raw = number.value.trim();
      if (!raw) return;
      const n = Number(raw);
      if (!Number.isFinite(n)) return;
      const next = clamp ? coerce(field, n) : n;
      if (clamp && String(next) !== number.value) number.value = String(next);
      if (slider) slider.value = String(next);
      onChange(next);
    };
    number.addEventListener("input", () => commit(false));
    number.addEventListener("change", () => commit(true));
    row.append(number);
    return {
      node: row,
      handle: {
        sync: (v) => {
          if (idle(number)) number.value = String(v);
          if (slider && idle(slider)) slider.value = String(v);
        },
      },
    };
  }

  if (isMoment(field.type)) {
    const picker = document.createElement("input");
    picker.type = field.type === "datetime" ? "datetime-local" : field.type;
    picker.value = String(value);
    if (field.min !== null) picker.min = String(field.min);
    if (field.max !== null) picker.max = String(field.max);
    if (field.step !== null) picker.step = String(field.step);
    // A picker reads "" until the date it is holding is complete, so a value
    // being typed in briefly looks cleared. That is the same state as an empty
    // picker, and the script sees an empty string either way.
    picker.addEventListener("input", () => onChange(coerce(field, picker.value)));
    row.append(picker);
    return {
      node: row,
      handle: {
        sync: (v) => {
          if (idle(picker)) picker.value = String(v);
        },
      },
    };
  }

  const text = document.createElement("input");
  text.type = "text";
  text.value = String(value);
  text.addEventListener("input", () => onChange(text.value));
  row.append(text);
  return {
    node: row,
    handle: {
      sync: (v) => {
        if (idle(text)) text.value = String(v);
      },
    },
  };
}

/* --------------------------------- widget ------------------------------- */

class InputWidget extends WidgetType {
  constructor(
    readonly block: InputBlockInfo,
    readonly filePath: string,
  ) {
    super();
  }
  eq(o: InputWidget) {
    // Values deliberately don't take part: they change without the document
    // changing, and rebuilding here would drop the control the user is holding.
    return (
      o.block.source === this.block.source &&
      o.block.id === this.block.id &&
      o.block.from === this.block.from &&
      o.filePath === this.filePath
    );
  }
  get estimatedHeight() {
    return estimatedBlockHeight(blockHeightKey("input", this.block.from));
  }

  toDOM(view: EditorView) {
    const key = inputKey(this.filePath, this.block.id);
    // Spacing lives on the outer element as padding, never as a margin: block
    // widgets are measured by their border box, so a margin would be invisible
    // to the height map and knock clicks onto the wrong line further down.
    const wrap = el("div", "cm-md-input");
    const card = el("div", "cm-md-input-card");
    wrap.append(card);
    const readOnly = view.state.readOnly;

    const head = el("div", "cm-md-input-head");
    const title = el("span", "cm-md-input-title");
    title.textContent = this.block.named ? `参数 · ${this.block.id}` : "参数";
    head.append(title);

    if (!readOnly) {
      const pin = el("button", "cm-md-input-btn");
      pin.type = "button";
      pin.textContent = "固化为默认值";
      pin.title = "把当前值写回笔记，作为这个块的新默认值";
      pin.addEventListener("click", () => pinDefaults(view, this.block, key));

      const reset = el("button", "cm-md-input-btn");
      reset.type = "button";
      reset.textContent = "重置";
      reset.title = "恢复笔记里写的默认值";
      reset.addEventListener("click", () => useInputStore.getState().reset(key));
      head.append(pin, reset);
    }
    card.append(head);

    const values = valuesFor(key, this.block.schema);
    const handles = new Map<string, ControlHandle>();
    const grid = el("div", "cm-md-input-grid");

    for (const field of this.block.schema.fields) {
      const label = el("label", "cm-md-input-label");
      label.textContent = field.label;
      const { node, handle } = buildControl(field, values[field.name], (next) => {
        useInputStore.getState().set(key, field.name, next);
      });
      if (readOnly)
        node.querySelectorAll("input, select").forEach((c) => {
          (c as HTMLInputElement).disabled = true;
        });
      if (field.unit) {
        const unit = el("span", "cm-md-input-unit");
        unit.textContent = field.unit;
        node.append(unit);
      }
      handles.set(field.name, handle);
      grid.append(label, node);
    }
    card.append(grid);

    for (const error of this.block.schema.errors) {
      const line = el("div", "cm-md-input-error");
      line.textContent = `第 ${error.line} 行：${error.message}`;
      card.append(line);
    }
    if (this.block.schema.fields.length === 0 && this.block.schema.errors.length === 0) {
      const empty = el("div", "cm-md-input-error");
      empty.textContent = "空的 input 块。写法：名字: number = 100 {slider: 0..1000}";
      card.append(empty);
    }

    // Reflect changes made elsewhere (重置, another widget on the same block).
    // Guarded by a comparison so a control isn't rewritten under the pointer.
    const unsubscribe = useInputStore.subscribe((state) => {
      if (state.lastChanged !== null && state.lastChanged !== key) return;
      const next = valuesFor(key, this.block.schema);
      for (const [name, handle] of handles) handle.sync(next[name]);
    });
    CLEANUPS.set(wrap, unsubscribe);

    // Click on the chrome (not a control) reveals the source, like the other
    // block widgets do.
    wrap.addEventListener("mousedown", (e) => {
      if (isControl(e.target)) return;
      e.preventDefault();
      view.dispatch({ selection: { anchor: this.block.from } });
      view.focus();
    });

    trackBlockHeight(wrap, () => blockHeightKey("input", this.block.from));
    return wrap;
  }

  destroy(dom: HTMLElement) {
    CLEANUPS.get(dom)?.();
    CLEANUPS.delete(dom);
    untrackBlockHeight(dom);
  }
  ignoreEvent() {
    return true;
  }
}

const CLEANUPS = new WeakMap<HTMLElement, () => void>();

function buildInputs(state: EditorState): DecorationSet {
  const ranges: Range<Decoration>[] = [];
  const filePath = useAppStore.getState().activeFilePath ?? "";
  for (const block of scanInputBlocks(state.doc)) {
    const inside =
      !state.readOnly &&
      state.selection.ranges.some((r) => r.from <= block.to && r.to >= block.from);
    if (inside) continue;
    ranges.push(
      Decoration.replace({
        widget: new InputWidget(block, filePath),
        block: true,
      }).range(block.from, block.to),
    );
  }
  return Decoration.set(ranges, true);
}

export const inputBlock = StateField.define<DecorationSet>({
  create: (state) => buildInputs(state),
  update(deco, tr) {
    if (
      tr.docChanged ||
      tr.selection ||
      tr.startState.readOnly !== tr.state.readOnly
    )
      return buildInputs(tr.state);
    return deco.map(tr.changes);
  },
  provide: (f) => EditorView.decorations.from(f),
});
