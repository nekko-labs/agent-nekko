import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'fs';
import { createRequire } from 'module';
import { tmpdir } from 'os';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { preservePackagedProfile } from './main/appIdentity.js';

// Guards the launch crash that shipped in v0.4.0. The @agent-nekko/* workspace packages are
// ESM-only (their "exports" map offers just an "import" condition) while main and
// preload build to CJS, so if electron-vite leaves them external the packaged app
// dies immediately with ERR_PACKAGE_PATH_NOT_EXPORTED. They must be bundled in.
// electron-vite 5 externalizes every "dependencies" entry unless told otherwise,
// so this breaks again the moment a new workspace package is added to deps
// without also being excluded in electron.vite.config.ts.

const root = join(dirname(fileURLToPath(import.meta.url)), '..');

const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
const workspaceDeps = Object.keys(pkg.dependencies ?? {}).filter((d) => d.startsWith('@agent-nekko/'));

describe('staged product identity', () => {
  let appData: string;

  beforeEach(() => {
    appData = mkdtempSync(join(tmpdir(), 'agent-nekko-profile-'));
  });

  afterEach(() => {
    rmSync(appData, { recursive: true, force: true });
  });

  function mockApp(isPackaged = true) {
    return {
      isPackaged,
      getPath: vi.fn(() => appData),
      setPath: vi.fn((_name: string, path: string) => {
        if (!existsSync(path) || !statSync(path).isDirectory()) throw new Error('Path must be an existing directory');
      }),
    };
  }

  it('creates only the profile directory before setting paths on a fresh install', () => {
    const app = mockApp();
    const profile = join(appData, 'Agent Nekko');
    expect(existsSync(profile)).toBe(false);
    expect(() => preservePackagedProfile(app)).not.toThrow();
    expect(app.getPath).toHaveBeenCalledExactlyOnceWith('appData');
    expect(app.setPath.mock.calls).toEqual([
      ['userData', profile],
      ['sessionData', profile],
    ]);
    expect(statSync(profile).isDirectory()).toBe(true);
    expect(readdirSync(profile)).toEqual([]);
    expect(existsSync(join(profile, 'agent-nekko'))).toBe(false);
    const main = readFileSync(join(root, 'src/main/index.ts'), 'utf8');
    const pin = main.indexOf('preservePackagedProfile(app);');
    expect(pin).toBeGreaterThan(0);
    expect(pin).toBeLessThan(main.indexOf('const isPrimary = claimSingleInstance();'));
    expect(pin).toBeLessThan(main.indexOf('app.whenReady()'));
    expect(main).toContain("join(app.getPath('userData'), 'agent-nekko')");
  });

  // The appId change makes a renamed build a fresh install, so the profile
  // folder can finally follow the product name. Nobody may lose data over it.
  it('adopts the newest earlier-brand profile on first run, minus throwaway caches', () => {
    const legacy = join(appData, 'Kotrain');
    mkdirSync(join(legacy, 'kotrain'), { recursive: true });
    mkdirSync(join(legacy, 'Local Storage'), { recursive: true });
    mkdirSync(join(legacy, 'GPUCache'), { recursive: true });
    writeFileSync(join(legacy, 'kotrain', 'settings.json'), '{"theme":"dark"}\n');
    writeFileSync(join(legacy, 'Local Storage', 'sentinel'), 'kept');
    writeFileSync(join(legacy, 'GPUCache', 'blob'), 'dropped');
    // An older brand as well: the newest one wins.
    mkdirSync(join(appData, 'Open Paw', 'open-paw'), { recursive: true });
    writeFileSync(join(appData, 'Open Paw', 'open-paw', 'settings.json'), '{"theme":"light"}\n');

    preservePackagedProfile(mockApp());

    const profile = join(appData, 'Agent Nekko');
    expect(readFileSync(join(profile, 'kotrain', 'settings.json'), 'utf8')).toBe('{"theme":"dark"}\n');
    expect(readFileSync(join(profile, 'Local Storage', 'sentinel'), 'utf8')).toBe('kept');
    expect(existsSync(join(profile, 'GPUCache'))).toBe(false);
    // The original is left alone, so a downgrade still finds its data.
    expect(existsSync(join(legacy, 'kotrain', 'settings.json'))).toBe(true);
  });

  it('leaves an existing profile alone rather than re-adopting over it', () => {
    const profile = join(appData, 'Agent Nekko');
    mkdirSync(join(profile, 'agent-nekko'), { recursive: true });
    writeFileSync(join(profile, 'agent-nekko', 'settings.json'), '{"theme":"current"}\n');
    mkdirSync(join(appData, 'Kotrain', 'kotrain'), { recursive: true });
    writeFileSync(join(appData, 'Kotrain', 'kotrain', 'settings.json'), '{"theme":"stale"}\n');

    preservePackagedProfile(mockApp());

    expect(readdirSync(profile)).toEqual(['agent-nekko']);
    expect(readFileSync(join(profile, 'agent-nekko', 'settings.json'), 'utf8')).toBe('{"theme":"current"}\n');
  });

  it('preserves existing browser and host data across repeated initialization', () => {
    const app = mockApp();
    const profile = join(appData, 'Agent Nekko');
    const browserData = join(profile, 'Local Storage');
    const hostData = join(profile, 'agent-nekko');
    mkdirSync(browserData, { recursive: true });
    mkdirSync(hostData, { recursive: true });
    const sentinel = Buffer.from([0, 1, 127, 128, 255]);
    writeFileSync(join(browserData, 'sentinel'), sentinel);
    const settings = '{"theme":"dark","mascotEnabled":true}\n';
    writeFileSync(join(hostData, 'settings.json'), settings);

    preservePackagedProfile(app);
    preservePackagedProfile(app);

    expect(readFileSync(join(browserData, 'sentinel'))).toEqual(sentinel);
    expect(readFileSync(join(hostData, 'settings.json'), 'utf8')).toBe(settings);
    expect(readdirSync(profile).sort()).toEqual(['Local Storage', 'agent-nekko']);
    expect(app.setPath.mock.calls).toEqual([
      ['userData', profile],
      ['sessionData', profile],
      ['userData', profile],
      ['sessionData', profile],
    ]);
  });

  it('leaves development profiles unchanged without creating any directories', () => {
    const app = mockApp(false);
    preservePackagedProfile(app);
    expect(app.getPath).not.toHaveBeenCalled();
    expect(app.setPath).not.toHaveBeenCalled();
    expect(readdirSync(appData)).toEqual([]);
    expect(existsSync(join(appData, 'Agent Nekko'))).toBe(false);
  });

  it('carries the current brand through every packaged identity and filename', () => {
    const builder = readFileSync(join(root, 'electron-builder.yml'), 'utf8');
    expect(builder).toContain('productName: Agent Nekko');
    expect(builder).toContain('appId: dev.nekkolabs.agentnekko');
    expect(builder).toContain('executableName: AgentNekko');
    expect(builder.match(/artifactName: AgentNekko-\$\{version\}-\$\{arch\}\.\$\{ext\}/g)).toHaveLength(3);
    expect(builder).toContain('repo: agent-nekko');
    expect(pkg.name).toBe('@agent-nekko/desktop');
    const mobile = readFileSync(join(root, '../mobile/capacitor.config.ts'), 'utf8');
    expect(mobile).toContain("appName: 'Agent Nekko'");
    expect(mobile).toContain("appId: 'dev.nekkolabs.agentnekko'");
    const manifest = JSON.parse(readFileSync(join(root, 'src/renderer/public/manifest.webmanifest'), 'utf8'));
    expect(manifest.name).toBe('Agent Nekko');
    expect(manifest.short_name).toBe('Agent Nekko');
    expect(manifest.start_url).toBe('./');
    expect(manifest.scope).toBe('./');
  });
});

