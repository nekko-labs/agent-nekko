const { execFileSync } = require('node:child_process');

/** Reject malformed sandbox code before Electron can show a main-process dialog. */
function checkSandboxSyntax(file) {
  execFileSync(process.execPath, ['--check', file], { stdio: 'pipe' });
}

module.exports = { checkSandboxSyntax };
