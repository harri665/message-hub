// A guarded HTTP(S) client for fetching pages that other people put in messages (link previews).
//
// What it protects against:
//  - SSRF: every address a host name resolves to is checked at connect time (so a DNS answer can't change between a
//    check and the connection), and literal IPs are checked up front. Private, loopback, link-local, CGNAT, multicast,
//    documentation, benchmarking and other special ranges are refused, for IPv4, IPv6 and the IPv4 forms inside IPv6
//    (mapped, NAT64, 6to4). Redirects are followed by hand so each hop is checked the same way.
//  - Odd schemes, credentials in URLs, unusual ports.
//  - Slow or huge answers: connect/total timeouts, a byte cap on the body (also after decompression), few redirects.
//  - Overload: a global limit on concurrent fetches.
import dns from 'node:dns';
import http from 'node:http';
import https from 'node:https';
import net from 'node:net';
import type { Readable } from 'node:stream';
import zlib from 'node:zlib';

/** Test-only escape hatch: lets the fetcher reach loopback/private addresses and any port. Off unless the env var is set. */
export const allowPrivate = () => process.env.LINK_PREVIEW_ALLOW_PRIVATE === '1';

// ---------- address checks ----------

type V4 = [number, number, number, number];

// [network, prefix length]
const BLOCKED_V4: [V4, number][] = [
  [[0, 0, 0, 0], 8], [[10, 0, 0, 0], 8], [[100, 64, 0, 0], 10], [[127, 0, 0, 0], 8], [[169, 254, 0, 0], 16],
  [[172, 16, 0, 0], 12], [[192, 0, 0, 0], 24], [[192, 0, 2, 0], 24], [[192, 88, 99, 0], 24], [[192, 168, 0, 0], 16],
  [[198, 18, 0, 0], 15], [[198, 51, 100, 0], 24], [[203, 0, 113, 0], 24], [[224, 0, 0, 0], 4], [[240, 0, 0, 0], 4],
];

function parseV4(s: string): V4 | null {
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(s);
  if (!m) return null;
  const p = m.slice(1).map(Number);
  return p.every((n) => n <= 255) ? (p as V4) : null;
}

function v4Allowed(a: V4): boolean {
  const n = ((a[0] << 24) | (a[1] << 16) | (a[2] << 8) | a[3]) >>> 0;
  return !BLOCKED_V4.some(([net4, bits]) => {
    const base = ((net4[0] << 24) | (net4[1] << 16) | (net4[2] << 8) | net4[3]) >>> 0;
    const mask = bits === 0 ? 0 : (0xffffffff << (32 - bits)) >>> 0;
    return (n & mask) === (base & mask);
  });
}

/** Expands an IPv6 text address into eight 16-bit groups, or null when it isn't valid. */
function parseV6(input: string): number[] | null {
  let s = input.toLowerCase();
  const zone = s.indexOf('%');
  if (zone >= 0) s = s.slice(0, zone);
  // A trailing dotted IPv4 (::ffff:1.2.3.4) is two groups.
  const dot = s.lastIndexOf(':');
  if (dot >= 0 && s.includes('.', dot)) {
    const v4 = parseV4(s.slice(dot + 1));
    if (!v4) return null;
    s = `${s.slice(0, dot + 1)}${((v4[0] << 8) | v4[1]).toString(16)}:${((v4[2] << 8) | v4[3]).toString(16)}`;
  }
  const halves = s.split('::');
  if (halves.length > 2) return null;
  const groups = (t: string) => (t === '' ? [] : t.split(':'));
  const head = groups(halves[0]);
  const tail = halves.length === 2 ? groups(halves[1]) : [];
  const fill = 8 - head.length - tail.length;
  if (halves.length === 1 ? head.length !== 8 : fill < 1) return null;
  const all = [...head, ...Array(halves.length === 2 ? fill : 0).fill('0'), ...tail];
  if (all.length !== 8) return null;
  const out = all.map((g) => (/^[0-9a-f]{1,4}$/.test(g) ? parseInt(g, 16) : NaN));
  return out.some(Number.isNaN) ? null : out;
}

