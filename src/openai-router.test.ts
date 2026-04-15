import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { routeCompanionPrompt } from './openai-router.js';

const originalApiKey = process.env.OPENAI_API_KEY;
const originalBaseUrl = process.env.OPENAI_BASE_URL;
const originalSimpleModel = process.env.OPENAI_MODEL_SIMPLE;
const originalStandardModel = process.env.OPENAI_MODEL_STANDARD;
const originalComplexModel = process.env.OPENAI_MODEL_COMPLEX;
const originalFallbackModel = process.env.OPENAI_MODEL_FALLBACK;

describe('openai router', () => {
  beforeEach(() => {
    process.env.OPENAI_API_KEY = 'test-key';
    process.env.OPENAI_BASE_URL = 'https://api.openai.com/v1';
    delete process.env.OPENAI_MODEL_SIMPLE;
    delete process.env.OPENAI_MODEL_STANDARD;
    delete process.env.OPENAI_MODEL_COMPLEX;
    delete process.env.OPENAI_MODEL_FALLBACK;
    vi.restoreAllMocks();
  });

  afterEach(() => {
    process.env.OPENAI_API_KEY = originalApiKey;
    process.env.OPENAI_BASE_URL = originalBaseUrl;
    process.env.OPENAI_MODEL_SIMPLE = originalSimpleModel;
    process.env.OPENAI_MODEL_STANDARD = originalStandardModel;
    process.env.OPENAI_MODEL_COMPLEX = originalComplexModel;
    process.env.OPENAI_MODEL_FALLBACK = originalFallbackModel;
  });

  it('uses the simple tier for router calls and reports model metadata', async () => {
    process.env.OPENAI_MODEL_SIMPLE = 'gpt-5.4-mini';
    const fetchImpl = vi.fn(async (_input, init) => {
      const payload = JSON.parse(String(init?.body)) as {
        model: string;
        input: string;
      };
      expect(payload.model).toBe('gpt-5.4-mini');
      expect(payload.input).toContain(
        'research.topic for live-fact asks such as weather',
      );
      return new Response(
        JSON.stringify({
          output_text: JSON.stringify({
            routeKind: 'assistant_capability',
            capabilityId: 'research.topic',
            canonicalText: "Get today's weather in Dallas",
            arguments: null,
            confidence: 'high',
            clarificationPrompt: null,
            reason: 'weather is a live-fact research ask',
          }),
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      );
    });

    const result = await routeCompanionPrompt(
      {
        channel: 'telegram',
        text: 'What is the weather today in Dallas?',
        requestRoute: 'protected_assistant',
      },
      fetchImpl as unknown as typeof fetch,
    );

    expect(result.routeKind).toBe('assistant_capability');
    expect(result.capabilityId).toBe('research.topic');
    expect(result.selectedModelTier).toBe('simple');
    expect(result.selectedModel).toBe('gpt-5.4-mini');
    expect(result.providerMode).toBe('direct_openai');
  });

  it('falls back upward when the cheap router model is rejected', async () => {
    process.env.OPENAI_MODEL_SIMPLE = 'gpt-5.4-mini';
    process.env.OPENAI_MODEL_STANDARD = 'gpt-5.4-standard';
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            error: { message: 'The model gpt-5.4-mini does not exist.' },
          }),
          { status: 404, headers: { 'Content-Type': 'application/json' } },
        ),
      )
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            output_text: JSON.stringify({
              routeKind: 'assistant_capability',
              capabilityId: 'research.topic',
              canonicalText: "Get today's weather in Dallas",
              arguments: null,
              confidence: 'high',
              clarificationPrompt: null,
              reason: 'weather is a live-fact research ask',
            }),
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } },
        ),
      );

    const result = await routeCompanionPrompt(
      {
        channel: 'telegram',
        text: 'What is the weather today in Dallas?',
        requestRoute: 'protected_assistant',
      },
      fetchImpl as unknown as typeof fetch,
    );

    const firstBody = JSON.parse(
      String(fetchImpl.mock.calls[0]?.[1]?.body),
    ) as { model: string };
    const secondBody = JSON.parse(
      String(fetchImpl.mock.calls[1]?.[1]?.body),
    ) as { model: string };
    expect(firstBody.model).toBe('gpt-5.4-mini');
    expect(secondBody.model).toBe('gpt-5.4-standard');
    expect(result.selectedModelTier).toBe('standard');
    expect(result.selectedModel).toBe('gpt-5.4-standard');
  });
});
