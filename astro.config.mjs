// @ts-check
import { defineConfig, passthroughImageService } from 'astro/config';
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
  image: {
    // Use the passthrough image service. Cloudflare Workers Builds was
    // not loading Sharp (even with it explicitly configured), so the
    // built HTML fell back to dynamic /_image?... URLs that 404 on a
    // no-server deploy. Passthrough emits the original asset URL as a
    // static file — no image service required at build or runtime.
    service: passthroughImageService(),
  },
});
