// Bundles index.js (+ all imported .ts source) into a single ESM file for Lambda.
// Replaces the old runtime `NODE_OPTIONS=--import tsx` approach, which type-stripped
// the whole module graph on every cold start and shipped ~66MB of node_modules.
// Output: dist/index.mjs (+ dist/templates for the SES OTP email). serverless.yml
// packages only dist/**.
import { build } from 'esbuild';
import { cpSync, rmSync } from 'node:fs';

rmSync('dist', { recursive: true, force: true });

const result = await build({
  entryPoints: ['index.js'],
  outfile: 'dist/index.mjs',
  bundle: true,
  platform: 'node',
  target: 'node24',
  format: 'esm',
  minify: true,
  metafile: true,
  // Resolves the @/* path aliases from tsconfig.json.
  tsconfig: 'tsconfig.json',
  // AWS SDK v3 ships with the nodejs24.x runtime — no need to bundle it.
  external: ['@aws-sdk/*'],
  // CJS deps (pg, ejs, ioredis, …) call require(); give the ESM bundle one.
  banner: {
    js: "import { createRequire as __cr } from 'node:module'; import { fileURLToPath as __fu } from 'node:url'; import { dirname as __dn } from 'node:path'; const require = __cr(import.meta.url); const __dirname = __dn(__fu(import.meta.url));",
  },
  logLevel: 'info',
});

cpSync('src/templates', 'dist/templates', { recursive: true });
// pdfkit reads its built-in font metrics (AFM) from __dirname/data at runtime.
cpSync('node_modules/pdfkit/js/data', 'dist/data', { recursive: true });

const bytes = Object.values(result.metafile.outputs).reduce((n, o) => n + o.bytes, 0);
console.log(`bundle: ${(bytes / 1024 / 1024).toFixed(2)} MB`);
