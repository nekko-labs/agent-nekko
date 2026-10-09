const {app,BrowserWindow,session,screen}=require('electron');
const fs=require('node:fs'),path=require('node:path'),cp=require('node:child_process');
const out=process.env.NEKKO_INTEGRATION_OUT,base=!!process.env.NEKKO_TEST_REVISION;
const dir=path.join(out,base?'before':'after');fs.mkdirSync(dir,{recursive:true});
app.setPath('userData',path.join(dir,'profile'));app.setPath('sessionData',path.join(dir,'profile'));
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
app.whenReady().then(async()=>{
 session.defaultSession.webRequest.onBeforeRequest((r,done)=>done({cancel:! /^(file:|data:|blob:)/.test(r.url)}));
 session.defaultSession.setPermissionRequestHandler((w,p,done)=>done(false));
 const left=Math.min(...screen.getAllDisplays().map(d=>d.bounds.x));
 const win=new BrowserWindow({width:1400,height:900,useContentSize:true,show:false,focusable:false,skipTaskbar:true,x:left-4000,y:-3000,webPreferences:{contextIsolation:true,sandbox:true,backgroundThrottling:false}});
 const report={base,checks:[],errors:[],visuallyInspected:false};
 win.on('focus',()=>report.errors.push('Fixture took focus'));
 const run=s=>win.webContents.executeJavaScript(s,true);
 const capture=async name=>{await sleep(250);fs.writeFileSync(path.join(dir,name+'.png'),(await win.capturePage(undefined,{stayHidden:true})).toPNG())};
 const check=async(name,s)=>report.checks.push({name,passed:!!await run(s)});
 try{
 await win.loadFile(path.join(out,'index.html'));win.showInactive();await sleep(800);
 for(const width of [1400,480])for(const theme of ['dark','light']){
 win.setContentSize(width,900);await run(`integration.reset();document.documentElement.dataset.theme='${theme}'`);await sleep(350);
 const key=theme+'-'+width;
 await capture(key+'-closed');
 report.checks.push({name:key+' question button backgrounds',value:await run("[...document.querySelectorAll('[data-question] button')].map(b=>({text:b.textContent,background:getComputedStyle(b).backgroundColor}))")});
 report.checks.push({name:key+' question background',value:await run("getComputedStyle(document.querySelector('[data-question]').firstElementChild).backgroundColor")});
 await run("document.querySelector('[data-working-subagents] button[aria-expanded]').click()");await sleep(100);await capture(key+'-popup');
 await check(key+' bottom-right indicator',"(()=>{const a=document.querySelector('[data-agent-window]').getBoundingClientRect(),b=document.querySelector('[data-working-subagents] button[aria-expanded]').getBoundingClientRect();return a.right-b.right<30&&b.left>a.left+a.width/2})()");
 await run("document.querySelector('[data-agent-window] span').dispatchEvent(new PointerEvent('pointerdown',{bubbles:true}));document.querySelector('[data-agent-window] span').click()");await sleep(100);
 await check(key+' outside dismissal',"!document.querySelector('[data-working-subagents] [role=group][aria-label=\"Working subagents\"]')");
 await check(key+' equal option backgrounds',"(()=>{const bs=[...document.querySelectorAll('[data-question] button')].filter(b=>/Existing branch|Something else/.test(b.textContent));return bs.length===2&&new Set(bs.map(b=>getComputedStyle(b).backgroundColor)).size===1})()");
  await run("(()=>{const b=document.querySelector('[data-working-subagents] button[aria-expanded]');if(b.getAttribute('aria-expanded')!=='true')b.click()})()");await sleep(100);
  await run("document.querySelector('[data-working-subagents] [role=group]').dispatchEvent(new PointerEvent('pointerdown',{bubbles:true}))");await sleep(100);
  await check(key+' interior retained',"!!document.querySelector('[data-working-subagents] [role=group]')");
  await run("document.querySelector('[data-working-subagents] [role=group] button').click()");
  await check(key+' child routing',"integration.events.some(e=>e.open==='child1')");
  await run("document.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true}))");await sleep(100);
  await check(key+' Escape dismissal',"!document.querySelector('[data-working-subagents] [role=group]')");
  await run("document.querySelector('[data-working-subagents] button[aria-expanded]').click()");await sleep(100);
  await run("integration.setRunning([])");await sleep(100);
  await check(key+' all running disappear',"!document.querySelector('[data-working-subagents]')");
  await run("integration.setRunning(['child1','child2'])");await sleep(100);
  await check(key+' reappear collapsed',"document.querySelector('[data-working-subagents] button[aria-expanded]').getAttribute('aria-expanded')==='false'&&!document.querySelector('[data-working-subagents] [role=group]')");
  const leftWidth=await run("document.querySelector('[data-pane=left-top]').getBoundingClientRect().width");
  const old=await run("document.querySelector('[data-pane=top]').getBoundingClientRect().height");
 await run("document.querySelector('[data-remove]').click()");await sleep(200);
 await check(key+' vertical growth',`document.querySelector('[data-pane=top]').getBoundingClientRect().height>${old}+10&&!document.querySelector('[data-pane=middle]')`);
 await check(key+' unchanged left width',`Math.abs(document.querySelector('[data-pane=left-top]').getBoundingClientRect().width-${leftWidth})<1`);
  await capture(key+'-removed');
 }
 win.setContentSize(1400,900);await run("integration.reset();document.documentElement.dataset.theme='dark'");await sleep(250);
 const frames=path.join(dir,'motion');fs.mkdirSync(frames,{recursive:true});
 for(let i=0;i<24;i++){if(i===4)await run("document.querySelector('[data-working-subagents] button[aria-expanded]').click()");if(i===14)await run("document.querySelector('[data-remove]').click()");fs.writeFileSync(path.join(frames,String(i).padStart(3,'0')+'.png'),(await win.capturePage(undefined,{stayHidden:true})).toPNG());await sleep(65)}
 const encode=cp.spawnSync('ffmpeg',['-y','-framerate','12','-i',path.join(frames,'%03d.png'),'-vf','pad=ceil(iw/2)*2:ceil(ih/2)*2','-c:v','libx264','-pix_fmt','yuv420p',path.join(dir,'motion.mp4')],{windowsHide:true,encoding:'utf8'});
 report.motion=encode.status===0?'motion.mp4':String(encode.error||encode.stderr).slice(0,300);
 report.background={focused:win.isFocused(),bounds:win.getBounds()};
 }catch(e){report.errors.push(String(e))}finally{fs.writeFileSync(path.join(dir,'status.json'),JSON.stringify(report,null,2));console.log(JSON.stringify(report,null,2));if(process.env.NEKKO_INSPECTION_HOLD){console.log('Holding isolated fixture for capture');await sleep(90000)}win.destroy();app.exit(report.errors.length||report.checks.some(c=>c.passed===false)?1:0)}
});
