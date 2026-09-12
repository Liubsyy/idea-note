import { useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import type { FileNode } from "./fs";

// Keep previews across sidebar remounts, bounded independently of project size.
// A refresh clears the cache; mtime changes also get a new key.
const cache = new Map<string, Promise<string | null>>();
export const clearNoteExcerpts = () => cache.clear();

function readExcerpt(node: FileNode): Promise<string | null> {
  const key = `${node.path}\0${node.mtime}`;
  let result = cache.get(key);
  if (!result) {
    result = invoke<string | null>("note_excerpt", { path: node.path });
    cache.set(key, result);
    void result.catch(() => { if (cache.get(key) === result) cache.delete(key); });
    if (cache.size > 512) cache.delete(cache.keys().next().value!);
  }
  return result;
}

/** Read content only when a mounted row approaches the scroll viewport. */
export function useNoteExcerpt(node: FileNode) {
  const ref = useRef<HTMLDivElement>(null);
  const [excerpt, setExcerpt] = useState<string | null>(null);
  useEffect(() => {
    setExcerpt(null);
    const element = ref.current;
    if (!element) return;
    let alive = true;
    const observer = new IntersectionObserver((entries) => {
      if (!entries.some((entry) => entry.isIntersecting)) return;
      observer.disconnect();
      void readExcerpt(node).then((value) => {
        if (alive) setExcerpt(value);
      }).catch(() => {});
    }, { root: element.closest("[data-sidebar-list]"), rootMargin: "160px" });
    observer.observe(element);
    return () => { alive = false; observer.disconnect(); };
  }, [node]);
  return { ref, excerpt };
}
