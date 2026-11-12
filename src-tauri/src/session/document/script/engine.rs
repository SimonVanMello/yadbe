//! The JavaScript engine of a run: QuickJS (`rquickjs`), one runtime per run on the run's
//! own thread, with a memory and a stack limit and an interrupt hook that stops a runaway
//! script when the run is cancelled or out of time. The context has the language only: no
//! file, network, process, timer or module access (QuickJS's `std` / `os` modules are not
//! linked, and no module loader is set). The prelude adds the mongosh API on the bridge.

use std::rc::Rc;
use std::sync::Arc;

use rquickjs::context::EvalOptions;
use rquickjs::{CaughtError, Context, Ctx, Function, Object, Runtime, Value};

use crate::db::document::json::Json;
use crate::db::errors::YadbeError;
use crate::session::document::model::ScriptMessageKind;
use crate::session::query_model::TextPosition;

use super::bridge::{Bridge, OpenCursor};
use super::shell::{Segment, segments};
use super::{ScriptControl, SourceMap};

/// The engine's heap.
pub const MEMORY_LIMIT: usize = 256 * 1024 * 1024;
/// The engine's stack (the thread has more, for the native calls under it).
pub const STACK_LIMIT: usize = 2 * 1024 * 1024;
/// Text results are cut past this.
const MAX_TEXT_RESULT: usize = 1024 * 1024;

const PRELUDE: &str = include_str!("prelude.js");
const PRELUDE_FILE: &str = "yadbe-prelude";
/// The file name of the user's code in stack traces.
pub const SCRIPT_FILE: &str = "yadbe-script";

/// What the last expression of a script was.
pub enum ScriptValue {
    None,
    Text {
        text: String,
        truncated: bool,
    },
    Documents {
        documents: Vec<Json>,
        single: bool,
    },
    /// A cursor left unread (or partly read): what was read already, and the rest to drain.
    Cursor {
        buffered: Vec<Json>,
        rest: Option<OpenCursor>,
    },
}

/// How the engine ended.
pub struct EngineEnd {
    pub value: ScriptValue,
    /// The error and where it happened in the editor text.
    pub failure: Option<(YadbeError, Option<TextPosition>)>,
    pub database: String,
}

fn catch_text<'js>(ctx: &Ctx<'js>, value: Value<'js>) -> String {
    value
        .as_string()
        .and_then(|s| s.to_string().ok())
        .unwrap_or_else(|| {
            ctx.json_stringify(value)
                .ok()
                .flatten()
                .and_then(|s| s.to_string().ok())
                .unwrap_or_default()
        })
}

/// The first frame of the user's code in a stack trace: `yadbe-script:LINE:COLUMN`.
pub fn frame_position(stack: &str) -> Option<(u32, u32)> {
    let marker = format!("{SCRIPT_FILE}:");
    let at = stack.find(&marker)? + marker.len();
    let mut parts = stack[at..].splitn(3, |c: char| !c.is_ascii_digit());
    let line = parts.next()?.parse().ok()?;
    let column = parts.next()?.parse().ok()?;
    Some((line, column))
}

/// Global code, sloppy mode as in mongosh; `promise`: top-level `await` allowed.
fn eval_options(file: &str, promise: bool) -> EvalOptions {
    let mut options = EvalOptions::default();
    options.global = true;
    options.strict = false;
    options.backtrace_barrier = promise;
    options.promise = promise;
    options.filename = Some(file.to_owned());
    options
}

/// The hooks the prelude returns.
struct Hooks<'js> {
    shell: Function<'js>,
    result: Function<'js>,
    database: Function<'js>,
    describe: Function<'js>,
    yadbe_id: Function<'js>,
}

