// Shared actions behind the Markdown toolbar and its keyboard shortcuts.
// Keeping prompts, templates and scratch colour state here ensures a toolbar
// click and the matching key binding always produce the same edit.

import type { Command, EditorView } from "@codemirror/view";

import { pickImage } from "../fs";
import { useAppStore } from "../../store/useAppStore";
import { getActiveView } from "./activeView";
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

const openImagePrompt = editableAction((view) => {
  useAppStore.getState().openPrompt({
    title: "插入图片",
    defaultValue: "",
    fields: [
      {
        name: "alt",
        label: "替代文本",
        defaultValue: selectedText(view),
        placeholder: "图片说明",
      },
      {
        name: "src",
        label: "图片地址或本地路径",
        defaultValue: "",
        placeholder: "https://example.com/image.png",
        actionLabel: "选择本地图片",
        onAction: pickImage,
      },
    ],
    onSubmit: (_value, values) => {
      const src = values.src?.trim();
      if (!src) throw "请选择本地图片或填写图片地址";
      md.image(activeEditableView(), src, values.alt);
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
