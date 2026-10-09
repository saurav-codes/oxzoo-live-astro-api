import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { serve } from '@hono/node-server';
import type { AddressInfo } from 'node:net';
import { createApp } from '../api/app.ts';
import { compareTag, pageTag, parseBuildInfo, validTag } from '../api/build.ts';
import { fp, serverLabel } from '../api/zoo.ts';

const PANEL = 'https://zoo-control.s1.zoo.sorv.dev';
const BUILD = { tag: 'zoo-1', built_at: '2026-10-09T09:58:00Z' };

function dist(tag = 'zoo-1'): string {
  const dir = mkdtempSync(join(tmpdir(), 'astro-api-test-'));
  writeFileSync(join(dir, 'index.html'), `<html><head><meta name="zoo-build-tag" content="${tag}"></head></html>`);
  return dir;
}

function app(env: Record<string, string> = {}, buildInfo: typeof BUILD | null = BUILD) {
  return createApp({
    env: { ZOO_PANEL_ORIGIN: `${PANEL},http://localhost:5173`, PUBLIC_BUILD_TAG: 'zoo-1', PUBLIC_HOST: 'astro-api.s4.zoo.sorv.dev', OX_RELEASE: '3f9c2a1b4d5e6f70', OX_ENV: 'production', ...env },
    distDir: dist(),
    buildInfo,
  });
}

test('health has the contract shape', async () => {
  const res = await app().request('/_zoo/health');
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.name, 'astro-api');
  assert.equal(body.server, 's4');
  assert.equal(body.release, '3f9c2a1b4d5e');
  assert.equal(body.env, 'production');
  assert.match(body.started_at, /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ$/);
  assert.equal(typeof body.uptime_s, 'number');
  assert.equal(body.build.tag, 'zoo-1');
  assert.equal(body.build.built_at, BUILD.built_at);
  assert.match(body.build.runtime, /^node \d+/);
});

test('health without a build omits tag and built_at, defaults to local', async () => {
  const a = createApp({ env: {}, distDir: dist(), buildInfo: null });
  const body = await (await a.request('/_zoo/health')).json();
  assert.equal(body.server, 'local');
  assert.equal(body.release, 'unknown');
  assert.equal(body.env, 'local');
  assert.deepEqual(Object.keys(body.build), ['runtime']);
});

test('CORS echoes a listed origin only, never *', async () => {
  const a = app();
  const ok = await a.request('/_zoo/health', { headers: { Origin: PANEL } });
  assert.equal(ok.headers.get('access-control-allow-origin'), PANEL);
  assert.equal(ok.headers.get('vary'), 'Origin');
  assert.equal(ok.headers.get('access-control-allow-credentials'), null);
  const bad = await a.request('/_zoo/health', { headers: { Origin: 'https://evil.example' } });
  assert.equal(bad.headers.get('access-control-allow-origin'), null);
  const none = await a.request('/api/info', { headers: { Origin: PANEL } });
  assert.equal(none.headers.get('access-control-allow-origin'), null);
});

test('CORS preflight is 204 with the methods, headers and max age', async () => {
  const a = app();
  const res = await a.request('/_zoo/probe', { method: 'OPTIONS', headers: { Origin: 'http://localhost:5173' } });
  assert.equal(res.status, 204);
  assert.equal(res.headers.get('access-control-allow-origin'), 'http://localhost:5173');
  assert.equal(res.headers.get('access-control-allow-methods'), 'GET, POST, OPTIONS');
  assert.equal(res.headers.get('access-control-allow-headers'), 'Content-Type');
  assert.equal(res.headers.get('access-control-max-age'), '600');
  const bad = await a.request('/_zoo/probe', { method: 'OPTIONS', headers: { Origin: 'https://evil.example' } });
  assert.equal(bad.status, 204);
  assert.equal(bad.headers.get('access-control-allow-origin'), null);
});

