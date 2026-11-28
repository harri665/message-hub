import assert from 'node:assert/strict';
import http from 'node:http';
import { test } from 'node:test';
import { FetchRefused, guardedGet, guardedLookup, isPublicIp, run, urlProblem } from '../src/netguard.ts';

delete process.env.LINK_PREVIEW_ALLOW_PRIVATE;

test('public addresses pass', () => {
  for (const ip of ['8.8.8.8', '1.1.1.1', '93.184.216.34', '151.101.1.69', '2606:4700:4700::1111', '2a00:1450:4009:81f::200e', '172.15.0.1', '172.32.0.1', '100.63.255.255', '100.128.0.1'])
    assert.equal(isPublicIp(ip), true, ip);
});

test('private, loopback, link-local, CGNAT and special IPv4 are refused', () => {
  for (const ip of ['0.0.0.0', '10.0.0.1', '10.255.255.255', '127.0.0.1', '127.1.2.3', '169.254.169.254', '172.16.0.1', '172.31.255.255', '192.168.1.1',
    '100.64.0.1', '100.100.100.100', '100.127.255.255', '192.0.0.1', '192.0.2.5', '198.18.0.1', '198.19.255.255', '198.51.100.1', '203.0.113.9', '224.0.0.1', '239.1.1.1', '240.0.0.1', '255.255.255.255'])
    assert.equal(isPublicIp(ip), false, ip);
});

test('IPv6 loopback, local and special ranges are refused', () => {
  for (const ip of ['::', '::1', '0:0:0:0:0:0:0:1', 'fe80::1', 'fe80::1%eth0', 'fc00::1', 'fd12:3456:789a::1', 'fec0::1', 'ff02::1', '2001:db8::1', '2001::1', '100::1', '64:ff9b:1::1', '[::1]'])
    assert.equal(isPublicIp(ip), false, ip);
});

test('IPv4 hidden inside IPv6 is judged as IPv4', () => {
  for (const ip of ['::ffff:127.0.0.1', '::ffff:10.0.0.1', '::ffff:7f00:1', '::ffff:a9fe:a9fe', '::ffff:192.168.0.1', '64:ff9b::7f00:1', '64:ff9b::a00:1', '2002:7f00:1::', '2002:0a00:0001::1', '::127.0.0.1', '::10.0.0.1'])
    assert.equal(isPublicIp(ip), false, ip);
  for (const ip of ['::ffff:8.8.8.8', '64:ff9b::808:808', '2002:808:808::1'])
    assert.equal(isPublicIp(ip), true, ip);
});

test('garbage is refused', () => {
  for (const ip of ['', 'abc', '1.2.3', '256.1.1.1', '1.2.3.4.5', '::g', '1::2::3', '12345::1'])
    assert.equal(isPublicIp(ip), false, ip);
});

test('URL policy: schemes, credentials, ports, names', () => {
  const bad = ['file:///etc/passwd', 'ftp://example.com/', 'gopher://example.com/', 'javascript:alert(1)', 'data:text/html,hi',
    'http://user:pw@example.com/', 'http://localhost/', 'http://localhost:8080/', 'http://foo.localhost/', 'http://db/', 'http://hub:8080/', 'http://wa:8090/',
    'http://127.0.0.1/', 'http://127.1/', 'http://2130706433/', 'http://0x7f000001/', 'http://017700000001/', 'http://[::1]/', 'http://[::ffff:127.0.0.1]/',
    'http://169.254.169.254/latest/meta-data/', 'http://metadata.google.internal/', 'http://printer.local/', 'http://nas.lan/', 'http://10.1.2.3/',
    'https://example.com:22/', 'https://example.com:5432/', 'http://192.168.1.10:80/', 'http://100.76.147.8:8095/'];
  for (const u of bad) assert.notEqual(urlProblem(new URL(u)), null, u);
  for (const u of ['http://example.com/', 'https://example.com/a?b=c', 'https://www.amazon.com/dp/B0', 'https://en.wikipedia.org/wiki/Foo_(bar)', 'https://example.com:8443/x', 'https://[2606:4700:4700::1111]/'])
    assert.equal(urlProblem(new URL(u)), null, u);
});

test('a host name that resolves to a private address is refused at connect time', async () => {
  const err: any = await new Promise((resolve) => guardedLookup('localhost', { all: true }, (e: any) => resolve(e)));
  assert.equal(err?.code, 'EBLOCKED');
  await assert.rejects(guardedGet(new URL('http://localhost/'), { maxBytes: 1000, accept: '*/*' }), FetchRefused);
});

