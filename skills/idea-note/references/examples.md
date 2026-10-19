<!-- Generated from src/lib/ai/componentGuide.ts. Update with node scripts/export-idea-note-skill.mjs. -->

# 完整示例

## 1. 参数 + Markdown 结论（最常用）

```input {id=loan}
principal: number = 500000 {slider: 100000..3000000, step: 50000, label: 贷款总额, unit: 元}
rate:      number = 3.85   {slider: 1..8, step: 0.05, label: 年利率, unit: %}
years:     select = [10, 20, 25, 30] {default: 30, label: 贷款年限, unit: 年}
```

```python {in=loan, out=markdown, run=watch}
import json, os

principal = float(os.environ["principal"])
monthly_rate = float(os.environ["rate"]) / 100 / 12
months = int(os.environ["years"]) * 12
growth = (1 + monthly_rate) ** months
monthly = principal * monthly_rate * growth / (growth - 1)
total = monthly * months

result = (
    f"**月供 {monthly:,.2f} 元**\n\n"
    f"- 利息合计：{total - principal:,.2f} 元\n"
    f"- 本息合计：{total:,.2f} 元"
)
print(json.dumps(result, ensure_ascii=False))
```

## 2. 无参数、打开笔记就刷新的表格

```python {run=open, out=table}
import datetime, json, shutil

total, used, free = shutil.disk_usage(".")
gb = 1024 ** 3
result = {
    "columns": ["项目", "数值"],
    "rows": [
        ["刷新时间", f"{datetime.datetime.now():%H:%M:%S}"],
        ["磁盘已用", f"{used / gb:.1f} GB"],
        ["使用率", f"{used / total * 100:.1f}%"],
    ],
}
print(json.dumps(result, ensure_ascii=False))
```

## 3. 把笔记里的表格变成 Mermaid 甘特图

```python {in=table:项目排期, out=mermaid, result=below}
import json, os

rows = json.loads(os.environ["IDEA_NOTE_INPUT"])["rows"]
lines = ["gantt", "    dateFormat YYYY-MM-DD", "    title 项目排期"]
for row in rows:
    lines.append(f"    {row['任务']} :{row['开始']}, {row['结束']}")
print(json.dumps("\n".join(lines), ensure_ascii=False))
```

## 4. 画图并返回图片路径（需要 matplotlib）

```input {id=plot}
freq: number = 2 {slider: 1..10, step: 1, label: 频率}
```

```python {in=plot, out=image, run=watch}
import json, math, os
import matplotlib
matplotlib.use("Agg")
import matplotlib.pyplot as plt

freq = float(os.environ["freq"])
xs = [i / 100 for i in range(0, 628)]
plt.figure(figsize=(6, 3))
plt.plot(xs, [math.sin(freq * x) for x in xs])
path = os.path.join(os.getcwd(), "plot.png")   # 工作目录 = 笔记所在目录
plt.savefig(path, dpi=120, bbox_inches="tight")
plt.close()
print(json.dumps("./plot.png", ensure_ascii=False))
```

## 5. Node + 运行时决定渲染方式

```input {id=view}
mode: select = [表格, 文字] {default: 表格, label: 展示方式}
```

```javascript {in=view, out=auto, run=watch}
const data = JSON.parse(process.env.IDEA_NOTE_INPUT);
const result =
  data.mode === "表格"
    ? { type: "table", data: { columns: ["项目", "值"], rows: [["状态", "正常"]] } }
    : { type: "markdown", data: "**状态：正常**" };
console.log(JSON.stringify({ idea_note_result: result }));
```

## 6. 日期区间统计（date / time）

```input {id=span}
start:   date = "2026-01-01" {label: 开始日期}
end:     date = "2026-03-31" {min: 2026-01-01, label: 结束日期}
per_day: time = "07:30" {label: 每天投入, step: 1800}
```

```python {in=span, out=markdown, run=watch}
import datetime, json, os

data = json.loads(os.environ["IDEA_NOTE_INPUT"])
if not data["start"] or not data["end"]:
    print(json.dumps("请先选好起止日期。", ensure_ascii=False))
    raise SystemExit

start = datetime.date.fromisoformat(data["start"])
end = datetime.date.fromisoformat(data["end"])
days = (end - start).days + 1
h, m = (int(x) for x in data["per_day"].split(":")[:2])
hours = days * (h + m / 60)

print(json.dumps(
    f"**共 {days} 天，合计投入 {hours:.1f} 小时**\n\n"
    f"- 工作日：{sum(1 for i in range(days) if (start + datetime.timedelta(i)).weekday() < 5)} 天",
    ensure_ascii=False,
))
```
