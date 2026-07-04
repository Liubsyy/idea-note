import { basename } from "../../lib/fs";
import { toDisplaySrc } from "../../lib/imagePath";

/** Read-only viewer for image files opened from the sidebar. */
export function ImageView({ path }: { path: string }) {
  return (
    <div
      className="flex h-full w-full items-center justify-center overflow-auto p-6"
      style={{ background: "var(--bg)" }}
    >
      <img
        src={toDisplaySrc(path)}
        alt={basename(path)}
        className="max-h-full max-w-full object-contain"
        style={{ boxShadow: "0 1px 8px rgba(0,0,0,0.15)" }}
      />
    </div>
  );
}
