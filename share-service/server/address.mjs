// Client addresses for administrator login rate limiting.

/** Parse TRUST_PROXY: how many reverse proxies in front of the Node server
 *  append to X-Forwarded-For. Unset means clients connect directly. */
export function trustedProxyHops(value) {
  if (value === undefined || value.trim() === '') return 0;
  if (!/^\d{1,2}$/.test(value.trim())) throw new Error('TRUST_PROXY must be the number of reverse proxies in front of the service, for example 1');
  return Number(value);
}

/** The client address as seen by the outermost trusted proxy. Each proxy
 *  appends the peer it received the request from, so only the last `hops`
 *  X-Forwarded-For entries are trustworthy; anything further left may have
 *  been sent by the client itself. */
export function forwardedClient(peer, forwardedFor, hops) {
  const chain = hops ? String(forwardedFor || '').split(',').map(v => v.trim()).filter(Boolean) : [];
  chain.push(peer || 'unknown');
  return chain[Math.max(0, chain.length - 1 - hops)];
}

function ipv6Groups(value) {
  const tail = /(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(value);
  if (tail) {
    const [a, b, c, d] = tail.slice(1).map(Number);
    if ([a, b, c, d].some(n => n > 255)) return null;
    value = value.slice(0, tail.index) + ((a << 8) | b).toString(16) + ':' + ((c << 8) | d).toString(16);
  }
  const halves = value.split('::');
  if (halves.length > 2) return null;
  const head = halves[0] ? halves[0].split(':') : [], rest = halves[1] ? halves[1].split(':') : [];
  const missing = 8 - head.length - rest.length;
  if (halves.length === 1 ? missing !== 0 : missing < 1) return null;
  const groups = [...head, ...Array(halves.length === 2 ? missing : 0).fill('0'), ...rest];
  return groups.every(g => /^[0-9a-f]{1,4}$/.test(g)) ? groups.map(g => parseInt(g, 16)) : null;
}

/** Rate-limit bucket for an address. IPv6 is grouped by /64 because one
 *  subscriber usually controls a whole /64; per-address buckets would hand
 *  each such client billions of fresh login budgets. */
export function rateLimitKey(address) {
  const value = String(address || 'unknown').trim().toLowerCase().slice(0, 100)
    .replace(/^\[([^\]]*)\](?::\d+)?$/, '$1').replace(/^(\d{1,3}(?:\.\d{1,3}){3}):\d+$/, '$1').replace(/%.*$/, '');
  const groups = value.includes(':') && ipv6Groups(value);
  if (!groups) return value;
  if (groups.slice(0, 5).every(g => g === 0) && groups[5] === 0xffff) return [groups[6] >> 8, groups[6] & 255, groups[7] >> 8, groups[7] & 255].join('.');
  return groups.slice(0, 4).map(g => g.toString(16)).join(':') + '::/64';
}
