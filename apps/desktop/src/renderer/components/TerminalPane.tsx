import React, { useEffect, useRef, useState } from 'react';
import type { TerminalEvent, TerminalInfo } from '@agent-nekko/shared';
import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import { WebLinksAddon } from '@xterm/addon-web-links';
import '@xterm/xterm/css/xterm.css';

/**
 * A real terminal: xterm.js wired to a host-side PTY. Keystrokes stream to the
 * pty and raw output streams back, so tab-completion, powerline prompts, zsh
 * plugins, and full-screen TUIs (vim, htop, lazygit) all work as they would in a
 * native terminal. The host retains scrollback so reattaching a tab restores the
 * screen, and we keep the pty sized to the visible viewport.
 */

const MONO = 'ui-monospace, SFMono-Regular, "SF Mono", Menlo, Consolas, "Liberation Mono", monospace';

/** Build an xterm theme from the app's CSS variables (tracks light/dark). */
function readTheme(): Record<string, string> {
  const cs = getComputedStyle(document.documentElement);
  const v = (name: string, fallback: string) => cs.getPropertyValue(name).trim() || fallback;
  const ink = v('--ink', '#17171d');
  const accent = v('--accent', '#6d5efc');
  return {
    background: v('--surface-2', '#f2f2f7'),
    foreground: ink,
    cursor: accent,
    cursorAccent: v('--paper', '#fafaf8'),
    selectionBackground: v('--ring', 'rgba(109,94,252,0.35)'),
  };
}

export function TerminalPane({ terminalId }: { terminalId: string }) {
  const hostRef = useRef<HTMLDivElement>(null);
  const [info, setInfo] = useState<TerminalInfo | null>(null);

  useEffect(() => {
    const el = hostRef.current;
    if (!el) return;

    const term = new Terminal({
      fontFamily: MONO,
      fontSize: 13,
      lineHeight: 1.2,
      cursorBlink: true,
      allowProposedApi: true,
      scrollback: 5000,
      theme: readTheme(),
    });
    const fit = new FitAddon();
    term.loadAddon(fit);
    term.loadAddon(new WebLinksAddon((_, uri) => window.nekko.openPath(uri)));
    term.open(el);
    try { fit.fit(); } catch { /* not laid out yet */ }
    term.focus();

    // Restore scrollback, then size the pty to our fitted viewport.
    window.nekko.terminalSnapshot(terminalId).then((snap) => {
      if (!snap) return;
      setInfo(snap.info);
      if (snap.buffer) term.write(snap.buffer);
      window.nekko.resizeTerminal(terminalId, term.cols, term.rows);
    }).catch(() => {});

    // Renderer → pty.
    const onData = term.onData((d) => window.nekko.writeTerminal(terminalId, d));
    const onResize = term.onResize(({ cols, rows }) => window.nekko.resizeTerminal(terminalId, cols, rows));

    // pty → renderer.
    const offEvent = window.nekko.onTerminalEvent((e: TerminalEvent) => {
      if (!('terminalId' in e) || e.terminalId !== terminalId) return;
      if (e.type === 'data') term.write(e.data);
      else if (e.type === 'exit') {
        setInfo((i) => (i ? { ...i, running: false, exitCode: e.code ?? undefined } : i));
        const code = e.code == null ? '' : ` with code ${e.code}`;
        term.write(`\r\n\x1b[2m[process exited${code}]\x1b[0m\r\n`);
      }
    });

    // Keep xterm (and the pty) fitted to the container as panes split/resize.
    const ro = new ResizeObserver(() => { try { fit.fit(); } catch { /* hidden */ } });
    ro.observe(el);

    // Re-theme when the app toggles light/dark or switches theme presets.
    const themeObs = new MutationObserver(() => { term.options.theme = readTheme(); });
    themeObs.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme', 'data-preset'] });

    return () => {
      onData.dispose();
      onResize.dispose();
      offEvent();
      ro.disconnect();
      themeObs.disconnect();
      term.dispose();
    };
  }, [terminalId]);

  return (
    <div className="flex h-full flex-col overflow-hidden" style={{ background: 'var(--surface-2)' }}>
      <div className="flex items-center justify-between border-b border-line px-3 py-1.5 text-[11px] text-ink-faint">
        <span className="truncate font-mono">{info?.cwd ?? ''}</span>
        {info && !info.running && (
          <span className="text-red-400">shell exited{info.exitCode != null ? ` (${info.exitCode})` : ''}</span>
        )}
      </div>
      <div ref={hostRef} className="min-h-0 flex-1 px-2 py-1" />
    </div>
  );
}