test('build tag comparison', () => {
  assert.match(compareTag(BUILD, 'zoo-1'), /agree on zoo-1/);
  assert.throws(() => compareTag(BUILD, 'zoo-2'), /built with tag zoo-1, running with zoo-2: stale build/);
  assert.throws(() => compareTag(null, 'zoo-1'), /not built/);
  assert.throws(() => compareTag({ tag: null, built_at: BUILD.built_at }, 'zoo-1'), /not set at build time/);
  assert.equal(validTag('zoo-1.2_a'), true);
  assert.equal(validTag('zoo 1'), false);
  assert.equal(validTag('a'.repeat(65)), false);
  assert.throws(() => parseBuildInfo('{"tag":"<x>","built_at":"2026-10-09T00:00:00Z"}'), /bad tag/);
  assert.deepEqual(parseBuildInfo(JSON.stringify(BUILD)), BUILD);
  assert.equal(pageTag('<meta name="zoo-build-tag" content="zoo-9">'), 'zoo-9');
  assert.equal(pageTag('<p>no tag</p>'), null);
});

test('helpers match DESIGN.md', () => {
  assert.equal(fp('zoo-test-key-0123456789abcdef'), '915a');
  assert.equal(serverLabel('catalog-api.s2.zoo.sorv.dev'), 's2');
  assert.equal(serverLabel('localhost'), 'local');
});

test('hello validates its input', async () => {
  const a = app();
  assert.equal((await a.request('/api/hello?name=../etc')).status, 400);
  assert.equal((await a.request(`/api/hello?name=${'a'.repeat(33)}`)).status, 400);
  const res = await a.request('/api/hello?name=zoo');
  assert.deepEqual(await res.json(), { message: 'hello, zoo', from: 'astro-api@s4' });
});

// A stand-in for Caddy: the page from dist, /api and /_zoo to the app.
async function listen(fetch: (req: Request) => Response | Promise<Response>) {
  const server = serve({ fetch, hostname: '127.0.0.1', port: 0 });
  await new Promise((r) => server.once('listening', r));
  return { server, port: (server.address() as AddressInfo).port };
}

test('probe passes every check end to end, and reports a stale build', async () => {
  const env: Record<string, string> = { ZOO_PANEL_ORIGIN: PANEL, PUBLIC_BUILD_TAG: 'zoo-1', HOST: '127.0.0.1' };
  const a = createApp({ env, distDir: dist(), buildInfo: BUILD });
  const api = await listen(a.fetch);
  env.PORT = String(api.port);
  const front = await listen((req) => {
    const path = new URL(req.url).pathname;
    if (path.startsWith('/api/') || path.startsWith('/_zoo/')) return a.fetch(req);
    return new Response('<meta name="zoo-build-tag" content="zoo-1">', { headers: { 'Content-Type': 'text/html' } });
  });
  env.PUBLIC_URL = `http://127.0.0.1:${front.port}`;
  try {
    const body = await (await a.request('/_zoo/probe')).json();
    assert.equal(body.ok, true, JSON.stringify(body.checks));
    assert.deepEqual(body.checks.map((c: { id: string }) => c.id), ['build-tag', 'static-files', 'api-loopback', 'caddy-routing']);
    assert.deepEqual(body.vars, [
      { name: 'ZOO_PANEL_ORIGIN', role: 'plain', value: PANEL },
      { name: 'PUBLIC_BUILD_TAG', role: 'plain', value: 'zoo-1' },
    ]);
    env.PUBLIC_BUILD_TAG = 'zoo-2';
    const stale = await (await a.request('/_zoo/probe')).json();
    assert.equal(stale.ok, false);
    assert.match(stale.checks[0].error, /stale build/);
  } finally {
    front.server.close();
    api.server.close();
  }
});

test('probe names a missing variable', async () => {
  const a = createApp({ env: {}, distDir: dist(), buildInfo: BUILD });
  const body = await (await a.request('/_zoo/probe')).json();
  assert.equal(body.ok, false);
  const tag = body.checks.find((c: { id: string }) => c.id === 'build-tag');
  assert.equal(tag.error, 'PUBLIC_BUILD_TAG is not set');
  assert.deepEqual(body.vars[1], { name: 'PUBLIC_BUILD_TAG', role: 'plain', missing: true });
});
