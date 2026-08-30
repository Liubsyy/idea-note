// The interactive-component authoring guide the AI assistant reads before it
// writes one.
//
// The full spec (doc/可交互组件规范.md) is far too long to sit in every system
// prompt, and most of it is only needed once the model has decided what kind of
// component it is building. So the prompt carries a short pointer, and this
// module carries the real thing, split into topics the `component_guide` tool
// hands over on demand.
//
// Everything here has to stay true to the code that actually runs a block:
// fenceAttrs.ts (attributes), inputs/schema.ts (the ```input DSL),
// inputs/collect.ts (how values reach the script) and resultProtocol.ts (what
// stdout must look like). When one of those changes, this text changes with it.

import { useAppStore } from "../../store/useAppStore";

export type GuideTopic =
  | "overview"
  | "input"
  | "data"
  | "output"
  | "run"
  | "examples";

export const GUIDE_TOPICS: GuideTopic[] = [
  "overview",
  "input",
  "data",
  "output",
  "run",
  "examples",
];

export const isGuideTopic = (value: string): value is GuideTopic =>
  (GUIDE_TOPICS as string[]).includes(value);

/* ------------------------------- sections -------------------------------- */

const OVERVIEW = `# 可交互组件速览

可交互组件 = 一个 \`input\` 参数块（可选）+ 一个可运行代码块。读者在笔记里拖滑块、
改数字、选下拉框，脚本就在本机重跑一遍，结果直接渲染回笔记里。

## 最小完整例子

\`\`\`input {id=price_calc}
quantity: number = 2    {min: 1, step: 1, label: 数量, unit: 件}
price:    number = 9.90 {min: 0, step: 0.01, label: 单价, unit: 元}
\`\`\`

\`\`\`python {in=price_calc, out=markdown, run=watch}
import json, os

quantity = int(float(os.environ["quantity"]))
price = float(os.environ["price"])
print(json.dumps(f"**合计：{quantity * price:.2f} 元**", ensure_ascii=False))
\`\`\`

## 两条铁律

1. **输入靠环境变量**：\`IDEA_NOTE_INPUT\`（一整份 JSON，保留类型）+ 每个字段一个
   同名环境变量（字符串）。脚本用 \`os.environ\` / \`process.env\` 读。
2. **输出必须是 stdout 最后一个非空行的单行合法 JSON**。字符串也要 JSON 编码：
   写 \`print(json.dumps("hello"))\`，不能写 \`print("hello")\`。前面的日志行随便打。

## 代码块信息行上的属性

| 属性 | 写在哪 | 取值 | 默认 | 作用 |
| --- | --- | --- | --- | --- |
| \`id\` | \`input\` 块 | 标识符（字母/下划线开头） | 无 | 给参数块起名，供 \`in=\` 引用 |
| \`in\` | 可运行块 | \`<id>\` / \`table:<名称>\` / \`file:<路径>\` | 无 | 数据从哪来 |
| \`out\` | 可运行块 | \`text\` \`table\` \`json\` \`mermaid\` \`html\` \`image\` \`markdown\` \`auto\` | 未声明 | 结果类型与渲染方式 |
| \`run\` | 可运行块 | \`manual\` \`watch\` \`open\`（可用 \`+\` 组合） | \`manual\` | 什么时候自动运行 |
| \`result\` | 可运行块 | \`above\` / \`below\` | \`above\` | 结果显示在代码块上方还是下方 |

书写顺序建议统一为：\`语言 {in=..., out=..., run=..., result=...}\`。

## 写组件的推荐流程

1. 想清楚**用户要调什么**（参数）、**要看到什么**（输出类型）。
2. 参数超过一个、或希望改完自动重算，就写 \`input\` 块并用 \`in=\` + \`run=watch\`；
   只是"点一下出结果"就只写可运行块。
3. 选 \`out=\`：文字结论用 \`markdown\`，数据用 \`table\`，流程/结构用 \`mermaid\`，
   画图用 \`image\`（脚本先把图片存到笔记目录再返回路径）。
4. 语言默认选 Python；确认本机可用的运行器（见下）。
5. 写完检查三件事：最后一行是单行 JSON、\`in=\` 的 id 和 \`input\` 块的 \`id\` 一致、
   \`table\` 的每行长度等于 \`columns\` 长度。

## 三条边界（写进笔记前要知道）

- 代码是在用户本机**真实执行**的，不是浏览器沙箱；不要写删除文件、联网上传、
  \`sudo\` 这类脚本，也不要依赖用户没提到的第三方库（用不到就别 import）。
- 参数值和运行结果只活在内存里，不会自动写回 \`.md\`，不产生 Git 差异。
- \`out=html\` 只渲染消毒后的静态 HTML：\`<script>\` 和内联事件会被删掉。交互只能
  通过 \`input\` 控件 + \`run=watch\` 实现，不能靠页面脚本。

需要细节时按主题再查：\`input\`（参数块语法）、\`data\`（表格/文件绑定与环境变量）、
\`output\`（七种输出格式）、\`run\`（触发方式与执行环境）、\`examples\`（完整示例）。`;

