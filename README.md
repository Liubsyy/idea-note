# Idea Note

<p align="center">
  <img src="./src-tauri/icons/icon.png" alt="Idea Note icon" width="96" />
</p>

<p align="center">
  <img src="https://img.shields.io/badge/Windows-0078D6?style=flat-square&logo=data:image/svg%2Bxml;base64,PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciIHZpZXdCb3g9IjAgMCAxNiAxNiI%2BPHBhdGggZmlsbD0id2hpdGUiIGQ9Ik0wIDJsNy0xdjZIMHpNOCAxbDgtMXY3SDh6TTAgOWg3djZsLTctMXpNOCA5aDh2N2wtOC0xeiIvPjwvc3ZnPg%3D%3D" alt="Windows" />
  <img src="https://img.shields.io/badge/MacOS-000000?style=flat-square&logo=apple&logoColor=white" alt="MacOS" />
  <img src="https://img.shields.io/badge/Linux-FCC624?style=flat-square&logo=linux&logoColor=black" alt="Linux" />
</p>
<p align="center">
  <a href="https://github.com/Liubsyy/idea-note/releases/latest"><img src="https://img.shields.io/github/v/release/Liubsyy/idea-note?display_name=tag&style=flat-square&logo=github&label=version&color=0ea5e9" alt="Latest release" /></a>
  <a href="https://github.com/Liubsyy/idea-note/releases"><img src="https://img.shields.io/github/downloads/Liubsyy/idea-note/total?style=flat-square&logo=github&label=downloads&color=10b981" alt="Total downloads" /></a>
</p>

**Idea Note** 是一款轻量、简洁的所见即所得 **Markdown** 笔记应用，内置 **AI 笔记助手**，可用自然语言编辑你的笔记，支持**Git远程同步**，兼容 Windows、MacOS 和 Linux 平台。


主界面效果图：



![](./doc/assets/sample1.png)




AI 笔记助手效果图：


![](doc/assets/sample2.png)


## 功能特性

- **AI 笔记助手**：可结合当前笔记进行问答、总结、润色，并通过工具直接读取、搜索、新建、编辑或删除笔记。
- **Markdown 编辑**：所见即所得实时预览，支持 CommonMark + GFM、KaTeX 公式、Mermaid 图表、HTML / SVG 渲染、源码模式、多标签页和格式工具栏。
- **文件管理**：除markdown外还可管理其他文件，可作为轻量级项目文件管理器，支持文件树、文件夹浏览、普通文本编辑和图片查看。
- **笔记管理**：提供笔记模式、大纲和全局搜索，方便整理、定位和回看内容。
- **Git 同步与历史**：支持自动提交、远程推拉、本地版本记录、单文件 / 全局历史和 diff 对比。
- **内置终端**：集成终端，可在应用内直接执行命令。
- **导出与系统集成**：可导出带书签大纲的 PDF，支持系统级“打开方式”关联常见文本、代码与图片文件。
- **其他特性**：支持切换主题和自定义主题、自定义字体字号间距。

## 使用说明

### 安装

根据平台下载桌面安装包或发行文件

