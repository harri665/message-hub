// Cloudflare Workers AI over its OpenAI-compatible REST endpoints (chat completions and embeddings), called from the hub
// with the account id and an API token. Every call is checked against the daily budget first and counted after.
// Calls take a chain of models: the first that answers wins. A model that is paid-only, missing or busy is skipped
// (and remembered for a while), so an unavailable default degrades to the next model instead of an error.
import { aiEnabled, config } from '../config.js';
import { budget, markExhausted, record, resetsAt, type Priority } from './usage.js';

export class AiError extends Error {
  constructor(message: string, public statusCode: number, public kind: 'off' | 'budget' | 'exhausted' | 'model' | 'busy' | 'failed') {
    super(message);
  }
}

const resetTime = () =>
  resetsAt().toLocaleTimeString('en-US', { timeZone: config.timeZone, hour: 'numeric', minute: '2-digit' });

export const budgetError = () =>
  new AiError(`Today's free AI allowance is used up. It resets at ${resetTime()}.`, 429, 'budget');

/** Extra request fields that keep each model's hidden reasoning short (reasoning is billed as output). */
const EXTRAS: Record<string, Record<string, unknown>> = {
  '@cf/openai/gpt-oss-120b': { reasoning_effort: 'low' },
  '@cf/openai/gpt-oss-20b': { reasoning_effort: 'low' },
  '@cf/moonshotai/kimi-k2.5': { chat_template_kwargs: { thinking: false } },
  '@cf/google/gemma-4-26b-a4b-it': { chat_template_kwargs: { enable_thinking: false } },
  '@cf/qwen/qwen3-30b-a3b-fp8': { chat_template_kwargs: { enable_thinking: false } },
};

/** Models that recently failed in a way that will repeat (paid-only, unknown): skipped until the time stored here. */
const unavailable = new Map<string, number>();

const base = () => config.ai.baseUrl || `https://api.cloudflare.com/client/v4/accounts/${encodeURIComponent(config.ai.accountId)}/ai/v1`;

/** Reads Cloudflare's error out of either response envelope ({errors: [...]} or OpenAI's {error: {...}}). */
function errorInfo(data: any): { code: number | null; message: string } {
  const e = Array.isArray(data?.errors) ? data.errors[0] : data?.error;
  if (!e) return { code: null, message: '' };
  if (typeof e === 'string') return { code: null, message: e };
  const code = Number(e.code ?? e.internal_code);
  return { code: Number.isFinite(code) ? code : null, message: String(e.message ?? '') };
}

