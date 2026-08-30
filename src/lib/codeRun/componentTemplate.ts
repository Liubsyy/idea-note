// The ready-to-run example inserted by the 可交互组件 dialog.
//
// Every generated block declares `out=` and prints exactly one JSON value on
// its final stdout line. Earlier output remains available for ordinary logs,
// but only that final value is consumed by the component protocol.

import type { OutKind, ResultPlacement, RunTrigger } from "./fenceAttrs";

export type ComponentSource = "none" | "input" | "table" | "file";

export interface ComponentOptions {
  lang: string;
  source: ComponentSource;
  name: string;
  out: OutKind;
  triggers?: RunTrigger[];
  trigger?: RunTrigger;
  placement: ResultPlacement;
}

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

const SAMPLE_FIELDS = [
  "amount: number = 500000 {slider: 0..2000000, step: 10000, label: 金额, unit: 元}",
  "rate:   number = 3.85 {step: 0.05, label: 比例, unit: %}",
  "title:  text = \"示例\"",
];

interface Emit {
  prelude: (needs: { env: boolean; bound: boolean }) => string[];
  /** Print already-serialized, literal JSON text. */
  literalJson: (json: string) => string;
  /** Print a computed string as a JSON string value. */
  envString: (prefix: string, name: string, suffix: string) => string;
  table: (hasParams: boolean) => string[];
  comment: (text: string) => string;
  rowsExample?: (key: string) => string[];
}

const dq = (text: string) => JSON.stringify(text);
const psq = (text: string) => `'${text.replace(/'/g, "''")}'`;
const shq = (text: string) => `'${text.replace(/'/g, `'"'"'`)}'`;
const jsonStringFragment = (text: string) => JSON.stringify(text).slice(1, -1);

