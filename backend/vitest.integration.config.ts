import { defineConfig } from 'vitest/config';

// Tests de integración: requieren PostgreSQL y MongoDB levantados
// (docker compose up -d postgres mongo) y leen la conexión de .env.
export default defineConfig({
  test: {
    include: ['test/integration/**/*.test.ts'],
    setupFiles: ['test/integration/setup.ts'],
    fileParallelism: false,
    testTimeout: 15_000,
  },
});