const INPUT = `# \`input\` 参数块

\`\`\`input {id=params}
principal: number = 500000 {slider: 100000..3000000, step: 50000, label: 贷款总额, unit: 元}
years:     select = [10, 20, 30] {default: 30, label: 年限, unit: 年}
title:     text   = "月度报告" {label: 标题}
enabled:   bool   = true {label: 启用}
source:    file   = "./sales.csv" {as: csv, label: 数据文件}
start:     date   = "2026-01-01" {max: 2026-12-31, label: 起始日期}
\`\`\`

- 一行一个字段：\`名字: 类型 = 默认值 {选项}\`。**一行写错只跳过这一行**，其余照常渲染。
- \`id\` 必须是标识符（\`[A-Za-z_][A-Za-z0-9_-]*\`），可运行块用 \`in=<id>\` 引用它。
- 字段名必须是 \`[A-Za-z_][A-Za-z0-9_]*\`（会变成环境变量名），不能重复。
- 类型可省略，按默认值猜：\`[a, b]\`→select，\`true/false\`→bool，数字→number，其余→text
  （file 和日期时间三种猜不出来，必须显式写）。正式笔记里建议写全。
- 只支持整行注释，别在字段行尾追加 \`# 说明\`。

## 八种类型

| 类型 | 控件 | 例子 |
| --- | --- | --- |
| \`number\` | 数字框（配 \`slider\` 再加滑块） | \`amount: number = 100 {min: 0, max: 1000, step: 10}\` |
| \`text\` | 单行文本框（没有多行文本域） | \`title: text = "报告"\` |
| \`bool\` | 复选框 | \`enabled: bool = true\` |
| \`select\` | 下拉框 | \`years: select = [10, 20, 30] {default: 30}\` |
| \`file\` | 路径输入框 | \`data: file = "./data.csv" {as: csv}\` |
| \`date\` | 日期选择器 | \`start: date = "2026-01-01"\` |
| \`time\` | 时间选择器 | \`alarm: time = "09:30"\` |
| \`datetime\` | 日期 + 时间选择器 | \`deadline: datetime = "2026-01-31T18:00"\` |

日期时间这三种的值就是字符串，格式固定：\`date\` 是 \`YYYY-MM-DD\`，\`time\` 是 \`HH:MM\`
（可带 \`:SS\`），\`datetime\` 是 \`YYYY-MM-DDTHH:MM\`（笔记里写成空格分隔也认，进脚本前
统一成 \`T\`）。默认值不合法（\`2026-13-01\`、\`2026-02-30\`）整行报错；不写默认值就是一个
空选择器，用户也可以把它清空，两种情况脚本都会收到空字符串，记得处理。
这三种**不参与类型推断**，必须显式写 \`: date\` / \`: time\` / \`: datetime\`。

## 选项

| 选项 | 适用 | 取值 | 说明 |
| --- | --- | --- | --- |
| \`label\` | 全部 | 文本 | 控件左侧显示名，默认取字段名 |
| \`default\` | 全部 | 字面量 | 覆盖初始值；\`select\` 用它指定默认项 |
| \`min\` \`max\` | number 与日期时间三种 | 数字，或同类型的日期字面量 | 可选范围的两端 |
| \`step\` | number 与日期时间三种 | 数字 | 步进（date 按天，time/datetime 按秒） |
| \`slider\` | number | \`true\` 或 \`0..100\` | 加滑块；范围写法同时设 min/max |
| \`unit\` | 全部 | 文本 | 控件右侧单位后缀 |
| \`as\` | file | \`csv\` / \`json\` / \`text\` | 文件内容按什么解析，默认 text |

- 选项名不区分大小写，认不出来的选项被忽略，同名后者覆盖前者。
- \`select\` 的选项列表不能为空，选项里不能含英文逗号，也不支持嵌套数组。
- \`text\` 的值没有通用转义，不适合放含逗号的复杂文本。
- \`file\` 路径相对**当前笔记所在目录**解析，必须落在工作区内，自动读取上限 2 MB。

## 值存在哪

用户改动的值按「文件路径 + 参数块 id」存在内存里，不写回 Markdown，不产生撤销记录。
参数卡片上有「重置」（回到文档里的默认值）和「固化为默认值」（把当前值写回 Markdown）。
所以给参数写**合理的默认值**很重要：笔记里读到的永远是默认值那一版。`;

