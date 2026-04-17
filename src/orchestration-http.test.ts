import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  _closeDatabase,
  _initTestDatabase,
  createRuntimeOrchestrationJob,
  setRegisteredGroup,
} from './db.js';
import { ensureLoopbackRegisteredGroup } from './group-registration.js';
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
  RuntimeBackendStatusSnapshot,
} from './types.js';

const dispatchSurface = {
  metaRoute: '/meta',
  statusRoute: '/status',
  jobsCollectionRoute: '/jobs',
  jobItemRoute: '/jobs/:jobId',
  jobFollowUpRoute: '/jobs/:jobId/followup',
  jobLogsRoute: '/jobs/:jobId/logs',
  jobStopRoute: '/jobs/:jobId/stop',
  followUpsCollectionRoute: '/followups',
  groupsCollectionRoute: '/groups/:groupFolder',
} as const;

interface TestHarness {
  baseUrl: string;
  server: OrchestrationHttpServerHandle;
  service: ReturnType<typeof createRuntimeOrchestrationService>;
  tempDir: string;
  queuedTasks: Map<string, () => Promise<void>>;
  runContainerAgent: ReturnType<typeof vi.fn>;
  requestStop: ReturnType<typeof vi.fn>;
  ensureOneClIAgent: ReturnType<typeof vi.fn>;
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
  registeredGroupsByJid: Record<string, RegisteredGroup>;
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
  meta: {
    ready?: boolean;
    version?: string | null;
    localExecutionState?:
      | 'available_authenticated'
      | 'available_auth_required'
      | 'not_ready'
      | 'unavailable';
    authState?: 'authenticated' | 'auth_required' | 'unknown';
    localExecutionDetail?: string | null;
    operatorGuidance?: string | null;
  } = {},
  options: {
    initialGroups?: Record<string, RegisteredGroup>;
  } = {},
): Promise<TestHarness> {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'andrea-http-test-'));
  const groupsDir = path.join(tempDir, 'groups');
  fs.mkdirSync(path.join(groupsDir, 'main'), { recursive: true });
  fs.mkdirSync(path.join(groupsDir, 'global'), { recursive: true });
  fs.writeFileSync(
    path.join(groupsDir, 'main', 'CLAUDE.md'),
    '# Andrea\n\nYou are Andrea.\n',
  );
  fs.writeFileSync(
    path.join(groupsDir, 'global', 'CLAUDE.md'),
    '# Andrea\n\nYou are Andrea.\n',
  );

  const queuedTasks = new Map<string, () => Promise<void>>();
  const runtimeJobs: TestHarness['runtimeJobs'] = [];
  const sessions: Record<string, string | undefined> = {};
  const storedThreads: Record<string, AgentThreadState | undefined> = {};
  const registeredGroupsByJid: Record<string, RegisteredGroup> = {
    'tg:main': mainGroup,
    'tg:other': otherGroup,
    ...(options.initialGroups || {}),
  };

  const runContainerAgent = vi.fn(async () => ({
    status: 'success' as const,
    result: 'ok',
    newSessionId: 'thread-default',
    runtime: 'codex_local' as const,
  }));
  const requestStop = vi.fn(() => true);
  const ensureOneClIAgent = vi.fn();

  const deps: RuntimeOrchestrationServiceDependencies = {
    assistantName: 'Andrea',
    enqueueJob(_groupJid, jobId, fn) {
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
    closeStdin() {},
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
      const match = Object.entries(registeredGroupsByJid).find(
        ([, group]) => group.folder === folder,
      );
      if (match) {
        return { jid: match[0], group: match[1] };
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
        localExecutionState:
          meta.localExecutionState ?? 'available_authenticated',
        authState: meta.authState ?? 'authenticated',
        localExecutionDetail:
          meta.localExecutionDetail ??
          'Codex local execution is authenticated and the container runtime is ready.',
        operatorGuidance: meta.operatorGuidance ?? null,
      };
    },
    getStatus(): RuntimeBackendStatusSnapshot {
      const base = {
        backend: 'andrea_openai' as const,
        transport: 'http' as const,
        enabled: true as const,
        version: meta.version ?? '1.2.42',
        ready: meta.ready ?? true,
        localExecutionState:
          meta.localExecutionState ?? 'available_authenticated',
        authState: meta.authState ?? 'authenticated',
        localExecutionDetail:
          meta.localExecutionDetail ??
          'Codex local execution is authenticated and the container runtime is ready.',
        operatorGuidance: meta.operatorGuidance ?? null,
      };
      return {
        ...base,
        dispatchSurface,
        runtime: {
          defaultRuntime: 'codex_local',
          fallbackRuntime: 'openai_cloud',
          codexLocalEnabled: true,
          codexLocalModel: 'gpt-5.4-mini',
          codexLocalReady: base.ready,
          hostCodexAuthPresent: base.authState === 'authenticated',
          openAiModelFallback: 'gpt-5.4',
          openAiApiKeyPresent: base.ready,
          openAiCloudReady: base.ready,
          openAiBaseUrl: null,
          activeThreadCount: 1,
          activeJobCount: 2,
          containerRuntimeName: 'podman',
          containerRuntimeStatus: 'running',
        },
      };
    },
    async routePrompt(request) {
      return {
        routeKind: 'unsupported',
        capabilityId: null,
        canonicalText: request.text,
        arguments: null,
        confidence: 'low',
        clarificationPrompt: null,
        reason: 'test stub',
      };
    },
    registerGroup(request) {
      return ensureLoopbackRegisteredGroup(request, {
        assistantName: 'Andrea',
        groupsDir,
        registeredGroups: registeredGroupsByJid,
        persistGroup(jid, group) {
          registeredGroupsByJid[jid] = group;
          setRegisteredGroup(jid, group);
        },
        ensureOneClIAgent,
      });
    },
  });

  return {
    baseUrl: `http://${server.host}:${server.port}`,
    server,
    service,
    tempDir,
    queuedTasks,
    runContainerAgent,
    requestStop,
    ensureOneClIAgent,
    runtimeJobs,
    registeredGroupsByJid,
  };
}

