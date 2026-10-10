# Managed Inference Runtime, Design (AN7, phases A + B)

**Status:** approved 2026-09-09. Covers **phase A** (runtime control plane) and **phase B**
(VRAM fit planner). Phases C (model catalog + downloads) and D (bundled engine) get their own
specs and are explicitly out of scope here.

**Goal:** make running a model locally something a non-expert can do from inside Agent Nekko in
one click, while telling the truth about what the machine can actually hold. Two halves: a
control plane that turns local model servers on and off and loads models into them, and a
capacity planner that answers "will this fit, where will it run, and why" *before* the load,
then checks its own answer afterwards.

---

## Why this is a subsystem and not a feature

Today (T98/T99) the Models page can already see local servers, show which models are resident,
load and unload through Ollama's HTTP API and LM Studio's `lms` CLI, and kill whatever process
holds the port. What it cannot do is start a server, explain a fit, or offer a load parameter.
The gap is not one more button, it is a missing abstraction: every runtime is special-cased in
the renderer, and there is no model of the machine's capacity anywhere in the codebase.

## Decomposition (locked)

| Phase | Scope | Status |
|---|---|---|
| **A** | Runtime control plane: detect, start, stop, address, load/unload, load parameters | this spec |
| **B** | Fit planner: predicted VRAM breakdown, verdict, suggestions, post-load reconciliation | this spec |
| C | Model catalog + acquisition (browse, choose quantization, download with progress) | later spec |
| D | Bundled llama.cpp engine so a fresh install runs a model with nothing else present | later spec |

D plugs into A as a fourth `RuntimeAdapter`. That is the point of building A first.

---

## Researched capabilities (2026-09-09)

### Ollama

The most controllable over plain HTTP, and the only one that reports its own CPU spill.

- `GET /api/ps` per resident model: `name`, `size`, `size_vram`, `context_length`,
  `expires_at`, `details`. **`size_vram < size` is the CPU-spill signal**: the difference is
  what landed in system RAM. `size_vram == 0` means fully on CPU.
- `POST /api/show` returns `details.parameter_size`, `details.quantization_level`, and a
  `model_info` map carrying the architecture's `*.block_count`, `*.attention.head_count_kv`,
  `*.embedding_length`, and `*.context_length`. Those four fields are exactly the inputs an
  exact KV-cache formula needs, which is why Ollama gets the most accurate projection.
- Load-time options on `/api/generate` and `/api/chat`: `num_ctx` (context), `num_gpu` (layers
  offloaded to GPU), `keep_alive` (residency TTL). A load is performed by calling with an empty
  prompt.
- Server-wide, environment only, requires a restart to change: `OLLAMA_NUM_PARALLEL`
  (concurrent slots per model), `OLLAMA_MAX_LOADED_MODELS`, `OLLAMA_KV_CACHE_TYPE`
  (`f16` default, `q8_0` roughly halves KV memory, `q4_0` roughly quarters it),
  `OLLAMA_HOST`, `OLLAMA_KEEP_ALIVE`.
- **KV cache is sized `num_ctx × num_parallel`.** This is the correlation the product needs to
  make visible: raising parallelism multiplies context cost.
- `ollama serve` is a foreground process we can own. `GET /api/version` is the health probe.

### LM Studio

Most control lives in the CLI, not the HTTP API.

- `lms server start` / `lms server stop` / `lms server status`: a real lifecycle, better than
  killing the PID on the port. Host binding via `--host` or `LMS_SERVER_HOST`.
- `lms load <key> --context-length N --gpu <max|off|0.0-1.0> --ttl <s> --identifier <name>`,
  `lms unload [--all]`, `lms ps`, `lms ls`. Already wired in `packages/host/src/lms.ts` (T99),
  including the "exits 0 on Model Not Found" trap and the binary resolution from
  `~/.lmstudio/bin/lms`.
- `GET /api/v0/models` (native, already used): `state` (`loaded` / `not-loaded`),
  `loaded_context_length`, `max_context_length`, plus quantization and architecture fields.
  **No per-model VRAM number over HTTP**, so honest fit reporting for LM Studio needs the CLI
  plus on-disk file size.
- JIT loading: a request for a not-loaded model can load it implicitly, which means a chat can
  silently trigger a multi-gigabyte load. Worth surfacing, not worth fighting.

