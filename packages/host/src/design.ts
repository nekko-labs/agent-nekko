import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs';
import { join } from 'path';
import { randomUUID } from 'crypto';
import { createProvider } from '@agent-nekko/core';
import type { DesignBoard, DesignPage, GenerateDesignInput } from '@agent-nekko/shared';
import { dataDir, getSettings } from './store.js';
import { resolveSubscriptionProvider } from './oauth.js';

/**
 * Design board persistence + AI design generation. The board is a Figma-style
 * canvas of an app's UI pages (a label + a URL the page renders at) plus
 * AI-generated design concepts, with persistent notes pinned to each card.
 * Concepts come from a prompt or a hand-drawn sketch (vision models) and are
 * generated one-shot with the default provider/model; the resulting
 * self-contained HTML prototype is stored on the page (rendered via srcdoc)
 * and mirrored into the workspace's nekko-designs/ folder so agents and
 * users can iterate on it as code. Stored in one JSON file keyed by
 * workspaceId; live "snapshots" are scaled previews rendered in the UI.
 */

type Store = Record<string, DesignPage[]>;

function file(): string {
  const dir = dataDir();
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  return join(dir, 'design.json');
}

function load(): Store {
  try {
    return JSON.parse(readFileSync(file(), 'utf8')) as Store;
  } catch {
    return {};
  }
}

function save(store: Store): void {
  writeFileSync(file(), JSON.stringify(store, null, 2), 'utf8');
}

function board(workspaceId: string, store: Store): DesignBoard {
  return { workspaceId, pages: store[workspaceId] ?? [] };
}

export function getDesignBoard(workspaceId: string): DesignBoard {
  return board(workspaceId, load());
}

export function addDesignPage(workspaceId: string, label: string, url: string): DesignBoard {
  const store = load();
  const now = Date.now();
  const page: DesignPage = { id: randomUUID(), label: label.trim() || url, url: url.trim(), notes: [], createdAt: now, updatedAt: now };
  store[workspaceId] = [...(store[workspaceId] ?? []), page];
  save(store);
  return board(workspaceId, store);
}

export function updateDesignPage(
  workspaceId: string,
  pageId: string,
  patch: Partial<Pick<DesignPage, 'label' | 'url'>>,
): DesignBoard {
  const store = load();
  store[workspaceId] = (store[workspaceId] ?? []).map((p) =>
    p.id === pageId ? { ...p, ...patch, updatedAt: Date.now() } : p,
  );
  save(store);
  return board(workspaceId, store);
}

export function removeDesignPage(workspaceId: string, pageId: string): DesignBoard {
  const store = load();
  store[workspaceId] = (store[workspaceId] ?? []).filter((p) => p.id !== pageId);
  save(store);
  return board(workspaceId, store);
}

export function addDesignNote(workspaceId: string, pageId: string, text: string): DesignBoard {
  const store = load();
  store[workspaceId] = (store[workspaceId] ?? []).map((p) =>
    p.id === pageId
      ? { ...p, notes: [...p.notes, { id: randomUUID(), text: text.trim(), createdAt: Date.now() }], updatedAt: Date.now() }
      : p,
  );
  save(store);
  return board(workspaceId, store);
}

/** System prompt for one-shot prototype generation. */
const DESIGN_SYSTEM = [
  'You are a world-class product designer and front-end engineer producing a single, self-contained HTML prototype.',
  'Rules: output ONE complete HTML document. All CSS lives in a <style> tag and any JS inline in a <script> tag. No external resources of any kind (no CDNs, web fonts, or remote images; use system font stacks, CSS gradients, and inline SVG). Responsive down to 375px wide. Polished and modern: real visual hierarchy, generous whitespace, consistent spacing scale, believable placeholder content. Add hover/focus states and small interactions where they sell the design.',
  'Output ONLY the HTML document. No explanations, no code fences.',
].join('\n');

/**
 * Generate (or refine) a design concept with the default provider/model:
 * prompt → design, or sketch (+ optional notes) → code prototype. Writes the
 * prototype into the workspace and upserts the concept page on the board.
 */
