import {
  STACK_ROLES,
  type CatalogEntry,
  type MachineFacts,
  type ReadinessCatalog,
  type ReadinessReason,
  type ReadinessReport,
  type ReadinessVerdict,
  type RoleAssessment,
  type StackRole,
} from '@agent-nekko/shared';

/**
 * The machine-readiness advisor (AN9b): given what a machine provably has and a
 * versioned catalog of stack components, pick a concurrently-resident set and
 * say how sure we are.
 *
 * Pure like `planFit`, and bound by the same honesty rules: a probe that did
 * not run produces `unverified`, never a guess; unified memory is one pool;
 * discrete GPUs are never summed; an absent artifact hash is reported, not
 * invented.
 *
 * Placement model: GPU-preferring components (the intent LLM) take the roomiest
 * single device that still has space, falling back to RAM when none does.
 * Everything else is RAM-resident. The stack must also leave the machine room
 * to live in, so the RAM budget holds back a fixed reserve for the OS and the
 * user's own applications. On a unified machine there is exactly one pool and
 * every component draws from it.
 */

/** What the OS plus the user's normal apps keep; the stack does not spend it. */
const STACK_RESERVE_BYTES = 4 * 1024 ** 3;

export interface EvaluateOptions {
  /** Roles to fill. Defaults to the whole stack. */
  roles?: StackRole[];
  /** BCP-47-ish code the speech roles must cover. Defaults to 'en'. */
  language?: string;
}

interface Candidate {
  entry: CatalogEntry;
  /** Probe-dependent gates we could not verify; caps the role at `unverified`. */
  unprobed: ReadinessReason[];
}

/** How sure a verdict is; the stack's verdict is the worst of its roles. */
const VERDICT_RANK: Record<ReadinessVerdict, number> = {
  insufficient: 0,
  unverified: 1,
  compatible: 2,
  recommended: 3,
};

