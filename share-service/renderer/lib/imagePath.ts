import { renderRuntime } from "../runtime";
export const toDisplaySrc = (src: string) => renderRuntime.resolveResource(src);
