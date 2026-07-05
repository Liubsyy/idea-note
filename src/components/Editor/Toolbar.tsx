import { useState, useRef, useEffect } from "react";
import { createPortal } from "react-dom";
import {
  Bold,
  Italic,
  Strikethrough,
  Code,
  Quote,
  List,
  ListOrdered,
  Braces,
  Minus,
  Link as LinkIcon,
  Image as ImageIcon,
  ImagePlus,
  Undo2,
  Redo2,
  Heading,
  ChevronDown,
  Shapes,
  Table,
  ListChecks,
  Sigma,
  Workflow,
  ChevronRight,
} from "lucide-react";

import type { EditorView } from "@codemirror/view";
import { md } from "../../lib/codemirror/markdownCommands";
import { getActiveView } from "../../lib/codemirror/activeView";
import { pickImage } from "../../lib/fs";
import { useAppStore } from "../../store/useAppStore";

function Divider() {
  return (
    <span
      className="mx-1 h-5 w-px shrink-0"
      style={{ background: "var(--border)" }}
    />
  );
}

interface BtnProps {
  title: string;
  onClick: () => void;
  children: React.ReactNode;
  active?: boolean;
}
function Btn({ title, onClick, children, active }: BtnProps) {
  return (
    <button
      title={title}
      onMouseDown={(e) => e.preventDefault()} // keep editor selection
      onClick={onClick}
      className="flex h-8 w-8 items-center justify-center rounded-md transition-colors"
      style={{
        color: active ? "var(--accent)" : "var(--text)",
        background: active ? "var(--active)" : "transparent",
      }}
      onMouseEnter={(e) => {
        if (!active) e.currentTarget.style.background = "var(--hover)";
      }}
      onMouseLeave={(e) => {
        e.currentTarget.style.background = active
          ? "var(--active)"
          : "transparent";
      }}
    >
      {children}
    </button>
  );
}

/**
 * Icon-and-chevron trigger that opens a portaled menu below it. The menu is
 * portaled to body so the toolbar's `overflow-x` can't clip it; clicking
 * outside, scrolling or resizing closes it. `render` receives a `close`
 * callback so items can dismiss the menu after acting.
 */
function Dropdown({
  title,
  active,
  menuWidth,
  trigger,
  render,
}: {
  title: string;
  active?: boolean;
  menuWidth: number;
  trigger: React.ReactNode;
  render: (close: () => void) => React.ReactNode;
}) {
  const [open, setOpen] = useState(false);
  const [pos, setPos] = useState({ x: 0, y: 0 });
  const triggerRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onDoc = (e: MouseEvent) => {
      const t = e.target as Node;
      if (!triggerRef.current?.contains(t) && !menuRef.current?.contains(t))
        setOpen(false);
    };
    const onLeave = () => setOpen(false);
    document.addEventListener("mousedown", onDoc);
    window.addEventListener("resize", onLeave);
    window.addEventListener("scroll", onLeave, true);
    return () => {
      document.removeEventListener("mousedown", onDoc);
      window.removeEventListener("resize", onLeave);
      window.removeEventListener("scroll", onLeave, true);
    };
  }, [open]);

  const toggle = () => {
    const r = triggerRef.current?.getBoundingClientRect();
    if (r) setPos({ x: r.left, y: r.bottom + 4 });
    setOpen((v) => !v);
  };

  return (
    <>
      <button
        ref={triggerRef}
        title={title}
        onMouseDown={(e) => e.preventDefault()}
        onClick={toggle}
        className="flex h-8 items-center gap-0.5 rounded-md px-1.5 transition-colors"
        style={{
          color: active ? "var(--accent)" : "var(--text)",
          background: active ? "var(--active)" : "transparent",
        }}
        onMouseEnter={(e) => {
          if (!active) e.currentTarget.style.background = "var(--hover)";
        }}
        onMouseLeave={(e) => {
          e.currentTarget.style.background = active
            ? "var(--active)"
            : "transparent";
        }}
      >
        {trigger}
      </button>
      {open &&
        createPortal(
          <div
            ref={menuRef}
            className="fixed z-50 rounded-lg py-1"
            style={{
              left: pos.x,
              top: pos.y,
              width: menuWidth,
              background: "var(--bg-elev)",
              border: "1px solid var(--border)",
              boxShadow: "0 8px 24px var(--shadow)",
            }}
          >
            {render(() => setOpen(false))}
          </div>,
          document.body,
        )}
    </>
  );
}

