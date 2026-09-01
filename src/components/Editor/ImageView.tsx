import { basename } from "../../lib/fs";
import { toDisplaySrc } from "../../lib/imagePath";

/** Read-only viewer for image files opened from the sidebar. */
export function ImageView({
  path,
  presentationScale,
}: {
  path: string;
  /** Omitted in the normal editor; supplied by immersive presentation mode. */
  presentationScale?: number;
}) {
  const scale = presentationScale ?? 1;
  const canvasScale = Math.max(1, scale);
  return (
    <div
      data-presentation-scroll={presentationScale === undefined ? undefined : ""}
      className="h-full w-full overflow-auto"
      style={{ background: "var(--bg)" }}
    >
      <div
        className="flex items-center justify-center p-6"
        style={{
          width: `${canvasScale * 100}%`,
          height: `${canvasScale * 100}%`,
          minWidth: "100%",
          minHeight: "100%",
        }}
      >
        <img
          src={toDisplaySrc(path)}
          alt={basename(path)}
          className="object-contain"
          style={{
            maxWidth: `${100 / canvasScale}%`,
            maxHeight: `${100 / canvasScale}%`,
            transform: presentationScale === undefined ? undefined : `scale(${scale})`,
            transformOrigin: "center",
            boxShadow: "0 1px 8px rgba(0,0,0,0.15)",
          }}
        />
      </div>
    </div>
  );
}
