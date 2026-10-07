const { app, BrowserWindow, session } = require('electron');
const path = require('node:path');
const out = path.resolve(__dirname, '../../../.shots/subagent-component');
app.setPath('userData', path.join(out, 'gallery-profile'));
app.setPath('sessionData', path.join(out, 'gallery-profile'));
app.whenReady().then(async () => {
  session.defaultSession.webRequest.onBeforeRequest((details, done) => done({ cancel: !/^(file:|data:|blob:)/.test(details.url) }));
  session.defaultSession.setPermissionRequestHandler((_wc, _permission, done) => done(false));
  const win = new BrowserWindow({ width: 1200, height: 800, title: 'Subagent component gallery · isolated synthetic data', webPreferences: { nodeIntegration: false, contextIsolation: true, sandbox: true } });
  await win.loadFile(path.join(out, 'index.html'));
  console.log('Gallery ready: ' + win.getTitle());
});