test('every redirect hop is checked, including a redirect to a private address', async () => {
  const hops: string[] = [];
  const fake = async (url: URL) => {
    hops.push(url.href);
    if (url.hostname === 'example.com') return { status: 302, location: 'http://169.254.169.254/latest/meta-data/', contentType: '', body: Buffer.alloc(0), truncated: false };
    return { status: 200, contentType: 'text/html', body: Buffer.from('ok'), truncated: false };
  };
  await assert.rejects(run(new URL('https://example.com/'), { maxBytes: 100, accept: '*/*' }, fake as any), /not public/);
  assert.deepEqual(hops, ['https://example.com/']);

  for (const target of ['http://127.0.0.1:8080/', 'http://[::1]/', 'http://10.0.0.5/', 'file:///etc/passwd', 'http://localhost/', 'http://db/', 'http://[::ffff:10.0.0.1]/']) {
    const f = async () => ({ status: 301, location: target, contentType: '', body: Buffer.alloc(0), truncated: false });
    await assert.rejects(run(new URL('https://example.com/'), { maxBytes: 100, accept: '*/*' }, f as any), FetchRefused, target);
  }
});

test('redirect chains are limited, and public redirects are followed', async () => {
  let n = 0;
  const loop = async () => ({ status: 302, location: `https://example.com/${++n}`, contentType: '', body: Buffer.alloc(0), truncated: false });
  await assert.rejects(run(new URL('https://example.com/'), { maxBytes: 100, accept: '*/*', maxRedirects: 3 }, loop as any), /too many redirects/);
  assert.equal(n, 4);
  const ok = async (u: URL) =>
    u.pathname === '/' ? { status: 301, location: '/next', contentType: '', body: Buffer.alloc(0), truncated: false } : { status: 200, contentType: 'text/html', body: Buffer.from('hi'), truncated: false };
  const res = await run(new URL('https://example.com/'), { maxBytes: 100, accept: '*/*' }, ok as any);
  assert.equal(res.url.pathname, '/next');
});

test('real requests: body cap, early stop, timeout, redirect (loopback allowed only in this test)', async () => {
  const srv = http.createServer((req, res) => {
    if (req.url === '/big') { res.writeHead(200, { 'content-type': 'text/html' }); res.write('a'.repeat(50_000)); res.write('b'.repeat(50_000)); return res.end('c'.repeat(50_000)); }
    if (req.url === '/head') { res.writeHead(200, { 'content-type': 'text/html' }); res.write('<html><head><title>x</title>' + ' '.repeat(25_000) + '</head>'); return setTimeout(() => res.end('<body>' + 'z'.repeat(1e6)), 3000); }
    if (req.url === '/slow') { res.writeHead(200); return void setTimeout(() => res.end('late'), 5000); }
    if (req.url === '/r') { res.writeHead(302, { location: '/big' }); return res.end(); }
    res.writeHead(404); res.end();
  });
  await new Promise<void>((r) => srv.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${(srv.address() as any).port}`;
  process.env.LINK_PREVIEW_ALLOW_PRIVATE = '1';
  try {
    const big = await guardedGet(new URL(`${base}/big`), { maxBytes: 60_000, accept: '*/*' });
    assert.equal(big.body.length, 60_000);
    assert.equal(big.truncated, true);
    const t0 = Date.now();
    const head = await guardedGet(new URL(`${base}/head`), { maxBytes: 600_000, accept: '*/*', enough: (b) => /<\/head>/i.test(b.toString('latin1')) });
    assert.ok(Date.now() - t0 < 2000, 'stopped reading at </head>');
    assert.match(head.body.toString(), /<title>x<\/title>/);
    await assert.rejects(guardedGet(new URL(`${base}/slow`), { maxBytes: 100, accept: '*/*', timeoutMs: 500 }), /timed out/);
    const viaRedirect = await guardedGet(new URL(`${base}/r`), { maxBytes: 1000, accept: '*/*' });
    assert.equal(viaRedirect.url.pathname, '/big');
  } finally {
    delete process.env.LINK_PREVIEW_ALLOW_PRIVATE;
    srv.closeAllConnections();
    srv.close();
  }
  // And with the flag off again, the same loopback server is out of reach.
  await assert.rejects(guardedGet(new URL(`${base}/big`), { maxBytes: 100, accept: '*/*' }), FetchRefused);
});
