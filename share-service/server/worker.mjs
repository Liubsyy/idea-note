import { createService } from './service.mjs';
import { d1Database, r2Objects } from './storage.mjs';
const service = env => createService({ db: d1Database(env.DB), objects: r2Objects(env.BUCKET), adminPassword: env.ADMIN_PASSWORD, allowedOrigins: (env.ALLOWED_ORIGINS || '').split(',').filter(Boolean), staticFetch: request => env.ASSETS.fetch(request) });
export default {
  fetch: (request, env) => service(env).fetch(request),
  scheduled: (_event, env, ctx) => ctx.waitUntil(service(env).cleanup()),
};
