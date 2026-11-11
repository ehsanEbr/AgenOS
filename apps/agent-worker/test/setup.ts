process.env.DATABASE_URL ??= 'postgresql://agentos:agentos@localhost:5432/agentos?schema=public';
process.env.REDIS_URL ??= 'redis://localhost:6379';
process.env.LOG_LEVEL ??= 'silent';
process.env.NODE_ENV = 'test';
