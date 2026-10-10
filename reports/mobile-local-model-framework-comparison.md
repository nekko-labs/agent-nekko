# On-device models for Nekko Agent: SwiftUI versus React Native

Research against repository baseline `f39374c`; sources accessed 2026-10-06.

## Executive recommendation

**Keep Expo/React Native for Nekko's current iOS-and-Android product. Run inference natively, and evaluate MLX on iOS and LiteRT-LM on both platforms behind the existing engine boundary. Do not rewrite the UI just to improve tokens per second.**

For a new, explicitly Apple-first product, SwiftUI + Swift-native inference would be the cleaner choice: less integration plumbing, direct access to Apple frameworks, and fewer runtime layers to debug. That does not establish that SwiftUI runs the same model faster than React Native.

The major choice is **inference runtime and model**, not UI framework. React Native can call native Swift/C++/Kotlin inference; it does not need to execute model math in JavaScript. SwiftUI does not itself run models or automatically unlock the Neural Engine.

This is a research recommendation, not a settled product decision or a measured performance result. No phone benchmarks, native builds, battery measurements, or App Store validation were performed.

## 1. What Nekko already has

- `apps/mobile/package.json`: Expo, React Native, and `llama.rn` (`^0.13.0-rc.6` declared). An inference dependency on a prerelease deserves explicit release qualification.
- `apps/mobile/src/services/llama.ts`: native llama.cpp initialization, `n_gpu_layers: 99`, memory mapping, one loaded model, streaming callbacks, cancellation, GPU fallback diagnostics, and reported decode speed.
- Its `Engine` interface separates completion, stop, and release from the UI. This is a useful seam for runtime experiments; it is not yet a fully general multi-runtime provider API.
- `apps/mobile/README.md`: phone inference requires a development/native build, not Expo Go; browser preview cannot verify it. iOS builds require macOS/Xcode. Store signing and release setup are not established in that document.
- `SPEC.md`, “Your agent in your pocket”: both iOS and Android, curated GGUF downloads, local chats, and a separately paired remote-computer experience. Phone-local chat is not proof of a complete on-phone coding-agent tool loop.

A SwiftUI rewrite would replace substantial client work while still requiring an Android implementation. Existing protocol/types and tests are reusable design assets, but the Node-based desktop host is not automatically portable into Hermes or iOS.

## 2. Direct comparison

| Dimension | SwiftUI iOS client | React Native / Expo client |
|---|---|---|
| On-device model support | Direct Swift packages/APIs: MLX Swift LM, llama.cpp wrapper, LiteRT-LM, Foundation Models, Core ML | Existing llama.rn native C++ runtime; Swift/Kotlin modules can expose additional runtimes |
| Same llama.cpp + same Metal configuration | No inherent UI-framework advantage in kernel speed | Native kernels do the computation; boundary and UI overhead still require measurement |
| Apple framework integration | Best developer ergonomics; direct lifecycle, tooling, and API access | Feasible, but sometimes requires platform-specific modules/configuration and compatibility maintenance |
| UI and streaming | Fewer runtime layers; updates can still overwhelm the main thread | Extra JS/runtime memory and event/render work; batch streaming and avoid repeated full transcript parsing |
| Peak memory | Potentially lower application overhead; must measure actual builds | Hermes/React/native views add overhead; this matters near a phone's memory limit |
| Android | Separate Android app needed | Shared client, with platform-specific inference backends and lifecycle work |
| Model portability | Depends on runtime: GGUF, MLX weights, compiled assets, or system model | Same dependency on runtime; current GGUF catalog already fits llama.rn |
| Maintenance for Nekko | Rewrite + two platform clients; strong Apple specialization | Least disruption; retain TS client investment and add native specializations selectively |
| Best fit | Apple-only/Apple-first product with deep OS integration | Nekko's existing cross-platform product and small-team delivery |

### Performance interpretation

With identical model bytes, llama.cpp commit, Metal kernels, context/cache configuration, and device, **similar core inference throughput is a reasonable hypothesis, not a benchmark result**. A Swift client can still win end-to-end if its lower overhead avoids memory pressure or expensive rendering. React Native can remain competitive if inference stays native and events are batched.

Modern React Native's JSI removes the legacy asynchronous serialized bridge as an architectural requirement [1]. It does not mean every callback is free, nor prove a particular binding performs zero copying. Profile the actual library/version.

Do not compare SwiftUI + MLX with React Native + llama.cpp and attribute all differences to SwiftUI. That changes two variables. Measure engine-only throughput and visible-stream latency separately.

## 3. Runtime options that matter more than UI

### llama.cpp / llama.rn — retain as the baseline

Best match for a broad downloadable GGUF catalog and Nekko's existing desktop model ecosystem. Upstream llama.rn documents Metal on iOS, OpenCL on supported Android GPUs, and **experimental** Qualcomm Hexagon support. It also documents structured output, tool calling, and multimodal integration [2]. These are upstream capabilities, not verified Nekko features or guarantees for every model.

