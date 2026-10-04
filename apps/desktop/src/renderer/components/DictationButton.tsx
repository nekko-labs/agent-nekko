import { useEffect, useRef, useState } from 'react';
import { createLocalRecognition, type LocalRecognition } from '../localDictation.js';
import { parseVoiceIntent, type VoiceIntent } from '../voiceCommands.js';
import { useStore } from '../store.js';

export function DictationButton({ sessionId, onText }: { sessionId: string; onText: (text: string) => void }) {
  const recognition = useRef<LocalRecognition | null>(null);
  const mounted = useRef(true);
  const textCallback = useRef(onText);
  textCallback.current = onText;
  const [state, setState] = useState<'idle' | 'starting' | 'listening'>('idle');
  const [interim, setInterim] = useState('');
  const [pending, setPending] = useState<VoiceIntent | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; recognition.current?.abort(); recognition.current = null; };
  }, [sessionId]);
  const execute = async (intent: VoiceIntent) => {
    setBusy(true);
    try {
      if (intent.kind === 'new-session') await useStore.getState().newChat();
      else if (intent.kind === 'complete-session') await useStore.getState().archiveChat(sessionId);
      else if (intent.kind === 'navigate') useStore.getState().setView(intent.view);
      setPending(null);
    } catch (e) { setError((e as Error).message); }
    finally { if (mounted.current) setBusy(false); }
  };
  const toggle = async () => {
    if (recognition.current) { recognition.current.stop(); return; }
    if (state === 'starting') return;
    setError('');
    setState('starting');
    try {
      const local = await createLocalRecognition();
      if (!mounted.current) return;
      recognition.current = local;
      local.onresult = (event) => {
        let preview = '';
        for (let i = event.resultIndex; i < event.results.length; i++) {
          const result = event.results[i];
          const text = result[0].transcript.trim();
          if (!result.isFinal) { preview += text; continue; }
          const intent = parseVoiceIntent(text);
          if (intent.kind === 'dictation') textCallback.current(intent.text);
          else {
            setPending(intent);
            local.stop();
            break;
          }
        }
        setInterim(preview);
      };
      local.onerror = (event) => { if (mounted.current) setError(`Dictation stopped: ${event.error}. No cloud fallback was used.`); };
      local.onend = () => { recognition.current = null; if (mounted.current) { setState('idle'); setInterim(''); } };
      local.start();
      setState('listening');
    } catch (e) {
      recognition.current?.abort();
      recognition.current = null;
      if (mounted.current) { setError((e as Error).message); setState('idle'); }
    }
  };
  return (
    <div className="relative shrink-0">
      <button type="button" className={`grid h-9 w-9 place-items-center rounded-xl hover:bg-surface-2 disabled:opacity-40 ${state === 'listening' ? 'text-(--danger)' : 'text-ink-soft'}`}
        onClick={() => void toggle()} disabled={state === 'starting' || !!pending} aria-pressed={state === 'listening'}
        aria-label={state === 'listening' ? 'Stop dictation' : 'Start local dictation'} title="Local dictation · Say ‘Nekko…’ for app commands">
        <svg className="h-5 w-5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" aria-hidden="true">
          <rect x="9" y="2" width="6" height="12" rx="3" /><path d="M5 10v2a7 7 0 0 0 14 0v-2M12 19v3M8 22h8" />
        </svg>
      </button>
      {(state !== 'idle' || pending || error) && <div className="absolute bottom-full right-0 z-40 mb-2 w-72 rounded-xl border border-line bg-surface p-3 shadow-lg">
        <p role="status" className="text-[12px] text-ink-soft">{state === 'starting' ? 'Checking on-device speech…' : state === 'listening' ? interim || 'Listening locally… Click the microphone to stop.' : pending ? 'Voice command' : 'Dictation unavailable'}</p>
        {pending && <>
          <p className="mt-1 text-[12px]">{pending.kind === 'new-session' ? 'Create a new session?' : pending.kind === 'complete-session' ? 'Complete this session?' : pending.kind === 'navigate' ? `Open ${pending.view === 'modelserver' ? 'Model Server' : pending.view}?` : pending.kind === 'unknown' ? `Unrecognized command: ${pending.text}` : ''}</p>
          <div className="mt-2 flex gap-2">
            {pending.kind === 'unknown' ? <button className="btn btn-outline py-1! text-[12px]!" onClick={() => { textCallback.current(pending.text); setPending(null); }}>Add to draft</button>
              : <button disabled={busy} className="btn btn-primary py-1! text-[12px]!" onClick={() => void execute(pending)}>Confirm</button>}
            <button disabled={busy} className="btn btn-outline py-1! text-[12px]!" onClick={() => setPending(null)}>Cancel</button>
          </div>
        </>}
        {error && <><p role="alert" className="mt-1 text-[12px] text-(--danger)">{error}</p><button className="mt-2 text-[12px] text-ink-soft" onClick={() => setError('')}>Dismiss</button></>}
      </div>}
    </div>
  );
}
