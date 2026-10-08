const { app, BrowserWindow, session } = require('electron');
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const out = process.env.NEKKO_SHORTCUT_OUT;
if (!out) throw Error('Use shortcut-integration.cjs');
const profile = fs.mkdtempSync(path.join(out, 'profile-'));
app.setPath('userData', profile); app.setPath('sessionData', profile);
const report = { checks: [], errors: [], blockedRequests: [], hidden: true };
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
app.whenReady().then(async () => {
  session.defaultSession.webRequest.onBeforeRequest((r, done) => {
    const cancel = !/^(file:|data:|blob:)/.test(r.url);
    if (cancel) report.blockedRequests.push(r.url);
    done({ cancel });
  });
  session.defaultSession.setPermissionRequestHandler((_w, _p, done) => done(false));
  const win = new BrowserWindow({ show: false, focusable: false, skipTaskbar: true, width: 1000, height: 700, webPreferences: { sandbox: true, contextIsolation: true, backgroundThrottling: false } });
  win.on('focus', () => report.errors.push('Fixture took focus'));
  win.webContents.on('console-message', e => { if (e.level === 'error') report.errors.push(e.message); });
  const run = s => win.webContents.executeJavaScript(s);
  try {
    await win.loadFile(path.join(out, 'index.html')); await sleep(800);
    for (const modifier of ['ctrlKey', 'metaKey']) {
      const chords = [
        ['t', false, 'agent'], ['T', false, 'agent'], ['n', false, 'agent'], ['N', false, 'agent'],
        ['t', true, 'terminal'], ['T', true, 'terminal'], ['`', false, 'terminal'], ['`', true, 'terminal'], ['~', true, 'terminal'], ['j', false, 'terminal'], ['J', false, 'terminal'],
      ];
      for (const [key, shiftKey, kind] of chords) {
        for (const mode of ['normal', 'alt', 'onboarding']) {
          const name = `${modifier} ${shiftKey ? 'Shift+' : ''}${key} ${mode}`;
          await run(`shortcutTest.reset(${mode === 'onboarding'})`); await sleep(40);
          const event = await run(`shortcutTest.dispatch(${JSON.stringify({ key, shiftKey, [modifier]: true, altKey: mode === 'alt' })})`);
          await sleep(100);
          const state = await run('shortcutTest.snapshot()');
          const handled = mode === 'normal';
          assert.equal(event.defaultPrevented, handled, name + ' preventDefault');
          assert.equal(event.dispatched, !handled, name + ' dispatch result');
          assert.equal(state.calls.length, handled ? 1 : 0, name + ' host calls');
          if (handled) {
            assert.equal(state.calls[0].method, kind === 'agent' ? 'createSession' : 'createTerminal', name);
            assert.equal(state.view, 'chat', name + ' real store view');
            const id = kind === 'agent' ? state.sessions[0]?.id : state.terminals[0]?.id;
            assert.ok(id, name + ' real store record');
            assert.ok(JSON.stringify(state.workspaces).includes(`"refId":"${id}"`), name + ' real pane');
            assert.ok(state.activeWorkspaceId, name + ' active workspace');
            if (kind === 'agent') {
              assert.equal(state.activeSessionId, id);
              assert.equal(state.calls[0].workspaceId, 'synthetic-project');
            } else assert.equal(state.calls[0].options.workspaceId, 'synthetic-project');
          } else assert.equal(state.workspaces.length, 0, name + ' no pane');
          report.checks.push({ name, passed: true, event, state });
        }
      }
    }
    for (const init of [{ key: 't' }, { key: 'T', shiftKey: true }, { key: 'n', ctrlKey: true, shiftKey: true }, { key: 'x', metaKey: true }]) {
      await run('shortcutTest.reset()');
      const event = await run(`shortcutTest.dispatch(${JSON.stringify(init)})`); await sleep(100);
      assert.equal(event.defaultPrevented, false); assert.equal((await run('shortcutTest.snapshot()')).calls.length, 0);
      report.checks.push({ name: `unmatched ${JSON.stringify(init)}`, passed: true });
    }
    assert.equal(win.isVisible(), false); assert.equal(win.isFocusable(), false);
    assert.deepEqual(report.errors, []);
    console.log(`PASS: ${report.checks.length} App KeyboardEvent-to-real-store cases; hidden, isolated, network blocked.`);
  } catch (e) { report.errors.push(e.stack); console.error(e); process.exitCode = 1; }
  finally {
    fs.writeFileSync(path.join(out, 'results.json'), JSON.stringify(report, null, 2));
    win.destroy(); app.quit();
  }
});
