import path from 'node:path';
import { config } from 'dotenv';
import { defineConfig } from 'drizzle-kit';

// drizzle-kit runs this file itself, outside the app, so it doesn't go
// through lib/env.ts. The npm scripts run with apps/api as the working
// directory, and the shared .env lives two levels up at the repo root.
config({ path: path.resolve(process.cwd(), '../../.env') });

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) throw new Error('Missing required environment variable: DATABASE_URL');

export default defineConfig({
  dialect: 'postgresql',
  // The TypeScript description of every table.
  schema: './src/db/schema.ts',
  // Generated .sql migration files land here and are committed to git, so
  // every database (yours, a teammate's, production) is built by the same
  // steps in the same order.
  out: './drizzle',
  dbCredentials: { url: databaseUrl },
  // Refuse to guess on ambiguous changes (a rename vs. a drop + add) and ask.
  strict: true,
  verbose: true,
});
