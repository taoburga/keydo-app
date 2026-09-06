import { test } from 'node:test';
import assert from 'node:assert/strict';
import { assertPublicHttpUrl, isPrivateHost } from '../lib/safe-url.js';

test('private, loopback, mapped, and non-routable addresses are blocked', () => {
  for (const host of [
    'localhost', 'x.local', '127.0.0.1', '10.0.0.1', '172.16.0.1',
    '192.168.1.1', '169.254.1.1', '100.64.0.1', '::1',
    '::ffff:127.0.0.1', 'fc00::1', 'fe80::1', '2001:db8::1',
  ]) assert.equal(isPrivateHost(host), true, host);
  assert.equal(isPrivateHost('fcc.gov'), false);
  assert.equal(isPrivateHost('fda.gov'), false);
  assert.equal(isPrivateHost('8.8.8.8'), false);
});

test('DNS answers are checked, not just the written hostname', async () => {
  await assert.rejects(() => assertPublicHttpUrl('https://example.com/x', {
    lookupFn: async () => [{ address: '127.0.0.1', family: 4 }],
  }), /private address/);
  await assert.doesNotReject(() => assertPublicHttpUrl('https://example.com/x', {
    lookupFn: async () => [{ address: '93.184.216.34', family: 4 }],
  }));
});

test('non-http schemes and credential-bearing URLs are blocked', async () => {
  await assert.rejects(() => assertPublicHttpUrl('file:///etc/passwd'), /http/);
  await assert.rejects(() => assertPublicHttpUrl('https://user:secret@example.com/', {
    lookupFn: async () => [{ address: '93.184.216.34', family: 4 }],
  }), /credentials/);
});

test('hexadecimal IPv4-mapped loopback and private addresses are rejected',async()=>{
  for(const host of ['::ffff:7f00:1','::ffff:c0a8:101','0:0:0:0:0:ffff:7f00:1']) assert.equal(isPrivateHost(host),true);
  await assert.rejects(()=>assertPublicHttpUrl('https://example.com/',{lookupFn:async()=>[{address:'::ffff:7f00:1',family:6}]}),/private/);
});

test('transport reuses validated addresses without a second DNS lookup',async()=>{
  const {publicHttpFetch}=await import('../lib/safe-url.js');
  const {PassThrough}=await import('node:stream');
  const {EventEmitter}=await import('node:events');
  let lookups=0;
  const result=await publicHttpFetch('https://example.com/article',{
    lookupFn:async()=>{lookups++;return [{address:'93.184.216.34',family:4}];},
    requestFn:(url,options,onResponse)=>{
      assert.equal(url.hostname,'example.com');
      options.lookup(url.hostname,{all:true},(error,addresses)=>{assert.equal(error,null);assert.deepEqual(addresses,[{address:'93.184.216.34',family:4}]);});
      const req=new EventEmitter();req.end=()=>{const res=new PassThrough();res.statusCode=200;res.headers={'content-type':'text/html'};onResponse(res);res.end('<title>safe</title>');};return req;
    },
  });
  assert.equal(lookups,1);assert.equal(result.status,200);
  const reader=result.body.getReader();assert.ok((await reader.read()).value.length);
});
