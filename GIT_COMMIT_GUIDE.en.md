# Git Commit Guide (English)

Prefer concise Conventional Commits messages so history is easy to browse, release notes are easy to generate, and issues are easy to locate. This is also the built-in guide for AI-generated commit messages when the interface is in English. The Chinese version is `GIT_COMMIT_GUIDE.md`.

## Commit format

```text
<type>(<scope>): <subject>
```

The scope is optional:

```text
<type>: <subject>
```

Requirements:

- Use an English type.
- Write the subject in English as one sentence describing the change. Write any necessary body in English too; preserve technical names, paths, and identifiers.
- Do not end the subject with a period.
- Keep each commit focused on one coherent change.
- Avoid vague descriptions such as `update`, `fix bug`, or `change things`.

## Common types

- `feat`: A new feature or user-visible capability.
- `fix`: A bug fix, error correction, or regression fix.
- `docs`: Documentation, README, CHANGELOG, or other explanatory text.
- `style`: Formatting, styling, or layout changes that do not affect logic.
- `refactor`: Code restructuring without changing user-visible behavior.
- `perf`: A performance improvement.
- `test`: New or updated tests.
- `build`: Build scripts, dependencies, or packaging configuration.
- `ci`: CI/CD configuration changes.
- `chore`: Maintenance such as version bumps, cleanup, or tool configuration.
- `sync`: A local snapshot commit created by the application's automatic sync.

## Suggested scopes

Common scopes:

- `sync`: Remote sync, Git sync, and sync settings.
- `editor`: The editor, preview, toolbar, and tabs.
- `sidebar`: The sidebar, file tree, search, and directories.
- `history`: Version history, rollback, and diff views.
- `settings`: The settings window and configuration.
- `terminal`: The bottom terminal panel.
- `print`: Printing and PDF export.
- `ai`: The AI assistant and model configuration.
- `tauri`: The Rust backend, Tauri commands, and desktop integration.
- `theme`: Themes, colors, and appearance.
- `deps`: Dependency changes.
- `release`: Releases, version numbers, and CHANGELOG.

## Examples

```text
feat(sync): support HTTPS credential login
fix(editor): keep image preview from stealing focus
docs: update release download links
refactor(tauri): share git command timeout handling
build(deps): add tempfile for git askpass helper
chore(release): bump version to 1.0.2
```

## Body and breaking changes

Add a body when the subject cannot explain the reason or impact clearly:

```text
fix(sync): retry HTTPS push after credential prompt

Local changes are committed before network operations, so failed auth should
not leave the workspace in a partial sync state.
```

For breaking changes, use `!` or `BREAKING CHANGE:`:

```text
feat(settings)!: rename sync config keys

BREAKING CHANGE: old sync config files need migration.
```