const EMITTERS: Record<string, Emit> = {
  python: {
    prelude: ({ env, bound }) => [
      env || bound ? "import json, os" : "import json",
      ...(bound
        ? ["", 'data = json.loads(os.environ["IDEA_NOTE_INPUT"])']
        : []),
    ],
    literalJson: (json) => `print(${dq(json)})`,
    envString: (prefix, name, suffix) =>
      `print(json.dumps(${dq(prefix)} + os.environ[${dq(name)}] + ${dq(suffix)}, ensure_ascii=False))`,
    table: (hasParams) => [
      `result = {"columns": ["项目", "数值"], "rows": [["金额", ${hasParams ? 'float(os.environ["amount"])' : "500000"}], ["比例", 3.85]]}`,
      "print(json.dumps(result, ensure_ascii=False))",
    ],
    comment: (text) => `# ${text}`,
    rowsExample: (key) => [
      `rows = data[${dq(key)}]`,
      "columns = list(rows[0].keys()) if rows else []",
      'result = {"columns": columns, "rows": [[row.get(column) for column in columns] for row in rows]}',
      "print(json.dumps(result, ensure_ascii=False))",
    ],
  },

  node: {
    prelude: ({ bound }) =>
      bound ? ["const data = JSON.parse(process.env.IDEA_NOTE_INPUT);"] : [],
    literalJson: (json) => `console.log(${dq(json)});`,
    envString: (prefix, name, suffix) =>
      `console.log(JSON.stringify(${dq(prefix)} + process.env.${name} + ${dq(suffix)}));`,
    table: (hasParams) => [
      `const result = { columns: ["项目", "数值"], rows: [["金额", ${hasParams ? "Number(process.env.amount)" : "500000"}], ["比例", 3.85]] };`,
      "console.log(JSON.stringify(result));",
    ],
    comment: (text) => `// ${text}`,
    rowsExample: (key) => [
      `const rows = data.${key};`,
      "const columns = rows.length ? Object.keys(rows[0]) : [];",
      "const result = { columns, rows: rows.map((row) => columns.map((column) => row[column])) };",
      "console.log(JSON.stringify(result));",
    ],
  },

  ruby: {
    prelude: ({ bound }) => [
      "# encoding: UTF-8",
      'require "json"',
      ...(bound ? ["", 'data = JSON.parse(ENV["IDEA_NOTE_INPUT"])'] : []),
    ],
    literalJson: (json) => `puts ${dq(json)}`,
    envString: (prefix, name, suffix) =>
      `puts JSON.generate(${dq(prefix)} + ENV[${dq(name)}] + ${dq(suffix)})`,
    table: (hasParams) => [
      `result = { "columns" => ["项目", "数值"], "rows" => [["金额", ${hasParams ? 'Float(ENV["amount"])' : "500000"}], ["比例", 3.85]] }`,
      "puts JSON.generate(result)",
    ],
    comment: (text) => `# ${text}`,
    rowsExample: (key) => [
      `rows = data[${dq(key)}]`,
      "columns = rows.empty? ? [] : rows[0].keys",
      'result = { "columns" => columns, "rows" => rows.map { |row| columns.map { |column| row[column] } } }',
      "puts JSON.generate(result)",
    ],
  },

  perl: {
    prelude: ({ bound }) => [
      "use utf8;",
      "use JSON::PP;",
      'binmode STDOUT, ":encoding(UTF-8)";',
      "my $json = JSON::PP->new->utf8(0);",
      ...(bound
        ? ["", "my $data = decode_json($ENV{IDEA_NOTE_INPUT});"]
        : []),
    ],
    literalJson: (json) => `print ${dq(json)}, "\\n";`,
    envString: (prefix, name, suffix) =>
      `print $json->encode(${dq(prefix)} . $ENV{${name}} . ${dq(suffix)}), "\\n";`,
    table: (hasParams) => [
      `my $result = { columns => ["项目", "数值"], rows => [["金额", ${hasParams ? "0 + $ENV{amount}" : "500000"}], ["比例", 3.85]] };`,
      'print $json->encode($result), "\\n";',
    ],
    comment: (text) => `# ${text}`,
    rowsExample: (key) => [
      `my $rows = $data->{${key}};`,
      "my @columns = @$rows ? sort keys %{$rows->[0]} : ();",
      "my @values = map { my $row = $_; [map { $row->{$_} } @columns] } @$rows;",
      'print $json->encode({ columns => \\@columns, rows => \\@values }), "\\n";',
    ],
  },

  bash: {
    prelude: ({ bound }) =>
      bound
        ? [
            "# 绑定数据位于 $IDEA_NOTE_INPUT；复杂处理可使用 jq。",
            '# echo "$IDEA_NOTE_INPUT" | jq "."',
          ]
        : [],
    literalJson: (json) => `printf '%s\\n' ${shq(json)}`,
    envString: (prefix, name, suffix) =>
      `printf '"%s%s%s"\\n' ${shq(jsonStringFragment(prefix))} "$${name}" ${shq(jsonStringFragment(suffix))}`,
    table: (hasParams) => [
      hasParams
        ? `printf '{"columns":["项目","数值"],"rows":[["金额",%s],["比例",3.85]]}\\n' "$amount"`
        : `printf '%s\\n' '{"columns":["项目","数值"],"rows":[["金额",500000],["比例",3.85]]}'`,
    ],
    comment: (text) => `# ${text}`,
  },

  powershell: {
    prelude: ({ bound }) =>
      bound ? ["$data = $env:IDEA_NOTE_INPUT | ConvertFrom-Json"] : [],
    literalJson: (json) => `Write-Output ${psq(json)}`,
    envString: (prefix, name, suffix) =>
      `Write-Output ("${prefix}$env:${name}${suffix}" | ConvertTo-Json -Compress)`,
    table: (hasParams) => [
      `$rows = ,@("金额", ${hasParams ? '[double]$env:amount' : "500000"}) + ,@("比例", 3.85)`,
      '$result = @{ columns = @("项目", "数值"); rows = $rows }',
      "Write-Output ($result | ConvertTo-Json -Compress -Depth 10)",
    ],
    comment: (text) => `# ${text}`,
  },
};