function v6Allowed(g: number[]): boolean {
  const embedded = (hi: number, lo: number): V4 => [hi >> 8, hi & 255, lo >> 8, lo & 255];
  const allZero = (from: number, to: number) => g.slice(from, to).every((x) => x === 0);
  if (allZero(0, 8)) return false; // ::
  if (allZero(0, 7) && g[7] === 1) return false; // ::1
  if (allZero(0, 5) && g[5] === 0xffff) return v4Allowed(embedded(g[6], g[7])); // ::ffff:a.b.c.d (mapped)
  if (allZero(0, 6)) return false; // ::a.b.c.d (deprecated compatible form)
  if (g[0] === 0x64 && g[1] === 0xff9b && allZero(2, 6)) return v4Allowed(embedded(g[6], g[7])); // 64:ff9b::/96 NAT64
  if (g[0] === 0x64 && g[1] === 0xff9b && g[2] === 1) return false; // 64:ff9b:1::/48 local NAT64
  if (g[0] === 0x2002) return v4Allowed(embedded(g[1], g[2])); // 6to4 embeds the IPv4 address
  if (g[0] === 0x2001 && g[1] === 0) return false; // Teredo
  if (g[0] === 0x2001 && g[1] === 0xdb8) return false; // documentation
  if (g[0] === 0x2001 && g[1] < 0x200) return false; // IETF protocol assignments (2001::/23)
  if (g[0] === 0x100 && g[1] === 0 && g[2] === 0 && g[3] === 0) return false; // discard-only 100::/64
  if ((g[0] & 0xfe00) === 0xfc00) return false; // fc00::/7 unique local
  if ((g[0] & 0xffc0) === 0xfe80) return false; // fe80::/10 link-local
  if ((g[0] & 0xffc0) === 0xfec0) return false; // fec0::/10 site-local (deprecated)
  if ((g[0] & 0xff00) === 0xff00) return false; // multicast
  return (g[0] & 0xe000) === 0x2000; // only global unicast 2000::/3 is ever routed to the public internet
}

/** True only for addresses on the public internet. Anything that doesn't parse is refused. */
export function isPublicIp(ip: string): boolean {
  const bare = ip.replace(/^\[|\]$/g, '');
  const v4 = parseV4(bare);
  if (v4) return v4Allowed(v4);
  if (net.isIPv6(bare) || bare.includes(':')) {
    const g = parseV6(bare);
    return !!g && v6Allowed(g);
  }
  return false;
}

/** Why a URL may not be fetched, or null when it may (host names are checked again when connecting). */
export function urlProblem(u: URL): string | null {
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return 'only http and https links can be previewed';
  if (u.username || u.password) return 'links with a login are not previewed';
  const host = u.hostname.toLowerCase().replace(/^\[|\]$/g, '');
  if (!host) return 'no host';
  if (allowPrivate()) return null;
  const port = u.port ? Number(u.port) : u.protocol === 'https:' ? 443 : 80;
  if (![80, 443, 8080, 8443].includes(port)) return 'unusual port';
  if (net.isIP(host) || host.includes(':')) return isPublicIp(host) ? null : 'address is not public';
  if (/^\d+$/.test(host) || /^0x[0-9a-f]+$/i.test(host)) return 'address is not public'; // legacy numeric IPv4 spellings
  if (!host.includes('.') || host.endsWith('.')) return 'not a public host name';
  if (/(^|\.)(localhost|local|internal|lan|home|intranet|corp|localdomain|home\.arpa|onion)$/.test(host)) return 'not a public host name';
  return null;
}

/** dns.lookup replacement that refuses to connect to non-public addresses (this is what defeats DNS rebinding). */
export function guardedLookup(hostname: string, options: any, cb: any) {
  const all = !!options?.all;
  dns.lookup(hostname, { all: true, verbatim: true }, (err, addrs) => {
    if (err) return cb(err);
    const ok = allowPrivate() ? addrs : addrs.filter((a) => isPublicIp(a.address));
    if (!ok.length || (!allowPrivate() && ok.length !== addrs.length)) {
      return cb(Object.assign(new Error(`${hostname} resolves to a non-public address`), { code: 'EBLOCKED' }));
    }
    if (all) cb(null, ok);
    else cb(null, ok[0].address, ok[0].family);
  });
}

// ---------- concurrency ----------

class Gate {
  private active = 0;
  private waiting: (() => void)[] = [];
  constructor(private max: number) {}
  async run<T>(fn: () => Promise<T>): Promise<T> {
    if (this.active >= this.max) await new Promise<void>((r) => this.waiting.push(r));
    this.active++;
    try {
      return await fn();
    } finally {
      this.active--;
      this.waiting.shift()?.();
    }
  }
}
const gate = new Gate(4);

// ---------- fetching ----------

// A plain browser-like agent: no names, no versions of this software, nothing personal.
const USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';

// Sites that refuse scripts posing as browsers (Wikipedia, for one) usually serve their tags to this plain agent.
const PLAIN_AGENT = 'Mozilla/5.0 (compatible; LinkPreview/1.0)';

export interface GuardedResponse {
  /** The URL that finally answered, after redirects. */
  url: URL;
  status: number;
  contentType: string;
  body: Buffer;
  /** True when the body was cut off at maxBytes. */
  truncated: boolean;
}

