import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

// Unit tests cover the pure TypeScript under src/lib (protocol, crypto,
// transcript, catalog). Screens are verified in the running app instead.
export default defineConfig({
  resolve: {
    alias: {
      '@/': fileURLToPath(new URL('./src/', import.meta.url)),
    },
  },
  test: {
    include: ['src/**/*.test.ts', 'src/**/*.itest.ts'],
    environment: 'node',
  },
});
