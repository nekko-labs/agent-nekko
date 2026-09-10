import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

const root = new URL('../', import.meta.url);
const read = (path) => readFileSync(new URL(path, root), 'utf8');
const config = JSON.parse(read('vercel.json'));
const matchesHost = (rule, host) => rule.has?.some(
  (condition) => condition.type === 'host' && new RegExp(`^(?:${condition.value})$`).test(host),
);
const redirectFor = (host) => config.redirects.find((rule) => matchesHost(rule, host));

test('brand redirect host patterns are explicitly anchored', () => {
  for (const rule of config.redirects) {
    for (const condition of rule.has ?? []) {
      if (condition.type === 'host') {
        assert.ok(condition.value.startsWith('^'), condition.value);
        assert.ok(condition.value.endsWith('$'), condition.value);
      }
    }
  }
});

test('every alternate and earlier-brand domain permanently redirects to the primary with a path capture', () => {
  const hosts = [
    'www.agentnekko.com', 'nekkoagent.com', 'www.nekkoagent.com',
    'kotrain.com', 'www.kotrain.com', 'kotrain.app', 'www.kotrain.app',
    'nekkos.app', 'www.nekkos.app', 'nekkos.dev', 'www.nekkos.dev',
  ];
  for (const host of hosts) {
    const rule = redirectFor(host);
    assert.equal(rule?.source, '/:path*', host);
    assert.equal(rule?.destination, 'https://agentnekko.com/:path*', host);
    assert.equal(rule?.permanent, true, host);
  }
});

test('the canonical host and unrelated/preview hosts never enter a brand redirect', () => {
  const hosts = [
    'agentnekko.com', 'localhost', 'preview.vercel.app',
    'nekkoagent.com.example.com', 'notnekkoagent.com',
    // The earlier brands are matched exactly, not as a suffix.
    'kotrain.com.example.com', 'notkotrain.com',
  ];
  for (const host of hosts) {
    assert.equal(redirectFor(host), undefined, host);
  }
});

test('every published and packaged identity carries the current brand', () => {
  assert.equal(JSON.parse(read('package.json')).name, 'agent-nekko-workspace');
  assert.equal(JSON.parse(read('apps/cli/package.json')).name, 'agent-nekko');
  const builder = read('apps/desktop/electron-builder.yml');
  assert.match(builder, /appId: dev\.nekkolabs\.agentnekko/);
  assert.match(builder, /productName: Agent Nekko/);
  assert.match(builder, /repo: agent-nekko/);
  // The binary and the download filenames must agree, and neither may carry a
  // previous brand: these are the names a user actually sees.
  assert.match(builder, /executableName: AgentNekko/);
  assert.equal(builder.match(/artifactName: AgentNekko-\$\{version\}-\$\{arch\}\.\$\{ext\}/g)?.length, 3);
  // No earlier brand may appear in an identity or filename setting. The
  // `protocols:` block is exempt on purpose: it lists the older URL schemes
  // that older Hypergate builds still emit.
  const identityLines = builder
    .split('\n')
    .filter((line) => /^(appId|productName|executableName|copyright)|artifactName|uninstallDisplayName/.test(line.trim()));
  assert.ok(identityLines.length >= 6, String(identityLines.length));
  for (const line of identityLines) assert.doesNotMatch(line, /kotrain|nekkos|open-?paw/i);
  assert.match(read('apps/mobile/capacitor.config.ts'), /appId: 'dev\.nekkolabs\.agentnekko'/);
});

test('the CLI keeps every earlier brand as a bin alias', () => {
  const bin = JSON.parse(read('apps/cli/package.json')).bin;
  assert.deepEqual(Object.keys(bin), ['agent-nekko', 'kotrain', 'nekkos']);
  for (const target of Object.values(bin)) assert.equal(target, 'dist/index.js');
});

