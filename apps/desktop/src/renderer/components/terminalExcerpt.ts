/** A text preview, not a terminal emulator: keep the latest CR progress update. */
export function terminalExcerpt(buffer: string): string {
  const text = buffer.replace(/\x1b\][^\x07]*(?:\x07|\x1b\\)/g, '').replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, '');
  const lines: string[] = [];
  let line = '';
  for (let i = 0; i < text.length; i++) {
    const char = text[i];
    if (char === '\r' && text[i + 1] !== '\n') line = '';
    else if (char === '\n') { lines.push(line); line = ''; }
    else if (char === '\b') line = line.slice(0, -1);
    else if (char !== '\r') line += char;
  }
  if (line.trimEnd()) lines.push(line);
  return lines.slice(-2).join('\n').trimEnd() || 'No output yet';
}
