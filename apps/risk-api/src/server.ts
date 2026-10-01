import './env';
import { buildRiskApp } from './app';

const app = await buildRiskApp();
const port = Number(process.env.RISK_API_PORT ?? 3002);
await app.listen({ port, host: '0.0.0.0' });
app.log.info(`risk API docs at http://localhost:${port}/docs`);
