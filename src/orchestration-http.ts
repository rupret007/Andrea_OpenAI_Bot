import { createServer, type IncomingMessage, type Server } from 'http';

import { logger } from './logger.js';
import type { RuntimeOrchestrationService } from './runtime-orchestration.js';
import {
  ORCHESTRATION_BACKEND_ID,
  type OrchestrationSource,
  type RuntimeBackendJob,
  type RuntimeBackendJobList,
  type RuntimeBackendMeta,
  type RuntimeOrchestrationJob,
} from './types.js';

const LOOPBACK_HOSTS = new Set(['127.0.0.1', '::1', 'localhost']);

class HttpRouteError extends Error {
  constructor(
    readonly status: number,
    readonly code:
      | 'validation_error'
      | 'not_found'
      | 'method_not_allowed'
      | 'internal_error',
    message: string,
    readonly allow?: string,
  ) {
    super(message);
    this.name = 'HttpRouteError';
  }
}

export interface OrchestrationHttpServerOptions {
  host: string;
  port: number;
  service: RuntimeOrchestrationService;
  getMeta(): RuntimeBackendMeta;
}

export interface OrchestrationHttpServerHandle {
  host: string;
  port: number;
  server: Server;
  close(): Promise<void>;
}

function normalizeHost(host: string): string {
  return host.trim().replace(/^\[(.*)\]$/, '$1');
}

export function isLoopbackHost(host: string): boolean {
  return LOOPBACK_HOSTS.has(normalizeHost(host).toLowerCase());
}

function getJobCapabilities(job: RuntimeOrchestrationJob) {
  return {
    followUp: true,
    logs: true,
    stop: job.status === 'queued' || job.status === 'running',
  };
}

export function toRuntimeBackendJob(
  job: RuntimeOrchestrationJob,
): RuntimeBackendJob {
  return {
    ...job,
    backend: ORCHESTRATION_BACKEND_ID,
    capabilities: getJobCapabilities(job),
  };
}

function toRuntimeBackendJobList(jobs: {
  jobs: RuntimeOrchestrationJob[];
  nextBeforeJobId?: string | null;
}): RuntimeBackendJobList {
  return {
    jobs: jobs.jobs.map(toRuntimeBackendJob),
    nextBeforeJobId: jobs.nextBeforeJobId || null,
  };
}

function writeJson(
  res: import('http').ServerResponse,
  status: number,
  payload: unknown,
): void {
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.end(JSON.stringify(payload));
}

function writeError(
  res: import('http').ServerResponse,
  err: HttpRouteError,
): void {
  if (err.allow) {
    res.setHeader('Allow', err.allow);
  }
  writeJson(res, err.status, {
    error: {
      code: err.code,
      message: err.message,
    },
  });
}

async function readRawBody(req: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return Buffer.concat(chunks).toString('utf-8');
}

async function readJsonBody(
  req: IncomingMessage,
  options: { required: boolean },
): Promise<Record<string, unknown> | null> {
  const rawBody = await readRawBody(req);
  if (!rawBody.trim()) {
    if (options.required) {
      throw new HttpRouteError(
        400,
        'validation_error',
        'A JSON request body is required.',
      );
    }
    return null;
  }

  const contentTypeHeader = req.headers['content-type'];
  const contentType = Array.isArray(contentTypeHeader)
    ? contentTypeHeader.join(';')
    : contentTypeHeader || '';
  if (!contentType.toLowerCase().includes('application/json')) {
    throw new HttpRouteError(
      400,
      'validation_error',
      'POST requests must use application/json.',
    );
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(rawBody);
  } catch {
    throw new HttpRouteError(
      400,
      'validation_error',
      'Request body must be valid JSON.',
    );
  }

  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new HttpRouteError(
      400,
      'validation_error',
      'Request body must be a JSON object.',
    );
  }

  return parsed as Record<string, unknown>;
}

function requireNonEmptyString(
  raw: unknown,
  fieldName: string,
): string {
  if (typeof raw !== 'string') {
    throw new HttpRouteError(
      400,
      'validation_error',
      `${fieldName} must be a non-empty string.`,
    );
  }
  const value = raw.trim();
  if (!value) {
    throw new HttpRouteError(
      400,
      'validation_error',
      `${fieldName} must be a non-empty string.`,
    );
  }
  return value;
}

