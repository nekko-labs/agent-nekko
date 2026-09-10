import { resolve } from 'path';
import { defineConfig } from 'electron-vite';
import react from '@vitejs/plugin-react';

// Our own workspace packages must be bundled into the main and preload output,
// never left as runtime requires. They are ESM-only (`"type": "module"` with an
// `exports` map whose only condition is `import`), while main and preload build
// to CJS, so a runtime `require('@agent-nekko/shared')` fails to resolve and Electron
// dies on launch with ERR_PACKAGE_PATH_NOT_EXPORTED. electron-vite 5 externalizes
// every `dependencies` entry by default (`build.externalizeDeps` defaults to
// true, which electron-vite 2 did not do), so each one has to be excluded here.
const workspacePackages = ['@agent-nekko/core', '@agent-nekko/host', '@agent-nekko/shared'];

export default defineConfig({
  main: {
    build: {
      externalizeDeps: { exclude: workspacePackages },
      rollupOptions: {
        // electron-updater is CJS with node-only internals, and @lydell/node-pty
        // ships a native .node binary, require both at runtime from node_modules
        // (electron-builder packs production deps + auto-unpacks .node from asar)
        // instead of bundling them.
        external: ['electron-updater', '@lydell/node-pty'],
        input: { index: resolve(__dirname, 'src/main/index.ts') },
      },
    },
  },
  preload: {
    build: {
      externalizeDeps: { exclude: workspacePackages },
      rollupOptions: {
        input: { index: resolve(__dirname, 'src/preload/index.ts') },
      },
    },
  },
  renderer: {
    root: resolve(__dirname, 'src/renderer'),
    // The renderer must bundle exactly one copy of React. zustand is hoisted to
    // the monorepo root, so its `react` peer resolves to the react 18 npm keeps
    // there, while this app renders with its own react 19 - two React instances
    // in one bundle, which leaves the hook dispatcher null and blanks the window
    // with "Cannot read properties of null (reading 'useCallback')". Deduping
    // resolves every `react` import to this app's copy. See bundleExternals.test.ts.
    resolve: { dedupe: ['react', 'react-dom'] },
    build: {
      rollupOptions: {
        input: { index: resolve(__dirname, 'src/renderer/index.html') },
      },
    },
    plugins: [react()],
  },
});
