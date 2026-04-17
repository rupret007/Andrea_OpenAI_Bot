import { afterEach, describe, expect, it, vi } from 'vitest';

import type { RuntimeOrchestrationJob } from './types.js';

describe('platform runtime bridge', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
    vi.resetModules();
  });

  it('posts runtime health and job state when the bridge is enabled', async () => {
    vi.stubEnv('ANDREA_PLATFORM_RUNTIME_GATEWAY_URL', 'http://127.0.0.1:4402/');

    const calls: Array<{ url: string; body: unknown }> = [];
    const fetchImpl = vi.fn(
      async (input: string | URL | Request, init?: RequestInit) => {
        calls.push({
          url: String(input),
          body: init?.body,
        });
        return new Response(null, { status: 202 });
      },
    );
    vi.stubGlobal('fetch', fetchImpl as unknown as typeof fetch);

    const bridge = await import('./platform-bridge.js');

    expect(bridge.isAndreaPlatformRuntimeBridgeEnabled()).toBe(true);

    const job: RuntimeOrchestrationJob = {
      jobId: 'job-1',
      kind: 'create',
      status: 'running',
      stopRequested: false,
      groupFolder: 'main',
      groupJid: 'group-jid',
      threadId: 'thread-1',
      runtimeRoute: 'cloud_allowed',
      requestedRuntime: 'openai_cloud',
      selectedRuntime: 'openai_cloud',
      promptPreview: 'Summarize the overnight runtime state.',
      latestOutputText: null,
      finalOutputText: null,
      errorText: null,
      logFile: null,
      sourceSystem: 'andrea',
      actorType: 'user',
      actorId: 'user-1',
      correlationId: 'corr-1',
      createdAt: '2026-04-17T00:00:00.000Z',
      startedAt: '2026-04-17T00:00:01.000Z',
      finishedAt: null,
      updatedAt: '2026-04-17T00:00:02.000Z',
    };

    await bridge.emitAndreaPlatformRuntimeHealth({
      severity: 'healthy',
      summary: 'Runtime bridge is healthy.',
      detail: 'HTTP listener is accepting requests.',
      metadata: { source: 'test' },
    });
    await bridge.emitAndreaPlatformJobState(
      job,
      'Mirrored from the runtime queue.',
    );
    await bridge.emitAndreaPlatformJobLog(
      job,
      'Runtime orchestration job started running.',
      'C:\\logs\\runtime-job.log',
    );

    expect(fetchImpl).toHaveBeenCalledTimes(3);
    expect(calls[0]?.url).toBe('http://127.0.0.1:4402/system/health');
    expect(calls[1]?.url).toBe('http://127.0.0.1:4402/job/state');
    expect(calls[2]?.url).toBe('http://127.0.0.1:4402/job/log');

    const firstBody = JSON.parse(String(calls[0]?.body ?? '{}'));
    const secondBody = JSON.parse(String(calls[1]?.body ?? '{}'));

    expect(firstBody).toMatchObject({
      source: 'andrea_openai_bot',
      component: 'andrea.runtime',
      owner: 'runtime',
      severity: 'healthy',
      summary: 'Runtime bridge is healthy.',
      detail: 'HTTP listener is accepting requests.',
      metadata: { source: 'test' },
    });
    expect(secondBody).toMatchObject({
      source: 'andrea_openai_bot',
      backend: 'andrea_openai',
      lane_id: 'andrea_runtime',
      job_id: 'job-1',
      group_folder: 'main',
      thread_id: 'thread-1',
      state: 'RUNNING',
      selected_runtime: 'openai_cloud',
      summary: 'Mirrored from the runtime queue.',
      metadata: {
        runtimeRoute: 'cloud_allowed',
        kind: 'create',
        sourceSystem: 'andrea',
      },
    });

    const thirdBody = JSON.parse(String(calls[2]?.body ?? '{}'));
    expect(thirdBody).toMatchObject({
      source: 'andrea_openai_bot',
      backend: 'andrea_openai',
      lane_id: 'andrea_runtime',
      job_id: 'job-1',
      log_excerpt: 'Runtime orchestration job started running.',
      log_path: 'C:\\logs\\runtime-job.log',
      metadata: {
        runtimeRoute: 'cloud_allowed',
        kind: 'create',
        selectedRuntime: 'openai_cloud',
      },
    });
  });
});