function optionalTrimmedString(raw: unknown, fieldName: string): string | null {
  if (raw === undefined || raw === null) return null;
  if (typeof raw !== 'string') {
    throw new HttpRouteError(
      400,
      'validation_error',
      `${fieldName} must be a string when provided.`,
    );
  }
  const trimmed = raw.trim();
  return trimmed ? trimmed : null;
}

function parsePositiveInt(
  raw: string | null,
  fieldName: string,
): number | undefined {
  if (raw === null || raw === '') return undefined;
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw new HttpRouteError(
      400,
      'validation_error',
      `${fieldName} must be a positive integer.`,
    );
  }
  return parsed;
}

function parseSource(raw: unknown): OrchestrationSource {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new HttpRouteError(
      400,
      'validation_error',
      'source must be an object.',
    );
  }

  const source = raw as Record<string, unknown>;
  return {
    system: requireNonEmptyString(source.system, 'source.system'),
    actorType: optionalTrimmedString(source.actorType, 'source.actorType'),
    actorId: optionalTrimmedString(source.actorId, 'source.actorId'),
    correlationId: optionalTrimmedString(
      source.correlationId,
      'source.correlationId',
    ),
  };
}

function decodeJobId(rawJobId: string): string {
  try {
    return decodeURIComponent(rawJobId);
  } catch {
    throw new HttpRouteError(
      400,
      'validation_error',
      'jobId is not a valid path segment.',
    );
  }
}

function classifyServiceError(err: unknown): HttpRouteError {
  if (err instanceof HttpRouteError) return err;

  const message = err instanceof Error ? err.message : String(err);

  if (
    message.startsWith('No runtime job found') ||
    message.startsWith('No runtime thread found') ||
    message.startsWith('No registered group found')
  ) {
    return new HttpRouteError(404, 'not_found', message);
  }

  if (
    message.startsWith('Invalid group folder') ||
    message.startsWith('source.system is required') ||
    message.startsWith('prompt is required') ||
    message.startsWith('Follow-up requires') ||
    message.startsWith('Follow-up target mismatch')
  ) {
    return new HttpRouteError(400, 'validation_error', message);
  }

  return new HttpRouteError(500, 'internal_error', message);
}

