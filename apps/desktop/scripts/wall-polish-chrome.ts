// Imported first by wall-polish-fixture so chrome.ts sees a desktop title bar.
// Synthetic and inert: no service control or native overlay is reachable.
Object.assign(window, {
  nekkoChrome: { platform: 'win32', titleBarHeight: 38, serviceControl: async () => ({ state: 'stopped' }), setTitleBarOverlay: () => {} },
});
