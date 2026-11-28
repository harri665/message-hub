// The daily Neuron budget. Cloudflare gives 10,000 free Neurons per day, reset at 00:00 UTC, and refuses requests once
// they are used up. The hub keeps its own count (from the token usage each response reports) and spends it in order:
//   interactive  answers, reply suggestions, search queries: up to the whole allowance, on the cheaper fallback model
//                once FALLBACK_SHARE of it is gone, so a busy day gives weaker answers instead of errors
//   new          photos and messages from the last few days: stops a little earlier, leaving room for interactive use
//   backlog      old photos and old messages: only while most of the day's allowance is still free
import { config } from '../config.js';
import { q, q1 } from '../db.js';

export type Priority = 'interactive' | 'new' | 'backlog';

/** Photos and messages sent within this many days count as new; older ones are backlog. */
export const NEW_DAYS = 3;

const FALLBACK_SHARE = 0.8;
const NEW_STOP_SHARE = 0.9;
const BACKLOG_STOP_SHARE = 0.7;

/** Neurons per million tokens, input and output, from Cloudflare's pricing page (2026-11-18). */
export const PRICES: Record<string, { input: number; output: number }> = {
  '@cf/moonshotai/kimi-k2.5': { input: 54545, output: 272727 },
  '@cf/nvidia/nemotron-3-120b-a12b': { input: 45455, output: 136364 },
  '@cf/openai/gpt-oss-120b': { input: 31818, output: 68182 },
  '@cf/openai/gpt-oss-20b': { input: 18182, output: 27273 },
  '@cf/meta/llama-3.3-70b-instruct-fp8-fast': { input: 26668, output: 204805 },
  '@cf/meta/llama-4-scout-17b-16e-instruct': { input: 24545, output: 77273 },
  '@cf/mistralai/mistral-small-3.1-24b-instruct': { input: 31876, output: 50488 },
  '@cf/qwen/qwen3.8-27b': { input: 40909, output: 290909 },
  '@cf/google/gemma-4-26b-a4b-it': { input: 9091, output: 27273 },
  '@cf/qwen/qwen3-30b-a3b-fp8': { input: 4625, output: 30475 },
  '@cf/zai-org/glm-4.7-flash': { input: 5500, output: 36400 },
  '@cf/baai/bge-m3': { input: 1075, output: 0 },
};
// Unknown models are counted at the price of the most expensive one above, so an override can't overspend quietly.
const UNKNOWN_PRICE = { input: 60000, output: 300000 };

export function neuronsFor(model: string, inputTokens: number, outputTokens: number) {
  const p = PRICES[model] ?? UNKNOWN_PRICE;
  return (inputTokens * p.input + outputTokens * p.output) / 1e6;
}

/** The UTC day the allowance belongs to, as YYYY-MM-DD. */
export const utcDay = (d = new Date()) => d.toISOString().slice(0, 10);

/** When today's allowance resets (the next 00:00 UTC). */
export function resetsAt(d = new Date()) {
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() + 1));
}

export interface BudgetDecision { ok: boolean; fallback: boolean }

/** Whether work of this priority may run with `used` of `limit` Neurons spent, and whether it should use the fallback model. */
export function decide(priority: Priority, used: number, limit: number): BudgetDecision {
  const share = used / limit;
  const stop = priority === 'interactive' ? 1 : priority === 'new' ? NEW_STOP_SHARE : BACKLOG_STOP_SHARE;
  return { ok: share < stop, fallback: share >= FALLBACK_SHARE };
}

// The count is kept in memory (loaded once per day) and written through to ai_usage.
let day = '';
let used = 0;
let exhausted = false;
let loading: Promise<void> | null = null;

async function load() {
  const today = utcDay();
  if (day === today) return;
  loading ??= (async () => {
    const row = await q1<{ n: number | null }>('select sum(neurons) as n from ai_usage where day = $1', [today]);
    day = today;
    used = Number(row?.n ?? 0);
    exhausted = false;
  })().finally(() => { loading = null; });
  await loading;
}

/** Neurons this hub has spent today (its own count). */
export async function hubUsedToday() {
  await load();
  return used;
}

/**
 * Neurons spent today by the whole Cloudflare account, which every hub using the same token shares (for example one
 * hub per person). Cloudflare's count is read every couple of minutes and lags a little, so this hub's own spending
 * since the last read is added on top; it is never less than this hub's own count. The budget uses this number, so
 * all hubs on one account stay inside the one free allowance together.
 */
