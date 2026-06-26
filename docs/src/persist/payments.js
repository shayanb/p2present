// persist/payments.js — payment hooks for "make it permanent" (STUBBED).
//
// Making a file *permanent* (Arweave pay-once) or *rented* (a pinning service /
// always-on seedbox) costs money. p2present is a static, server-less site, so it
// ships NO live payment keys — instead it defines a clean adapter boundary you
// wire to your own backend when you operate a paid "make permanent" button.
//
// Two adapters, both no-ops here until configured:
//   • Stripe (fiat)   — a hosted-checkout / payment-intent flow handled by YOUR
//                        server, which then funds the upload and returns a credit.
//   • On-chain rent   — a wallet pays an Arweave/Irys (or filecoin/storage) node
//                        directly; the signed receipt funds the upload.
//
// To wire a real flow, set `window.__P2_PAYMENTS = { stripe?, onchain? }` (see
// SERVICE.md → "Wiring the Make-permanent button"). Until then `makePermanent`
// throws PaymentNotConfiguredError with a clear, user-facing message — the host
// UI surfaces it as an actionable status rather than a crash.

export class PaymentNotConfiguredError extends Error {
  constructor(message) {
    super(message);
    this.name = 'PaymentNotConfiguredError';
    this.code = 'PAYMENT_NOT_CONFIGURED';
  }
}

// Where a wired deployment injects its adapters (kept off the module so a static
// build has nothing to configure and tests can pass their own).
export function configuredPayments() {
  return (typeof window !== 'undefined' && window.__P2_PAYMENTS) || null;
}

const NOT_WIRED =
  'Permanent storage needs a funded upload. This static build ships no payment ' +
  'keys — wire Stripe (fiat) or an on-chain rent path (see SERVICE.md → "Make it ' +
  'permanent"), or paste an Arweave upload-service endpoint + token above to ' +
  'upload directly with credits you already hold.';

/**
 * Pay for, and obtain credit toward, a permanent upload.
 *
 * @param {object} opts
 *   - provider : 'arweave' | …   the persistence provider asking to be funded
 *   - file     : File            (for size → price estimation by a real backend)
 *   - method   : 'stripe' | 'onchain'   preferred rail (optional)
 *   - onProgress: (msg) => void
 *   - adapters : { stripe?, onchain? }  injected hooks (defaults to window.__P2_PAYMENTS)
 * @returns {Promise<{ receipt:string, method:string }>}  funding receipt
 * @throws {PaymentNotConfiguredError} when no adapter is wired
 *
 * ADAPTER CONTRACT (implement on YOUR side):
 *   stripe(opts)  → start checkout / confirm a PaymentIntent on your server,
 *                   return { receipt } once your server has funded the upload.
 *   onchain(opts) → request a wallet signature / tx that pays the storage node,
 *                   return { receipt } (the tx hash / data-item receipt).
 */
export async function makePermanent({ provider, file, method, onProgress, adapters } = {}) {
  const cfg = adapters || configuredPayments();
  const rail = method || (cfg && (cfg.onchain ? 'onchain' : cfg.stripe ? 'stripe' : null));

  if (cfg && rail && typeof cfg[rail] === 'function') {
    onProgress?.(`Starting ${rail} payment for permanent storage…`);
    const out = await cfg[rail]({ provider, file, onProgress });
    if (!out || !out.receipt) throw new Error(`${rail} payment returned no receipt.`);
    return { receipt: out.receipt, method: rail };
  }

  // --- STUB: no rail wired. Document both paths inline for whoever wires it. ---
  // TODO(payments): implement ONE of these on your backend and inject via
  // window.__P2_PAYMENTS = { stripe, onchain }.
  //
  //   stripe: async ({ file }) => {
  //     // 1. POST file size to /api/quote → { amount, currency }
  //     // 2. redirect to Stripe Checkout (or confirm a PaymentIntent)
  //     // 3. your webhook funds an Arweave/Irys upload, returns a credit id
  //     return { receipt: creditId };
  //   }
  //   onchain: async ({ file }) => {
  //     // 1. estimate bytes → winston/AR (or the node's quote endpoint)
  //     // 2. const tx = await irys.fund(price)  // wallet signs
  //     return { receipt: tx.id };
  //   }
  throw new PaymentNotConfiguredError(NOT_WIRED);
}