describe('orchestration http server', () => {
  let harness: TestHarness | null = null;

  beforeEach(() => {
    _initTestDatabase();
  });

  afterEach(async () => {
    await harness?.server.close();
    if (harness?.tempDir) {
      fs.rmSync(harness.tempDir, { recursive: true, force: true });
    }
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
      localExecutionState: string;
      authState: string;
      localExecutionDetail: string | null;
      operatorGuidance: string | null;
    };

    expect(response.status).toBe(200);
    expect(body).toEqual({
      backend: 'andrea_openai',
      transport: 'http',
      enabled: true,
      version: '1.2.42',
      ready: true,
      localExecutionState: 'available_authenticated',
      authState: 'authenticated',
      localExecutionDetail:
        'Codex local execution is authenticated and the container runtime is ready.',
      operatorGuidance: null,
    });
  });

  it('returns a platform-ready status snapshot from /status', async () => {
    harness = await buildHarness({}, { ready: true, version: '1.2.42' });

    const response = await fetch(`${harness.baseUrl}/status`);
    const body = (await response.json()) as RuntimeBackendStatusSnapshot;

    expect(response.status).toBe(200);
    expect(body.backend).toBe('andrea_openai');
    expect(body.dispatchSurface).toEqual(dispatchSurface);
    expect(body.runtime).toMatchObject({
      defaultRuntime: 'codex_local',
      fallbackRuntime: 'openai_cloud',
      activeJobCount: 2,
      activeThreadCount: 1,
      containerRuntimeStatus: 'running',
    });
  });

  it('accepts structured prompt routing through POST /route', async () => {
    harness = await buildHarness();

    const response = await fetch(`${harness.baseUrl}/route`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        channel: 'telegram',
        text: 'summerize my text messages in Pops of Punk last 2 days',
        requestRoute: 'direct_assistant',
        conversationSummary: 'Recent BlueBubbles summaries are available.',
      }),
    });
    const body = (await response.json()) as {
      routeKind: string;
      capabilityId: string | null;
      canonicalText: string;
      arguments: Record<string, unknown> | null;
      confidence: string;
      clarificationPrompt: string | null;
      reason: string | null;
    };

    expect(response.status).toBe(200);
    expect(body).toEqual({
      routeKind: 'unsupported',
      capabilityId: null,
      canonicalText: 'summerize my text messages in Pops of Punk last 2 days',
      arguments: null,
      confidence: 'low',
      clarificationPrompt: null,
      reason: 'test stub',
    });
  });

  it('accepts generic follow-up targets through POST /followups', async () => {
    harness = await buildHarness({
      getStoredThread() {
        return {
          group_folder: 'main',
          runtime: 'codex_local',
          thread_id: 'thread-existing',
          last_response_id: 'thread-existing',
          updated_at: '2026-04-02T00:00:00.000Z',
        };
      },
    });

    const followResponse = await fetch(`${harness.baseUrl}/followups`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        groupFolder: 'main',
        prompt: 'Add one more line.',
        source: { system: 'nanobot' },
      }),
    });
    const followed = (await followResponse.json()) as {
      job: RuntimeBackendJob;
    };

    expect(followResponse.status).toBe(202);
    expect(followed.job.kind).toBe('follow_up');
    expect(followed.job.groupFolder).toBe('main');
  });

  it('creates jobs successfully through POST /jobs', async () => {
    harness = await buildHarness();

    const response = await fetch(`${harness.baseUrl}/jobs`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        groupFolder: 'main',
        prompt: 'Please summarize the latest state.',
        requestedRuntime: 'openai_cloud',
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
    expect(body.job.requestedRuntime).toBe('openai_cloud');
  });

  it('registers a new group through PUT /groups/:groupFolder', async () => {
    harness = await buildHarness();

    const response = await fetch(
      `${harness.baseUrl}/groups/bootstrap-proof-a`,
      {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          jid: 'tg:bootstrap-a',
          name: 'Bootstrap Proof A',
          trigger: '@Andrea',
          addedAt: '2026-04-02T00:00:00.000Z',
          requiresTrigger: true,
          isMain: false,
        }),
      },
    );
    const body = (await response.json()) as {
      created: boolean;
      group: {
        jid: string;
        name: string;
        folder: string;
        trigger: string;
        addedAt: string;
        requiresTrigger: boolean;
        isMain: boolean;
      };
    };

    expect(response.status).toBe(201);
    expect(body).toEqual({
      created: true,
      group: {
        jid: 'tg:bootstrap-a',
        name: 'Bootstrap Proof A',
        folder: 'bootstrap-proof-a',
        trigger: '@Andrea',
        addedAt: '2026-04-02T00:00:00.000Z',
        requiresTrigger: true,
        isMain: false,
      },
    });
    expect(harness.registeredGroupsByJid['tg:bootstrap-a']).toMatchObject({
      folder: 'bootstrap-proof-a',
      name: 'Bootstrap Proof A',
    });
    expect(harness.ensureOneClIAgent).toHaveBeenCalledWith(
      'tg:bootstrap-a',
      expect.objectContaining({
        folder: 'bootstrap-proof-a',
      }),
    );
  });

  it('treats identical group registration as idempotent success', async () => {
    harness = await buildHarness();

    const firstResponse = await fetch(
      `${harness.baseUrl}/groups/bootstrap-proof-b`,
      {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          jid: 'tg:bootstrap-b',
          name: 'Bootstrap Proof B',
          trigger: '@Andrea',
          addedAt: '2026-04-02T00:00:00.000Z',
          requiresTrigger: false,
          isMain: false,
        }),
      },
    );
    expect(firstResponse.status).toBe(201);

    const secondResponse = await fetch(
      `${harness.baseUrl}/groups/bootstrap-proof-b`,
      {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          jid: 'tg:bootstrap-b',
          name: 'Bootstrap Proof B',
          trigger: '@Andrea',
          addedAt: '2026-04-03T00:00:00.000Z',
          requiresTrigger: false,
          isMain: false,
        }),
      },
    );
    const secondBody = (await secondResponse.json()) as {
      created: boolean;
      group: { addedAt: string };
    };

    expect(secondResponse.status).toBe(200);
    expect(secondBody.created).toBe(false);
    expect(secondBody.group.addedAt).toBe('2026-04-02T00:00:00.000Z');
  });

  it('returns 409 when folder metadata conflicts with an existing group', async () => {
    harness = await buildHarness();

    const response = await fetch(`${harness.baseUrl}/groups/main`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        jid: 'tg:main',
        name: 'Different Main',
        trigger: '@Andrea',
        addedAt: '2026-04-02T00:00:00.000Z',
        requiresTrigger: true,
        isMain: true,
      }),
    });
    const body = (await response.json()) as {
      error: { code: string; message: string };
    };

    expect(response.status).toBe(409);
    expect(body.error.code).toBe('conflict');
    expect(body.error.message).toContain('different metadata');
  });

  it('returns 409 when a jid is already mapped to another folder', async () => {
    harness = await buildHarness();

    const response = await fetch(`${harness.baseUrl}/groups/main-duplicate`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        jid: 'tg:main',
        name: 'Main Duplicate',
        trigger: '@Andrea',
        addedAt: '2026-04-02T00:00:00.000Z',
        requiresTrigger: true,
        isMain: false,
      }),
    });
    const body = (await response.json()) as {
      error: { code: string; message: string };
    };

    expect(response.status).toBe(409);
    expect(body.error.code).toBe('conflict');
    expect(body.error.message).toContain('already mapped to folder');
  });

  it('returns 400 for invalid group registration bodies', async () => {
    harness = await buildHarness();

    const response = await fetch(
      `${harness.baseUrl}/groups/bootstrap-proof-c`,
      {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          jid: 'tg:bootstrap-c',
          name: 'Bootstrap Proof C',
          trigger: '@Andrea',
          addedAt: '2026-04-02T00:00:00.000Z',
          requiresTrigger: 'true',
          isMain: false,
          containerConfig: {},
        }),
      },
    );
    const body = (await response.json()) as {
      error: { code: string; message: string };
    };

    expect(response.status).toBe(400);
    expect(body.error.code).toBe('validation_error');
    expect(body.error.message).toContain('Unexpected field');
  });

  it('returns 405 for unsupported methods on /groups/:groupFolder', async () => {
    harness = await buildHarness();

    const response = await fetch(`${harness.baseUrl}/groups/bootstrap-proof-d`);
    const body = (await response.json()) as {
      error: { code: string };
    };

    expect(response.status).toBe(405);
    expect(body.error.code).toBe('method_not_allowed');
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

  it('supports missing-group then register then create-job without restart', async () => {
    harness = await buildHarness({}, {}, { initialGroups: {} });
    const logFile = path.join(harness.tempDir, 'bootstrap-proof.log');
    fs.writeFileSync(logFile, 'bootstrap log line 1\nbootstrap log line 2\n');
    harness.runContainerAgent.mockImplementation(async () => ({
      status: 'success' as const,
      result: 'bootstrapped ok',
      newSessionId: 'thread-bootstrap',
      runtime: 'codex_local' as const,
      logFile,
    }));

    const createBeforeRegister = await fetch(`${harness.baseUrl}/jobs`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        groupFolder: 'bootstrap-proof-live',
        prompt: 'Write a bootstrap proof.',
        source: { system: 'nanobot' },
      }),
    });
    expect(createBeforeRegister.status).toBe(404);

    const registerResponse = await fetch(
      `${harness.baseUrl}/groups/bootstrap-proof-live`,
      {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          jid: 'tg:bootstrap-live',
          name: 'Bootstrap Live',
          trigger: '@Andrea',
          addedAt: '2026-04-02T00:00:00.000Z',
          requiresTrigger: true,
          isMain: false,
        }),
      },
    );
    expect(registerResponse.status).toBe(201);

    const createAfterRegister = await fetch(`${harness.baseUrl}/jobs`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        groupFolder: 'bootstrap-proof-live',
        prompt: 'Write a bootstrap proof.',
        source: { system: 'nanobot', actorType: 'operator' },
      }),
    });
    const created = (await createAfterRegister.json()) as {
      job: RuntimeBackendJob;
    };
    expect(createAfterRegister.status).toBe(202);

    await harness.queuedTasks.get(created.job.jobId)!();

    const getCreated = await fetch(
      `${harness.baseUrl}/jobs/${encodeURIComponent(created.job.jobId)}`,
    );
    const createdJob = (await getCreated.json()) as { job: RuntimeBackendJob };
    expect(getCreated.status).toBe(200);
    expect(createdJob.job.status).toBe('succeeded');
    expect(createdJob.job.threadId).toBe('thread-bootstrap');

    const followResponse = await fetch(
      `${harness.baseUrl}/jobs/${encodeURIComponent(created.job.jobId)}/followup`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          prompt: 'Please continue.',
          source: { system: 'nanobot' },
        }),
      },
    );
    const followed = (await followResponse.json()) as {
      job: RuntimeBackendJob;
    };
    expect(followResponse.status).toBe(202);
    expect(followed.job.parentJobId).toBe(created.job.jobId);

    const logsResponse = await fetch(
      `${harness.baseUrl}/jobs/${encodeURIComponent(created.job.jobId)}/logs`,
    );
    const logsBody = (await logsResponse.json()) as {
      jobId: string;
      logText: string | null;
      logFile: string | null;
      lines: number;
    };
    expect(logsResponse.status).toBe(200);
    expect(logsBody.jobId).toBe(created.job.jobId);
    expect(logsBody.logFile).toBe(logFile);
    expect(logsBody.logText).toContain('bootstrap log line 2');

    const stopResponse = await fetch(
      `${harness.baseUrl}/jobs/${encodeURIComponent(followed.job.jobId)}/stop`,
      {
        method: 'POST',
      },
    );
    const stopped = (await stopResponse.json()) as {
      job: RuntimeBackendJob;
      liveStopAccepted: boolean;
    };
    expect(stopResponse.status).toBe(200);
    expect(stopped.job.stopRequested).toBe(true);
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
