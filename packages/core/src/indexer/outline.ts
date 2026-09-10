import type { CodeSymbol } from '@agent-nekko/shared';

/** Map file extensions to a language label. */
export function detectLanguage(path: string): string | undefined {
  const ext = path.split('.').pop()?.toLowerCase();
  const map: Record<string, string> = {
    ts: 'typescript', tsx: 'typescript', js: 'javascript', jsx: 'javascript', mjs: 'javascript',
    py: 'python', rs: 'rust', go: 'go', java: 'java', rb: 'ruby', php: 'php', cs: 'csharp',
    cpp: 'cpp', c: 'c', h: 'c', swift: 'swift', kt: 'kotlin', md: 'markdown', json: 'json',
    css: 'css', html: 'html', vue: 'vue', sh: 'shell',
  };
  return ext ? map[ext] : undefined;
}

interface Pattern {
  re: RegExp;
  kind: CodeSymbol['kind'];
  group: number;
}

/** Lightweight, dependency-free symbol patterns per language family. */
const PATTERNS: Record<string, Pattern[]> = {
  typescript: [
    { re: /^\s*(?:export\s+)?(?:default\s+)?(?:async\s+)?function\s+([A-Za-z0-9_$]+)/, kind: 'function', group: 1 },
    { re: /^\s*(?:export\s+)?(?:abstract\s+)?class\s+([A-Za-z0-9_$]+)/, kind: 'class', group: 1 },
    { re: /^\s*(?:export\s+)?interface\s+([A-Za-z0-9_$]+)/, kind: 'interface', group: 1 },
    { re: /^\s*(?:export\s+)?type\s+([A-Za-z0-9_$]+)\s*=/, kind: 'type', group: 1 },
    { re: /^\s*(?:export\s+)?const\s+([A-Za-z0-9_$]+)\s*=\s*(?:async\s*)?\(/, kind: 'function', group: 1 },
    { re: /^\s*(?:export\s+)?const\s+([A-Z][A-Za-z0-9_$]*)\s*=/, kind: 'const', group: 1 },
  ],
  python: [
    { re: /^\s*def\s+([A-Za-z0-9_]+)/, kind: 'function', group: 1 },
    { re: /^\s*class\s+([A-Za-z0-9_]+)/, kind: 'class', group: 1 },
  ],
  rust: [
    { re: /^\s*(?:pub\s+)?fn\s+([A-Za-z0-9_]+)/, kind: 'function', group: 1 },
    { re: /^\s*(?:pub\s+)?struct\s+([A-Za-z0-9_]+)/, kind: 'class', group: 1 },
    { re: /^\s*(?:pub\s+)?trait\s+([A-Za-z0-9_]+)/, kind: 'interface', group: 1 },
  ],
  go: [
    { re: /^\s*func\s+(?:\([^)]*\)\s*)?([A-Za-z0-9_]+)/, kind: 'function', group: 1 },
    { re: /^\s*type\s+([A-Za-z0-9_]+)\s+struct/, kind: 'class', group: 1 },
  ],
};

PATTERNS.javascript = PATTERNS.typescript;

/** Extract a flat symbol outline from a source file using regex heuristics. */
export function extractOutline(source: string, language: string | undefined): CodeSymbol[] {
  if (!language) return [];
  const patterns = PATTERNS[language];
  if (!patterns) return [];
  const symbols: CodeSymbol[] = [];
  const lines = source.split('\n');
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (line.length > 400) continue;
    for (const p of patterns) {
      const m = p.re.exec(line);
      if (m && m[p.group]) {
        symbols.push({ name: m[p.group], kind: p.kind, line: i + 1 });
        break;
      }
    }
  }
  return symbols;
}
