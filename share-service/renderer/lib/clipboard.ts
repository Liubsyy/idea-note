import { renderRuntime } from "../runtime";
export const copyText = (text: string) => renderRuntime.copyText(text);
export const readClipboardText = () => renderRuntime.readClipboardText();
