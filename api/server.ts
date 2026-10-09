import { fileURLToPath } from 'node:url';
import { serve } from '@hono/node-server';
import { createApp } from './app.ts';
import { readBuildInfo } from './build.ts';

const distDir = fileURLToPath(new URL('../dist/', import.meta.url));
const buildInfo = readBuildInfo(distDir);
const app = createApp({ env: process.env, distDir, buildInfo });
const hostname = process.env.HOST || '127.0.0.1';
const port = Number(process.env.PORT || 3000);

const server = serve({ fetch: app.fetch, hostname, port }, () => {
  console.log(`astro-api listening on ${hostname}:${port}, build tag ${buildInfo?.tag ?? '(none)'}`);
});

for (const sig of ['SIGTERM', 'SIGINT'] as const) {
  process.on(sig, () => server.close(() => process.exit(0)));
}
