# Git Commit Guide

本项目提交信息优先使用简洁的 Conventional Commits 风格，便于查看历史、生成变更说明和定位问题。

## 提交格式

```text
<type>(<scope>): <subject>
```

`scope` 可省略：

```text
<type>: <subject>
```

要求：

- 使用英文 type。
- subject 使用一句话说明本次变更，优先中文或英文均可，但同一批提交尽量统一。
- subject 不以句号结尾。
- 一次提交只做一件相对完整的事。
- 避免使用笼统描述，例如 `update`、`fix bug`、`改东西`。

## 常用 Type

- `feat`: 新功能或新的用户可见能力。
- `fix`: 修复 bug、异常行为或回归。
- `docs`: 文档、README、CHANGELOG 等文本说明。
- `style`: 仅格式、样式、排版变更，不影响逻辑。
- `refactor`: 重构代码，不改变用户可见行为。
- `perf`: 性能优化。
- `test`: 新增或修改测试。
- `build`: 构建脚本、依赖、打包配置变更。
- `ci`: CI/CD 配置变更。
- `chore`: 维护类改动，例如版本号、清理、工具配置。
- `sync`: 应用自动同步生成的本地快照提交。

## Scope 建议

常见 scope：

- `sync`: 远程同步、Git 同步、同步设置。
- `editor`: 编辑器、预览、工具栏、标签页。
- `sidebar`: 侧栏、文件树、搜索、目录。
- `history`: 历史版本、回退、差异查看。
- `settings`: 设置窗口和配置项。
- `terminal`: 底部终端。
- `print`: 打印、PDF 导出。
- `ai`: AI 助手、模型配置。
- `tauri`: Rust 后端、Tauri 命令、桌面集成。
- `theme`: 主题、配色、外观。
- `deps`: 依赖变更。
- `release`: 发布、版本号、CHANGELOG。

## 示例

```text
feat(sync): support HTTPS credential login
fix(editor): keep image preview from stealing focus
docs: update release download links
refactor(tauri): share git command timeout handling
build(deps): add tempfile for git askpass helper
chore(release): bump version to 1.0.2
```

## 正文和破坏性变更

当 subject 无法解释清楚原因或影响时，添加正文：

```text
fix(sync): retry HTTPS push after credential prompt

Local changes are committed before network operations, so failed auth should
not leave the workspace in a partial sync state.
```

如果包含破坏性变更，使用 `!` 或 `BREAKING CHANGE:`：

```text
feat(settings)!: rename sync config keys

BREAKING CHANGE: old sync config files need migration.
```

## 自动同步提交

应用自动生成的本地快照提交可保持现有格式：

```text
sync: 2026/7/5 09:34:25
```

这类提交只用于笔记库内容快照，不建议用于代码功能开发提交。

## CHANGELOG 规则

面向用户的功能、修复和发布相关变更，应同步更新 `CHANGELOG.md`：

- 新功能使用清晰的用户视角描述。
- 修复项说明修复了什么场景。
- 避免空 bullet。
- 同一版本下按重要程度从高到低排列。

## 提交前检查

根据改动范围选择运行：

```bash
npm run build
cargo check --manifest-path src-tauri/Cargo.toml
cargo fmt --manifest-path src-tauri/Cargo.toml --check
```

只改文档时可以不运行完整构建，但提交说明中应能看出这是文档变更。
