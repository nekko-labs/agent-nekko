import React, { useEffect, useRef, useState } from 'react';
import type { TerminalEvent, TerminalInfo, TerminalStream, TerminalRenderer } from '@agent-nekko/shared';
import '@xterm/xterm/css/xterm.css';
import { PaneActions, useInPaneFrame } from './PaneFrame.js';
import { useStore } from '../store.js';

/**
 * A real terminal wired to a pty. Keystrokes stream to the pty and raw output
 * streams back, so tab-completion, powerline prompts, zsh plugins, and
 * full-screen TUIs (vim, htop, lazygit) all work as they would in a native
 * terminal.
 *
 * Two renderers, one surface. The default is xterm.js on its WebGL renderer.
 * ghostty-web (Ghostty's own terminal core compiled to WebAssembly, drawing to
 * a canvas) is an experimental opt-in: it parses correctly and renders well,
 * but measured under a 40 MB flood it kept the UI thread busy 20-30 ms a
 * frame, against xterm's one frame, so it does not meet the speed contract
 * yet. A ghostty terminal falls back to xterm if its WebAssembly cannot load.
 * Both implement the slice of xterm's API this pane uses.
 *
 * Two data paths. On the desktop the engine daemon streams each terminal on
 * its own socket: output arrives at most once per frame, and every chunk is
 * acknowledged once parsed so a flood slows the program instead of this pane
 * (see `nekko_term::session`). Elsewhere (the web edition, the agent command
 * log) output rides the shared event bus as before.
 */

/**
 * Text fonts first, then the Nerd Fonts prompt themes (oh-my-posh, starship,
 * powerlevel10k) draw their segment glyphs with. Those glyphs live in the
 * Private Use Area, which no text font covers; xterm.js draws the powerline
 * shapes itself, but ghostty-web takes every glyph from the font stack, so
 * without a Nerd Font on this list a themed prompt renders as boxes. Only
 * installed fonts are used, so listing absent ones costs nothing.
 */
const MONO = [
  'ui-monospace',
  'SFMono-Regular',
  '"SF Mono"',
  'Menlo',
  '"Cascadia Mono"',
  'Consolas',
  '"Liberation Mono"',
  '"Symbols Nerd Font Mono"',
  '"CaskaydiaCove Nerd Font Mono"',
  '"CaskaydiaCove NFM"',
  '"CaskaydiaCove NF"',
  '"Hack Nerd Font Mono"',
  '"JetBrainsMono Nerd Font Mono"',
  '"MesloLGS NF"',
  '"FiraCode Nerd Font Mono"',
  'monospace',
].join(', ');

/** Build a terminal theme from the app's CSS variables (tracks light/dark). */
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

interface Disposable {
  dispose(): void;
}

/** The part of the xterm.js API both renderers implement. */
interface TermSurface {
  cols: number;
  rows: number;
  options: { theme?: unknown; disableStdin?: boolean; cursorBlink?: boolean };
  open(el: HTMLElement): void;
  write(data: string | Uint8Array, callback?: () => void): void;
  onData(cb: (data: string) => void): Disposable;
  onResize(cb: (size: { cols: number; rows: number }) => void): Disposable;
  loadAddon(addon: unknown): void;
  focus(): void;
  reset(): void;
  dispose(): void;
}

interface Mounted {
  term: TermSurface;
  fit: { fit(): void };
  kind: TerminalRenderer;
}

/** ghostty-web's WebAssembly module, loaded once per page. */
let ghosttyReady: Promise<typeof import('ghostty-web')> | null = null;
function loadGhostty() {
  ghosttyReady ??= import('ghostty-web').then(async (g) => {
    await g.init();
    return g;
  });
  return ghosttyReady;
}

