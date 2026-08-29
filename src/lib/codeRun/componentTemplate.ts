// The example a 可交互组件 dialog inserts.
//
// The dialog collects four decisions — language, where the inputs come from,
// how the output is rendered, where the result sits — and this module turns
// them into a block that *runs as written*. An example that has to be fixed
// before it works teaches the wrong thing, so every combination produces
// something printable, and languages whose example would be a lie (JSON
// decoding in bash) get an honest comment instead of fake code.

import type { OutKind, ResultPlacement, RunTrigger } from "./fenceAttrs";

/** Where the block reads its inputs from. */
export type ComponentSource = "none" | "input" | "table" | "file";

export interface ComponentOptions {
  /** Runner language id (`python`, `node`, …). */
  lang: string;
  source: ComponentSource;
  /** Input block id, table name or file path, depending on `source`. */
  name: string;
  out: OutKind;
  /** Automatic triggers. More than one may be enabled at the same time. */
  triggers?: RunTrigger[];
  /** Backwards-compatible single-trigger input for existing callers. */
  trigger?: RunTrigger;
  placement: ResultPlacement;
}

/**
 * The sample table a `in=table:` example brings with it.
 *
 * Without it the inserted block would name a table that isn't there and fail on
 * its first run — an example is only an example if it runs. The name is written
 * as a bold line rather than a heading so dropping one into a note doesn't
 * rearrange its outline; findTable() matches either.
 */
const sampleTable = (name: string): string =>
  [
    `**${name}**`,
    "",
    "| 月份 | 渠道 | 金额 |",
    "| :--- | :--- | ---: |",
    "| 1月 | 线上 | 1200 |",
    "| 2月 | 线上 | 1580 |",
    "| 3月 | 门店 | 990 |",
  ].join("\n");

/** The sample parameters an `input` block starts with. */
const SAMPLE_FIELDS = [
  "amount: number = 500000 {slider: 0..2000000, step: 10000, label: 金额, unit: 元}",
  "rate:   number = 3.85 {step: 0.05, label: 比例, unit: %}",
  "title:  text = \"示例\"",
];

/* ------------------------------- languages ------------------------------ */

/**
 * The few things an example needs to say in each language. Printing a literal
 * and printing "text + one environment variable + text" cover every output
 * kind; anything more specific is handled by `rowsExample`.
 */
interface Emit {
  /** Lines that set the script up (imports, decoding the JSON payload). */
  prelude: (needs: { env: boolean; json: boolean }) => string[];
  /** Print a literal line. */
  lit: (text: string) => string;
  /** Print `prefix` + the `name` environment variable + `suffix`. */
  env: (prefix: string, name: string, suffix: string) => string;
  comment: (text: string) => string;
  /** Echo bound rows back out as CSV — the `out=table` starting point. Absent
   *  where it would take more explaining than a comment is worth. */
  rowsExample?: (key: string) => string[];
}

/** A double-quoted string literal, safe in C-like and Python syntax. */
const dq = (text: string) => JSON.stringify(text);

/** A single-quoted PowerShell literal: it has no backslash escapes, so `dq`
 *  would emit `\"` verbatim into the output. Doubling `'` is the only escape. */
const psq = (text: string) => `'${text.replace(/'/g, "''")}'`;

const EMITTERS: Record<string, Emit> = {
  python: {
    prelude: ({ env, json }) =>
      json
        ? ["import json, os", "", 'data = json.loads(os.environ["IDEA_NOTE_INPUT"])']
        : env
          ? ["import os"]
          : [],
    lit: (text) => `print(${dq(text)})`,
    env: (prefix, name, suffix) =>
      `print(${[
        prefix && `${dq(prefix)} + `,
        `os.environ[${dq(name)}]`,
        suffix && ` + ${dq(suffix)}`,
      ]
        .filter(Boolean)
        .join("")})`,
    comment: (text) => `# ${text}`,
    rowsExample: (key) => [
      `rows = data[${dq(key)}]`,
      "",
      'print(",".join(rows[0].keys()))',
      "for row in rows:",
      '    print(",".join(str(value) for value in row.values()))',
    ],
  },

  node: {
    prelude: ({ json }) =>
      json ? ["const data = JSON.parse(process.env.IDEA_NOTE_INPUT);"] : [],
    lit: (text) => `console.log(${dq(text)});`,
    env: (prefix, name, suffix) =>
      `console.log(${[
        prefix && `${dq(prefix)} + `,
        `process.env.${name}`,
        suffix && ` + ${dq(suffix)}`,
      ]
        .filter(Boolean)
        .join("")});`,
    comment: (text) => `// ${text}`,
    rowsExample: (key) => [
      `const rows = data.${key};`,
      "",
      'console.log(Object.keys(rows[0]).join(","));',
      'for (const row of rows) console.log(Object.values(row).join(","));',
    ],
  },

  ruby: {
    prelude: ({ json }) =>
      json ? ['require "json"', "", 'data = JSON.parse(ENV["IDEA_NOTE_INPUT"])'] : [],
    lit: (text) => `puts ${dq(text)}`,
    env: (prefix, name, suffix) =>
      `puts ${[prefix && `${dq(prefix)} + `, `ENV[${dq(name)}]`, suffix && ` + ${dq(suffix)}`]
        .filter(Boolean)
        .join("")}`,
    comment: (text) => `# ${text}`,
    rowsExample: (key) => [
      `rows = data[${dq(key)}]`,
      "",
      'puts rows[0].keys.join(",")',
      'rows.each { |row| puts row.values.join(",") }',
    ],
  },

  perl: {
    prelude: ({ json }) =>
      json
        ? ["use JSON::PP;", "", "my $data = decode_json($ENV{IDEA_NOTE_INPUT});"]
        : [],
    lit: (text) => `print ${dq(text)}, "\\n";`,
    env: (prefix, name, suffix) =>
      `print ${[prefix && `${dq(prefix)}, `, `$ENV{${name}}`, suffix && `, ${dq(suffix)}`]
        .filter(Boolean)
        .join("")}, "\\n";`,
    comment: (text) => `# ${text}`,
  },

  bash: {
    prelude: ({ json }) =>
      json
        ? ["# JSON 数据在 $IDEA_NOTE_INPUT 里，可用 jq 解析：", '# echo "$IDEA_NOTE_INPUT" | jq -r ".rows[0]"']
        : [],
    lit: (text) => `echo ${dq(text)}`,
    env: (prefix, name, suffix) => `echo "${prefix}\${${name}}${suffix}"`,
    comment: (text) => `# ${text}`,
  },

  powershell: {
    prelude: ({ json }) =>
      json ? ["$data = $env:IDEA_NOTE_INPUT | ConvertFrom-Json"] : [],
    lit: (text) => `Write-Output ${psq(text)}`,
    env: (prefix, name, suffix) => `Write-Output "${prefix}$env:${name}${suffix}"`,
    comment: (text) => `# ${text}`,
  },
};