Android acceleration is device/driver-specific. Upstream currently describes tested OpenCL support on Adreno 700+ and experimental HTP on SM8450+; do not generalize that to all Android phones. Confirm the backend actually selected at runtime. CPU fallback is a compatibility path, not a performance promise.

### MLX Swift LM — strongest Apple-focused challenger

MLX Swift LM provides Swift LLM/VLM libraries; official examples run chat models on iOS and macOS [3,4]. It is attractive for an Apple-specialized inference layer and fast experimentation with supported architectures.

Trade-offs: Apple-focused coverage, a different model packaging ecosystem from GGUF, architecture/version compatibility, and ongoing API evolution. The current upstream main branch documents a breaking 3.x transition [3]. Pin versions instead of depending on moving main.

**MLX can be wrapped in a Swift Expo module; adopting it does not require adopting SwiftUI.** Metal GPU acceleration is not the same as Neural Engine execution. Do not extrapolate Mac throughput to iPhone.

### Apple Foundation Models — optional system-model provider

Apple provides a native Swift framework for model integration. Current Apple documentation describes on-device models, Private Cloud Compute, and other providers [5]. Therefore **“Foundation Models” is not by itself an offline/privacy guarantee**: choose an explicitly on-device path and test that no request routes elsewhere.

An OS-managed on-device model can reduce the app's model-download/setup burden. It is not a drop-in replacement for a user-selectable GGUF catalog. Availability depends on compatible device/OS, downloaded assets, language/region, settings, and API generation; use runtime availability checks and an honest fallback UI. Benchmark suitability for Nekko's coding, structured output, and tool tasks rather than assuming frontier-equivalent ability.

SwiftUI makes integration straightforward; React Native can access it through a Swift module [6].

### LiteRT-LM — prioritize an experiment

Google's current docs describe cross-platform on-device LLM execution, multimodality, tool use, and GPU/NPU acceleration. The Swift guide explicitly supports Metal-backed GPU inference [7,8]. This is no longer an Android-only option.

Potential fit: a curated, mobile-optimized catalog, particularly models available in `.litertlm` format. Costs: separate artifacts/conversion, model/backend support constraints, native-module integration, and qualification on actual devices. Marketing claims and runtime-wide accelerator support do not prove a specific model runs on a specific phone NPU.

The current landing page and Swift guide differ in wording about macOS readiness. Treat iOS as the documented experiment target here and verify release-specific platform support before committing to macOS coverage.

### ExecuTorch / Core ML — useful for optimized model pipelines

ExecuTorch documents mobile LLM deployment and hardware-specific backends, including Core ML and Qualcomm paths [9]. Consider it when Nekko controls a small set of model artifacts and can invest in export, quantization, compilation, and backend validation. React Native integration is possible through native bindings.

Core ML is a runtime/model-deployment choice, not a UI framework. Neural Engine benefits depend on supported operations, conversion, shapes, precision, device, and scheduling. It is not a universal accelerator for arbitrary GGUF files. This research did not inspect detailed Core ML documentation: the fetched page returned only a JavaScript documentation shell.

### MLC LLM — compiler-oriented alternative

MLC provides iOS Swift and Android deployment paths. Its iOS workflow compiles model libraries and packages runtime/tokenizer assets [10]. Attractive when optimizing a controlled catalog; more build/model-pipeline complexity than loading arbitrary supported GGUF files. Keep as a secondary experiment, not a reason to rewrite Nekko.

## 4. Other current framework options

“Current” here means documented, relevant alternatives, not a measured popularity ranking.

| Option | Why consider it | Why not switch Nekko now? |
|---|---|---|
| SwiftUI + Jetpack Compose | Direct platform SDK access and tailored native UX | Two UI implementations; no automatic inference gain |
| Kotlin Multiplatform, with SwiftUI + Compose or shared Compose UI | Share business/protocol logic while retaining native adapters; Compose supports iOS and Android [11] | Significant TS migration; still need platform runtime bindings |
| Flutter | Cross-platform UI; C-compatible native libraries callable through Dart FFI [12]; Google documents a community LiteRT-LM Flutter package [7] | Dart rewrite and plugin qualification; not inherently faster model math |
| Tauri 2 | Web UI plus Rust/native backend, mobile support; interesting alongside Nekko's Rust work [13] | WebView/UI trade-offs and mobile integration work; desktop daemon/process assumptions cannot simply be transplanted to iOS |

For Nekko, a hybrid **React Native client + specialized native engines** offers most of the useful flexibility without another client rewrite. Shared UI does not require identical model runtimes on both platforms.

## 5. Phone constraints neither framework removes

