import { useCallback, useEffect, useState } from 'react';
import type { DownloadJob, EngineStatus, LocalModel } from '@agent-nekko/shared';
import { useStore } from '../../store.js';
import { Badge } from '../primitives/index.js';
import { CheckIcon, CopyIcon } from '../../icons.js';
import { formatBytes } from '../runtimes/verdict.js';
import { EngineInstallCard } from './EngineInstallCard.js';
import { ModelLibrary } from './ModelLibrary.js';
import { CatalogBrowser } from './CatalogBrowser.js';
import { DownloadsPanel } from './DownloadsPanel.js';
import { EngineServerSettings } from './EngineServerSettings.js';
import { ModelFolders } from './ModelFolders.js';

/**
 * The engine Agent Nekko runs itself, and the models it serves.
 *
 * These are one block rather than two because they are one thing: the server and
 * the models it can load are useless apart, and the questions people actually
 * arrive with ("is it running", "what have I got", "where did that come from",
 * "get me another one") interleave. Splitting them into a server card and a
 * model card made you cross the page to answer any of them.
 *
 * Five surfaces, which is exactly why this is a section and not a taller card:
 * the library, the catalog, the download queue, the folders that feed the
 * library, and the server's own configuration.
 */

/** Matches the runtime cards' poll, so the whole page moves at one rhythm. */
const POLL_MS = 6000;
const PROVIDER_ID = 'nekko-engine';

type Tab = 'models' | 'discover' | 'downloads' | 'folders' | 'server';

export function EngineSection({
  onProvidersChanged,
  onOpenModel,
}: {
  onProvidersChanged: () => void;
  /** Open one catalog model's own page, which the whole view takes over for. */
  onOpenModel: (id: string) => void;
}) {
  const pushToast = useStore((s) => s.pushToast);
  const [status, setStatus] = useState<EngineStatus | null>(null);
  const [models, setModels] = useState<Array<LocalModel & { loaded: boolean }>>([]);
  const [jobs, setJobs] = useState<DownloadJob[]>([]);
  const [tab, setTab] = useState<Tab>('models');
  const [busy, setBusy] = useState<'starting' | 'stopping' | null>(null);
  const [showLog, setShowLog] = useState(false);

  const refresh = useCallback(async () => {
    const [s, m, d] = await Promise.all([
      window.nekko.engineStatus().catch(() => null),
      window.nekko.engineModels().catch(() => []),
      window.nekko.engineDownloads().catch(() => []),
    ]);
    setStatus(s);
    setModels(m);
    setJobs(d);
  }, []);

  useEffect(() => {
    refresh();
    const t = setInterval(refresh, POLL_MS);
    return () => clearInterval(t);
  }, [refresh]);

  // Progress arrives as events, so the panel stays live between polls; a finished
  // download also means a new model, hence the library refresh.
  useEffect(() => {
    return window.nekko.onDownloadsUpdated((next) => {
      setJobs(next);
      if (next.some((j) => j.state === 'done')) void refresh();
    });
  }, [refresh]);

  if (!status) return null;

  const { install, running } = status;
  const installed = Boolean(install.binPath);
  const active = jobs.filter((j) => j.state === 'downloading' || j.state === 'queued' || j.state === 'verifying');
  const residentBytes = status.resident.reduce((n, r) => n + (r.vramBytes ?? 0), 0);
  const borrowed = models.filter((m) => m.managed === false).length;

  const toggle = async () => {
    setBusy(running ? 'stopping' : 'starting');
    const res = running
      ? await window.nekko.runtimeStop(PROVIDER_ID, true).catch((e: Error) => ({ ok: false, message: e.message }))
      : await window.nekko.runtimeStart(PROVIDER_ID).catch((e: Error) => ({ error: e.message }));
    setBusy(null);
    // `runtimeStart` answers with a status or an error; `runtimeStop` with ok +
    // a message. Both failure shapes end up in the same toast.
    const failure =
      'error' in res ? (res as { error: string }).error : 'ok' in res && !res.ok ? res.message : null;
    if (failure) {
      pushToast('error', failure);
      setShowLog(true);
    }
    await refresh();
    onProvidersChanged();
  };

  const address = `http://127.0.0.1:${status.settings.port}/v1`;

  return (
    <section>
      <div className="flex items-center gap-2">
        <span className="h-2.5 w-2.5 rounded-full" style={{ background: 'var(--accent)' }} />
        <h2 className="text-[15px] font-semibold">Agent Nekko engine</h2>
        {running ? (
          <Badge tone="success" variant="solid" className="px-2 py-0.5">
            <CheckIcon className="h-3 w-3" /> Serving
          </Badge>
        ) : installed ? (
          <span className="chip">stopped</span>
        ) : (
          <span className="chip">not installed</span>
        )}
      </div>
      <p className="mt-0.5 text-[12px] text-ink-faint">
        Run models with nothing else installed. Built on llama.cpp, managed here, served on one address any tool can
        use — including models Ollama, LM Studio or anything else on this machine already downloaded.
      </p>

      <div className="card mt-3 p-5">
        {/* The install card used to be the *whole* card until an engine existed,
            which hid the library behind it — so a machine with twenty models
            already on it showed "not installed" and nothing else. What we have is
            true whether or not the runtime is downloaded; only running it isn't. */}
        {!installed ? (
          <EngineInstallCard install={install} onChanged={refresh} />
        ) : (
          <>
            <div className="flex flex-wrap items-center gap-2">
              <StatusDot running={running} busy={busy !== null} />
              <span className="text-[13px]">{running ? 'Running' : 'Stopped'}</span>
              {install.version && <span className="text-[11px] text-ink-faint">{install.version}</span>}
              {running && (
                <span className="text-[11px] text-ink-faint">
                  {status.resident.length} loaded
                  {residentBytes > 0 ? ` · ${formatBytes(residentBytes)} on GPU` : ''}
                </span>
              )}
              <div className="ml-auto flex items-center gap-2">
                {running && <AddressPill address={address} />}
                <button className="btn btn-outline py-1 text-[12px]" onClick={toggle} disabled={busy !== null}>
                  {busy === 'starting' ? 'Starting…' : busy === 'stopping' ? 'Stopping…' : running ? 'Stop' : 'Start'}
                </button>
              </div>
            </div>

            {status.settings.bind === 'lan' && running && (
              <p className="mt-2 text-[11.5px]" style={{ color: 'var(--warning, #d1a054)' }}>
                Reachable from your whole network on port {status.settings.port}
                {status.settings.apiKey ? ', and a key is required.' : '. No key is set, so anything on it can use your models.'}
              </p>
            )}
          </>
        )}

        <div className="mt-3 flex flex-wrap gap-1.5 border-b pb-2" style={{ borderColor: 'var(--line)' }}>
          <TabButton active={tab === 'models'} onClick={() => setTab('models')}>
            My models{models.length > 0 ? ` (${models.length})` : ''}
          </TabButton>
          <TabButton active={tab === 'discover'} onClick={() => setTab('discover')}>
            Find models
          </TabButton>
          <TabButton active={tab === 'downloads'} onClick={() => setTab('downloads')}>
            Downloads{active.length > 0 ? ` (${active.length})` : ''}
          </TabButton>
          <TabButton active={tab === 'folders'} onClick={() => setTab('folders')}>
            Folders{borrowed > 0 ? ` (${borrowed} borrowed)` : ''}
          </TabButton>
          <TabButton active={tab === 'server'} onClick={() => setTab('server')}>
            Server
          </TabButton>
        </div>

        <div className="mt-3">
          {tab === 'models' && (
            <ModelLibrary providerId={PROVIDER_ID} models={models} canLoad={installed} onChanged={refresh} />
          )}
          {tab === 'discover' && <CatalogBrowser onOpen={onOpenModel} />}
          {tab === 'downloads' && <DownloadsPanel jobs={jobs} onChanged={refresh} />}
          {tab === 'folders' && <ModelFolders onChanged={refresh} />}
          {tab === 'server' && (
            <EngineServerSettings
              settings={status.settings}
              install={install}
              running={running}
              onChanged={() => {
                refresh();
                onProvidersChanged();
              }}
            />
          )}
        </div>

        {status.log.length > 0 && (
          <details className="mt-3" open={showLog}>
            <summary className="cursor-pointer text-[11px] text-ink-faint">Engine output</summary>
            <pre className="mt-1 max-h-40 overflow-auto rounded bg-[color-mix(in_srgb,var(--ink-faint)_8%,transparent)] p-2 font-mono text-[10px]">
              {status.log.join('\n')}
            </pre>
          </details>
        )}
      </div>
    </section>
  );
}