async function handleRequest(
  req: IncomingMessage,
  res: import('http').ServerResponse,
  options: OrchestrationHttpServerOptions,
): Promise<void> {
  const method = req.method || 'GET';
  const url = new URL(req.url || '/', 'http://127.0.0.1');
  const pathname = url.pathname;

  if (pathname === '/meta') {
    if (method !== 'GET') {
      throw new HttpRouteError(
        405,
        'method_not_allowed',
        'Method not allowed for /meta.',
        'GET',
      );
    }

    writeJson(res, 200, options.getMeta());
    return;
  }

  if (pathname === '/jobs') {
    if (method === 'POST') {
      const body = await readJsonBody(req, { required: true });
      if (!body) {
        throw new HttpRouteError(
          500,
          'internal_error',
          'JSON body unexpectedly missing.',
        );
      }
      const job = await options.service.createJob({
        groupFolder: requireNonEmptyString(body.groupFolder, 'groupFolder'),
        prompt: requireNonEmptyString(body.prompt, 'prompt'),
        source: parseSource(body.source),
      });
      writeJson(res, 202, { job: toRuntimeBackendJob(job) });
      return;
    }

    if (method === 'GET') {
      const beforeJobId = optionalTrimmedString(
        url.searchParams.get('beforeJobId'),
        'beforeJobId',
      );
      if (beforeJobId && !options.service.getJob(beforeJobId)) {
        throw new HttpRouteError(
          404,
          'not_found',
          `No runtime job found for "${beforeJobId}".`,
        );
      }

      const jobs = options.service.listJobs({
        groupFolder: optionalTrimmedString(
          url.searchParams.get('groupFolder'),
          'groupFolder',
        ) || undefined,
        limit: parsePositiveInt(url.searchParams.get('limit'), 'limit'),
        beforeJobId: beforeJobId || undefined,
      });
      writeJson(res, 200, toRuntimeBackendJobList(jobs));
      return;
    }

    throw new HttpRouteError(
      405,
      'method_not_allowed',
      'Method not allowed for /jobs.',
      'GET, POST',
    );
  }

  const followUpMatch = pathname.match(/^\/jobs\/([^/]+)\/followup$/);
  if (followUpMatch) {
    if (method !== 'POST') {
      throw new HttpRouteError(
        405,
        'method_not_allowed',
        `Method not allowed for ${pathname}.`,
        'POST',
      );
    }

    const body = await readJsonBody(req, { required: true });
    if (!body) {
      throw new HttpRouteError(
        500,
        'internal_error',
        'JSON body unexpectedly missing.',
      );
    }
    const jobId = decodeJobId(followUpMatch[1] || '');
    const job = await options.service.followUp({
      jobId,
      prompt: requireNonEmptyString(body.prompt, 'prompt'),
      source: parseSource(body.source),
    });
    writeJson(res, 202, { job: toRuntimeBackendJob(job) });
    return;
  }

  const logsMatch = pathname.match(/^\/jobs\/([^/]+)\/logs$/);
  if (logsMatch) {
    if (method !== 'GET') {
      throw new HttpRouteError(
        405,
        'method_not_allowed',
        `Method not allowed for ${pathname}.`,
        'GET',
      );
    }

    const jobId = decodeJobId(logsMatch[1] || '');
    const result = options.service.getJobLogs({
      jobId,
      lines: parsePositiveInt(url.searchParams.get('lines'), 'lines'),
    });
    writeJson(res, 200, result);
    return;
  }

  const stopMatch = pathname.match(/^\/jobs\/([^/]+)\/stop$/);
  if (stopMatch) {
    if (method !== 'POST') {
      throw new HttpRouteError(
        405,
        'method_not_allowed',
        `Method not allowed for ${pathname}.`,
        'POST',
      );
    }

    const body = await readJsonBody(req, { required: false });
    const jobId = decodeJobId(stopMatch[1] || '');
    const result = await options.service.stopJob({
      jobId,
      source: body?.source ? parseSource(body.source) : undefined,
    });
    writeJson(res, 200, {
      ...result,
      job: toRuntimeBackendJob(result.job),
    });
    return;
  }

  const jobMatch = pathname.match(/^\/jobs\/([^/]+)$/);
  if (jobMatch) {
    if (method !== 'GET') {
      throw new HttpRouteError(
        405,
        'method_not_allowed',
        `Method not allowed for ${pathname}.`,
        'GET',
      );
    }

    const jobId = decodeJobId(jobMatch[1] || '');
    const job = options.service.getJob(jobId);
    if (!job) {
      throw new HttpRouteError(
        404,
        'not_found',
        `No runtime job found for "${jobId}".`,
      );
    }
    writeJson(res, 200, { job: toRuntimeBackendJob(job) });
    return;
  }

  throw new HttpRouteError(404, 'not_found', `No route found for ${pathname}.`);
}

export async function startOrchestrationHttpServer(
  options: OrchestrationHttpServerOptions,
): Promise<OrchestrationHttpServerHandle> {
  const normalizedHost = normalizeHost(options.host);
  if (!isLoopbackHost(normalizedHost)) {
    throw new Error(
      `ORCHESTRATION_HTTP_HOST must be loopback-only. Received "${options.host}".`,
    );
  }

  const server = createServer((req, res) => {
    void handleRequest(req, res, options).catch((err) => {
      const httpErr = classifyServiceError(err);
      logger.warn(
        {
          method: req.method,
          url: req.url,
          status: httpErr.status,
          code: httpErr.code,
          err: err instanceof HttpRouteError ? undefined : err,
        },
        'Orchestration HTTP request failed',
      );
      writeError(res, httpErr);
    });
  });

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(options.port, normalizedHost, () => {
      server.off('error', reject);
      resolve();
    });
  });

  const address = server.address();
  const actualPort =
    address && typeof address === 'object' ? address.port : options.port;

  return {
    host: normalizedHost,
    port: actualPort,
    server,
    close() {
      return new Promise<void>((resolveClose, rejectClose) => {
        server.close((err) => {
          if (err) {
            rejectClose(err);
            return;
          }
          resolveClose();
        });
      });
    },
  };
}
