// Shared actions behind the Markdown toolbar and its keyboard shortcuts.
// Keeping prompts, templates and scratch colour state here ensures a toolbar
// click and the matching key binding always produce the same edit.

import type { Command, EditorView } from "@codemirror/view";

import { pickImage } from "../fs";
import { NO_IMAGE_SIZE, parseImageDimension } from "../imageSyntax";
import { useAppStore } from "../../store/useAppStore";
import { getActiveView } from "./activeView";
import { imageAt } from "./imageAt";
import { md } from "./markdownCommands";

const LAST_COLORS_KEY = "idea-note:last-colors";
export const DEFAULT_LAST_COLORS = { text: "#e11d48", bg: "#fef08a" };

export interface LastMarkdownColors {
  text: string;
  bg: string;
}

export function loadLastMarkdownColors(): LastMarkdownColors {
  try {
    const saved = JSON.parse(localStorage.getItem(LAST_COLORS_KEY) ?? "{}");
    return {
      text:
        typeof saved.text === "string"
          ? saved.text
          : DEFAULT_LAST_COLORS.text,
      bg:
        typeof saved.bg === "string" ? saved.bg : DEFAULT_LAST_COLORS.bg,
    };
  } catch {
    return DEFAULT_LAST_COLORS;
  }
}

export function saveLastMarkdownColors(colors: LastMarkdownColors) {
  localStorage.setItem(LAST_COLORS_KEY, JSON.stringify(colors));
}

export const MERMAID_TYPES: {
  commandId: string;
  label: string;
  body: string;
}[] = [
  {
    commandId: "markdownMermaidFlowchart",
    label: "流程图",
    body: "flowchart TD\n    A[开始] --> B{判断}\n    B -->|是| C[执行]\n    B -->|否| D[结束]",
  },
  {
    commandId: "markdownMermaidSequence",
    label: "时序图",
    body: "sequenceDiagram\n    participant A as 用户\n    participant B as 服务器\n    A->>B: 请求\n    B-->>A: 响应",
  },
  {
    commandId: "markdownMermaidGantt",
    label: "甘特图",
    body: "gantt\n    title 项目计划\n    dateFormat YYYY-MM-DD\n    section 阶段一\n    需求分析 :a1, 2024-01-01, 7d\n    设计     :after a1, 5d",
  },
  {
    commandId: "markdownMermaidPie",
    label: "饼图",
    body: 'pie title 占比\n    "A" : 40\n    "B" : 35\n    "C" : 25',
  },
  {
    commandId: "markdownMermaidClass",
    label: "类图",
    body: "classDiagram\n    class Animal {\n      +String name\n      +eat()\n    }\n    Animal <|-- Dog",
  },
  {
    commandId: "markdownMermaidState",
    label: "状态图",
    body: "stateDiagram-v2\n    [*] --> 待机\n    待机 --> 运行 : 启动\n    运行 --> [*] : 停止",
  },
];

function selectedText(view: EditorView) {
  const range = view.state.selection.main;
  return view.state.sliceDoc(range.from, range.to).trim();
}

function editableAction(action: (view: EditorView) => void): Command {
  return (view) => {
    if (view.state.readOnly) return false;
    action(view);
    return true;
  };
}

function activeEditableView(): EditorView {
  const view = getActiveView();
  if (!view || view.state.readOnly) throw "当前文档不可编辑";
  return view;
}

const openLinkPrompt = editableAction((view) => {
  useAppStore.getState().openPrompt({
    title: "插入链接",
    defaultValue: "https://",
    fields: [
      {
        name: "label",
        label: "显示文本",
        defaultValue: selectedText(view),
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
      md.link(activeEditableView(), href, values.label);
    },
  });
});

// Insert an image, or edit the one under the cursor — same dialog either way
// (so a size can be set right when inserting), prefilled from that image when
// there is one. md.image() resolves the target again on submit, so it stays
// correct even if the document moved while the dialog was open.
const openImagePrompt = editableAction((view) => {
  const current = imageAt(view.state, view.state.selection.main.head);
  const size = current?.size ?? NO_IMAGE_SIZE;
  useAppStore.getState().openPrompt({
    title: current ? "编辑图片" : "插入图片",
    defaultValue: "",
    fields: [
      {
        name: "alt",
        label: "替代文本",
        defaultValue: current?.alt ?? selectedText(view),
        placeholder: "图片说明",
      },
      {
        name: "src",
        label: "图片地址或本地路径",
        defaultValue: current?.url ?? "",
        placeholder: "https://example.com/image.png",
        actionLabel: "选择本地图片",
        onAction: pickImage,
      },
      {
        name: "width",
        label: "显示尺寸",
        defaultValue: size.width,
        placeholder: "宽",
        group: "size",
        hint: "留空为原始尺寸；只填一边时另一边按比例缩放，可用像素或百分比（如 300、50%）",
      },
      {
        name: "height",
        label: "高度",
        defaultValue: size.height,
        placeholder: "高",
        group: "size",
        prefix: "×",
      },
    ],
    onSubmit: (_value, values) => {
      const src = values.src?.trim();
      if (!src) throw "请选择本地图片或填写图片地址";
      const width = parseImageDimension(values.width ?? "");
      const height = parseImageDimension(values.height ?? "");
      if (width === null || height === null)
        throw "尺寸只能填数字或百分比，如 300、50%";
      md.image(activeEditableView(), src, values.alt, { width, height });
    },
  });
});

/** Stable command ids are persisted in user settings, so never rename them. */
export const MARKDOWN_ACTIONS: Record<string, Command> = {
  markdownParagraph: editableAction(md.paragraph),
  markdownHeading1: editableAction((v) => md.heading(v, 1)),
  markdownHeading2: editableAction((v) => md.heading(v, 2)),
  markdownHeading3: editableAction((v) => md.heading(v, 3)),
  markdownHeading4: editableAction((v) => md.heading(v, 4)),
  markdownHeading5: editableAction((v) => md.heading(v, 5)),
  markdownHeading6: editableAction((v) => md.heading(v, 6)),
  markdownBold: editableAction(md.bold),
  markdownItalic: editableAction(md.italic),
  markdownStrike: editableAction(md.strike),
  markdownInlineCode: editableAction(md.inlineCode),
  markdownTextColor: editableAction((v) =>
    md.textColor(v, loadLastMarkdownColors().text),
  ),
  markdownBgColor: editableAction((v) =>
    md.bgColor(v, loadLastMarkdownColors().bg),
  ),
  markdownClearColor: editableAction(md.clearColor),
  markdownBulletList: editableAction(md.bulletList),
  markdownOrderedList: editableAction(md.orderedList),
  markdownTaskList: editableAction(md.taskList),
  markdownQuote: editableAction(md.quote),
  markdownHighlightBlock: editableAction(md.highlightBlock),
  markdownCodeBlock: editableAction(md.codeBlock),
  markdownHr: editableAction(md.hr),
  markdownLink: openLinkPrompt,
  markdownImage: openImagePrompt,
  markdownTable: editableAction(md.table),
  markdownMathBlock: editableAction(md.mathBlock),
  ...Object.fromEntries(
    MERMAID_TYPES.map((item) => [
      item.commandId,
      editableAction((v) => md.mermaid(v, item.body)),
    ]),
  ),
};
