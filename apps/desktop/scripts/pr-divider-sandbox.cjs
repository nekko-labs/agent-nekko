const {app,BrowserWindow,session}=require('electron');
const fs=require('node:fs');const path=require('node:path');const cp=require('node:child_process');
const dir=process.env.NEKKO_PR_FIXTURE_DIR;if(!dir)throw Error('Use pr-divider-integration.cjs');
app.setPath('userData',path.join(dir,'profile'));app.setPath('sessionData',path.join(dir,'profile'));
app.commandLine.appendSwitch('disable-background-networking');
const report={checks:[],errors:[],captures:[],visuallyInspected:false};
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
app.whenReady().then(async()=>{
 session.defaultSession.webRequest.onBeforeRequest((d,done)=>done({cancel:! /^(file:|data:|blob:)/.test(d.url)}));
 session.defaultSession.setPermissionRequestHandler((_w,_p,done)=>done(false));
 const win=new BrowserWindow({width:1200,height:800,useContentSize:true,show:false,focusable:false,skipTaskbar:true,x:-10000,y:-10000,title:'PR divider isolated fixture',webPreferences:{sandbox:true,contextIsolation:true,nodeIntegration:false,backgroundThrottling:false}});
 win.on('focus',()=>report.errors.push('Unexpected OS focus'));
 win.webContents.on('console-message',e=>{if(e.level==='error')report.errors.push(e.message)});
 const run=code=>win.webContents.executeJavaScript(code,true);
 const state=async value=>{await run(`window.setFixturePrState('${value}')`);await sleep(400)};
 const shot=async name=>{await sleep(200);const file=path.join(dir,name+'.png');fs.writeFileSync(file,(await win.capturePage(undefined,{stayHidden:true,stayAwake:false})).toPNG());report.captures.push(file)};
 const geometry=()=>run(`(()=>{const footer=document.querySelector('[aria-label="Chat actions and information"]');if(!footer)throw Error('Missing actual footer');const dock=footer.querySelector('[aria-label="Pending pull requests"]');if(!dock)return {expanded:null,actions:0,overlaps:[],footer:footer.getBoundingClientRect().toJSON(),dock:null};const buttons=[...footer.querySelectorAll('button')].filter(b=>{const r=b.getBoundingClientRect();return r.width>0&&r.height>0&&!b.closest('[inert]')});const overlaps=[];for(let i=0;i<buttons.length;i++)for(let j=i+1;j<buttons.length;j++){const a=buttons[i].getBoundingClientRect(),b=buttons[j].getBoundingClientRect();if(Math.min(a.right,b.right)-Math.max(a.left,b.left)>1&&Math.min(a.bottom,b.bottom)-Math.max(a.top,b.top)>1)overlaps.push([buttons[i].textContent,buttons[j].textContent]);}return {expanded:dock.querySelector('button').getAttribute('aria-expanded'),actions:dock.querySelectorAll('[data-pr-actions]').length,overlaps,footer:footer.getBoundingClientRect().toJSON(),dock:dock.getBoundingClientRect().toJSON()};})()`);
 try{
  await win.loadFile(path.join(dir,'index.html'));win.setPosition(-10000,-10000);win.showInactive();await sleep(1800);
  for(const theme of ['dark','light'])for(const width of [1200,700]){
   await run(`document.documentElement.dataset.theme='${theme}'`);win.setContentSize(width,800);await sleep(400);
   await state('open');const open=await geometry();await shot(`${theme}-${width}-open`);
   await state('merged');const merged=await geometry();await shot(`${theme}-${width}-merged`);
   await state('open');const reopened=await geometry();await shot(`${theme}-${width}-reopened`);
   report.checks.push({theme,width,open,merged,reopened});
   if(open.actions!==2||merged.actions!==0||reopened.actions!==2||open.expanded!=='true'||merged.expanded!==(process.env.NEKKO_PR_FIXTURE_KIND==='before'?null:'false')||reopened.expanded!=='true')report.errors.push(`${theme}/${width}: transition assertion failed`);
   if([open,merged,reopened].some(g=>g.overlaps.length))report.errors.push(`${theme}/${width}: control overlap`);
  }
  win.setContentSize(1200,800);await run("document.documentElement.dataset.theme='dark'");await state('open');
  const motion=path.join(dir,'motion');fs.mkdirSync(motion);
  for(let i=0;i<35;i++){if(i===5)await run("window.setFixturePrState('merged')");if(i===18)await run("window.setFixturePrState('open')");fs.writeFileSync(path.join(motion,String(i).padStart(3,'0')+'.png'),(await win.capturePage(undefined,{stayHidden:true,stayAwake:false})).toPNG());await sleep(80)}
  try{cp.execFileSync('ffmpeg',['-y','-framerate','10','-i',path.join(motion,'%03d.png'),'-vf','pad=ceil(iw/2)*2:ceil(ih/2)*2','-c:v','libx264','-pix_fmt','yuv420p',path.join(dir,'open-merged-open.mp4')],{windowsHide:true,stdio:'ignore'});report.video=path.join(dir,'open-merged-open.mp4')}catch(e){report.videoLimitation=String(e)}
  report.background={visible:win.isVisible(),focused:win.isFocused()};if(win.isFocused()||win.getBounds().x!==-10000||win.getBounds().y!==-10000)report.errors.push('Background invariant failed');
 }catch(e){report.errors.push(String(e))}
 report.success=!report.errors.length;fs.writeFileSync(path.join(dir,'status.json'),JSON.stringify(report,null,2));console.log(JSON.stringify(report,null,2));win.destroy();app.exit(report.success?0:1);
});