async function post(path: string, body: unknown, timeoutMs: number) {
  let res: Response;
  try {
    // Paths starting with /run/ go to the native endpoint (/ai/run/<model>) next to the OpenAI-compatible /ai/v1.
    const url = path.startsWith('/run/') ? `${base().replace(/\/v1$/, '')}${path}` : `${base()}${path}`;
    res = await fetch(url, {
      method: 'POST',
      headers: { authorization: `Bearer ${config.ai.token}`, 'content-type': 'application/json' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (e) {
    throw new AiError(`Couldn't reach Cloudflare: ${e instanceof Error ? e.message : e}`, 502, 'busy');
  }
  const data: any = await res.json().catch(() => ({}));
  if (res.ok && data?.success !== false) return data;
  const { code, message } = errorInfo(data);
  const text = `${message || res.statusText} (${res.status}${code ? `, ${code}` : ''})`;
  if (code === 3036 || /daily free allocation/i.test(message)) {
    await markExhausted();
    throw budgetError();
  }
  if (res.status === 401 || code === 10000) throw new AiError(`Cloudflare refused the API token: ${text}`, 502, 'failed');
  if (code === 5035 || res.status === 403 || res.status === 404 || /model.*(not found|no such|unknown)|no route/i.test(message)) {
    throw new AiError(`Model unavailable: ${text}`, 502, 'model');
  }
  if (res.status === 429 || code === 3040 || res.status >= 500) throw new AiError(`Workers AI is busy: ${text}`, 503, 'busy');
  throw Object.assign(new AiError(`Workers AI error: ${text}`, 502, 'failed'), { badRequest: res.status === 400 });
}

/** Text of a chat completion, with any <think> block removed. Accepts the OpenAI shape and Workers AI's native one. */
export function completionText(data: any): string {
  const msg = data?.choices?.[0]?.message ?? data?.result?.choices?.[0]?.message;
  let content: unknown = msg?.content ?? data?.result?.response ?? data?.response;
  if (Array.isArray(content)) content = content.map((p: any) => (typeof p === 'string' ? p : p?.text ?? '')).join('');
  return String(content ?? '').replace(/<think>[\s\S]*?(<\/think>|$)/g, '').trim();
}

const estimateTokens = (s: string) => Math.ceil(s.length / 4);

export type ChatContent = string | ({ type: 'text'; text: string } | { type: 'image_url'; image_url: { url: string } })[];
export interface ChatMessage { role: 'system' | 'user' | 'assistant'; content: ChatContent }

export interface ChatOptions {
  feature: string;
  priority: Priority;
  /** Models to try in order. When the day's budget is mostly spent, only the last (the fallback) is used. */
  models: string[];
  messages: ChatMessage[];
  maxTokens: number;
  temperature?: number;
  json?: boolean;
  timeoutMs?: number;
}

export async function chat(o: ChatOptions): Promise<{ text: string; model: string }> {
  if (!aiEnabled()) throw new AiError('AI features are off. Set CF_ACCOUNT_ID and CF_API_TOKEN to turn them on.', 503, 'off');
  const b = await budget(o.priority);
  if (!b.ok) throw budgetError();
  let models = [...new Set(o.models)];
  if (b.fallback) models = models.slice(-1);
  const now = Date.now();
  const usable = models.filter((m) => (unavailable.get(m) ?? 0) < now);
  let last: unknown = null;
  for (const model of usable.length ? usable : models.slice(-1)) {
    const body = {
      model, messages: o.messages, max_tokens: o.maxTokens, temperature: o.temperature ?? 0.3,
      ...(o.json ? { response_format: { type: 'json_object' } } : {}),
    };
    try {
      let data: any;
      try {
        data = await post('/chat/completions', { ...body, ...EXTRAS[model] }, o.timeoutMs ?? 90_000);
      } catch (e: any) {
        // A model that doesn't accept the reasoning switch (or JSON mode) gets the plain request instead.
        if (!e?.badRequest || (!EXTRAS[model] && !o.json)) throw e;
        const { response_format: _rf, ...plain } = body;
        data = await post('/chat/completions', plain, o.timeoutMs ?? 90_000);
      }
      const text = completionText(data);
      const usage = data?.usage ?? data?.result?.usage ?? {};
      // When a response carries no usage, count ~4 characters per token and ~600 tokens per image.
      const promptTokens = o.messages.reduce((n, m) => n + (typeof m.content === 'string'
        ? estimateTokens(m.content)
        : m.content.reduce((k, p) => k + (p.type === 'text' ? estimateTokens(p.text) : 600), 0)), 0);
      await record(o.feature, model, Number(usage.prompt_tokens) || promptTokens, Number(usage.completion_tokens) || estimateTokens(text));
      if (!text) throw new AiError(`${model} returned an empty answer`, 502, 'failed');
      return { text, model };
    } catch (e) {
      last = e;
      if (!(e instanceof AiError) || e.kind === 'budget' || e.kind === 'off') throw e;
      if (e.kind === 'model') unavailable.set(model, Date.now() + 6 * 3600_000);
      if (e.kind === 'busy') unavailable.set(model, Date.now() + 60_000);
    }
  }
  throw last instanceof Error ? last : new AiError('No AI model could answer', 502, 'failed');
}

export const EMBED_DIMS = 1024;

/** One embedding per text (bge-m3, 1024 numbers each), in order. */
export async function embed(texts: string[], feature: string, priority: Priority): Promise<number[][]> {
  if (!aiEnabled()) throw new AiError('AI features are off. Set CF_ACCOUNT_ID and CF_API_TOKEN to turn them on.', 503, 'off');
  if (!texts.length) return [];
  if (!(await budget(priority)).ok) throw budgetError();
  const model = config.ai.models.embed;
  let data: any;
  try {
    data = await post('/embeddings', { model, input: texts }, 60_000);
  } catch (e) {
    // The OpenAI-compatible route isn't documented for every embedding model; the native one takes {text: [...]}.
    if (!(e instanceof AiError) || (e.kind !== 'model' && e.kind !== 'failed')) throw e;
    data = await post(`/run/${model}`, { text: texts }, 60_000);
  }
  const raw: unknown[] = Array.isArray(data?.data) ? data.data : Array.isArray(data?.result?.data) ? data.result.data : [];
  const vectors = raw.map((d: any) => (Array.isArray(d) ? d : d?.embedding)) as number[][];
  if (vectors.length !== texts.length || vectors.some((v) => !Array.isArray(v) || v.length !== EMBED_DIMS)) {
    throw new AiError(`Unexpected embedding response from ${model}`, 502, 'failed');
  }
  const tokens = Number(data?.usage?.prompt_tokens ?? data?.usage?.total_tokens) || texts.reduce((n, t) => n + estimateTokens(t), 0);
  await record(feature, model, tokens, 0);
  return vectors;
}

/** pgvector's text form of a vector. */
export const vectorLiteral = (v: number[]) => `[${v.map((x) => (Number.isFinite(x) ? x : 0)).join(',')}]`;
