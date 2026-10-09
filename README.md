# astro-api

> **Role in the zoo:** project `astro-api` of [oxzoo-live](https://github.com/saurav-codes/oxzoo-live-control/blob/main/zoo/README.md#projects), deployed with ox on server s4 at https://astro-api.s4.zoo.sorv.dev. The contract it follows is [DESIGN.md](https://github.com/saurav-codes/oxzoo-live-control/blob/main/zoo/DESIGN.md).

Server s4, `https://astro-api.s4.zoo.sorv.dev`. Astro 7 static site plus a small Hono API
(Node 24, `@hono/node-server`) behind the same domain. Proof level P2.

## What it proves

- `[static]` with `[app]`: Caddy serves the Astro build from `dist/` and routes only the
  `[static] api` prefixes (`/api`, `/_zoo`) to the app process. In the Caddy renderer
  (`vpsctl/internal/host/caddy.go`) each prefix matches the path exactly or `prefix/*`, so
  `/_zoo/health` goes to the app and a path like `/_zoox` does not.
- A build-time variable: `PUBLIC_BUILD_TAG` is baked into the page (`<meta name="zoo-build-tag">`)
  and into `dist/build-info.json` by `scripts/build-info.ts` before `astro build`. The running
  API compares it with the `PUBLIC_BUILD_TAG` it runs with. ox gives the build and the run the
  same variables and redeploys on save, so a mismatch means a stale build.

## Endpoints

| Path | What |
|------|------|
| `/` | Static page; it fetches `/api/info` and shows whether page and API agree on the tag, plus a greet form |
| `GET /api/info` | Identity, baked tag and build time, runtime tag, runtime, uptime, request counter |
| `GET /api/hello?name=` | Greeting; `name` must match `^[A-Za-z0-9 _-]{1,32}$` (400 otherwise) |
| `GET /_zoo/health` | DESIGN.md health; `build.tag` and `build.built_at` come from `dist/build-info.json` |
| `GET /_zoo/probe` | DESIGN.md probe, checks below |

Probe checks:

| id | Real operation | env |
|----|----------------|-----|
| `build-tag` | baked tag in `dist/build-info.json` equals runtime `PUBLIC_BUILD_TAG` | `PUBLIC_BUILD_TAG` |
| `static-files` | reads `dist/index.html`, its meta tag equals the baked tag | none |
| `api-loopback` | `GET http://$HOST:$PORT/api/hello?name=probe`, compares the body | `PORT` |
| `caddy-routing` | `GET $PUBLIC_URL/` must be the Astro page, `GET $PUBLIC_URL/api/info` must answer `name: astro-api` (8 s) | `PUBLIC_URL` |

`vars`: `ZOO_PANEL_ORIGIN` (plain), `PUBLIC_BUILD_TAG` (plain).

## ox features exercised

`[static] dir` + `[static] api` with `[app]`, `[app] health`, start, install and build
detected from `package.json` and `package-lock.json`, node 24 from `engines`, build-time
variables. Zero-config detection alone gives an app with no static site (every path to the
app), so `ox.toml` declares `[static]`.

## Variables

- Provided by ox: `PORT`, `HOST`, `OX_ENV`, `OX_RELEASE`, `PUBLIC_URL`, `PUBLIC_HOST`.
- Yours (plain, see `.env.example`): `ZOO_PANEL_ORIGIN`, `PUBLIC_BUILD_TAG` (build time and run time).
- No secrets, no services.

## Run and test

```sh
npm ci
PUBLIC_BUILD_TAG=zoo-1 npm run build
PORT=4321 PUBLIC_BUILD_TAG=zoo-1 ZOO_PANEL_ORIGIN=http://localhost:5173 npm start
npm test
```

`npm test` (node:test, 9 tests): health shape, CORS (listed origin echoed, unlisted gets
nothing, preflight 204 with methods, headers, max age), build tag comparison, input
validation, and a full probe through a stand-in for Caddy (static page plus `/api` forwarded)
that passes, then fails with `stale build` when the runtime tag changes. Passing on node
26.8.2 and node 24.21.0; build and start also checked on node 24.21.0.

## ox check

```
ox check . (manifest: ox.toml)

  app.start                  npm run start                                        detected:package.json
  app.health                 /_zoo/health                                         declared
  static.dir                 dist                                                 declared
  build.install              npm ci                                               detected:package-lock.json
  build.commands[0]          npm run build                                        detected:package.json
  tools.node                 24                                                   detected:package.json

  Provided by ox: PORT, HOST, OX_ENV, OX_PROJECT, OX_RELEASE, OX_DATA_DIR, PUBLIC_URL, PUBLIC_HOST
  Set on the dashboard before the first deploy: ZOO_PANEL_ORIGIN, PUBLIC_BUILD_TAG

Ready to deploy.
```

The text output does not list `static.api`; `ox check --json` shows
`"API": ["/api", "/_zoo"]` under `resolved.manifest.Static`.

## Not verified locally

Real Caddy routing (no Caddy here; the `caddy-routing` check is exercised against a Node
stand-in) and the browser view of the page.
