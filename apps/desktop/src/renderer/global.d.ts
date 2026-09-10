import type { KotrainApi } from '@agent-nekko/shared';

declare global {
  interface Window {
    kotrain: KotrainApi;
    /**
     * The window-chrome bridge, present only in the Electron shell (see
     * `chrome.ts`). Absent in a browser tab and in the Capacitor builds, which
     * have chrome of their own.
     */
    kotrainChrome?: {
      platform: string;
      titleBarHeight: number;
      setTitleBarOverlay: (theme: { color: string; symbolColor: string }) => void;
    };
  }
}

export {};
