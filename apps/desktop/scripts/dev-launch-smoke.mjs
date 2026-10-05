import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { build } from 'esbuild';
import { prepareMacBundle } from './dev-launch.mjs';

if (process.platform !== 'darwin') throw Error('This smoke check requires macOS');
const out = resolve(process.argv[2] || 'native-smoke');
mkdirSync(out, { recursive: true });
const data = mkdtempSync(join(tmpdir(), 'nekko-native-smoke-'));
const entry = join(data, 'fixture');
mkdirSync(entry);
const require = createRequire(import.meta.url);
const electron = require('electron');
const original = readFileSync(resolve(electron, '../../Info.plist'));
const { launcher, bundle } = prepareMacBundle();
const plist = join(bundle, 'Contents/Info.plist');
const get = key => spawnSync('/usr/libexec/PlistBuddy', ['-c', `Print :${key}`, plist], { encoding: 'utf8' }).stdout.trim();
if (get('CFBundleIdentifier') !== 'com.agentnekko.desktop.dev' || get('CFBundleDisplayName') !== 'Agent Nekko') throw Error('Bundle identity mismatch');
if (spawnSync('/usr/bin/codesign', ['--verify', '--deep', '--strict', bundle], { stdio: 'inherit' }).status !== 0) throw Error('Invalid bundle signature');
if (!original.equals(readFileSync(resolve(electron, '../../Info.plist')))) throw Error('Shared Electron runtime changed');
await build({ entryPoints: ['src/main/devLaunchProcess.ts'], outfile: join(entry, 'register.cjs'), bundle: true, platform: 'node', format: 'cjs' });
writeFileSync(join(entry, 'package.json'), JSON.stringify({ name: 'agent-nekko-native-fixture', main: 'index.cjs' }));
writeFileSync(join(entry, 'index.cjs'), `
const {app,BrowserWindow,Menu,systemPreferences}=require('electron');
const fs=require('node:fs'),path=require('node:path');
require('./register.cjs').registerDevLaunch(app);
app.setName('Agent Nekko');
app.setPath('userData',path.join(process.env.NEKKO_DATA_DIR,'desktop'));
app.whenReady().then(async()=>{
 const win=new BrowserWindow({width:900,height:640,title:'Agent Nekko native verification'});
 await win.loadURL('data:text/html,<title>Agent Nekko</title><h1>Agent Nekko</h1><p>Isolated development bundle verification</p>');
 win.show();app.focus({steal:true});
 const report={name:app.getName(),execPath:process.execPath,userData:app.getPath('userData'),pid:process.pid,menu:Menu.getApplicationMenu()?.items.map(i=>i.label)};
 fs.writeFileSync(path.join(process.env.NEKKO_DATA_DIR,'report.json'),JSON.stringify(report));
 const timer=setInterval(()=>{if(!fs.existsSync(path.join(process.env.NEKKO_DATA_DIR,'request-mic')))return;clearInterval(timer);fs.writeFileSync(path.join(process.env.NEKKO_DATA_DIR,'permission-requested'),'microphone');void systemPreferences.askForMediaAccess('microphone');},100);
});
app.on('window-all-closed',()=>app.quit());
`);
const sleep = ms => new Promise(r => setTimeout(r, ms));
async function waitFor(check, label) { for (let i = 0; i < 150; i++) { if (check()) return; await sleep(100); } throw Error('Timeout: ' + label); }
const env = { ...process.env, NEKKO_DATA_DIR: data, NEKKO_DEV_OWNER: 'native-smoke' };
delete env.ELECTRON_RUN_AS_NODE;
delete env.ELECTRON_RENDERER_URL;
let child;
try {
  for (let launch = 0; launch < 2; launch++) {
    if (existsSync(join(data, 'report.json'))) writeFileSync(join(data, 'report.json'), 'null');
    child = spawn(launcher, [entry], { env, stdio: 'inherit' });
    let report;
    await waitFor(() => { try { report = JSON.parse(readFileSync(join(data, 'report.json'), 'utf8')); return !!report; } catch { return false; } }, 'native window');
    if (report.name !== 'Agent Nekko' || !report.execPath.startsWith(bundle) || !report.userData.startsWith(data)) throw Error('Native identity or isolated profile mismatch');
    writeFileSync(join(out, `launch-${launch}.json`), JSON.stringify(report, null, 2));
    if (launch === 1) {
      await sleep(1000);
      if (spawnSync('/usr/sbin/screencapture', ['-x', join(out, 'native-branding.png')]).status !== 0) throw Error('Native screenshot unavailable');
      writeFileSync(join(data, 'request-mic'), 'fixture only');
      await waitFor(() => existsSync(join(data, 'permission-requested')), 'permission request');
      await sleep(1500);
      if (spawnSync('/usr/sbin/screencapture', ['-x', join(out, 'native-permission.png')]).status !== 0) throw Error('Permission screenshot unavailable');
    }
    child.kill('SIGTERM');
    await waitFor(() => { try { process.kill(report.pid, 0); return false; } catch { return true; } }, 'owned app shutdown');
    await waitFor(() => child.exitCode !== null, 'wrapper shutdown');
    child = null;
  }
  writeFileSync(join(out, 'result.json'), JSON.stringify({ signedIdentity: true, sharedRuntimeUnchanged: true, isolatedProfile: true, restart: true, shutdown: true }, null, 2));
} finally { child?.kill('SIGTERM'); }