fn hooks<'js>(ctx: &Ctx<'js>, bridge: &Rc<Bridge>, database: &str) -> rquickjs::Result<Hooks<'js>> {
    let native = Object::new(ctx.clone())?;
    let b = Rc::clone(bridge);
    native.set(
        "op",
        Function::new(ctx.clone(), move |request: String| b.op(&request))?,
    )?;
    let b = Rc::clone(bridge);
    native.set(
        "cursorOpen",
        Function::new(ctx.clone(), move |request: String| b.cursor_open(&request))?,
    )?;
    let b = Rc::clone(bridge);
    native.set(
        "cursorNext",
        Function::new(ctx.clone(), move |id: f64| b.cursor_next(id))?,
    )?;
    let b = Rc::clone(bridge);
    native.set(
        "cursorClose",
        Function::new(ctx.clone(), move |id: f64| b.cursor_close(id))?,
    )?;
    let b = Rc::clone(bridge);
    native.set(
        "print",
        Function::new(ctx.clone(), move |kind: String, text: String| {
            let kind = match kind.as_str() {
                "warn" => ScriptMessageKind::Warn,
                "error" => ScriptMessageKind::Error,
                _ => ScriptMessageKind::Print,
            };
            b.print(kind, text);
        })?,
    )?;
    let b = Rc::clone(bridge);
    native.set(
        "sleep",
        Function::new(ctx.clone(), move |ms: f64| b.sleep(ms))?,
    )?;
    let b = Rc::clone(bridge);
    native.set(
        "unsupported",
        Function::new(ctx.clone(), move |method: String, instead: String| {
            b.stash(YadbeError::mongosh_unsupported(&method, &instead))
        })?,
    )?;
    let b = Rc::clone(bridge);
    native.set(
        "message",
        Function::new(ctx.clone(), move |id: f64| {
            b.stashed(id as i64)
                .map(|e| e.message.en)
                .unwrap_or_default()
        })?,
    )?;
    let options = eval_options(PRELUDE_FILE, false);
    let prelude: Function = ctx.eval_with_options(PRELUDE, options)?;
    let hooks: Object = prelude.call((native, database.to_owned()))?;
    Ok(Hooks {
        shell: hooks.get("shell")?,
        result: hooks.get("result")?,
        database: hooks.get("database")?,
        describe: hooks.get("describe")?,
        yadbe_id: hooks.get("yadbeId")?,
    })
}

/// Runs the jobs the script queued (promise callbacks), until none is left or the run stops.
fn drain_jobs(ctx: &Ctx<'_>, control: &ScriptControl) {
    while ctx.execute_pending_job() {
        if control.interrupted() {
            break;
        }
    }
}

struct Run<'a, 'js> {
    ctx: Ctx<'js>,
    hooks: Hooks<'js>,
    bridge: &'a Rc<Bridge>,
}

impl<'js> Run<'_, 'js> {
    /// The typed error and position of what a script threw.
    fn failure(&self, error: rquickjs::Error) -> (YadbeError, Option<(u32, u32)>) {
        let caught = CaughtError::from_error(&self.ctx, error);
        let (value, stack) = match &caught {
            CaughtError::Exception(exception) => (
                exception.clone().into_value(),
                exception.stack().unwrap_or_default(),
            ),
            CaughtError::Value(value) => (value.clone(), String::new()),
            CaughtError::Error(other) => {
                let error = self
                    .bridge
                    .control
                    .stop_reason()
                    .unwrap_or_else(|| YadbeError::script_error(other.to_string()));
                return (error, None);
            }
        };
        let position = frame_position(&stack);
        // Cancelled or out of time: where the script was when it was stopped.
        if let Some(stop) = self.bridge.control.stop_reason() {
            return (stop, position);
        }
        let id: i64 = self.hooks.yadbe_id.call((value.clone(),)).unwrap_or(-1);
        if let Some(error) = self.bridge.stashed(id) {
            return (error, position);
        }
        let described: String = self
            .hooks
            .describe
            .call((value.clone(),))
            .unwrap_or_else(|_| catch_text(&self.ctx, value));
        let error = if described.contains("out of memory") {
            YadbeError::script_error(format!(
                "{described} (a script has {} MB)",
                MEMORY_LIMIT / 1024 / 1024
            ))
        } else {
            YadbeError::script_error(described)
        };
        (error, position)
    }

    /// Evaluates one piece of JavaScript; its completion value (awaited).
    fn eval(&self, source: String) -> Result<Value<'js>, rquickjs::Error> {
        let options = eval_options(SCRIPT_FILE, true);
        let completion: Value = self.ctx.eval_with_options(source, options)?;
        let completion = self.settle(completion)?;
        // An async script's promise resolves to `{ value }`, its completion value.
        let value = match completion.as_object() {
            Some(object) => object.get::<_, Value>("value")?,
            None => completion,
        };
        let value = self.settle(value)?;
        drain_jobs(&self.ctx, &self.bridge.control);
        Ok(value)
    }

    /// The value of a promise, once the job queue settled it.
    fn settle(&self, value: Value<'js>) -> Result<Value<'js>, rquickjs::Error> {
        let Some(promise) = value.as_promise() else {
            return Ok(value);
        };
        match promise.finish::<Value>() {
            Err(rquickjs::Error::WouldBlock) => Err(rquickjs::Exception::throw_message(
                &self.ctx,
                "the script awaits a promise that never settles",
            )),
            other => other,
        }
    }
}

