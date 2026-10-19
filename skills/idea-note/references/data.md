<!-- Generated from src/lib/ai/componentGuide.ts. Update with node scripts/export-idea-note-skill.mjs. -->

# 数据怎么进脚本

不论来源是什么，系统都同时准备两条通道：

1. `IDEA_NOTE_INPUT` 环境变量：一整份 JSON 字符串，**保留真实类型**，首选。
2. 一批独立环境变量：方便零依赖地读一个标量或路径（值都是字符串）。

一个代码块只有一个生效的 `in=`。

## 来源一：`in=<input 块 id>`

`IDEA_NOTE_INPUT` 就是字段名到值的映射，例如 `{"amount": 100, "active": true}`。

| 字段类型 | 独立环境变量 | `IDEA_NOTE_INPUT` 里 |
| --- | --- | --- |
| number | 十进制字符串 `"100"` | JSON number |
| text | 原文本 | JSON string |
| bool | `"true"` / `"false"` | JSON boolean |
| select | 所选值的字符串形式 | 选项原本的类型 |
| date / time / datetime | 原样字符串，如 `"2026-01-31"` | 同一份 JSON string |
| file | 解析后的绝对路径 | 该字段是绝对路径，另有 `<字段名>_data` 存内容 |

一个名为 `source` 的 file 字段会生出四个入口：环境变量 `source` 和 `source_path`
（都是绝对路径）、`IDEA_NOTE_INPUT["source"]`（路径）、`IDEA_NOTE_INPUT["source_data"]`
（按 `as` 解析后的内容）。因此字段名不要占用 `IDEA_NOTE_INPUT`、`table_rows`、
`file_path`、`_truncated`，也不要和已有文件字段的 `_path` / `_data` 撞名。

## 来源二：`in=table:<名称>`

名称是表格上方的 1～6 级标题，或一行只写名称的普通文本（中间可以有空行，但不能夹别的内容）。

```text
IDEA_NOTE_INPUT = {
  "columns": ["月份", "金额"],
  "rows":  [{"月份": "1月", "金额": "1200"}, ...],
  "table": [ ...与 rows 相同... ]
}
额外环境变量：table_rows=<数据行数>
```

- **所有单元格都是字符串**，要算数自己转（`float(row["金额"])`）。
- 表格每行首尾都要有 `|`，第二行必须是合法分隔行（`| --- | ---: |`）。
- 同名标题出现多次时取第一个匹配到的表格。
- `run=watch` **不监听表格改动**，表格改了要手动点运行。

## 来源三：`in=file:<路径>`

```text
IDEA_NOTE_INPUT = {"path": "<绝对路径>", "data": <按扩展名解析后的值>}
额外环境变量：file_path=<绝对路径>
```

扩展名决定格式：`.csv`→csv，`.json`→json，其余→text。这种写法没地方写 `as`。

## 三种解析格式

- `text`：`data` 是完整文本字符串。
- `json`：`data` 是 `JSON.parse` 后的值；语法错误直接阻止运行。
- `csv`：首行当表头，之后每行一个对象；**所有值保持字符串**；支持双引号包裹、
  引号内逗号与换行、`""` 转义、LF/CRLF/CR。

## 数据太大会被裁剪

`IDEA_NOTE_INPUT` 超过 32 KiB 时换成精简对象：只保留标量字段，加上 `"_truncated": true`，
数组和对象被删掉。处理大文件的脚本应当先探一手，再照 `*_path` / `file_path` 自己读文件：

```python
payload = json.loads(os.environ["IDEA_NOTE_INPUT"])
if payload.get("_truncated"):
    with open(os.environ["source_path"], encoding="utf-8") as f:
        ...
```
