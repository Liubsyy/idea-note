import type { EditorView } from '@codemirror/view';
import type { CodeRunConfig } from './lib/codeRun/runners';
export interface RenderAppState {
  activeFilePath: string | null;
  codeRunConfig: CodeRunConfig;
  runPanelOpen: boolean;
  toggleRunPanel(): void;
  showToast(message: string, kind?: 'success' | 'error' | 'info'): void;
}
export interface RenderRuntime {
  /** The document was written by someone else (a published share), so HTML
   *  loses page-wide `<style>` and form controls; see sanitizeHtml. */
  untrustedContent: boolean;
  isDark(): boolean;
  resolveResource(src: string): string;
  openLink(url: string): void;
  copyText(text: string): Promise<void>;
  readClipboardText(): Promise<string>;
  openImagePrompt(view: EditorView): boolean;
  openResourcePrompt(view: EditorView, url: string, label: string): void;
  runBlock(view: EditorView, info: string, code: string): Promise<void>;
  app: { getState(): RenderAppState; subscribe(listener: (state: RenderAppState, previous: RenderAppState) => void): () => void };
}
const inactive: RenderAppState = { activeFilePath: '', codeRunConfig: { enabled: false, confirmEveryRun: true, fontSize: 13, maxOutputKb: 200, runners: [] }, runPanelOpen: false, toggleRunPanel() {}, showToast() {} };
export const renderRuntime: RenderRuntime = {
  untrustedContent: false,
  isDark: () => typeof document !== "undefined" && document.documentElement.classList.contains("dark"),
  resolveResource: src => /^(?:https?:|data:image\/|blob:|\/api\/v1\/public\/)/i.test(src) ? src : '',
  openLink: url => { if (/^(https?:|mailto:|\/api\/v1\/public\/)/i.test(url)) window.open(url, '_blank', 'noopener,noreferrer'); },
  copyText: text => navigator.clipboard.writeText(text), readClipboardText: () => navigator.clipboard.readText(),
  openImagePrompt: () => false, openResourcePrompt() {}, runBlock: async () => { throw new Error('Code execution is unavailable'); },
  app: { getState: () => inactive, subscribe: () => () => {} },
};
export function configureRenderRuntime(runtime: Partial<RenderRuntime>) { Object.assign(renderRuntime, runtime); }
