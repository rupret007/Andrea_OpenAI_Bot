import { logger } from './logger.js';
import type {
  RuntimeBackendStatusSnapshot,
  RuntimeOrchestrationJob,
} from './types.js';

const RUNTIME_GATEWAY_BASE_URL = (
  process.env.ANDREA_PLATFORM_RUNTIME_GATEWAY_URL || ''
)
  .trim()
  .replace(/\/+$/, '');

type HealthSeverity =
  | 'healthy'
  | 'degraded'
  | 'faulted'
  | 'blocked_external'
  | 'near_live_only';

function runtimeGatewayRoute(path: string): string | null {
  if (!RUNTIME_GATEWAY_BASE_URL) return null;
  return `${RUNTIME_GATEWAY_BASE_URL}${path}`;
}

async function postRuntimeGateway(
  path: string,
  payload: object,
): Promise<void> {
  const url = runtimeGatewayRoute(path);
  if (!url) return;

  try {
    const response = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    if (!response.ok) {
      logger.warn(
        {
          component: 'andrea_platform_runtime_bridge',
          path,
          status: response.status,
        },
        'Andrea platform runtime bridge returned a non-2xx response.',
      );
    }
  } catch (err) {
    logger.debug(
      {
        component: 'andrea_platform_runtime_bridge',
        path,
        err,
      },
      'Andrea platform runtime bridge post failed.',
    );
  }
}

export function isAndreaPlatformRuntimeBridgeEnabled(): boolean {
  return Boolean(RUNTIME_GATEWAY_BASE_URL);
}

export async function emitAndreaPlatformRuntimeHealth(input: {
  severity: HealthSeverity;
  summary: string;
  detail?: string | null;
  metadata?: Record<string, string>;
}): Promise<void> {
  await postRuntimeGateway('/system/health', {
    source: 'andrea_openai_bot',
    component: 'andrea.runtime',
    owner: 'runtime',
    severity: input.severity,
    summary: input.summary,
    ...(input.detail ? { detail: input.detail } : {}),
    ...(input.metadata ? { metadata: input.metadata } : {}),
  });
}

export function mapRuntimeStatusToHealthSeverity(
  status: RuntimeBackendStatusSnapshot,
): HealthSeverity {
  if (!status.enabled) {
    return 'faulted';
  }

  if (!status.ready) {
    if (status.localExecutionState === 'available_auth_required') {
      return 'near_live_only';
    }
    if (status.localExecutionState === 'unavailable') {
      return 'faulted';
    }
    return 'degraded';
  }

  return 'healthy';
}

export function buildRuntimeHealthMetadata(
  status: RuntimeBackendStatusSnapshot,
): Record<string, string> {
  return {
    backend: status.backend,
    transport: status.transport,
    enabled: String(status.enabled),
    version: status.version || '',
    ready: String(status.ready),
    localExecutionState: status.localExecutionState,
    authState: status.authState,
    localExecutionDetail: status.localExecutionDetail || '',
    operatorGuidance: status.operatorGuidance || '',
    defaultRuntime: status.runtime.defaultRuntime,
    fallbackRuntime: status.runtime.fallbackRuntime,
    codexLocalEnabled: String(status.runtime.codexLocalEnabled),
    codexLocalModel: status.runtime.codexLocalModel || '',
    codexLocalReady: String(status.runtime.codexLocalReady),
    hostCodexAuthPresent: String(status.runtime.hostCodexAuthPresent),
    openAiModelFallback: status.runtime.openAiModelFallback,
    openAiApiKeyPresent: String(status.runtime.openAiApiKeyPresent),
    openAiCloudReady: String(status.runtime.openAiCloudReady),
    openAiBaseUrl: status.runtime.openAiBaseUrl || '',
    activeThreadCount: String(status.runtime.activeThreadCount),
    activeJobCount: String(status.runtime.activeJobCount),
    containerRuntimeName: status.runtime.containerRuntimeName,
    containerRuntimeStatus: status.runtime.containerRuntimeStatus,
    dispatchSurface: JSON.stringify(status.dispatchSurface),
  };
}

export async function emitAndreaPlatformRuntimeHealthFromStatus(
  status: RuntimeBackendStatusSnapshot,
): Promise<void> {
  await emitAndreaPlatformRuntimeHealth({
    severity: mapRuntimeStatusToHealthSeverity(status),
    summary: status.ready
      ? 'Andrea OpenAI runtime backend is ready.'
      : 'Andrea OpenAI runtime backend is not fully ready.',
    detail: status.localExecutionDetail,
    metadata: buildRuntimeHealthMetadata(status),
  });
}

export async function emitAndreaPlatformJobState(
  job: RuntimeOrchestrationJob,
  summary?: string | null,
): Promise<void> {
  await postRuntimeGateway('/job/state', {
    source: 'andrea_openai_bot',
    ...(job.correlationId ? { correlation_id: job.correlationId } : {}),
    backend: 'andrea_openai',
    lane_id: 'andrea_runtime',
    job_id: job.jobId,
    group_folder: job.groupFolder,
    ...(job.threadId ? { thread_id: job.threadId } : {}),
    state: job.status.toUpperCase(),
    ...(job.selectedRuntime ? { selected_runtime: job.selectedRuntime } : {}),
    summary: summary || job.promptPreview,
    ...(job.errorText ? { error_text: job.errorText } : {}),
    metadata: {
      runtimeRoute: job.runtimeRoute,
      ...(job.kind ? { kind: job.kind } : {}),
      ...(job.sourceSystem ? { sourceSystem: job.sourceSystem } : {}),
      ...(job.actorType ? { actorType: job.actorType } : {}),
      ...(job.actorId ? { actorId: job.actorId } : {}),
      ...(job.correlationId ? { correlationId: job.correlationId } : {}),
      ...(job.requestedRuntime ? { requestedRuntime: job.requestedRuntime } : {}),
      ...(job.selectedRuntime ? { selectedRuntime: job.selectedRuntime } : {}),
    },
  });
}

export async function emitAndreaPlatformJobLog(
  job: RuntimeOrchestrationJob,
  logExcerpt: string,
  logPath?: string | null,
): Promise<void> {
  await postRuntimeGateway('/job/log', {
    source: 'andrea_openai_bot',
    ...(job.correlationId ? { correlation_id: job.correlationId } : {}),
    backend: 'andrea_openai',
    lane_id: 'andrea_runtime',
    job_id: job.jobId,
    log_excerpt: logExcerpt,
    ...(logPath ? { log_path: logPath } : {}),
    metadata: {
      runtimeRoute: job.runtimeRoute,
      ...(job.kind ? { kind: job.kind } : {}),
      ...(job.sourceSystem ? { sourceSystem: job.sourceSystem } : {}),
      ...(job.actorType ? { actorType: job.actorType } : {}),
      ...(job.actorId ? { actorId: job.actorId } : {}),
      ...(job.correlationId ? { correlationId: job.correlationId } : {}),
      ...(job.requestedRuntime ? { requestedRuntime: job.requestedRuntime } : {}),
      ...(job.selectedRuntime ? { selectedRuntime: job.selectedRuntime } : {}),
      ...(logPath ? { logFile: logPath } : {}),
    },
  });
}