### vLLM

A different shape: **one model per process, all configuration fixed at launch.**

- `vllm serve <model>` with `--gpu-memory-utilization` (default 0.9), `--max-model-len`,
  `--quantization`, `--kv-cache-dtype` (`fp8` halves KV memory), `--max-num-seqs`,
  `--tensor-parallel-size`, `--cpu-offload-gb`.
- There is no "load a model" call. Switching models means restarting the process. Sleep Mode
  can release weights without killing it, but only through the process's own API.
- `GET /metrics` is Prometheus text: `vllm:kv_cache_usage_perc`, `vllm:num_requests_waiting`,
  `vllm:time_to_first_token_seconds`, and more.
- In practice Linux + NVIDIA + Python. Windows needs WSL, macOS cannot run it.

**Decision (locked): vLLM is connect-existing only.** We detect it, show its configuration and
live `/metrics`, and can stop it. We never spawn it. The planner still computes the fit and
renders the exact `vllm serve` flags as copyable text for the user to run themselves. Nothing
unverifiable ships as a working button. Revisit when there is Linux + NVIDIA hardware to test on.

### The asymmetry, stated plainly

Ollama and LM Studio are **model managers**: a long-lived server you send models to. vLLM is a
**process per model**: configuration is a launch command. One UI covers both only if the
difference is data, not branching. Hence `RuntimeCapabilities`.

---

## Architecture

Three units, each with one job.

```
packages/core/src/capacity/      pure, no I/O: the fit planner
  facts.ts       ModelFacts / HardwareFacts / FitRequest / FitPlan types + guards
  plan.ts        planFit(model, request, hardware) -> FitPlan
  kv.ts          KV-cache and weight math, per dtype
  suggest.ts     ordered, actionable suggestions from a FitPlan

packages/host/src/runtimes/      the control plane (I/O lives here)
  types.ts       RuntimeAdapter, RuntimeCapabilities, RuntimeStatus
  ollama.ts      adapter: serve supervision, /api/ps, /api/show, load via num_ctx/num_gpu
  lmstudio.ts    adapter: lms server start|stop|status, wraps existing lms.ts
  vllm.ts        adapter: detect + status + /metrics + stop only
  supervisor.ts  child-process ownership, PID tracking, health polling, log ring buffer
  registry.ts    kind -> adapter, plus detection across all kinds
  index.ts       the service surface consumed by host.ts

packages/shared/src/runtimes.ts  types + IPC channel contracts

apps/desktop/src/renderer/components/runtimes/
  RuntimeCard.tsx      power toggle, status, address, VRAM bar, resident models
  AddressField.tsx     copy + inline edit
  FitDrawer.tsx        the per-model planner surface
  FitBar.tsx           segmented weights / KV / overhead / free
  AdvancedControls.tsx the expert disclosure
```

### The adapter interface

```ts
export interface RuntimeCapabilities {
  canStart: boolean          // may we spawn it ourselves
  canStop: boolean
  canLoad: boolean           // load/unload individual models at runtime
  canSetContext: boolean     // per-load context length
  canSetGpuLayers: boolean
  canSetParallel: 'per-load' | 'server-env' | false
  canSetKvCacheType: 'per-load' | 'server-env' | false
  configuredAtLaunch: boolean // vLLM: config is a launch command, not a control
  reportsPerModelVram: boolean
}

export interface RuntimeAdapter {
  kind: RuntimeKind
  capabilities: RuntimeCapabilities
  detect(baseUrl: string): Promise<RuntimeDetection>
  status(baseUrl: string): Promise<RuntimeStatus>
  listModels(baseUrl: string): Promise<ModelFacts[]>
  start?(opts: StartOptions): Promise<RuntimeStatus>
  stop?(baseUrl: string): Promise<StopResult>
  load?(baseUrl: string, modelId: string, params: LoadParams): Promise<LoadResult>
  unload?(baseUrl: string, modelId: string): Promise<LoadResult>
}
```

`capabilities` is the honesty mechanism. The renderer asks the capability, never the kind. vLLM
declaring `canStart: false, canLoad: false, configuredAtLaunch: true` is what makes its card
render copyable flags instead of dead buttons, with no `if (kind === 'vllm')` anywhere in the UI.
When phase D adds a bundled engine it declares its own capabilities and the UI already works.

