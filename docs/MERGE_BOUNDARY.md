# Merge Boundary

This repo is now the Codex/OpenAI runtime lane in a two-repo system.

Current directional split:

- `Andrea_NanoBot` is the architecture reference and eventual Telegram/operator shell
- `Andrea_OpenAI_Bot` is the Codex/OpenAI execution backend lane that `Andrea_NanoBot` can call

This pass does **not** merge the repos. It defines the clean boundary between them.

## What Andrea Owns

- provider-neutral runtime selection
- Podman-first container execution
- per-group thread continuity
- durable runtime orchestration jobs
- job-specific logs and honest runtime failures
- Codex auth seeding into per-group `.codex`
- the opt-in localhost HTTP transport adapter

## What Andrea_NanoBot Owns

- Telegram dashboard and button UX
- current selection / "current job" UI state
- reply-linked operator workflows
- operator guidance and navigation

## Contract To Preserve

- the orchestration request/response model in [ORCHESTRATION_CONTRACT.md](ORCHESTRATION_CONTRACT.md)
- the loopback HTTP routes:
  - `GET /meta`
  - `PUT /groups/:groupFolder`
  - `POST /jobs`
  - `POST /jobs/:jobId/followup`
  - `GET /jobs`
  - `GET /jobs/:jobId`
  - `GET /jobs/:jobId/logs`
  - `POST /jobs/:jobId/stop`
- runtime thread/job persistence shape
- route policy semantics:
  - `local_required`
  - `cloud_allowed`
  - `cloud_preferred`
- the truth that `codex_local` is primary and `openai_cloud` is conditional
- `jobId` as the primary backend handle
- `threadId` as returned continuity metadata only

## First-Run Bootstrap

`Andrea_NanoBot` remains the source of truth for chat and group context. When it sees a missing-group `404` for `POST /jobs`, it can now mirror its existing registered-group metadata into `Andrea_OpenAI_Bot` with:

- `PUT /groups/:groupFolder`

That route is intentionally local-only and narrow:

- it exists only to bootstrap the backend workspace for a known NanoBot group
- it is idempotent for equivalent metadata
- it returns a conflict instead of silently overwriting mismatched existing registrations
- it is not a general-purpose group admin API

## What Is Intentionally Deferred

- a transport beyond the local opt-in loopback HTTP boundary
- a shared dashboard/session state layer across repos
- artifact browsing
- a session-browser API separate from job records

## Temporary Standalone Conveniences

These still live here for local validation and development:

- standalone runtime validation script
- runtime-focused README/docs framing
- local bot packaging metadata
- real-world message corpus and optional Telegram sender under `scripts/`
