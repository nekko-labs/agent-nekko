import type { EngineBackend, EngineBuild, EnginePlatform, GpuStats } from '@agent-nekko/shared';

/**
 * Which llama.cpp build this machine should run.
 *
 * llama.cpp publishes one archive per platform and accelerator on every release,
 * named with the build tag (`llama-b7021-bin-win-cuda-12.4-x64.zip`). We match on
 * a pattern rather than a filename so a new release needs no change here, and we
 * order candidates best-first from what the GPU probe actually found rather than
 * from the platform alone: a Windows machine with no NVIDIA card must not be
 * offered the CUDA build as its first choice.
 *
 * Nothing is downloaded from this module. It only decides what would be right,
 * which keeps the decision testable without a network.
 */

const BUILDS: EngineBuild[] = [
  // Windows
  {
    id: 'win-x64-cuda',
    platform: 'win32',
    arch: 'x64',
    backend: 'cuda',
    assetPattern: 'bin-win-cuda',
    requires: 'An NVIDIA GPU with a current driver.',
    // The CUDA archive ships without the runtime libraries; they are a separate
    // asset on the same release, and the build will not start without them.
    companionPattern: 'cudart-llama-bin-win',
  },
  {
    id: 'win-x64-vulkan',
    platform: 'win32',
    arch: 'x64',
    backend: 'vulkan',
    assetPattern: 'bin-win-vulkan',
    requires: 'Any GPU with Vulkan drivers (AMD, Intel, or NVIDIA).',
  },
  {
    id: 'win-x64-cpu',
    platform: 'win32',
    arch: 'x64',
    backend: 'cpu',
    assetPattern: 'bin-win-cpu',
    requires: 'Any x64 processor. Slower, but always works.',
  },
  {
    id: 'win-arm64-cpu',
    platform: 'win32',
    arch: 'arm64',
    backend: 'cpu',
    assetPattern: 'bin-win-arm64',
    requires: 'A Windows on Arm machine.',
  },
  // macOS
  {
    id: 'macos-arm64-metal',
    platform: 'darwin',
    arch: 'arm64',
    backend: 'metal',
    assetPattern: 'bin-macos-arm64',
    requires: 'Apple Silicon. Uses the GPU through Metal.',
  },
  {
    id: 'macos-x64-cpu',
    platform: 'darwin',
    arch: 'x64',
    backend: 'cpu',
    assetPattern: 'bin-macos-x64',
    requires: 'An Intel Mac.',
  },
  // Linux
  {
    id: 'linux-x64-cpu',
    platform: 'linux',
    arch: 'x64',
    backend: 'cpu',
    assetPattern: 'bin-ubuntu-x64',
    requires: 'Any x64 Linux. Slower, but always works.',
  },
  {
    id: 'linux-x64-vulkan',
    platform: 'linux',
    arch: 'x64',
    backend: 'vulkan',
    assetPattern: 'bin-ubuntu-vulkan-x64',
    requires: 'A GPU with Vulkan drivers.',
  },
  {
    id: 'linux-arm64-cpu',
    platform: 'linux',
    arch: 'arm64',
    backend: 'cpu',
    assetPattern: 'bin-ubuntu-arm64',
    requires: 'An arm64 Linux machine.',
  },
];

/**
 * The builds that could run here, best first.
 *
 * "Best" is the accelerator we have evidence for. An NVIDIA reading from
 * `nvidia-smi` is evidence for CUDA; Apple Silicon is evidence for Metal; a GPU
 * we cannot identify is evidence for Vulkan but not for CUDA. With no evidence at
 * all we lead with CPU, because a slow engine that runs beats a fast one that
 * fails to start.
 */
export function buildsFor(
  platform: EnginePlatform,
  arch: string,
  gpu: GpuStats | null,
): EngineBuild[] {
  const candidates = BUILDS.filter((b) => b.platform === platform && b.arch === arch);
  const rank = preferenceOrder(platform, gpu);
  return [...candidates].sort((a, b) => rank.indexOf(a.backend) - rank.indexOf(b.backend));
}

function preferenceOrder(platform: EnginePlatform, gpu: GpuStats | null): EngineBackend[] {
  if (platform === 'darwin') return ['metal', 'cpu', 'vulkan', 'cuda', 'hip'];
  if (gpu?.source === 'nvidia-smi' && gpu.devices.length > 0) return ['cuda', 'vulkan', 'cpu', 'hip', 'metal'];
  // A GPU we know nothing about: Vulkan is the portable accelerated path, and
  // claiming CUDA without an NVIDIA reading would be a guess.
  if (gpu && gpu.devices.length > 0) return ['vulkan', 'cpu', 'cuda', 'hip', 'metal'];
  return ['cpu', 'vulkan', 'cuda', 'hip', 'metal'];
}

/** The build we would install if the user just says yes. */
export function recommendedBuild(
  platform: EnginePlatform,
  arch: string,
  gpu: GpuStats | null,
): EngineBuild | undefined {
  return buildsFor(platform, arch, gpu)[0];
}

/**
 * Pick a release asset for a build.
 *
 * Matching is a substring test against the asset name, plus an extension check,
 * because llama.cpp's names are stable in their middle and volatile at both ends
 * (`llama-b7021-bin-win-cuda-12.4-x64.zip`). Where several CUDA builds exist for
 * different toolkit versions the newest wins, which is what a current driver
 * wants.
 */
export function matchAsset(build: EngineBuild, assetNames: string[]): string | undefined {
  const archive = /\.(zip|tar\.gz|tgz)$/i;
  const hits = assetNames.filter((n) => n.includes(build.assetPattern) && archive.test(n));
  return hits.sort().at(-1);
}

export function matchCompanion(build: EngineBuild, assetNames: string[]): string | undefined {
  if (!build.companionPattern) return undefined;
  const hits = assetNames.filter((n) => n.includes(build.companionPattern as string) && /\.zip$/i.test(n));
  return hits.sort().at(-1);
}

/** Every build we know about, for the "choose it yourself" list. */
export function allBuilds(): EngineBuild[] {
  return BUILDS;
}
