const { app, BrowserWindow, session } = require('electron');
const fs = require('node:fs');
const path = require('node:path');
const out = process.env.NEKKO_INTEGRATION_OUT;
if (!out) throw Error('Launch through command-center-integration.cjs');
const runDir = path.join(out, new Date().toISOString().replace(/[:.]/g, '-'));
fs.mkdirSync(runDir, { recursive: true });
app.setPath('userData', path.join(runDir, 'profile'));
app.setPath('sessionData', path.join(runDir, 'profile'));
const report = { checks: [], errors: [], captures: [], visuallyInspected: false };
const sleep = ms => new Promise(r => setTimeout(r, ms));
app.whenReady().then(async () => {
  session.defaultSession.webRequest.onBeforeRequest((d, done) => done({ cancel: !/^(file:|data:|blob:)/.test(d.url) }));
  session.defaultSession.setPermissionRequestHandler((_wc, _permission, done) => done(false));
  const win = new BrowserWindow({ width: 1200, height: 900, useContentSize: true, show: false, focusable: false, skipTaskbar: true, x: process.env.NEKKO_WALL_REALTIME ? 40 : -10000, y: process.env.NEKKO_WALL_REALTIME ? 40 : -10000, title: 'Synthetic Command Center verification', webPreferences: { nodeIntegration: false, contextIsolation: true, sandbox: true, backgroundThrottling: false } });
  win.webContents.on('console-message', e => { if (e.level === 'error') report.errors.push(e.message); else if (process.env.NEKKO_WALL_EVIDENCE) console.log(e.message); });
  const run = s => win.webContents.executeJavaScript(s, true);
  const check = async (name, expression) => { await sleep(180); if (!await run(expression)) throw Error(name); report.checks.push(name); };
  const click = async (text, selector = null) => {
    await run(`(() => {
      const scope = ${JSON.stringify(selector)};
      const root = scope === null ? document : document.querySelector(scope);
      const text = ${JSON.stringify(text)};
      const b = [...root.querySelectorAll('button')].find(b => b.textContent.trim() === text);
      if (!b) throw Error('Missing button ' + text);
      b.focus(); b.click();
    })()`);
    await sleep(180);
  };
  const reset = async () => { await run('window.integration.reset()'); await sleep(350); };
  const open = async category => { await click('Add window'); if (category) { await run(`[...document.querySelectorAll('.agent-window-picker__option')].find(b=>b.querySelector('strong')?.textContent===${JSON.stringify(category)}).click()`); await sleep(180); } };
  const image = async () => { await open('Media'); await run("[...document.querySelectorAll('.agent-window-picker button')].find(b=>b.textContent.includes('Create image session')).click()"); await sleep(200); };
  const capture = async name => { await sleep(350); fs.writeFileSync(path.join(runDir, name + '.png'), (await win.webContents.capturePage()).toPNG()); report.captures.push(path.join(runDir, name + '.png')); };
  try {
    await win.loadFile(path.join(out, 'index.html')); win.showInactive(); await sleep(900);
    await check('mounted full CommandCenterView', "(document.body.textContent.includes('Agents') || document.body.textContent.includes('Command Center')) && !!document.querySelector('[data-command-wall]')");
    const current = !process.env.NEKKO_TEST_REVISION;
    if (process.env.NEKKO_WALL_REALTIME) {
      win.setAlwaysOnTop(true, 'floating');
      await sleep(500);
      const rail = await run("(()=>{const r=document.querySelector('.command-wall-add-rail-right').getBoundingClientRect();return {x:Math.round(r.x+r.width/2),y:Math.round(r.y+r.height/2)}})()");
      const motion = path.join(runDir, 'realtime'); fs.mkdirSync(motion);
      win.webContents.sendInputEvent({type:'mouseMove',...rail});
      for (let frame=0; frame<20; frame++) {
        fs.writeFileSync(path.join(motion, `${String(frame).padStart(3,'0')}.png`), (await win.webContents.capturePage()).toPNG());
        await sleep(50);
      }
      await check('real-time hover transition finishes', "(()=>{const a=document.querySelector('.command-wall-add[data-preview]');if(!a)return false;const r=a.getBoundingClientRect();return r.height>100&&[...document.querySelectorAll('.command-wall-window')].every(p=>{const s=p.getBoundingClientRect();return Math.min(r.right,s.right)-Math.max(r.left,s.left)<=1||Math.min(r.bottom,s.bottom)-Math.max(r.top,s.top)<=1})})()");
      await capture('sweep-realtime-hover');
      win.webContents.sendInputEvent({type:'mouseMove',x:5,y:5});
      await sleep(500);
      await check('real-time pointer exit removes preview', "!document.querySelector('.command-wall-add[data-preview]')");
      const encoded=require('node:child_process').spawnSync('ffmpeg',['-y','-framerate','10','-i',path.join(motion,'%03d.png'),'-vf','pad=ceil(iw/2)*2:ceil(ih/2)*2','-c:v','libx264','-pix_fmt','yuv420p',path.join(runDir,'sweep-realtime-hover.mp4')],{encoding:'utf8'});
      if(encoded.status!==0) throw Error(encoded.stderr);
      report.captures.push(path.join(runDir,'sweep-realtime-hover.mp4'));
      win.setAlwaysOnTop(false);
      if(process.env.NEKKO_REALTIME_ONLY) { report.success=true; return; }
    }
    if (current && process.env.NEKKO_WALL_EVIDENCE) {
      await run("integration.state().view='command'; document.querySelector('[data-wall-composer] [aria-label=\"Show selected chat in Focus\"]').click()");
      await check('composer Focus selects hero', "document.querySelector('[data-wall-layout]').dataset.wallLayout==='focus'");
      await run("window.dispatchEvent(new KeyboardEvent('keydown',{key:'@',code:'Digit2',ctrlKey:true,shiftKey:true,bubbles:true}))");
      await check('Grid keyboard shortcut', "document.querySelector('[data-wall-layout]').dataset.wallLayout==='grid'");
      await run("window.dispatchEvent(new KeyboardEvent('keydown',{key:'#',code:'Digit3',ctrlKey:true,shiftKey:true,bubbles:true}))");
      await check('Fixed keyboard shortcut', "document.querySelector('[data-wall-layout]').dataset.wallLayout==='fixed'");
      await reset();
    }
    if (process.env.NEKKO_WALL_EVIDENCE) {
      await run("integration.state().view='command'");
      for (const theme of ['light', 'dark']) {
        for (const [width, label] of [[1200, 'desktop'], [400, 'narrow']]) {
          win.setContentSize(width, 900); await reset();
          await run(`document.documentElement.dataset.theme='${theme}'`);
          await capture(`wall-idle-${theme}-${label}`);
          if (current) {
            await check('editor stays inside composer frame', "(()=>{const p=document.querySelector('[data-wall-composer]').getBoundingClientRect(), e=document.querySelector('[data-wall-composer] [contenteditable]').getBoundingClientRect();return e.top>=p.top&&e.bottom<=p.bottom+1})()");
            await run("document.querySelector('.command-wall-add-rail-right').dispatchEvent(new MouseEvent('mouseover',{bubbles:true}))");
            await sleep(400);
            // Off-screen Windows compositor can defer CSS transitions. Settle
            // finite transitions for endpoint assertions; motion captures below
            // explicitly sample the timeline rather than treating timeouts as proof.
            await run("document.getAnimations().filter(a=>a instanceof CSSTransition).forEach(a=>a.finish())");
            await check('edge hover opens non-overlapping preview', "(()=>{const a=document.querySelector('.command-wall-add[data-preview]');if(!a||a.hasAttribute('data-solid'))return false;const r=a.getBoundingClientRect();return [...document.querySelectorAll('.command-wall-window')].every(p=>{const s=p.getBoundingClientRect();return Math.min(r.right,s.right)-Math.max(r.left,s.left)<=1||Math.min(r.bottom,s.bottom)-Math.max(r.top,s.top)<=1})})()");
            if (width < 720) await run("document.querySelector('.command-wall-add').scrollIntoView({block:'nearest'})");
            await capture(`wall-liquid-${theme}-${label}`);
            await run("document.querySelector('.command-wall-add-zone').dispatchEvent(new MouseEvent('mouseout',{bubbles:true,relatedTarget:document.body}))");
            await sleep(100);
            await check('pointer exit restores compact strips', "!document.querySelector('.command-wall-add[data-preview]')");
            await run("document.querySelector('.command-wall-add-rail-right').focus(); document.querySelector('.command-wall-add-rail-right').dispatchEvent(new FocusEvent('focusin',{bubbles:true}))"); await sleep(100);
            await check('keyboard focus previews Add', "!!document.querySelector('.command-wall-add[data-preview]')");
            await run("document.querySelector('.command-wall-add-fill').click()");
            await check('click solidifies add slot', "!!document.querySelector('.command-wall-add[data-solid] #wall-window-picker')");
            await run("document.getAnimations().filter(a=>a instanceof CSSTransition).forEach(a=>a.finish())");
            await capture(`wall-solid-${theme}-${label}`);
            await run("document.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true}))");
          }
          await click('Fixed'); await capture(`wall-fixed-hint-${theme}-${label}`);
          await run("document.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true}))");
        }
      }
      if (process.env.NEKKO_WALL_HOLD) {
        win.setContentSize(1200,900); await reset(); await run("document.documentElement.dataset.theme='dark'");
        console.log('Evidence sandbox ready for native capture');
        await new Promise(resolve => setTimeout(resolve, 110000));
      }
    }
    await check('cold session model hydrates', "document.querySelector('.command-wall-window').textContent.includes('Fixture model')");
    await run("document.querySelector('.command-wall-window button[aria-haspopup=listbox]').click()"); await sleep(500);
    await run("[...document.querySelectorAll('[role=listbox] button')].find(b=>b.textContent.includes('Auto')).click()"); await sleep(500);
    await check('Auto saved to bridge', "JSON.parse(sessionStorage.getItem('fixture-record')).autoModel===true");
    await win.reload(); await sleep(1400);
    await check('Auto restores after cold reload', "document.querySelector('.command-wall-window').textContent.includes('Auto')");
    if (current) {
      await check('no model picker in shared composer', "!document.querySelector('[data-wall-composer] [role=listbox]') && !document.querySelector('[data-wall-composer]').textContent.includes('No model') && !document.querySelector('[data-wall-composer]').textContent.includes('Auto �')");
      await run('integration.ask()'); await sleep(500);
      await check('question belongs to agent window', "!!document.querySelector('.command-wall-window .composer-question') && !document.querySelector('[data-wall-composer] .composer-question')");
      await run("document.querySelector('.command-wall-window .composer-question [role=group]').dispatchEvent(new KeyboardEvent('keydown',{key:'Enter',bubbles:true}))"); await sleep(500);
      await check('question answer targets owning session', "integration.calls.some(c=>c.method==='answer'&&c.id==='existing'&&c.callId==='ask-fixture')");
      await run("window.startEditor=document.querySelector('[data-wall-composer] [contenteditable]').getBoundingClientRect().height; document.querySelector('[aria-label=\"Resize composer versus wall\"]').dispatchEvent(new KeyboardEvent('keydown',{key:'ArrowUp',bubbles:true}))"); await sleep(500);
      await check('resize grows editor', "document.querySelector('[data-wall-composer] [contenteditable]').getBoundingClientRect().height>window.startEditor");
      if (!process.env.NEKKO_TEST_REVISION) {
      await run("window.copiedChat=null; Object.defineProperty(navigator,'clipboard',{configurable:true,value:{writeText:async text=>{window.copiedChat=text}}}); document.querySelector('.command-wall-window [data-chat-surface]').dispatchEvent(new MouseEvent('contextmenu',{bubbles:true,clientX:150,clientY:150}))");
      await check('transcript menu contains copy and export', "document.querySelector('[role=menu]').textContent.includes('Copy chat') && document.querySelector('[role=menu]').textContent.includes('Export as Markdown')");
      await click('Copy chat', '[role=menu]');
      await check('copy writes Markdown transcript', "window.copiedChat.startsWith('# Existing conversation') && !document.querySelector('[role=menu]')");
      await run("window.exportedName=null; window.exportedBlob=null; URL.createObjectURL=blob=>{window.exportedBlob=blob;return 'blob:fixture'}; URL.revokeObjectURL=()=>{}; HTMLAnchorElement.prototype.click=function(){window.exportedName=this.download}; document.querySelector('.command-wall-window [data-chat-surface]').dispatchEvent(new MouseEvent('contextmenu',{bubbles:true,clientX:150,clientY:150}))");
      await click('Export as Markdown', '[role=menu]');
      await check('export uses same Markdown payload', "(async()=>window.exportedName==='Existing-conversation.md' && await window.exportedBlob.text()===window.copiedChat)()");
      await run("document.querySelector('[data-wall-composer] [contenteditable]').dispatchEvent(new MouseEvent('contextmenu',{bubbles:true,clientX:150,clientY:150}))");
      await check('editor excludes transcript actions', "![...document.querySelectorAll('[role=menu]')].some(m=>m.textContent.includes('Copy chat')||m.textContent.includes('Export as Markdown'))");
      await run("document.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true}))");
      await check('footer exposes all reply measurements', "(()=>{const e=document.querySelector('.command-wall-window [aria-label=\"Chat actions and information\"]');return e.textContent.includes('tok/s') && e.textContent.includes('total tokens') && e.textContent.includes('Time unavailable')})()");
    }
      }
    for (const theme of ['light', 'dark']) {
      await run(`document.documentElement.dataset.theme='${theme}'`);
      for (const [width, label] of [[1200, 'desktop'], [400, 'narrow']]) {
        win.setContentSize(width, 900); await run("sessionStorage.removeItem('fixture-record')"); await reset(); await capture(`full-grid-${theme}-${label}`);
        await run("document.querySelector('.command-wall-window [data-chat-surface]').dispatchEvent(new MouseEvent('contextmenu',{bubbles:true,clientX:180,clientY:200}))"); await capture(`chat-menu-${theme}-${label}`);
        await run("document.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true}))");
        await run("document.querySelector('[aria-label=\"Git checkout options\"]')?.click()"); await capture(`checkout-modal-${theme}-${label}`);
        await run("document.querySelector('[aria-label=\"Close checkout notice\"]')?.click()");
        await run('integration.ask()'); await sleep(350); await run("document.querySelector('.composer-question')?.scrollIntoView({block:'nearest'})"); await capture(`question-${theme}-${label}`); await reset();
        await run("document.querySelector('.command-wall-window button[aria-haspopup=listbox]').click()"); await capture(`full-picker-${theme}-${label}`);
        await run("document.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true}))"); await click('Focus'); await capture(`full-focus-${theme}-${label}`);
        await run("integration.route('workspace')"); await sleep(500);
        await run("(()=>{const b=document.querySelector('[title=\"New agent with a terminal\"]'); b.focus(); b.dispatchEvent(new FocusEvent('focusin',{bubbles:true}));})()"); await capture(`workspace-image-menu-${theme}-${label}`);
      }
    }
    if (process.env.NEKKO_WALL_EVIDENCE && current) {
      win.setContentSize(1200,900); await reset(); await run("document.documentElement.dataset.theme='dark'");
      const motion = path.join(runDir, 'liquid-motion'); fs.mkdirSync(motion);
      for (let frame = 0; frame < 48; frame++) {
        if (frame === 5) await run("document.querySelector('.command-wall-add-rail-right').dispatchEvent(new MouseEvent('mouseover',{bubbles:true}))");
        if (frame === 31) await run("document.querySelector('.command-wall-add-fill').click()");
        await run(`document.getAnimations().filter(a=>a instanceof CSSTransition).forEach(a=>{a.currentTime=${frame < 31 ? Math.max(0, frame - 5) * 100 : (frame - 31) * 100}})`);
        fs.writeFileSync(path.join(motion, `${String(frame).padStart(3, '0')}.png`), (await win.webContents.capturePage()).toPNG()); await sleep(100);
      }
      const encoded = require('node:child_process').spawnSync('ffmpeg', ['-y','-framerate','10','-i',path.join(motion,'%03d.png'),'-vf','pad=ceil(iw/2)*2:ceil(ih/2)*2','-c:v','libx264','-pix_fmt','yuv420p',path.join(runDir,'liquid-add-motion.mp4')],{encoding:'utf8'});
      if (encoded.status !== 0) throw Error(encoded.stderr);
      report.captures.push(path.join(runDir,'liquid-add-motion.mp4'));
    }
    if (process.env.NEKKO_WALL_EVIDENCE && current) {
      await win.loadFile(path.join(out,'index.html'),{query:{multi:'1'}}); win.setContentSize(1200,900); await sleep(800);
      await run("document.documentElement.dataset.theme='dark'");
      await run("(()=>{const i=document.querySelector('[data-wall-composer] [contenteditable]'); i.focus(); const dt=new DataTransfer();dt.items.add(new File([Uint8Array.from(atob('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aX1cAAAAASUVORK5CYII='),c=>c.charCodeAt(0))],'fixture.png',{type:'image/png'}));i.dispatchEvent(new ClipboardEvent('paste',{bubbles:true,cancelable:true,clipboardData:dt}))})()");
      await check('pasted image attachment renders', "!!document.querySelector('[data-wall-composer] img[alt=\"Pending attachment 1\"]')");
      await check('attachment editor remains inside frame', "(()=>{const p=document.querySelector('[data-wall-composer]').getBoundingClientRect(),e=document.querySelector('[data-wall-composer] [contenteditable]').getBoundingClientRect();return e.bottom<=p.bottom+1})()");
      await capture('wall-multi-attachment');
      await check('multi-chat selection hint', "document.querySelector('[data-wall-composer]').textContent.includes('selects a window')");
      await run("document.querySelector('.command-wall-add-rail-bottom').dispatchEvent(new MouseEvent('mouseover',{bubbles:true}))"); await sleep(150);
      await run("document.getAnimations().filter(a=>a instanceof CSSTransition).forEach(a=>a.finish())");
      await capture('wall-multi-hover');
      await run("document.querySelector('.command-wall-add-fill').click()"); await sleep(200);
      await capture('wall-multi-solid');
      await win.loadFile(path.join(out,'index.html')); await sleep(600);
    }
    // Timed PNG frames form a portable motion recording without screen permissions.
    win.setContentSize(1200, 900); await reset(); await run("document.documentElement.dataset.theme='light'");
    const motion = path.join(runDir, 'motion'); fs.mkdirSync(motion);
    for (let frame = 0; frame < 36; frame++) {
      if (frame === 4 || frame === 16) await run("document.querySelector('[aria-label=\"Resize composer versus wall\"]').dispatchEvent(new KeyboardEvent('keydown',{key:'ArrowUp',bubbles:true}))");
      if (frame === 22) await click('Focus');
      if (frame === 29) await click('Grid');
      fs.writeFileSync(path.join(motion, `${String(frame).padStart(3, '0')}.png`), (await win.webContents.capturePage()).toPNG());
      await sleep(100);
    }
    const encoded = require('node:child_process').spawnSync('ffmpeg', ['-y', '-framerate', '10', '-i', path.join(motion, '%03d.png'), '-vf', 'pad=ceil(iw/2)*2:ceil(ih/2)*2', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', path.join(runDir, 'full-view-motion.mp4')], { encoding: 'utf8' });
    if (encoded.status !== 0) throw Error(encoded.stderr);
    report.captures.push(path.join(runDir, 'full-view-motion.mp4'));
    if (current) {
      win.setContentSize(900,480); await reset();
      await check('short grid remains scrollable', "(()=>{const stage=document.querySelector('.command-wall-stage');return stage && stage.scrollHeight>0 && document.querySelector('[data-wall-composer] [contenteditable]').clientHeight>=36})()");
      await click('Fixed');
      await check('short fixed layout retains accessible editor', "document.querySelector('[data-wall-composer] [contenteditable]').clientHeight>=36 && document.documentElement.scrollWidth<=innerWidth");
    }
    report.success = true;
  } catch (e) { report.errors.push(String(e)); report.success = false; process.exitCode = 1; }
  finally { fs.writeFileSync(path.join(runDir, 'status.json'), JSON.stringify(report, null, 2)); fs.writeFileSync(path.join(out, 'latest-run.txt'), runDir); console.log(JSON.stringify({ runDir, ...report }, null, 2)); win.destroy(); app.exit(report.success ? 0 : 1); }
});
