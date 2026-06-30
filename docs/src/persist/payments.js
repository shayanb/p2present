// persist/payments.js — payment hooks for "make it permanent".
//
// Making a file *permanent* (Arweave pay-once) or *rented* (a pinning service /
// always-on seedbox) costs money. p2present is a static, server-less site, so it
// ships NO live payment keys — instead it defines a clean adapter boundary and a
// ready-made Stripe rail you point at YOUR payments Worker (service/, deployed
// from wrangler.payments.toml). Nothing here embeds a key.
//
// Two adapters:
//   • Stripe (fiat)   — a hosted Checkout flow handled by your payments Worker,
//                        whose webhook funds the upload and records a permanent
//                        reference the browser polls back. A default adapter is
//                        built automatically when a payments base URL is
//                        configured (see `paymentsBase()`), so a wired deploy
//                        needs no glue code.
//   • On-chain rent   — a wallet pays an Arweave/Irys (or filecoin/storage) node
//                        directly; the signed receipt funds the upload. Still a
//                        stub here (see docs/CRYPTO-PAYMENTS.md for the design).
//
// You can always override either adapter explicitly via
// `window.__P2_PAYMENTS = { stripe?, onchain? }`. With neither an explicit
// adapter NOR a payments base configured, `makePermanent` throws
// PaymentNotConfiguredError with a clear, user-facing message — the host UI
// surfaces it as an actionable status rather than a crash.

export class PaymentNotConfiguredError extends Error {
  constructor(message) {
    super(message);
    this.name = 'PaymentNotConfiguredError';
    this.code = 'PAYMENT_NOT_CONFIGURED';
  }
}

const NOT_WIRED =
  'Permanent storage needs a funded upload. This static build ships no payment ' +
  'keys — wire Stripe (point the page at a payments Worker, see SERVICE.md → "Make ' +
  'it permanent") or an on-chain rent path (docs/CRYPTO-PAYMENTS.md), or paste an ' +
  'Arweave upload-service endpoint + token above to upload directly with credits ' +
  'you already hold.';

const stripTrailing = (s) => String(s || '').replace(/\/+$/, '');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// --- payments service base URL ----------------------------------------------
// Resolved like the Save-&-share service base (service.js): first match wins.
//   1. ?payments=<base>          per-link override (used by tests/smoke)
//   2. window.__P2_PAYMENTS_BASE injected before the page scripts
//   3. <meta name="p2present:payments" content="https://…">
//   4. localStorage['p2present:payments']  sticky per-browser override
// Returns null when nothing is configured (→ graceful "not configured" stub).
export function paymentsBase() {
  if (typeof window === 'undefined') return null;
  try {
    const q = new URLSearchParams(location.search).get('payments');
    if (q) return stripTrailing(q);
  } catch {}
  if (window.__P2_PAYMENTS_BASE) return stripTrailing(window.__P2_PAYMENTS_BASE);
  try {
    const meta = document.querySelector('meta[name="p2present:payments"]');
    if (meta?.content) return stripTrailing(meta.content);
  } catch {}
  try {
    const ls = localStorage.getItem('p2present:payments');
    if (ls) return stripTrailing(ls);
  } catch {}
  return null;
}

const PENDING_KEY = 'p2present:pendingPay';

/**
 * A ready-made Stripe adapter bound to a payments-Worker base URL. It creates a
 * Checkout Session for the upload, remembers the job, and redirects the browser
 * to Stripe. After payment the browser returns to this page with `?p2pay=…&job=…`
 * — call `resumePendingPermanent()` on load to poll the resulting reference.
 *
 * @param {string} base   payments Worker origin (no trailing slash)
 * @param {object} deps   { fetch } injectable for tests
 */
export function defaultStripeAdapter(base, deps = {}) {
  const f = deps.fetch || ((...a) => globalThis.fetch(...a));
  return async function stripe({ provider, file, onProgress }) {
    onProgress?.('Creating secure checkout…');
    const res = await f(`${base}/api/pay/checkout`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        provider: provider || 'arweave',
        bytes: file?.size || 0,
        name: file?.name || 'asset',
        returnUrl: typeof location !== 'undefined' ? location.href : undefined,
      }),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      if (res.status === 501) throw new PaymentNotConfiguredError(NOT_WIRED);
      throw new Error(data?.detail || data?.error || `checkout failed (HTTP ${res.status})`);
    }
    if (!data.url || !data.jobId) throw new Error('checkout returned no redirect URL.');

    // Remember which job we're waiting on so resume can reflect the ref back.
    try {
      localStorage.setItem(PENDING_KEY, JSON.stringify({
        jobId: data.jobId, provider, name: file?.name || 'asset', amount: data.amount, ts: Date.now(),
      }));
    } catch {}

    onProgress?.('Redirecting to Stripe Checkout…');
    if (typeof location !== 'undefined' && location) {
      location.href = data.url;
      await new Promise(() => {}); // suspend — the page is navigating to Stripe
    }
    return { receipt: data.jobId, jobId: data.jobId, redirect: data.url };
  };
}