/** A labelled row in a dropdown menu, optionally with a leading icon. */
function MenuItem({
  icon,
  label,
  active,
  onClick,
  style,
}: {
  icon?: React.ReactNode;
  label: React.ReactNode;
  active?: boolean;
  onClick: () => void;
  style?: React.CSSProperties;
}) {
  return (
    <button
      onMouseDown={(e) => e.preventDefault()}
      onClick={onClick}
      className="flex w-full items-center gap-2 px-3 py-1.5 text-left text-sm transition-colors"
      style={{
        color: active ? "var(--accent)" : "var(--text)",
        background: active ? "var(--active)" : "transparent",
        ...style,
      }}
      onMouseEnter={(e) => {
        if (!active) e.currentTarget.style.background = "var(--hover)";
      }}
      onMouseLeave={(e) => {
        e.currentTarget.style.background = active
          ? "var(--active)"
          : "transparent";
      }}
    >
      {icon}
      <span className="flex-1">{label}</span>
    </button>
  );
}

/**
 * A menu row that expands a second panel to its right on hover. The sub-panel
 * is a DOM descendant, so the pointer moving onto it never fires this row's
 * mouseleave, and it stays inside the parent dropdown for outside-click checks.
 */
function SubMenu({
  icon,
  label,
  children,
}: {
  icon?: React.ReactNode;
  label: React.ReactNode;
  children: React.ReactNode;
}) {
  const [open, setOpen] = useState(false);
  return (
    <div
      className="relative"
      onMouseEnter={() => setOpen(true)}
      onMouseLeave={() => setOpen(false)}
    >
      <div
        className="flex w-full items-center gap-2 px-3 py-1.5 text-sm"
        style={{
          color: "var(--text)",
          background: open ? "var(--hover)" : "transparent",
        }}
      >
        {icon}
        <span className="flex-1">{label}</span>
        <ChevronRight size={13} style={{ color: "var(--text-muted)" }} />
      </div>
      {open && (
        <div
          className="absolute rounded-lg py-1"
          style={{
            left: "100%",
            top: -5,
            width: 132,
            background: "var(--bg-elev)",
            border: "1px solid var(--border)",
            boxShadow: "0 8px 24px var(--shadow)",
          }}
        >
          {children}
        </div>
      )}
    </div>
  );
}

// Mermaid diagram templates offered in the insert > Mermaid submenu. The
// renderer is the full mermaid library, so any diagram type works.
const MERMAID_TYPES: { label: string; body: string }[] = [
  {
    label: "流程图",
    body: "flowchart TD\n    A[开始] --> B{判断}\n    B -->|是| C[执行]\n    B -->|否| D[结束]",
  },
  {
    label: "时序图",
    body: "sequenceDiagram\n    participant A as 用户\n    participant B as 服务器\n    A->>B: 请求\n    B-->>A: 响应",
  },
  {
    label: "甘特图",
    body: "gantt\n    title 项目计划\n    dateFormat YYYY-MM-DD\n    section 阶段一\n    需求分析 :a1, 2024-01-01, 7d\n    设计     :after a1, 5d",
  },
  {
    label: "饼图",
    body: 'pie title 占比\n    "A" : 40\n    "B" : 35\n    "C" : 25',
  },
  {
    label: "类图",
    body: "classDiagram\n    class Animal {\n      +String name\n      +eat()\n    }\n    Animal <|-- Dog",
  },
  {
    label: "状态图",
    body: "stateDiagram-v2\n    [*] --> 待机\n    待机 --> 运行 : 启动\n    运行 --> [*] : 停止",
  },
];

