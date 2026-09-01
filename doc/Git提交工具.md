# Git 工具

一个基于 Idea Note 可交互组件的 Git 小工具：查看状态、拉取、提交、推送、分支管理、提交历史，全部在本机真实执行。

> [!HIGHLIGHT color=blue]
>
> 本文档必须使用Idea Note打开，否则只能看到代码无法直接操作执行。

## 一、仓库状态

点击运行按钮手动刷新，修改「使用代理」等参数时会自动重跑。

```input {id=git_status}
use_proxy: bool = true {label: 使用代理}
proxy_url: text = "http://127.0.0.1:7890" {label: 代理地址}
```

```python {in=git_status, out=markdown, run=watch}
import subprocess, json, os

use_proxy = os.environ.get("use_proxy", "false").strip().lower() == "true"
proxy_url = os.environ.get("proxy_url", "").strip()

cmd = ["git"]
if use_proxy and proxy_url:
    cmd += ["-c", f"http.proxy={proxy_url}", "-c", f"https.proxy={proxy_url}"]
cmd += ["status"]
p = subprocess.run(cmd, capture_output=True, text=True)
out = (p.stdout or "") + (p.stderr or "")
print(json.dumps(f"```\n{out.strip() or '(无输出)'}\n```", ensure_ascii=False))
```

## 二、拉取

拉取远程最新代码，默认走代理。

```input {id=git_pull}
use_proxy: bool = true {label: 使用代理}
proxy_url: text = "http://127.0.0.1:7890" {label: 代理地址}
```

```python {in=git_pull, out=markdown, run=manual}
import subprocess, json, os

use_proxy = os.environ.get("use_proxy", "false").strip().lower() == "true"
proxy_url = os.environ.get("proxy_url", "").strip()

def run(cmd):
    p = subprocess.run(cmd, capture_output=True, text=True)
    return p.returncode, (p.stdout or "") + (p.stderr or "")

def git_cmd(*args):
    cmd = ["git"]
    if use_proxy and proxy_url:
        cmd += ["-c", f"http.proxy={proxy_url}", "-c", f"https.proxy={proxy_url}"]
    return cmd + list(args)

if use_proxy and not proxy_url:
    text = "**⚠️ 已勾选使用代理，请填写代理地址**"
else:
    code, out = run(git_cmd("pull"))
    icon = "✅" if code == 0 else "❌"
    text = f"**{icon} 拉取{'成功' if code == 0 else '失败'}**\n\n```\n{out.strip() or '(无输出)'}\n```"

print(json.dumps(text, ensure_ascii=False))
```

## 三、提交

1. 在「提交信息」输入框中填写提交说明（必填）。
2. 可按需勾选「提交后推送」（推送默认走代理）。
3. 点击运行按钮执行；结果会显示在代码块上方。

```input {id=git_commit}
commit_message: text = "" {label: 提交信息}
push: bool = true {label: 提交后推送}
use_proxy: bool = true {label: 使用代理}
proxy_url: text = "http://127.0.0.1:7890" {label: 代理地址}
```

```python {in=git_commit, out=markdown, run=manual}
import subprocess, json, os

message = os.environ.get("commit_message", "").strip()
push = os.environ.get("push", "false").strip().lower() == "true"
use_proxy = os.environ.get("use_proxy", "false").strip().lower() == "true"
proxy_url = os.environ.get("proxy_url", "").strip()

def run(cmd):
    p = subprocess.run(cmd, capture_output=True, text=True)
    return p.returncode, (p.stdout or "") + (p.stderr or "")

def git_cmd(*args):
    cmd = ["git"]
    if use_proxy and proxy_url:
        cmd += ["-c", f"http.proxy={proxy_url}", "-c", f"https.proxy={proxy_url}"]
    return cmd + list(args)

if not message:
    text = "**⚠️ 请先填写提交信息**"
elif use_proxy and not proxy_url:
    text = "**⚠️ 已勾选使用代理，请填写代理地址**"
else:
    lines = [f"**提交信息：** `{message}`"]
    run(git_cmd("add", "-A"))
    cm_code, cm_out = run(git_cmd("commit", "-m", message))
    lines.append("✅ **提交成功**" if cm_code == 0 else "❌ **提交失败**")
    lines.append(f"```\n{cm_out.strip() or '(无输出)'}\n```")
    if cm_code == 0 and push:
        ps_code, ps_out = run(git_cmd("push"))
        lines.append("✅ **推送成功**" if ps_code == 0 else "❌ **推送失败**")
        lines.append(f"```\n{ps_out.strip() or '(无输出)'}\n```")
    text = "\n\n".join(lines)

print(json.dumps(text, ensure_ascii=False))
```

## 四、推送

把当前分支推送到远程（未提交的改动请先到「三、提交」处理），默认走代理。

```input {id=git_push}
use_proxy: bool = true {label: 使用代理}
proxy_url: text = "http://127.0.0.1:7890" {label: 代理地址}
```

