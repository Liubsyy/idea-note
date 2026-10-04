export type PreviewKind = "svg" | "html" | "json" | "yaml";
export type PreviewMode = "preview" | "source" | "split";
export function filePreviewKind(path: string): PreviewKind | null {
  const ext = path.split(".").pop()?.toLowerCase();
  if (ext === "svg" || ext === "json") return ext;
  if (ext === "html" || ext === "htm") return "html";
  if (ext === "yaml" || ext === "yml") return "yaml";
  return null;
}
