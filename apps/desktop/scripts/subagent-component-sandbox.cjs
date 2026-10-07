const { app, BrowserWindow, session } = require('electron');
const fs = require('node:fs');
const path = require('node:path');
const cp = require('node:child_process');
const out = process.env.NEKKO_COMPONENT_OUT;
if (!out) throw Error('Launch through subagent-component-integration.cjs');
const kind = process.env.NEKKO_TEST_REVISION ? 'before' : 'after';
const runDir = path.join(out, kind);
fs.mkdirSync(runDir, { recursive: true });
app.setPath('userData', path.join(runDir, 'profile'));
app.setPath('sessionData', path.join(runDir, 'profile'));
const report = { checks: [], errors: [], captures: [], visuallyInspected: false };
const sleep = ms => new Promise(r => setTimeout(r, ms));
app.whenReady().then(async () => {
  session.defaultSession.webRequest.onBeforeRequest((d, done) => done({ cancel: !/^(file:|data:|blob:)/.test(d.url) }));
  session.defaultSession.setPermissionRequestHandler((_wc, _permission, done) => done(false));
  const win = new BrowserWindow({ width: 1200, height: 800, useContentSize: true, show: false, focusable: false, skipTaskbar: true, x: -10000, y: -10000, title: `Subagent component ${kind} · isolated`, webPreferences: { nodeIntegration: false, contextIsolation: true, sandbox: true, backgroundThrottling: false } });
  win.on('show', () => { report.errors.push('Verification window became visible'); process.exitCode = 1; });
  win.on('focus', () => { report.errors.push('Verification window took OS focus'); process.exitCode = 1; });
  win.webContents.on('console-message', e => { if (e.level === 'error') report.errors.push(e.message); });
  const run = code => win.webContents.executeJavaScript(code, true);
  const capture = async name => { await sleep(250); const file = path.join(runDir, name + '.png'); fs.writeFileSync(file, (await win.capturePage(undefined, { stayHidden: true, stayAwake: false })).toPNG()); report.captures.push(file); };
  // Fixed expressions only: never interpolate labels into executable code.
  const clicks = {
    group: "(() => { const b = [...document.querySelectorAll('button')].find(b => b.textContent.includes('Worked on')); if (!b) throw Error('Missing group button'); b.click(); })()",
    beforeTask: "(() => { const b = [...document.querySelectorAll('button')].find(b => b.textContent.includes('spawn_agent')); if (!b) throw Error('Missing task button'); b.click(); })()",
    afterTask: "(() => { const b = [...document.querySelectorAll('button')].find(b => b.textContent.includes('Spawned subagent')); if (!b) throw Error('Missing task button'); b.click(); })()",
  };
  const click = async key => { await run(clicks[key]); await sleep(180); };
  try {
    await win.loadFile(path.join(out, 'index.html')); await sleep(650);
    if (!await run("document.body.textContent.includes('Delegation steps') && document.body.textContent.includes('Reply states')")) throw Error('Component fixture did not mount: ' + await run('document.body.textContent.slice(0,500)'));
    report.checks.push('real components mounted; reply state variants present');
    if (kind === 'after') {
      const initial = await run(`(() => { const b=[...document.querySelectorAll('button')].find(b=>b.textContent.includes('Spawned subagent')); return { text:b?.textContent, border:getComputedStyle(b?.parentElement).borderLeftWidth, reply:document.body.textContent }; })()`);
      if (!initial.text.includes('Run the integration checks') || initial.border !== '0px' || !initial.reply.includes('Sleeping · will check in') || !initial.reply.includes('Waiting for access')) throw Error('Compact standalone or reply state missing: ' + JSON.stringify(initial));
      report.checks.push('standalone task summary borderless; sleeping and blocked states');
    }
    for (const theme of ['light','dark']) {
      await run(`document.documentElement.dataset.theme='${theme}'`);
      for (const [width,label] of [[1200,'wide'],[400,'narrow']]) {
        win.setContentSize(width,800);
        await capture(`${theme}-${label}-collapsed`);
        await click('group');
        await capture(`${theme}-${label}-expanded`);
        const buttons = await run("[...document.querySelectorAll('li button')].map(b=>b.textContent)");
        if (buttons.length !== 4) throw Error('Missing activity steps: ' + buttons);
        await click(kind === 'before' ? 'beforeTask' : 'afterTask');
        const text = await run('document.body.textContent');
        if (!text.includes('All integration checks passed')) throw Error('Result disclosure failed');
        report.checks.push(`${theme} ${label}: group and task/result disclosure`);
        await capture(`${theme}-${label}-result`);
        await click('group');
      }
    }
    const motion = path.join(runDir, 'motion'); fs.mkdirSync(motion, { recursive: true });
    win.setContentSize(1200,800);
    for (let i=0;i<12;i++) { if(i===3 || i===8) await click('group'); fs.writeFileSync(path.join(motion, `${String(i).padStart(3,'0')}.png`), (await win.capturePage(undefined, { stayHidden: true, stayAwake: false })).toPNG()); await sleep(100); }
    cp.execFileSync('ffmpeg', ['-y','-framerate','10','-i',path.join(motion,'%03d.png'),'-vf','pad=ceil(iw/2)*2:ceil(ih/2)*2','-c:v','libx264','-pix_fmt','yuv420p',path.join(runDir,'disclosure.mp4')], { stdio: 'ignore', windowsHide: true });
    report.background = { visible: win.isVisible(), focused: win.isFocused() };
    if (win.isVisible() || win.isFocused()) report.errors.push("Background verification visibility/focus invariant failed");
    report.success = !report.errors.length;
  } catch (e) { report.errors.push(String(e)); report.success = false; }
  finally { fs.writeFileSync(path.join(runDir, 'status.json'), JSON.stringify(report, null, 2)); console.log(JSON.stringify({runDir,...report},null,2)); win.destroy(); app.exit(report.success ? 0 : 1); }
});
