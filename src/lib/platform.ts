/** True when running on Windows, where the native title bar is disabled
 *  (`decorations: false`) and the app draws its own window controls. */
export const isWindows = /Win/.test(navigator.platform);

/** True when the webview is backed by macOS WebKit. */
export const isMac = /Mac/.test(navigator.platform);
