import type { CapacitorConfig } from '@capacitor/cli';

const config: CapacitorConfig = {
  appId: 'dev.nekkolabs.agentnekko',
  appName: 'Agent Nekko',
  // The web UI is the same React renderer as desktop/web; `npm run sync-web`
  // copies the built renderer here.
  webDir: 'www',
  backgroundColor: '#0f0f11',
  ios: {
    contentInset: 'always',
    backgroundColor: '#0f0f11',
  },
  android: {
    backgroundColor: '#0f0f11',
  },
  server: {
    androidScheme: 'https',
  },
};

export default config;
