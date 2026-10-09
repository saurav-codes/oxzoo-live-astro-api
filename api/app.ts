// The Hono API behind the static site: /api for the page, /_zoo for the panel.
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { Hono } from 'hono';
import type { Context } from 'hono';
import { compareTag, pageTag } from './build.ts';
import type { BuildInfo } from './build.ts';
import { health, identity, isZooCorsPath, parseOrigins, corsHeaders, preflightHeaders, Prober } from './zoo.ts';
import type { Check, Env, VarSpec } from './zoo.ts';

export const META = { name: 'astro-api', stack: 'Astro static + Hono API' };
const NAME_RE = /^[A-Za-z0-9 _-]{1,32}$/;
const VARS: VarSpec[] = [
  { name: 'ZOO_PANEL_ORIGIN', role: 'plain' },
  { name: 'PUBLIC_BUILD_TAG', role: 'plain' },
];

export interface Options {
  env: Env;
  distDir: string;
  buildInfo: BuildInfo | null;
  startedAt?: Date;
}

async function fetchJSON(url: string, signal: AbortSignal): Promise<Record<string, unknown>> {
  const res = await fetch(url, { signal, redirect: 'manual', headers: { Accept: 'application/json' } });
  if (res.status !== 200) throw new Error(`${new URL(url).pathname} answered ${res.status}`);
  return (await res.json()) as Record<string, unknown>;
}

async function fetchText(url: string, signal: AbortSignal): Promise<string> {
  const res = await fetch(url, { signal, redirect: 'manual' });
  if (res.status !== 200) throw new Error(`${new URL(url).pathname} answered ${res.status}`);
  const text = await res.text();
  return text.slice(0, 256 * 1024);
}

export function createApp(opts: Options) {
  const { env, distDir, buildInfo } = opts;
  const startedAt = opts.startedAt ?? new Date();
  const origins = parseOrigins(env.ZOO_PANEL_ORIGIN);
  const prober = new Prober();
  let served = 0;
  const build = () => {
    const b: { tag?: string; built_at?: string; runtime: string } = { runtime: `node ${process.versions.node}` };
    if (buildInfo?.tag) b.tag = buildInfo.tag;
    if (buildInfo?.built_at) b.built_at = buildInfo.built_at;
    return b;
  };

  const checks: Check[] = [
    {
      id: 'build-tag',
      label: 'Build tag baked by Astro equals runtime PUBLIC_BUILD_TAG',
      env: ['PUBLIC_BUILD_TAG'],
      run: async () => compareTag(buildInfo, env.PUBLIC_BUILD_TAG),
    },
    {
      id: 'static-files',
      label: 'dist/index.html exists and carries the build tag',
      env: [],
      run: async () => {
        const html = await readFile(join(distDir, 'index.html'), 'utf8');
        const tag = pageTag(html);
        if (tag === null) throw new Error('dist/index.html has no zoo-build-tag meta');
        if (tag !== (buildInfo?.tag ?? '')) throw new Error(`index.html tag ${tag} != build-info tag ${buildInfo?.tag}`);
        return `dist/index.html ${html.length} bytes, tag ${tag}`;
      },
    },
    {
      id: 'api-loopback',
      label: 'API answers on its own port (GET /api/hello)',
      env: ['PORT'],
      run: async (signal) => {
        const host = env.HOST || '127.0.0.1';
        const body = await fetchJSON(`http://${host}:${env.PORT}/api/hello?name=probe`, signal);
        if (body.message !== 'hello, probe') throw new Error(`unexpected body ${JSON.stringify(body).slice(0, 100)}`);
        return 'GET /api/hello round trip on loopback';
      },
    },
    {
      // Through Caddy: proves [static] serves the page and [static] api routes /api here.
      id: 'caddy-routing',
      label: 'Public URL serves the static page and routes /api to this app',
      env: ['PUBLIC_URL'],
      timeoutMs: 8000,
      run: async (signal) => {
        const base = env.PUBLIC_URL!.replace(/\/+$/, '');
        const html = await fetchText(`${base}/`, signal);
        const tag = pageTag(html);
        if (tag === null) throw new Error('GET / is not the Astro page (no zoo-build-tag meta)');
        const info = await fetchJSON(`${base}/api/info`, signal);
        if (info.name !== META.name) throw new Error(`GET /api/info answered name ${JSON.stringify(info.name)}`);
        return `GET / static page (tag ${tag}), GET /api/info from ${META.name}`;
      },
    },
  ];

  const app = new Hono();

  app.use('/_zoo/*', async (c, next) => {
    const origin = c.req.header('Origin');
    if (!isZooCorsPath(c.req.path)) return next();
    if (c.req.method === 'OPTIONS') return c.body(null, 204, preflightHeaders(origin, origins));
    await next();
    for (const [k, v] of Object.entries(corsHeaders(origin, origins))) c.header(k, v);
  });

  const noStore = (c: Context) => c.header('Cache-Control', 'no-store');

  app.get('/_zoo/health', (c) => {
    noStore(c);
    return c.json(health(META, env, startedAt, build()));
  });

  app.get('/_zoo/probe', async (c) => {
    noStore(c);
    try {
      const { status, body } = await prober.probe(META, env, checks, VARS);
      return c.json(body, status as 200 | 429);
    } catch (err) {
      console.error('probe failed:', (err as Error).message);
      return c.json({ error: 'probe failed' }, 500);
    }
  });

  app.get('/api/info', (c) => {
    served += 1;
    noStore(c);
    return c.json({
      ...identity(META, env),
      built_tag: buildInfo?.tag ?? null,
      built_at: buildInfo?.built_at ?? null,
      runtime_tag: env.PUBLIC_BUILD_TAG || null,
      runtime: `node ${process.versions.node}`,
      uptime_s: Math.floor((Date.now() - startedAt.getTime()) / 1000),
      served,
    });
  });

  app.get('/api/hello', (c) => {
    const name = (c.req.query('name') ?? '').trim();
    if (!NAME_RE.test(name)) return c.json({ error: 'name must match ^[A-Za-z0-9 _-]{1,32}$' }, 400);
    return c.json({ message: `hello, ${name}`, from: `${META.name}@${identity(META, env).server}` });
  });

  app.notFound((c) => c.json({ error: 'not found' }, 404));
  app.onError((err, c) => {
    console.error('request failed:', err.message);
    return c.json({ error: 'internal error' }, 500);
  });

  return app;
}