const DATA = `# 数据怎么进脚本

不论来源是什么，系统都同时准备两条通道：

1. \`IDEA_NOTE_INPUT\` 环境变量：一整份 JSON 字符串，**保留真实类型**，首选。
2. 一批独立环境变量：方便零依赖地读一个标量或路径（值都是字符串）。

一个代码块只有一个生效的 \`in=\`。

## 来源一：\`in=<input 块 id>\`

\`IDEA_NOTE_INPUT\` 就是字段名到值的映射，例如 \`{"amount": 100, "active": true}\`。

| 字段类型 | 独立环境变量 | \`IDEA_NOTE_INPUT\` 里 |
| --- | --- | --- |
| number | 十进制字符串 \`"100"\` | JSON number |
| text | 原文本 | JSON string |
| bool | \`"true"\` / \`"false"\` | JSON boolean |
| select | 所选值的字符串形式 | 选项原本的类型 |
| date / time / datetime | 原样字符串，如 \`"2026-01-31"\` | 同一份 JSON string |
| file | 解析后的绝对路径 | 该字段是绝对路径，另有 \`<字段名>_data\` 存内容 |

一个名为 \`source\` 的 file 字段会生出四个入口：环境变量 \`source\` 和 \`source_path\`
（都是绝对路径）、\`IDEA_NOTE_INPUT["source"]\`（路径）、\`IDEA_NOTE_INPUT["source_data"]\`
（按 \`as\` 解析后的内容）。因此字段名不要占用 \`IDEA_NOTE_INPUT\`、\`table_rows\`、
\`file_path\`、\`_truncated\`，也不要和已有文件字段的 \`_path\` / \`_data\` 撞名。

## 来源二：\`in=table:<名称>\`

名称是表格上方的 1～6 级标题，或一行只写名称的普通文本（中间可以有空行，但不能夹别的内容）。

\`\`\`text
IDEA_NOTE_INPUT = {
  "columns": ["月份", "金额"],
  "rows":  [{"月份": "1月", "金额": "1200"}, ...],
  "table": [ ...与 rows 相同... ]
}
额外环境变量：table_rows=<数据行数>
\`\`\`

- **所有单元格都是字符串**，要算数自己转（\`float(row["金额"])\`）。
- 表格每行首尾都要有 \`|\`，第二行必须是合法分隔行（\`| --- | ---: |\`）。
- 同名标题出现多次时取第一个匹配到的表格。
- \`run=watch\` **不监听表格改动**，表格改了要手动点运行。

## 来源三：\`in=file:<路径>\`

\`\`\`text
IDEA_NOTE_INPUT = {"path": "<绝对路径>", "data": <按扩展名解析后的值>}
额外环境变量：file_path=<绝对路径>
\`\`\`

扩展名决定格式：\`.csv\`→csv，\`.json\`→json，其余→text。这种写法没地方写 \`as\`。

## 三种解析格式

- \`text\`：\`data\` 是完整文本字符串。
- \`json\`：\`data\` 是 \`JSON.parse\` 后的值；语法错误直接阻止运行。
- \`csv\`：首行当表头，之后每行一个对象；**所有值保持字符串**；支持双引号包裹、
  引号内逗号与换行、\`""\` 转义、LF/CRLF/CR。

## 数据太大会被裁剪

\`IDEA_NOTE_INPUT\` 超过 32 KiB 时换成精简对象：只保留标量字段，加上 \`"_truncated": true\`，
数组和对象被删掉。处理大文件的脚本应当先探一手，再照 \`*_path\` / \`file_path\` 自己读文件：

\`\`\`python
payload = json.loads(os.environ["IDEA_NOTE_INPUT"])
if payload.get("_truncated"):
    with open(os.environ["source_path"], encoding="utf-8") as f:
        ...
\`\`\``;

