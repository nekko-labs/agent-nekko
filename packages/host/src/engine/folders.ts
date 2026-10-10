import { homedir, platform } from 'os';
import { join } from 'path';
import type { ModelFolder, ModelFolderProviderId } from '@agent-nekko/shared';

/**
 * Where the other model apps keep their models.
 *
 * A GGUF is a GGUF whoever downloaded it, so a machine that has already pulled
 * Qwen through Ollama or LM Studio should not have to pull it again to run it
 * here. These are the default locations those apps use, per platform, and the
 * folder list starts as whichever of them actually exist.
 *
 * Nothing here is authoritative: a path that is wrong for someone's install is a
 * folder that fails to exist, which the scan skips and the settings page shows
 * as missing. That is why guessing is safe, and why every row stays editable.
 */

const HOME = () => homedir();

/** Windows knows these by environment variable; the fallbacks are the defaults. */
function localAppData(): string {
  return process.env.LOCALAPPDATA || join(HOME(), 'AppData', 'Local');
}
function appData(): string {
  return process.env.APPDATA || join(HOME(), 'AppData', 'Roaming');
}

/**
 * Candidate folders for one app, best first.
 *
 * Several apps moved their folder between versions and both paths are still in
 * the wild, so each provider gets a list and the probe keeps whichever exists.
 */
export function knownFolderCandidates(
  os: NodeJS.Platform = platform(),
): Array<{ provider: ModelFolderProviderId; paths: string[] }> {
  const home = HOME();
  const win = os === 'win32';
  const mac = os === 'darwin';

  const ollama = process.env.OLLAMA_MODELS
    ? [process.env.OLLAMA_MODELS]
    : win
      ? [join(localAppData(), 'Ollama', 'models'), join(home, '.ollama', 'models')]
      : [join(home, '.ollama', 'models'), '/usr/share/ollama/.ollama/models'];

  const lmstudio = win
    ? [join(home, '.lmstudio', 'models'), join(home, '.cache', 'lm-studio', 'models')]
    : [join(home, '.lmstudio', 'models'), join(home, '.cache', 'lm-studio', 'models')];

  const gpt4all = win
    ? [join(localAppData(), 'nomic.ai', 'GPT4All')]
    : mac
      ? [join(home, 'Library', 'Application Support', 'nomic.ai', 'GPT4All')]
      : [join(home, '.local', 'share', 'nomic.ai', 'GPT4All')];

  const jan = win
    ? [join(appData(), 'Jan', 'data', 'models'), join(home, 'jan', 'models')]
    : mac
      ? [join(home, 'Library', 'Application Support', 'Jan', 'data', 'models'), join(home, 'jan', 'models')]
      : [join(home, '.config', 'Jan', 'data', 'models'), join(home, 'jan', 'models')];

  const hfCache = process.env.HF_HOME
    ? [join(process.env.HF_HOME, 'hub')]
    : process.env.HUGGINGFACE_HUB_CACHE
      ? [process.env.HUGGINGFACE_HUB_CACHE]
      : [join(home, '.cache', 'huggingface', 'hub')];

  return [
    { provider: 'ollama', paths: ollama },
    { provider: 'lmstudio', paths: lmstudio },
    { provider: 'jan', paths: jan },
    { provider: 'gpt4all', paths: gpt4all },
    { provider: 'llamacpp', paths: [join(home, '.cache', 'llama.cpp'), join(home, 'llama.cpp', 'models')] },
    { provider: 'huggingface', paths: hfCache },
    // vLLM has no folder of its own: it serves whatever is in the HF cache, so
    // the row exists to say so rather than to point somewhere different.
    { provider: 'vllm', paths: [...hfCache, join(home, '.cache', 'vllm')] },
    { provider: 'koboldcpp', paths: [join(home, 'koboldcpp', 'models'), join(home, '.koboldcpp', 'models')] },
    {
      provider: 'textgenwebui',
      paths: [join(home, 'text-generation-webui', 'models'), join(home, 'text-generation-webui', 'user_data', 'models')],
    },
    { provider: 'localai', paths: [join(home, '.local', 'share', 'local-ai', 'models'), '/build/models'] },
    { provider: 'bionic', paths: [join(home, '.bionic', 'models'), join(home, 'bionic-gpt', 'models')] },
  ];
}

/** A stable id for a folder row, derived from what put it there. */
export function folderId(provider: ModelFolderProviderId | undefined, path: string): string {
  if (provider) return provider;
  // A custom folder is identified by its path, slugged so the id stays safe in
  // a model id and stable across restarts.
  const slug = path
    .replace(/[\\/]+/g, '-')
    .replace(/[^A-Za-z0-9._-]/g, '')
    .replace(/^-+|-+$/g, '')
    .toLowerCase();
  return `dir-${slug.slice(-48) || 'custom'}`;
}

/** A folder row for a known provider at a path. */
export function knownFolder(provider: ModelFolderProviderId, path: string): ModelFolder {
  return { id: folderId(provider, path), path, provider, enabled: true };
}
