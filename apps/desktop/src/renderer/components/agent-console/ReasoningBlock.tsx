import { useState } from 'react';
import { ThoughtIcon } from '../../icons.js';

/** Compact thinking indicator — matches tool card style. */
export function ReasoningBlock({ text, live, duration }: { text: string; live: boolean; duration: number | null }) {
  const [open, setOpen] = useState(false);
  return (
    <div className="mt-1">
      <button
        className="flex w-full items-center gap-1.5 py-0.5 text-left text-[12px] font-mono text-ink-faint hover:text-ink-soft"
        onClick={() => setOpen((o) => !o)}
        aria-expanded={open}
      >
        <span className="w-3 shrink-0 text-[10px]">{open ? '▾' : '▸'}</span>
        <ThoughtIcon className="h-3 w-3 shrink-0" />
        <span>{live ? 'Thinking…' : duration != null ? `Thought for ${duration}s` : 'Thought process'}</span>
      </button>
      {open && <pre className="ml-[18px] mt-0.5 max-h-60 overflow-y-auto whitespace-pre-wrap border-l border-line pl-2 text-[12px] font-mono leading-relaxed text-ink-faint">{text}</pre>}
    </div>
  );
}