const OUTPUT = `# 输出：把结果送回笔记

只有退出码为 0 时才解析结果，且只看 stdout（stderr 只显示在运行面板里）。

## 方式一（推荐）：写了 \`out=<类型>\`

stdout 前面可以随便打日志，**最后一个非空行**必须是完整、合法、**单行**的 JSON 值，
它就是该类型的 data，不用再包一层。

两个最常见的错误：多行 JSON（缩进过的 \`json.dumps(..., indent=2)\`），
以及字符串没做 JSON 编码（\`print("hello")\` 而不是 \`print(json.dumps("hello"))\`）。
记住一句话：**最后一行必须能被 \`JSON.parse\` 直接吃下去。**

## 方式二：\`out=auto\` 或不写 \`out=\`

渲染类型要运行时才知道时，在任意独立的 stdout 行输出包装对象：

\`\`\`json
{"idea_note_result":{"type":"table","data":{"columns":["项目"],"rows":[["值"]]}}}
\`\`\`

最后一个形态正确的包装对象生效。区别：\`out=auto\` 在笔记里有结果卡片位置（没输出
包装对象算错误），不写 \`out=\` 则运行时弹出运行面板、没有包装对象也不算错——
**临时跑一段脚本看输出就不写 \`out=\`，做组件就写具体类型或 \`auto\`。**

## 七种输出格式

| \`out\` | data 形态 | 渲染成 |
| --- | --- | --- |
| \`text\` | string | 等宽纯文本（不解析 HTML） |
| \`table\` | \`{columns: string[], rows: JsonValue[][]}\` | 表头可点击排序的表格 |
| \`json\` | 任意合法 JSON | 两空格缩进的 JSON |
| \`mermaid\` | string | Mermaid 图表（返回**源码**，不是 SVG） |
| \`html\` | string | 消毒后的静态 HTML |
| \`image\` | 非空路径字符串或路径数组 | 一张或多张图片 |
| \`markdown\` | string | 渲染后的 Markdown |

要点：

- \`table\`：\`columns\` 必须全是字符串；\`rows\` 是**数组的数组**，每行长度和 columns
  完全一致；**不支持把行写成对象**。单元格必须是合法 JSON 值。
- \`json\` 的 data 不能含 \`NaN\` / \`Infinity\` / \`undefined\` / 日期对象，脚本先自己转。
- \`html\`：\`<script>\`、内联事件处理器会被 DOMPurify 删掉，不能依赖页面脚本；
  想要交互就把交互放进 \`input\` 块，用 \`run=watch\` 重新生成 HTML。
- \`image\`：路径相对当前笔记目录解析，也支持绝对路径和 \`http(s):\` / \`data:\`；
  协议只校验形态、不保证文件存在，所以脚本要先真的把图片写到磁盘再返回路径。
- \`markdown\`：结果里的可运行代码块不会再执行，只是渲染内容。

## 结果显示在哪

- \`result=above\`（默认）把结果放在代码块上方，代码退居其后；想按"代码→结果"阅读就写 \`result=below\`。
- 写了 \`out=\`（含 \`auto\`）的块在运行前就显示"尚未运行"占位卡片，且不弹运行面板。
- \`watch\` 重算期间保留上一次结果，成功并通过校验后才替换。
- 行内结果只在内存里，关闭文件就清掉，不会写进笔记。`;

