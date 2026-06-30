// scripts/test.mjs — unit tests for the pure (non-DOM) logic: source transport
// recognisers, IPFS gateway expansion, base64 round-trips, and manifest
// normalisation. Run: `npm test`  (node scripts/test.mjs).
//
// DOM/provider behaviour (player, providers, routing, auto-hide) is covered by
// the headless smoke in scripts/smoke.mjs.

import assert from 'node:assert/strict';
import {
  isMagnet, isIpfs, isHttp, isArweave, ipfsPath, ipfsGatewayUrls,
  arweavePath, arweaveGatewayUrls, httpCandidates,
  encodeBase64, decodeBase64, DEFAULT_IPFS_GATEWAYS,
} from '../docs/src/resolve.js';
import {
  persistProviders, DEFAULT_PERSIST_PROVIDER, PaymentNotConfiguredError,
} from '../docs/src/persist/index.js';
import { makePermanent, defaultStripeAdapter } from '../docs/src/persist/payments.js';
import { normaliseManifest } from '../docs/src/manifest.js';
import { SyncEngine } from '../docs/src/sync.js';
import { validate } from '../docs/src/schema-validate.js';
import { keccak256Utf8, toHex } from '../docs/src/crypto/keccak.js';
import { privToAddress, sign as secpSign, recoverAddress, sigToHex, sigFromHex, toChecksumAddress } from '../docs/src/crypto/secp256k1.js';
import {
  canonicalize, signEip191WithKey, signEd25519, generateEd25519,
  verifyManifest, describeSigner,
} from '../docs/src/sign.js';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

let passed = 0;
const tests = [];
const test = (name, fn) => tests.push([name, fn]);

// --- recognisers -----------------------------------------------------------
test('isMagnet', () => {
  assert.ok(isMagnet('magnet:?xt=urn:btih:abc'));
  assert.ok(isMagnet('  MAGNET:?xt=urn:btih:abc  '));
  assert.ok(!isMagnet('https://x/y'));
  assert.ok(!isMagnet('magnetic'));
});
test('isIpfs', () => {
  assert.ok(isIpfs('ipfs://bafkreigh2akiscaildc6vc7gznufx7vqg5ihrwujdq6e2htdpp7v2j6jzu'));
  assert.ok(isIpfs('QmYwAPJzv5CZsnA625s3Xf2nemtYgPpHdWEz79ojWnPbdG'));
  assert.ok(isIpfs('bafkreigh2akiscaildc6vc7gznufx7vqg5ihrwujdq6e2htdpp7v2j6jzu/index.html'));
  assert.ok(!isIpfs('https://ipfs.io/ipfs/QmFoo'));   // http url, not a bare cid
  assert.ok(!isIpfs('hello-world'));
});
test('isHttp', () => {
  assert.ok(isHttp('https://x'));
  assert.ok(isHttp('http://x'));
  assert.ok(!isHttp('ipfs://x'));
});

// --- ipfs gateway expansion ------------------------------------------------
test('ipfsPath strips prefixes', () => {
  assert.equal(ipfsPath('ipfs://CID/sub/file.mp4'), 'CID/sub/file.mp4');
  assert.equal(ipfsPath('ipfs/CID'), 'CID');
  assert.equal(ipfsPath('CID'), 'CID');
});
test('ipfsGatewayUrls: subdomain + path gateways, with subpath', () => {
  const urls = ipfsGatewayUrls('ipfs://CID/slides/index.html', DEFAULT_IPFS_GATEWAYS);
  assert.equal(urls[0], 'https://CID.ipfs.dweb.link/slides/index.html');
  assert.equal(urls[1], 'https://ipfs.io/ipfs/CID/slides/index.html');
  assert.equal(urls[2], 'https://cloudflare-ipfs.com/ipfs/CID/slides/index.html');
});
test('ipfsGatewayUrls: bare CID, no subpath', () => {
  const urls = ipfsGatewayUrls('CID');
  assert.equal(urls[0], 'https://CID.ipfs.dweb.link');
  assert.equal(urls[1], 'https://ipfs.io/ipfs/CID');
});
test('ipfsGatewayUrls: custom gateway without {cid} placeholder', () => {
  const urls = ipfsGatewayUrls('ipfs://CID/a.mp4', ['https://my.gw/']);
  assert.equal(urls[0], 'https://my.gw/ipfs/CID/a.mp4');
});
test('httpCandidates routes by transport', () => {
  assert.deepEqual(httpCandidates('https://x/y'), ['https://x/y']);
  assert.deepEqual(httpCandidates('magnet:?xt=1'), []);
  assert.equal(httpCandidates('ipfs://CID')[0], 'https://CID.ipfs.dweb.link');
});

