import React, { useState } from 'react';
import { createRoot } from 'react-dom/client';
import { Markdown } from '__SOURCE__/components/Markdown.tsx';
import { FilePane } from '__SOURCE__/components/FilePane.tsx';
import { ImageModeControls } from '__SOURCE__/components/agent-console/ImageModeControls.tsx';
import { ImageGeneration } from '__SOURCE__/components/engine/ImageGeneration.tsx';
import { useStore } from '__SOURCE__/store.ts';
import '__SOURCE__/styles.css';
const w = window as any;
const calls: any[] = [];
const svg = '<svg xmlns="http://www.w3.org/2000/svg" width="320" height="120"><rect width="320" height="120" fill="#77aabb"/><text x="20" y="65" font-size="24">Local SVG fixture</text></svg>';
const model = { id: 'fixture-image', name: 'Fixture diffusion', modality: 'image', preset: {} };
let ready = false;
const companions = () => ({ ready, setId: 'fixture', label: 'Fixture model', missingBytes: ready ? 0 : 1000000000, defaults: { steps: 4, cfgScale: 1 }, files: [{ role: 'vae', bytes: 1000000000, path: ready ? 'C:/fixture/vae' : undefined }] });
const log = (name: string, ...args: any[]) => calls.push({ name, args });
w.nekko = {
 readFile: async (path: string) => { log('readFile', path); return { content: svg, binary: false, truncated: false }; },
 listComments: async () => [],
 engineModels: async () => [model], engineStatus: async () => ({ diffusionInstall: { binPath: 'mock' } }),
 engineImageCompanions: async () => companions(),
 engineDownloads: async () => [{ id: 'image-companions:fixture', target: model.id, state: 'failed' }],
 engineDownloadImageCompanions: async (id: string) => { log('downloadCompanions', id); return { ok: true, message: 'Mock queued' }; },
 setSessionOptions: async (id: string, patch: any) => { log('sessionOptions', patch); return { id, ...patch }; },
 engineSaveModelPreset: async (...args: any[]) => { log('savePreset', ...args); },
 openPath: async (...args: any[]) => { log('openPath', ...args); },
};
const originalClick = HTMLAnchorElement.prototype.click;
HTMLAnchorElement.prototype.click = function () { if (this.download) { log('download', this.download, this.href); return; } originalClick.call(this); };
useStore.setState({ openFilePane: (path: string) => log('openFilePane', path), pushToast: (...args: any[]) => log('toast', ...args), newImageChat: async (...args: any[]) => log('newImageChat', ...args) } as any);
w.fixture = { calls, setReady: () => { ready = true; }, button: (section: string, text: string) => { const b = [...document.querySelectorAll(`#${section} button`)].find((b: any) => b.textContent.includes(text)) as HTMLButtonElement; if (!b) return false; b.click(); return true; } };
function App() {
 const [session, setSession] = useState<any>({ id: 'fixture-session', imageParams: { modelId: model.id } });
 return <main style={{ padding: 16, background: 'var(--surface)', color: 'var(--ink)' }}>
 <h1>Image artifacts interaction fixture</h1>
 <section id="markdown"><Markdown doc basePath="C:/fixture/docs" text={'[Relative SVG](../art.svg)\n\n![SVG click](../art.svg)'} /></section>
 <section id="controls" className="flex flex-wrap gap-2 py-3"><ImageModeControls session={session} onChange={setSession} busy={false} /></section>
 <section id="generation"><ImageGeneration model={model as any} onChanged={() => log('changed')} /></section>
 <section id="file" style={{ height: 640 }}><FilePane path="C:/fixture/art.svg" /></section>
 </main>;
}
createRoot(document.getElementById('root')!).render(<App />);
