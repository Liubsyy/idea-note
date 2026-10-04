import type { PreviewKind } from "../../lib/filePreview";
import { HtmlEditor } from "./HtmlEditor";
import { StructuredEditor } from "./StructuredEditor";
import { SvgEditor } from "./SvgEditor";

export function FilePreviewEditor({ path, kind }: { path: string; kind: PreviewKind }) {
  if (kind === "svg") return <SvgEditor path={path} />;
  if (kind === "html") return <HtmlEditor path={path} />;
  return <StructuredEditor kind={kind} />;
}
