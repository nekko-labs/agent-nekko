// Isolated real-editor fixture: no host bridge, network, or system clipboard writes.
const fs = require('node:fs');
const path = require('node:path');
const cp = require('node:child_process');
const root = path.resolve(__dirname, '../../..');
const out = path.join(root, '.shots/composer-editing');
if (!process.versions.electron) {
  fs.mkdirSync(out, { recursive: true });
  const editor = path.join(root, 'apps/desktop/src/renderer/components/agent-console/MarkdownEditor.tsx');
  const baseline = path.join(path.dirname(editor), '.composer-baseline.tsx');
  fs.writeFileSync(baseline, cp.execFileSync('git', ['show', 'HEAD:apps/desktop/src/renderer/components/agent-console/MarkdownEditor.tsx'], { cwd: root }));
  const esbuild = require('esbuild');
  try {
    for (const [name, source] of [['before', baseline], ['after', editor]]) {
      const entry = path.join(out, `${name}.tsx`);
      fs.writeFileSync(entry, `import React, {useState} from 'react'; import {createRoot} from 'react-dom/client'; import {MarkdownEditor} from ${JSON.stringify(source)}; ${name === 'after' ? `import {clipboardMarkdown} from ${JSON.stringify(path.join(path.dirname(editor), 'composerFormatting.ts'))}; window.convert=clipboardMarkdown;` : ''} function App(){const [value,setValue]=useState('hello world');const [disabled,setDisabled]=useState(false);window.disableEditor=setDisabled;return <MarkdownEditor value={value} onChange={setValue} onPaste={e=>{if(e.clipboardData.files.length){e.preventDefault();window.imageCount=e.clipboardData.files.length;}}} onKeyDown={()=>{}} className="editor" placeholder="Message" disabled={disabled} aria-expanded={false}/>;} createRoot(document.getElementById('root')).render(<App/>);`);
      esbuild.buildSync({ entryPoints: [entry], bundle: true, outfile: path.join(out, `${name}.js`), platform: 'browser' });
      fs.writeFileSync(path.join(out, `${name}.html`), `<style>:root{--paper:#fff;--ink:#222;--surface-2:#ddd}body{margin:120px 24px;background:var(--paper);color:var(--ink);font:14px system-ui} .editor{white-space:pre-wrap;border:1px solid #999;padding:16px;min-height:120px}.fixed{position:fixed}.flex{display:flex}.flex-wrap{flex-wrap:wrap}.card{border:1px solid #999;border-radius:8px}button{padding:8px;border:0;background:transparent;color:inherit;cursor:pointer}button[aria-pressed=true]{outline:1px solid #777}button[role=menuitem]{display:block;width:100%;text-align:left}button:disabled{opacity:.4}</style><div id="root"></div><script src="${name}.js"></script>`);
    }
  } finally { fs.unlinkSync(baseline); }
  const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE;
  const result = cp.spawnSync(require('electron'), [__filename], { cwd: root, encoding: 'utf8', env, timeout: 90000 });
  console.log(result.stdout); console.error(result.stderr); process.exit(result.status ?? 1);
} else {
  const { app, BrowserWindow, session } = require('electron');
  app.setPath('userData', path.join(out, 'profile')); app.setPath('sessionData', path.join(out, 'profile'));
  app.whenReady().then(async () => {
    // A partition isolates browser storage, NOT the OS clipboard. Never perform
    // native copy/write/clear here: Windows has no private selection clipboard and
    // Electron cannot guarantee preservation of every native clipboard format.
    const partition = `composer-verification-${process.pid}`;
    const isolated = session.fromPartition(partition, { cache: false });
    const permissions = [];
    isolated.webRequest.onBeforeRequest((d, done) => done({ cancel: !/^(file:|data:|blob:)/.test(d.url) }));
    isolated.setPermissionCheckHandler((_w, permission) => { permissions.push({ kind: 'check', permission }); return false; });
    isolated.setPermissionRequestHandler((_w, permission, done) => { permissions.push({ kind: 'request', permission }); done(false); });
    const win = new BrowserWindow({ width: 900, height: 600, show: false, title: 'Isolated composer verification', webPreferences: { partition, sandbox: true, contextIsolation: true, nodeIntegration: false } });
    const run = text => win.webContents.executeJavaScript(text, true);
    const wait = () => new Promise(r => setTimeout(r, 150));
    const checks = [];
    const check = async (name, expr) => { await wait(); if (!await run(expr)) throw Error(name); checks.push(name); };
    const select = async (a, b) => { await run(`window.el=document.querySelector('[contenteditable]'); el.focus(); el.setSelectionRange(${a},${b})`); await wait(); };
    const context = async () => { await run("el.dispatchEvent(new MouseEvent('contextmenu',{bubbles:true,cancelable:true,clientX:90,clientY:200}))"); await wait(); };
    const click = async label => { await run(`[...document.querySelectorAll('button')].find(b=>b.textContent===${JSON.stringify(label)}||b.getAttribute('aria-label')===${JSON.stringify(label)}).click()`); await wait(); };
    let nativeClipboard;
    try {
      await win.loadFile(path.join(out, 'after.html')); await wait();
      // Denied native reads only: discard any unexpected result, never log user data.
      nativeClipboard = await run(`(async()=>{
        const result = { secureContext: isSecureContext, read: typeof navigator.clipboard?.read, readText: typeof navigator.clipboard?.readText, outcomes: {} };
        for (const method of ['read', 'readText']) {
          if (typeof navigator.clipboard?.[method] !== 'function') { result.outcomes[method] = 'unavailable'; continue; }
          try { await navigator.clipboard[method](); result.outcomes[method] = 'unexpected success (contents discarded)'; }
          catch (e) { result.outcomes[method] = e.name; }
        }
        return result;
      })()`);
      nativeClipboard.permissions = permissions;
      if (Object.values(nativeClipboard.outcomes).some(value => value.startsWith('unexpected'))) throw Error('Native read permission isolation failed');
      await select(0, 5); await context(); await click('Paste');
      await check('native denied paste reports failure without mutation', "!!document.querySelector('[role=alert]') && el.value==='hello world'");
      for (const name of ['before', 'after']) {
        await win.loadFile(path.join(out, `${name}.html`)); await wait();
        for (const theme of ['light', 'dark']) {
          await run(`document.documentElement.style.setProperty('--paper','${theme === 'light' ? '#fff' : '#222'}');document.documentElement.style.setProperty('--ink','${theme === 'light' ? '#222' : '#eee'}')`);
          for (const width of [900, 400]) {
            win.setContentSize(width, 600); await select(0, 5);
            if (name === 'after') await context();
            fs.writeFileSync(path.join(out, `${name}-${theme}-${width}.png`), (await win.webContents.capturePage()).toPNG());
            if (name === 'after') { await run("document.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true}))"); await wait(); }
          }
        }
      }
      await select(0, 5);
      await check('selection toolbar appears', "!!document.querySelector('[data-composer-toolbar]')");
      await click('Bold');
      await check('selection formatting preserves content', "el.value==='**hello** world' && el.selectionStart===2 && el.selectionEnd===7");
      await context();
      await check('bold active in context menu', "document.querySelector('[aria-label=Bold]').getAttribute('aria-pressed')==='true'");
      await click('Bold'); await check('toggle removes marks', "el.value==='hello world'");
      await run(`Object.defineProperty(navigator,'clipboard',{configurable:true,value:{readText:async()=> 'plain\\r\\ntext',writeText:async t=>window.copied=t,read:async()=>[{types:['text/plain','text/html'],getType:async t=>new Blob([t==='text/html'?'<p><strong>rich</strong> <a href="https://example.com">link</a></p>':'rich link'])}]}})`);
      await select(0, 5); await context(); await click('Copy'); await check('copy selected Markdown source', "window.copied==='hello'");
      await context(); await click('Paste as Markdown'); await check('rich paste converts to Markdown', "el.value==='**rich** [link](https://example.com) world'");
      await select(0, 35); await context(); await click('Paste without formatting');
      await check('plain paste normalizes newlines', "el.value.startsWith('plain\\ntext')");
      await run("el.dispatchEvent(new KeyboardEvent('keydown',{key:'z',ctrlKey:true,bubbles:true,cancelable:true}))");
      await check('paste uses editor undo', "el.value==='**rich** [link](https://example.com) world'");
      await check('conversion strips unsafe resources and links', `window.convert('<script>bad()</script><img src="https://invalid"><a href="javascript:bad()">safe</a>','')==='safe'`);
      await check('conversion preserves code and list structure', "window.convert('<ol><li>one</li><li>two</li></ol><pre><code>a*b</code></pre>','')==='1. one\\n2. two\\n\\n```\\na*b\\n```'");
      await run("Object.defineProperty(navigator,'clipboard',{configurable:true,value:{readText:async()=>{throw Error('denied')}}})");
      await context(); await click('Paste without formatting'); await check('permission failure shown without mutation', "!!document.querySelector('[role=alert]') && el.value==='**rich** [link](https://example.com) world'");
      await run("Object.defineProperty(navigator,'clipboard',{configurable:true,value:{read:async()=>[{types:['image/png'],getType:async()=>new Blob(['fixture'],{type:'image/png'})}]}})");
      await click('Paste'); await check('ordinary image paste reuses attachment handler', "window.imageCount===1 && el.value==='**rich** [link](https://example.com) world'");
      await run("Object.defineProperty(navigator,'clipboard',{configurable:true,value:{read:async()=>[{types:['text/plain'],getType:async()=>new Blob(['ordinary'])}]}})");
      await select(0, 8); await context(); await click('Paste'); await check('ordinary paste inserts plain text', "el.value.startsWith('ordinary')");
      for (const label of ['Paste', 'Paste as Markdown']) {
        for (const read of ['missing', 'rejecting']) {
          await run(`window.fallbackCalls=0; Object.defineProperty(navigator,'clipboard',{configurable:true,value:{${read === 'rejecting' ? "read:async()=>{throw new DOMException('fixture denied','NotAllowedError')}," : ''}readText:async()=>{window.fallbackCalls++;return 'fallback\\r\\ntext'}}})`);
          await select(0, 0); await context(); await click(label);
          await check(`${label}: ${read} read falls back to readText`, "window.fallbackCalls===1 && el.value.startsWith('fallback\\ntext') && !document.querySelector('[role=alert]')");
        }
      }
      const unchanged = await run('el.value');
      await run("Object.defineProperty(navigator,'clipboard',{configurable:true,value:{read:async()=>{throw Error('denied')},readText:async()=>{throw Error('denied')}}})");
      await select(0, 0); await context(); await click('Paste');
      await check('both read APIs denied leave editor unchanged', `!!document.querySelector('[role=alert]') && el.value===${JSON.stringify(unchanged)}`);
      await run("document.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true}))");
      await select(0, 8); await run("document.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true}))"); await check('Escape dismisses selection toolbar', "!document.querySelector('[data-composer-toolbar]')");
      await select(0, 0); await context(); await check('Copy disabled at collapsed caret', "[...document.querySelectorAll('button')].find(b=>b.textContent==='Copy').disabled");
      await run('window.disableEditor(true)'); await wait(); await context(); await check('disabled editor exposes no editing menu or toolbar', "!document.querySelector('[role=menu]') && !document.querySelector('[data-composer-toolbar]')");
      fs.writeFileSync(path.join(out, 'status.json'), JSON.stringify({ success: true, checks, nativeClipboard, nativeWrites: 'not attempted: all-format preservation cannot be guaranteed on Windows', mockedClipboard: true, visualInspection: false }, null, 2));
      console.log(JSON.stringify({ success: true, checks, out }, null, 2)); win.destroy(); app.exit(0);
    } catch (e) { console.error(e); win.destroy(); app.exit(1); }
  });
}
