import { OPENAI_MODEL_FALLBACK } from './config.js';
import type {
  CompanionRouteArguments,
  CompanionRouteConfidence,
  CompanionRouteKind,
  RoutePromptRequest,
  RoutePromptResult,
} from './types.js';

const DEFAULT_OPENAI_BASE_URL = 'https://api.openai.com/v1';

function normalizeText(value: string | null | undefined): string {
  return (value || '').replace(/\s+/g, ' ').trim();
}

function trimTrailingSlashes(value: string): string {
  return value.replace(/\/+$/, '');
}

function extractResponseOutputText(payload: unknown): string {
  const record =
    payload && typeof payload === 'object'
      ? (payload as Record<string, unknown>)
      : {};
  const directOutput = record.output_text;
  if (typeof directOutput === 'string' && directOutput.trim()) {
    return directOutput.trim();
  }
  const output = Array.isArray(record.output) ? record.output : [];
  const parts: string[] = [];
  for (const item of output) {
    const itemRecord =
      item && typeof item === 'object'
        ? (item as Record<string, unknown>)
        : {};
    const content = Array.isArray(itemRecord.content) ? itemRecord.content : [];
    for (const chunk of content) {
      const chunkRecord =
        chunk && typeof chunk === 'object'
          ? (chunk as Record<string, unknown>)
          : {};
      if (
        chunkRecord.type === 'output_text' &&
        typeof chunkRecord.text === 'string'
      ) {
        parts.push(chunkRecord.text);
      }
    }
  }
  return parts.join('\n').trim();
}

function stripJsonFences(value: string): string {
  return value
    .replace(/^```(?:json)?\s*/i, '')
    .replace(/\s*```$/i, '')
    .trim();
}

function safeJsonParse<T>(value: string, fallback: T): T {
  try {
    return JSON.parse(value) as T;
  } catch {
    return fallback;
  }
}

function normalizeRouteKind(value: unknown): CompanionRouteKind {
  switch (value) {
    case 'assistant_capability':
    case 'direct_quick_reply':
    case 'protected_assistant':
    case 'clarify':
      return value;
    default:
      return 'unsupported';
  }
}

function normalizeConfidence(value: unknown): CompanionRouteConfidence {
  switch (value) {
    case 'high':
    case 'medium':
      return value;
    default:
      return 'low';
  }
}

function normalizePositiveInteger(value: unknown): number | null {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    return null;
  }
  const rounded = Math.round(value);
  return rounded > 0 ? rounded : null;
}

function normalizeArguments(value: unknown): CompanionRouteArguments | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return null;
  }
  const record = value as Record<string, unknown>;
  const timeWindowKind =
    record.timeWindowKind === 'default_24h' ||
    record.timeWindowKind === 'last_hours' ||
    record.timeWindowKind === 'last_days' ||
    record.timeWindowKind === 'today' ||
    record.timeWindowKind === 'yesterday' ||
    record.timeWindowKind === 'this_week'
      ? record.timeWindowKind
      : null;
  const replyStyle =
    record.replyStyle === 'shorter' ||
    record.replyStyle === 'warmer' ||
    record.replyStyle === 'more_direct'
      ? record.replyStyle
      : null;
  return {
    targetChatName: normalizeText(record.targetChatName as string) || null,
    targetChatJid: normalizeText(record.targetChatJid as string) || null,
    personName: normalizeText(record.personName as string) || null,
    threadTitle: normalizeText(record.threadTitle as string) || null,
    timeWindowKind,
    timeWindowValue: normalizePositiveInteger(record.timeWindowValue),
    savedMaterialOnly:
      typeof record.savedMaterialOnly === 'boolean'
        ? record.savedMaterialOnly
        : null,
    replyStyle,
  };
}

function getRouterConfig(): {
  apiKey: string;
  baseUrl: string;
  model: string;
} {
  const apiKey = normalizeText(process.env.OPENAI_API_KEY);
  if (!apiKey) {
    throw new Error(
      'OpenAI routing is unavailable because OPENAI_API_KEY is not configured on the backend host.',
    );
  }
  const baseUrl = trimTrailingSlashes(
    normalizeText(process.env.OPENAI_BASE_URL) || DEFAULT_OPENAI_BASE_URL,
  );
  return {
    apiKey,
    baseUrl,
    model: OPENAI_MODEL_FALLBACK,
  };
}

