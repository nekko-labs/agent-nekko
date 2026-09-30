//! The Agent Nekko model server's data plane, run inside `nekkod`.
//!
//! - [`Supervisor`]: one process per loaded model (llama.cpp, stable-diffusion.cpp
//!   or MLX), started, health-checked, logged and stopped.
//! - [`EngineRouter`]: the one OpenAI-compatible address in front of them.
//!
//! Which model to load with which arguments stays with the TS engine (the
//! [`Policy`]); this crate owns the processes and the request path, so a
//! restart of the TS backend neither drops loaded models nor interrupts a
//! generation in progress.

mod router;
mod supervisor;

pub use router::{BoxFuture, EngineRouter, Policy, ServeConfig};
pub use supervisor::{ChildInfo, Kind, PORT_PLACEHOLDER, SpawnOutcome, SpawnSpec, Supervisor};
