// Measures what each continuously running decoration costs the GPU process
// and the renderer, using the app's own built stylesheet. Run with:
//   node_modules/.bin/electron apps/desktop/scripts/idle-energy-bench.cjs [css]
// The window is shown inactive (an occluded or hidden window is throttled by
// Chromium and would hide the cost), off to the side of every display, with
// its own throwaway profile and every network request blocked.
const { app, BrowserWindow, session, screen } = require('electron');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const cssPath = process.argv.find((a) => a.endsWith('.css'))
  || (() => { const dir = path.join(__dirname, '..', 'out', 'renderer', 'assets'); return path.join(dir, fs.readdirSync(dir).find((f) => f.endsWith('.css'))); })();
const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'nekko-energy-bench-'));
app.setPath('userData', profile);
app.setPath('sessionData', profile);

const beam = '<div class="relative rounded-2xl" style="width:1000px;height:360px;margin:20px"><span class="composer-beam-ring" aria-hidden><span class="composer-beam-spin"></span></span></div>';
const wallBeam = '<div class="relative" style="width:700px;height:620px;margin:8px;--pane-radius:12px;display:inline-block"><span class="composer-beam-ring wall-window-beam" aria-hidden><span class="composer-beam-spin"></span></span></div>';
const dots = '<div>Working<span class="dots"></span></div>';
const rocket = '<span class="status-rocket inline-grid"><svg width="14" height="14" viewBox="0 0 24 24"><path d="M12 2v14"/><path class="rocket-flame" d="M11 18h2v3h-2z"/><path class="rocket-streak" d="M5 14v4"/></svg></span>';
const pulse = '<div class="command-wall-window" data-wall-needs-you style="display:inline-block;margin:20px"><div class="panel" style="width:700px;height:600px"></div></div>';
const nekko = '<svg class="pixel-nekko" width="48" height="48" viewBox="0 0 16 16"><rect class="pixel-eyes-open" x="4" y="6" width="2" height="2"/><rect class="pixel-eyes-closed" x="4" y="7" width="2" height="1"/></svg>';
const mascot = `<button class="pixel-mascot pixel-idle" style="position:fixed;bottom:8px;left:0">${nekko.replace('pixel-nekko', 'pixel-nekko pixel-quiet')}</button>`;

const scenarios = {
  idle: '',
  'composer beam': beam,
  '3 wall beams': wallBeam.repeat(3),
  '3 working dots': dots.repeat(3),
  '3 status rockets': rocket.repeat(3),
  'needs-you pulse': pulse,
  mascot,
  'busy wall (all)': beam + wallBeam.repeat(3) + dots.repeat(6) + rocket.repeat(3) + mascot,
  'busy wall, unfocused': beam + wallBeam.repeat(3) + dots.repeat(6) + rocket.repeat(3) + mascot,
};
const only = process.env.NEKKO_BENCH_ONLY;
const SECONDS = Number(process.env.NEKKO_BENCH_SECONDS || 6);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function cpuSeconds(type) {
  // cumulativeCPUUsage is CPU seconds since the process started.
  return app.getAppMetrics().filter((m) => m.type === type).reduce((s, m) => s + (m.cpu.cumulativeCPUUsage ?? 0), 0);
}

app.whenReady().then(async () => {
  session.defaultSession.webRequest.onBeforeRequest((d, done) => done({ cancel: !/^(file:|data:|blob:)/.test(d.url) }));
  const left = Math.min(...screen.getAllDisplays().map((d) => d.bounds.x));
  // NEKKO_BENCH_HOLD=<seconds> shows one scenario on screen (inactive) for a recording.
  const hold = Number(process.env.NEKKO_BENCH_HOLD || 0);
  const win = new BrowserWindow({ width: hold ? 1100 : 2200, height: hold ? 460 : 1400, x: hold ? 40 : left - 2300, y: hold ? 80 : 0, show: false, focusable: false, skipTaskbar: true, title: process.env.NEKKO_BENCH_TITLE || 'Nekko energy bench', webPreferences: { sandbox: true, contextIsolation: true, backgroundThrottling: false } });
  const css = fs.readFileSync(cssPath, 'utf8') + (process.env.NEKKO_BENCH_EXTRA ? fs.readFileSync(process.env.NEKKO_BENCH_EXTRA, 'utf8') : '');
  const results = [];
  for (const [name, body] of Object.entries(scenarios)) {
    if (only && !name.includes(only)) continue;
    const html = `<!doctype html><html data-theme="dark"${name.endsWith('unfocused') ? ' data-app-inactive' : ''}><head><style>${css}</style></head><body style="background:#111;color:#ddd">${body}</body></html>`;
    const file = path.join(profile, 'bench.html');
    fs.writeFileSync(file, html);
    await win.loadFile(file);
    win.showInactive();
    await sleep(1500);
    if (hold) { await sleep(hold * 1000); continue; }
    const g0 = cpuSeconds('GPU'), r0 = cpuSeconds('Tab');
    await sleep(SECONDS * 1000);
    const gpu = ((cpuSeconds('GPU') - g0) / SECONDS) * 100;
    const renderer = ((cpuSeconds('Tab') - r0) / SECONDS) * 100;
    results.push({ name, gpu: gpu.toFixed(1), renderer: renderer.toFixed(1) });
    console.log(`${name.padEnd(20)} GPU process ${gpu.toFixed(1).padStart(5)}%   renderer ${renderer.toFixed(1).padStart(5)}%`);
  }
  if (process.env.NEKKO_BENCH_OUT) fs.writeFileSync(process.env.NEKKO_BENCH_OUT, JSON.stringify({ css: path.basename(cssPath), seconds: SECONDS, results }, null, 2));
  fs.rmSync(profile, { recursive: true, force: true });
  app.quit();
});
