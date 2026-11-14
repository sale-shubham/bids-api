import { defineConfig } from 'vitest/config';
import { fileURLToPath } from 'node:url';

export default defineConfig({
  resolve: {
    alias: [
      { find: '@', replacement: fileURLToPath(new URL('./src', import.meta.url)) },
      // Mirror tsconfig paths: bare `@prisma/client` is the generated Prisma 7
      // client in src/generated. Exact-match regex only — subpaths like
      // `@prisma/client/runtime/client` must still resolve to the npm package
      // (the generated client imports its runtime from there).
      {
        find: /^@prisma\/client$/,
        replacement: fileURLToPath(
          new URL('./src/generated/prisma/client.ts', import.meta.url),
        ),
      },
    ],
  },
  test: {
    environment: 'node',
    include: ['src/**/*.test.ts', 'scripts/**/*.test.ts'],
  },
});
