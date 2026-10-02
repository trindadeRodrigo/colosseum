import type { EnvLike } from '@colosseum/schemas';
import type { FastifyInstance } from 'fastify';
import { registerConfigRoute } from './config';

/** Every /v1 route. The app hands in its environment once; nothing under here reads process.env. */
export async function registerV1Routes(app: FastifyInstance, env: EnvLike) {
  await registerConfigRoute(app, env);
}