export function evaluateReadiness(
  facts: MachineFacts,
  catalog: ReadinessCatalog,
  opts: EvaluateOptions = {},
): ReadinessReport {
  const language = opts.language ?? 'en';
  const roles = opts.roles ?? STACK_ROLES;
  const unknowns: string[] = [];
  if (facts.cpuFeatures === null) unknowns.push('cpu features');
  if (facts.diskFreeBytes === null) unknowns.push('free disk');

  const reportReasons: ReadinessReason[] = [];
  if (facts.unified) reportReasons.push({ code: 'unified-memory' });
  if (facts.devices.length > 1 && !facts.unified) {
    reportReasons.push({ code: 'devices-not-pooled', detail: String(facts.devices.length) });
  }

  // ---- Per-role eligibility: hard gates exclude, unprobed gates cap. --------
  const eligible = new Map<StackRole, { candidates: Candidate[]; failures: ReadinessReason[] }>();
  for (const role of roles) {
    const candidates: Candidate[] = [];
    const failures: ReadinessReason[] = [];
    for (const entry of catalog.entries.filter((e) => e.role === role)) {
      const { hard, soft } = classifyEntry(entry, facts, language);
      if (hard.length > 0) {
        for (const r of hard) failures.push({ ...r, detail: detailWith(r.detail, entry.id) });
      } else {
        candidates.push({ entry, unprobed: soft });
      }
    }
    eligible.set(role, { candidates, failures });
  }

  // ---- Placement: devices are single pools, RAM accumulates what GPUs cannot
  // hold. The intent model places first (largest, GPU-preferring), then the
  // smaller roles wrap around it. Intent is also the one role with a wide size
  // range, so when a later role cannot place we demote the intent pick and
  // retry: a complete stack on a smaller brain beats a bigger brain alone.
  interface Placement {
    entry: CatalogEntry;
    onGpu: boolean;
    unprobed: ReadinessReason[];
  }
  const exhausted = new Set<StackRole>();
  const picksByRole = new Map<StackRole, Placement>();
  const deviceFree = facts.devices.map((d) => d.freeBytes);
  let ramUsedBytes = 0;

  const placeAll = (intentStart: number) => {
    picksByRole.clear();
    exhausted.clear();
    deviceFree.forEach((_, i) => {
      deviceFree[i] = facts.devices[i].freeBytes;
    });
    ramUsedBytes = 0;
    const orderedRoles = [...roles].sort((a, b) => rolePriority(a) - rolePriority(b));
    for (const role of orderedRoles) {
      const { candidates } = eligible.get(role) ?? { candidates: [] };
      const start = role === 'intent' ? intentStart : 0;
      let placed: Placement | null = null;
      for (const cand of candidates.slice(start)) {
        const e = cand.entry;
        if (e.prefersGpu && !facts.unified && deviceFree.length > 0) {
          const idx = roomiest(deviceFree);
          if (deviceFree[idx] >= e.memoryBytes) {
            deviceFree[idx] -= e.memoryBytes;
            placed = { entry: e, onGpu: true, unprobed: cand.unprobed };
            break;
          }
        }
        if (facts.systemRamFreeBytes - ramUsedBytes - STACK_RESERVE_BYTES >= e.memoryBytes) {
          ramUsedBytes += e.memoryBytes;
          placed = { entry: e, onGpu: false, unprobed: cand.unprobed };
          break;
        }
      }
      if (placed) picksByRole.set(role, placed);
      else if (candidates.slice(start).length > 0) exhausted.add(role);
    }
  };

  let intentStart = 0;
  for (;;) {
    placeAll(intentStart);
    if (exhausted.size === 0 || !roles.includes('intent')) break;
    // Demotion only frees room: roles with no eligible candidate at all (every
    // entry hard-failed) cannot be helped by it.
    const unfilled = roles.filter((r) => !picksByRole.has(r));
    if (unfilled.every((r) => (eligible.get(r)?.candidates.length ?? 0) === 0)) break;
    const intentPick = picksByRole.get('intent');
    const intentCands = eligible.get('intent')?.candidates ?? [];
    const curIdx = intentPick ? intentCands.findIndex((c) => c.entry === intentPick.entry) : -1;
    if (curIdx < 0 || curIdx + 1 >= intentCands.length) break;
    intentStart = curIdx + 1;
  }

  const assessments: RoleAssessment[] = [];
  for (const role of roles) {
    const { candidates, failures } = eligible.get(role) ?? { candidates: [], failures: [] };
    const placed = picksByRole.get(role);
    if (!placed) {
      const reasons: ReadinessReason[] = dedupeReasons(failures);
      if (exhausted.has(role)) reasons.push({ code: 'low-memory' });
      reasons.push({ code: 'no-candidate' });
      assessments.push({ role, verdict: 'insufficient', pick: null, alternates: [], reasons });
      continue;
    }
    const { entry, onGpu, unprobed } = placed;
    const reasons: ReadinessReason[] = [...unprobed];
    if (entry.prefersGpu && !onGpu && !facts.unified) reasons.push({ code: 'cpu-only' });
    if (!entry.artifact.sha256) reasons.push({ code: 'artifact-unpinned' });
    const meetsRecommended = recommendedMet(entry, facts, onGpu);
    if (!meetsRecommended) reasons.push({ code: 'below-recommended' });

    const verdict: ReadinessVerdict =
      unprobed.length > 0 ? 'unverified' : meetsRecommended ? 'recommended' : 'compatible';
    assessments.push({
      role,
      verdict,
      pick: entry,
      alternates: candidates.filter((c) => c.entry !== entry).map((c) => c.entry),
      reasons,
    });
  }

  // ---- Combined budget: what the picks cost together, disk included. --------
  const picked = assessments.map((a) => a.pick).filter((e): e is CatalogEntry => e !== null);
  const combinedMemory = picked.reduce((s, e) => s + e.memoryBytes, 0);
  const combinedInstall = picked.reduce((s, e) => s + e.installBytes, 0);
  const ramBudget = Math.max(0, facts.systemRamFreeBytes - STACK_RESERVE_BYTES);
  // "Budget" is what the stack was measured against: the roomiest single device
  // before placement plus RAM minus reserve (or the one unified pool alone).
  const roomiestDevice = facts.devices.reduce((m, d) => Math.max(m, d.freeBytes), 0);
  const budgetBytes = facts.unified ? ramBudget : ramBudget + roomiestDevice;

  if (ramUsedBytes > ramBudget) {
    reportReasons.push({ code: 'combined-exceeds-memory', bytes: ramUsedBytes });
  }
  if (facts.diskFreeBytes === null) {
    // The disk gate was already carried per-pick via 'disk-unprobed'.
  } else if (combinedInstall > facts.diskFreeBytes) {
    reportReasons.push({ code: 'combined-exceeds-disk', bytes: combinedInstall });
  }

  let verdict: ReadinessVerdict = 'recommended';
  for (const a of assessments) {
    if (VERDICT_RANK[a.verdict] < VERDICT_RANK[verdict]) verdict = a.verdict;
  }
  // Placement already holds RAM inside its budget, so a combined memory
  // overflow shows up as an unfilled role. Disk is different: it is only
  // checked here, at the whole-stack level.
  if (verdict !== 'insufficient' && facts.diskFreeBytes !== null && combinedInstall > facts.diskFreeBytes) {
    verdict = 'insufficient';
  }

  return {
    verdict,
    catalogVersion: catalog.version,
    roles: assessments,
    combined: {
      memoryBytes: combinedMemory,
      budgetBytes,
      installBytes: combinedInstall,
      diskFreeBytes: facts.diskFreeBytes,
    },
    reasons: dedupeReasons(reportReasons),
    unknowns,
  };
}

