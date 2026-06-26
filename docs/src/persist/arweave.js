// persist/arweave.js — Arweave provider (ar://). The DEFAULT "make it permanent"
// path: pay once, the data lives on the permaweb forever (no recurring rent).
//
// A static page can't sign + fund an Arweave transaction without a heavy wallet
// bundle, so this provider uploads through an *upload service* the user points it
// at — an Irys/Turbo (ArDrive) node or any bundler endpoint that accepts an
// authenticated POST of the file bytes and returns a JSON body carrying the tx
// id. Funding that upload is the job of the payment hook (see payments.js):
//   • endpoint configured  → POST the bytes, get ar://<txid> back.
//   • no endpoint          → invoke makePermanent() (Stripe / on-chain rent stub),
//                            which is documented-but-unwired in this build.

import { BasePersistenceProvider } from './base.js';
import { makePermanent, PaymentNotConfiguredError } from './payments.js';

export class ArweaveProvider extends BasePersistenceProvider {
  static id = 'arweave';
  static label = 'Arweave — permanent (pay once)';
  static scheme = 'ar';
  static permanent = true;
  static action = 'Make permanent 💎';
  static blurb = 'Pay once, stored forever on the permaweb. Returns an ar:// reference.';
  static note =
    'Arweave is pay-once permanent storage. Point this at an upload service you ' +
    'fund yourself (an Irys / Turbo node, or any bundler that accepts an ' +
    'authenticated POST and returns a tx id) — the endpoint + token are stored ' +
    'ONLY in this browser. With no endpoint, the “Make permanent” button calls the ' +
    'payment hook (Stripe / on-chain rent), which is documented but unwired in this ' +
    'static build — see SERVICE.md.';
  static fields = [
    {
      key: 'endpoint', label: 'Upload service URL', type: 'text', optional: true,
      placeholder: 'https://turbo.ardrive.io/tx  (Irys/Turbo/bundler that returns {id})',
    },
    {
      key: 'token', label: 'Service token (Bearer)', type: 'password', optional: true,
      placeholder: 'optional — depends on your node',
    },
  ];

  async put(file, { onProgress } = {}) {
    const endpoint = this.cfg('endpoint');

    if (!endpoint) {
      // No direct upload endpoint → this is where money changes hands. The hook
      // is stubbed: it throws a documented PaymentNotConfiguredError we surface.
      onProgress?.('Requesting permanent-storage funding…');
      await makePermanent({
        provider: 'arweave', file, onProgress,
        adapters: this.payments,                 // tests inject; browser uses window.__P2_PAYMENTS
      }).catch((err) => {
        if (err instanceof PaymentNotConfiguredError) throw err;
        throw new Error(`Permanent-storage payment failed: ${err.message}`);
      });
      // A wired deployment would now hold a funding receipt and continue to an
      // upload; with only the stub there is nothing to upload to, so stop here.
      throw new PaymentNotConfiguredError(
        'Payment succeeded but no upload endpoint is configured to spend it on. ' +
        'Set the Arweave upload service URL above.');
    }

    onProgress?.('Uploading to Arweave…');
    const token = this.cfg('token');
    const headers = { 'Content-Type': file.type || 'application/octet-stream' };
    if (token) headers.Authorization = `Bearer ${token}`;
    const res = await this.fetch(endpoint, { method: 'POST', headers, body: file });
    if (!res.ok) {
      throw new Error(`Arweave upload HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`);
    }
    const j = await res.json().catch(() => ({}));
    // Bundlers differ: Irys/Turbo return {id}; some return {txid}/{transaction}.
    const txid = j.id || j.txid || j.transaction || j.transactionId;
    if (!txid) throw new Error('Upload response had no transaction id (expected {id}).');

    return {
      ref: `ar://${txid}`,
      scheme: 'ar',
      name: file.name,
      permanent: true,
      gateway: `https://arweave.net/${txid}`,
    };
  }
}
