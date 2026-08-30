import { useEffect, useMemo, useState } from "react";
import { createPortal } from "react-dom";

import { useAppStore } from "../../store/useAppStore";
import type {
  OutKind,
  ResultPlacement,
  RunTrigger,
} from "../../lib/codeRun/fenceAttrs";
import {
  buildComponentSnippet,
  type ComponentSource,
} from "../../lib/codeRun/componentTemplate";

/**
 * The 可交互组件 dialog: pick where a block's inputs come from and how its
 * output is drawn, and get a working example.
 *
 * The whole point is that the answer is *visible before you commit* — the
 * preview below the fields is the exact markdown the editor will receive, so
 * the fence attributes stop being something you have to memorise from the docs.
 */

const SOURCES: { value: ComponentSource; label: string; hint: string }[] = [
  { value: "none", label: "无", hint: "不读取任何输入" },
  { value: "input", label: "参数控件", hint: "生成一个 input 块，渲染成滑块/输入框" },
  { value: "table", label: "文档表格", hint: "读取本笔记里某张 Markdown 表格" },
  { value: "file", label: "外部文件", hint: "读取笔记同目录下的 CSV / JSON" },
];

/** `watch` needs an input block to watch; `open` works with any source. */
const TRIGGERS: {
  value: Exclude<RunTrigger, "manual">;
  label: string;
  hint: string;
}[] = [
  { value: "watch", label: "监听输入", hint: "参数控件一变就重新运行" },
  { value: "open", label: "打开时触发", hint: "每次会话里第一次打开这篇笔记时运行一次" },
];

const OUTS: { value: OutKind; label: string }[] = [
  { value: "text", label: "文本" },
  { value: "table", label: "表格" },
  { value: "json", label: "JSON" },
  { value: "mermaid", label: "流程图" },
  { value: "html", label: "HTML" },
  { value: "image", label: "图片" },
  { value: "markdown", label: "Markdown" },
];

/** Field label and starting value for the name box, per source. */
const NAME_FIELD: Record<
  ComponentSource,
  { label: string; value: string; placeholder: string } | null
> = {
  none: null,
  input: { label: "参数块名称", value: "params", placeholder: "params" },
  table: { label: "表格名称（上方标题）", value: "销售数据", placeholder: "销售数据" },
  file: { label: "文件路径", value: "./data.csv", placeholder: "./data.csv" },
};

const selectStyle = {
  color: "var(--text)",
  background: "var(--bg)",
  border: "1px solid var(--border)",
};

