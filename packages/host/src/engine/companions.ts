import { createHash } from 'crypto';
import { join } from 'path';

/**
 * Where fetched sidecars live for a model that is not ours to write beside.
 *
 * Borrowed folders (LM Studio, Ollama, the HF cache) are read-only territory,
 * so a projector or chat template we fetch for a model living in one cannot go
 * next to the weights the way a downloaded model's does. These files land in a
 * nekko-owned directory under the models folder instead, keyed by a short hash
 * of the model id so ids with slashes map to one directory each without
 * becoming paths themselves.
 *
 * `resolveCompanions` checks the model's own directory first, then here, so a
 * sidecar the user dropped in by hand still wins over one we fetched.
 */
export function companionsDir(modelsDir: string, modelId: string): string {
  const key = createHash('sha1').update(modelId).digest('hex').slice(0, 12);
  return join(modelsDir, '.companions', key);
}
