import './env';
import { createDb, seedChains } from '@colosseum/db';
import { parseChainConfigs } from '@colosseum/schemas';
import { buildApp } from './app';

// The vault tables point at `chains`. Write its rows before serving, and stop if this database was
// seeded for another network than the one the environment names.
const seed = createDb();
await seedChains(seed.db, parseChainConfigs(process.env));
await seed.client.end();

const app = await buildApp();
const port = Number(process.env.API_PORT ?? 3001);
await app.listen({ port, host: '0.0.0.0' });
app.log.info(`docs at http://localhost:${port}/docs`);
