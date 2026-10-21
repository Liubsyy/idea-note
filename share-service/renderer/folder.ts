import type { ShareDocument } from './viewer';

export type NoteContent = Pick<ShareDocument, 'markdown' | 'inputs' | 'results'>;
export type FolderEntry =
  | { kind: 'directory'; path: string }
  | { kind: 'markdown'; path: string; content: NoteContent }
  | { kind: 'file'; path: string; asset: string; mime: string; size: number };
export interface FolderDocument {
  format: 2;
  title: string;
  expiresAt: number | null;
  assets: string[];
  appearance: Record<string, string>;
  entries: FolderEntry[];
}
export type ShareSnapshot = ShareDocument | FolderDocument;
export const imageMime = (mime: string) => /^image\/(?:png|jpeg|gif|webp|avif|bmp|svg\+xml)$/.test(mime);
export function textFile(path: string) {
  return /(?:^|\/)(?:[^/]+\.(?:txt|log|json|jsonc|ya?ml|toml|ini|conf|cfg|csv|tsv|xml|html?|css|scss|less|js|jsx|mjs|cjs|ts|tsx|py|rs|go|java|c|h|cpp|hpp|sh|bash|zsh|sql|vue|svelte|tex|svg)|Dockerfile|Makefile|LICENSE|\.env(?:\.[^/]*)?|\.gitignore)$/i.test(path);
}
export function defaultFolderFile(document: FolderDocument): string | undefined {
  const files = document.entries.filter(e => e.kind !== 'directory');
  return (files.find(e => /^readme\.(md|markdown)$/i.test(e.path)) || files.find(e => e.kind === 'markdown') || files[0])?.path;
}
/** Resolve a note's local reference within the logical shared directory. */
export function folderReference(note: string, source: string): { path: string; suffix: string } | null {
  if (/^(?:[a-z][a-z0-9+.-]*:|\/\/|#)/i.test(source)) return null;
  const split = source.search(/[?#]/), raw = split < 0 ? source : source.slice(0, split), suffix = split < 0 ? '' : source.slice(split);
  let decoded: string;
  try { decoded = decodeURIComponent(raw).replace(/\\/g, '/'); } catch { return null; }
  if (decoded.startsWith('/') || /^[a-z]:/i.test(decoded)) return null;
  const parts = note.split('/').slice(0, -1);
  for (const part of decoded.split('/')) {
    if (!part || part === '.') continue;
    if (part === '..') { if (!parts.length) return null; parts.pop(); }
    else parts.push(part);
  }
  return { path: parts.join('/'), suffix };
}
export const folderFileUrl = (shareId: string, path: string, suffix = '') =>
  `/share/${shareId}?file=${encodeURIComponent(path)}${suffix.includes('#') ? suffix.slice(suffix.indexOf('#')) : ''}`;
