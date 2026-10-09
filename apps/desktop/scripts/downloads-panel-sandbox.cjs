// Hidden, non-focusable, network-blocked window that captures the Downloads
// panel fixture. Launch through downloads-panel-integration.cjs.
const { app, BrowserWindow, session } = require('electron');
const fs = require('node:fs');
const path = require('node:path');
const out = process.env.NEKKO_COMPONENT_OUT;
if (!out) throw Error('Launch through downloads-panel-integration.cjs');
const kind = process.env.NEKKO_TEST_REVISION ? 'before' : 'after';
const runDir = path.join(out, kind);
fs.mkdirSync(runDir, { recursive: true });
app.setPath('userData', path.join(runDir, 'profile'));
app.setPath('sessionData', path.join(runDir, 'profile'));
const report = { checks: [], errors: [], captures: [] };
const sleep = ms => new Promise(r => setTimeout(r, ms));
app.whenReady().then(async () => {
  session.defaultSession.webRequest.onBeforeRequest((d, done) => done({ cancel: !/^(file:|data:|blob:)/.test(d.url) }));
  session.defaultSession.setPermissionRequestHandler((_wc, _permission, done) => done(false));
  const win = new BrowserWindow({ width: 1100, height: 560, useContentSize: true, show: false, focusable: false, skipTaskbar: true, x: -10000, y: -10000, title: `Downloads panel ${kind} · isolated`, webPreferences: { nodeIntegration: false, contextIsolation: true, sandbox: true, backgroundThrottling: false } });
  win.on('show', () => { report.errors.push('Verification window became visible'); });
  win.on('focus', () => { report.errors.push('Verification window took OS focus'); });
  win.webContents.on('console-message', e => { if (e.level === 'error') report.errors.push(e.message); });
  const run = code => win.webContents.executeJavaScript(code, true);
  const capture = async name => { await sleep(250); const file = path.join(runDir, name + '.png'); fs.writeFileSync(file, (await win.capturePage(undefined, { stayHidden: true, stayAwake: false })).toPNG()); report.captures.push(file); };
  try {
    await win.loadFile(path.join(out, 'index.html')); await sleep(600);
    if (!await run("document.body.textContent.includes('Qwen3.8 Flash Next')")) throw Error('Fixture did not mount: ' + await run('document.body.textContent.slice(0,300)'));
    if (kind === 'after') {
      const counts = await run("({ groups: document.querySelectorAll('[data-download-group]').length, files: document.querySelectorAll('[data-download-file]').length })");
      if (counts.groups !== 2 || counts.files !== 3) throw Error('Unexpected grouping: ' + JSON.stringify(counts));
      report.checks.push('two downloads; the split vision model lists three titled files');
    }
    for (const theme of ['dark', 'light']) {
      await run(`document.documentElement.dataset.theme='${theme}'`);
      for (const [width, label] of [[1100, 'wide'], [420, 'narrow']]) {
        win.setContentSize(width, label === 'wide' ? 560 : 820);
        await capture(`${theme}-${label}`);
      }
    }
    report.background = { visible: win.isVisible(), focused: win.isFocused() };
    if (win.isVisible() || win.isFocused()) report.errors.push('Background verification visibility/focus invariant failed');
    report.success = !report.errors.length;
  } catch (e) { report.errors.push(String(e)); report.success = false; }
  finally { fs.writeFileSync(path.join(runDir, 'status.json'), JSON.stringify(report, null, 2)); console.log(JSON.stringify({ runDir, ...report }, null, 2)); win.destroy(); app.exit(report.success ? 0 : 1); }
});
