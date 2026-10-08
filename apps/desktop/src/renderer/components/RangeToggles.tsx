import React from 'react';
import { INSIGHT_RANGES, type InsightRange } from '../insightRanges.js';

/** The time-range filter the Insights charts share, also used by the wall's Budget panel. */
export function RangeToggles({ range, onChange, chart }: { range: InsightRange; onChange: (range: InsightRange) => void; chart: string }) {
  return (
    <div className="mt-2 flex flex-wrap gap-1" role="group" aria-label={`${chart} time range`}>
      {INSIGHT_RANGES.map((value) => (
        <button key={value} type="button" aria-pressed={range === value} onClick={() => onChange(value)}
          className={`rounded-md px-2 py-1 text-[11px] ${range === value ? 'bg-surface-2 font-semibold text-ink' : 'text-ink-faint hover:bg-surface-2 hover:text-ink'}`}>
          {value}
        </button>
      ))}
    </div>
  );
}
