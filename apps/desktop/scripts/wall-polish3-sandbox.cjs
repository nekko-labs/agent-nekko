// Synthetic agent-window indicators evidence; never connects to the user's host or profile.
// Launched through wall-polish-integration.cjs with NEKKO_SANDBOX=wall-polish3-sandbox.cjs.
const { app, BrowserWindow, session, screen } = require('electron');
const fs = require('node:fs');
const path = require('node:path');
const out = process.env.NEKKO_INTEGRATION_OUT;
if (!out) throw Error('Launch through wall-polish-integration.cjs');
const base = !!process.env.NEKKO_TEST_REVISION;
const dir = path.join(out, base ? 'before3' : 'after3');
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
    x: left - 3000, y: -2000, title: 'Synthetic agent window indicators verification',
    webPreferences: { contextIsolation: true, sandbox: true, backgroundThrottling: false },
  });
  const report = { checks: [], errors: [], visuallyInspected: false };
  win.on('focus', () => report.errors.push('Fixture took focus'));
  win.webContents.on('console-message', e => { if (e.level === 'error') report.errors.push('console: ' + e.message); });
  const run = source => win.webContents.executeJavaScript(source, true);
  const check = async (name, source) => {
    await sleep(150);
    let ok = false;
    try { ok = !!await run(source); } catch (e) { report.errors.push(name + ': ' + e); }
    report.checks.push({ name, passed: ok });
  };
  const capture = async (name, rect) => {
    await sleep(350);
    await run('document.getAnimations().forEach(a => { try { a.finish(); } catch {} })');
    fs.writeFileSync(path.join(dir, name + '.png'), (await win.capturePage(rect || undefined, { stayHidden: true, stayAwake: false })).toPNG());
  };
  // Only fixed selectors and presets reach the page, looked up by index there.
  const SELECTORS = { beta: '[data-grid-cell="chat:beta"]', alpha: '[data-grid-cell="chat:alpha"]', panel: '[data-agent-panel]', composer: '[data-wall-composer]' };
  const PRESETS = { plain: {}, question: { question: true }, many: { many: true }, manyRow: { many: true, horizontal: true } };
  await sleep(0);
  const rectOf = async (key, pad = 12, tail = 0) => {
    if (!(key in SELECTORS) || !Number.isInteger(pad) || !Number.isInteger(tail)) throw Error('unknown selector');
    await run(`window.__sel=${JSON.stringify(Object.values(SELECTORS))}`);
    const index = Object.keys(SELECTORS).indexOf(key);
    return run(`(()=>{const e=document.querySelector(window.__sel[${index}]);if(!e)return undefined;const r=e.getBoundingClientRect();const p=${pad},t=${tail};const top=t?Math.max(r.y,r.bottom-t):r.y;return {x:Math.max(0,Math.floor(r.x)-p),y:Math.max(0,Math.floor(top)-p),width:Math.min(innerWidth,Math.ceil(r.width)+p*2),height:Math.min(innerHeight,Math.ceil(r.bottom-top)+p*2)}})()`);
  };
  const reset = async (preset = 'plain') => {
    if (!(preset in PRESETS)) throw Error('unknown preset');
    await run(`window.__presets=${JSON.stringify(Object.values(PRESETS))}`);
    await run(`integration.reset(window.__presets[${Object.keys(PRESETS).indexOf(preset)}])`);
    await sleep(1100);
  };
  const theme = t => run(`document.documentElement.dataset.theme='${t === 'light' ? 'light' : 'dark'}'`);
  try {
    await win.loadFile(path.join(out, 'index.html'));
    win.showInactive();
    await sleep(1000);
    for (const t of ['dark', 'light']) {
      // 1. Attention: beta asked a question.
      await reset('question'); await theme(t); await sleep(400);
      await check(`needs-you window wears the warm ring (${t})`, "(()=>{const w=document.querySelector('[data-grid-cell=\"chat:beta\"]');if(!w||!w.hasAttribute('data-wall-needs-you'))return false;const ring=getComputedStyle(w.querySelector(':scope > .panel'),'::after').boxShadow;return /2px/.test(ring)})()");
      await check(`needs-you window shows the ? status (${t})`, "!!document.querySelector('[data-grid-cell=\"chat:beta\"] [data-agent-status] [aria-label=\"Needs your input\"]')");
      await check(`sidebar card shows the ? for the question (${t})`, "[...document.querySelectorAll('[data-agent-panel] [aria-label=\"Needs your input\"]')].length>0");
      await capture(`attention-${t}`);
      await capture(`attention-window-${t}`, await rectOf('beta', 14));
      // 2. Footer: status far bottom-right, internet toggle, tools and MCP.
      await check(`status glyph is at the window's bottom-right (${t})`, "(()=>{const w=document.querySelector('[data-grid-cell=\"chat:alpha\"]').getBoundingClientRect();const s=document.querySelector('[data-grid-cell=\"chat:alpha\"] [data-agent-status]')?.getBoundingClientRect();if(!s)return false;return w.right-s.right<24&&w.bottom-s.bottom<24})()");
      await check(`no status glyph in the title strip (${t})`, "!document.querySelector('[data-grid-cell=\"chat:alpha\"] .panel > div:first-child [aria-label=\"Done, idle\"]')");
      await check(`internet toggle replaces Online (${t})`, "(()=>{const w=document.querySelector('[data-grid-cell=\"chat:alpha\"]');const b=w.querySelector('.agent-internet-toggle');return !!b&&b.dataset.internet==='allowed'&&/allow or block|block internet/i.test(b.title)&&!/Online/.test(w.textContent)})()");
      await check(`tools and MCP in the window footer (${t})`, "(()=>{const f=document.querySelector('[data-grid-cell=\"chat:alpha\"] [data-agent-footer-controls]');return !!f&&/Tools/.test(f.textContent)&&/MCP/.test(f.textContent)})()");
      await check(`tools and MCP gone from the composer (${t})`, "(()=>{const c=document.querySelector('[data-wall-composer]');return !!c&&!/Tools/.test(c.textContent)&&!/MCP/.test(c.textContent)&&!/Offline/.test(c.textContent)})()");
      await capture(`footer-${t}`, await rectOf('alpha', 8, 64));
      await run("document.querySelector('[data-grid-cell=\"chat:alpha\"] .agent-internet-toggle')?.click()"); await sleep(500);
      await check(`internet toggle blocks (${t})`, "integration.calls.some(c=>c.method==='options'&&c.id==='alpha'&&c.options.offline===true)&&document.querySelector('[data-grid-cell=\"chat:alpha\"] .agent-internet-toggle').dataset.internet==='blocked'");
      await capture(`footer-blocked-${t}`, await rectOf('alpha', 8, 64));
      await run("document.querySelector('[data-grid-cell=\"chat:alpha\"] .agent-internet-toggle')?.click()"); await sleep(500);
      await run("[...document.querySelectorAll('[data-grid-cell=\"chat:alpha\"] [data-agent-footer-controls] .ctl-menu')].find(b=>/Tools/.test(b.textContent))?.click()"); await sleep(400);
      await check(`tools menu floats above the window (${t})`, "(()=>{const m=document.querySelector('[role=menu][aria-label=Tools]');if(!m)return false;const r=m.getBoundingClientRect();const hit=document.elementFromPoint(r.left+20,r.top+12);return m.contains(hit)})()");
      await capture(`tools-menu-${t}`);
      await run("document.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape'}))"); await sleep(200);
      // 3. Composer: no Continue work box.
      await check(`composer has no Continue work (${t})`, "!/Continue work/.test(document.querySelector('[data-wall-composer]')?.textContent||'')");
      await capture(`composer-${t}`, await rectOf('composer', 10));
      // 4. Chat panel: closing a group hides its cards; wheel scrolls the list.
      await reset('many'); await theme(t); await sleep(400);
      // A real wheel event through Chromium's input pipeline (renderer-only, no
      // OS input), over the middle of the card list.
      const listPoint = await run("(()=>{const l=document.querySelector('[data-agent-panel] .overflow-y-auto');if(!l)return null;l.scrollTop=0;const r=l.getBoundingClientRect();return {x:Math.round(r.left+r.width/2),y:Math.round(r.top+Math.min(r.height/2,300)),top:l.scrollTop}})()");
      if (listPoint) {
        for (let i = 0; i < 4; i++) { win.webContents.sendInputEvent({ type: 'mouseWheel', x: listPoint.x, y: listPoint.y, deltaX: 0, deltaY: -120, canScroll: true }); await sleep(60); }
        await sleep(400);
      }
      report[`wheelDebug-${t}`] = await run("(()=>{const l=document.querySelector('[data-agent-panel] .overflow-y-auto');const p=document.querySelector('[data-agent-panel]');return l?{scrollTop:l.scrollTop,sh:l.scrollHeight,ch:l.clientHeight,panelH:Math.round(p.getBoundingClientRect().height),vh:innerHeight}:null})()");
      await check(`panel list scrolls with a real mouse wheel (${t})`, "(()=>{const l=document.querySelector('[data-agent-panel] .overflow-y-auto');return !!l&&l.scrollTop>40})()");
      await check(`panel stays inside the window (${t})`, "(()=>{const p=document.querySelector('[data-agent-panel]');return !!p&&p.getBoundingClientRect().bottom<=innerHeight+1})()");
      await capture(`panel-many-${t}`, await rectOf('panel', 6));
      await run("document.querySelector('[data-agent-panel] [data-sidebar-group]')?.click()"); await sleep(500);
      report[`groupDebug-${t}`] = await run("(()=>{const g=document.querySelector('[data-agent-panel] [data-group-cards][data-collapsed]');if(!g)return 'none:'+document.querySelectorAll('[data-agent-panel] [data-group-cards]').length+':'+document.querySelector('[data-agent-panel] [data-sidebar-group]')?.getAttribute('aria-expanded');const cs=getComputedStyle(g);return cs.visibility+' h='+g.getBoundingClientRect().height+' inert='+g.hasAttribute('inert')})()");
      await check(`closed group hides its cards (${t})`, "(()=>{const g=document.querySelector('[data-agent-panel] [data-group-cards][data-collapsed]');if(!g)return false;const cs=getComputedStyle(g);return cs.visibility==='hidden'&&g.getBoundingClientRect().height<2&&g.hasAttribute('inert')})()");
      await capture(`panel-closed-group-${t}`, await rectOf('panel', 6));
      await reset('manyRow'); await theme(t); await sleep(400);
      await check(`row: wheel scrolls sideways (${t})`, "(()=>{const r=document.querySelector('.agent-panel-row');if(!r||r.scrollWidth<=r.clientWidth)return false;const before=r.scrollLeft;r.dispatchEvent(new WheelEvent('wheel',{deltaY:200,bubbles:true,cancelable:true}));return r.scrollLeft>before})()");
      await run("(()=>{const row=document.querySelector('.agent-panel-row');if(row)row.scrollLeft=0})();document.querySelector('[data-agent-panel] [data-sidebar-group]')?.click()"); await sleep(500);
      await check(`row: closed group leaves no strip (${t})`, "(()=>{const g=document.querySelector('.agent-panel-row [data-group-cards][data-collapsed]');return !!g&&g.getBoundingClientRect().width<2})()");
      await capture(`row-closed-group-${t}`, await rectOf('panel', 6));
    }
    if (win.isFocused()) throw Error('Fixture focus invariant failed');
    report.background = { visible: win.isVisible(), focused: win.isFocused(), bounds: win.getBounds() };
    report.success = !report.errors.some(e => /focus/.test(e)) && (base || report.checks.every(c => c.passed));
  } catch (error) {
    report.errors.push(String(error)); report.success = false;
  } finally {
    fs.writeFileSync(path.join(dir, 'status.json'), JSON.stringify(report, null, 2));
    console.log(JSON.stringify({ dir, success: report.success, failed: report.checks.filter(c => !c.passed).map(c => c.name), errors: report.errors.slice(0, 8) }, null, 2));
    win.destroy(); app.exit(report.success ? 0 : 1);
  }
});
