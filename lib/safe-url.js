import { lookup } from 'node:dns/promises';
import { request as httpRequest } from 'node:http';
import { request as httpsRequest } from 'node:https';
import { Readable } from 'node:stream';
import ipaddr from 'ipaddr.js';

export function isPrivateHost(host) {
  const h = String(host || '').toLowerCase().replace(/^\[|\]$/g, '');
  if (!h || h === 'localhost' || /\.(localhost|local|internal)$/.test(h)) return true;
  if (!ipaddr.isValid(h)) return h.includes(':');
  const address = ipaddr.process(h); // normalizes dotted AND hexadecimal mapped IPv4
  return address.range() !== 'unicast';
}

async function resolvePublic(url, lookupFn) {
  const u = url instanceof URL ? url : new URL(String(url));
  if (!['http:', 'https:'].includes(u.protocol)) throw new Error('only http(s) URLs');
  if (u.username || u.password) throw new Error('credentials in URLs are not allowed');
  const host = u.hostname.replace(/^\[|\]$/g, '');
  if (isPrivateHost(host)) throw new Error('private host is not allowed');
  const addresses = ipaddr.isValid(host)
    ? [{ address: host, family: ipaddr.parse(host).kind() === 'ipv6' ? 6 : 4 }]
    : await lookupFn(host, { all: true, verbatim: true });
  if (!addresses.length || addresses.some(a => !ipaddr.isValid(a.address) || isPrivateHost(a.address))) {
    throw new Error('host resolved to a private address');
  }
  return { url: u, addresses };
}

export async function assertPublicHttpUrl(url, { lookupFn = lookup } = {}) {
  return (await resolvePublic(url, lookupFn)).url;
}

// Pin the transport to exactly the checked DNS answers. Retain the original
// host for HTTP Host and TLS certificate verification; never look it up twice.
export async function publicHttpFetch(url, { signal, headers = {}, lookupFn = lookup, requestFn } = {}) {
  const resolved = await resolvePublic(url, lookupFn);
  if (signal?.aborted) throw new Error('request aborted');
  const transport = requestFn || (resolved.url.protocol === 'https:' ? httpsRequest : httpRequest);
  return new Promise((resolve, reject) => {
    const req = transport(resolved.url, {
      headers, signal, agent: false,
      lookup(_host, options, callback) {
        const addresses = options?.family
          ? resolved.addresses.filter(a => a.family === options.family) : resolved.addresses;
        if (!addresses.length) { callback(new Error('No validated address for this family')); return; }
        if (options?.all) callback(null, addresses);
        else callback(null, addresses[0].address, addresses[0].family);
      },
    }, res => {
      resolve({ status: res.statusCode, headers: { get: key => res.headers[key.toLowerCase()] || null }, body: Readable.toWeb(res) });
    });
    req.on('error', reject);
    req.end();
  });
}
