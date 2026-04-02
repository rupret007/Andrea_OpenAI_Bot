# Runtime

## Architecture

This repo uses a provider-neutral runtime model with two supported runtime lanes:

- `codex_local`
- `openai_cloud`

Routing policy:

- `local_required`
- `cloud_allowed`
- `cloud_preferred`

High-level flow:

```text
Telegram or other channel
  -> SQLite message/task state
  -> per-group queue
  -> runtime selection
  -> Podman container
  -> Andrea reply
```

## Orchestration Boundary

This repo now includes:

- an internal callable orchestration service
- an opt-in localhost-only HTTP wrapper around that same service

The backend surface is shaped for `Andrea_NanoBot`, which will eventually own the Telegram-first operator shell.

What it does now:

- accepts async `createJob` and `followUp` requests
- persists durable runtime job records in SQLite
- exposes `getJob`, `listJobs`, `getJobLogs`, and `stopJob`
- reuses real runtime threads when the selected runtime allows it
- exposes a local HTTP boundary with:
  - `GET /meta`
  - `POST /jobs`
  - `POST /jobs/:jobId/followup`
  - `GET /jobs`
  - `GET /jobs/:jobId`
  - `GET /jobs/:jobId/logs`
  - `POST /jobs/:jobId/stop`

What it still does not do:

- own dashboard or current-selection UI state
- expose a public internet-facing API
- add auth or broader infrastructure beyond local loopback transport

See [ORCHESTRATION_CONTRACT.md](ORCHESTRATION_CONTRACT.md) for the internal service model and the loopback HTTP mapping.

## Local Runtime

`codex_local` is the primary path.

What it does:

- runs inside a per-group Podman container
- mounts the group workspace and IPC namespace
- mounts a per-group `.codex` home
- seeds that `.codex` home from the host Codex auth files when available
- generates an `AGENTS.md` overlay while keeping `CLAUDE.md` as the current memory source

What was live-validated on March 30, 2026:

- container image build
- Podman smoke run
- real container launch through `runContainerAgent`
- host Codex auth seeding into the per-group `.codex` mount
- successful local Codex one-shot reply in a real containerized group workspace
- same-thread follow-up reuse with the same returned session id
- structured Codex runtime error propagation back to the host runner when validation is forced into failure cases

What is still blocked:

- a live Telegram-mediated operator walkthrough, because that was not exercised against a connected chat in this pass

## Cloud Fallback

`openai_cloud` is intentionally secondary.

What it does today:

- handles cloud-safe text work
- uses OpenAI Responses
- persists provider-neutral thread/job metadata

What it does not do yet:

- full local tool parity
- local filesystem edits
- local shell parity with `codex_local`

What was validated on March 30, 2026:

- the container reaches the `openai_cloud` lane
- missing credentials now produce an explicit structured error

What is still needed:

- configured `OPENAI_API_KEY` or compatible gateway token
- successful live cloud turn validation

## Persistence

Persisted state includes:

- runtime threads
- runtime orchestration jobs
- legacy sessions
- scheduled tasks
- task run logs
- registered groups

Legacy `sessions` rows are hydrated internally as `claude_legacy` thread records so old session state is not silently dropped. That compatibility is migration-focused only and is not a supported Andrea runtime lane.

## Operator Surface

Operator-only runtime commands are handled separately from normal assistant conversation:

- `/runtime-status`
- `/runtime-jobs`
- `/runtime-followup`
- `/runtime-stop`
- `/runtime-logs`

Those commands now sit on top of the callable orchestration/service boundary where appropriate, rather than owning the only follow-up and stop path themselves.

Legacy `/remote-control` commands are rejected with guidance toward the supported runtime commands.

## Loopback HTTP Mode

The HTTP boundary is disabled by default.

Enable it with:

```dotenv
ORCHESTRATION_HTTP_ENABLED=true
ORCHESTRATION_HTTP_HOST=127.0.0.1
ORCHESTRATION_HTTP_PORT=3210
```

Rules:

- host must stay loopback-only
- runtime/provider failures stay in job state, not HTTP status codes
- `jobId` is the primary backend handle
- `threadId` is continuity metadata returned on job reads

If HTTP is enabled and no chat channels connect, the process now stays up in loopback HTTP-only mode instead of exiting. That is intended for local backend consumption by `Andrea_NanoBot`, not for public deployment.

## `/runtime-artifacts`

Deferred in this pass.

Reason:

- there is no small, truthful artifact abstraction shared by both `codex_local` and `openai_cloud`
- current operator inspection uses logs and job/thread state
- exposing a command now would overpromise availability and semantics