```python {in=git_push, out=markdown, run=manual}
import subprocess, json, os

use_proxy = os.environ.get("use_proxy", "false").strip().lower() == "true"
proxy_url = os.environ.get("proxy_url", "").strip()

def run(cmd):
    p = subprocess.run(cmd, capture_output=True, text=True)
    return p.returncode, (p.stdout or "") + (p.stderr or "")

def git_cmd(*args):
    cmd = ["git"]
    if use_proxy and proxy_url:
        cmd += ["-c", f"http.proxy={proxy_url}", "-c", f"https.proxy={proxy_url}"]
    return cmd + list(args)

if use_proxy and not proxy_url:
    text = "**⚠️ 已勾选使用代理，请填写代理地址**"
else:
    code, out = run(git_cmd("push"))
    icon = "✅" if code == 0 else "❌"
    text = f"**{icon} 推送{'成功' if code == 0 else '失败'}**\n\n```\n{out.strip() or '(无输出)'}\n```"

print(json.dumps(text, ensure_ascii=False))
```

## 五、分支管理

支持列出、切换、新建分支。

```input {id=git_branch}
branch_action: select = [列出分支, 切换分支, 新建分支] {default: 列出分支, label: 操作}
branch_name: text = "" {label: 分支名}
use_proxy: bool = true {label: 使用代理}
proxy_url: text = "http://127.0.0.1:7890" {label: 代理地址}
```

```python {in=git_branch, out=markdown, run=manual}
import subprocess, json, os

use_proxy = os.environ.get("use_proxy", "false").strip().lower() == "true"
proxy_url = os.environ.get("proxy_url", "").strip()

def run(cmd):
    p = subprocess.run(cmd, capture_output=True, text=True)
    return p.returncode, (p.stdout or "") + (p.stderr or "")

def git_cmd(*args):
    cmd = ["git"]
    if use_proxy and proxy_url:
        cmd += ["-c", f"http.proxy={proxy_url}", "-c", f"https.proxy={proxy_url}"]
    return cmd + list(args)

action = os.environ.get("branch_action", "列出分支").strip()
name = os.environ.get("branch_name", "").strip()

if action == "列出分支":
    code, out = run(git_cmd("branch", "-a"))
    if code == 0:
        text = f"**当前分支列表**\n\n```\n{out.strip() or '(无分支)'}\n```"
    else:
        text = f"❌ **获取分支失败**\n\n```\n{out.strip()}\n```"
elif action == "切换分支":
    if not name:
        text = "**⚠️ 请填写要切换到的分支名**"
    else:
        code, out = run(git_cmd("switch", name))
        if code == 0:
            text = f"✅ **已切换到分支 `{name}`**"
        else:
            text = f"❌ **切换失败**\n\n```\n{out.strip()}\n```"
else:  # 新建分支
    if not name:
        text = "**⚠️ 请填写新分支名**"
    else:
        code, out = run(git_cmd("switch", "-c", name))
        if code == 0:
            text = f"✅ **已创建并切换到分支 `{name}`**"
        else:
            text = f"❌ **创建失败**\n\n```\n{out.strip()}\n```"

print(json.dumps(text, ensure_ascii=False))
```

## 六、提交历史

点击运行按钮手动刷新，修改「显示条数」「使用代理」等参数时会自动重跑，结果以表格呈现。

```input {id=git_log}
count: select = [5, 10, 20] {default: 10, label: 显示条数}
use_proxy: bool = true {label: 使用代理}
proxy_url: text = "http://127.0.0.1:7890" {label: 代理地址}
```

```python {in=git_log, out=table, run=watch}
import subprocess, json, os

count = int(os.environ.get("count", "10"))
use_proxy = os.environ.get("use_proxy", "false").strip().lower() == "true"
proxy_url = os.environ.get("proxy_url", "").strip()

cmd = ["git"]
if use_proxy and proxy_url:
    cmd += ["-c", f"http.proxy={proxy_url}", "-c", f"https.proxy={proxy_url}"]
cmd += ["log", "--format=%h%x09%s", "-n", str(count)]
p = subprocess.run(cmd, capture_output=True, text=True)
if p.returncode != 0:
    print(json.dumps({"columns": ["提示"], "rows": [[(p.stderr or "获取日志失败").strip()]]}, ensure_ascii=False))
else:
    rows = []
    for line in p.stdout.strip().splitlines():
        if "\t" in line:
            h, msg = line.split("\t", 1)
            rows.append([h, msg])
        else:
            rows.append([line, ""])
    print(json.dumps({"columns": ["哈希", "提交信息"], "rows": rows}, ensure_ascii=False))
```

## 小提示

- **代理**：六个组件都带「使用代理」开关（默认勾选）与代理地址输入框，代理地址默认 `http://127.0.0.1:7890`，请改成你本机实际地址。若已配置 git 全局代理，可取消勾选。
- 仓库状态、分支管理、提交历史是本地操作，代理勾不勾都不影响结果，勾上也无妨。
- 提交流程：先 `git add -A` 暂存全部改动，再 `git commit -m <提交信息>`。
- 勾选「提交后推送」（**默认勾选**）时，提交成功后会接着执行 `git push`；不想要推送可取消勾选，或之后单独用「四、推送」。
- 推送失败通常是分支尚未关联远程，可用 `git branch --set-upstream-to=origin/<分支名> <分支名>` 关联后重试。
- 切换分支前建议先看「一、仓库状态」，确认工作区干净，避免改动丢失。
- 提交历史默认展示最近 10 条，可切换 5 / 10 / 20 条。
