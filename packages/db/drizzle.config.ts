import { defineConfig } from 'drizzle-kit';

export default defineConfig({
  dialect: 'postgresql',
  schema: ['./src/schema.ts', './src/risk-schema.ts', './src/basket-schema.ts'],
  out: './migrations',
  dbCredentials: {
    url: process.env.DATABASE_URL ?? 'postgres://colosseum:colosseum@localhost:5433/colosseum',
  },
});
