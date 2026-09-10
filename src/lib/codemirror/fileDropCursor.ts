import { EditorView, ViewPlugin, type ViewUpdate } from "@codemirror/view";

type DropPoint = { x: number; y: number };

// Tauri's native file drags don't emit DOM dragover events. Keep their preview
// separate from the selection so hovering doesn't reveal markdown source or
// replace the user's current selection.
export const fileDropCursor = ViewPlugin.fromClass(class {
  private point: DropPoint | null = null;
  private cursor: HTMLDivElement | null = null;

  constructor(private view: EditorView) {}

  private measure = {
    read: () => {
      if (!this.point || this.view.state.readOnly || !this.view.dom.isConnected)
        return null;
      const pos = this.view.posAtCoords(this.point);
      const rect = pos == null ? null : this.view.coordsAtPos(pos);
      if (!rect) return null;
      const { scrollDOM, scaleX, scaleY } = this.view;
      const outer = scrollDOM.getBoundingClientRect();
      return {
        left: (rect.left - outer.left) / scaleX + scrollDOM.scrollLeft,
        top: (rect.top - outer.top) / scaleY + scrollDOM.scrollTop,
        height: (rect.bottom - rect.top) / scaleY,
      };
    },
    write: (rect: { left: number; top: number; height: number } | null) => {
      if (!this.point || !rect) {
        this.removeCursor();
        return;
      }
      if (!this.cursor) {
        this.cursor = document.createElement("div");
        this.cursor.className = "cm-fileDropCursor";
        this.cursor.setAttribute("aria-hidden", "true");
        this.view.scrollDOM.appendChild(this.cursor);
        this.view.dom.classList.add("cm-file-drop-active");
      }
      this.cursor.style.left = `${rect.left}px`;
      this.cursor.style.top = `${rect.top}px`;
      this.cursor.style.height = `${rect.height}px`;
    },
  };

  setPoint(point: DropPoint | null) {
    this.point = this.view.state.readOnly ? null : point;
    if (this.point) this.measureCursor();
    else this.removeCursor();
  }

  measureCursor() {
    if (this.point) this.view.requestMeasure(this.measure);
  }

  update(update: ViewUpdate) {
    if (update.state.readOnly) this.setPoint(null);
    else if (this.point && (update.docChanged || update.geometryChanged))
      this.measureCursor();
  }

  private removeCursor() {
    this.cursor?.remove();
    this.cursor = null;
    this.view.dom.classList.remove("cm-file-drop-active");
  }

  destroy() {
    this.setPoint(null);
  }
}, {
  eventObservers: {
    scroll() {
      // A stationary pointer still needs a new insertion position on scroll.
      this.measureCursor();
    },
  },
});

export function setFileDropCursor(view: EditorView, point: DropPoint | null) {
  view.plugin(fileDropCursor)?.setPoint(point);
}
