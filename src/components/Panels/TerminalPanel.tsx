import { useEffect, useRef } from "react";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import "@xterm/xterm/css/xterm.css";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { useAppStore } from "../../store/useAppStore";

/** Read the app's theme tokens so the terminal matches the current theme. */
function themeColors() {
  const css = getComputedStyle(document.documentElement);
  const v = (name: string) => css.getPropertyValue(name).trim();
  return {
    background: v("--bg"),
    foreground: v("--text"),
    cursor: v("--accent"),
    cursorAccent: v("--bg"),
    selectionBackground: v("--selection"),
  };
}

function stripTerminalStyles(data: string) {
  return data.replace(/\x1b\[[0-9;:]*m/g, "");
}

/**
 * One integrated-terminal tab: an xterm.js surface bound to a Rust-side PTY
 * keyed by `id` (term_open/write/resize/close in lib.rs). Stays mounted while
 * inactive (hidden) so scrollback survives tab switches; re-fits when shown.
 */
export function TerminalView({ id, active }: { id: number; active: boolean }) {
  const hostRef = useRef<HTMLDivElement>(null);
  // Keyed by themeId (not just light/dark) so switching between two same-mode
  // themes — or live-editing a custom theme — re-reads the CSS-variable colours.
  const themeId = useAppStore((s) => s.themeId);
  const termRef = useRef<Terminal | null>(null);
  const fitRef = useRef<FitAddon | null>(null);

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;

    const term = new Terminal({
      fontSize: 13,
      // Menlo is noticeably narrower than SF Mono (ui-monospace) on macOS;
      // a slight negative letterSpacing tightens columns further.
      fontFamily:
        'Menlo, "JetBrains Mono", "SF Mono", SFMono-Regular, ui-monospace, Consolas, monospace',
      letterSpacing: -0.5,
      cursorBlink: true,
      theme: themeColors(),
      allowProposedApi: true,
    });
    termRef.current = term;
    const fit = new FitAddon();
    fitRef.current = fit;
    term.loadAddon(fit);
    term.open(host);
    fit.fit();

    const workspacePath = useAppStore.getState().workspacePath;
    invoke("term_open", {
      id,
      cwd: workspacePath,
      cols: term.cols,
      rows: term.rows,
    }).catch((err) => {
      // Surface the failure in the terminal itself — otherwise a shell that
      // can't spawn just leaves a dead black panel.
      term.writeln(`终端启动失败: ${err}`);
    });

    const decoder = new TextDecoder();
    const unlisten = listen<number[]>(`term:data:${id}`, (e) => {
      term.write(stripTerminalStyles(decoder.decode(new Uint8Array(e.payload), { stream: true })));
    });
    const onData = term.onData((d) => void invoke("term_write", { id, data: d }));

    const sync = () => {
      try {
        fit.fit();
        void invoke("term_resize", { id, cols: term.cols, rows: term.rows });
      } catch {
        /* host not measurable yet */
      }
    };
    const ro = new ResizeObserver(sync);
    ro.observe(host);

    return () => {
      ro.disconnect();
      onData.dispose();
      void unlisten.then((f) => f());
      term.dispose();
      termRef.current = null;
      fitRef.current = null;
      void invoke("term_close", { id });
    };
  }, [id]);

  // When this tab becomes active, it just became visible (0→real size), so
  // re-fit and focus.
  useEffect(() => {
    if (!active) return;
    const t = window.setTimeout(() => {
      try {
        fitRef.current?.fit();
        const term = termRef.current;
        if (term) {
          void invoke("term_resize", { id, cols: term.cols, rows: term.rows });
          term.focus();
        }
      } catch {
        /* not measurable */
      }
    }, 0);
    return () => window.clearTimeout(t);
  }, [active, id]);

  // Re-theme live when the active theme changes.
  useEffect(() => {
    if (termRef.current) termRef.current.options.theme = themeColors();
  }, [themeId]);

  return <div ref={hostRef} className={`h-full w-full ${active ? "" : "hidden"}`} />;
}