function TabButton({
  active,
  onClick,
  children,
}: {
  active: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      className="rounded-full px-2.5 py-1 text-[12px]"
      style={
        active
          ? { background: 'color-mix(in srgb, var(--accent) 16%, transparent)', color: 'var(--accent)' }
          : { color: 'var(--ink-faint)' }
      }
      onClick={onClick}
    >
      {children}
    </button>
  );
}

/** The address, one click from the clipboard: it is what other tools need. */
function AddressPill({ address }: { address: string }) {
  const [copied, setCopied] = useState(false);
  useEffect(() => {
    if (!copied) return;
    const t = setTimeout(() => setCopied(false), 1200);
    return () => clearTimeout(t);
  }, [copied]);
  return (
    <button
      className="inline-flex items-center gap-1.5 rounded-full border px-2 py-1 font-mono text-[11px] text-ink-faint hover:text-ink"
      style={{ borderColor: 'var(--line)' }}
      title="Copy the address other tools should point at"
      onClick={async () => {
        try {
          await navigator.clipboard.writeText(address);
          setCopied(true);
        } catch {
          /* clipboard denied, nothing worth surfacing */
        }
      }}
    >
      {address}
      {copied ? (
        <span style={{ color: 'var(--success)' }}>
          <CheckIcon className="h-3 w-3" />
        </span>
      ) : (
        <CopyIcon className="h-3 w-3" />
      )}
    </button>
  );
}

function StatusDot({ running, busy }: { running: boolean; busy: boolean }) {
  const color = busy ? 'var(--warning, #d1a054)' : running ? 'var(--success)' : 'var(--ink-faint)';
  return (
    <span
      className="inline-block h-2 w-2 shrink-0 rounded-full"
      style={{ background: color, opacity: busy ? 0.7 : 1 }}
      aria-hidden
    />
  );
}
