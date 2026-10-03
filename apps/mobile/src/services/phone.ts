/**
 * Everything that runs on the phone itself: downloading models, loading one
 * into llama.cpp, and chats with it. Nothing here touches the network except
 * the model download from Hugging Face; prompts and replies never leave the
 * device.
 */
import * as Crypto from 'expo-crypto';
import * as Device from 'expo-device';
import { File } from 'expo-file-system';
import { activateKeepAwakeAsync, deactivateKeepAwake } from 'expo-keep-awake';

import { findModel, modelUrl, type PhoneModel } from '@/lib/catalog';
import { createStore } from '@/lib/store';
import { engineSupported, loadEngine, type ChatTurn, type Engine } from './llama';
import { modelsDir, readJson, writeJson } from './storage';

export interface InstalledModel {
  id: string;
  file: string;
  sizeBytes: number;
  installedAt: number;
}

export interface DownloadState {
  bytes: number;
  total: number;
  state: 'downloading' | 'error';
  error?: string;
}

export interface LocalMessage {
  id: string;
  role: 'user' | 'assistant';
  content: string;
  reasoning?: string;
  at: number;
  /** Generation speed of this reply, tokens per second. */
  tps?: number;
  interrupted?: boolean;
}

export interface LocalChat {
  id: string;
  title: string;
  modelId: string;
  thinking: boolean;
  createdAt: number;
  updatedAt: number;
  messages: LocalMessage[];
}

export interface PhoneState {
  ready: boolean;
  supported: boolean;
  totalMemory: number | null;
  installed: InstalledModel[];
  downloads: Record<string, DownloadState>;
  defaultModelId?: string;
  chats: LocalChat[];
  /** The model in memory right now. */
  loaded?: { modelId: string; gpu: boolean; gpuNote?: string };
  loading?: { modelId: string; progress: number };
  loadError?: string;
  /** The chat currently generating, with the reply as it streams. */
  live?: { chatId: string; content: string; reasoning: string };
}

export const phone = createStore<PhoneState>({
  ready: false,
  supported: engineSupported,
  totalMemory: Device.totalMemory ?? null,
  installed: [],
  downloads: {},
  chats: [],
});

interface Persisted {
  installed: InstalledModel[];
  defaultModelId?: string;
}

const SYSTEM_PROMPT =
  'You are Nekko, a helpful assistant running entirely on this phone, with no internet access. ' +
  'Answer clearly and briefly; use Markdown for lists and code. If you are unsure, say so.';

let engine: Engine | null = null;
const tasks = new Map<string, { cancel(): void }>();

export function loadPhone(): void {
  const saved = readJson<Persisted>('models', { installed: [] });
  // Drop entries whose file was removed behind our back (storage cleanup).
  const installed = engineSupported
    ? saved.installed.filter((m) => new File(modelsDir(), m.file).exists)
    : saved.installed;
  const chats = readJson<LocalChat[]>('chats', []);
  phone.set({ ready: true, installed, defaultModelId: saved.defaultModelId, chats: chats.sort((a, b) => b.updatedAt - a.updatedAt) });
}

function persistModels(): void {
  const { installed, defaultModelId } = phone.get();
  writeJson('models', { installed, defaultModelId } satisfies Persisted);
}

let chatsTimer: ReturnType<typeof setTimeout> | null = null;
function persistChats(now = false): void {
  if (chatsTimer) clearTimeout(chatsTimer);
  const write = () => writeJson('chats', phone.get().chats);
  if (now) write();
  else chatsTimer = setTimeout(write, 400);
}

export function isInstalled(id: string): boolean {
  return phone.get().installed.some((m) => m.id === id);
}

/* ------------------------------------------------------------------ models */

export async function downloadModel(m: PhoneModel): Promise<void> {
  if (!engineSupported || tasks.has(m.id) || isInstalled(m.id)) return;
  const dir = modelsDir();
  const part = new File(dir, `${m.file}.part`);
  if (part.exists) part.delete();
  const setDl = (d: DownloadState | null) =>
    phone.set((s) => {
      const downloads = { ...s.downloads };
      if (d) downloads[m.id] = d;
      else delete downloads[m.id];
      return { downloads };
    });
  setDl({ bytes: 0, total: m.sizeBytes, state: 'downloading' });
  let lastPaint = 0;
  const task = File.createDownloadTask(modelUrl(m), part, {
    onProgress: ({ bytesWritten, totalBytes }) => {
      const now = Date.now();
      if (now - lastPaint < 250) return;
      lastPaint = now;
      setDl({ bytes: bytesWritten, total: totalBytes > 0 ? totalBytes : m.sizeBytes, state: 'downloading' });
    },
  });
  tasks.set(m.id, task);
  void activateKeepAwakeAsync('model-download').catch(() => {});
  try {
    const file = await task.downloadAsync();
    if (!file) return; // cancelled
    const size = part.info().size ?? 0;
    if (size !== m.sizeBytes) {
      part.delete();
      throw new Error(`Download was incomplete (${size} of ${m.sizeBytes} bytes). Try again on Wi-Fi.`);
    }
    const target = new File(dir, m.file);
    if (target.exists) target.delete();
    part.moveSync(target);
    phone.set((s) => ({
      installed: [...s.installed.filter((x) => x.id !== m.id), { id: m.id, file: m.file, sizeBytes: m.sizeBytes, installedAt: Date.now() }],
      defaultModelId: s.defaultModelId ?? m.id,
    }));
    persistModels();
    setDl(null);
  } catch (e) {
    if (part.exists) part.delete();
    const msg = (e as Error).message || 'Download failed';
    if (/abort|cancel/i.test(msg)) setDl(null);
    else setDl({ bytes: 0, total: m.sizeBytes, state: 'error', error: msg });
  } finally {
    tasks.delete(m.id);
    if (tasks.size === 0) deactivateKeepAwake('model-download');
  }
}