// --- base64 ----------------------------------------------------------------
test('base64 round-trips (incl. unicode + url-safe)', () => {
  for (const s of ['hello', 'https://x/p2present.json', 'فارسی · 🎞️', '{"a":1}']) {
    assert.equal(decodeBase64(encodeBase64(s)), s);
  }
  // tolerate URL-safe alphabet + whitespace
  const b = encodeBase64('https://example.com/p2present.json?a=1&b=2');
  const urlSafe = b.replace(/\+/g, '-').replace(/\//g, '_');
  assert.equal(decodeBase64(urlSafe), 'https://example.com/p2present.json?a=1&b=2');
});

// --- manifest normalisation ------------------------------------------------
const BASE = 'https://host.example/talk/p2present.json';
const fullManifest = () => ({
  p2present: '1.0',
  title: 'T',
  meta: { author: 'A' },
  video: {
    sources: [
      { provider: 'webtorrent', src: 'magnet:?xt=urn:btih:deadbeef&dn=talk.mp4' },
      { provider: 'ipfs', src: 'ipfs://VIDCID/talk.mp4' },
      { provider: 'youtube', src: 'uYygWN1MZDE' },
      { provider: 'mp4', src: 'media/talk.mp4' },
    ],
    poster: 'media/poster.jpg',
  },
  deck: {
    type: 'html',
    sources: [
      { src: 'ipfs://DECKCID/index.html' },
      { src: 'magnet:?xt=urn:btih:cafe&dn=slides.html' },
      { src: 'slides/index.html' },
    ],
    slideCount: 3,
  },
  timing: [
    { time: '0:30', slide: 2, transition: 'fade' },
    { time: 0, slide: 1 },
  ],
  subtitles: [{ lang: 'en', src: 'subs/en.srt' }],
  resolvers: { ipfsGateways: ['https://g1/{cid}', 'https://g2/{cid}'] },
  layout: { split: 0.7, mode: 'overlap' },
});

test('normalise: video sources resolved by provider', () => {
  const m = normaliseManifest(fullManifest(), BASE);
  const v = m.video.sources;
  assert.equal(v[0].src, 'magnet:?xt=urn:btih:deadbeef&dn=talk.mp4'); // webtorrent verbatim
  assert.equal(v[1].src, 'ipfs://VIDCID/talk.mp4');                   // ipfs verbatim (provider resolves)
  assert.equal(v[2].src, 'uYygWN1MZDE');                             // youtube id verbatim
  assert.equal(v[3].src, 'https://host.example/talk/media/talk.mp4'); // mp4 resolved
  assert.equal(m.video.poster, 'https://host.example/talk/media/poster.jpg');
});
test('normalise: deck ipfs expands to gateway list, magnet kept, https resolved', () => {
  const m = normaliseManifest(fullManifest(), BASE);
  const d = m.deck.sources.map((s) => s.src);
  assert.equal(d[0], 'https://g1/DECKCID/index.html');   // ipfs → gateway 1
  assert.equal(d[1], 'https://g2/DECKCID/index.html');   // ipfs → gateway 2
  assert.equal(d[2], 'magnet:?xt=urn:btih:cafe&dn=slides.html'); // magnet kept
  assert.equal(d[3], 'https://host.example/talk/slides/index.html'); // https resolved
});
test('normalise: timing parsed + sorted, subtitle srt inferred', () => {
  const m = normaliseManifest(fullManifest(), BASE);
  assert.deepEqual(m.sync.map((c) => c.time), [0, 30]);
  assert.equal(m.sync[1].transition, 'fade');
  assert.equal(m.subtitles[0].format, 'srt');
  assert.equal(m.subtitles[0].src, 'https://host.example/talk/subs/en.srt');
});
test('normalise: resolvers + layout defaults/overrides', () => {
  const m = normaliseManifest(fullManifest(), BASE);
  assert.deepEqual(m.resolvers.ipfsGateways, ['https://g1/{cid}', 'https://g2/{cid}']);
  assert.ok(m.resolvers.webtorrentTrackers.length >= 1); // defaulted
  assert.equal(m.layout.split, 0.7);
  assert.equal(m.layout.mode, 'overlap');
});
test('normalise: default layout is p2p/PiP unless JSON overrides it', () => {
  const raw = fullManifest();
  delete raw.layout.mode;
  assert.equal(normaliseManifest(raw, BASE).layout.mode, 'overlap');
  raw.layout.mode = 'split';
  assert.equal(normaliseManifest(raw, BASE).layout.mode, 'split');
});
test('normalise: rejects missing video/deck', () => {
  assert.throws(() => normaliseManifest({ deck: { type: 'html', sources: [{ src: 'a' }] } }, BASE), /video/);
  assert.throws(() => normaliseManifest({ video: { sources: [{ provider: 'mp4', src: 'a' }] } }, BASE), /deck/);
});
test('normalise: rejects empty sources', () => {
  assert.throws(() => normaliseManifest({ video: { sources: [] }, deck: { type: 'html', sources: [{ src: 'a' }] } }, BASE), /video\.sources/);
});

// --- sync engine: timeline seek (bug-1 regression) -------------------------
// A fake video/deck so we can drive SyncEngine without a DOM. The scrubber is
// authoritative over the VIDEO: seekToTime must seek the video to the EXACT time
// (not the slide's cue time) and move the deck to the slide mapped to that time.
function fakeRig({ time = 0 } = {}) {
  const video = {
    _t: time, _playing: false,
    seek(s) { this._t = s; }, getTime() { return this._t; },
    getDuration() { return 1000; }, isPlaying() { return this._playing; },
  };
  const deck = {
    _current: 1, slideCount: 23, _handlers: {},
    on(ev, fn) { (this._handlers[ev] ||= []).push(fn); },
    goTo(n) { this._current = n; },
    get currentSlide() { return this._current; },
  };
  const cues = [
    { time: 0, slide: 1 }, { time: 100, slide: 2 }, { time: 500, slide: 6 },
    { time: 900, slide: 12 },
  ];
  return { video, deck, sync: new SyncEngine({ video, deck, cues }) };
}
test('sync.seekToTime: seeks video to the EXACT time + jumps the deck', () => {
  const { video, deck, sync } = fakeRig();
  sync.seekToTime(500);
  assert.equal(video.getTime(), 500);         // exact scrub time, not snapped
  assert.equal(deck.currentSlide, 6);         // slide mapped to t=500
});
test('sync.seekToTime: preserves a non-cue-boundary time', () => {
  const { video, deck, sync } = fakeRig();
  sync.seekToTime(640);                        // between cue 500(s6) and 900(s12)
  assert.equal(video.getTime(), 640);          // NOT snapped to 500
  assert.equal(deck.currentSlide, 6);          // still on slide 6
});
test('sync.seekToTime: when unlinked, seeks video but leaves the deck', () => {
  const { video, deck, sync } = fakeRig();
  sync.setLinked(false);
  sync.seekToTime(900);
  assert.equal(video.getTime(), 900);          // video still seeks (authoritative)
  assert.equal(deck.currentSlide, 1);          // deck untouched while unlinked
});
test('sync.seekToTime: clamps negative time to 0', () => {
  const { video, sync } = fakeRig({ time: 300 });
  sync.seekToTime(-50);
  assert.equal(video.getTime(), 0);
});

// --- schema validation (builder) -------------------------------------------
const SCHEMA = JSON.parse(readFileSync(
  join(dirname(fileURLToPath(import.meta.url)), '../docs/p2present.schema.json'), 'utf-8'));
const minimalValid = {
  p2present: '1.0', title: 'T',
  video: { sources: [{ provider: 'youtube', src: 'abc' }] },
  deck: { type: 'html', sources: [{ src: 'slides/index.html' }] },
  timing: [{ time: 0, slide: 1 }],
};
test('schema: a minimal valid manifest passes', () => {
  assert.ok(validate(minimalValid, SCHEMA).valid);
});
test('schema: missing video/deck flagged', () => {
  const r = validate({ p2present: '1.0' }, SCHEMA);
  assert.ok(!r.valid);
  assert.ok(r.errors.some((e) => /video/.test(e.path)));
  assert.ok(r.errors.some((e) => /deck/.test(e.path)));
});
test('schema: bad provider enum flagged', () => {
  const m = JSON.parse(JSON.stringify(minimalValid));
  m.video.sources[0].provider = 'vimeo';
  const r = validate(m, SCHEMA);
  assert.ok(!r.valid);
  assert.ok(r.errors.some((e) => /provider/.test(e.path) && /one of/.test(e.message)));
});
test('schema: empty video.sources flagged (minItems)', () => {
  const m = JSON.parse(JSON.stringify(minimalValid));
  m.video.sources = [];
  assert.ok(!validate(m, SCHEMA).valid);
});
test('schema: timing accepts inline array OR string (oneOf)', () => {
  assert.ok(validate({ ...minimalValid, timing: 'timing.json' }, SCHEMA).valid);
  assert.ok(validate({ ...minimalValid, timing: [{ slide: 2 }] }, SCHEMA).valid);
});
test('schema: deck.thumbnails accepts both shapes', () => {
  const a = { ...minimalValid, deck: { ...minimalValid.deck, thumbnails: ['a.png', 'b.png'] } };
  const b = { ...minimalValid, deck: { ...minimalValid.deck, thumbnails: [{ slide: 1, src: 'a.png' }] } };
  assert.ok(validate(a, SCHEMA).valid);
  assert.ok(validate(b, SCHEMA).valid);
});

// --- signed manifests (Phase 8) --------------------------------------------
// Known secp256k1 vector: privkey → its Ethereum address (web3.js test key).
const ETH_KEY = '0x4c0883a69102937d6231471b5dbb6204fe5129617082792ae468d01a3f362318';
const ETH_ADDR = '0x2c7536E3605D9C16a7a3D7b1898e529396a65c23';
const signable = () => ({
  p2present: '1.0', title: 'Signed Talk',
  meta: { author: 'A' },
  video: { sources: [{ provider: 'youtube', src: 'abc' }] },
  deck: { type: 'html', sources: [{ src: 'slides/index.html' }], slideCount: 3 },
  timing: [{ time: 0, slide: 1 }, { time: 30, slide: 2 }],
});

test('keccak256 matches a known vector', () => {
  assert.equal(toHex(keccak256Utf8('abc')),
    '4e03657aea45a94fc7d47ba826c8d667c0d1e6e33a64a036ec44f58fa12d6c45');
});
test('secp256k1: privkey → address vector + EIP-55 checksum', () => {
  assert.equal(privToAddress(ETH_KEY), ETH_ADDR.toLowerCase());
  assert.equal(toChecksumAddress(privToAddress(ETH_KEY)), ETH_ADDR);
  assert.equal(privToAddress(1n), '0x7e5f4552091a69125d5dfcb7b8c2659029395bdf');
});
test('secp256k1: sign → recover round-trips (incl. hex pack/parse)', () => {
  const h = keccak256Utf8('p2present');
  const sig = secpSign(h, ETH_KEY);
  assert.equal(recoverAddress(h, sig), ETH_ADDR.toLowerCase());
  assert.equal(recoverAddress(h, sigFromHex(sigToHex(sig))), ETH_ADDR.toLowerCase());
});

test('canonicalize: key order independent, array order preserved', () => {
  assert.equal(canonicalize({ b: 1, a: 2, c: [3, { z: 1, y: 2 }] }),
    canonicalize({ c: [3, { y: 2, z: 1 }], a: 2, b: 1 }));
  assert.equal(canonicalize({ a: 2, b: 1, c: [3, { y: 2, z: 1 }] }),
    '{"a":2,"b":1,"c":[3,{"y":2,"z":1}]}');
  assert.notEqual(canonicalize([1, 2]), canonicalize([2, 1]));   // arrays are ordered
});

test('sign eip191 (raw key): valid round trip; signer = the key address', async () => {
  const signed = signEip191WithKey(signable(), ETH_KEY);
  assert.equal(signed.sig.alg, 'eip191');
  assert.equal(signed.sig.signer.address, ETH_ADDR);
  const v = await verifyManifest(signed);
  assert.equal(v.state, 'valid');
  assert.equal(v.signer.address, ETH_ADDR);
  const d = await describeSigner(v, { resolveEns: false });
  assert.equal(d.kind, 'address');
});
test('sign eip191: tampering any signed field invalidates it', async () => {
  const signed = signEip191WithKey(signable(), ETH_KEY);
  for (const mutate of [
    (m) => { m.title = 'Hacked'; },
    (m) => { m.deck.slideCount = 99; },
    (m) => { m.timing[0].slide = 5; },
    (m) => { m.video.sources[0].src = 'evil'; },
    (m) => { m.sig.signer.address = '0x0000000000000000000000000000000000000001'; },
  ]) {
    const t = JSON.parse(JSON.stringify(signed));
    mutate(t);
    assert.equal((await verifyManifest(t)).state, 'invalid');
  }
});
test('sign eip191: a corrupt signature is invalid, not throwing', async () => {
  const signed = signEip191WithKey(signable(), ETH_KEY);
  signed.sig.signature = '0x' + 'ab'.repeat(65);
  const v = await verifyManifest(signed);
  assert.equal(v.state, 'invalid');
});

test('sign ed25519: valid round trip + domain bound into the signature', async () => {
  const kp = await generateEd25519();
  const signed = await signEd25519(signable(), { ...kp, domain: 'example.com' });
  assert.equal(signed.sig.alg, 'ed25519');
  assert.equal(signed.sig.signer.key, kp.publicKey);
  assert.equal((await verifyManifest(signed)).state, 'valid');
  // tamper content
  const t1 = JSON.parse(JSON.stringify(signed)); t1.title = 'X';
  assert.equal((await verifyManifest(t1)).state, 'invalid');
  // tamper the bound domain label
  const t2 = JSON.parse(JSON.stringify(signed)); t2.sig.signer.domain = 'evil.com';
  assert.equal((await verifyManifest(t2)).state, 'invalid');
  const d = await describeSigner(await verifyManifest(signed), { resolveEns: false });
  assert.equal(d.label, 'example.com');
});

test('unsigned manifest verifies as "unsigned" (never invalid)', async () => {
  assert.equal((await verifyManifest(signable())).state, 'unsigned');
  assert.equal((await verifyManifest({ ...signable(), sig: { alg: 'eip191' } })).state, 'unsigned');
});

test('schema: a signed manifest validates; a sig missing fields is flagged', () => {
  const signed = signEip191WithKey(signable(), ETH_KEY);
  assert.ok(validate(signed, SCHEMA).valid);
  const bad = JSON.parse(JSON.stringify(signed)); delete bad.sig.signature;
  const r = validate(bad, SCHEMA);
  assert.ok(!r.valid && r.errors.some((e) => /signature/.test(e.path)));
  const bad2 = JSON.parse(JSON.stringify(signed)); bad2.sig.alg = 'rsa';
  assert.ok(!validate(bad2, SCHEMA).valid);
});

// --- arweave (ar://) transport ---------------------------------------------
test('isArweave + arweavePath + gateway expansion', () => {
  assert.ok(isArweave('ar://abc123'));
  assert.ok(isArweave('  AR://abc123/poster.png '));
  assert.ok(!isArweave('https://arweave.net/abc'));
  assert.equal(arweavePath('ar://TX/sub/a.mp4'), 'TX/sub/a.mp4');
  const urls = arweaveGatewayUrls('ar://TX/a.mp4');
  assert.equal(urls[0], 'https://arweave.net/TX/a.mp4');
  assert.equal(urls[1], 'https://ar-io.net/TX/a.mp4');
  assert.equal(httpCandidates('ar://TX')[0], 'https://arweave.net/TX');
});
test('normalise: ar:// video (mp4) resolves to gateway; deck ar:// expands', () => {
  const m = normaliseManifest({
    p2present: '1.0', title: 'AR',
    video: { sources: [{ provider: 'mp4', src: 'ar://VIDTX/talk.mp4' }], poster: 'ar://POSTERTX' },
    deck: { type: 'html', sources: [{ src: 'ar://DECKTX/index.html' }] },
    timing: [{ time: 0, slide: 1 }],
  }, BASE);
  assert.equal(m.video.sources[0].src, 'https://arweave.net/VIDTX/talk.mp4');
  assert.equal(m.video.poster, 'https://arweave.net/POSTERTX');
  assert.equal(m.deck.sources[0].src, 'https://arweave.net/DECKTX/index.html');
  assert.equal(m.deck.sources[1].src, 'https://ar-io.net/DECKTX/index.html'); // gateway 2
});

// --- persistence providers (mock uploads) ----------------------------------
// A fake Response factory + a recording fetch so providers never hit the network.
function fakeRes({ ok = true, status = 200, json, text = '' } = {}) {
  return { ok, status, async json() { return json; }, async text() { return text; } };
}
function recordingFetch(reply) {
  const calls = [];
  const fn = async (url, init) => { calls.push({ url, init }); return reply(url, init); };
  fn.calls = calls;
  return fn;
}
const aFile = (name = 'note.txt', body = 'hi', type = 'text/plain') =>
  new File([body], name, { type });
const provider = (id, config, deps) => new (persistProviders.get(id))(config, deps);

test('persist registry: arweave is the default + permanent; all schemes present', () => {
  assert.equal(DEFAULT_PERSIST_PROVIDER, 'arweave');
  assert.deepEqual(persistProviders.list(), ['arweave', 'pinning', 'seedbox', 's3']);
  const A = persistProviders.get('arweave');
  assert.equal(A.scheme, 'ar');
  assert.equal(A.permanent, true);
  assert.deepEqual(
    ['pinning', 'seedbox', 's3'].map((id) => persistProviders.get(id).scheme),
    ['ipfs', 'magnet', 'https']);
});

test('pinning (pinata): mock pin → ipfs:// ref + gateway; missing token throws', async () => {
  const fetch = recordingFetch(() => fakeRes({ json: { IpfsHash: 'bafkMOCKCID' } }));
  const p = provider('pinning', { service: 'pinata', token: 'JWT' }, { fetch });
  const r = await p.put(aFile());
  assert.equal(r.ref, 'ipfs://bafkMOCKCID');
  assert.equal(r.scheme, 'ipfs');
  assert.equal(r.gateway, 'https://bafkMOCKCID.ipfs.dweb.link');
  assert.match(fetch.calls[0].url, /pinata\.cloud/);
  await assert.rejects(
    provider('pinning', { service: 'pinata' }, { fetch }).put(aFile()), /token/i);
});
test('pinning (web3.storage): mock upload → ipfs:// from {cid}', async () => {
  const fetch = recordingFetch(() => fakeRes({ json: { cid: 'bafkW3' } }));
  const r = await provider('pinning', { service: 'web3storage', token: 'T' }, { fetch }).put(aFile());
  assert.equal(r.ref, 'ipfs://bafkW3');
  assert.match(fetch.calls[0].url, /web3\.storage/);
});

test('s3/https: PUT to presigned URL → public https ref (query stripped)', async () => {
  const fetch = recordingFetch(() => fakeRes({}));
  const r = await provider('s3', { putUrl: 'https://b.s3.aws/key?X-Sig=abc' }, { fetch }).put(aFile());
  assert.equal(r.ref, 'https://b.s3.aws/key');     // query dropped by default
  assert.equal(r.scheme, 'https');
  assert.equal(fetch.calls[0].init.method, 'PUT');
  // explicit publicUrl wins
  const r2 = await provider('s3',
    { putUrl: 'https://up/x?sig=1', publicUrl: 'https://cdn/x' }, { fetch }).put(aFile());
  assert.equal(r2.ref, 'https://cdn/x');
});

test('arweave: with an upload endpoint → ar:// ref + permanent + gateway', async () => {
  const fetch = recordingFetch(() => fakeRes({ json: { id: 'TX42' } }));
  const r = await provider('arweave', { endpoint: 'https://node/tx', token: 'k' }, { fetch }).put(aFile());
  assert.equal(r.ref, 'ar://TX42');
  assert.equal(r.scheme, 'ar');
  assert.equal(r.permanent, true);
  assert.equal(r.gateway, 'https://arweave.net/TX42');
  assert.equal(fetch.calls[0].init.headers.Authorization, 'Bearer k');
});
test('arweave: no endpoint + no payment rail → PaymentNotConfiguredError (documented, not a crash)', async () => {
  const err = await provider('arweave', {}, {}).put(aFile()).then(() => null, (e) => e);
  assert.ok(err instanceof PaymentNotConfiguredError, String(err));
  assert.match(err.message, /permanent/i);
});
test('arweave: a wired payment rail funds, but still needs an endpoint to spend it', async () => {
  const payments = { stripe: async () => ({ receipt: 'rcpt_1' }) };
  const err = await provider('arweave', {}, { payments }).put(aFile()).then(() => null, (e) => e);
  assert.ok(err instanceof PaymentNotConfiguredError);
  assert.match(err.message, /upload endpoint/i);
});

// --- payments adapter boundary ----------------------------------------------
test('makePermanent: injected stripe adapter funds + returns a receipt', async () => {
  const adapters = { stripe: async ({ provider }) => ({ receipt: `rc_${provider}`, jobId: 'job1' }) };
  const out = await makePermanent({ provider: 'arweave', file: aFile(), adapters });
  assert.equal(out.method, 'stripe');
  assert.equal(out.receipt, 'rc_arweave');
  assert.equal(out.jobId, 'job1');
});
test('makePermanent: prefers onchain when both rails are present; method overrides', async () => {
  const adapters = { onchain: async () => ({ receipt: 'chain' }), stripe: async () => ({ receipt: 'fiat' }) };
  assert.equal((await makePermanent({ file: aFile(), adapters })).receipt, 'chain');
  assert.equal((await makePermanent({ file: aFile(), method: 'stripe', adapters })).receipt, 'fiat');
});
test('makePermanent: no rail → PaymentNotConfiguredError', async () => {
  const err = await makePermanent({ file: aFile(), adapters: {} }).then(() => null, (e) => e);
  assert.ok(err instanceof PaymentNotConfiguredError, String(err));
});
test('defaultStripeAdapter: POSTs checkout + returns the jobId (no DOM → no redirect)', async () => {
  let seen;
  const fetch = async (url, init) => {
    seen = { url, body: JSON.parse(init.body) };
    return fakeRes({ json: { jobId: 'job_42', url: 'https://checkout.stripe.com/c/x', amount: 220 } });
  };
  const stripe = defaultStripeAdapter('https://pay.example', { fetch });
  const out = await stripe({ provider: 'arweave', file: aFile('talk.mp4') });
  assert.match(seen.url, /\/api\/pay\/checkout$/);
  assert.equal(seen.body.provider, 'arweave');
  assert.equal(seen.body.name, 'talk.mp4');
  assert.equal(out.receipt, 'job_42');
  assert.equal(out.jobId, 'job_42');
});
test('defaultStripeAdapter: surfaces a 501 as PaymentNotConfiguredError', async () => {
  const fetch = async () => ({ ok: false, status: 501, json: async () => ({ error: 'not_configured' }) });
  const stripe = defaultStripeAdapter('https://pay.example', { fetch });
  const err = await stripe({ provider: 'arweave', file: aFile() }).then(() => null, (e) => e);
  assert.ok(err instanceof PaymentNotConfiguredError, String(err));
});

test('seedbox: in-tab seed → magnet ref; seedbox URL marks it always-on', async () => {
  const wtClient = { seed: (file, opts, cb) => cb({ magnetURI: 'magnet:?xt=urn:btih:deadbeef' }) };
  const getWebTorrent = async () => wtClient;
  const r = await provider('seedbox', { trackers: 'wss://t1\n wss://t2 ' }, { getWebTorrent }).put(aFile('v.mp4'));
  assert.equal(r.ref, 'magnet:?xt=urn:btih:deadbeef');
  assert.equal(r.scheme, 'magnet');
  assert.equal(r.extra.alwaysOn, false);
  // with a seedbox endpoint that accepts the magnet → alwaysOn
  const fetch = recordingFetch(() => fakeRes({}));
  const r2 = await provider('seedbox',
    { seedboxUrl: 'https://seed/box', seedboxToken: 'tk' }, { getWebTorrent, fetch }).put(aFile('v.mp4'));
  assert.equal(r2.extra.alwaysOn, true);
  assert.match(fetch.calls[0].init.body, /magnet:/);
  assert.equal(fetch.calls[0].init.headers.Authorization, 'Bearer tk');
});

// --- runner ----------------------------------------------------------------
let failed = 0;
for (const [name, fn] of tests) {
  try { await fn(); passed++; console.log('  ✓', name); }
  catch (err) { failed++; console.error('  ✗', name, '\n     ', err.message); }
}
console.log(`\n${passed}/${tests.length} passed${failed ? `, ${failed} FAILED` : ''}.`);
process.exit(failed ? 1 : 0);
