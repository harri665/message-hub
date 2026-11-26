import path from 'node:path';

function required(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`Missing required environment variable ${name}`);
  return v;
}

export const config = {
  port: Number(process.env.PORT ?? 8080),
  databaseUrl: required('DATABASE_URL'),
  appPassword: required('APP_PASSWORD'),
  secureCookies: process.env.SECURE_COOKIES === 'true',
  sessionDays: Number(process.env.SESSION_DAYS ?? 90),
  attachmentsDir: path.resolve(process.env.ATTACHMENTS_DIR ?? './data/attachments'),
  webDir: path.resolve(process.env.WEB_DIR ?? '../web/dist'),
  migrationsDir: path.resolve(process.env.MIGRATIONS_DIR ?? './migrations'),
  defaultCountryCode: process.env.DEFAULT_COUNTRY_CODE ?? '1',
  bluebubbles: {
    url: (process.env.BLUEBUBBLES_URL ?? '').replace(/\/+$/, ''),
    password: process.env.BLUEBUBBLES_PASSWORD ?? '',
  },
  whatsapp: {
    url: (process.env.WA_CONNECTOR_URL ?? '').replace(/\/+$/, ''),
    secret: process.env.INTERNAL_SECRET ?? '',
  },
};
