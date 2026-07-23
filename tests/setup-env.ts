// Runs before any test module is imported (see vitest.config.ts setupFiles).
// src/config/env.ts calls loadEnv() at import time, so these must exist before
// any module that transitively imports env/logger/prisma is loaded.
process.env.DATABASE_URL ??= 'postgresql://test:test@localhost:5432/testdb';
process.env.JWT_ACCESS_SECRET ??= 'test-access-secret-not-real-0001';
process.env.JWT_REFRESH_SECRET ??= 'test-refresh-secret-not-real-001';
