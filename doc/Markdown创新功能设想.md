# Markdown 创新功能设想

> 本文是一份**功能构想稿**，不是已实现功能的说明。所有条目都以当前代码为基础提出，并标注了可复用的现有模块与大致成本。
>


## 一、把「可执行」推到底

### 1. 富输出：代码块能吐出图，而不只是文本 ⭐

脚本按约定输出，运行面板与插入的结果块直接渲染，而不是当作纯文本显示。

````markdown
```python {out=mermaid}
import json
print(json.dumps("graph TD; A[订单]-->B[支付]-->C[发货]", ensure_ascii=False))
```
````

输出协议约定：指定 `out=` 时，stdout 最后一个非空行是严格 JSON data；未指定时输出 `{"idea_note_result":{"type":"...","data":...}}`。

| type | data |
| :--- | :--- |
| `mermaid` | JSON 字符串 |
| `table` | `{"columns":[...],"rows":[...]}` |
| `image` | JSON 路径字符串或路径数组 |
| `html` | JSON 字符串，消毒后静态渲染 |

**独特性**：Typora / Obsidian 的代码块只能高亮；Jupyter 能富输出但产物不是 Markdown 文件。这里能做到**源文件仍是纯 md**——别的编辑器打开就是一个普通代码块加一个普通 mermaid 块。

**复用**：`RunOutputPanel` 的结果插入逻辑 + 已有 mermaid / SVG / 表格渲染器。

**成本**：低。主要工作是输出协议约定与渲染分发。

---

### 2. 文档即测试：笔记会自己告诉你「过期了」 ⭐

运行后，把实际输出与笔记里已存在的 ```output 块做 diff：

- 一致 → 块角标绿勾 + 时间戳
- 不一致 → 红标，点开即左右对比

再加一个**全库体检**：跑一遍工作区所有可执行块，产出报告「12 个块通过，3 个结果已变，2 个解释器缺失」。

**独特性**：把技术笔记从「写完就腐烂」变成「有回归测试的活文档」。编辑器领域几乎空白，最接近的是 Rust doctest / mdbook test，但都不是交互式笔记。

**复用**：已有 `diff` 与 `@codemirror/merge` 依赖、`useRunStore` 的 `hashCode` 块身份、`search.rs` 的全库遍历。

**成本**：中。

---

### 3. 块链：不常驻进程也能有 Notebook 体验

当前每次运行都是独立进程，状态无法延续。不必直接上常驻 REPL（缓冲与状态清理都麻烦），先做纯前端代码拼接：

````markdown
```python {id=setup}
import pandas as pd
df = pd.read_csv("data.csv")
```

```python {after=setup}
print(df.head())      # 运行时自动把 setup 的代码拼在前面
```
````

**优点**：后端零改动；语义确定，不会出现 Notebook 那种「我上次到底跑没跑那个 cell」的困惑；结果天然可复现。之后若确有需要，再考虑 `{session=x}` 常驻进程方案。

**成本**：低。

---

### 4. 参数控件块：笔记变成小工具

在 Markdown 里声明输入，实时预览渲染成滑块 / 下拉 / 输入框，代码块通过环境变量取值：

````markdown
```input
principal: number = 500000  {slider: 0..2000000}
rate:      number = 3.85
years:     select = [20, 25, 30]
```

```python {watch=input}
import os
p = float(os.environ["principal"]); r = float(os.environ["rate"]) / 100 / 12
n = int(os.environ["years"]) * 12
m = p * r * (1 + r) ** n / ((1 + r) ** n - 1)
print(f"月供 {m:.2f}")
```
````

拖动滑块，下面的结果自动重算。房贷计算器、正则测试器、单位换算、API 调试面板——每篇笔记都能变成一个小 App。

**独特性**：Observable 有 `viewof`，但不是本地 Markdown 文件 + 本地解释器。

**复用**：块级 widget 模板照抄 `src/lib/codemirror/diagram.ts`——StateField（块级装饰不能来自 ViewPlugin）+ 扫描围栏得到 `[from, to]` + 选区不相交时 `Decoration.replace({ widget, block: true })`、相交时露出源码 + `blockHeight.ts` 记住实测高度以免滚动跳动。控件本身的按钮/交互可参考 `livePreview.ts` 的 `CodeActionsWidget`（`Decoration.widget({ side: -1 })`，浮在块上而不接管块）。runner 配置里现成的 `env` 字段天然就能传参。

**成本**：中。

---

### 5. 表格即数据源，结果可回写

````markdown
```python {in=table:销售数据, out=table:汇总}
# rows：上方那张 markdown 表格已被解析成数组
```
````

跑完把结果写回笔记里指定的表格，在文档内形成数据流。Markdown 表格第一次变成「活的」。

**成本**：中。难点在回写时的编辑冲突与 undo 语义。

---

## 二、让笔记「自己动」

### 6. 触发式块：打开即刷新的仪表盘

````markdown
```bash {run: on-open, cache: 10m}
git -C ~/work log --oneline -5
```
````

触发器：`on-open` / `on-save` / `every 30m`。可以做一篇「晨间仪表盘」笔记：今日待办统计、CI 状态、服务器磁盘、汇率。

**安全**：必须逐笔记白名单 + 首次弹窗授权（现有的 `confirmEveryRun` 是不错的底子），绝不能对同步下来的仓库自动执行。

**成本**：中，安全模型是主要工作量。

---

### 7. ```query 块：用 SQL 查自己的笔记库

