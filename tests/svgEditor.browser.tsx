// Run with `npm run dev`, then open /tests/svgEditor.browser.html.
// Real browser XML parsing, image decoding, React and CodeMirror; only IPC is mocked.
import React from "react";
import { createRoot } from "react-dom/client";
import { mockIPC, mockWindows } from "@tauri-apps/api/mocks";
import { undo, redo } from "@codemirror/commands";
import "../src/styles/globals.css";

const original = '<svg xmlns="http://www.w3.org/2000/svg" width="360" height="220"><rect width="360" height="220" fill="#6579bd"/><text x="180" y="120" text-anchor="middle" font-size="24" fill="white">SVG 实时预览</text></svg>';
const disk = new Map([["/test/one.svg", original], ["/test/two.SVG", original.replace("6579bd", "42846b")]]);
let revision = 1;
let writes = 0;
let rasterReads = 0;
mockWindows("main");
mockIPC((cmd, args) => {
  if (cmd === "read_file") {
    if (String(args?.path).endsWith(".png")) rasterReads++;
    return disk.get(String(args?.path));
  }
  if (cmd === "write_file") {
    disk.set(String(args?.path), String(args?.content));
    revision++;
    writes++;
    return;
  }
  if (cmd === "file_stat") return [revision, disk.get(String(args?.path))?.length ?? 0];
  if (cmd === "sync_config_load") return "{}";
  if (cmd === "git_proxy_load") return "";
  return null;
}, { shouldMockEvents: true });

const result = document.getElementById("test-result")!;
const host = document.getElementById("test-editor")!;
const root = createRoot(host);
const passed: string[] = [];
const pause = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
function check(ok: unknown, message: string): asserts ok {
  if (!ok) throw new Error(message);
}
async function until(check: () => unknown, label: string) {
  for (let i = 0; i < 100; i++) {
    if (check()) return;
    await pause(30);
  }
  throw new Error(`Timed out: ${label}`);
}

try {
  const { useAppStore } = await import("../src/store/useAppStore");
  const { getActiveView } = await import("../src/lib/codemirror/activeView");
  const { SvgEditor } = await import("../src/components/Editor/SvgEditor");
  const { svgValidationError } = await import("../src/lib/svgPreview");
  useAppStore.setState({ workspacePath: null, refreshTree: async () => {}, editorLineNumbers: true });
  function Fixture() {
    const path = useAppStore(s => s.activeFilePath);
    const docKey = useAppStore(s => s.docKey);
    return path ? <SvgEditor key={docKey} path={path} /> : null;
  }
  const click = (label: string) => {
    const button = [...host.querySelectorAll("button")].find(el => el.textContent === label);
    check(button, `Missing button ${label}`);
    button.click();
  };
  const image = () => host.querySelector<HTMLImageElement>(".svg-editor-preview img");
  const imageReady = () => !!image()?.complete && (image()?.naturalWidth ?? 0) > 0;
  const replace = (text: string) => {
    const view = getActiveView();
    check(view, "source editor must be active");
    view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: text } });
    return view;
  };
  check(svgValidationError(original) === null, "valid SVG parses");
  check(svgValidationError("<svg><g></svg>") !== null, "malformed XML rejected");
  check(svgValidationError("<html/>") !== null, "non-SVG XML rejected");
  check(svgValidationError('<svg xmlns="urn:wrong"/>') !== null, "wrong namespace rejected");
  passed.push("XML validation");

  await useAppStore.getState().openFile("/test/one.svg");
  root.render(<Fixture />);
  await until(imageReady, "initial image");
  check(host.querySelector('[aria-pressed="true"]')?.textContent === "图片", "default image mode");
  check(!getActiveView(), "hidden editor excluded from global commands");
  check(useAppStore.getState().content === original && !useAppStore.getState().isDirty, "SVG loaded as clean text");
  passed.push("default image + text loading");

  click("分屏");
  await until(() => getActiveView(), "split editor");
  const view = getActiveView()!;
  const firstUrl = image()!.src;
  const updated = original.replace("6579bd", "bd6579");
  replace(updated);
  await pause(100);
  check(image()!.src === firstUrl, "preview updates are debounced");
  await until(() => image()!.src !== firstUrl && imageReady(), "live image update");
  check(useAppStore.getState().isDirty, "edit marks buffer dirty");
  passed.push("split live rendering + debounce");

  click("图片");
  await until(() => !getActiveView(), "image-only mode");
  click("源码");
  await until(() => getActiveView(), "source-only mode");
  check(getActiveView() === view, "same editor survives switches");
  check(undo(view), "undo available after switching");
  check(useAppStore.getState().content === original && !useAppStore.getState().isDirty, "undo restores clean original");
  check(redo(view), "redo available");
  await useAppStore.getState().save();
  check(disk.get("/test/one.svg") === updated && !useAppStore.getState().isDirty, "save writes current SVG");
  passed.push("mode switches preserve undo/redo + save");

  click("分屏");
  await until(() => !host.textContent?.includes("更新中"), "preview settled");
  const validUrl = image()!.src;
  replace("<svg><g></svg>");
  await until(() => host.querySelector('[role="alert"]'), "syntax error");
  check(image()!.src === validUrl && imageReady(), "invalid edit preserves last valid image");
  replace(updated.replace("bd6579", "42846b"));
  await until(() => !host.querySelector('[role="alert"]') && image()!.src !== validUrl, "error recovery");
  passed.push("invalid source fallback + automatic recovery");

  // Switching files flushes edits through the existing save mechanism.
  const unsaved = useAppStore.getState().content;
  await useAppStore.getState().openFile("/test/two.SVG");
  await until(() => host.querySelector('[aria-pressed="true"]')?.textContent === "图片" && imageReady(), "second SVG");
  check(disk.get("/test/one.svg") === unsaved, "file switch saves prior edits");
  const secondUrl = image()!.src;
  disk.set("/test/two.SVG", original.replace("6579bd", "d4984f"));
  revision++;
  await useAppStore.getState().checkExternalChange();
  await until(() => image()?.src !== secondUrl && imageReady(), "external reload");
  check(useAppStore.getState().content === disk.get("/test/two.SVG"), "external SVG changes reload");
  passed.push("file switching + external reload");

  root.unmount();
  await pause(0);
  await useAppStore.getState().openFile("/test/photo.png");
  check(rasterReads === 0 && useAppStore.getState().content === "", "raster remains binary image");
  check(writes === 2, "preview itself never writes files");
  passed.push("raster compatibility + preview does not save");
  result.textContent = `PASS (${passed.length} groups): ${passed.join("; ")}`;
  document.title = "PASS — SVG editor regression";
  // Leave a working split view available for manual inspection.
  await useAppStore.getState().openFile("/test/one.svg");
  createRoot(host).render(<Fixture />);
  await until(() => host.querySelector("button"), "manual preview");
  click("分屏");
} catch (error) {
  result.textContent = `FAIL after ${passed.join("; ")}: ${String(error)}`;
  document.title = "FAIL — SVG editor regression";
  console.error(error);
}
