// Dev-only automated test for the native PDF export pipeline.
//
// `VITE_PDF_EXPORT_TEST=/abs/out.pdf npm run tauri dev` exports a fixture
// document (Chinese text, headings, table, code, KaTeX, mermaid, task list,
// enough content to paginate) shortly after startup, then writes
// `<out.pdf>.result.json` with {ok, error} so an external harness can assert
// on both the outcome and the produced file. Never bundled in production —
// main.tsx only imports this module in dev when the env var is set.

import { invoke } from "@tauri-apps/api/core";

import { fillPrintRoot, prepareOutlineForExport } from "./printNote";

// A 4x4 red PNG so the <img> path is exercised without touching the network.
const RED_DOT =
  "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAQAAAAECAIAAAAmkwkpAAAAFUlEQVR4nGP8z8DwnwEJMDGgAXQBAEcVAgWNZbjSAAAAAElFTkSuQmCC";

/**
 * Write a generated PNG (magenta/teal checker, 96x96) next to `outPath` and
 * return its absolute path, so the fixture can exercise the local-file image
 * pipeline (toDisplaySrc → asset protocol) and not just data URIs.
 */
async function writeLocalTestImage(
  outPath: string,
  name: string,
): Promise<string> {
  const canvas = document.createElement("canvas");
  canvas.width = canvas.height = 96;
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("canvas 2d unavailable");
  for (let y = 0; y < 2; y++)
    for (let x = 0; x < 2; x++) {
      ctx.fillStyle = (x + y) % 2 ? "#e6007e" : "#00a0a0";
      ctx.fillRect(x * 48, y * 48, 48, 48);
    }
  const dataUrl = canvas.toDataURL("image/png");
  const bytes = Array.from(atob(dataUrl.split(",")[1]), (c) => c.charCodeAt(0));
  const dir = outPath.slice(0, outPath.lastIndexOf("/")) || "/";
  return invoke<string>("write_binary_file", { dir, name, data: bytes });
}

const FIXTURE = `# PDF 导出测试文档

这是一段中文正文，用于验证 **PingFang SC** 字体渲染与加粗、*斜体*、\`行内代码\`。

## 表格

| 方案 | 平台 | 状态 |
|------|------|------|
| NSPrintOperation | macOS | 测试中 |
| PrintToPdf | Windows | 待验证 |
| WebKitPrintOperation | Linux | 待验证 |

## 代码块

\`\`\`rust
fn main() {
    println!("你好，PDF 导出");
}
\`\`\`

## 数学公式

行内公式 $E = mc^2$，块级公式：

$$
\\int_{-\\infty}^{\\infty} e^{-x^2} \\, dx = \\sqrt{\\pi}
$$

## Mermaid 图

\`\`\`mermaid
graph LR
  A[渲染 print-root] --> B[原生打印管线]
  B --> C[PDF 文件]
\`\`\`

## 任务列表

- [x] macOS 实现
- [ ] Windows 验证
- [ ] Linux 验证

## 图片

data URI 图片：

![red dot](${RED_DOT})

本地文件图片（绝对路径，asset 协议）：

LOCAL_IMAGE_PLACEHOLDER

路径带未转义空格的图片（Typora 宽松语法）：

SPACED_IMAGE_PLACEHOLDER

## 分页内容

${Array.from(
  { length: 40 },
  (_, i) =>
    `第 ${i + 1} 段：这一段文字反复出现以撑出多页内容，验证跨页分页、页边距与 break-inside 规则是否生效。`,
).join("\n\n")}

最后一行：文档结束标记 END-OF-FIXTURE。
`;

export async function runPdfExportTest(outPath: string): Promise<void> {
  const report = (ok: boolean, error?: string) =>
    invoke("write_file", {
      path: `${outPath}.result.json`,
      content: JSON.stringify({ ok, error: error ?? null }),
    }).catch(() => undefined);

  try {
    let fixture = FIXTURE;
    try {
      const imgPath = await writeLocalTestImage(outPath, "pdf-test-image.png");
      // Raw unescaped space in the destination — must render via the lenient
      // spaced_image rule, matching the editor's behavior.
      const spacedPath = await writeLocalTestImage(
        outPath,
        "pdf test image 3.png",
      );
      fixture = fixture
        .replace("LOCAL_IMAGE_PLACEHOLDER", `![local checker](${imgPath})`)
        .replace("SPACED_IMAGE_PLACEHOLDER", `![spaced](${spacedPath})`);
    } catch (e) {
      const note = `本地测试图片生成失败：${String(e)}`;
      fixture = fixture
        .replace("LOCAL_IMAGE_PLACEHOLDER", note)
        .replace("SPACED_IMAGE_PLACEHOLDER", note);
    }
    await fillPrintRoot(fixture);
    await invoke("export_pdf", {
      path: outPath,
      outline: prepareOutlineForExport(),
    });
    await report(true);
  } catch (e) {
    await report(false, typeof e === "string" ? e : String(e));
  }
}
