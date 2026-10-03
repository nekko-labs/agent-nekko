/**
 * Two kinds of storage. Secrets (pairing keys, the derived E2E key, this
 * phone's device id) go to the Keychain / Android Keystore through
 * expo-secure-store. Bulk data (local chats, the downloaded-model list) goes
 * to JSON files in the app's documents folder. The web build, used only for
 * development previews, falls back to localStorage for both.
 */
import { Directory, File, Paths } from 'expo-file-system';
import * as SecureStore from 'expo-secure-store';
import { Platform } from 'react-native';

const isWeb = Platform.OS === 'web';

export async function getSecret(key: string): Promise<string | null> {
  if (isWeb) return safeLocal()?.getItem(`nekko.secret.${key}`) ?? null;
  return SecureStore.getItemAsync(key, { keychainAccessible: SecureStore.AFTER_FIRST_UNLOCK_THIS_DEVICE_ONLY });
}

export async function setSecret(key: string, value: string | null): Promise<void> {
  if (isWeb) {
    const ls = safeLocal();
    if (value === null) ls?.removeItem(`nekko.secret.${key}`);
    else ls?.setItem(`nekko.secret.${key}`, value);
    return;
  }
  if (value === null) await SecureStore.deleteItemAsync(key);
  else await SecureStore.setItemAsync(key, value, { keychainAccessible: SecureStore.AFTER_FIRST_UNLOCK_THIS_DEVICE_ONLY });
}

function dataDir(): Directory {
  const dir = new Directory(Paths.document, 'nekko');
  if (!dir.exists) dir.create({ intermediates: true });
  return dir;
}

export function readJson<T>(name: string, fallback: T): T {
  try {
    if (isWeb) {
      const raw = safeLocal()?.getItem(`nekko.data.${name}`);
      return raw ? (JSON.parse(raw) as T) : fallback;
    }
    const f = new File(dataDir(), `${name}.json`);
    return f.exists ? (JSON.parse(f.textSync()) as T) : fallback;
  } catch {
    return fallback;
  }
}

export function writeJson(name: string, value: unknown): void {
  const text = JSON.stringify(value);
  if (isWeb) {
    try {
      safeLocal()?.setItem(`nekko.data.${name}`, text);
    } catch {
      /* quota or private mode: previews only */
    }
    return;
  }
  // Write-then-rename so a crash mid-write never leaves half a chat history.
  const dir = dataDir();
  const tmp = new File(dir, `${name}.json.tmp`);
  if (tmp.exists) tmp.delete();
  tmp.create();
  tmp.write(text);
  const target = new File(dir, `${name}.json`);
  if (target.exists) target.delete();
  tmp.moveSync(target);
}

/** Folder that holds downloaded GGUF models. */
export function modelsDir(): Directory {
  const dir = new Directory(Paths.document, 'models');
  if (!dir.exists) dir.create({ intermediates: true });
  return dir;
}

function safeLocal(): Storage | null {
  try {
    return globalThis.localStorage ?? null;
  } catch {
    return null;
  }
}
