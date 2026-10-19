<!-- Generated from src/lib/ai/componentGuide.ts. Update with node scripts/export-idea-note-skill.mjs. -->

# `input` 参数块

```input {id=params}
principal: number = 500000 {slider: 100000..3000000, step: 50000, label: 贷款总额, unit: 元}
years:     select = [10, 20, 30] {default: 30, label: 年限, unit: 年}
title:     text   = "月度报告" {label: 标题}
enabled:   bool   = true {label: 启用}
source:    file   = "./sales.csv" {as: csv, label: 数据文件}
start:     date   = "2026-01-01" {max: 2026-12-31, label: 起始日期}
```

- 一行一个字段：`名字: 类型 = 默认值 {选项}`。**一行写错只跳过这一行**，其余照常渲染。
- `id` 必须是标识符（`[A-Za-z_][A-Za-z0-9_-]*`），可运行块用 `in=<id>` 引用它。
- 字段名必须是 `[A-Za-z_][A-Za-z0-9_]*`（会变成环境变量名），不能重复。
- 类型可省略，按默认值猜：`[a, b]`→select，`true/false`→bool，数字→number，其余→text
  （file 和日期时间三种猜不出来，必须显式写）。正式笔记里建议写全。
- 只支持整行注释，别在字段行尾追加 `# 说明`。

## 八种类型

| 类型 | 控件 | 例子 |
| --- | --- | --- |
| `number` | 数字框（配 `slider` 再加滑块） | `amount: number = 100 {min: 0, max: 1000, step: 10}` |
| `text` | 单行文本框（没有多行文本域） | `title: text = "报告"` |
| `bool` | 复选框 | `enabled: bool = true` |
| `select` | 下拉框 | `years: select = [10, 20, 30] {default: 30}` |
| `file` | 路径输入框 | `data: file = "./data.csv" {as: csv}` |
| `date` | 日期选择器 | `start: date = "2026-01-01"` |
| `time` | 时间选择器 | `alarm: time = "09:30"` |
| `datetime` | 日期 + 时间选择器 | `deadline: datetime = "2026-01-31T18:00"` |

日期时间这三种的值就是字符串，格式固定：`date` 是 `YYYY-MM-DD`，`time` 是 `HH:MM`
（可带 `:SS`），`datetime` 是 `YYYY-MM-DDTHH:MM`（笔记里写成空格分隔也认，进脚本前
统一成 `T`）。默认值不合法（`2026-13-01`、`2026-02-30`）整行报错；不写默认值就是一个
空选择器，用户也可以把它清空，两种情况脚本都会收到空字符串，记得处理。
这三种**不参与类型推断**，必须显式写 `: date` / `: time` / `: datetime`。

## 选项

| 选项 | 适用 | 取值 | 说明 |
| --- | --- | --- | --- |
| `label` | 全部 | 文本 | 控件左侧显示名，默认取字段名 |
| `default` | 全部 | 字面量 | 覆盖初始值；`select` 用它指定默认项 |
| `min` `max` | number 与日期时间三种 | 数字，或同类型的日期字面量 | 可选范围的两端 |
| `step` | number 与日期时间三种 | 数字 | 步进（date 按天，time/datetime 按秒） |
| `slider` | number | `true` 或 `0..100` | 加滑块；范围写法同时设 min/max |
| `unit` | 全部 | 文本 | 控件右侧单位后缀 |
| `as` | file | `csv` / `json` / `text` | 文件内容按什么解析，默认 text |

- 选项名不区分大小写，认不出来的选项被忽略，同名后者覆盖前者。
- `select` 的选项列表不能为空，选项里不能含英文逗号，也不支持嵌套数组。
- `text` 的值没有通用转义，不适合放含逗号的复杂文本。
- `file` 路径相对**当前笔记所在目录**解析，必须落在工作区内，自动读取上限 2 MB。

## 值存在哪

用户改动的值按「文件路径 + 参数块 id」存在内存里，不写回 Markdown，不产生撤销记录。
参数卡片上有「重置」（回到文档里的默认值）和「固化为默认值」（把当前值写回 Markdown）。
所以给参数写**合理的默认值**很重要：笔记里读到的永远是默认值那一版。
