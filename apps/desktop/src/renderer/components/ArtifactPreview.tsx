import React, { useEffect, useId, useState } from 'react';

/** Untrusted documents get an opaque origin, no app bridge, and no network. */
export function isolatedDocument(source: string): string {
  return `<!doctype html><meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data: blob:; font-src data:; connect-src 'none'; form-action 'none'; base-uri 'none'"><meta name="referrer" content="no-referrer">${source}`;
}

export function ArtifactPreview({ source, title = 'Design preview' }: { source: string; title?: string }) {
  const [width, setWidth] = useState('100%');
  const [interactive, setInteractive] = useState(false);
  return <div className="flex h-full min-h-96 flex-col gap-2 p-3">
    <div className="flex flex-wrap items-center gap-2 text-[12px]">
      <strong>{title}</strong>
      <select aria-label="Preview viewport" className="input w-auto" value={width} onChange={(e) => setWidth(e.target.value)}>
        <option value="100%">Fit</option><option value="375px">Phone · 375</option><option value="768px">Tablet · 768</option><option value="1280px">Desktop · 1280</option>
      </select>
      <button className="chip chip-action" aria-pressed={interactive} onClick={() => setInteractive(!interactive)}>{interactive ? 'Disable interactions' : 'Enable interactions'}</button>
      <span className="text-ink-faint">Isolated · network blocked</span>
    </div>
    <div className="min-h-96 flex-1 overflow-auto rounded-lg border border-line bg-surface-2">
      <iframe key={String(interactive)} title={title} sandbox={interactive ? 'allow-scripts' : ''} referrerPolicy="no-referrer"
        srcDoc={isolatedDocument(source)} style={{ width, height: '100%', minHeight: 480, border: 0, background: 'white' }} />
    </div>
  </div>;
}

let mermaidQueue: Promise<unknown> = Promise.resolve();
export function MermaidDiagram({ code }: { code: string }) {
  const id = useId().replace(/[^a-zA-Z0-9]/g, '');
  const [svg, setSvg] = useState('');
  const [error, setError] = useState('');
  useEffect(() => {
    let live = true;
    setSvg(''); setError('');
    if (code.length > 30_000) { setError('Diagram exceeds the 30 KB preview limit.'); return; }
    mermaidQueue = mermaidQueue.catch(() => {}).then(async () => {
      if (!live) return;
      try {
        const { default: mermaid } = await import('mermaid');
        mermaid.initialize({ startOnLoad: false, securityLevel: 'strict', maxTextSize: 30_000, suppressErrorRendering: true });
        const result = await mermaid.render(`diagram${id}`, code);
        if (live) setSvg(result.svg);
      } catch { if (live) setError('Diagram could not be rendered. Check the Mermaid source below.'); }
    });
    return () => { live = false; };
  }, [code, id]);
  return <div className="my-2 rounded-xl border border-line p-3">
    {error ? <p role="status" className="text-[12px] text-ink-soft">{error}</p> : svg
      ? <iframe title="Mermaid diagram" sandbox="" srcDoc={isolatedDocument(svg)} className="h-80 w-full border-0 bg-white" />
      : <p className="text-[12px] text-ink-faint">Rendering diagram…</p>}
    <details><summary className="cursor-pointer text-[12px]">Mermaid source</summary><pre className="overflow-auto text-[12px]">{code}</pre></details>
  </div>;
}
