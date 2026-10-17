import path from 'node:path';
import type { NextConfig } from 'next';

const nextConfig: NextConfig = {
  // Emits .next/standalone: a minimal server.js plus ONLY the node_modules
  // files the app actually imports. The production image copies that instead
  // of every dependency in the repo — a fraction of the size.
  output: 'standalone',

  // This app lives inside a monorepo and imports `@coach/shared` from outside
  // its own folder. Tracing from the repo root is what lets the standalone
  // build include that package; traced from apps/web alone, it would be
  // missing at runtime.
  //
  // process.cwd() rather than import.meta.dirname or __dirname: Next may load
  // this file as either CommonJS or ESM, and each has only one of those two.
  // The working directory is reliable — npm workspaces always run the build
  // from apps/web.
  outputFileTracingRoot: path.join(process.cwd(), '../../'),
};

export default nextConfig;
