# Orchestration Contract

`Andrea_OpenAI_Bot` now exposes two aligned backend surfaces:

- an in-process orchestration service
- an opt-in localhost-only HTTP wrapper around that same service

This repo is the Codex/OpenAI execution lane that `Andrea_NanoBot` will later call. It owns execution truth, not the Telegram shell.

## Ownership Split

`Andrea_OpenAI_Bot` owns:

- runtime execution
- provider routing
- durable job lifecycle
- real thread reuse
- logs
- stop/cancel
- truthful runtime and provider errors

`Andrea_NanoBot` owns:

- Telegram UX
- reply-linked cards
- button flows
- current selected job state
- current selected workspace state
- dashboard state
- operator shell behavior

## Shared Concepts

- `jobId` is the primary opaque backend handle
- `threadId` is continuity metadata when a real reusable runtime thread exists
- selection state stays outside this repo
- runtime/provider failures are reflected in job state, not transport status

## Internal Service Surface

The orchestration service exposes:

- `createJob(request)`
- `followUp(request)`
- `getJob(jobId)`
- `listJobs(query)`
- `getJobLogs(query)`
- `stopJob(request)`

The model is async and job-centric:

- `createJob` and `followUp` return a durable job immediately
- callers poll `getJob`, `listJobs`, and `getJobLogs`
- `stopJob` marks `stopRequested` and reports whether a live stop signal was accepted

## Source Metadata

Caller metadata stays generic and transport-friendly:

```ts
type OrchestrationSource = {
  system: string;
  actorType?: string | null;
  actorId?: string | null;
  correlationId?: string | null;
};
```

The backend does not require Telegram-specific fields.

## Request Types

Create:

```ts
type CreateRuntimeJobRequest = {
  groupFolder: string;
  prompt: string;
  source: OrchestrationSource;
  routeHint?: RuntimeRoute;
  requestedRuntime?: AgentRuntimeName | null;
};
```

Follow-up:

```ts
type FollowUpRuntimeJobRequest = {
  prompt: string;
  source: OrchestrationSource;
  jobId?: string;
  threadId?: string;
  groupFolder?: string;
};
```

List / logs / stop:

```ts
type ListRuntimeJobsRequest = {
  groupFolder?: string;
  threadId?: string;
  limit?: number;
  beforeJobId?: string;
};

type GetRuntimeJobLogsRequest = {
  jobId: string;
  lines?: number;
};

type StopRuntimeJobRequest = {
  jobId: string;
  source?: OrchestrationSource;
};
```

## Job Model

Each durable orchestration job record includes:

```ts
type RuntimeOrchestrationJob = {
  jobId: string;
  kind: 'create' | 'follow_up';
  status: 'queued' | 'running' | 'succeeded' | 'failed';
  stopRequested: boolean;
  groupFolder: string;
  groupJid: string;
  parentJobId?: string | null;
  threadId?: string | null;
  runtimeRoute: RuntimeRoute;
  requestedRuntime?: AgentRuntimeName | null;
  selectedRuntime?: AgentRuntimeName | null;
  promptPreview: string;
  latestOutputText?: string | null;
  finalOutputText?: string | null;
  errorText?: string | null;
  logFile?: string | null;
  sourceSystem: string;
  actorType?: string | null;
  actorId?: string | null;
  correlationId?: string | null;
  createdAt: string;
  startedAt?: string | null;
  finishedAt?: string | null;
  updatedAt: string;
};
```

`listJobs` returns:

```ts
type RuntimeOrchestrationJobList = {
  jobs: RuntimeOrchestrationJob[];
  nextBeforeJobId?: string | null;
};
```

## HTTP Wrapper

The local HTTP boundary is intentionally narrow and loopback-only.

Routes:

- `GET /meta`
- `PUT /groups/:groupFolder`
- `POST /jobs`
- `POST /jobs/:jobId/followup`
- `GET /jobs/:jobId`
- `GET /jobs`
- `GET /jobs/:jobId/logs`
- `POST /jobs/:jobId/stop`

HTTP request shapes:

- `POST /jobs`
  - body: `{ groupFolder, prompt, source }`
- `PUT /groups/:groupFolder`
  - body: `{ jid, name, trigger, addedAt, requiresTrigger, isMain }`
- `POST /jobs/:jobId/followup`
  - body: `{ prompt, source }`
- `GET /jobs`
  - query: `groupFolder?`, `limit?`, `beforeJobId?`
- `GET /jobs/:jobId/logs`
  - query: `lines?`
- `POST /jobs/:jobId/stop`
  - body optional: `{ source? }`

All HTTP job payloads include:

```ts
{
  backend: 'andrea_openai',
  capabilities: {
    followUp: true,
    logs: true,
    stop: boolean
  }
}
```

`GET /meta` returns minimal local identity and readiness:

```ts
{
  backend: 'andrea_openai',
  transport: 'http',
  enabled: true,
  version: string | null,
  ready: boolean
}
```

`PUT /groups/:groupFolder` returns:

```ts
{
  group: {
    jid: string;
    name: string;
    folder: string;
    trigger: string;
    addedAt: string;
    requiresTrigger: boolean;
    isMain: boolean;
  }
  created: boolean;
}
```

This route is loopback-only and exists only to support `Andrea_NanoBot` first-run workspace bootstrap. It is not a broader admin CRUD API.

## Ordering And Pagination

`GET /jobs` uses stable newest-first ordering:

- `createdAt DESC, jobId DESC`
- most recent first
- `beforeJobId` means jobs older than that anchor in the same ordering
- `nextBeforeJobId` is the last returned job id when more results exist

Unknown `beforeJobId` returns `404` at the HTTP layer.

## Transport Error Semantics

HTTP status codes represent transport outcomes only:

- `400` invalid JSON, invalid params, or missing required fields
- `404` missing job, missing group target, or unknown `beforeJobId`
- `409` conflicting local group registration data
- `405` wrong method
- `500` handler/transport failure

Runtime/provider failures do not become transport failures. They remain visible in job state through:

- `status`
- `errorText`
- `selectedRuntime`
- `latestOutputText`
- `finalOutputText`

## Resolution And Reuse Rules

- `createJob` targets an Andrea `groupFolder`
- `followUp` resolution order is:
  - `jobId`
  - `threadId`
  - `groupFolder`
- invalid or conflicting follow-up targets are rejected
- `requestedRuntime` remains advisory only
- actual runtime selection still follows Andrea's current route/runtime logic
- `threadId` is populated when real execution knows it or reuses it truthfully

## Guarantees

- durable SQLite-backed job records
- honest `queued/running/succeeded/failed` lifecycle
- real thread reuse when the selected runtime allows it
- job-specific log retrieval when a log file exists
- immediate group availability after successful `PUT /groups/:groupFolder` without restart
- no reintroduction of Claude remote-control concepts
- a small local HTTP boundary for future `Andrea_NanoBot` integration

## Conditional Or Deferred

- `openai_cloud` still requires `OPENAI_API_KEY` or a compatible gateway token
- the HTTP boundary is local-only, opt-in, and unauthenticated in this pass
- group registration is intentionally narrow and mirrors `Andrea_NanoBot`'s existing group context truth; it is not a public group-management API
- there is still no public deployment surface, auth layer, or broader transport framework
- there is no separate session browser yet; callers use `jobId`, `threadId`, and `listJobs`
- `/runtime-artifacts` remains deferred
