import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  _closeDatabase,
  _initTestDatabase,
  createRuntimeOrchestrationJob,
} from './db.js';
import {
  startOrchestrationHttpServer,
  type OrchestrationHttpServerHandle,
} from './orchestration-http.js';
import {
  createRuntimeOrchestrationService,
  type RuntimeOrchestrationServiceDependencies,
} from './runtime-orchestration.js';
import type {
  AgentThreadState,
  RegisteredGroup,
  RuntimeBackendJob,
  RuntimeOrchestrationJob,
} from './types.js';

interface TestHarness {
  baseUrl: string;
  server: OrchestrationHttpServerHandle;
  service: ReturnType<typeof createRuntimeOrchestrationService>;
  queuedTasks: Map<string, () => Promise<void>>;
  runContainerAgent: ReturnType<typeof vi.fn>;
  requestStop: ReturnType<typeof vi.fn>;
  runtimeJobs: Array<{
    groupJid: string;
    active: boolean;
    idleWaiting: boolean;
    isTaskContainer: boolean;
    runningTaskId: string | null;
    pendingMessages: boolean;
    pendingTaskCount: number;
    containerName: string | null;
    groupFolder: string | null;
    retryCount: number;
  }>;
}

const mainGroup: RegisteredGroup = {
  name: 'Main',
  folder: 'main',
  trigger: '@Andrea',
  added_at: '2026-04-02T00:00:00.000Z',
  isMain: true,
};

const otherGroup: RegisteredGroup = {
  name: 'Other',
  folder: 'other',
  trigger: '@Andrea',
  added_at: '2026-04-02T00:00:00.000Z',
};

async function buildHarness(
  overrides: Partial<RuntimeOrchestrationServiceDependencies> = {},
  meta: { ready?: boolean; version?: string | null } = {},
): Promise<TestHarness> {
  const queuedTasks = new Map<string, () => Promise<void>>();
  const runtimeJobs: TestHarness['runtimeJobs'] = [];
  const sessions: Record<string, string | undefined> = {};
  const storedThreads: Record<string, AgentThreadState | undefined> = {};

  const runContainerAgent = vi.fn(async () => ({
    status: 'success' as const,
    result: 'ok',
    newSessionId: 'thread-default',
    runtime: 'codex_local' as const,
  }));
  const requestStop = vi.fn(() => true);

  const deps: RuntimeOrchestrationServiceDependencies = {
    assistantName: 'Andrea',
    enqueueJob(groupJid, jobId, fn) {
      queuedTasks.set(jobId, fn);
    },
    getAvailableGroups() {
      return [];
    },
    getRegisteredGroupJids() {
      return new Set(['tg:main', 'tg:other']);
    },
    getRuntimeJobs() {
      return runtimeJobs;
    },
    getSession(groupFolder) {
      return sessions[groupFolder];
    },
    getStoredThread(groupFolder) {
      return storedThreads[groupFolder];
    },
    notifyIdle() {},
    persistAgentThread(groupFolder, threadId, runtime) {
      sessions[groupFolder] = threadId;
      storedThreads[groupFolder] = {
        group_folder: groupFolder,
        runtime,
        thread_id: threadId,
        last_response_id: threadId,
        updated_at: '2026-04-02T00:00:00.000Z',
      };
    },
    refreshTaskSnapshots() {},
    registerProcess() {},
    requestStop,
    resolveGroupByFolder(folder) {
      if (folder === mainGroup.folder) {
        return { jid: 'tg:main', group: mainGroup };
      }
      if (folder === otherGroup.folder) {
        return { jid: 'tg:other', group: otherGroup };
      }
      return null;
    },
    runContainerAgent,
    writeGroupsSnapshot() {},
    ...overrides,
  };

  const service = createRuntimeOrchestrationService(deps);
  const server = await startOrchestrationHttpServer({
    host: '127.0.0.1',
    port: 0,
    service,
    getMeta() {
      return {
        backend: 'andrea_openai',
        transport: 'http',
        enabled: true,
        version: meta.version ?? '1.2.42',
        ready: meta.ready ?? true,
      };
    },
  });

  return {
    baseUrl: `http://${server.host}:${server.port}`,
    server,
    service,
    queuedTasks,
    runContainerAgent,
    requestStop,
    runtimeJobs,
  };
}