const fallbackEmit = (lang: string): Emit => ({
  prelude: () => [`# ${lang}：最后一行需要输出一个合法的单行 JSON 值`],
  literalJson: (json) => `# 输出：${json}`,
  envString: (prefix, name, suffix) =>
    `# 输出 JSON 字符串：${prefix}<${name}>${suffix}`,
  table: () => ['# 输出：{"columns":["列名"],"rows":[["值"]]}'],
  comment: (text) => `# ${text}`,
});

const emitterFor = (lang: string): Emit => EMITTERS[lang] ?? fallbackEmit(lang);

function outputLines(emit: Emit, kind: OutKind, hasParams: boolean): string[] {
  switch (kind) {
    case "table":
      return emit.table(hasParams);
    case "json":
      return [emit.literalJson('{"ok":true,"amount":500000}')];
    case "mermaid":
      return [
        emit.literalJson(
          JSON.stringify("graph TD\n  A[输入] --> B[计算] --> C[结果]"),
        ),
      ];
    case "html":
      return [
        emit.literalJson(
          JSON.stringify(
            '<div style="padding:6px 10px;border-radius:6px;background:#eef2ff">这是一个 HTML 组件</div>',
          ),
        ),
      ];
    case "image":
      return [emit.literalJson(JSON.stringify("./chart.png"))];
    case "markdown":
      return hasParams
        ? [emit.envString("**计算结果**\n\n- 金额：", "amount", " 元")]
        : [
            emit.literalJson(
              JSON.stringify("**计算结果**\n\n- 金额：500000 元"),
            ),
          ];
    default:
      return [
        hasParams
          ? emit.envString("金额 = ", "amount", " 元")
          : emit.literalJson(JSON.stringify("Hello, 组件！")),
      ];
  }
}

function fenceInfo(o: ComponentOptions): string {
  const attrs: string[] = [];
  if (o.source === "input") attrs.push(`in=${o.name}`);
  else if (o.source === "table") attrs.push(`in=table:${o.name}`);
  else if (o.source === "file") attrs.push(`in=file:${o.name}`);
  attrs.push(`out=${o.out}`);
  const triggers = o.triggers ?? (o.trigger ? [o.trigger] : []);
  // Several triggers combine into one `run=`, not one attribute each: the
  // parser accumulates repeated keys, but `run=watch+open` is the written form.
  const run: RunTrigger[] = [];
  if (triggers.includes("watch") && o.source === "input") run.push("watch");
  if (triggers.includes("open")) run.push("open");
  if (run.length) attrs.push(`run=${run.join("+")}`);
  if (o.placement === "below") attrs.push("result=below");
  return `${o.lang} {${attrs.join(", ")}}`;
}

function bodyLines(o: ComponentOptions): string[] {
  const emit = emitterFor(o.lang);
  const bound = o.source === "table" || o.source === "file";
  const lines = [...emit.prelude({ env: o.source === "input", bound })];

  if (bound && o.out === "table" && emit.rowsExample) {
    const key = o.source === "table" ? "rows" : "data";
    if (lines.length) lines.push("");
    lines.push(...emit.rowsExample(key));
    return lines;
  }

  if (bound)
    lines.push(emit.comment("绑定的数据已经解析好了，下面先返回一份示例结果"));
  if (lines.length) lines.push("");
  lines.push(...outputLines(emit, o.out, o.source === "input"));
  return lines;
}

export function buildComponentSnippet(o: ComponentOptions): string {
  const blocks: string[] = [];
  if (o.source === "input")
    blocks.push(
      ["```input {id=" + o.name + "}", ...SAMPLE_FIELDS, "```"].join("\n"),
    );
  else if (o.source === "table") blocks.push(sampleTable(o.name));
  blocks.push(["```" + fenceInfo(o), ...bodyLines(o), "```"].join("\n"));
  return blocks.join("\n\n");
}