export async function generateDesign(workspaceId: string, input: GenerateDesignInput): Promise<DesignBoard> {
  const prompt = (input.prompt ?? '').trim();
  if (!prompt && !input.sketchDataUrl) throw new Error('Describe the design or draw a sketch first.');

  const settings = getSettings();
  const providerCfg = settings.providers.find((p) => p.id === settings.defaultProviderId);
  const model = settings.defaultModelId;
  if (!providerCfg || !model) throw new Error('Set a default provider and model in Models first.');

  const store = load();
  const existing = input.pageId ? (store[workspaceId] ?? []).find((p) => p.id === input.pageId) : undefined;

  let ask: string;
  if (existing?.html) {
    ask = `Here is the current prototype:\n\n${existing.html.slice(0, 60000)}\n\nApply this change and output the full updated document, keeping everything else intact: ${prompt}`;
  } else if (input.sketchDataUrl) {
    ask = `Turn the attached hand-drawn sketch into a working, polished HTML prototype. Follow the sketch's layout, boxes, and annotations faithfully, then fill in professional visual design (type, color, spacing).${prompt ? `\n\nAdditional instructions: ${prompt}` : ''}`;
  } else {
    ask = `Design this: ${prompt}`;
  }

  let out = '';
  try {
    const resolved = await resolveSubscriptionProvider(providerCfg);
    for await (const chunk of createProvider(resolved).chat({
      model,
      system: DESIGN_SYSTEM,
      messages: [{
        id: 'design',
        role: 'user',
        content: ask,
        images: !existing && input.sketchDataUrl ? [input.sketchDataUrl] : undefined,
        createdAt: Date.now(),
      }],
      temperature: 0.6,
    })) {
      if (chunk.type === 'text') out += chunk.delta;
    }
  } catch (e) {
    throw new Error(`Design generation failed: ${(e as Error).message}`);
  }

  out = out.replace(/^```(?:html)?\s*/i, '').replace(/\s*```\s*$/i, '').trim();
  const lower = out.toLowerCase();
  const docStart = lower.indexOf('<!doctype');
  const htmlStart = lower.indexOf('<html');
  const start = docStart >= 0 ? docStart : htmlStart;
  if (start > 0) out = out.slice(start);
  if (!out.includes('<')) throw new Error('The model returned no HTML. Try again, or pick a stronger default model in Models.');

  const label = (input.label?.trim() || existing?.label || prompt.slice(0, 42) || 'Concept').trim();

  // Mirror the prototype into the workspace so it's real, editable code.
  let filePath = existing?.file;
  const ws = settings.workspaces.find((w) => w.id === workspaceId);
  if (ws) {
    try {
      // Prefer nekko-designs, but keep filling a folder from an earlier brand
      // if the workspace already has one (no split-brain folders).
      let dir = join(ws.path, 'nekko-designs');
      if (!existsSync(dir)) {
        const legacy = ['kotrain-designs', 'nekkos-designs']
          .map((name) => join(ws.path, name))
          .find(existsSync);
        if (legacy) dir = legacy;
        else mkdirSync(dir, { recursive: true });
      }
      if (!filePath) {
        const slug = label.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40) || 'design';
        filePath = join(dir, `${slug}-${randomUUID().slice(0, 6)}.html`);
      }
      writeFileSync(filePath, out, 'utf8');
    } catch {
      filePath = existing?.file; // board still works without the file mirror
    }
  }

  const now = Date.now();
  if (existing) {
    store[workspaceId] = (store[workspaceId] ?? []).map((p) =>
      p.id === existing.id ? { ...p, html: out, prompt: prompt || p.prompt, file: filePath, updatedAt: now } : p,
    );
  } else {
    const page: DesignPage = {
      id: randomUUID(),
      kind: 'concept',
      label,
      url: '',
      html: out,
      prompt,
      origin: input.sketchDataUrl ? 'sketch' : 'prompt',
      file: filePath,
      notes: [],
      createdAt: now,
      updatedAt: now,
    };
    store[workspaceId] = [...(store[workspaceId] ?? []), page];
  }
  save(store);
  return board(workspaceId, store);
}

export function resolveDesignNote(workspaceId: string, pageId: string, noteId: string): DesignBoard {
  const store = load();
  store[workspaceId] = (store[workspaceId] ?? []).map((p) =>
    p.id === pageId ? { ...p, notes: p.notes.filter((n) => n.id !== noteId), updatedAt: Date.now() } : p,
  );
  save(store);
  return board(workspaceId, store);
}