async function mountTerminal(el: HTMLElement, prefer: TerminalRenderer, readOnly: boolean): Promise<Mounted> {
  const options = {
    fontFamily: MONO,
    fontSize: 13,
    cursorBlink: !readOnly,
    disableStdin: readOnly,
    scrollback: 5000,
    theme: readTheme(),
  };
  if (prefer === 'ghostty') {
    try {
      const g = await loadGhostty();
      const term = new g.Terminal(options) as unknown as TermSurface;
      const fit = new g.FitAddon();
      term.loadAddon(fit);
      term.open(el);
      return { term, fit, kind: 'ghostty' };
    } catch (err) {
      ghosttyReady = null;
      console.warn('ghostty-web could not start; using xterm.js', err);
    }
  }
  const [{ Terminal }, { FitAddon }, { WebLinksAddon }] = await Promise.all([
    import('@xterm/xterm'),
    import('@xterm/addon-fit'),
    import('@xterm/addon-web-links'),
  ]);
  const term = new Terminal({ ...options, lineHeight: 1.2, allowProposedApi: true }) as unknown as TermSurface;
  const fit = new FitAddon();
  term.loadAddon(fit);
  term.loadAddon(new WebLinksAddon((_, uri) => window.nekko.openPath(uri)));
  term.open(el);
  try {
    // GPU rendering; on a lost context (driver reset, too many contexts) the
    // addon is dropped and xterm carries on with its DOM renderer.
    const { WebglAddon } = await import('@xterm/addon-webgl');
    const webgl = new WebglAddon();
    webgl.onContextLoss(() => webgl.dispose());
    term.loadAddon(webgl);
  } catch {
    /* no WebGL here: the DOM renderer still works */
  }
  return { term, fit, kind: 'xterm' };
}

