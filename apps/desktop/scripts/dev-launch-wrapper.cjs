const { spawn } = require('node:child_process');
const { readFileSync, unlinkSync } = require('node:fs');
const { randomUUID } = require('node:crypto');
const { join } = require('node:path');

exports.launch = (bundle, cache) => {
  const token = randomUUID(), file = join(cache, `launch-${token}.json`);
  const args = ['-n', '-W', '-a', bundle];
  const env = { ...process.env, NEKKO_DEV_PID_FILE: file, NEKKO_DEV_LAUNCH_TOKEN: token };
  for (const key of ['PATH', 'HOME', 'ELECTRON_RENDERER_URL', 'NODE_ENV', 'NODE_ENV_ELECTRON_VITE', 'NEKKO_DATA_DIR', 'NEKKO_DEV_OWNER', 'NEKKO_DEV_PID_FILE', 'NEKKO_DEV_LAUNCH_TOKEN']) {
    if (env[key]) args.push('--env', key + '=' + env[key]);
  }
  args.push('--args', ...process.argv.slice(2).map(a => a === '.' ? process.cwd() : a));
  const child = spawn('/usr/bin/open', args, { stdio: 'inherit' });
  let stopping = false;
  const stop = () => {
    if (stopping) return;
    stopping = true;
    const started = Date.now();
    const timer = setInterval(() => {
      try {
        const receipt = JSON.parse(readFileSync(file, 'utf8'));
        if (receipt.token === token && Number.isInteger(receipt.pid) && receipt.pid > 0) {
          process.kill(receipt.pid, 'SIGTERM');
          clearInterval(timer);
        }
      } catch { /* the app may still be starting */ }
      if (Date.now() - started > 5000) { clearInterval(timer); child.kill(); }
    }, 50);
  };
  process.on('SIGTERM', stop);
  process.on('SIGINT', stop);
  child.on('error', error => { console.error(error); process.exitCode = 1; });
  child.on('exit', code => { try { unlinkSync(file); } catch {} process.exit(code ?? 1); });
};
