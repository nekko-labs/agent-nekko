//! The agent loop for the engine daemon (PF14), starting with the pieces of
//! packages/core/src/agent that do not talk to a model: repairing an
//! interrupted transcript (`resume.ts`), catching a stream that has collapsed
//! into repetition (`runaway.ts`), and shaping the history a model is sent
//! (`windowHistory` and `asSeenByChatModel` in `loop.ts`). The loop itself
//! follows once the providers (`nekko-agent`) and tools (`nekko-tools`) land.
//!
//! Behavior matches the TS functions exactly; `tests/golden.rs` holds these to
//! outputs the TS functions wrote.

pub mod history;
pub mod resume;
pub mod run;
pub mod runaway;

pub use history::{as_seen_by_chat_model, window_history};
pub use resume::{INTERRUPTED_NOTE, INTERRUPTED_TOOL_OUTPUT, RESUME_PROMPT, repair_interrupted_history};
pub use run::{
    Cancel, ChatRequest, Chunk, ChunkStream, DEFAULT_MAX_STEPS, ModelClient, RunOptions, ToolRunner, run_agent,
};
pub use runaway::{RUNAWAY_NOTE, RunawayGuard, RunawayOptions};