/** A runner the app doesn't ship a template for: leave a scaffold, not code
 *  that pretends to work. */
const fallbackEmit = (lang: string): Emit => ({
  prelude: () => [`# ${lang}：把结果打印到标准输出即可`],
  lit: (text) => `# 输出：${text}`,
  env: (prefix, name, suffix) => `# 输出：${prefix}<${name}>${suffix}`,
  comment: (text) => `# ${text}`,
});

const emitterFor = (lang: string): Emit => EMITTERS[lang] ?? fallbackEmit(lang);

/* -------------------------------- output -------------------------------- */

/** The lines that print a sample of `kind`. */
function outputLines(emit: Emit, kind: OutKind, hasParams: boolean): string[] {
  switch (kind) {
    case "table":
      return [
        emit.lit("项目,数值"),
        hasParams ? emit.env("金额,", "amount", "") : emit.lit("金额,500000"),
        emit.lit("比例,3.85"),
      ];
    case "json":
      return [emit.lit('{"ok": true, "amount": 500000}')];
    case "mermaid":
      return [emit.lit("graph TD"), emit.lit("  A[输入] --> B[计算] --> C[结果]")];
    case "html":
      return [
        emit.lit(
          '<div style="padding:6px 10px;border-radius:6px;background:#eef2ff">这是一个 HTML 组件</div>',
        ),
      ];
    case "image":
      return [emit.lit("::image ./chart.png")];
    case "markdown":
      return [
        emit.lit("**计算结果**"),
        emit.lit(""),
        hasParams ? emit.env("- 金额：", "amount", " 元") : emit.lit("- 金额：500000 元"),
      ];
    default:
      return [
        hasParams ? emit.env("金额 = ", "amount", " 元") : emit.lit("Hello, 组件！"),
      ];
  }
}

/* ------------------------------- assembly ------------------------------- */

/** The fence's info string, e.g. `python {in=params, out=table, watch}`. */
function fenceInfo(o: ComponentOptions): string {
  const attrs: string[] = [];
  if (o.source === "input") attrs.push(`in=${o.name}`);
  else if (o.source === "table") attrs.push(`in=table:${o.name}`);
  else if (o.source === "file") attrs.push(`in=file:${o.name}`);
  if (o.out !== "text") attrs.push(`out=${o.out}`);
  else attrs.push("inline");
  const triggers = o.triggers ?? (o.trigger ? [o.trigger] : []);
  // `watch` needs controls to watch; `open` stands on its own. Repeating
  // `run=` keeps the generated Markdown readable when both are selected.
  if (triggers.includes("watch") && o.source === "input") attrs.push("run=watch");
  if (triggers.includes("open")) attrs.push("run=open");
  if (o.placement === "below") attrs.push("result=below");
  return attrs.length ? `${o.lang} {${attrs.join(", ")}}` : o.lang;
}

function bodyLines(o: ComponentOptions): string[] {
  const emit = emitterFor(o.lang);
  const bound = o.source === "table" || o.source === "file";
  const lines = [
    ...emit.prelude({ env: o.source === "input", json: bound }),
  ];

  // Bound data + a table: echo the rows straight back out. That is both the
  // most common thing to want and the shortest honest example.
  if (bound && o.out === "table" && emit.rowsExample) {
    const key = o.source === "table" ? "rows" : "data";
    if (lines.length) lines.push("");
    lines.push(...emit.rowsExample(key));
    return lines;
  }

  if (bound) lines.push(emit.comment("绑定的数据已经解析好了，下面先打印一份示例输出"));
  if (lines.length) lines.push("");
  lines.push(...outputLines(emit, o.out, o.source === "input"));
  return lines;
}

/**
 * The markdown to insert: the data the block reads (an ```input block, or a
 * sample table) followed by the code block itself. A `file` source is the one
 * case with nothing to insert — the dialog says the file has to exist, since
 * writing one behind the user's back is not the dialog's business.
 */
export function buildComponentSnippet(o: ComponentOptions): string {
  const blocks: string[] = [];
  if (o.source === "input")
    blocks.push(
      ["```input {id=" + o.name + "}", ...SAMPLE_FIELDS, "```"].join("\n"),
    );
  else if (o.source === "table") blocks.push(sampleTable(o.name));
  blocks.push(
    ["```" + fenceInfo(o), ...bodyLines(o), "```"].join("\n"),
  );
  return blocks.join("\n\n");
}
