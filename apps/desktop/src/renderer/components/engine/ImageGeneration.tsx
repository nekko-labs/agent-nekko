import { useState } from 'react';
import type { LocalModel, ImageGenerationResult } from '@agent-nekko/shared';
import { useStore } from '../../store.js';

export function ImageGeneration({ model, onChanged }: { model: LocalModel; onChanged: () => void }) {
  const pushToast = useStore(s => s.pushToast);
  const [prompt, setPrompt] = useState('');
  const [size, setSize] = useState('1024x1024');
  const [steps, setSteps] = useState(28);
  const [cfgScale, setCfgScale] = useState(4.5);
  const [seed, setSeed] = useState(-1);
  const [paths, setPaths] = useState(model.preset?.diffusion ?? {});
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<ImageGenerationResult | null>(null);
  const [error, setError] = useState('');
  const save = async () => {
    await window.nekko.engineSaveModelPreset(model.id, { ...model.preset, diffusion: paths });
    onChanged();
  };
  const generate = async () => {
    setBusy(true); setError('');
    try {
      await save();
      const [width, height] = size.split('x').map(Number);
      setResult(await window.nekko.engineGenerateImage({ modelId: model.id, prompt, width, height, steps, cfgScale, seed }));
      onChanged();
    } catch (e) { setError((e as Error).message); }
    finally { setBusy(false); }
  };
  return <div className="mt-3 space-y-3 border-t border-line py-3">
    <h3 className="text-[13px] font-semibold">Generate with {model.name}</h3>
    <label className="block text-[12px]">Prompt<textarea className="input mt-1 min-h-24 w-full" value={prompt} maxLength={20000} onChange={e => setPrompt(e.target.value)} placeholder="Describe the image you want" disabled={busy} /></label>
    <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
      <label className="text-[12px]">Size<select className="input mt-1 w-full" value={size} onChange={e => setSize(e.target.value)} disabled={busy}>{['512x512', '768x768', '1024x1024', '1024x768', '768x1024'].map(s => <option key={s}>{s}</option>)}</select></label>
      <label className="text-[12px]">Steps<input className="input mt-1 w-full" type="number" min={1} max={100} value={steps} onChange={e => setSteps(Number(e.target.value))} disabled={busy} /></label>
      <label className="text-[12px]">CFG scale<input className="input mt-1 w-full" type="number" min={0} max={30} step={0.5} value={cfgScale} onChange={e => setCfgScale(Number(e.target.value))} disabled={busy} /></label>
      <label className="text-[12px]">Seed<input className="input mt-1 w-full" type="number" min={-1} value={seed} onChange={e => setSeed(Number(e.target.value))} disabled={busy} /></label>
    </div>
    <details><summary className="cursor-pointer text-[12px] text-ink-soft">Companion files and memory settings</summary>
      <p className="mt-2 text-[12px] text-ink-faint">Use absolute paths on the machine running Nekko. SD3.5 needs clip_l, clip_g and t5xxl. Files beside the model are detected automatically. Standalone weights may also need a VAE.</p>
      <div className="mt-2 grid grid-cols-1 gap-2 sm:grid-cols-2">{(['clip_l', 'clip_g', 't5xxl', 'vae', 'llm'] as const).map(key => <label key={key} className="text-[12px]">{key}<input className="input mt-1 w-full" value={paths[key] ?? ''} onChange={e => setPaths({ ...paths, [key]: e.target.value || undefined })} disabled={busy} /></label>)}</div>
      <div className="mt-3 space-y-2 text-[12px]">
        <label className="flex gap-2"><input type="checkbox" checked={paths.standalone !== false} onChange={e => setPaths({ ...paths, standalone: e.target.checked })} disabled={busy} />Standalone diffusion weights (not a full checkpoint)</label>
        <label className="flex gap-2"><input type="checkbox" checked={paths.offloadToCpu ?? false} onChange={e => setPaths({ ...paths, offloadToCpu: e.target.checked })} disabled={busy} />Offload weights to CPU when possible</label>
        <label className="flex gap-2"><input type="checkbox" checked={paths.clipOnCpu ?? false} onChange={e => setPaths({ ...paths, clipOnCpu: e.target.checked })} disabled={busy} />Keep text encoders on CPU</label>
      </div>
      <button className="btn btn-outline mt-3 py-1 text-[12px]" disabled={busy} onClick={() => void save().then(() => pushToast('success', 'Image settings saved.')).catch(e => pushToast('error', e.message))}>Save image settings</button>
    </details>
    <button className="btn btn-primary text-[12px]" disabled={busy || !prompt.trim()} onClick={() => void generate()}>{busy ? 'Generating, this can take several minutes…' : 'Generate image'}</button>
    {error && <p role="alert" className="text-[12px] text-ink-soft">{error}</p>}
    {result?.data.map((image, i) => <figure key={`${result.created}-${i}`} className="space-y-2"><img className="h-auto max-w-full rounded-lg" src={`data:image/png;base64,${image.b64_json}`} alt={`Generated image: ${prompt}`} /><a className="btn btn-outline inline-flex text-[12px]" href={`data:image/png;base64,${image.b64_json}`} download={`nekko-image-${result.created}-${i}.png`}>Save image</a></figure>)}
  </div>;
}
