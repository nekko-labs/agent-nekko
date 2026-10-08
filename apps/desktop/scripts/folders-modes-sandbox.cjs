const { app, BrowserWindow, session } = require('electron');
const fs = require('node:fs');
const path = require('node:path');
const out = process.env.NEKKO_INTEGRATION_OUT;
const tag = process.env.NEKKO_TEST_REVISION ? 'before' : 'after';
const dir = path.join(out, `${tag}-${new Date().toISOString().replace(/[:.]/g, '-')}`);
fs.mkdirSync(dir, { recursive: true });
app.setPath('userData', path.join(dir, 'profile'));
app.setPath('sessionData', path.join(dir, 'profile'));
const report = { revision: process.env.NEKKO_TEST_REVISION || 'working-tree', checks: [], captures: [], errors: [], visuallyInspected: false };
const sleep = ms => new Promise(r => setTimeout(r, ms));
app.whenReady().then(async () => {
  session.defaultSession.webRequest.onBeforeRequest((d, done) => done({ cancel: !/^(file:|data:|blob:)/.test(d.url) }));
  session.defaultSession.setPermissionRequestHandler((_wc, _p, done) => done(false));
  const win = new BrowserWindow({ width: 1200, height: 800, useContentSize: true, show: false, focusable: false, skipTaskbar: true, title: 'Owned hidden folders modes fixture', webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false, backgroundThrottling: false } });
  win.on('focus', () => report.errors.push('Unexpected OS focus'));
  win.webContents.on('console-message', e => { if (e.level === 'error') report.errors.push(e.message); });
  const run = s => win.webContents.executeJavaScript(s, true);
  const check = async (name, s) => { await sleep(120); if (!await run(s)) throw Error(name); report.checks.push(name); };
  const click = async s => { await run(`(${s}).click()`); await sleep(150); };
  const button = text => `[...document.querySelectorAll('button')].find(b=>b.textContent.trim().startsWith(${JSON.stringify(text)}))`;
  const folder = () => click(`document.querySelector('[aria-label^="Primary folder:"]')`);
  const mode = () => click(button('Mode'));
  const reset = async () => { await run('integration.reset()'); await sleep(180); };
  const capture = async name => { await sleep(220); const image = await win.capturePage(undefined, { stayHidden: true, stayAwake: false }); if (image.isEmpty()) throw Error('Empty capture'); const file = path.join(dir, `${tag}-${name}.png`); fs.writeFileSync(file, image.toPNG()); report.captures.push({ path: file, size: image.getSize() }); };
  const save = () => { fs.writeFileSync(path.join(dir, 'manifest.json'), JSON.stringify({ ...report, pid: process.pid, windowId: win.id, title: win.getTitle(), hidden: !win.isVisible(), focusable: win.isFocusable(), held: !!process.env.NEKKO_FIXTURE_HOLD }, null, 2)); fs.writeFileSync(path.join(out, `${tag}-latest.txt`), dir); };
  try {
    await win.loadFile(path.join(out, 'index.html')); await sleep(700);
    await check('focused components mounted', "!!document.querySelector('[aria-label^=\"Primary folder:\"]')");
    for (const theme of ['dark', 'light']) for (const width of [1200, 390]) {
      win.setContentSize(width, 800); await reset(); await run(`document.documentElement.dataset.theme='${theme}'`);
      await folder(); await capture(`folder-${theme}-${width}`); await mode(); await capture(`mode-${theme}-${width}`);
      await check(`menu within ${width} viewport`, "[...document.querySelectorAll('[role=menu]')].every(e=>{const r=e.getBoundingClientRect();return r.left>=0&&r.right<=innerWidth+1&&r.top>=0&&r.bottom<=innerHeight+1})");
    }
    if (tag === 'after') {
      await reset(); await folder(); await click(button('Beta reference'));
      await check('folder pick persists and demotes old primary', "integration.record().workspaceId==='beta'&&integration.record().supportingWorkspaceIds.includes('alpha')&&integration.persisted()==='beta'");
      await folder(); await click(button('No folder')); await check('clear persists explicit no-folder', "!integration.record().workspaceId&&integration.persisted()===null");
      await folder(); await click(button('Add folder')); await check('synthetic picker adds and selects', "integration.record().workspaceId==='added'");
      await folder(); await click("document.querySelector('[aria-label=\"Revoke access to Added folder\"]')"); await check('removal refreshes saved folders', "!integration.state().settings.workspaces.some(w=>w.id==='added')");
      await run('integration.failures.remove=true'); await folder(); await click("document.querySelector('[aria-label=\"Revoke access to Alpha project\"]')"); await check('removal failure surfaces toast without removing', "integration.state().toasts.some(t=>JSON.stringify(t).includes('Synthetic removal failure'))&&integration.state().settings.workspaces.some(w=>w.id==='alpha')");
      await reset(); await run('integration.failures.folder=true'); await folder(); await click(button('Beta reference')); await check('folder selection failure surfaces toast', "integration.state().toasts.some(t=>JSON.stringify(t).includes('Synthetic folder failure'))");
      await reset(); await mode(); await check('execution permissions independent columns', "document.querySelector('[role=menu] .grid').children.length===2"); await click(button('Ask')); await check('permission preserves execution', "integration.record().mode==='ask'&&integration.record().executionMode==='worktree'");
      await mode(); await click(button('Unified')); await check('execution preserves permission and updates default', "integration.record().executionMode==='unified'&&integration.record().mode==='ask'&&integration.state().settings.defaultExecutionMode==='unified'");
      await run('integration.failures.options=true'); await mode(); await click(button('Worktree')); await check('execution error shown', "document.querySelector('[role=alert]')?.textContent.includes('Synthetic options failure')");
      await run('integration.failures.options=false'); await mode(); await click(button('Sandbox'));
      await check('setup consent required and initial focus inside', "document.querySelector('[role=dialog]').contains(document.activeElement)&&[...document.querySelectorAll('button')].find(b=>b.textContent==='Configure Sandbox').disabled");
      await run(`(()=>{const i=document.querySelector('[role=dialog] input:not([type=checkbox])');Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(i,'local@sha256:'+'a'.repeat(64));i.dispatchEvent(new Event('input',{bubbles:true}));})()`);
      await check('digest alone insufficient', `${button('Configure Sandbox')}.disabled`);
      await click("document.querySelector('[role=dialog] input[type=checkbox]')"); await check('digest plus consent enables setup', `!${button('Configure Sandbox')}.disabled`);
      await click(button('Configure Sandbox')); await check('setup error fail closed', "document.querySelector('[role=dialog] [role=alert]')?.textContent.includes('Synthetic local image unavailable')&&integration.record().executionMode==='unified'");
      await run(`${button('Configure Sandbox')}.focus();document.dispatchEvent(new KeyboardEvent('keydown',{key:'Tab',bubbles:true}));`); await check('Tab wraps to first dialog control', "document.activeElement===document.querySelector('[role=dialog] input')");
      await run("document.dispatchEvent(new KeyboardEvent('keydown',{key:'Tab',shiftKey:true,bubbles:true}))"); await check('Shift Tab wraps to last control', `document.activeElement===${button('Configure Sandbox')}`);
      await run("(()=>{const b=document.querySelector('[aria-label^=\"Primary folder:\"]');b.focus();b.dispatchEvent(new FocusEvent('focusin',{bubbles:true}));})()"); await check('focus cannot escape modal', "document.querySelector('[role=dialog]').contains(document.activeElement)");
      await capture('setup-error-light-390'); await click(button('Cancel')); await check('setup close label and dismissal', "!document.querySelector('[role=dialog]')");
      await reset(); await mode(); await click(button('Sandbox')); await run('document.dispatchEvent(new KeyboardEvent("keydown",{key:"Escape",bubbles:true}))'); await check('Escape dismisses setup', "!document.querySelector('[role=dialog]')");
    }
    if (report.errors.length) throw Error(report.errors.join('\n'));
    await reset(); await folder(); save(); console.log(JSON.stringify({ dir, checks: report.checks.length, captures: report.captures.length }));
    if (process.env.NEKKO_FIXTURE_HOLD) { setTimeout(() => app.quit(), 30 * 60 * 1000); fs.watchFile(path.join(dir, 'stop'), () => { if (fs.existsSync(path.join(dir, 'stop'))) app.quit(); }); }
    else app.quit();
  } catch (e) { report.errors.push(String(e.stack || e)); save(); console.error(e); process.exitCode = 1; app.quit(); }
});