describe('orchestration http server', () => {
  let harness: TestHarness | null = null;

  beforeEach(() => {
    _initTestDatabase();
  });

  afterEach(async () => {
    await harness?.server.close();
    harness = null;
    _closeDatabase();
  });

  it('returns backend identity and readiness from /meta', async () => {
    harness = await buildHarness({}, { ready: true, version: '1.2.42' });

    const response = await fetch(`${harness.baseUrl}/meta`);
    const body = (await response.json()) as {
      backend: string;
      transport: string;
      enabled: boolean;
      version: string | null;
      ready: boolean;
    };

    expect(response.status).toBe(200);
    expect(body).toEqual({
      backend: 'andrea_openai',
      transport: 'http',
      enabled: true,
      version: '1.2.42',
      ready: true,
    });
  });

  it('creates jobs successfully through POST /jobs', async () => {
    harness = await buildHarness();

    const response = await fetch(`${harness.baseUrl}/jobs`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        groupFolder: 'main',
        prompt: 'Please summarize the latest state.',
        source: {
          system: 'nanobot',
          actorType: 'operator',
          actorId: 'user-1',
        },
      }),
    });
    const body = (await response.json()) as { job: RuntimeBackendJob };

    expect(response.status).toBe(202);
    expect(body.job.backend).toBe('andrea_openai');
    expect(body.job.capabilities).toEqual({
      followUp: true,
      logs: true,
      stop: true,
    });
    expect(body.job.sourceSystem).toBe('nanobot');
    expect(body.job.actorType).toBe('operator');
    expect(body.job.actorId).toBe('user-1');
  });

  it('returns 404 when POST /jobs targets an unknown group', async () => {
    harness = await buildHarness();

    const response = await fetch(`${harness.baseUrl}/jobs`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        groupFolder: 'missing',
        prompt: 'Please summarize the latest state.',
        source: {
          system: 'nanobot',
          actorType: 'operator',
          actorId: 'user-1',
        },
      }),
    });
    const body = (await response.json()) as {
      error: { code: string; message: string };
    };

    expect(response.status).toBe(404);
    expect(body.error.code).toBe('not_found');
    expect(body.error.message).toContain('missing');
  });

  it('accepts follow-up for an existing job', async () => {
    harness = await buildHarness();

    const createResponse = await fetch(`${harness.baseUrl}/jobs`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        groupFolder: 'main',
        prompt: 'Create a plan.',
        source: { system: 'nanobot' },
      }),
    });
    const created = (await createResponse.json()) as {
      job: RuntimeBackendJob;
    };

    const followResponse = await fetch(
      `${harness.baseUrl}/jobs/${encodeURIComponent(created.job.jobId)}/followup`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          prompt: 'Please continue.',
          source: { system: 'nanobot', actorType: 'operator' },
        }),
      },
    );
    const followed = (await followResponse.json()) as {
      job: RuntimeBackendJob;
    };

    expect(followResponse.status).toBe(202);
    expect(followed.job.parentJobId).toBe(created.job.jobId);
  });

  it('returns 404 when follow-up references a missing job', async () => {
    harness = await buildHarness();

    const response = await fetch(`${harness.baseUrl}/jobs/missing/followup`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        prompt: 'Continue',
        source: { system: 'nanobot' },
      }),
    });
    const body = (await response.json()) as {
      error: { code: string; message: string };
    };

    expect(response.status).toBe(404);
    expect(body.error.code).toBe('not_found');
  });

  it('returns 200 for GET /jobs/:jobId and 404 for missing jobs', async () => {
    harness = await buildHarness();

    const createResponse = await fetch(`${harness.baseUrl}/jobs`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        groupFolder: 'main',
        prompt: 'Create a plan.',
        source: { system: 'nanobot' },
      }),
    });
    const created = (await createResponse.json()) as {
      job: RuntimeBackendJob;
    };

    const okResponse = await fetch(
      `${harness.baseUrl}/jobs/${encodeURIComponent(created.job.jobId)}`,
    );
    const okBody = (await okResponse.json()) as { job: RuntimeBackendJob };
    expect(okResponse.status).toBe(200);
    expect(okBody.job.jobId).toBe(created.job.jobId);

    const missingResponse = await fetch(`${harness.baseUrl}/jobs/missing`);
    const missingBody = (await missingResponse.json()) as {
      error: { code: string };
    };
    expect(missingResponse.status).toBe(404);
    expect(missingBody.error.code).toBe('not_found');
  });

  it('lists jobs in stable newest-first order and paginates with beforeJobId', async () => {
    harness = await buildHarness();

    createRuntimeOrchestrationJob({
      jobId: 'job-1',
      kind: 'create',
      status: 'succeeded',
      stopRequested: false,
      groupFolder: 'main',
      groupJid: 'tg:main',
      parentJobId: null,
      threadId: 'thread-a',
      runtimeRoute: 'local_required',
      requestedRuntime: null,
      selectedRuntime: 'codex_local',
      promptPreview: 'first',
      latestOutputText: 'first',
      finalOutputText: 'first',
      errorText: null,
      logFile: null,
      sourceSystem: 'nanobot',
      actorType: null,
      actorId: null,
      correlationId: null,
      createdAt: '2026-04-02T00:00:01.000Z',
      startedAt: '2026-04-02T00:00:01.000Z',
      finishedAt: '2026-04-02T00:00:02.000Z',
      updatedAt: '2026-04-02T00:00:02.000Z',
    });
    createRuntimeOrchestrationJob({
      jobId: 'job-2',
      kind: 'create',
      status: 'succeeded',
      stopRequested: false,
      groupFolder: 'other',
      groupJid: 'tg:other',
      parentJobId: null,
      threadId: 'thread-b',
      runtimeRoute: 'local_required',
      requestedRuntime: null,
      selectedRuntime: 'codex_local',
      promptPreview: 'second',
      latestOutputText: 'second',
      finalOutputText: 'second',
      errorText: null,
      logFile: null,
      sourceSystem: 'nanobot',
      actorType: null,
      actorId: null,
      correlationId: null,
      createdAt: '2026-04-02T00:00:02.000Z',
      startedAt: '2026-04-02T00:00:02.000Z',
      finishedAt: '2026-04-02T00:00:03.000Z',
      updatedAt: '2026-04-02T00:00:03.000Z',
    });
    createRuntimeOrchestrationJob({
      jobId: 'job-3',
      kind: 'follow_up',
      status: 'running',
      stopRequested: false,
      groupFolder: 'main',
      groupJid: 'tg:main',
      parentJobId: 'job-1',
      threadId: 'thread-a',
      runtimeRoute: 'local_required',
      requestedRuntime: null,
      selectedRuntime: 'codex_local',
      promptPreview: 'third',
      latestOutputText: 'third',
      finalOutputText: null,
      errorText: null,
      logFile: null,
      sourceSystem: 'nanobot',
      actorType: null,
      actorId: null,
      correlationId: null,
      createdAt: '2026-04-02T00:00:03.000Z',
      startedAt: '2026-04-02T00:00:03.000Z',
      finishedAt: null,
      updatedAt: '2026-04-02T00:00:03.000Z',
    });

    const response = await fetch(`${harness.baseUrl}/jobs?limit=2`);
    const body = (await response.json()) as {
      jobs: RuntimeBackendJob[];
      nextBeforeJobId: string | null;
    };

    expect(response.status).toBe(200);
    expect(body.jobs.map((job) => job.jobId)).toEqual(['job-3', 'job-2']);
    expect(body.nextBeforeJobId).toBe('job-2');

    const nextResponse = await fetch(
      `${harness.baseUrl}/jobs?limit=2&beforeJobId=${encodeURIComponent(body.nextBeforeJobId || '')}`,
    );
    const nextBody = (await nextResponse.json()) as {
      jobs: RuntimeBackendJob[];
      nextBeforeJobId: string | null;
    };
    expect(nextBody.jobs.map((job) => job.jobId)).toEqual(['job-1']);
    expect(nextBody.nextBeforeJobId).toBeNull();

    const missingAnchor = await fetch(
      `${harness.baseUrl}/jobs?beforeJobId=missing`,
    );
    expect(missingAnchor.status).toBe(404);
  });

  it('returns job logs or a truthful empty result', async () => {
    harness = await buildHarness();

    createRuntimeOrchestrationJob({
      jobId: 'job-logless',
      kind: 'create',
      status: 'succeeded',
      stopRequested: false,
      groupFolder: 'main',
      groupJid: 'tg:main',
      parentJobId: null,
      threadId: null,
      runtimeRoute: 'local_required',
      requestedRuntime: null,
      selectedRuntime: 'codex_local',
      promptPreview: 'no logs',
      latestOutputText: null,
      finalOutputText: null,
      errorText: null,
      logFile: null,
      sourceSystem: 'nanobot',
      actorType: null,
      actorId: null,
      correlationId: null,
      createdAt: '2026-04-02T00:00:01.000Z',
      startedAt: null,
      finishedAt: null,
      updatedAt: '2026-04-02T00:00:01.000Z',
    });

    const response = await fetch(`${harness.baseUrl}/jobs/job-logless/logs`);
    const body = (await response.json()) as {
      jobId: string;
      logFile: string | null;
      logText: string | null;
      lines: number;
    };

    expect(response.status).toBe(200);
    expect(body).toEqual({
      jobId: 'job-logless',
      logFile: null,
      logText: null,
      lines: 40,
    });
  });

  it('stops queued jobs successfully', async () => {
    harness = await buildHarness();

    const createResponse = await fetch(`${harness.baseUrl}/jobs`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        groupFolder: 'main',
        prompt: 'Please summarize the latest state.',
        source: { system: 'nanobot' },
      }),
    });
    const created = (await createResponse.json()) as {
      job: RuntimeBackendJob;
    };

    const stopResponse = await fetch(
      `${harness.baseUrl}/jobs/${encodeURIComponent(created.job.jobId)}/stop`,
      {
        method: 'POST',
      },
    );
    const stopped = (await stopResponse.json()) as {
      job: RuntimeBackendJob;
      liveStopAccepted: boolean;
    };

    expect(stopResponse.status).toBe(200);
    expect(stopped.liveStopAccepted).toBe(false);
    expect(stopped.job.stopRequested).toBe(true);
    expect(stopped.job.status).toBe('failed');
  });

  it('returns 400 for validation failures and 405 for wrong methods', async () => {
    harness = await buildHarness();

    const invalidResponse = await fetch(`${harness.baseUrl}/jobs`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        groupFolder: 'main',
        prompt: '',
        source: { system: '' },
      }),
    });
    const invalidBody = (await invalidResponse.json()) as {
      error: { code: string };
    };
    expect(invalidResponse.status).toBe(400);
    expect(invalidBody.error.code).toBe('validation_error');

    const wrongMethod = await fetch(`${harness.baseUrl}/jobs/main/stop`);
    const wrongMethodBody = (await wrongMethod.json()) as {
      error: { code: string };
    };
    expect(wrongMethod.status).toBe(405);
    expect(wrongMethodBody.error.code).toBe('method_not_allowed');
  });

  it('keeps runtime failures in job state rather than transport status', async () => {
    harness = await buildHarness({
      runContainerAgent: vi.fn(async () => ({
        status: 'error' as const,
        result: null,
        runtime: 'openai_cloud' as const,
        error:
          'openai_cloud requires OPENAI_API_KEY or a compatible gateway token.',
        logFile: 'C:\\logs\\runtime-provider-error.log',
      })),
    });

    const createResponse = await fetch(`${harness.baseUrl}/jobs`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        groupFolder: 'main',
        prompt: 'Please run the cloud lane.',
        source: { system: 'nanobot', actorType: 'operator' },
      }),
    });
    const created = (await createResponse.json()) as {
      job: RuntimeBackendJob;
    };

    expect(createResponse.status).toBe(202);
    await harness.queuedTasks.get(created.job.jobId)!();

    const getResponse = await fetch(
      `${harness.baseUrl}/jobs/${encodeURIComponent(created.job.jobId)}`,
    );
    const failed = (await getResponse.json()) as { job: RuntimeBackendJob };

    expect(getResponse.status).toBe(200);
    expect(failed.job.status).toBe('failed');
    expect(failed.job.errorText).toContain('OPENAI_API_KEY');
    expect(failed.job.selectedRuntime).toBe('openai_cloud');
  });
});
