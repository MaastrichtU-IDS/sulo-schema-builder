import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['src/**/*.test.ts'],
    environment: 'node',
    // Postgres-backed tests start a Docker container per test file.
    testTimeout: 120_000,
    hookTimeout: 180_000,
    // Containers are expensive; one file at a time keeps the machine sane.
    fileParallelism: false,
  },
});