const RUN = `# 运行：用什么跑、什么时候跑

## 语言

内置运行器：\`python\`（别名 py、python3）、\`node\`（js、javascript、mjs）、
\`ruby\`（rb）、\`perl\`（pl）、\`bash\`（sh、shell、zsh）、\`powershell\`（ps1、pwsh）、
以及 Windows 上的 \`bat\`（cmd、batch）。
\`mermaid\`、\`input\`、\`output\` 是保留标识，不能当可运行语言。
运行器可以在设置里禁用或改命令，**能不能跑最终取决于用户设备上装没装解释器**。

## 执行环境

- 在用户本机真实执行；工作目录是笔记所在目录（未保存的草稿用工作区目录）。
- 一条解释器命令 + 一个临时代码文件：**没有 stdin，没有 TTY**。需要交互输入、
  常驻服务、\`sudo\`、或"先编译再运行"的场景请改用「在终端运行」。
- 默认超时 30 秒，默认最大输出 200 KiB；**输出被截断后结构化结果就不再解析**。
- 标准库优先。要用第三方库（如 matplotlib）时先在正文里说明需要 \`pip install\`。

## \`run\`：什么时候自动运行

| 值 | 行为 |
| --- | --- |
| \`manual\` | 只有点运行按钮才跑（默认） |
| \`watch\` | 绑定的 \`input\` 参数一变就自动跑（300 ms 防抖） |
| \`open\` | 每次打开这篇笔记时自动跑一次 |

- 组合写法：\`run=watch+open\`、\`run=watch|open\`、\`run=watch open\`，或重复写 \`run=watch, run=open\`。
- **\`run=watch\` 只对 \`in=<input 块 id>\` 生效**，不监听表格和文件内容变化。
- \`run=manual\` 会清掉它左边已解析到的自动触发器，别混写顺序冲突的属性。
- 只读模式下不执行任何自动运行。
- 开启「运行前二次确认」时，自动运行在每个应用会话首次触发时问一次。

## 重跑与结果身份

运行记录按「文件路径 + 代码内容哈希」关联。因此：

- 改了代码内容，旧结果就不再属于新代码。
- **两段源码完全相同的代码块共享同一个结果**。一篇笔记里要放两个同源码的独立组件时，
  给它们加不同的注释把源码区分开。

## 安全

代码有用户账号的全部权限。写组件时只做计算和渲染：不要写删除/覆盖用户文件、
上传数据、访问网络凭证之类的脚本；需要读文件就通过 \`in=file:\` 或 \`file\` 字段，
把路径交给用户决定。`;

