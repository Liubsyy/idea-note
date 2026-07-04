// Typed wrapper for the sidebar global search command
// (src-tauri/src/search.rs). Kept separate from the AI-tool `search_notes`
// wrapper in fs.ts — the two features evolve independently.

import { Channel, invoke } from "@tauri-apps/api/core";

/** The three input-box toggles, mirrored by the Rust command. */
export interface SearchOptions {
  caseSensitive: boolean;
  wholeWord: boolean;
  regex: boolean;
}

/** One global-search match. Filename hits have `line: null` and carry the
 *  match span within `name`; content hits carry the 1-based line number and a
 *  match-centred snippet with the span inside it. Offsets are Unicode code
 *  points. */
export interface GlobalSearchHit {
  path: string;
  name: string;
  line: number | null;
  snippet: string | null;
  match_start: number;
  match_len: number;
  /** Exact matched substring, for re-locating it in the live editor doc. */
  matched_text: string;
}

export interface GlobalSearchResult {
  hits: GlobalSearchHit[];
  /** Backend searches no longer auto-cap; the UI uses this flag for manual stop. */
  truncated: boolean;
  /** Set when regex mode was on but the pattern failed to compile. */
  regex_error: string | null;
}

/** A streamed search event from `global_search_stream`. `hits` arrives in
 *  small backend batches, `done` is always last for a completed search. */
export type SearchEvent =
  | { kind: "hits"; hits: GlobalSearchHit[] }
  | { kind: "regexError"; message: string }
  | { kind: "done"; truncated: boolean };

/** Streaming workspace search: hits flow to `onEvent` in small batches as the
 *  backend walks the tree, so the sidebar fills in progressively instead of
 *  blocking on the whole scan. The returned promise resolves as soon as the
 *  scan is launched (events keep arriving after); it rejects only if the
 *  command itself fails (e.g. the directory is gone). Starting a new stream
 *  supersedes any still-running one on the backend. */
export function globalSearchStream(
  dir: string,
  query: string,
  opts: SearchOptions,
  onEvent: (event: SearchEvent) => void,
): Promise<void> {
  const channel = new Channel<SearchEvent>();
  channel.onmessage = onEvent;
  return invoke("global_search_stream", {
    dir,
    query,
    caseSensitive: opts.caseSensitive,
    wholeWord: opts.wholeWord,
    regex: opts.regex,
    onEvent: channel,
  });
}

/** Cooperatively stop the currently running sidebar global search. */
export function stopGlobalSearch(): Promise<void> {
  return invoke("stop_global_search");
}
