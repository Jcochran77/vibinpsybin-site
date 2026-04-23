// @ts-check
import { defineConfig } from 'astro/config';
import { loadEnv } from 'vite';

const env = loadEnv(process.env.NODE_ENV ?? 'development', process.cwd(), '');
// Make server-only env vars available to build-time code via process.env
for (const [k, v] of Object.entries(env)) {
  if (process.env[k] === undefined) process.env[k] = v;
}

// https://astro.build/config
export default defineConfig({
  site: 'https://vibinpsybin.band',
  trailingSlash: 'never',
});
