//! The model server's data plane, served from the daemon (`nekko-infer`).
//!
//! The TS engine keeps deciding what to load and with which arguments; it
//! sends the resulting command here (`infer:spawn`), and the daemon owns the
//! process and the OpenAI-compatible port in front of it. When the router
//! needs a model that is not running, it asks the TS engine to load it
//! (`engine:routerLoad`), which comes back through `infer:spawn`.

use crate::backend::Backend;
use nekko_infer::{BoxFuture, EngineRouter, Policy, ServeConfig, SpawnSpec, Supervisor};
use serde_json::{Value, json};
use std::sync::Arc;

pub struct Engine {
    pub supervisor: Arc<Supervisor>,
    pub router: EngineRouter,
}

impl Engine {
    pub fn new(backend: Arc<Backend>) -> Self {
        let supervisor = Arc::new(Supervisor::new());
        let router = EngineRouter::new(supervisor.clone(), Arc::new(BackendPolicy { backend }));
        Self { supervisor, router }
    }

    pub fn shutdown(&self) {
        self.router.stop();
        self.supervisor.kill_all();
    }
}

struct BackendPolicy {
    backend: Arc<Backend>,
}

impl Policy for BackendPolicy {
    fn load(&self, model: String, image: bool) -> BoxFuture<Result<(), (u16, String)>> {
        let backend = self.backend.clone();
        Box::pin(async move {
            let r = backend.call("engine:routerLoad", json!([model, image])).await.map_err(|e| (503, e))?;
            if r.get("ok").and_then(Value::as_bool) == Some(true) {
                return Ok(());
            }
            let status = r.get("status").and_then(Value::as_u64).unwrap_or(503) as u16;
            let message = r.get("message").and_then(Value::as_str).unwrap_or("Couldn't load the model.").to_string();
            Err((status, message))
        })
    }

    fn models(&self) -> BoxFuture<Result<Value, String>> {
        let backend = self.backend.clone();
        Box::pin(async move { backend.call("engine:routerModels", json!([])).await })
    }

    fn model(&self, id: String) -> BoxFuture<Result<Option<Value>, String>> {
        let backend = self.backend.clone();
        Box::pin(async move {
            let v = backend.call("engine:routerModel", json!([id])).await?;
            Ok((!v.is_null()).then_some(v))
        })
    }
}

fn arg(args: &[Value], i: usize) -> &Value {
    args.get(i).unwrap_or(&Value::Null)
}

/// The `infer:*` channels.
pub async fn route(engine: &Engine, channel: &str, args: &[Value]) -> Option<Result<Value, String>> {
    Some(match channel {
        "infer:serve" => match serde_json::from_value::<ServeConfig>(arg(args, 0).clone()) {
            Ok(cfg) => engine.router.serve(cfg).await.map(|m| json!({ "ok": true, "message": m })),
            Err(e) => Err(format!("bad serve config: {e}")),
        },
        "infer:stopServing" => {
            engine.router.stop();
            Ok(Value::Null)
        }
        "infer:serving" => Ok(serde_json::to_value(engine.router.serving()).unwrap_or(Value::Null)),
        "infer:spawn" => match serde_json::from_value::<SpawnSpec>(arg(args, 0).clone()) {
            Ok(spec) => Ok(serde_json::to_value(engine.supervisor.spawn(spec).await).unwrap_or(Value::Null)),
            Err(e) => Err(format!("bad spawn spec: {e}")),
        },
        "infer:kill" => Ok(json!(engine.supervisor.kill(arg(args, 0).as_str().unwrap_or_default()))),
        "infer:list" => Ok(serde_json::to_value(engine.supervisor.list()).unwrap_or(json!([]))),
        "infer:log" => Ok(json!(engine.supervisor.log(arg(args, 0).as_str().unwrap_or_default()))),
        _ => return None,
    })
}
