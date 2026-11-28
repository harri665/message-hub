import assert from 'node:assert/strict';
import { test } from 'node:test';

process.env.DATABASE_URL ??= 'postgres://unused:unused@127.0.0.1:1/unused';
const { extractLink, parseHtml, readLinkPayload, decodeEntities } = await import('../src/linkpreview.ts');

test('extractLink finds the first link and tidies punctuation', () => {
  assert.equal(extractLink('https://example.com/a')?.url, 'https://example.com/a');
  assert.equal(extractLink('look: https://example.com/a, cool')?.url, 'https://example.com/a');
  assert.equal(extractLink('(see https://example.com/a)')?.url, 'https://example.com/a');
  assert.equal(extractLink('https://en.wikipedia.org/wiki/Foo_(bar)')?.url, 'https://en.wikipedia.org/wiki/Foo_(bar)');
  assert.equal(extractLink('is it https://example.com/a?')?.url, 'https://example.com/a');
  assert.equal(extractLink('www.example.com/x')?.url, 'https://www.example.com/x');
  assert.equal(extractLink('a https://one.com b https://two.com')?.url, 'https://one.com/');
  assert.equal(extractLink('https://example.com/a#frag')?.url, 'https://example.com/a');
  assert.equal(extractLink('no link here'), null);
  assert.equal(extractLink('ftp://example.com'), null);
  assert.equal(extractLink(null), null);
});

test('extractLink returns the text without the link', () => {
  assert.equal(extractLink('https://example.com/a')?.rest, '');
  assert.equal(extractLink('check this out https://example.com/a')?.rest, 'check this out');
  assert.equal(extractLink('before https://example.com/a after')?.rest, 'before after');
  assert.equal(extractLink('line one\nhttps://example.com/a\nline two')?.rest, 'line one\nline two'.replace('\n', '\n'));
});

test('parseHtml reads OpenGraph, Twitter and fallback tags', () => {
  const base = new URL('https://shop.example.com/p/1');
  const og = parseHtml(`<!doctype html><html><head><title>Fallback &amp; title</title>
    <meta property="og:title" content="The &quot;Thing&quot;"><meta property='og:site_name' content=Shop>
    <meta property="og:description" content="Nice   thing"><meta property="og:image" content="/img/a.jpg">
    <link rel="icon" href="/favicon.ico"><link rel="apple-touch-icon" sizes="180x180" href="/touch.png"></head><body>
    <meta property="og:title" content="late"></body></html>`, base);
  assert.deepEqual(og, { title: 'The "Thing"', siteName: 'Shop', description: 'Nice thing', image: 'https://shop.example.com/img/a.jpg', icon: 'https://shop.example.com/touch.png' });
  const tw = parseHtml('<head><meta name="twitter:title" content="T"><meta name="twitter:image" content="https://cdn.example.com/x.png"></head>', base);
  assert.equal(tw.title, 'T');
  assert.equal(tw.image, 'https://cdn.example.com/x.png');
  const plain = parseHtml('<html><head><title>  Just a title </title></head>', base);
  assert.equal(plain.title, 'Just a title');
  assert.equal(plain.image, null);
  // An image on a private address is dropped rather than fetched later.
  assert.equal(parseHtml('<head><meta property="og:image" content="http://192.168.1.1/a.png"></head>', base).image, null);
  assert.equal(parseHtml('<head><meta property="og:image" content="file:///etc/passwd"></head>', base).image, null);
  assert.equal(decodeEntities('a &#39;b&#x27; &lt;c&gt; &unknown;'), "a 'b' <c> &unknown;");
});

test('readLinkPayload reads an iMessage LPLinkMetadata archive', () => {
  const objects = [
    '$null',
    { richLinkIsPlaceholder: false, richLinkMetadata: { UID: 2 }, $class: { UID: 23 } },
    { $class: { UID: 22 }, originalURL: { UID: 3 }, title: { UID: 8 }, summary: { UID: 11 }, siteName: { UID: 12 }, image: { UID: 12 + 1 }, URL: { UID: 6 }, icon: { UID: 9 } },
    { 'NS.base': { UID: 0 }, $class: { UID: 5 }, 'NS.relative': { UID: 4 } }, 'https://youtu.be/abc',
    { $classname: 'NSURL' },
    { 'NS.base': { UID: 0 }, $class: { UID: 5 }, 'NS.relative': { UID: 7 } }, 'https://www.youtube.com/watch?v=abc',
    'A video title',
    { richLinkImageAttachmentSubstituteIndex: 0, MIMEType: { UID: 10 }, imageType: 5 }, 'image/png',
    'About the video', 'YouTube',
    { richLinkImageAttachmentSubstituteIndex: 1, MIMEType: { UID: 10 }, imageType: 0 },
  ];
  // Fix up indexes: build by hand so UIDs line up with the array above.
  const payload = [{ $version: 100000, $archiver: 'NSKeyedArchiver', $top: { root: { UID: 1 } }, $objects: objects }];
  objects[2] = { $class: { UID: 5 }, originalURL: { UID: 3 }, title: { UID: 8 }, summary: { UID: 11 }, siteName: { UID: 12 }, image: { UID: 13 }, URL: { UID: 6 }, icon: { UID: 9 } };
  const got = readLinkPayload(payload);
  assert.deepEqual(got, { url: 'https://www.youtube.com/watch?v=abc', title: 'A video title', siteName: 'YouTube', summary: 'About the video', imageIndex: 1, iconIndex: 0 });
  assert.equal(readLinkPayload(null), null);
  assert.equal(readLinkPayload([{ $objects: ['$null'], $top: { root: { UID: 0 } } }]), null);
  assert.equal(readLinkPayload([{ $objects: [{ $self: 1 }], $top: { root: { UID: 0 } } }]), null);
});
