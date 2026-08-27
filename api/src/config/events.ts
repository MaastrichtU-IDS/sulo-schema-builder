// Change-publication settings (spec §8): the SSE keep-alive interval.

import { optional } from './env.js';

export const eventsConfig = {
  // Proxies and load balancers commonly kill an idle HTTP connection after
  // 30-60s; a keep-alive comment well under that keeps every open
  // subscription looking alive to anything sitting in front of this server.
  sseKeepAliveMs: parseInt(optional('EVENTS_SSE_KEEPALIVE_MS', '20000'), 10),
} as const;