describe('bundled main/preload externals', () => {
  it('has workspace packages to check', () => {
    expect(workspaceDeps.length).toBeGreaterThan(0);
  });

  for (const bundle of ['out/main/index.js', 'out/preload/index.js']) {
    it(`${bundle} does not require a workspace package at runtime`, () => {
      // CI builds every workspace (npm run build:web) before npm test.
      const src = readFileSync(join(root, bundle), 'utf8');
      const leaked = workspaceDeps.filter((dep) =>
        new RegExp(`require\\(\\s*["'\`]${dep}(/|["'\`])`).test(src),
      );
      expect(leaked).toEqual([]);
    });
  }

  for (const dep of workspaceDeps) {
    it(`${dep} is excluded from externalizeDeps in main and preload`, async () => {
      const config: any = (await import('../electron.vite.config.js')).default;
      expect(config.main.build.externalizeDeps.exclude).toContain(dep);
      expect(config.preload.build.externalizeDeps.exclude).toContain(dep);
    });
  }
});

// The other half of the launch fix: v0.4.0 shipped react 18 and react 19
// side by side in one renderer bundle (zustand is hoisted to the monorepo root
// and its `react` peer resolved to the root react 18), which left the hook
// dispatcher null and rendered a blank white window. React tags its internals
// with a version-specific key, so a second copy is easy to spot.
const REACT_INTERNALS_KEYS = [
  '__CLIENT_INTERNALS_DO_NOT_USE_OR_WARN_USERS_THEY_CANNOT_UPGRADE', // react 19
  '__SECRET_INTERNALS_DO_NOT_USE_OR_YOU_WILL_BE_FIRED', // react 18 and older
];

describe('bundled renderer React', () => {
  const assetsDir = join(root, 'out/renderer/assets');

  it('bundles exactly one copy of React', () => {
    const found = new Set<string>();
    for (const file of readdirSync(assetsDir).filter((f) => f.endsWith('.js'))) {
      const src = readFileSync(join(assetsDir, file), 'utf8');
      for (const key of REACT_INTERNALS_KEYS) if (src.includes(key)) found.add(key);
    }
    expect([...found]).toHaveLength(1);
  });

  it('bundles only the React version this app depends on', () => {
    // Resolve rather than hardcode a path: npm may hoist react to the repo root.
    const reactPkg = createRequire(join(root, 'package.json')).resolve('react/package.json');
    const expected = JSON.parse(readFileSync(reactPkg, 'utf8')).version;
    const versions = new Set<string>();
    for (const file of readdirSync(assetsDir).filter((f) => f.endsWith('.js'))) {
      const src = readFileSync(join(assetsDir, file), 'utf8');
      for (const m of src.matchAll(/"(\d+\.\d+\.\d+)"/g)) {
        if (/^(18|19|20)\./.test(m[1])) versions.add(m[1]);
      }
    }
    expect([...versions]).toEqual([expected]);
  });
});