export interface GuardedOptions {
  maxBytes: number;
  accept: string;
  /** Total time for the whole fetch including redirects. */
  timeoutMs?: number;
  maxRedirects?: number;
  /** Stop reading as soon as this says so (e.g. once </head> has arrived). It sees each new chunk plus the last bytes before it. */
  enough?: (latest: Buffer) => boolean;
  /** Use the generic link-preview agent instead of the browser-like one (for sites that turn browsers-from-scripts away). */
  plainAgent?: boolean;
}

export class FetchRefused extends Error {}

export function guardedGet(start: URL, opts: GuardedOptions): Promise<GuardedResponse> {
  return gate.run(() => run(start, opts));
}

type Hop = { status: number; location?: string; contentType: string; body: Buffer; truncated: boolean };

/** Follows redirects by hand, vetting every hop. `hop` is the single-request function (replaceable in tests). */
export async function run(
  start: URL, opts: GuardedOptions, hop: (url: URL, opts: GuardedOptions, deadline: number) => Promise<Hop> = once,
): Promise<GuardedResponse> {
  const deadline = Date.now() + (opts.timeoutMs ?? 10_000);
  const maxRedirects = opts.maxRedirects ?? 4;
  let url = start;
  for (let n = 0; ; n++) {
    const problem = urlProblem(url);
    if (problem) throw new FetchRefused(problem);
    const res = await hop(url, opts, deadline);
    if ([301, 302, 303, 307, 308].includes(res.status) && res.location) {
      if (n >= maxRedirects) throw new FetchRefused('too many redirects');
      try {
        url = new URL(res.location, url);
      } catch {
        throw new FetchRefused('bad redirect');
      }
      continue;
    }
    return { url, status: res.status, contentType: res.contentType, body: res.body, truncated: res.truncated };
  }
}

function once(url: URL, opts: GuardedOptions, deadline: number) {
  return new Promise<Hop>((resolve, reject) => {
    const lib = url.protocol === 'https:' ? https : http;
    const left = deadline - Date.now();
    if (left <= 0) return reject(new FetchRefused('timed out'));
    let settled = false;
    const done = (fn: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      fn();
    };
    const req = lib.request(
      url,
      {
        method: 'GET',
        // IP literals skip DNS, and urlProblem() has already vetted them.
        lookup: guardedLookup as any,
        agent: false,
        headers: {
          'user-agent': opts.plainAgent ? PLAIN_AGENT : USER_AGENT,
          accept: opts.accept,
          'accept-language': 'en-US,en;q=0.9',
          'accept-encoding': 'gzip, deflate, br',
        },
      },
      (res) => {
        const status = res.statusCode ?? 0;
        const location = res.headers.location;
        if (location && status >= 300 && status < 400) {
          res.resume();
          return done(() => resolve({ status, location, contentType: '', body: Buffer.alloc(0), truncated: false }));
        }
        let stream: Readable = res;
        const enc = String(res.headers['content-encoding'] ?? '').toLowerCase();
        if (enc === 'gzip' || enc === 'x-gzip') stream = res.pipe(zlib.createGunzip());
        else if (enc === 'deflate') stream = res.pipe(zlib.createInflate());
        else if (enc === 'br') stream = res.pipe(zlib.createBrotliDecompress());
        else if (enc && enc !== 'identity') {
          res.destroy();
          return done(() => reject(new FetchRefused('unsupported encoding')));
        }
        const declared = Number(res.headers['content-length'] ?? 0);
        // Bodies we only want the start of are fine; for whole-file reads a huge declared size is refused up front.
        if (!opts.enough && declared > opts.maxBytes && !enc) {
          res.destroy();
          return done(() => reject(new FetchRefused('too large')));
        }
        const chunks: Buffer[] = [];
        let size = 0;
        let truncated = false;
        let tail: Buffer = Buffer.alloc(0);
        const finish = () => {
          const body = Buffer.concat(chunks);
          res.destroy();
          done(() => resolve({ status, contentType: String(res.headers['content-type'] ?? ''), body, truncated }));
        };
        stream.on('data', (c: Buffer) => {
          if (settled) return;
          size += c.length;
          const prevTail = tail;
          tail = c.subarray(Math.max(0, c.length - 16));
          chunks.push(size > opts.maxBytes ? c.subarray(0, c.length - (size - opts.maxBytes)) : c);
          if (size > opts.maxBytes) {
            truncated = true;
            stream.destroy();
            return finish();
          }
          if (opts.enough && opts.enough(Buffer.concat([prevTail, c]))) {
            truncated = true;
            stream.destroy();
            finish();
          }
        });
        stream.on('end', finish);
        stream.on('error', (e) => done(() => reject(e)));
        res.on('error', (e) => done(() => reject(e)));
      },
    );
    const timer = setTimeout(() => {
      req.destroy();
      done(() => reject(new FetchRefused('timed out')));
    }, left);
    req.on('error', (e) => done(() => reject(e)));
    req.end();
  });
}
