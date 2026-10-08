// Synthetic Logs bubble evidence; never connects to the user's host or profile.
// Launched through wall-polish-integration.cjs with NEKKO_SANDBOX=logs-bubble-sandbox.cjs.
const { app, BrowserWindow, session, screen } = require('electron');
const fs = require('node:fs');
const path = require('node:path');
const out = process.env.NEKKO_INTEGRATION_OUT;
if (!out) throw Error('Launch through wall-polish-integration.cjs');
const base = !!process.env.NEKKO_TEST_REVISION;
const dir = path.join(out, base ? 'before-logs' : 'after-logs');
fs.rmSync(dir, { recursive: true, force: true });
fs.mkdirSync(dir, { recursive: true });
app.setPath('userData', path.join(dir, 'profile'));
app.setPath('sessionData', path.join(dir, 'profile'));
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

app.whenReady().then(async () => {
  session.defaultSession.webRequest.onBeforeRequest((request, done) => done({ cancel: !/^(file:|data:|blob:)/.test(request.url) }));
  session.defaultSession.setPermissionRequestHandler((_contents, _permission, done) => done(false));
  const left = Math.min(...screen.getAllDisplays().map(d => d.bounds.x));
  const win = new BrowserWindow({
    width: 1400, height: 900, useContentSize: true, show: false, focusable: false, skipTaskbar: true,
    x: left - 3000, y: -2000, title: 'Synthetic Logs bubble verification',
    webPreferences: { contextIsolation: true, sandbox: true, backgroundThrottling: false },
  });
  const report = { checks: [], errors: [], measures: {} };
  win.on('focus', () => report.errors.push('Fixture took focus'));
  win.webContents.on('console-message', e => { if (e.level === 'error' && !/terminal|xterm|ghostty/i.test(e.message)) report.errors.push('console: ' + e.message); });
  const run = source => win.webContents.executeJavaScript(source, true);
  const check = async (name, source) => { let ok = false; try { ok = !!await run(source); } catch (e) { report.errors.push(name + ': ' + e); } report.checks.push({ name, passed: ok }); };
  const capture = async (name, rect) => { await sleep(300); fs.writeFileSync(path.join(dir, name + '.png'), (await win.capturePage(rect || undefined, { stayHidden: true, stayAwake: false })).toPNG()); };
  const alphaRect = "(()=>{const w=document.querySelector('[data-grid-cell=\"chat:alpha\"]');if(!w)return undefined;const r=w.getBoundingClientRect();return {x:Math.max(0,Math.floor(r.x)-6),y:Math.max(0,Math.floor(r.y)-6),width:Math.ceil(r.width)+12,height:Math.ceil(r.height)+12}})()";
  const clickLogs = "(()=>{const b=document.querySelector('[data-grid-cell=\"chat:alpha\"] [aria-label=\"Open agent logs\"]');if(!b)return false;b.click();return true})()";
  try {
    await win.loadFile(path.join(out, 'index.html'));
    win.showInactive();
    await sleep(1000);
    for (const t of ['dark', 'light']) {
      await run(`integration.reset({})`); await sleep(1200);
      await run(`document.documentElement.dataset.theme='${t === 'light' ? 'light' : 'dark'}'`); await sleep(300);
      await check(`Logs button present on the wall window (${t})`, "!!document.querySelector('[data-grid-cell=\"chat:alpha\"] [aria-label=\"Open agent logs\"]')");
      const viewBefore = await run('integration.state().view');
      await run(clickLogs); await sleep(80);
      await capture(`opening-${t}`, await run(alphaRect));
      await sleep(400);
      report.measures[`view-${t}`] = { before: viewBefore, after: await run('integration.state().view') };
      report.measures[`bubble-${t}`] = await run("(()=>{const w=document.querySelector('[data-grid-cell=\"chat:alpha\"] [data-chat-surface]');const b=document.querySelector('[data-grid-cell=\"chat:alpha\"] [data-agent-logs]');if(!w||!b)return null;const wr=w.getBoundingClientRect(),br=b.getBoundingClientRect();return {rightGap:Math.round(wr.right-br.right),centreOffset:Math.round((br.top+br.bottom)/2-(wr.top+wr.bottom)/2),w:Math.round(br.width),h:Math.round(br.height),terminal:!!b.querySelector('.xterm, canvas, [class*=terminal]')}})()");
      await check(`clicking Logs opens the bubble in this window (${t})`, "!!document.querySelector('[data-grid-cell=\"chat:alpha\"] [data-agent-logs]')");
      await check(`the wall stays on screen (no bounce to the hidden Chat view) (${t})`, "integration.state().view==='command'");
      await check(`bubble anchored middle-right of the window (${t})`, "(()=>{const w=document.querySelector('[data-grid-cell=\"chat:alpha\"] [data-chat-surface]');const b=document.querySelector('[data-grid-cell=\"chat:alpha\"] [data-agent-logs]');if(!w||!b)return false;const wr=w.getBoundingClientRect(),br=b.getBoundingClientRect();return wr.right-br.right>=8&&wr.right-br.right<=16&&Math.abs((br.top+br.bottom)/2-(wr.top+wr.bottom)/2)<=2})()");
      await capture(`open-${t}`, await run(alphaRect));
      await run("document.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true}))"); await sleep(250);
      await check(`Esc closes the bubble (${t})`, "!document.querySelector('[data-agent-logs]')");
    }
    report.success = !report.errors.some(e => /focus/.test(e)) && (base || report.checks.every(c => c.passed));
  } catch (error) {
    report.errors.push(String(error)); report.success = false;
  } finally {
    fs.writeFileSync(path.join(dir, 'status.json'), JSON.stringify(report, null, 2));
    console.log(JSON.stringify({ dir, success: report.success, failed: report.checks.filter(c => !c.passed).map(c => c.name), errors: report.errors.slice(0, 6), measures: report.measures }, null, 2));
    win.destroy(); app.exit(report.success ? 0 : 1);
  }
});
