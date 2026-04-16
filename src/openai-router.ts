import {
  buildOpenAiModelCandidates,
  detectOpenAiProviderMode,
  isOpenAiModelRejection,
} from './openai-model-routing.js';
import type {
  CompanionRouteArguments,
  CompanionRouteConfidence,
  CompanionRouteKind,
  OpenAiModelTier,
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
      item && typeof item === 'object' ? (item as Record<string, unknown>) : {};
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

type CompanionRouteTimeWindowKind =
  | 'default_24h'
  | 'last_hours'
  | 'last_days'
  | 'today'
  | 'yesterday'
  | 'this_week';

const GENERIC_THREAD_NAME_TOKENS = new Set([
  'a',
  'an',
  'for',
  'from',
  'in',
  'last',
  'message',
  'messages',
  'my',
  'please',
  'pls',
  'recent',
  'text',
  'texts',
  'that',
  'the',
  'this',
  'thread',
  'today',
  'week',
  'yesterday',
]);

function parseThreadSummaryWindow(
  text: string,
): { cleanedText: string; kind: CompanionRouteTimeWindowKind; value: number | null } {
  const normalized = normalizeText(text);
  const patterns: Array<{
    pattern: RegExp;
    kind: CompanionRouteTimeWindowKind;
    parseValue?(match: RegExpMatchArray): number | null;
  }> = [
    {
      pattern: /\blast\s+(\d+)\s+hours?\b/i,
      kind: 'last_hours',
      parseValue: (match) => Number.parseInt(match[1] || '', 10) || null,
    },
    {
      pattern: /\blast\s+(\d+)\s+days?\b/i,
      kind: 'last_days',
      parseValue: (match) => Number.parseInt(match[1] || '', 10) || null,
    },
    { pattern: /\btoday\b/i, kind: 'today' },
    { pattern: /\byesterday\b/i, kind: 'yesterday' },
    { pattern: /\bthis week\b/i, kind: 'this_week' },
  ];

  for (const candidate of patterns) {
    const match = normalized.match(candidate.pattern);
    if (!match) continue;
    return {
      cleanedText: normalizeText(
        normalized.replace(candidate.pattern, ' ').replace(/[.,!?]+$/g, ''),
      ),
      kind: candidate.kind,
      value: candidate.parseValue ? candidate.parseValue(match) : null,
    };
  }

  return {
    cleanedText: normalized.replace(/[.,!?]+$/g, '').trim(),
    kind: 'default_24h',
    value: 24,
  };
}

function cleanThreadChatName(value: string): string {
  return normalizeText(value)
    .replace(/^(?:from|in)\s+/i, '')
    .replace(/^the\s+/i, '')
    .replace(
      /\b(?:text(?: message)?s?|messages?|message|thread|chat|conversation|group(?: chat)?|space)\b/gi,
      ' ',
    )
    .replace(/\b(?:please|pls)\b/gi, ' ')
    .replace(/["']/g, '')
    .replace(/\b(?:from|in)\b\s*$/i, '')
    .replace(/[.,!?]+$/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function isSpecificThreadChatName(value: string): boolean {
  const normalized = cleanThreadChatName(value).toLowerCase();
  if (!normalized) {
    return false;
  }
  if (
    /^(?:for|today|yesterday|this week|recent|my|my texts?|my messages?|text messages?|messages?|texts?)$/i.test(
      normalized,
    )
  ) {
    return false;
  }
  const tokens = normalized.split(/\s+/).filter(Boolean);
  return tokens.some((token) => !GENERIC_THREAD_NAME_TOKENS.has(token));
}

function looksLikeThreadSummaryPrompt(value: string): boolean {
  const lower = value.toLowerCase();
  if (
    !/\b(?:summari[sz]e|summerize|sumarize)\b/.test(lower) &&
    !/\bsummary of\b/.test(lower)
  ) {
    return false;
  }
  if (/\b(news|article|website|page|video|podcast)\b/.test(lower)) {
    return false;
  }
  if (
    /^summari[sz]e this\b/.test(lower) ||
    /^summerize this\b/.test(lower) ||
    /^sumarize this\b/.test(lower) ||
    /^summari[sz]e this message\b/.test(lower)
  ) {
    return false;
  }
  return /\b(?:text(?: message)?s?|messages|texts|thread|chat|conversation)\b/.test(
    lower,
  );
}

function parseNamedThreadSummaryArguments(
  rawText: string,
): {
  canonicalText: string;
  arguments: CompanionRouteArguments;
} | null {
  const normalized = normalizeText(rawText);
  if (!normalized || !looksLikeThreadSummaryPrompt(normalized)) {
    return null;
  }

  const { cleanedText, kind, value } = parseThreadSummaryWindow(normalized);
  const withoutLead = normalizeText(
    normalizeText(
      cleanedText
        .replace(/^(?:can you|could you|please|hey|hi|hello)\s+/i, '')
        .replace(/\b(?:summari[sz]e|summerize|sumarize)\b/i, ''),
    )
      .replace(/^my\s+/i, '')
      .replace(/^(?:the\s+)?(?:text(?: message)?s?|messages?|texts?)\s+/i, '')
      .replace(/^(?:in|from)\s+/i, ''),
  );

  const extractionPatterns = [
    /^(?:my\s+)?(?:text(?: message)?s?|messages?|texts?)\s+(?:in|from)\s+(.+)$/i,
    /^(?:in|from)\s+(.+)$/i,
    /^(.+?)\s+(?:text(?: message)?s?|messages?|thread|chat|conversation)$/i,
    /^(.+)$/i,
  ];

  let targetChatName = '';
  for (const pattern of extractionPatterns) {
    const match = withoutLead.match(pattern);
    if (!match) continue;
    targetChatName = cleanThreadChatName(match[1] || '');
    if (targetChatName && isSpecificThreadChatName(targetChatName)) break;
  }

  if (!targetChatName || !isSpecificThreadChatName(targetChatName)) {
    return null;
  }

  const canonicalText =
    kind === 'default_24h'
      ? `summarize my text messages in ${targetChatName}`
      : kind === 'last_hours'
        ? `summarize my text messages in ${targetChatName} from the last ${value || 1} hours`
        : kind === 'last_days'
          ? `summarize my text messages in ${targetChatName} from the last ${value || 1} days`
          : kind === 'today'
            ? `summarize my text messages in ${targetChatName} from today`
            : kind === 'yesterday'
              ? `summarize my text messages in ${targetChatName} from yesterday`
              : `summarize my text messages in ${targetChatName} from this week`;

  return {
    canonicalText,
    arguments: {
      targetChatName,
      threadTitle: targetChatName,
      timeWindowKind: kind,
      timeWindowValue: value,
    },
  };
}

function buildGenericThreadSummaryClarification(rawText: string): string | null {
  const normalized = normalizeText(rawText).toLowerCase();
  if (
    !/\b(?:text(?: message)?s?|messages|texts)\b/.test(normalized) ||
    /\b(news|article|website|page|video|podcast)\b/.test(normalized)
  ) {
    return null;
  }
  const looksGenericRecentAsk =
    /\b(?:recent|latest)\s+(?:text(?: message)?s?|messages|texts)\b/.test(
      normalized,
    ) ||
    /\b(?:what(?:'s| is| are)|show me)\b.*\b(?:text(?: message)?s?|messages|texts)\b/.test(
      normalized,
    ) ||
    looksLikeThreadSummaryPrompt(normalized);
  if (!looksGenericRecentAsk) {
    return null;
  }
  const namedIntent = parseNamedThreadSummaryArguments(rawText);
  if (namedIntent) {
    return null;
  }
  const { kind, value } = parseThreadSummaryWindow(rawText);
  if (kind === 'today') {
    return 'Which Messages chat should I summarize for today?';
  }
  if (kind === 'yesterday') {
    return 'Which Messages chat should I summarize from yesterday?';
  }
  if (kind === 'this_week') {
    return 'Which Messages chat should I summarize from this week?';
  }
  if (kind === 'last_days') {
    return `Which Messages chat should I summarize from the last ${value || 1} day${value === 1 ? '' : 's'}?`;
  }
  if (kind === 'last_hours') {
    return `Which Messages chat should I summarize from the last ${value || 1} hour${value === 1 ? '' : 's'}?`;
  }
  return 'Which Messages chat do you want me to summarize?';
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
  simpleModel: string | null;
  standardModel: string | null;
  complexModel: string | null;
  fallbackModel: string | null;
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
    simpleModel: normalizeText(process.env.OPENAI_MODEL_SIMPLE) || null,
    standardModel: normalizeText(process.env.OPENAI_MODEL_STANDARD) || null,
    complexModel: normalizeText(process.env.OPENAI_MODEL_COMPLEX) || null,
    fallbackModel:
      normalizeText(process.env.OPENAI_MODEL_FALLBACK) ||
      normalizeText(process.env.OPENAI_MODEL_COMPLEX),
  };
}

function buildRouterPrompt(input: RoutePromptRequest): string {
  return [
    "You are Andrea's routing planner for Telegram and BlueBubbles.",
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
    'Use assistant_capability with research.topic for live-fact asks such as weather, forecast, current conditions, temperature, wind, humidity, rain, snow, headlines, latest news, or other outward lookup questions.',
    "Use protected_assistant for calendar/reminder/task-style asks that should stay on Andrea's protected local path.",
    'Use direct_quick_reply for greetings, presence, thanks, and very lightweight discovery or chit-chat.',
    'Use clarify when the target thread/person/window is too ambiguous to execute safely.',
    'Use unsupported only when none of the supported local routes fit.',
    'Never send a thread-summary ask to research.summarize when it is about a synced Messages chat by name.',
    'Treat summarize misspellings like summerize and sumarize as summarize.',
    'For thread summaries, fill arguments.targetChatName and the timeWindow fields when possible.',
    'If the user asks for recent text messages or a text-message summary without naming a specific synced Messages chat, use clarify and ask which chat they mean.',
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

  const providerMode = detectOpenAiProviderMode(config.baseUrl);
  const prompt = buildRouterPrompt({
    ...input,
    text: normalizedText,
  });
  const namedThreadSummaryIntent =
    parseNamedThreadSummaryArguments(normalizedText);
  const genericThreadSummaryClarification =
    buildGenericThreadSummaryClarification(normalizedText);
  const candidates = buildOpenAiModelCandidates('simple', {
    simpleModel: config.simpleModel,
    standardModel: config.standardModel,
    complexModel: config.complexModel,
    fallbackModel: config.fallbackModel,
  });
  let lastFailure: string | null = null;

  for (const candidate of candidates) {
    const response = await fetchImpl(`${config.baseUrl}/responses`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${config.apiKey}`,
      },
      body: JSON.stringify({
        model: candidate.model,
        input: prompt,
      }),
    });

    if (!response.ok) {
      const body = await response.text();
      lastFailure = `OpenAI routing request failed with status ${response.status}: ${normalizeText(body) || 'no response body'}`;
      if (isOpenAiModelRejection(response.status, body)) {
        continue;
      }
      throw new Error(lastFailure);
    }

    const payload = (await response.json()) as unknown;
    const rawOutput = stripJsonFences(extractResponseOutputText(payload));
    if (!rawOutput) {
      throw new Error('OpenAI routing returned an empty response payload.');
    }

    const parsed = safeJsonParse<Partial<RoutePromptResult>>(rawOutput, {});
    const result: RoutePromptResult = {
      routeKind: normalizeRouteKind(parsed.routeKind),
      capabilityId: normalizeText(parsed.capabilityId || undefined) || null,
      canonicalText:
        normalizeText(parsed.canonicalText || undefined) || normalizedText,
      arguments: normalizeArguments(parsed.arguments),
      confidence: normalizeConfidence(parsed.confidence),
      clarificationPrompt:
        normalizeText(parsed.clarificationPrompt || undefined) || null,
      reason: normalizeText(parsed.reason || undefined) || null,
      selectedModelTier:
        (parsed.selectedModelTier as OpenAiModelTier | null | undefined) ||
        candidate.tier,
      selectedModel:
        normalizeText(parsed.selectedModel || undefined) || candidate.model,
      providerMode:
        normalizeText(parsed.providerMode || undefined) === 'compatible_gateway'
          ? 'compatible_gateway'
          : providerMode,
    };
    if (genericThreadSummaryClarification) {
      return {
        ...result,
        routeKind: 'clarify',
        capabilityId: null,
        canonicalText: 'summarize a synced Messages thread',
        arguments: null,
        clarificationPrompt: genericThreadSummaryClarification,
        reason:
          'generic recent-text summary asks need a specific synced Messages thread',
      };
    }
    if (namedThreadSummaryIntent) {
      return {
        ...result,
        routeKind: 'assistant_capability',
        capabilityId: 'communication.summarize_thread',
        canonicalText:
          namedThreadSummaryIntent.canonicalText || result.canonicalText,
        arguments: {
          ...(result.arguments || {}),
          ...namedThreadSummaryIntent.arguments,
        },
        reason:
          result.reason ||
          'user asked to summarize a synced Messages thread by name',
      };
    }
    return result;
  }

  throw new Error(
    lastFailure || 'OpenAI routing failed before returning a usable response.',
  );
}