| 系统 | 文件 | 说明 |
| :--- | :--- | :--- |
| **Windows** | **x64**：[安装包](https://github.com/Liubsyy/idea-note/releases/latest/download/Idea.Note_1.0.4_windows_x64_setup.exe) \| [免安装包](https://github.com/Liubsyy/idea-note/releases/latest/download/Idea.Note_1.0.4_windows_x64.zip)<br>**x86**：[安装包](https://github.com/Liubsyy/idea-note/releases/latest/download/Idea.Note_1.0.4_windows_x86_setup.exe) \| [免安装包](https://github.com/Liubsyy/idea-note/releases/latest/download/Idea.Note_1.0.4_windows_x86.zip) | 大多数电脑选 x64<br>32 位系统选 x86 |
| **MacOS** | **Apple Silicon**：[安装包](https://github.com/Liubsyy/idea-note/releases/latest/download/Idea.Note_1.0.4_macos_aarch64.dmg) \| [应用包压缩](https://github.com/Liubsyy/idea-note/releases/latest/download/Idea.Note_1.0.4_macos_aarch64.app.tar.gz)<br>**Intel**：[安装包](https://github.com/Liubsyy/idea-note/releases/latest/download/Idea.Note_1.0.4_macos_x64.dmg) \| [应用包压缩](https://github.com/Liubsyy/idea-note/releases/latest/download/Idea.Note_1.0.4_macos_x64.app.tar.gz) | M芯片选 Apple Silicon<br>Intel 芯片选 Intel |
| **Linux** | **安装包**：[deb](https://github.com/Liubsyy/idea-note/releases/latest/download/Idea.Note_1.0.4_linux_amd64.deb) \| [rpm](https://github.com/Liubsyy/idea-note/releases/latest/download/Idea.Note_1.0.4_linux_x86_64.rpm)<br>**免安装**：[AppImage](https://github.com/Liubsyy/idea-note/releases/latest/download/Idea.Note_1.0.4_linux_amd64.AppImage) | Ubuntu/Debian/Linux Mint选deb<br>Fedora/RHEL/CentOS Stream/openSUSE选rpm |

MacOS 首次安装时如果遇到"无法打开"或"应用已损坏"之类的权限提示，可按下面方式处理：

1. "系统设置 -> 隐私与安全性"中找到被拦截的应用，点击"仍要打开"
2. 如果第1种方式不行，可以在终端执行以下命令后重新打开
```
xattr -rd com.apple.quarantine /Applications/Idea\ Note.app
```

### 笔记管理

首次启动时选择一个本地文件夹作为工作区，所有笔记都以普通文件形式存放在这个文件夹里，不使用私有格式，随时可以用其他工具打开。

左侧列表提供三种视图，可在顶部切换：

- **文件模式**：完整文件树，可新建、重命名、拖拽整理文件与文件夹，也能编辑普通文本、查看图片，当作轻量的项目文件管理器使用
- **笔记模式**：只显示 Markdown 笔记，支持卡片和树形两种展示方式，专注于笔记本身
- **预览大纲**：当前笔记的标题大纲，点击标题即可跳转

侧栏还提供全局搜索（`Cmd/Ctrl+Shift+F`），可在整个工作区内按关键词定位内容。安装后 Idea Note 也会注册为常见文本、Markdown、代码与图片文件的系统"打开方式"，可以直接从文件管理器中用它打开单个文件。

### 编辑笔记

正文采用所见即所得的实时预览：光标点进公式、表格、Mermaid 图表等块时显示源码方便编辑，移开光标即渲染成型。每个标签页右上角可在三种模式间切换：

- **编辑**：实时预览编辑（默认）
- **只读**：纯阅读，防止误改
- **源码**：完整 Markdown 源码，适合大段整理

顶部工具栏可一键插入标题、加粗 / 斜体 / 删除线、列表与任务列表、引用、代码块、链接、图片、表格、KaTeX 数学公式，以及流程图、时序图、甘特图等各类 Mermaid 图表。支持多标签页同时打开多篇笔记；粘贴的图片和文件会自动保存为附件，保存目录可在设置中配置。

Markdown 语法的完整支持范围可参考 [doc/markdown-语法大全.md](./doc/markdown-语法大全.md)。

### AI 笔记助手

点击标题栏机器人图标打开 AI 笔记助手面板。在设置中添加模型服务即可使用：支持 Anthropic、OpenAI 以及任何兼容两者接口的服务（自定义 Base URL、API Key 和模型 ID），对话中可随时切换模型与思考级别。

助手能看到当前打开的笔记，可以直接问答、总结、润色；它还内置一组笔记工具，可以搜索工作区、读取任意笔记，并新建、编辑、删除笔记。所有修改操作默认"编辑前确认"，逐条审阅后再生效，也可切换为自动执行。会话支持多开并保留历史，随时回看或删除。

实现原理见 [doc/AI笔记助手原理.md](./doc/AI笔记助手原理.md)。

### Git 同步与历史记录

在"设置 → 远程同步"中配置，基于命令行 git 实现（需已安装 git），支持两种方式：

- **仅本地**：将工作区初始化为本地 git 仓库，修改自动提交为版本快照，不推送到任何远程，之后可随时升级为远程同步
- **远程同步**：关联 GitHub / Gitee / 自建等任意远程仓库，或直接克隆一个远程仓库作为新笔记库；开启自动同步后按设定间隔（1–60 分钟）在后台自动执行"提交 → 拉取合并 → 推送"，也可随时手动同步

两端修改了同一处时，双方内容都会以 `<<<<<<<` 标记保留在文件中，整理后再次同步即可，不会丢失内容。网络受限时可配置仅同步时生效的 HTTP 代理，不写入 git 全局配置。

点击标题栏历史图标，可查看当前笔记的每一次变更并左右对比差异，也可切换到全局历史浏览整个工作区的提交记录。

### 内置终端

点击标题栏终端图标可打开底部终端面板，直接在工作区目录下执行命令，运行脚本、使用 git 等都无需离开应用。

### 导出 PDF

在侧栏文件右键菜单中选择"导出 PDF"，通过系统 WebView 静默打印直接生成 PDF 文件，自动附带书签大纲，公式、图表、代码高亮与应用内显示一致，无需安装任何额外组件。

### 设置

在侧栏底部齿轮图标打开设置窗口，包含以下配置项：

- **外观**：明暗主题与主题色、界面缩放、紧凑排版，支持导入自定义主题 JSON
- **左侧列表**：各视图的字体大小
- **编辑器**：字体、字号、行高与标题缩放
- **快捷键**：自定义编辑器快捷键
- **图片/附件**：粘贴图片与文件的保存目录（笔记目录 / 工程目录 / 绝对目录）
- **AI 笔记助手**：模型服务、API Key 与字号
- **远程同步**：Git 仓库与同步代理

![](doc/assets/setting.png)

## 开发与构建

### 技术栈

- 前端：`React 19`、`TypeScript`、`Vite 8`、`CodeMirror 6`、`Zustand`、`Tailwind CSS`
- 桌面端：`Tauri 2`
- 后端逻辑：`Rust`

### 环境要求

- Node.js：建议使用较新的 LTS 版本
- Rust：较新的稳定版

### 目录结构

- `src/`：React 前端界面与页面逻辑
  - `components/`：侧栏、编辑器、面板、设置等 UI 组件
  - `lib/codemirror/`：实时预览、公式、图表等编辑器扩展
  - `lib/ai/`：AI 笔记助手客户端与工具
  - `store/`：Zustand 全局状态
- `src-tauri/`：Tauri 桌面端与 Rust 后端实现（文件、Git、搜索、终端、打印等命令）
- `doc/`：文档与 Markdown 语法示例

### 本地开发

#### 1. 安装依赖

```bash
npm install
```

#### 2. 启动桌面应用调试

```bash
npm run tauri dev
```

仅前端预览可用 `npm run dev`（浏览器中文件读写等原生能力不可用）。

### 常用命令

| 命令 | 说明 |
| --- | --- |
| `npm install` | 安装前端依赖 |
| `npm run dev` | 启动前端开发服务器 |
| `npm run tauri dev` | 启动桌面应用开发模式 |
| `npm run preview` | 预览前端构建产物 |
| `npm run build` | 执行 TypeScript 检查并构建前端 |
| `npm run tauri build` | 构建桌面应用安装包 |
| `cargo check --manifest-path src-tauri/Cargo.toml` | 检查 Rust / Tauri 侧代码 |
| `cargo test --manifest-path src-tauri/Cargo.toml` | 运行 Rust 单元测试 |


### 打包与资源说明

- 应用名称：`Idea Note`
- 应用标识：`com.liubs.idea-note`

