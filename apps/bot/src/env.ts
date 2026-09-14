import { config } from 'dotenv';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

// Same trick as the API: npm workspaces set cwd to THIS package's directory,
// not the repo root where our single shared .env lives, so resolve the path
// relative to this file instead of relying on cwd.
const here = path.dirname(fileURLToPath(import.meta.url));
config({ path: path.resolve(here, '../../../.env') });

function required(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`Missing required environment variable: ${name}`);
  return value;
}

export const env = {
  botToken: required('TELEGRAM_BOT_TOKEN'),
  /** Must match the API's BOT_SERVICE_SECRET exactly — it's a shared secret. */
  botServiceSecret: required('BOT_SERVICE_SECRET'),
  apiUrl: process.env.API_URL ?? 'http://localhost:4000',
} as const;