// Every rename so far has kept older configs and data working. These pin the
// fallback chains, because a blanket sweep is exactly what would delete them.
test('env lookups read the current brand first and then every older one', () => {
  const source = read('packages/shared/src/brand-env.ts');
  assert.match(source, /ENV_PREFIXES = \['NEKKO_', 'KOTRAIN_', 'NEKKOS_', 'OPENPAW_'\]/);
  // Referencing `process` directly would break the renderer, which is typed
  // without node.
  assert.doesNotMatch(source.replace(/\/\*[\s\S]*?\*\/|^\s*\/\/.*$/gm, ''), /(?<!\.)\bprocess\.env\b/);
});

test('data dirs prefer the current brand but keep using an existing older one', () => {
  for (const path of ['apps/cli/src/lib.ts', 'apps/server/src/index.ts']) {
    const source = read(path);
    assert.match(source, /join\(homedir\(\), '\.nekko'\)/, path);
    assert.match(source, /\['\.kotrain', '\.nekkos', '\.open-paw'\]/, path);
  }
  // The desktop app copies an earlier brand's userData dir on first run.
  const main = read('apps/desktop/src/main/index.ts');
  assert.match(main, /join\(app\.getPath\('userData'\), 'agent-nekko'\)/);
  for (const legacy of ['kotrain', 'Kotrain', 'Nekkos', 'Open Paw']) {
    assert.ok(main.includes(`'${legacy}'`), legacy);
  }
});

test('deep links and install targets still accept the schemes and values older builds emit', () => {
  assert.match(read('apps/desktop/src/renderer/deepLinks.ts'), /LINK_SCHEMES = \['agent-nekko', 'kotrain', 'nekkos'\]/);
  assert.match(read('apps/desktop/src/main/index.ts'), /PROTOCOLS = \['agent-nekko', 'kotrain', 'nekkos'\]/);
  // macOS resolves schemes from Info.plist, so they must be declared for the
  // packaged build too, not just registered at runtime.
  const builder = read('apps/desktop/electron-builder.yml');
  for (const scheme of ['agent-nekko', 'kotrain', 'nekkos']) {
    assert.ok(new RegExp(`^\\s+- ${scheme}$`, 'm').test(builder), scheme);
  }
  const market = read('packages/shared/src/skills-market.ts');
  assert.match(market, /InstallTarget = 'agent-nekko' \| 'claude' \| 'codex'/);
  for (const legacy of ['kotrain', 'nekkos', "'open-paw'"]) assert.ok(market.includes(legacy), legacy);
  // A methodology saved under an older brand must not fall through to the
  // default, which would silently drop its plan document.
  assert.match(read('packages/shared/src/spec.ts'), /LEGACY_METHODOLOGY_IDS[^\n]*kotrain: 'agent-nekko'/);
});

test('the assistant uses the Nekko identity and retains grounded execution guidance', () => {
  const prompt = read('packages/core/src/agent/prompt.ts');
  assert.match(prompt, /You are Nekko, the assistant inside Agent Nekko/);
  assert.match(prompt, /Use tools to ground your answers/);
  assert.match(prompt, /destructive commands/);
  assert.match(prompt, /End every turn with an honest wrap-up/);
});

