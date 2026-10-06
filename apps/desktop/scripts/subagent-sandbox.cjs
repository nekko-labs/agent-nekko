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
  const win = new BrowserWindow({ width: 1200, height: 900, useContentSize: true, show: false, focusable: false, skipTaskbar: true, x: -10000, y: -10000, title: 'Synthetic Command Center verification', webPreferences: { nodeIntegration: false, contextIsolation: true, sandbox: true, backgroundThrottling: false } });
  win.webContents.on('console-message', e => { if (e.level === 'error') report.errors.push(e.message); });
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
    await check('mounted full CommandCenterView', "document.body.textContent.includes('Command Center') && !!document.querySelector('[data-command-wall]')");
    const current = !process.env.NEKKO_TEST_REVISION;
    const scroll = async end => { await run(`document.querySelector('[data-transcript-scroll]').scrollTop=${end ? '1e7' : '0'}`); await sleep(400); };
    const expand = async () => { await run("[...document.querySelectorAll('.command-wall-window button')].find(b=>b.textContent.includes('Worked on')).click()"); await sleep(250); await run("[...document.querySelectorAll('.command-wall-window li button')].filter(b=>b.textContent.includes('spawn_agent')).forEach(b=>b.click())"); await sleep(400); };
    for (const theme of ['light','dark']) {
      await run(`document.documentElement.dataset.theme='${theme}'`);
      for (const [width,label] of [[1200,'desktop'],[400,'narrow']]) {
        win.setContentSize(width,900); await reset(); await click('Focus'); await scroll(true);
        await capture(`collapsed-${theme}-${label}`);
        if(current) await check('collapsed subagent cue '+theme+label,"document.querySelector('.command-wall-window').textContent.includes('3 subagents')");
        await expand(); await scroll(true); await capture(`expanded-${theme}-${label}`);
        if(current) {
          await check('completed/error/missing results '+theme+label,"['From subagent','Subagent failed','No subagent result recorded','All integration checks passed.'].every(t=>document.querySelector('.command-wall-window').textContent.includes(t))");
          await scroll(false); await scroll(true);
          await check('expanded state survives virtualization '+theme+label,"document.querySelector('.command-wall-window').textContent.includes('From subagent')");
        }
      }
    }
    win.setContentSize(1200,900); await reset(); await click('Focus'); await scroll(true);
    if(current) {
      for(let i=0;i<12 && !await run("document.querySelector('.command-wall-window').textContent.includes('automated wake-up')");i++){await run("document.querySelector('[data-transcript-scroll]').scrollTop-=200");await sleep(250);}
      await capture('watch-and-controls-dark-desktop');
      await check('watch and ordinary messages coexist',"document.querySelector('.command-wall-window').textContent.includes('automated wake-up') && document.querySelector('.command-wall-window').textContent.includes('Please check the integration')");
      await check('ordinary message controls remain',"!!document.querySelector('.command-wall-window button[title=\"Copy prompt\"]')");
    }
    const motion=path.join(runDir,'motion');fs.mkdirSync(motion);
    for(let frame=0;frame<16;frame++){
      if(frame===3) await expand();
      if(frame===10) await run("[...document.querySelectorAll('.command-wall-window button')].find(b=>b.textContent.includes('Worked on')).click()");
      fs.writeFileSync(path.join(motion,`${String(frame).padStart(3,'0')}.png`),(await win.webContents.capturePage()).toPNG());await sleep(100);
    }
    require('node:child_process').execFileSync('ffmpeg',['-y','-framerate','10','-i',path.join(motion,'%03d.png'),'-vf','pad=ceil(iw/2)*2:ceil(ih/2)*2','-c:v','libx264','-pix_fmt','yuv420p',path.join(runDir,'subagent-motion.mp4')],{stdio:'ignore'});
    report.success = true;
  } catch (e) { report.errors.push(String(e)); report.success = false; process.exitCode = 1; }
  finally { fs.writeFileSync(path.join(runDir, 'status.json'), JSON.stringify(report, null, 2)); fs.writeFileSync(path.join(out, 'latest-run.txt'), runDir); console.log(JSON.stringify({ runDir, ...report }, null, 2)); win.destroy(); app.exit(report.success ? 0 : 1); }
});
