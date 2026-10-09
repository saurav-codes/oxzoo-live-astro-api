// Runs before `astro build`: bakes PUBLIC_BUILD_TAG and the build time into
// public/build-info.json, which Astro copies to dist/ for the API to read.
import { mkdirSync, writeFileSync } from 'node:fs';
import { validTag } from '../api/build.ts';

const tag = process.env.PUBLIC_BUILD_TAG ?? '';
if (tag !== '' && !validTag(tag)) {
  console.error('PUBLIC_BUILD_TAG must match ^[A-Za-z0-9._-]{1,64}$');
  process.exit(1);
}
const info = { tag: tag || null, built_at: new Date().toISOString().replace(/\.\d{3}Z$/, 'Z') };
mkdirSync('public', { recursive: true });
writeFileSync('public/build-info.json', JSON.stringify(info) + '\n');
console.log(`build-info: tag=${info.tag ?? '(unset)'} built_at=${info.built_at}`);
