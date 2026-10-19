<!-- Generated from src/lib/ai/componentGuide.ts. Update with node scripts/export-idea-note-skill.mjs. -->

# 可交互组件速览

可交互组件 = 一个 `input` 参数块（可选）+ 一个可运行代码块。读者在笔记里拖滑块、
改数字、选下拉框，脚本就在本机重跑一遍，结果直接渲染回笔记里。

## 最小完整例子

```input {id=price_calc}
quantity: number = 2    {min: 1, step: 1, label: 数量, unit: 件}
price:    number = 9.90 {min: 0, step: 0.01, label: 单价, unit: 元}
```

```python {in=price_calc, out=markdown, run=watch}
import json, os

quantity = int(float(os.environ["quantity"]))
price = float(os.environ["price"])
print(json.dumps(f"**合计：{quantity * price:.2f} 元**", ensure_ascii=False))
```

## 两条铁律

1. **输入靠环境变量**：`IDEA_NOTE_INPUT`（一整份 JSON，保留类型）+ 每个字段一个
   同名环境变量（字符串）。脚本用 `os.environ` / `process.env` 读。
2. **输出必须是 stdout 最后一个非空行的单行合法 JSON**。字符串也要 JSON 编码：
   写 `print(json.dumps("hello"))`，不能写 `print("hello")`。前面的日志行随便打。

## 代码块信息行上的属性

| 属性 | 写在哪 | 取值 | 默认 | 作用 |
| --- | --- | --- | --- | --- |
| `id` | `input` 块 | 标识符（字母/下划线开头） | 无 | 给参数块起名，供 `in=` 引用 |
| `in` | 可运行块 | `<id>` / `table:<名称>` / `file:<路径>` | 无 | 数据从哪来 |
| `out` | 可运行块 | `text` `table` `json` `mermaid` `html` `image` `markdown` `auto` | 未声明 | 结果类型与渲染方式 |
| `run` | 可运行块 | `manual` `watch` `open`（可用 `+` 组合） | `manual` | 什么时候自动运行 |
| `result` | 可运行块 | `above` / `below` | `above` | 结果显示在代码块上方还是下方 |

书写顺序建议统一为：`语言 {in=..., out=..., run=..., result=...}`。

## 写组件的推荐流程

1. 想清楚**用户要调什么**（参数）、**要看到什么**（输出类型）。
2. 参数超过一个、或希望改完自动重算，就写 `input` 块并用 `in=` + `run=watch`；
   只是"点一下出结果"就只写可运行块。
3. 选 `out=`：文字结论用 `markdown`，数据用 `table`，流程/结构用 `mermaid`，
   画图用 `image`（脚本先把图片存到笔记目录再返回路径）。
4. 语言默认选 Python；确认本机可用的运行器（见下）。
5. 写完检查三件事：最后一行是单行 JSON、`in=` 的 id 和 `input` 块的 `id` 一致、
   `table` 的每行长度等于 `columns` 长度。

## 三条边界（写进笔记前要知道）

- 代码是在用户本机**真实执行**的，不是浏览器沙箱；不要写删除文件、联网上传、
  `sudo` 这类脚本，也不要依赖用户没提到的第三方库（用不到就别 import）。
- 参数值和运行结果只活在内存里，不会自动写回 `.md`，不产生 Git 差异。
- `out=html` 只渲染消毒后的静态 HTML：`<script>` 和内联事件会被删掉。交互只能
  通过 `input` 控件 + `run=watch` 实现，不能靠页面脚本。

需要细节时按主题再查：`input`（参数块语法）、`data`（表格/文件绑定与环境变量）、
`output`（七种输出格式）、`run`（触发方式与执行环境）、`examples`（完整示例）。