### Process ownership

A server we started is ours: we hold the child handle, we stop it with SIGTERM then SIGKILL, and
we know its PID without asking the OS.

A server we merely found is not ours. The existing `servers.ts` port-killer stays, but it stops
being the default path. **Stopping a foreign process asks first** and says what it is about to
kill. Today we do that silently, which is wrong: the process on port 11434 might be a system
service the user depends on.

`supervisor.ts` keeps owned processes in a map keyed by runtime id, tails the last 200 log lines
into a ring buffer for the card's error surface, and polls health until the server answers or a
startup budget expires (60s: a cold `ollama serve` on a slow disk is not instant).

---

## The fit planner

### Inputs

**`ModelFacts`**, normalized by each adapter:

| Field | Ollama source | LM Studio source | vLLM source |
|---|---|---|---|
| `weightsBytes` | `/api/ps` `size`, else file size | `lms ls --json` size | HF metadata, else unknown |
| `layers` | `model_info.*.block_count` | GGUF metadata via `lms` | config, else unknown |
| `kvHeads` | `model_info.*.attention.head_count_kv` | same | same |
| `headDim` | `embedding_length / head_count` | same | same |
| `maxContext` | `model_info.*.context_length` | `max_context_length` | `--max-model-len` |
| `quantization` | `details.quantization_level` | model key suffix | `--quantization` |

Anything unavailable is `undefined`, never a guess.

**`FitRequest`**: `contextTokens`, `parallelSlots`, `kvCacheDtype` (`f16` | `q8_0` | `q4_0` |
`fp8`), `gpuLayerFraction` (0..1).

**`HardwareFacts`**: per-device VRAM total and free, `unified: boolean`, system RAM total and
free. Sourced from the existing `gpu.ts` (`nvidia-smi`) and `gpu-macos.ts` (`ioreg`, already
flags `unified`) plus `system.ts`.

### The math

```
weightsBytes = actual size on disk or as reported by the runtime
               (NOT parameterCount × quantBits, which is wrong for mixed-precision
                GGUF quants like Q4_K_M where attention tensors carry more bits)

kvCacheBytes = 2                    // one K, one V
             × layers
             × kvHeads
             × headDim
             × contextTokens
             × bytesPerElement(kvCacheDtype)
             × parallelSlots

overheadBytes = compute buffers + runtime reserve
                (per-runtime constant, seeded from measurement, refined by calibration)

required     = weightsBytes + kvCacheBytes + overheadBytes
```

The `× parallelSlots` term is the correlation the product exists to expose: doubling parallelism
doubles KV cost at the same context length, which is why a model that "fit yesterday" stops
fitting when someone raises `OLLAMA_NUM_PARALLEL`.

### Verdicts

| Verdict | Meaning |
|---|---|
| `fits` | required fits in the budget with headroom to spare |
| `tight` | fits, but with less than the headroom margin left; a long conversation may spill |
| `spills` | weights partly on GPU, remainder in system RAM; runs, but far slower |
| `wont-load` | does not fit even in system RAM, or exceeds the model's own max context |
| `unknown` | metadata insufficient to compute a projection |

**`unknown` is first-class.** If we do not have the layer count we say we cannot tell rather than
inferring capacity from a model's name. This matches the constraint already written into AN9b
("never infer a guarantee from a model name or missing probe"), and it is the difference between
a tool people trust and one they stop believing after the first confident wrong answer.

### Unified memory

On Apple Silicon the GPU and CPU share one pool. The budget is **system RAM minus OS headroom**,
not VRAM plus RAM. `HardwareFacts.unified` gates this, and the planner must never sum a unified
device's "VRAM" with system RAM. Getting this wrong makes a 24 GB Mac look like it has 48 GB.

Multiple discrete GPUs are **not pooled by default**: without tensor parallelism a model must fit
on one device. The planner reports the best single device, and notes tensor parallelism as a
suggestion only where the runtime supports it (vLLM).

### Reasons and suggestions

`reasons` are structured, each carrying the number that drove it
(`{ code: 'kv-cache-dominates', bytes, sharePct }`), so the UI writes plain language from data
rather than storing prose. `suggestions` are ordered by benefit-per-cost and each carries the
`FitRequest` delta that would apply it, so a suggestion chip is one click:

