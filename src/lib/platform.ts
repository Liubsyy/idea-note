/** True when running on Windows, where the native title bar is disabled
 *  (`decorations: false`) and the app draws its own window controls. */
export const isWindows = /Win/.test(navigator.platform);