test('packaged icon sources use the canonical MiniNekko head and current palette', () => {
  const source = read('apps/desktop/scripts/icon-art.cjs');
  const implementation = source.replace(/\/\*[\s\S]*?\*\/|^\s*\/\/.*$/gm, '');
  assert.doesNotMatch(implementation, /#(?:6d5efc|22d3ee|8b7dff|4c46c8|221f45|121222|090911|a9f3ff|e6fbff|7de6ff|101020|141428|0c0c16|07070d)\b/i);
  assert.doesNotMatch(implementation, /onOrbit|function trail|id="(?:space|nebula|nebula2|bloom|core)"/);
  for (const token of ['#101714', '#f2f1e9', '#a7c8ac', '#f0a35e', 'data-part="inner-ears"', 'data-mascot-accessory="sunglasses"', 'data-mascot-accessory="earpiece"', 'data-part="mouth"']) {
    assert.match(source, new RegExp(token.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i'));
  }
  assert.match(source, /AI on your computer/);
  assert.doesNotMatch(implementation, /Local-first AI coding/);

  const installerSource = read('apps/desktop/scripts/gen-installer-art.mjs').replace(/\/\*[\s\S]*?\*\/|^\s*\/\/.*$/gm, '');
  assert.match(installerSource, /rgbaToInt\(16, 23, 20, 255\)/);
  assert.match(installerSource, /rgbaToInt\(167, 200, 172, 255\)/);
  assert.match(installerSource, /AI on your computer/);
  assert.doesNotMatch(installerSource, /Local-first AI|coding & cowork/);
});

test('generated vector icons contain cat accessories without old orbit art', () => {
  for (const path of ['apps/desktop/build/icon.svg', 'apps/desktop/src/renderer/public/icon.svg']) {
    const svg = read(path);
    assert.match(svg, /<svg[^>]+viewBox="0 0 512 512"/);
    assert.match(svg, /fill="#101714"/i);
    assert.match(svg, /stroke="#f2f1e9"/i);
    assert.match(svg, /stroke="#a7c8ac"/i);
    assert.match(svg, /stroke="#f0a35e"/i);
    assert.match(svg, /data-mascot-accessory="sunglasses"/);
    assert.match(svg, /data-mascot-accessory="earpiece"/);
    assert.match(svg, /data-part="mouth"/);
    assert.doesNotMatch(svg, /#(?:6d5efc|22d3ee|8b7dff|4c46c8|221f45|121222|090911|a9f3ff|e6fbff|7de6ff|101020)\b/i);
    assert.doesNotMatch(svg, /id="(?:space|nebula|nebula2|bloom|core)"/);
  }
});

test('generated raster icons and installer art retain dimensions and exclude old accent pixels', async () => {
  const { Jimp } = await import('jimp');
  const binary = (path) => readFileSync(new URL(path, root));
  const expected = new Map([
    ['apps/desktop/build/icon.png', [512, 512]],
    ['apps/desktop/src/renderer/public/icon-512.png', [512, 512]],
    ['apps/desktop/build/installerHeader.bmp', [150, 57]],
    ['apps/desktop/build/installerSidebar.bmp', [164, 314]],
  ]);
  const forbidden = new Set(['109,94,252', '34,211,238', '139,125,255']);
  const current = new Set(['16,23,20', '242,241,233', '167,200,172', '240,163,94']);
  for (const [path, [width, height]] of expected) {
    const image = await Jimp.read(binary(path));
    const seen = new Set();
    assert.deepEqual([image.bitmap.width, image.bitmap.height], [width, height], path);
    for (let i = 0; i < image.bitmap.data.length; i += 4) {
      const pixel = `${image.bitmap.data[i]},${image.bitmap.data[i + 1]},${image.bitmap.data[i + 2]}`;
      assert.equal(forbidden.has(pixel), false, `${path}: ${pixel}`);
      if (current.has(pixel)) seen.add(pixel);
    }
    assert.equal(seen.has('16,23,20'), true, path);
    if (path.endsWith('.png')) {
      assert.equal(seen.has('242,241,233'), true, path);
    } else {
      assert.equal(seen.has('167,200,172'), true, path);
    }
  }

  const ico = binary('apps/desktop/build/icon.ico');
  const count = ico.readUInt16LE(4);
  const sizes = [];
  for (let i = 0; i < count; i++) {
    const offset = 6 + i * 16;
    const size = ico[offset] || 256;
    const length = ico.readUInt32LE(offset + 8);
    const dataOffset = ico.readUInt32LE(offset + 12);
    const image = await Jimp.read(ico.subarray(dataOffset, dataOffset + length));
    assert.deepEqual([image.bitmap.width, image.bitmap.height], [size, size]);
    sizes.push(size);
  }
  assert.deepEqual(sizes, [16, 24, 32, 48, 64, 128, 256]);
});