const EXAMPLES = `# 完整示例

## 1. 参数 + Markdown 结论（最常用）

\`\`\`input {id=loan}
principal: number = 500000 {slider: 100000..3000000, step: 50000, label: 贷款总额, unit: 元}
rate:      number = 3.85   {slider: 1..8, step: 0.05, label: 年利率, unit: %}
years:     select = [10, 20, 25, 30] {default: 30, label: 贷款年限, unit: 年}
\`\`\`

\`\`\`python {in=loan, out=markdown, run=watch}
import json, os

principal = float(os.environ["principal"])
monthly_rate = float(os.environ["rate"]) / 100 / 12
months = int(os.environ["years"]) * 12
growth = (1 + monthly_rate) ** months
monthly = principal * monthly_rate * growth / (growth - 1)
total = monthly * months

result = (
    f"**月供 {monthly:,.2f} 元**\\n\\n"
    f"- 利息合计：{total - principal:,.2f} 元\\n"
    f"- 本息合计：{total:,.2f} 元"
)
print(json.dumps(result, ensure_ascii=False))
\`\`\`

## 2. 无参数、打开笔记就刷新的表格

\`\`\`python {run=open, out=table}
import datetime, json, shutil

total, used, free = shutil.disk_usage(".")
gb = 1024 ** 3
result = {
    "columns": ["项目", "数值"],
    "rows": [
        ["刷新时间", f"{datetime.datetime.now():%H:%M:%S}"],
        ["磁盘已用", f"{used / gb:.1f} GB"],
        ["使用率", f"{used / total * 100:.1f}%"],
    ],
}
print(json.dumps(result, ensure_ascii=False))
\`\`\`

## 3. 把笔记里的表格变成 Mermaid 甘特图

\`\`\`python {in=table:项目排期, out=mermaid, result=below}
import json, os

rows = json.loads(os.environ["IDEA_NOTE_INPUT"])["rows"]
lines = ["gantt", "    dateFormat YYYY-MM-DD", "    title 项目排期"]
for row in rows:
    lines.append(f"    {row['任务']} :{row['开始']}, {row['结束']}")
print(json.dumps("\\n".join(lines), ensure_ascii=False))
\`\`\`

## 4. 画图并返回图片路径（需要 matplotlib）

\`\`\`input {id=plot}
freq: number = 2 {slider: 1..10, step: 1, label: 频率}
\`\`\`

\`\`\`python {in=plot, out=image, run=watch}
import json, math, os
import matplotlib
matplotlib.use("Agg")
import matplotlib.pyplot as plt

freq = float(os.environ["freq"])
xs = [i / 100 for i in range(0, 628)]
plt.figure(figsize=(6, 3))
plt.plot(xs, [math.sin(freq * x) for x in xs])
path = os.path.join(os.getcwd(), "plot.png")   # 工作目录 = 笔记所在目录
plt.savefig(path, dpi=120, bbox_inches="tight")
plt.close()
print(json.dumps("./plot.png", ensure_ascii=False))
\`\`\`

## 5. Node + 运行时决定渲染方式

\`\`\`input {id=view}
mode: select = [表格, 文字] {default: 表格, label: 展示方式}
\`\`\`

\`\`\`javascript {in=view, out=auto, run=watch}
const data = JSON.parse(process.env.IDEA_NOTE_INPUT);
const result =
  data.mode === "表格"
    ? { type: "table", data: { columns: ["项目", "值"], rows: [["状态", "正常"]] } }
    : { type: "markdown", data: "**状态：正常**" };
console.log(JSON.stringify({ idea_note_result: result }));
\`\`\`

## 6. 日期区间统计（date / time）

\`\`\`input {id=span}
start:   date = "2026-01-01" {label: 开始日期}
end:     date = "2026-03-31" {min: 2026-01-01, label: 结束日期}
per_day: time = "07:30" {label: 每天投入, step: 1800}
\`\`\`

\`\`\`python {in=span, out=markdown, run=watch}
import datetime, json, os

data = json.loads(os.environ["IDEA_NOTE_INPUT"])
if not data["start"] or not data["end"]:
    print(json.dumps("请先选好起止日期。", ensure_ascii=False))
    raise SystemExit

start = datetime.date.fromisoformat(data["start"])
end = datetime.date.fromisoformat(data["end"])
days = (end - start).days + 1
h, m = (int(x) for x in data["per_day"].split(":")[:2])
hours = days * (h + m / 60)

print(json.dumps(
    f"**共 {days} 天，合计投入 {hours:.1f} 小时**\\n\\n"
    f"- 工作日：{sum(1 for i in range(days) if (start + datetime.timedelta(i)).weekday() < 5)} 天",
    ensure_ascii=False,
))
\`\`\``;

const SECTIONS: Record<GuideTopic, string> = {
  overview: OVERVIEW,
  input: INPUT,
  data: DATA,
  output: OUTPUT,
  run: RUN,
  examples: EXAMPLES,
};

/* ------------------------- this machine's runners ------------------------- */

/** What the note can actually execute right now — the guide is useless if it
 *  talks the model into a language this device has switched off. */
export function runnerAvailability(): string {
  const config = useAppStore.getState().codeRunConfig;
  if (!config.enabled)
    return "本机状态：代码块执行总开关已关闭，组件写出来也点不了运行——请提醒用户在设置里打开「执行代码块」。";
  const enabled = config.runners.filter((r) => r.enabled);
  if (!enabled.length)
    return "本机状态：所有运行器都被禁用了，请提醒用户在设置里启用需要的语言。";
  const names = enabled
    .map((r) => (r.aliases.length ? `${r.lang}（别名 ${r.aliases.join("、")}）` : r.lang))
    .join("、");
  return [
    `本机已启用的运行器：${names}。围栏语言只能用这些标识（或其别名）。`,
    "注意：启用不代表机器上一定装了对应解释器，用户点运行报「找不到命令」时提示他安装或在设置里改命令。",
    config.confirmEveryRun
      ? "用户开启了「运行前二次确认」，自动运行（watch / open）首次触发时会先弹确认。"
      : "用户关闭了「运行前二次确认」，运行按钮和自动触发会直接执行。",
  ].join("\n");
}

/** The guide text for one topic, with the machine's runner state appended. */
export function componentGuide(topic: GuideTopic = "overview"): string {
  return `${SECTIONS[topic]}\n\n---\n\n${runnerAvailability()}`;
}
