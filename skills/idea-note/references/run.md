<!-- Generated from src/lib/ai/componentGuide.ts. Update with node scripts/export-idea-note-skill.mjs. -->

# 运行：用什么跑、什么时候跑

## 语言

内置运行器：`python`（别名 py、python3）、`node`（js、javascript、mjs）、
`ruby`（rb）、`perl`（pl）、`bash`（sh、shell、zsh）、`powershell`（ps1、pwsh）、
以及 Windows 上的 `bat`（cmd、batch）。
`mermaid`、`input`、`output` 是保留标识，不能当可运行语言。
运行器可以在设置里禁用或改命令，**能不能跑最终取决于用户设备上装没装解释器**。

## 执行环境

- 在用户本机真实执行；工作目录是笔记所在目录（未保存的草稿用工作区目录）。
- 一条解释器命令 + 一个临时代码文件：**没有 stdin，没有 TTY**。需要交互输入、
  常驻服务、`sudo`、或"先编译再运行"的场景请改用「在终端运行」。
- 默认超时 30 秒，默认最大输出 200 KiB；**输出被截断后结构化结果就不再解析**。
- 标准库优先。要用第三方库（如 matplotlib）时先在正文里说明需要 `pip install`。

## `run`：什么时候自动运行

| 值 | 行为 |
| --- | --- |
| `manual` | 只有点运行按钮才跑（默认） |
| `watch` | 绑定的 `input` 参数一变就自动跑（300 ms 防抖） |
| `open` | 每次打开这篇笔记时自动跑一次 |

- 组合写法：`run=watch+open`、`run=watch|open`、`run=watch open`，或重复写 `run=watch, run=open`。
- **`run=watch` 只对 `in=<input 块 id>` 生效**，不监听表格和文件内容变化。
- `run=manual` 会清掉它左边已解析到的自动触发器，别混写顺序冲突的属性。
- 只读模式下不执行任何自动运行。
- 开启「运行前二次确认」时，自动运行在每个应用会话首次触发时问一次。

## 重跑与结果身份

运行记录按「文件路径 + 代码内容哈希」关联。因此：

- 改了代码内容，旧结果就不再属于新代码。
- **两段源码完全相同的代码块共享同一个结果**。一篇笔记里要放两个同源码的独立组件时，
  给它们加不同的注释把源码区分开。

## 安全

代码有用户账号的全部权限。写组件时只做计算和渲染：不要写删除/覆盖用户文件、
上传数据、访问网络凭证之类的脚本；需要读文件就通过 `in=file:` 或 `file` 字段，
把路径交给用户决定。
