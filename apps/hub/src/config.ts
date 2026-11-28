import path from 'node:path';

const capitalize = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

function required(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`Missing required environment variable ${name}`);
  return v;
}

export const config = {
  port: Number(process.env.PORT ?? 8080),
  databaseUrl: required('DATABASE_URL'),
  /** Optional: if unset, the password is created in the browser on first visit and stored hashed. */
  appPassword: process.env.APP_PASSWORD ?? '',
  secureCookies: process.env.SECURE_COOKIES === 'true',
  sessionDays: Number(process.env.SESSION_DAYS ?? 90),
  attachmentsDir: path.resolve(process.env.ATTACHMENTS_DIR ?? './data/attachments'),
  webDir: path.resolve(process.env.WEB_DIR ?? '../web/dist'),
  migrationsDir: path.resolve(process.env.MIGRATIONS_DIR ?? './migrations'),
  defaultCountryCode: process.env.DEFAULT_COUNTRY_CODE ?? '1',
  /** IANA time zone used when the MCP server shows message times, e.g. America/Denver. */
  timeZone: process.env.TIME_ZONE || 'UTC',
  /** Names that mean the user in search (`from: harrison`), comma separated, e.g. SELF_NAMES=harrison,harri665. `me` always works. */
  selfNames: (process.env.SELF_NAMES ?? '').split(',').map((x) => x.trim().toLowerCase()).filter(Boolean),
  bluebubbles: {
    url: (process.env.BLUEBUBBLES_URL ?? '').replace(/\/+$/, ''),
    password: process.env.BLUEBUBBLES_PASSWORD ?? '',
  },
  whatsapp: {
    url: (process.env.WA_CONNECTOR_URL ?? '').replace(/\/+$/, ''),
    secret: process.env.INTERNAL_SECRET ?? '',
  },
  /** Cloudflare Workers AI (see ai/). Off unless both the account id and the token are set. */
  ai: {
    accountId: process.env.CF_ACCOUNT_ID ?? '',
    token: process.env.CF_API_TOKEN ?? '',
    /** Neurons the hub may spend per UTC day. Cloudflare's free allowance is 10,000. */
    dailyNeurons: Number(process.env.AI_DAILY_NEURONS) || 10_000,
    /** Whose hub this is, shown next to its Neuron count: HUB_OWNER, else the first SELF_NAMES entry. */
    owner: process.env.HUB_OWNER?.trim() || capitalize((process.env.SELF_NAMES ?? '').split(',')[0]?.trim() ?? ''),
    /** Overrides the API base (for AI Gateway); defaults to the Workers AI REST API for the account. */
    baseUrl: (process.env.AI_BASE_URL ?? '').replace(/\/+$/, ''),
    models: {
      answer: process.env.AI_MODEL_ANSWER || '@cf/meta/llama-3.3-70b-instruct-fp8-fast',
      reply: process.env.AI_MODEL_REPLY || '@cf/openai/gpt-oss-120b',
      vision: process.env.AI_MODEL_VISION || '@cf/google/gemma-4-26b-a4b-it',
      fallback: process.env.AI_MODEL_FALLBACK || '@cf/google/gemma-4-26b-a4b-it',
      embed: '@cf/baai/bge-m3',
    },
  },
};

export const aiEnabled = () => !!(config.ai.accountId && config.ai.token);
