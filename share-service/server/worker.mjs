import { createService } from './service.mjs';
import { d1Database } from './storage.mjs';
import { b2Objects } from './b2.mjs';
const instances = new WeakMap();
const service = env => {
  if (!instances.has(env)) instances.set(env, createService({ db: d1Database(env.DB), objects: b2Objects(env), adminPassword: env.ADMIN_PASSWORD, allowedOrigins: (env.ALLOWED_ORIGINS || '').split(',').filter(Boolean), staticFetch: request => env.ASSETS.fetch(request), cleanupObjectLimit: 10 }));
  return instances.get(env);
};
export default {
  fetch: (request, env) => service(env).fetch(request),
  scheduled: (_event, env, ctx) => ctx.waitUntil(service(env).cleanup()),
};
