import fp from 'fastify-plugin';
import cors from '@fastify/cors';
import { config } from '../config.js';

export default fp(async (fastify) => {
  await fastify.register(cors, {
    origin: config.env === 'development' ? true : false,
    methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization', 'X-API-Key'],
  });
});