export function cancelDownload(id: string): void {
  tasks.get(id)?.cancel();
  tasks.delete(id);
  phone.set((s) => {
    const downloads = { ...s.downloads };
    delete downloads[id];
    return { downloads };
  });
}

export async function deleteModel(id: string): Promise<void> {
  const entry = phone.get().installed.find((m) => m.id === id);
  if (!entry) return;
  if (phone.get().loaded?.modelId === id) await unloadModel();
  const f = new File(modelsDir(), entry.file);
  if (f.exists) f.delete();
  phone.set((s) => {
    const installed = s.installed.filter((m) => m.id !== id);
    return { installed, defaultModelId: s.defaultModelId === id ? installed[0]?.id : s.defaultModelId };
  });
  persistModels();
}

export function setDefaultModel(id: string): void {
  phone.set({ defaultModelId: id });
  persistModels();
}

async function ensureLoaded(modelId: string): Promise<Engine> {
  const s = phone.get();
  if (engine && s.loaded?.modelId === modelId) return engine;
  const entry = s.installed.find((m) => m.id === modelId);
  const meta = findModel(modelId);
  if (!entry || !meta) throw new Error('That model is no longer on this phone. Download it again from Models.');
  if (engine) await unloadModel();
  phone.set({ loading: { modelId, progress: 0 }, loadError: undefined });
  try {
    const path = new File(modelsDir(), entry.file).uri;
    engine = await loadEngine(path, meta.ctx, (progress) => phone.set({ loading: { modelId, progress } }));
    phone.set({ loading: undefined, loaded: { modelId, gpu: engine.gpu, gpuNote: engine.gpuNote } });
    return engine;
  } catch (e) {
    engine = null;
    const msg = (e as Error).message || 'Could not load the model';
    phone.set({ loading: undefined, loaded: undefined, loadError: msg });
    throw new Error(`${meta.name} could not start: ${msg}`);
  }
}

export async function unloadModel(): Promise<void> {
  const e = engine;
  engine = null;
  phone.set({ loaded: undefined });
  await e?.release().catch(() => {});
}

/* ------------------------------------------------------------------- chats */

export function newLocalChat(modelId: string): string {
  const chat: LocalChat = {
    id: `p_${Crypto.randomUUID()}`,
    title: 'New chat',
    modelId,
    thinking: false,
    createdAt: Date.now(),
    updatedAt: Date.now(),
    messages: [],
  };
  phone.set((s) => ({ chats: [chat, ...s.chats] }));
  persistChats(true);
  return chat.id;
}

export function getChat(id: string): LocalChat | undefined {
  return phone.get().chats.find((c) => c.id === id);
}

function updateChat(id: string, fn: (c: LocalChat) => LocalChat): void {
  phone.set((s) => ({ chats: s.chats.map((c) => (c.id === id ? fn(c) : c)).sort((a, b) => b.updatedAt - a.updatedAt) }));
  persistChats();
}

export function setChatOptions(id: string, patch: Partial<Pick<LocalChat, 'modelId' | 'thinking' | 'title'>>): void {
  updateChat(id, (c) => ({ ...c, ...patch }));
}

export function deleteLocalChat(id: string): void {
  phone.set((s) => ({ chats: s.chats.filter((c) => c.id !== id) }));
  persistChats(true);
}

export async function sendLocal(chatId: string, text: string): Promise<void> {
  const chat = getChat(chatId);
  if (!chat || phone.get().live) return;
  const user: LocalMessage = { id: Crypto.randomUUID(), role: 'user', content: text.trim(), at: Date.now() };
  updateChat(chatId, (c) => ({
    ...c,
    title: c.messages.length === 0 ? titleFrom(text) : c.title,
    updatedAt: Date.now(),
    messages: [...c.messages, user],
  }));
  phone.set({ live: { chatId, content: '', reasoning: '' } });
  try {
    const eng = await ensureLoaded(chat.modelId);
    const history = getChat(chatId)!.messages;
    const turns: ChatTurn[] = [{ role: 'system', content: SYSTEM_PROMPT }, ...history.map((m) => ({ role: m.role, content: m.content }))];
    const result = await eng.complete(turns, { thinking: !!chat.thinking && !!findModel(chat.modelId)?.thinking, maxTokens: 2048 }, (d) =>
      phone.set({ live: { chatId, content: d.content, reasoning: d.reasoning } }),
    );
    const reply: LocalMessage = {
      id: Crypto.randomUUID(),
      role: 'assistant',
      content: result.content.trim(),
      reasoning: result.reasoning.trim() || undefined,
      at: Date.now(),
      tps: result.tokensPerSecond,
      interrupted: result.interrupted || undefined,
    };
    updateChat(chatId, (c) => ({ ...c, updatedAt: Date.now(), messages: [...c.messages, reply] }));
  } finally {
    phone.set({ live: undefined });
    persistChats(true);
  }
}

export async function stopLocal(): Promise<void> {
  await engine?.stop();
}

function titleFrom(text: string): string {
  const flat = text.replace(/\s+/g, ' ').trim();
  return flat.length > 48 ? `${flat.slice(0, 47)}…` : flat || 'New chat';
}