// Where a wired deployment injects its adapters. An explicit window.__P2_PAYMENTS
// wins; otherwise a default Stripe adapter is synthesized from the payments base.
export function configuredPayments(deps = {}) {
  if (typeof window !== 'undefined' && window.__P2_PAYMENTS) return window.__P2_PAYMENTS;
  const base = paymentsBase();
  if (base) return { stripe: defaultStripeAdapter(base, deps), _base: base };
  return null;
}

/**
 * Pay for, and obtain credit toward, a permanent upload.
 *
 * @param {object} opts
 *   - provider : 'arweave' | …   the persistence provider asking to be funded
 *   - file     : File            (for size → price estimation by the backend)
 *   - method   : 'stripe' | 'onchain'   preferred rail (optional)
 *   - onProgress: (msg) => void
 *   - adapters : { stripe?, onchain? }  injected hooks (defaults to configuredPayments())
 * @returns {Promise<{ receipt:string, method:string }>}  funding receipt
 * @throws {PaymentNotConfiguredError} when no adapter is wired
 *
 * ADAPTER CONTRACT:
 *   stripe(opts)  → start Checkout on your payments Worker; in the browser this
 *                   redirects and never returns (resume via resumePendingPermanent).
 *   onchain(opts) → request a wallet signature / tx that pays the storage node,
 *                   return { receipt } (the tx hash / data-item receipt).
 */
export async function makePermanent({ provider, file, method, onProgress, adapters } = {}) {
  const cfg = adapters || configuredPayments();
  // Prefer on-chain when explicitly present; otherwise Stripe. Caller can force
  // a rail with `method`.
  const rail = method || (cfg && (cfg.onchain ? 'onchain' : cfg.stripe ? 'stripe' : null));

  if (cfg && rail && typeof cfg[rail] === 'function') {
    onProgress?.(`Starting ${rail} payment for permanent storage…`);
    const out = await cfg[rail]({ provider, file, onProgress });
    if (!out || !out.receipt) throw new Error(`${rail} payment returned no receipt.`);
    return { receipt: out.receipt, method: rail, jobId: out.jobId };
  }

  // --- No rail wired. Document both paths for whoever wires it. ---------------
  // TODO(payments): either deploy the payments Worker (service/payments-worker.js)
  // and point this page at it (see paymentsBase()), or inject your own adapter via
  // window.__P2_PAYMENTS = { stripe, onchain }. See docs/CRYPTO-PAYMENTS.md for the
  // on-chain rail design.
  throw new PaymentNotConfiguredError(NOT_WIRED);
}

/**
 * Resume a Stripe redirect after the browser returns from Checkout. Reads the
 * `?p2pay=…&job=…` params, polls the payments Worker for the resulting permanent
 * reference, and returns it for the host page to reflect into the manifest.
 *
 * @param {object} deps  { fetch, onProgress, attempts, intervalMs }
 * @returns {Promise<null | { status, jobId, ref?, scheme?, name?, provider?, note? }>}
 *   null when there is nothing to resume (no return params present).
 */
export async function resumePendingPermanent(deps = {}) {
  if (typeof window === 'undefined') return null;
  let params;
  try { params = new URLSearchParams(location.search); } catch { return null; }
  const status = params.get('p2pay');
  const jobId = params.get('job');
  if (!status || !jobId) return null;

  const pending = readPending(jobId);
  clearPayParams();          // so a refresh doesn't re-trigger
  if (jobId) clearPending();

  if (status !== 'success') return { status: 'cancelled', jobId, ...pending };

  const base = paymentsBase();
  if (!base) return { status: 'no_base', jobId, ...pending };

  const f = deps.fetch || ((...a) => globalThis.fetch(...a));
  const attempts = deps.attempts ?? 20;
  const intervalMs = deps.intervalMs ?? 1500;
  for (let i = 0; i < attempts; i++) {
    try {
      const r = await f(`${base}/api/pay/result?jobId=${encodeURIComponent(jobId)}`);
      if (r.ok) {
        const d = await r.json();
        if (d.ref) return { status: 'persisted', jobId, ref: d.ref, scheme: d.scheme, ...pending };
        if (d.status === 'paid_pending_backend' || d.status === 'paid_backend_error') {
          return { status: d.status, jobId, note: d.note, ...pending };
        }
        deps.onProgress?.(`Finalizing permanent storage… (${d.status || 'working'})`);
      }
    } catch { /* transient — keep polling */ }
    await sleep(intervalMs);
  }
  return { status: 'timeout', jobId, ...pending };
}

// --- pending-job bookkeeping (localStorage) ---------------------------------

function readPending(jobId) {
  try {
    const p = JSON.parse(localStorage.getItem(PENDING_KEY) || 'null');
    if (p && p.jobId === jobId) return { name: p.name, provider: p.provider };
  } catch {}
  return {};
}
function clearPending() { try { localStorage.removeItem(PENDING_KEY); } catch {} }

function clearPayParams() {
  try {
    const u = new URL(location.href);
    u.searchParams.delete('p2pay');
    u.searchParams.delete('job');
    history.replaceState(null, '', u.toString());
  } catch {}
}