/// Runs the user's code. `map` places it in the editor text.
pub fn run(
    bridge: &Rc<Bridge>,
    control: &Arc<ScriptControl>,
    code: &str,
    map: &SourceMap,
    database: &str,
) -> EngineEnd {
    let fail = |error: YadbeError| EngineEnd {
        value: ScriptValue::None,
        failure: Some((error, None)),
        database: database.to_owned(),
    };
    let runtime = match Runtime::new() {
        Ok(runtime) => runtime,
        Err(err) => return fail(YadbeError::internal(format!("JavaScript engine: {err}"))),
    };
    runtime.set_memory_limit(MEMORY_LIMIT);
    runtime.set_max_stack_size(STACK_LIMIT);
    let watched = Arc::clone(control);
    runtime.set_interrupt_handler(Some(Box::new(move || watched.interrupted())));
    let context = match Context::full(&runtime) {
        Ok(context) => context,
        Err(err) => return fail(YadbeError::internal(format!("JavaScript context: {err}"))),
    };
    context.with(|ctx| {
        let hooks = match hooks(&ctx, bridge, database) {
            Ok(hooks) => hooks,
            Err(err) => {
                let detail = CaughtError::from_error(&ctx, err).to_string();
                return fail(YadbeError::internal(format!("mongosh prelude: {detail}")));
            }
        };
        let run = Run {
            ctx: ctx.clone(),
            hooks,
            bridge,
        };
        let mut last: Option<Value> = None;
        let mut failure = None;
        for segment in segments(code) {
            match segment {
                Segment::Shell { command, start } => {
                    let (name, argument) = command.parts();
                    match run.hooks.shell.call::<_, Value>((name, argument)) {
                        Ok(answer) => {
                            bridge
                                .print(ScriptMessageKind::Shell, catch_text(&ctx, answer.clone()));
                            last = Some(answer);
                        }
                        Err(err) => {
                            let (error, _) = run.failure(err);
                            failure = Some((error, Some(map.line_start(start))));
                            break;
                        }
                    }
                }
                Segment::Js { start, end } => match run.eval(map.padded(code, start, end)) {
                    Ok(value) => last = Some(value),
                    Err(err) => {
                        let (error, position) = run.failure(err);
                        failure = Some((
                            error,
                            position.map(|(line, column)| map.place(line, column)),
                        ));
                        break;
                    }
                },
            }
        }
        let database = run
            .hooks
            .database
            .call::<_, String>(())
            .unwrap_or_else(|_| database.to_owned());
        if let Some(failure) = failure {
            return EngineEnd {
                value: ScriptValue::None,
                failure: Some(failure),
                database,
            };
        }
        let value = match last {
            None => ScriptValue::None,
            Some(value) => match run.hooks.result.call::<_, String>((value,)) {
                Ok(described) => describe(bridge, &described),
                Err(err) => {
                    let (error, _) = run.failure(err);
                    return EngineEnd {
                        value: ScriptValue::None,
                        failure: Some((error, None)),
                        database,
                    };
                }
            },
        };
        EngineEnd {
            value,
            failure: None,
            database,
        }
    })
}

/// The prelude's description of the result, as a value.
fn describe(bridge: &Bridge, described: &str) -> ScriptValue {
    let Ok(json) = Json::parse(described) else {
        return ScriptValue::None;
    };
    let documents = |key: &str| {
        json.get(key)
            .and_then(Json::as_array)
            .map(<[Json]>::to_vec)
            .unwrap_or_default()
    };
    match json.get("kind").and_then(Json::as_str) {
        Some("text") => {
            let mut text = json
                .get("text")
                .and_then(Json::as_str)
                .unwrap_or_default()
                .to_owned();
            let truncated = text.len() > MAX_TEXT_RESULT;
            if truncated {
                let mut at = MAX_TEXT_RESULT;
                while !text.is_char_boundary(at) {
                    at -= 1;
                }
                text.truncate(at);
            }
            ScriptValue::Text { text, truncated }
        }
        Some("documents") => ScriptValue::Documents {
            documents: documents("documents"),
            single: matches!(json.get("single"), Some(Json::Bool(true))),
        },
        Some("cursor") => {
            let id = json.get("id").and_then(|id| match id {
                Json::Number(n) => n.as_u64().and_then(|n| u32::try_from(n).ok()),
                _ => None,
            });
            ScriptValue::Cursor {
                buffered: documents("buffered"),
                rest: id.and_then(|id| bridge.take_cursor(id)),
            }
        }
        _ => ScriptValue::None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn frames_of_the_user_code() {
        let stack = "    at find (yadbe-prelude:120:7)\n    at <eval> (yadbe-script:4:12)\n";
        assert_eq!(frame_position(stack), Some((4, 12)));
        assert_eq!(frame_position("    at yadbe-script:2:9\n"), Some((2, 9)));
        assert_eq!(frame_position("    at f (yadbe-prelude:3:1)\n"), None);
    }
}