export async function usedToday() {
  await load();
  refreshAccountUsage().catch(() => {});
  let total = used;
  if (account.day === day && account.used !== null) total = Math.max(used, account.used + (used - account.hubUsedAtCheck));
  return exhausted ? Math.max(total, config.ai.dailyNeurons) : total;
}

export async function budget(priority: Priority): Promise<BudgetDecision> {
  return decide(priority, await usedToday(), config.ai.dailyNeurons);
}

export async function record(feature: string, model: string, inputTokens: number, outputTokens: number) {
  await load();
  const n = neuronsFor(model, inputTokens, outputTokens);
  used += n;
  await q(
    `insert into ai_usage (day, feature, model, requests, input_tokens, output_tokens, neurons) values ($1, $2, $3, 1, $4, $5, $6)
     on conflict (day, feature, model) do update set requests = ai_usage.requests + 1,
       input_tokens = ai_usage.input_tokens + excluded.input_tokens, output_tokens = ai_usage.output_tokens + excluded.output_tokens,
       neurons = ai_usage.neurons + excluded.neurons`,
    [day, feature, model, inputTokens, outputTokens, n],
  );
  return n;
}

/** Cloudflare said the day's allowance is gone (other use on the account counts too): stop until the reset. */
export async function markExhausted() {
  await load();
  exhausted = true;
}

// ---------- the whole account's use, from Cloudflare's GraphQL Analytics API ----------

const ACCOUNT_TTL_MS = 2 * 60_000;
const account = { day: '', used: null as number | null, hubUsedAtCheck: 0, checkedAt: 0, error: null as string | null };
let accountLoading: Promise<void> | null = null;

/** Reads today's Workers AI Neurons for the account (dataset aiInferenceAdaptiveGroups, UTC day). */
export async function fetchAccountNeurons(day: string): Promise<number> {
  const res = await fetch('https://api.cloudflare.com/client/v4/graphql', {
    method: 'POST',
    headers: { authorization: `Bearer ${config.ai.token}`, 'content-type': 'application/json' },
    body: JSON.stringify({
      query: `query($acc: string!, $day: Date!) { viewer { accounts(filter: { accountTag: $acc }) {
        aiInferenceAdaptiveGroups(limit: 1, filter: { date: $day }) { sum { totalNeurons } } } } }`,
      variables: { acc: config.ai.accountId, day },
    }),
    signal: AbortSignal.timeout(15_000),
  });
  const data: any = await res.json().catch(() => ({}));
  const err = data?.errors?.[0];
  if (err) {
    throw new Error(err.extensions?.code === 'authz'
      ? 'Add the "Account Analytics: Read" permission to the Cloudflare API token to see the whole account.'
      : `Cloudflare analytics: ${err.message ?? 'error'}`);
  }
  if (!res.ok) throw new Error(`Cloudflare analytics: HTTP ${res.status}`);
  const groups = data?.data?.viewer?.accounts?.[0]?.aiInferenceAdaptiveGroups ?? [];
  return Number(groups[0]?.sum?.totalNeurons ?? 0);
}

/** Refreshes the account's count when it is older than a couple of minutes (or always, with force). */
export function refreshAccountUsage(force = false): Promise<void> {
  const today = utcDay();
  if (!force && account.day === today && Date.now() - account.checkedAt < ACCOUNT_TTL_MS) return Promise.resolve();
  accountLoading ??= (async () => {
    await load();
    const hubUsed = used;
    try {
      const n = await fetchAccountNeurons(today);
      Object.assign(account, { day: today, used: n, hubUsedAtCheck: hubUsed, error: null });
    } catch (e) {
      Object.assign(account, { day: today, used: null, hubUsedAtCheck: hubUsed, error: e instanceof Error ? e.message : String(e) });
    } finally {
      account.checkedAt = Date.now();
    }
  })().finally(() => { accountLoading = null; });
  return accountLoading;
}

/** The account's count for the Settings page: Cloudflare's number (null when it can't be read) and why not. */
export async function accountUsage() {
  await refreshAccountUsage();
  return { used: account.day === utcDay() ? account.used : null, checkedAt: account.checkedAt ? new Date(account.checkedAt).toISOString() : null, error: account.error };
}

export async function usageToday() {
  await load();
  return q<{ feature: string; model: string; requests: number; neurons: number }>(
    'select feature, model, requests, neurons from ai_usage where day = $1 order by neurons desc',
    [day],
  );
}