export function CodeComponentModal({
  onInsert,
  onClose,
}: {
  onInsert: (snippet: string) => void;
  onClose: () => void;
}) {
  const runners = useAppStore((s) => s.codeRunConfig.runners);
  // Only languages that can actually run — an example in a disabled runner's
  // language would insert a block with no run button. With every runner off,
  // fall back to python so the dialog still produces something meaningful.
  const languages = useMemo(() => {
    const enabled = runners.filter((r) => r.enabled).map((r) => r.lang);
    return enabled.length ? enabled : ["python"];
  }, [runners]);

  const [lang, setLang] = useState(() => languages[0] ?? "python");
  const [source, setSource] = useState<ComponentSource>("input");
  const [name, setName] = useState(NAME_FIELD.input!.value);
  const [out, setOut] = useState<OutKind>("markdown");
  const [triggers, setTriggers] = useState<RunTrigger[]>(["watch"]);
  const [placement, setPlacement] = useState<ResultPlacement>("above");

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [onClose]);

  // Switching source swaps in that source's example name, so the preview is
  // never left showing a table name in a file path field. 监听输入 has nothing
  // to watch without controls; selecting 参数控件 adds it by default.
  const changeSource = (next: ComponentSource) => {
    setSource(next);
    setName(NAME_FIELD[next]?.value ?? "");
    setTriggers((current) => {
      if (next === "input")
        return current.includes("watch") ? current : ["watch", ...current];
      return current.filter((trigger) => trigger !== "watch");
    });
  };

  const toggleTrigger = (trigger: Exclude<RunTrigger, "manual">) => {
    setTriggers((current) =>
      current.includes(trigger)
        ? current.filter((item) => item !== trigger)
        : [...current, trigger],
    );
  };

  const nameField = NAME_FIELD[source];
  const snippet = buildComponentSnippet({
    lang,
    source,
    name: name.trim() || nameField?.value || "",
    out,
    triggers,
    placement,
  });

  const row = (label: string, control: React.ReactNode, hint?: string) => (
    <div>
      <div className="mb-1 text-xs" style={{ color: "var(--text-soft)" }}>
        {label}
      </div>
      {control}
      {hint && (
        <div className="mt-1 text-[11px]" style={{ color: "var(--text-muted)" }}>
          {hint}
        </div>
      )}
    </div>
  );

  // Rendered into <body> rather than in place: the toolbar row this modal is
  // mounted from carries `backdrop-blur`, and an element with a backdrop-filter
  // becomes the containing block for its fixed-position descendants — the
  // overlay would cover the 44px toolbar instead of the window, and the editor
  // would paint straight over it. The toolbar's own dropdowns portal for the
  // same reason.
  const modal = (
    <div
      className="fixed inset-0 z-[60] flex items-start justify-center"
      style={{ background: "rgba(0,0,0,0.35)" }}
      onMouseDown={onClose}
    >
      <div
        className="mt-20 max-h-[80vh] overflow-y-auto rounded-xl p-4"
        style={{
          width: "min(520px, calc(100vw - 32px))",
          background: "var(--bg-elev)",
          border: "1px solid var(--border)",
          boxShadow: "0 12px 40px var(--shadow)",
        }}
        onMouseDown={(e) => e.stopPropagation()}
      >
        <div className="mb-3 text-sm font-semibold" style={{ color: "var(--text)" }}>
          插入可交互组件
        </div>

        <div className="space-y-3">
          <div className="flex gap-3">
            <div className="flex-1">
              {row(
                "语言",
                <select
                  value={lang}
                  onChange={(e) => setLang(e.target.value)}
                  className="w-full rounded px-2 py-1 text-sm outline-none"
                  style={selectStyle}
                >
                  {languages.map((id) => (
                    <option key={id} value={id}>
                      {id}
                    </option>
                  ))}
                </select>,
              )}
            </div>
            <div className="flex-1">
              {row(
                "输出渲染",
                <select
                  value={out}
                  onChange={(e) => setOut(e.target.value as OutKind)}
                  className="w-full rounded px-2 py-1 text-sm outline-none"
                  style={selectStyle}
                >
                  {OUTS.map((o) => (
                    <option key={o.value} value={o.value}>
                      {o.label}
                    </option>
                  ))}
                </select>,
              )}
            </div>
          </div>

          {row(
            "输入来源",
            <select
              value={source}
              onChange={(e) => changeSource(e.target.value as ComponentSource)}
              className="w-full rounded px-2 py-1 text-sm outline-none"
              style={selectStyle}
            >
              {SOURCES.map((s) => (
                <option key={s.value} value={s.value}>
                  {s.label}
                </option>
              ))}
            </select>,
            SOURCES.find((s) => s.value === source)?.hint,
          )}

          {nameField &&
            row(
              nameField.label,
              <input
                value={name}
                placeholder={nameField.placeholder}
                onChange={(e) => setName(e.target.value)}
                className="w-full rounded px-2 py-1 text-sm outline-none"
                style={selectStyle}
              />,
              source === "file"
                ? "相对于本笔记，且必须在工作区内；这个文件需要事先存在"
                : source === "table"
                  ? "会一并插入一张同名的示例表格，插入后即可直接运行"
                  : undefined,
            )}

          <div className="flex gap-3">
            <div className="flex-1">
              {row(
                "触发（可多选）",
                <div
                  className="space-y-1 rounded px-2 py-1.5"
                  style={selectStyle}
                >
                  {TRIGGERS.map((t) => {
                    const disabled = t.value === "watch" && source !== "input";
                    return (
                      <label
                        key={t.value}
                        className={`flex items-start gap-2 text-sm ${disabled ? "opacity-50" : "cursor-pointer"}`}
                      >
                        <input
                          type="checkbox"
                          className="mt-0.5 accent-[var(--accent)]"
                          checked={triggers.includes(t.value)}
                          disabled={disabled}
                          onChange={() => toggleTrigger(t.value)}
                        />
                        <span>
                          <span style={{ color: "var(--text)" }}>{t.label}</span>
                          <span
                            className="ml-1 text-[11px]"
                            style={{ color: "var(--text-muted)" }}
                          >
                            {t.hint}
                          </span>
                        </span>
                      </label>
                    );
                  })}
                </div>,
                triggers.length === 0 ? "未选择时只有点运行按钮才执行" : undefined,
              )}
            </div>
            <div className="flex-1">
              {row(
                "结果位置",
                <select
                  value={placement}
                  onChange={(e) => setPlacement(e.target.value as ResultPlacement)}
                  className="w-full rounded px-2 py-1 text-sm outline-none"
                  style={selectStyle}
                >
                  <option value="above">代码块上方</option>
                  <option value="below">代码块下方</option>
                </select>,
                triggers.includes("open")
                  ? "自动运行会先问一次；本次会话内不再询问"
                  : undefined,
              )}
            </div>
          </div>

          {row(
            "预览",
            <pre
              className="max-h-52 overflow-auto rounded p-2 text-[11px] leading-relaxed"
              style={{
                color: "var(--text)",
                background: "var(--code-bg)",
                border: "1px solid var(--border)",
              }}
            >
              {snippet}
            </pre>,
          )}
        </div>

        <div className="mt-4 flex justify-end gap-2">
          <button
            onClick={onClose}
            className="rounded px-3 py-1 text-sm"
            style={{ color: "var(--text)", border: "1px solid var(--border)" }}
          >
            取消
          </button>
          <button
            onClick={() => onInsert(snippet)}
            className="rounded px-3 py-1 text-sm"
            style={{ color: "#fff", background: "var(--accent)" }}
          >
            插入
          </button>
        </div>
      </div>
    </div>
  );

  return createPortal(modal, document.body);
}