export function Toolbar() {
  const active = useAppStore((s) => s.activeFormats);
  const openPrompt = useAppStore((s) => s.openPrompt);

  const iconSize = 15;
  // Run a command against the active editor view, if any.
  const run = (fn: (v: EditorView) => void) => {
    const v = getActiveView();
    if (v) fn(v);
  };
  const selectedText = () => {
    const v = getActiveView();
    if (!v) return "";
    const range = v.state.selection.main;
    return v.state.sliceDoc(range.from, range.to).trim();
  };

  return (
    <div className="flex items-center gap-0.5 overflow-x-auto px-2">
      {/* Heading dropdown */}
      <Dropdown
        title="标题"
        active={active.heading > 0}
        menuWidth={128}
        trigger={
          <>
            <Heading size={iconSize} />
            <ChevronDown size={13} />
          </>
        }
        render={(close) => (
          <>
            {[1, 2, 3, 4, 5, 6].map((lvl) => (
              <MenuItem
                key={lvl}
                label={`标题 ${lvl}`}
                active={active.heading === lvl}
                style={{ fontSize: `${20 - lvl}px` }}
                onClick={() => {
                  run((v) => md.heading(v, lvl));
                  close();
                }}
              />
            ))}
            <div
              className="my-1 h-px"
              style={{ background: "var(--border)" }}
            />
            <MenuItem
              label="正文"
              onClick={() => {
                run((v) => md.paragraph(v));
                close();
              }}
            />
          </>
        )}
      />

      <Divider />

      <Btn title="加粗 (Ctrl/Cmd+B)" active={active.bold} onClick={() => run(md.bold)}>
        <Bold size={iconSize} />
      </Btn>
      <Btn title="斜体 (Ctrl/Cmd+I)" active={active.italic} onClick={() => run(md.italic)}>
        <Italic size={iconSize} />
      </Btn>
      <Btn title="删除线" active={active.strike} onClick={() => run(md.strike)}>
        <Strikethrough size={iconSize} />
      </Btn>
      <Btn title="行内代码" active={active.code} onClick={() => run(md.inlineCode)}>
        <Code size={iconSize} />
      </Btn>

      <Divider />

      <Btn title="无序列表" active={active.bulletList} onClick={() => run(md.bulletList)}>
        <List size={iconSize} />
      </Btn>
      <Btn title="有序列表" active={active.orderedList} onClick={() => run(md.orderedList)}>
        <ListOrdered size={iconSize} />
      </Btn>
      <Btn title="任务列表" onClick={() => run(md.taskList)}>
        <ListChecks size={iconSize} />
      </Btn>

      <Divider />

      <Btn title="引用" active={active.blockquote} onClick={() => run(md.quote)}>
        <Quote size={iconSize} />
      </Btn>
      <Btn title="代码块" active={active.codeBlock} onClick={() => run(md.codeBlock)}>
        <Braces size={iconSize} />
      </Btn>
      <Btn title="分割线" onClick={() => run(md.hr)}>
        <Minus size={iconSize} />
      </Btn>

      <Divider />

      <Btn
        title="链接"
        active={active.link}
        onClick={() =>
          openPrompt({
            title: "插入链接",
            defaultValue: "https://",
            fields: [
              {
                name: "label",
                label: "显示文本",
                defaultValue: selectedText(),
                placeholder: "链接",
              },
              {
                name: "href",
                label: "链接地址",
                defaultValue: "https://",
                placeholder: "https://example.com",
              },
            ],
            onSubmit: (_value, values) => {
              const href = values.href?.trim();
              if (!href) throw "请填写链接地址";
              run((v) => md.link(v, href, values.label));
            },
          })
        }
      >
        <LinkIcon size={iconSize} />
      </Btn>
      <Btn
        title="本地图片"
        onClick={async () => {
          const path = await pickImage();
          if (path) run((v) => md.image(v, path));
        }}
      >
        <ImagePlus size={iconSize} />
      </Btn>
      <Btn
        title="网络图片"
        onClick={() =>
          openPrompt({
            title: "图片地址",
            defaultValue: "https://",
            onSubmit: (src) => {
              if (src.trim()) run((v) => md.image(v, src.trim()));
            },
          })
        }
      >
        <ImageIcon size={iconSize} />
      </Btn>

      {/* Insert dropdown — block templates the editor renders but that have no
          single-key syntax: table, task list, math, mermaid. */}
      <Dropdown
        title="插入"
        menuWidth={168}
        trigger={
          <>
            <Shapes size={iconSize} />
            <ChevronDown size={13} />
          </>
        }
        render={(close) => (
          <>
            <MenuItem
              icon={<Table size={15} />}
              label="表格"
              onClick={() => {
                run(md.table);
                close();
              }}
            />
            <MenuItem
              icon={<Sigma size={15} />}
              label="数学公式"
              onClick={() => {
                run(md.mathBlock);
                close();
              }}
            />
            <SubMenu icon={<Workflow size={15} />} label="Mermaid 图表">
              {MERMAID_TYPES.map((t) => (
                <MenuItem
                  key={t.label}
                  label={t.label}
                  onClick={() => {
                    run((v) => md.mermaid(v, t.body));
                    close();
                  }}
                />
              ))}
            </SubMenu>
          </>
        )}
      />

      <Divider />

      <Btn title="撤销 (Ctrl/Cmd+Z)" onClick={() => run(md.undo)}>
        <Undo2 size={iconSize} />
      </Btn>
      <Btn title="重做 (Ctrl/Cmd+Shift+Z)" onClick={() => run(md.redo)}>
        <Redo2 size={iconSize} />
      </Btn>
    </div>
  );
}
