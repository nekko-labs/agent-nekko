// Synthetic Done-row evidence; never connects to the user's host or profile.
// Launched through wall-polish-integration.cjs with NEKKO_SANDBOX=done-row-sandbox.cjs.
const { app, BrowserWindow, session, screen } = require('electron');
const fs = require('node:fs');
const path = require('node:path');
const out = process.env.NEKKO_INTEGRATION_OUT;
if (!out) throw Error('Launch through wall-polish-integration.cjs');
const base = !!process.env.NEKKO_TEST_REVISION;
const dir = path.join(out, base ? 'before-done' : 'after-done');
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
    x: left - 3000, y: -2000, title: 'Synthetic Done row verification',
    webPreferences: { contextIsolation: true, sandbox: true, backgroundThrottling: false },
  });
  const report = { checks: [], errors: [], measures: {} };
  win.on('focus', () => report.errors.push('Fixture took focus'));
  win.webContents.on('console-message', e => { if (e.level === 'error') report.errors.push('console: ' + e.message); });
  const run = source => win.webContents.executeJavaScript(source, true);
  const check = async (name, source) => { let ok = false; try { ok = !!await run(source); } catch (e) { report.errors.push(name + ': ' + e); } report.checks.push({ name, passed: ok }); };
  const rowRect = "(()=>{const s=document.querySelector('[data-grid-cell=\"chat:alpha\"] [data-turn-stats]');if(!s)return undefined;const m=s.closest('.msg-ai')||s.parentElement;const r=m.getBoundingClientRect();const t=s.getBoundingClientRect();return {x:Math.max(0,Math.floor(r.x)-12),y:Math.max(0,Math.floor(r.y)-8),width:Math.ceil(r.width)+24,height:Math.ceil(t.bottom-r.y)+16}})()";
  const capture = async (name, rect) => { await sleep(300); fs.writeFileSync(path.join(dir, name + '.png'), (await win.capturePage(rect || undefined, { stayHidden: true, stayAwake: false })).toPNG()); };
  // done text, stats box, and whether they share a line.
  const measure = "(()=>{const s=document.querySelector('[data-grid-cell=\"chat:alpha\"] [data-turn-stats]');const row=s&&s.closest('[data-done-row]');const d=row&&[...row.children].find(c=>/Done\\./.test(c.textContent));if(!s)return null;const sr=s.getBoundingClientRect(),dr=d?d.getBoundingClientRect():null,rr=(row||s.parentElement).getBoundingClientRect();return {sameLine:!!dr&&Math.abs(sr.top-dr.top)<4,gap:dr?Math.round(sr.left-dr.right):null,rightAligned:Math.round(rr.right-sr.right),statsRight:Math.round(sr.right),rowRight:Math.round(rr.right),statsTop:Math.round(sr.top),doneBottom:dr?Math.round(dr.bottom):null}})()";
  try {
    await win.loadFile(path.join(out, 'index.html'));
    win.showInactive();
    await sleep(1000);
    for (const t of ['dark', 'light']) {
      // Wide: Focus mode gives the chat window the whole wall.
      win.setContentSize(1400, 900);
      await run(`integration.reset({focus:true})`); await sleep(1200);
      await run("document.getElementById('squeeze')?.remove()");
      await run(`document.documentElement.dataset.theme='${t === 'light' ? 'light' : 'dark'}'`); await sleep(300);
      report.measures[`wide-${t}`] = await run(measure);
      await check(`wide: stats on the Done line, right-aligned, >=30px gap (${t})`, `(()=>{const m=${measure};return !!m&&m.sameLine&&m.gap>=30&&m.rightAligned<=1})()`);
      await capture(`wide-${t}`, await run(rowRect));
      // Narrow: squeeze the reply column (fixture-only style) so Done and the
      // stats cannot share a line; the stats must wrap below, still right-aligned.
      await run("(()=>{const s=document.createElement('style');s.id='squeeze';s.textContent='[data-grid-cell=\"chat:alpha\"] .msg-ai{max-width:380px!important;width:380px!important}';document.head.append(s)})()"); await sleep(300);
      await run(`document.documentElement.dataset.theme='${t === 'light' ? 'light' : 'dark'}'`); await sleep(300);
      report.measures[`narrow-${t}`] = await run(measure);
      await check(`narrow: stats wrap below Done, right-aligned (${t})`, `(()=>{const m=${measure};return !!m&&!m.sameLine&&m.statsTop>=m.doneBottom-1&&m.rightAligned<=1})()`);
      await capture(`narrow-${t}`, await run(rowRect));
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
