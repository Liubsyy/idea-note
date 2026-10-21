import assert from 'node:assert/strict';
import test from 'node:test';
import { createServer, request } from 'node:http';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { forwardedClient, rateLimitKey, trustedProxyHops } from '../server/address.mjs';
import { nodeService, requestListener } from '../server/node.mjs';
const origin = 'https://share.test', password = 'address-test-admin-password';

test('TRUST_PROXY is opt-in and only accepts a proxy count', () => {
  assert.equal(trustedProxyHops(undefined), 0);
  assert.equal(trustedProxyHops(''), 0);
  assert.equal(trustedProxyHops('0'), 0);
  assert.equal(trustedProxyHops(' 2 '), 2);
  for (const value of ['true', 'yes', '-1', '1.5', '10.0.0.0/8']) assert.throws(() => trustedProxyHops(value), /TRUST_PROXY/, value);
});

test('the client is the entry appended by the outermost trusted proxy; forged entries are ignored', () => {
  assert.equal(forwardedClient('10.0.0.2', '198.51.100.7', 0), '10.0.0.2');
  assert.equal(forwardedClient('10.0.0.2', '198.51.100.7', 1), '198.51.100.7');
  assert.equal(forwardedClient('10.0.0.2', '6.6.6.6, 7.7.7.7,198.51.100.7', 1), '198.51.100.7');
  assert.equal(forwardedClient('10.0.0.2', '6.6.6.6, 198.51.100.7, 172.70.1.1', 2), '198.51.100.7');
  // A request that bypassed a proxy falls back to the furthest known hop.
  assert.equal(forwardedClient('10.0.0.2', undefined, 1), '10.0.0.2');
  assert.equal(forwardedClient(undefined, undefined, 0), 'unknown');
});

test('rate-limit keys normalize addresses and group IPv6 by /64', () => {
  assert.equal(rateLimitKey('198.51.100.7'), '198.51.100.7');
  assert.equal(rateLimitKey('198.51.100.7:4431'), '198.51.100.7');
  assert.equal(rateLimitKey('::ffff:198.51.100.7'), '198.51.100.7');
  assert.equal(rateLimitKey('2001:db8:1:2::1'), '2001:db8:1:2::/64');
  assert.equal(rateLimitKey('2001:DB8:0001:0002:ffff:eeee:dddd:cccc'), '2001:db8:1:2::/64');
  assert.equal(rateLimitKey('[2001:db8:1:2::5]:443'), '2001:db8:1:2::/64');
  assert.equal(rateLimitKey('2001:db8::1.2.3.4'), '2001:db8:0:0::/64');
  assert.equal(rateLimitKey('fe80::1%en0'), 'fe80:0:0:0::/64');
  assert.notEqual(rateLimitKey('2001:db8:1:3::1'), rateLimitKey('2001:db8:1:2::1'));
  for (const value of ['unknown', '1:2:3', '1::2::3', 'not-an-ip']) assert.equal(rateLimitKey(value), value);
});

test('behind a trusted proxy, a client locking itself out does not lock out other clients', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'idea-share-address-'));
  const service = await nodeService({ dataDir: dir, password, distDir: dir });
  const server = createServer(requestListener(service, { publicOrigin: origin, hops: 1 }));
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => { await new Promise(resolve => server.close(resolve)); service.close(); await rm(dir, { recursive: true, force: true }); });
  const login = (forwardedFor, secret) => new Promise((resolve, reject) => {
    const body = JSON.stringify({ password: secret });
    const req = request({ host: '127.0.0.1', port: server.address().port, path: '/api/v1/admin/login', method: 'POST',
      headers: { Origin: origin, 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body), 'X-Forwarded-For': forwardedFor } }, res => { res.resume(); resolve(res.statusCode); });
    req.on('error', reject); req.end(body);
  });
  // Rotating a forged leftmost entry does not buy fresh attempts.
  for (let i = 0; i < 10; i++) assert.equal(await login(`10.9.9.${i}, 203.0.113.9`, 'wrong'), 401);
  assert.equal(await login('10.9.9.99, 203.0.113.9', password), 429);
  assert.equal(await login('198.51.100.20', password), 200);
  // One IPv6 subscriber cannot dodge the limit by changing the interface ID.
  for (let i = 1; i <= 10; i++) assert.equal(await login(`2001:db8:5:6::${i.toString(16)}`, 'wrong'), 401);
  assert.equal(await login('2001:db8:5:6::ffff', password), 429);
  assert.equal(await login('2001:db8:5:7::1', password), 200);
});

test('a successful login clears the bucket; failures are counted per client', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'idea-share-address-'));
  const service = await nodeService({ dataDir: dir, password, distDir: dir });
  t.after(async () => { service.close(); await rm(dir, { recursive: true, force: true }); });
  const login = async (client, secret) => (await service.fetch(new Request(origin + '/api/v1/admin/login', { method: 'POST', headers: { Origin: origin, 'X-Service-Client-IP': client }, body: JSON.stringify({ password: secret }) }))).status;
  for (let i = 0; i < 9; i++) assert.equal(await login('192.0.2.1', 'typo'), 401);
  assert.equal(await login('192.0.2.1', password), 200);
  for (let i = 0; i < 10; i++) assert.equal(await login('192.0.2.1', 'typo'), 401);
  assert.equal(await login('192.0.2.1', password), 429);
  assert.equal(await login('192.0.2.2', password), 200);
});
