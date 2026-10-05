import { defineConfig } from 'vitest/config';

// Tests unitarios: sin bases de datos ni LLM reales.
export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
    exclude: ['test/integration/**'],
  },
});
