<!-- Generated from src/lib/ai/componentGuide.ts. Update with node scripts/export-idea-note-skill.mjs. -->

# 输出：把结果送回笔记

只有退出码为 0 时才解析结果，且只看 stdout（stderr 只显示在运行面板里）。

## 方式一（推荐）：写了 `out=<类型>`

stdout 前面可以随便打日志，**最后一个非空行**必须是完整、合法、**单行**的 JSON 值，
它就是该类型的 data，不用再包一层。

两个最常见的错误：多行 JSON（缩进过的 `json.dumps(..., indent=2)`），
以及字符串没做 JSON 编码（`print("hello")` 而不是 `print(json.dumps("hello"))`）。
记住一句话：**最后一行必须能被 `JSON.parse` 直接吃下去。**

## 方式二：`out=auto` 或不写 `out=`

渲染类型要运行时才知道时，在任意独立的 stdout 行输出包装对象：

```json
{"idea_note_result":{"type":"table","data":{"columns":["项目"],"rows":[["值"]]}}}
```

最后一个形态正确的包装对象生效。区别：`out=auto` 在笔记里有结果卡片位置（没输出
包装对象算错误），不写 `out=` 则运行时弹出运行面板、没有包装对象也不算错——
**临时跑一段脚本看输出就不写 `out=`，做组件就写具体类型或 `auto`。**

## 七种输出格式

| `out` | data 形态 | 渲染成 |
| --- | --- | --- |
| `text` | string | 等宽纯文本（不解析 HTML） |
| `table` | `{columns: string[], rows: JsonValue[][]}` | 表头可点击排序的表格 |
| `json` | 任意合法 JSON | 两空格缩进的 JSON |
| `mermaid` | string | Mermaid 图表（返回**源码**，不是 SVG） |
| `html` | string | 消毒后的静态 HTML |
| `image` | 非空路径字符串或路径数组 | 一张或多张图片 |
| `markdown` | string | 渲染后的 Markdown |

要点：

- `table`：`columns` 必须全是字符串；`rows` 是**数组的数组**，每行长度和 columns
  完全一致；**不支持把行写成对象**。单元格必须是合法 JSON 值。
- `json` 的 data 不能含 `NaN` / `Infinity` / `undefined` / 日期对象，脚本先自己转。
- `html`：`<script>`、内联事件处理器会被 DOMPurify 删掉，不能依赖页面脚本；
  想要交互就把交互放进 `input` 块，用 `run=watch` 重新生成 HTML。
- `image`：路径相对当前笔记目录解析，也支持绝对路径和 `http(s):` / `data:`；
  协议只校验形态、不保证文件存在，所以脚本要先真的把图片写到磁盘再返回路径。
- `markdown`：结果里的可运行代码块不会再执行，只是渲染内容。

## 结果显示在哪

- `result=above`（默认）把结果放在代码块上方，代码退居其后；想按"代码→结果"阅读就写 `result=below`。
- 写了 `out=`（含 `auto`）的块在运行前就显示"尚未运行"占位卡片，且不弹运行面板。
- `watch` 重算期间保留上一次结果，成功并通过校验后才替换。
- 行内结果只在内存里，关闭文件就清掉，不会写进笔记。
