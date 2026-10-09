// What the build baked, and how the probe checks it against the running process.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

export interface BuildInfo {
  tag: string | null;
  built_at: string;
}

const TAG_RE = /^[A-Za-z0-9._-]{1,64}$/;

export function validTag(tag: string): boolean {
  return TAG_RE.test(tag);
}

export function parseBuildInfo(text: string): BuildInfo {
  const v = JSON.parse(text);
  if (!v || typeof v !== 'object') throw new Error('build-info.json is not an object');
  const tag = v.tag === null ? null : String(v.tag);
  if (tag !== null && !validTag(tag)) throw new Error('build-info.json has a bad tag');
  if (typeof v.built_at !== 'string' || Number.isNaN(Date.parse(v.built_at))) {
    throw new Error('build-info.json has no built_at');
  }
  return { tag, built_at: v.built_at };
}

// null when the site was never built (local dev without `npm run build`).
export function readBuildInfo(distDir: string): BuildInfo | null {
  try {
    return parseBuildInfo(readFileSync(join(distDir, 'build-info.json'), 'utf8'));
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw err;
  }
}

// The tag baked at build must equal the variable the process runs with:
// ox gives the build and the run the same variables, so a mismatch is a stale build.
export function compareTag(baked: BuildInfo | null, runtime: string | undefined): string {
  if (!baked) throw new Error('dist/build-info.json is missing: the site was not built');
  if (baked.tag === null) throw new Error('PUBLIC_BUILD_TAG was not set at build time');
  if (baked.tag !== runtime) throw new Error(`built with tag ${baked.tag}, running with ${runtime}: stale build`);
  return `build and runtime agree on ${baked.tag}, built ${baked.built_at}`;
}

// The page Astro rendered carries the tag in <meta name="zoo-build-tag">.
export function pageTag(html: string): string | null {
  const m = /<meta name="zoo-build-tag" content="([^"]*)"/.exec(html);
  return m ? m[1] : null;
}
