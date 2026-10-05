/** Read-only two-line excerpt, not a terminal emulator. CR resets the cursor. */
export function terminalExcerpt(buffer: string): string {
  const clean = buffer.replace(/\x1b\][^\x07]*(?:\x07|\x1b\\)/g, '').replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, '');
  const lines: string[] = [];
  let line: string[] = [], cursor = 0;
  for (const char of clean) {
    if (char === '\r') { cursor = 0; continue; }
    if (char === '\n') { lines.push(line.join('').trimEnd()); line = []; cursor = 0; continue; }
    if (char === '\b') { cursor = Math.max(0, cursor - 1); continue; }
    if (char < ' ' && char !== '\t') continue;
    line[cursor++] = char;
  }
  lines.push(line.join('').trimEnd());
  while (lines.length && !lines[lines.length - 1]) lines.pop();
  return lines.slice(-2).join('\n') || 'No output yet';
}