1. **Memory is a hard gate.** Dense 4-bit weights have a theoretical floor of roughly 0.5 GB per billion parameters: 1B ~0.5 GB, 2B ~1 GB, 4B ~2 GB, before quantization metadata, tokenizer, KV cache, buffers, app overhead, and multimodal components. Real files and peaks are larger. For mixture-of-experts models, active parameter count is not total stored weight size. Physical RAM is not an app's usable budget.
2. **Long context can dominate.** Larger caches increase memory; prefill latency can make an apparently fast decoder feel slow. Default to conservative context and one loaded model; avoid copying the desktop agent prompt/tool inventory blindly.
3. **Sustained speed differs from a cold benchmark.** Measure heat, battery, and throughput after repeated turns, not just the first answer.
4. **Background behavior is constrained.** A normal phone app should not promise an indefinitely running background agent. Qualify foreground/background transitions and permitted task APIs; recover state after suspension. SwiftUI does not exempt an app from iOS scheduling.
5. **Tools remain sandboxed.** Local inference does not give iOS arbitrary filesystem access, shell execution, or control of other apps. Model-generated calls need permission-scoped native tools and approvals. Remote computer execution remains a distinct trust boundary.
6. **Offline is an observable contract.** Downloading needs connectivity initially. Afterwards prove airplane-mode operation and inspect network activity; no silent cloud fallback. Keep explicit local/remote routing and label where execution happens.
7. **Model delivery needs release work.** Pin sources and checksums, verify licenses, support interrupted downloads, budget disk/cache, exclude replaceable weights from backups, and validate entitlements/store behavior in signed builds. These are qualification items, not findings that every current implementation is defective.

## 6. Proposed experiment and decision gate

Use three stages so the results identify the actual bottleneck:

1. **Isolate UI overhead:** release-build RN/llama.rn versus a minimal Swift harness using matching llama.cpp revision, GGUF bytes, kernels/build flags, context, thread count, offload, sampler, and cache state. Run both headless inference and streaming UI. If matching commits is impossible, record the confound explicitly.
2. **Compare engines:** on the same iPhone, test llama.cpp versus MLX versus LiteRT-LM using the same base model and closest available quantization/quality. Different formats are not automatically numerically equivalent; check task quality alongside speed. Add Android llama.rn versus LiteRT-LM.
3. **Test the product:** actual chat UI, multi-turn history, structured outputs, cancellation, load/unload, low-memory events, interrupted downloads, and background/resume. Confirm GPU/NPU selection rather than assuming it.

Device matrix: oldest intended iPhone, a current mainstream iPhone, a higher-memory iPhone; Android midrange, recent Snapdragon flagship, and a non-Qualcomm device. Use physical devices, not simulators, for accelerator/thermal claims.

Record cold/warm load time, first visible token and prefill time, native decode tokens/s, visible-stream latency, peak resident memory, dropped frames, cancellation latency, battery/energy, thermal state, and sustained speed over 10–15 minutes. Use fixed prompts at short and long contexts, repeated runs, and median/tail results. Keep OS, runtime commit, model hash, build configuration, and device state with results.

Evaluate Nekko-specific quality: summarization, small code edits, valid constrained JSON, selecting the right tool, refusing out-of-scope actions, and completing several tool turns without drifting. Grammar-valid output is not the same as a correct action.

**Decision gate:** keep RN if it meets agreed user-experience and memory budgets. Adopt a native engine adapter if an alternative improves latency, sustained efficiency, or fit at comparable task quality. Consider a SwiftUI rewrite only if measured client overhead or Apple-specific UX requirements remain material after targeted fixes. Set budgets before testing; no numerical winner is asserted here.

## 7. Scope and next steps

- No implementation or UI changes; no visual delta. `SPEC.md` remains unchanged because this report explores options rather than settling a product decision.
- Public documentation establishes available integration paths, not Nekko's release readiness or a speed ranking. Upstream main-branch claims may exceed the installed dependency's capabilities.
- Next engineering step: benchmark the existing phone engine first, then build one iOS native adapter experiment rather than another complete app.

## Primary sources

1. React Native architecture: https://reactnative.dev/architecture/landing-page
2. llama.rn installation, acceleration, Expo integration and API: https://github.com/mybigday/llama.rn/blob/main/README.md
3. MLX Swift LM: https://github.com/ml-explore/mlx-swift-lm
4. Official MLX Swift examples: https://github.com/ml-explore/mlx-swift-examples
5. Apple Intelligence / Foundation Models overview: https://developer.apple.com/apple-intelligence/
6. Expo Swift/Kotlin native modules: https://docs.expo.dev/modules/overview/
7. LiteRT-LM overview and integration options: https://developers.google.com/edge/litert-lm
8. LiteRT-LM Swift API: https://developers.google.com/edge/litert-lm/swift
9. ExecuTorch mobile LLM deployment: https://docs.pytorch.org/executorch/stable/llm/getting-started.html
10. MLC LLM iOS Swift SDK: https://llm.mlc.ai/docs/deploy/ios.html
11. Compose Multiplatform relationship/platform support: https://kotlinlang.org/docs/multiplatform/compose-multiplatform-and-jetpack-compose.html
12. Flutter native FFI: https://docs.flutter.dev/platform-integration/bind-native-code
13. Tauri overview: https://v2.tauri.app/start/
