import path from 'node:path';

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
};
