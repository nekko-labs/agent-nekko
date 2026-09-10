import { existsSync, readFileSync } from 'fs';
import { join } from 'path';
import type { AppSettings } from '@agent-nekko/shared';
import { DEFAULT_PROMPTS, DEFAULT_SPEC_METHODOLOGY, DEFAULT_ORCHESTRATION, DEFAULT_ACCENT, LEGACY_ACCENTS } from '@agent-nekko/shared';
import { DEFAULT_GUARDRAILS } from '@agent-nekko/core';
import { dataDir } from './paths.js';
import { ensurePrivateFile, writeJsonAtomic } from './secure-file.js';

export { dataDir } from './paths.js';

const SETTINGS_PATH = () => join(dataDir(), 'settings.json');

function defaults(): AppSettings {
  return {
    theme: 'system',
    accent: DEFAULT_ACCENT,
    sandboxMode: 'workspace-jail',
    providers: [],
    guardrails: DEFAULT_GUARDRAILS,
    workspaces: [],
    connectors: [],
    mascotEnabled: true,
    prompts: DEFAULT_PROMPTS,
    favoriteModels: [],
    mcpServers: [],
    specMethodology: DEFAULT_SPEC_METHODOLOGY,
    orchestration: DEFAULT_ORCHESTRATION,
  };
}

// Keyed by data dir so a single process serving many accounts (Kotrain Cloud)
// never bleeds one account's settings into another. Single-data-dir editions
// (desktop/server/CLI) just use the one entry.
const cache = new Map<string, AppSettings>();

export function getSettings(): AppSettings {
  const dir = dataDir();
  const cached = cache.get(dir);
  if (cached) return cached;
  let settings: AppSettings;
  try {
    if (existsSync(SETTINGS_PATH())) {
      ensurePrivateFile(SETTINGS_PATH());
      const parsed = JSON.parse(readFileSync(SETTINGS_PATH(), 'utf8'));
      settings = { ...defaults(), ...parsed };
      // Normalize array fields from older or partially-written settings files.
      if (!Array.isArray(settings.providers)) settings.providers = [];
      if (!Array.isArray(settings.guardrails) || settings.guardrails.length === 0) settings.guardrails = DEFAULT_GUARDRAILS;
      if (!Array.isArray(settings.workspaces)) settings.workspaces = [];
      if (!Array.isArray(settings.connectors)) settings.connectors = [];
      if (!Array.isArray(settings.prompts)) settings.prompts = DEFAULT_PROMPTS;
      if (!Array.isArray(settings.favoriteModels)) settings.favoriteModels = [];
      if (!Array.isArray(settings.mcpServers)) settings.mcpServers = [];
      // Migrate users off a prior default accent (e.g. the old orange) so the
      // refreshed color applies unless they picked their own.
      if (settings.accent && LEGACY_ACCENTS.includes(settings.accent.toLowerCase())) {
        settings.accent = DEFAULT_ACCENT;
      }
    } else {
      settings = defaults();
    }
  } catch {
    settings = defaults();
  }
  cache.set(dir, settings);
  return settings;
}

export function saveSettings(patch: Partial<AppSettings>): AppSettings {
  const next = { ...getSettings(), ...patch };
  cache.set(dataDir(), next);
  writeJsonAtomic(SETTINGS_PATH(), next);
  return next;
}

/** Reset all settings (theme, providers, guardrails, prompts, …) to defaults. */
export function resetSettings(): AppSettings {
  const next = defaults();
  cache.set(dataDir(), next);
  writeJsonAtomic(SETTINGS_PATH(), next);
  return next;
}
