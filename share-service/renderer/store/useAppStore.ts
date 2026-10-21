import { renderRuntime } from '../runtime';
export const useAppStore = {
  getState: () => renderRuntime.app.getState(),
  subscribe: (listener: Parameters<typeof renderRuntime.app.subscribe>[0]) => renderRuntime.app.subscribe(listener),
};
