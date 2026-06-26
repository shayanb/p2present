// persist/index.js — persistence-provider registry + interface contract.
//
// A PersistenceProvider takes a File and returns a *manifest reference* — the
// string you paste into a video / deck / subtitle source. It mirrors the
// video-provider pattern (Registry + a base class + one module per provider):
//
//   static id        unique key ('arweave', 'pinning', …)
//   static label     human name for the picker
//   static scheme    ref scheme produced: 'ar' | 'ipfs' | 'magnet' | 'https'
//   static permanent true = pay-once permanence (drives the "Make permanent" UX)
//   static fields    UI inputs the provider needs (token, endpoint, trackers…)
//   static action    primary button label
//   async put(file, {onProgress}) -> { ref, scheme, name?, gateway?, permanent?, extra? }
//
// Providers extend BasePersistenceProvider (base.js). Construct one with the
// user's config + injectable deps:  new ArweaveProvider(config, { fetch, payments })
//
// Add a provider:  persistProviders.register('filecoin', FilecoinProvider)

import { Registry } from '../registry.js';
import { BasePersistenceProvider } from './base.js';
import { ArweaveProvider } from './arweave.js';
import { PinningProvider } from './pinning.js';
import { SeedboxProvider } from './seedbox.js';
import { HttpsProvider } from './s3.js';

export { BasePersistenceProvider };
export { makePermanent, PaymentNotConfiguredError } from './payments.js';

export const persistProviders = new Registry('persistence provider');
// Order = display order in the host picker. Arweave (permanent) is the DEFAULT.
persistProviders.register('arweave', ArweaveProvider);   // ar://     pay-once permanent
persistProviders.register('pinning', PinningProvider);   // ipfs://   pinning service (rent)
persistProviders.register('seedbox', SeedboxProvider);   // magnet:   WebTorrent seed
persistProviders.register('s3', HttpsProvider);          // https     S3 / presigned PUT

export const DEFAULT_PERSIST_PROVIDER = 'arweave';

/** Provider classes in registration order (for building the UI). */
export function listPersistProviders() {
  return persistProviders.list().map((id) => persistProviders.get(id));
}
