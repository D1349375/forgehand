import { defineConfig } from 'vitest/config';

export default defineConfig({ test: { include: ['tests/unit/**/*.test.ts'], environment: 'node',
  // Cold Windows process/file startup can exceed Vitest's 5s default.
  testTimeout: 45_000, maxWorkers: 1, pool: 'threads', isolate: false,
} });
