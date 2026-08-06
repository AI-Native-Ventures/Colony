# Phase 3: Worker Mode and Seat Bindings

## The one-sentence summary

Give a member's machine a way to actually execute the jobs filed against employees.

## What problem this solves

Phase 2 built the queue but nothing reads from it. A human files a job, a human
claims it to prove it's their work, but then nothing happens -- no LLM runs on
the instruction, no result is posted, and the job just sits there leased until
the lease lapses. This phase is the thing that actually does the work.

## Files

### New

1. `crates/buzz-cli/src/seat.rs` -- Seat binding configuration
2. `crates/buzz-cli/src/llm.rs` -- LLM caller (simple, provider-agnostic)
3. `crates/buzz-cli/src/worker.rs` -- The worker loop
4. `migrations/0045_seat_bindings.sql` -- (maybe) relay-side seat binding records

### Modified

5. `crates/buzz-cli/src/lib.rs` -- Add `JobsCmd::Work` subcommand
6. `crates/buzz-cli/src/commands/jobs.rs` -- Wire worker dispatch
7. `crates/buzz-cli/src/commands/mod.rs` -- Register worker module

## 1. Seat binding configuration (`seat.rs`)

A member chooses which provider and model to use for each employee's work on
their machine. This is local configuration, not relay state, because it names
provider credentials that live on the machine.

```rust
/// One provider/model pair a member can try.
struct Binding {
    /// What to call (e.g. `"openrouter"`, `"deepseek"`).
    provider: String,
    /// The model id on that provider (`"anthropic/claude-sonnet-4"`).
    model: String,
    /// Env var holding the API key (`"OPENROUTER_API_KEY"`).
    key_var: String,
}

/// How a given employee runs on this machine.
struct EmployeeBindings {
    /// Try these in order. If one fails, try the next.
    bindings: Vec<Binding>,
}

/// A member's seat: what runs where, on which budget.
struct SeatConfig {
    /// The fallback when no per-employee override says otherwise.
    default: EmployeeBindings,
    /// Per-employee overrides, keyed by pubkey hex.
    employees: HashMap<String, EmployeeBindings>,
}
```

Read from `~/.config/buzz/seat.toml`:

```toml
[default]
bindings = [
  { provider = "deepseek", model = "deepseek-chat" },
]

[employees."abc123..."]
bindings = [
  { provider = "openrouter", model = "anthropic/claude-sonnet-4" },
  { provider = "openrouter", model = "openai/gpt-5" },
  { provider = "deepseek", model = "deepseek-chat" },
]
```

The provider name picks the API format:
- `openrouter` -- `https://openrouter.ai/api/v1/chat/completions`  
- `deepseek` -- `https://api.deepseek.com/v1/chat/completions`
- `openai` -- `https://api.openai.com/v1/chat/completions`
- `anthropic` -- `https://api.anthropic.com/v1/messages`

The key for each provider is read from:
- `OPENROUTER_API_KEY`
- `DEEPSEEK_API_KEY`
- `OPENAI_API_KEY`
- `ANTHROPIC_API_KEY`

Following CLAUDE.md, neither the provider name nor the model id is hardcoded.

## 2. LLM caller (`llm.rs`)

One function: send an instruction to a provider and get the response back.

```rust
pub async fn call_llm(
    instruction: &str,
    binding: &Binding,
    timeout: Duration,
) -> Result<LlmLoopback, LlmError> {
    // Reads the API key from the env var named in binding.key_var
    // Builds a chat completion request to the provider's endpoint
    // Returns the model's text response
}
```

`LlmLoopback` carries:
- `response: String` -- what the model said
- `provider: String` -- which provider served it
- `model: String` -- which model id
- `input_tokens: u32` -- tokens consumed on the request
- `output_tokens: u32` -- tokens produced

## 3. Worker loop (`worker.rs`)

The main loop. Runs until interrupted.