/** intent places first (largest, GPU-preferring); the runtime is tiny and last. */
function rolePriority(role: StackRole): number {
  switch (role) {
    case 'intent': return 0;
    case 'stt': return 1;
    case 'tts': return 2;
    case 'runtime': return 3;
  }
}

function roomiest(free: number[]): number {
  let best = 0;
  for (let i = 1; i < free.length; i++) if (free[i] > free[best]) best = i;
  return best;
}

/**
 * Hard gates exclude a candidate outright; soft gates are probe gaps that keep
 * it eligible but cap its verdict at `unverified`.
 */
function classifyEntry(
  e: CatalogEntry,
  facts: MachineFacts,
  language: string,
): { hard: ReadinessReason[]; soft: ReadinessReason[] } {
  const hard: ReadinessReason[] = [];
  const soft: ReadinessReason[] = [];
  const req = e.requires ?? {};

  if (req.os && !req.os.includes(facts.os.platform)) hard.push({ code: 'unsupported-os', detail: facts.os.platform });
  if (req.arch && !req.arch.includes(facts.os.arch)) hard.push({ code: 'unsupported-arch', detail: facts.os.arch });
  if (req.backends && !req.backends.some((b) => facts.backends.includes(b))) {
    hard.push({ code: 'missing-backend', detail: req.backends.join('|') });
  }
  if (e.languages !== 'any' && !e.languages.includes(language)) {
    hard.push({ code: 'unsupported-language', detail: language });
  }
  if (req.cpuFeatures?.length) {
    if (facts.cpuFeatures === null) {
      soft.push({ code: 'cpu-feature-unprobed', detail: req.cpuFeatures.join(',') });
    } else {
      const missing = req.cpuFeatures.filter((f) => !facts.cpuFeatures!.includes(f));
      if (missing.length > 0) hard.push({ code: 'missing-cpu-feature', detail: missing.join(',') });
    }
  }
  if (req.minRamBytes !== undefined && facts.systemRamTotalBytes < req.minRamBytes) {
    hard.push({ code: 'low-memory', bytes: req.minRamBytes });
  }
  if (req.minVramBytes !== undefined) {
    const roomiestDevice = facts.devices.reduce((m, d) => Math.max(m, d.totalBytes), 0);
    if (roomiestDevice < req.minVramBytes) hard.push({ code: 'low-vram', bytes: req.minVramBytes });
  }
  if (req.minDiskBytes !== undefined) {
    if (facts.diskFreeBytes === null) soft.push({ code: 'disk-unprobed' });
    else if (facts.diskFreeBytes < req.minDiskBytes) hard.push({ code: 'low-disk', bytes: req.minDiskBytes });
  }
  return { hard, soft };
}

function recommendedMet(e: CatalogEntry, facts: MachineFacts, onGpu: boolean): boolean {
  const rec = e.recommended;
  if (!rec) return true;
  if (rec.backends && !rec.backends.some((b) => facts.backends.includes(b) && (!e.prefersGpu || onGpu || facts.unified))) {
    return false;
  }
  if (rec.minRamBytes !== undefined && facts.systemRamTotalBytes < rec.minRamBytes) return false;
  if (rec.minVramBytes !== undefined) {
    const roomiestDevice = facts.devices.reduce((m, d) => Math.max(m, d.totalBytes), 0);
    if (roomiestDevice < rec.minVramBytes) return false;
  }
  return true;
}

function dedupeReasons(reasons: ReadinessReason[]): ReadinessReason[] {
  const seen = new Set<string>();
  return reasons.filter((r) => {
    const key = `${r.code}|${r.detail ?? ''}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function detailWith(detail: string | undefined, id: string): string {
  return detail ? `${id}:${detail}` : id;
}
