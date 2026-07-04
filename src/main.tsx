import ReactDOM from "react-dom/client";
import { getCurrentWindow } from "@tauri-apps/api/window";
import App from "./App";
import { SettingsWindow } from "./components/SettingsWindow";
import "./styles/globals.css";
import "./styles/print.css";

// The settings UI lives in its own standalone Tauri window (label "settings")
// so it can be dragged off the main window and leave the editor usable. Both
// windows load this same entry; we branch on the window label.
function isSettingsWindow(): boolean {
  try {
    return getCurrentWindow().label === "settings";
  } catch {
    return false;
  }
}

// Note: StrictMode is intentionally omitted — its double-mount in dev would
// rebuild the CodeMirror EditorView twice (it self-cleans, but it's wasteful).
ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  isSettingsWindow() ? <SettingsWindow /> : <App />,
);

// Dev-only automated test hook for the native PDF export pipeline; see
// lib/print/pdfExportTest.ts. Tree-shaken out of production builds.
const pdfTestOut = import.meta.env.DEV && import.meta.env.VITE_PDF_EXPORT_TEST;
if (pdfTestOut && !isSettingsWindow()) {
  setTimeout(() => {
    void import("./lib/print/pdfExportTest").then((m) =>
      m.runPdfExportTest(String(pdfTestOut)),
    );
  }, 4000);
}