```rust
pub async fn run_worker(
    client: &BuzzClient,
    config: &SeatConfig,
    poll_interval: Duration,
) -> Result<(), CliError> {
    loop {
        // 1. Poll for open jobs belonging to this worker's pubkey
        let jobs = client.query_all(json!({
            "kinds": [KIND_JOB_HEAD],
            "#p": [my_pubkey],
        })).await?;
        let open: Vec<_> = jobs.iter()
            .filter(|j| tag_value(j, "status") == "open")
            .collect();
        
        // 2. Pick one; if none, sleep and loop
        let Some(job) = open.first() else {
            sleep(poll_interval).await;
            continue;
        };
        
        // 3. Pick the seat binding for this job's employee
        let employee = tag_value(job, "employee");
        let bindings = config.bindings_for(&employee);
        
        // 4. Claim the job
        client.submit_event(claim_job(&job_id)).await?;
        // Read the head to get the attempt number
        let head = await_head(&job_id, "leased").await;
        let attempt = attempt_of(&head);
        
        // 5. Spawn heartbeat timer
        let heartbeat = Heartbeat::start(client, &job_id, attempt);
        
        // 6. Try each binding in order
        let result = try_bindings(&bindings, &instruction, &heartbeat).await;
        
        // 7. Stop heartbeat, post result
        heartbeat.stop();
        match result {
            Ok(reply) => {
                client.submit_event(finish_job(&job_id, attempt, "done", &reply.response)).await?;
                // Post usage to the ledger
                publish_usage(client, &job, &reply).await?;
            }
            Err(e) => {
                client.submit_event(finish_job(&job_id, attempt, "failed", &e.to_string())).await?;
            }
        }
    }
}
```

Key design decisions:

- **One job at a time.** No concurrency. The worker is deliberately sequential: claim, execute, finish, loop. Two workers on two machines naturally run in parallel because they claim different jobs.
- **Heartbeat happens concurrently.** Tokio spawns a task that fires heartbeats on an interval, and the worker waits on the LLM call. The heartbeat stops when the LLM returns.
- **Fallback chain.** `try_bindings` iterates through the list until one succeeds. An error from a provider means the next one is tried. If none succeed, the job is reported as failed.
- **Terminal states on error.** If the claim loses (job already taken), the worker just loops to the next one. If the heartbeat loses, the worker abandons the job rather than racing.

## 4. CLI integration

Add to `JobsCmd`:

```rust
/// Run as a worker, claiming and executing jobs on this machine
Work {
    /// Only work jobs for this employee
    #[arg(long)]
    employee: Option<String>,
    /// Seconds between polling for new work
    #[arg(long, default_value = "5")]
    poll: u64,
    /// Path to seat config
    #[arg(long)]
    config: Option<String>,
},
```

The command:
1. Loads the seat config (from `--config` or `~/.config/buzz/seat.toml`)
2. Validates that at least one binding is configured
3. Starts the worker loop
4. Exits cleanly on SIGINT

## 5. The gate

**Same employee completes jobs for two founders on different bindings, with correct stamps and ledger attribution.**

Proved via E2E test against a live relay:

1. Hire an employee (phase 1)
2. File a job against it (phase 2)
3. Start worker A (openrouter/claude) and worker B (deepseek), each with their own identity
4. Both workers claim jobs for the same employee
5. Both post results
6. Assert each result carries:
   - The correct worker's pubkey
   - The provider and model that worker was configured with
   - The correct attempt number

Alternative E2E shape without API keys: file two jobs, the test itself does the claim/heartbeat/finish step by step using the CLI commands, and asserts that the provider stamp in the result differs between the two. An env var `LLM_RESPONSE` lets the test inject a canned reply so no real API key is needed.

## What stays deferred

- Handoff asks (exhausted seat sends ask to other seat) -- phase 5
- Credential pinning -- phase 5
- Hire-existing-agent flow -- phase 6
- Workspace briefs -- phase 4
- Concurrency within one machine -- intentionally absent, not deferred
