const {app,BrowserWindow}=require('electron');const path=require('path');const fs=require('fs');
app.setPath('userData',path.join(require('os').tmpdir(),'nekko-security-profile-'+Date.now()));
require('esbuild').buildSync({entryPoints:[path.join(__dirname,'../src/main/artifactPreview.ts')],bundle:true,platform:'node',format:'cjs',external:['electron'],outfile:path.join(__dirname,'../../../node_modules/.cache/nekko-preview-test.cjs')}); const {registerArtifactPreview}=require(path.join(__dirname,'../../../node_modules/.cache/nekko-preview-test.cjs'));
app.whenReady().then(async()=>{try{
 const parent=new BrowserWindow({show:false,webPreferences:{preload:path.join(__dirname,'security-preload.cjs'),contextIsolation:true,sandbox:true}});
 registerArtifactPreview(w=>w.id===parent.webContents.id);
 await parent.loadURL('data:text/html,<meta http-equiv="Content-Security-Policy" content="script-src %27none%27"><h1>Parent</h1>');
 const source=`<h1 id="result">No script</h1><script>document.getElementById('result').textContent='Script executed';window.probe={bridge:typeof window.nekko,node:typeof require,opener:window.opener===null};fetch('https://example.com').then(()=>probe.network='allowed',()=>probe.network='blocked');</script>`;
 await parent.webContents.executeJavaScript(`window.testPreview(${JSON.stringify(source)})`);
 const preview=BrowserWindow.getAllWindows().find(w=>w!==parent);
 await new Promise(r=>setTimeout(r,500));
 const result=await preview.webContents.executeJavaScript(`({...probe,text:document.querySelector('#result').textContent})`);
 if(result.text!=='Script executed'||result.bridge!=='undefined'||result.node!=='undefined'||result.network!=='blocked'||!result.opener)throw Error(JSON.stringify(result));
 
 console.log('PASS',result);preview.close();parent.close();app.quit();
}catch(e){console.error(e);app.exit(1);}});