export function TerminalPane({ terminalId }: { terminalId: string }) {
  const hostRef = useRef<HTMLDivElement>(null);
  const [info, setInfo] = useState<TerminalInfo | null>(null);
  const prefer = useStore((s) => s.settings?.terminal?.renderer) ?? 'xterm';

  useEffect(() => {
    const el = hostRef.current;
    if (!el) return;
    const readOnly = terminalId.startsWith('agent_');
    let disposed = false;
    const cleanups: (() => void)[] = [];

    void (async () => {
      const { term, fit, kind } = await mountTerminal(el, prefer, readOnly);
      if (disposed) {
        term.dispose();
        return;
      }
      cleanups.push(() => term.dispose());
      try { fit.fit(); } catch { /* not laid out yet */ }
      term.focus();

      const exited = (code: number | null | undefined) => {
        setInfo((i) => (i ? { ...i, running: false, exitCode: code ?? undefined } : i));
        const suffix = code == null ? '' : ` with code ${code}`;
        term.write(`\r\n\x1b[2m[process exited${suffix}]\x1b[0m\r\n`);
      };

      // Parsed output is acknowledged so the daemon can send more. ghostty-web
      // parses synchronously (its callback waits for a paint, which a hidden
      // pane never gets), so it acks at once; xterm parses in slices and acks
      // from its callback.
      let stream: TerminalStream | null = null;
      const write = (bytes: Uint8Array) => {
        if (kind === 'ghostty') {
          term.write(bytes);
          stream?.ack(bytes.length);
        } else {
          term.write(bytes, () => stream?.ack(bytes.length));
        }
      };
      let reconnect: ReturnType<typeof setTimeout> | undefined;
      const attach = async (again: boolean): Promise<boolean> => {
        const s =
          (await window.nekko.openTerminalStream?.(terminalId, {
            onHello: (hello) => {
              // A reattach replays the scrollback from the top.
              if (again) term.reset();
              if (hello.info) setInfo(hello.info);
              stream?.resize(term.cols, term.rows);
            },
            onData: write,
            onExit: exited,
            onClose: () => {
              if (!disposed) reconnect = setTimeout(() => void attach(true), 300);
            },
          })) ?? null;
        if (disposed) {
          s?.close();
          return false;
        }
        stream = s;
        return Boolean(s);
      };
      const streamed = !readOnly && (await attach(false).catch(() => false));
      if (disposed) return;
      cleanups.push(() => {
        clearTimeout(reconnect);
        stream?.close();
      });

      if (!streamed) {
        // Agent logs are created lazily and live only in backend memory. A
        // missing snapshot is not a broken renderer (or a persisted chat log).
        let receivedData = false;
        let showingNotice = false;
        const notice = (message: string) => {
          if (disposed || receivedData) return;
          showingNotice = true;
          term.write(`\x1b[2m${message}\x1b[0m\r\n`);
        };
        // Restore scrollback, then size the pty to our fitted viewport.
        window.nekko.terminalSnapshot(terminalId).then((snap) => {
          if (disposed) return;
          if (!snap) {
            if (readOnly) notice('No command output available. Only shell commands appear here; logs are kept in memory and cleared when the backend restarts.');
            return;
          }
          setInfo(snap.info);
          if (snap.info.agentSessionId) {
            term.options.disableStdin = true;
            term.options.cursorBlink = false;
          }
          if (snap.buffer) term.write(snap.buffer);
          else if (readOnly) notice('No shell command output yet.');
          window.nekko.resizeTerminal(terminalId, term.cols, term.rows);
        }).catch(() => notice('Terminal output unavailable. Close and reopen this pane to retry.'));
        const offEvent = window.nekko.onTerminalEvent((e: TerminalEvent) => {
          if (!('terminalId' in e) || e.terminalId !== terminalId) return;
          if (e.type === 'data') {
            if (readOnly) setInfo((i) => i ? { ...i, running: true, exitCode: undefined } : i);
            receivedData = true;
            if (showingNotice) { term.reset(); showingNotice = false; }
            term.write(e.data);
          }
          else if (e.type === 'exit') exited(e.code);
        });
        cleanups.push(offEvent);
      }

      // Renderer → pty.
      const onData = term.onData((d) => (stream ? stream.write(d) : window.nekko.writeTerminal(terminalId, d)));
      const onResize = term.onResize(({ cols, rows }) =>
        stream ? stream.resize(cols, rows) : window.nekko.resizeTerminal(terminalId, cols, rows),
      );
      cleanups.push(() => onData.dispose(), () => onResize.dispose());

      // Keep the terminal (and the pty) fitted to the container as panes split/resize.
      const ro = new ResizeObserver(() => { try { fit.fit(); } catch { /* hidden */ } });
      ro.observe(el);
      cleanups.push(() => ro.disconnect());

      // Re-theme when the app toggles light/dark or switches theme presets.
      const themeObs = new MutationObserver(() => { term.options.theme = readTheme(); });
      themeObs.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme', 'data-preset'] });
      cleanups.push(() => themeObs.disconnect());
    })();

    return () => {
      disposed = true;
      // Last in, first out: listeners and sockets before the terminal itself.
      cleanups.reverse().forEach((fn) => fn());
    };
  }, [terminalId, prefer]);

  // Inside a workspace the frame already draws the window's title strip, so the
  // cwd line rides in that one bar instead of stacking a second bar (and a
  // second border) under it: a terminal used to read as two headers while every
  // other window read as one.
  const framed = useInPaneFrame();
  const status = (
    <span className="flex items-center gap-2 text-[11px] text-ink-faint">
      <span className="max-w-[26ch] truncate font-mono">{info?.cwd ?? ''}</span>
      {info && !info.running && (
        <span className="shrink-0 text-red-400">shell exited{info.exitCode != null ? ` (${info.exitCode})` : ''}</span>
      )}
    </span>
  );

  return (
    <div className="flex h-full flex-col overflow-hidden" style={{ background: 'var(--surface-2)' }}>
      {framed ? (
        <PaneActions>{status}</PaneActions>
      ) : (
        <div className="flex shrink-0 items-center justify-between border-b border-line px-3 py-1.5">{status}</div>
      )}
      <div ref={hostRef} className="min-h-0 flex-1 px-2 py-1" />
    </div>
  );
}
