export interface SidebarDropTarget {
  dir: string;
  element: HTMLElement;
}

/** Only the file/notes list accepts copies, including its empty area. */
export function sidebarDropTarget(el: Element | null): SidebarDropTarget | null {
  const list = el?.closest<HTMLElement>("[data-sidebar-drop-root]");
  const root = list?.getAttribute("data-sidebar-drop-root");
  if (!list || !root) return null;
  const row = el?.closest<HTMLElement>("[data-tree-dir], [data-tree-parent]");
  const dir = row?.getAttribute("data-tree-dir") || row?.getAttribute("data-tree-parent") || root;
  // Highlight the destination folder even when the pointer is over a file.
  const folder = Array.from(list.querySelectorAll<HTMLElement>("[data-tree-dir]"))
    .find((item) => item.getAttribute("data-tree-dir") === dir);
  return { dir, element: dir === root ? list : folder ?? row ?? list };
}

/** Native OS drags do not emit DOM mouse events; position the copy badge from
 *  Tauri's drag coordinates instead. All decoration stays out of hit testing. */
export function createSidebarDropFeedback() {
  let highlighted: HTMLElement | null = null;
  let badge: HTMLDivElement | null = null;
  const clear = () => {
    highlighted?.removeAttribute("data-native-drop-target");
    highlighted = null;
    badge?.remove();
    badge = null;
  };
  return {
    clear,
    show(target: SidebarDropTarget, point: { x: number; y: number }, count: number) {
      if (highlighted !== target.element) {
        highlighted?.removeAttribute("data-native-drop-target");
        highlighted = target.element;
        highlighted.setAttribute("data-native-drop-target", "true");
      }
      if (!badge) {
        badge = document.createElement("div");
        badge.className = "sidebar-copy-badge";
        document.body.appendChild(badge);
      }
      const name = target.dir.split(/[\\/]/).filter(Boolean).pop() || target.dir;
      badge.textContent = `松开以拷贝${count > 1 ? ` ${count} 个项目` : ""}到「${name}」`;
      badge.style.left = `${Math.max(8, Math.min(point.x + 18, window.innerWidth - badge.offsetWidth - 8))}px`;
      badge.style.top = `${Math.max(8, Math.min(point.y + 20, window.innerHeight - badge.offsetHeight - 8))}px`;
    },
  };
}