function buildRouterPrompt(input: RoutePromptRequest): string {
  return [
    'You are Andrea\'s routing planner for Telegram and BlueBubbles.',
    'Return JSON only.',
    'You never execute actions. You only select the best local route and extract lightweight arguments.',
    'Valid routeKind values: assistant_capability, direct_quick_reply, protected_assistant, clarify, unsupported.',
    'Use assistant_capability for local capabilities such as:',
    '- communication.summarize_thread (summarize a synced Messages thread by chat name and optional time window)',
    '- communication.understand_message',
    '- communication.draft_reply',
    '- communication.open_loops',
    '- communication.manage_tracking',
    '- daily.loose_ends',
    '- daily.evening_reset',
    '- daily.whats_next',
    '- staff.prioritize',
    '- knowledge.summarize_saved',
    '- capture.add_item',
    '- capture.read_items',
    '- capture.update_item',
    '- research.topic',
    '- research.compare',
    '- research.summarize',
    '- research.recommend',
    'Use protected_assistant for calendar/reminder/task-style asks that should stay on Andrea\'s protected local path.',
    'Use direct_quick_reply for greetings, presence, thanks, and very lightweight discovery or chit-chat.',
    'Use clarify when the target thread/person/window is too ambiguous to execute safely.',
    'Use unsupported only when none of the supported local routes fit.',
    'Never send a thread-summary ask to research.summarize when it is about a synced Messages chat by name.',
    'Treat summarize misspellings like summerize and sumarize as summarize.',
    'For thread summaries, fill arguments.targetChatName and the timeWindow fields when possible.',
    'For reply rewrites, fill arguments.replyStyle when the user asks for shorter, warmer, or more direct.',
    'For saved-material asks, set arguments.savedMaterialOnly=true when that is explicit.',
    'Keep canonicalText short and execution-friendly for the local suite.',
    `Context JSON: ${JSON.stringify(input)}`,
    'Return JSON with keys: routeKind, capabilityId, canonicalText, arguments, confidence, clarificationPrompt, reason.',
  ].join('\n');
}

export async function routeCompanionPrompt(
  input: RoutePromptRequest,
  fetchImpl: typeof fetch = fetch,
): Promise<RoutePromptResult> {
  const config = getRouterConfig();
  const normalizedText = normalizeText(input.text);
  if (!normalizedText) {
    return {
      routeKind: 'clarify',
      capabilityId: null,
      canonicalText: '',
      arguments: null,
      confidence: 'low',
      clarificationPrompt: 'What do you want Andrea to help with here?',
      reason: 'empty prompt',
    };
  }

  const response = await fetchImpl(`${config.baseUrl}/responses`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${config.apiKey}`,
    },
    body: JSON.stringify({
      model: config.model,
      input: buildRouterPrompt({
        ...input,
        text: normalizedText,
      }),
    }),
  });

  if (!response.ok) {
    const body = await response.text();
    throw new Error(
      `OpenAI routing request failed with status ${response.status}: ${normalizeText(body) || 'no response body'}`,
    );
  }

  const payload = (await response.json()) as unknown;
  const rawOutput = stripJsonFences(extractResponseOutputText(payload));
  if (!rawOutput) {
    throw new Error('OpenAI routing returned an empty response payload.');
  }

  const parsed = safeJsonParse<Partial<RoutePromptResult>>(rawOutput, {});
  return {
    routeKind: normalizeRouteKind(parsed.routeKind),
    capabilityId: normalizeText(parsed.capabilityId || undefined) || null,
    canonicalText: normalizeText(parsed.canonicalText || undefined) || normalizedText,
    arguments: normalizeArguments(parsed.arguments),
    confidence: normalizeConfidence(parsed.confidence),
    clarificationPrompt:
      normalizeText(parsed.clarificationPrompt || undefined) || null,
    reason: normalizeText(parsed.reason || undefined) || null,
  };
}
