import fp from 'fastify-plugin';
import fastifyStatic from '@fastify/static';
import { config } from '../config.js';

export default fp(async (fastify) => {
  await fastify.register(fastifyStatic, {
    root: config.staticDir,
    wildcard: false,
  });
});