- "Drop context to 16k to fit" (`contextTokens: 16384`)
- "Use q8_0 KV cache to save 3.2 GB" (`kvCacheDtype: 'q8_0'`)
- "Pick the Q4_K_M build instead of Q8_0" (a different model id)
- "Reduce parallel slots from 4 to 2" (`parallelSlots: 2`)

### Reconciliation

After a load, the adapter reports measured residency (Ollama's `size` versus `size_vram`; an
`nvidia-smi` free-VRAM delta elsewhere). The measurement is stored beside the projection and
shown as "projected 18.4 GB, actual 19.1 GB", and the delta is written to a per-runtime
calibration record (`runtime-calibration.json`, an exponential moving average of the overhead
residual, clamped to a sane range and discarded on runtime version change).

This is the part that keeps the estimate honest over time: a hardcoded overhead constant is a
guess that never improves, and a projection nobody can check is a projection nobody should trust.

---

## UI

No new nav entry (T136 just removed three). The Models page is restructured so a local provider
renders as a **runtime card**.

**Runtime card (always visible):**
- Power toggle. Real start/stop where `canStart`; a labelled "connect only" state otherwise.
- Status dot plus version and uptime; a failed start shows the tail of the log buffer.
- Address field: monospace, copy button, inline edit that re-detects on save.
- A VRAM bar for the card's device, with resident models segmented into it.
- Resident model rows with their loaded context and, where reported, their own VRAM.

**Fit drawer (opens per model), simple layer by default:**
- One context slider. The `FitBar` under it updates live as it moves: segmented
  weights / KV cache / overhead / free against the device budget.
- A one-line verdict in plain language, generated from `reasons`.
- Up to three suggestion chips, each one click to apply.
- A Load button.

**Advanced disclosure (collapsed by default):**
- Quantization picker where sibling quants exist.
- Parallel slots, KV cache dtype, GPU layer fraction, TTL / keep-alive.
- Controls the runtime only accepts as environment (`OLLAMA_NUM_PARALLEL`,
  `OLLAMA_KV_CACHE_TYPE`) are shown with a restart-required note, since changing them means
  restarting the server. `canSetParallel: 'server-env'` drives that, not a kind check.
- For vLLM, the generated `vllm serve` command, copyable.

The `FitBar` is the whole idea in one widget. If a user drags context from 8k to 64k and watches
the green bar go red before they ever click Load, phase B has done its job.

---

## Errors and safety

- Starting a runtime is a consented, user-initiated action. No autostart on app launch in this
  phase.
- Stopping a process we do not own asks first and names the process. Stopping one we own does not.
- A failed start surfaces the captured stderr, not a generic failure toast. "Port 11434 already
  in use" and "ollama: command not found" are different problems with different fixes.
- Long loads (a 40 GB model on a slow disk) get progress where the runtime reports it and an
  honest indeterminate state where it does not, plus a cancel that actually cancels.
- The planner never blocks a load. A `wont-load` verdict warns clearly and still lets the user
  proceed: our estimate can be wrong, and their machine is theirs.

## Testing

**Planner (pure, table-driven).** The bulk of the test weight, because the math is the product:
CPU-only machine; unified memory with no double-counting; two discrete GPUs that must not be
pooled; missing layer count yielding `unknown` rather than a number; each KV dtype; parallel
slots multiplying KV; context above the model's own max; a model that fits alone but not beside
one already resident; zero and absurd inputs.

**Adapters.** Recorded fixtures for `/api/ps`, `/api/show`, `/api/v0/models`, `lms ls --json`,
and vLLM `/metrics`, including the shapes that break naive parsing (a `model_info` map whose
keys are architecture-prefixed, an `/api/ps` entry with `size_vram: 0`).

**Supervisor.** Start, health-poll, stop, and a start that fails on a busy port, against a stub
server rather than a real runtime.

**Live verification.** Ollama and LM Studio on this Mac, covering the unified-memory path end to
end. The discrete-GPU path (`nvidia-smi`, real spill) against the RTX 5090 Windows machine.
vLLM's adapter is verified only as far as fixtures allow, and is labelled accordingly.

## Out of scope here

Model downloads and catalog browsing (phase C). A bundled engine (phase D). Automatic model
routing by task (AN6b). Autostart on app launch. Multi-machine or remote runtime management.