````markdown
```query
SELECT path, title FROM notes
WHERE tags LIKE '%待办%' AND mtime > date('now','-7 day')
```
````

渲染成可点击表格。用途：任务清单聚合、标签墙、孤儿笔记检测、断链检查。

**复用**：`src-tauri/src/search.rs` 与 `tree.rs` 已有全库遍历能力。

**成本**：中。相比 Dataview 那套自造 DSL，标准 SQL 更容易被用户接受。

---

### 8. 段落级 Git blame + 时间机器

光标停在某段时，行内淡色显示「3 天前 · sync: 2026/8/25」；侧栏时间轴滑块拖动时，整篇笔记在预览里回放历史版本。

**独特性**：笔记应用里几乎没有段落级溯源，而本项目已有完整 Git 基建。

**复用**：`git.rs` + `HistoryModal.tsx`，解析 `git blame --porcelain` 即可。

**成本**：低到中。

---

## 三、编辑器交互层

### 9. 行内实时计算 ⭐

```markdown
服务器 12 台 × `= 12 * 320 元/月` → 每年 `= 上一行 * 12`
预计上线 `= 今天 + 45 天`（星期几？）
下载耗时 `= 4.7GB / 20Mbps`
```

行内 `` `= …` `` 实时求值，支持单位、货币、日期、引用上文变量。相当于把 Soulver / Numi 的能力长在 Markdown 里。

**复用**：行内 KaTeX 的 widget 机制现成（`src/lib/codemirror/math.ts`）。

**成本**：低。求值器可用现成小库或自写受限表达式解析。

---

### 10. AI 块：把 AI 变成与代码块同构的「可执行块」

````markdown
```ai {model=opus, cache}
根据上面的表格，写一段 200 字的季度总结
```

```output
（回答落在这里，可重跑、可 diff、可固化）
```
````

现在 AI 在侧边面板，本质是「会话」；变成块之后就是「文档的一部分」——可版本控制、可 diff、可批量重跑。

**复用**：`src/lib/ai/` 全套客户端 + code-run 的面板 / 重跑 / 插入结果 UI 几乎原样复用。

**成本**：低，收益极高。

---

### 11. 可执行链接

```markdown
[run: npm test]          点一下直接送进底部终端面板
[open: ./src/app.ts:42]  点一下在编辑器打开并定位
```

README、运维手册、新人上手文档立刻从「复制粘贴」变成「点一下」。

**复用**：`terminal.rs` 与代码块右键的「在终端运行」已有通路。

**成本**：很低。

---

### 12. 导出侧的条件内容

```markdown
<!-- @only(editor) --> API Key: sk-xxx，导出 PDF 时自动排除
<!-- @only(export) --> 版权声明
```

一份源文件，对内是工作稿，对外是成品；同时天然防止密钥被导出。

**复用**：`src/lib/print/renderMarkdown.ts`。

**成本**：低。

---

## 优先级建议

| 想法 | 独特性 | 成本 | 建议 |
| :--- | :--- | :--- | :--- |
| 1. 富输出（代码块出图 / 表） | 高 | 低 | **先做**，立刻放大现有卖点 |
| 10. AI 块 | 高 | 低 | **先做**，复用度最高 |
| 9. 行内实时计算 | 高 | 低 | **先做**，演示效果好 |
| 2. 文档即测试 | 很高 | 中 | 第二批，最有差异化的一条 |
| 3. 块链 `{after=}` | 中 | 低 | 第二批，顺手 |
| 4. 参数控件块 | 高 | 中 | 第二批 |
| 11. 可执行链接 | 中 | 很低 | 随时可插入 |
| 12. 导出条件内容 | 中 | 低 | 随时可插入 |
| 7. ```query 块 | 中 | 中 | 第三批 |
| 8. 段落级 blame | 高 | 中 | 第三批 |
| 5. 表格即数据源 | 高 | 中 | 第三批 |
| 6. 触发式块 | 中 | 中 | 第三批，安全模型先想清楚 |

## 落地路径

1. **抽象先行**：从 `useRunStore` / `RunOutputPanel` 中提取「可执行块」通用模型（输入、输出、状态、缓存键、重跑、结果插入），代码块成为它的第一个实例。
2. **第一批**：富输出 → AI 块 → 行内计算。三者共用上一步的抽象，验证抽象是否站得住。
3. **第二批**：文档即测试 + 块链 + 参数控件块。此时「块」已具备输入与校验，笔记开始具备可复现性。
4. **第三批**：查询块、段落级 blame、表格数据流、触发式块。在此之前必须先落地逐仓库 / 逐笔记的执行授权模型。
