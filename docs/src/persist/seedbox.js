// persist/seedbox.js — WebTorrent provider (magnet:).
//
// Creates a torrent from the file in this tab and announces it to trackers, so
// the magnet works peer-to-peer immediately. In-tab seeding stops when the tab
// closes — for ALWAYS-ON availability, point this at a seedbox: a remote always-on
// WebTorrent client you control, which this provider hands the magnet (or file)
// to over an authenticated POST so it keeps seeding after you leave.
//
// The browser WebTorrent client is injected (deps.getWebTorrent) so the provider
// stays DOM-free and unit-testable with a mock client.

import { BasePersistenceProvider } from './base.js';

export class SeedboxProvider extends BasePersistenceProvider {
  static id = 'seedbox';
  static label = 'WebTorrent seed (magnet)';
  static scheme = 'magnet';
  static action = 'Create & seed';
  static blurb = 'Create + seed a torrent in the browser. Returns a magnet: reference.';
  static note =
    'In-tab seeding stops when you close this tab. For always-on availability, add a ' +
    'seedbox URL — a remote WebTorrent client you control that keeps seeding the magnet. ' +
    'Trackers + seedbox token are stored only in this browser.';
  static fields = [
    { key: 'trackers', label: 'Trackers (wss://, one per line)', type: 'textarea', optional: true },
    {
      key: 'seedboxUrl', label: 'Always-on seedbox URL', type: 'text', optional: true,
      placeholder: 'optional — POST {magnet} to keep seeding after this tab closes',
    },
    { key: 'seedboxToken', label: 'Seedbox token (Bearer)', type: 'password', optional: true },
  ];

  /** Parse the textarea into a clean tracker list. */
  trackerList() {
    return String(this.cfg('trackers') || '')
      .split('\n').map((s) => s.trim()).filter(Boolean);
  }

  async put(file, { onProgress } = {}) {
    if (typeof this.getWebTorrent !== 'function') {
      throw new Error('WebTorrent client unavailable in this context.');
    }
    onProgress?.('Loading WebTorrent…');
    const client = await this.getWebTorrent();
    const trackers = this.trackerList();
    const opts = trackers.length ? { announce: trackers } : {};

    onProgress?.('Hashing + announcing to trackers…');
    const torrent = await new Promise((resolve, reject) => {
      try { client.seed(file, opts, (t) => resolve(t)); }
      catch (err) { reject(err); }
    });

    // Optionally hand the magnet to an always-on seedbox so it survives this tab.
    const seedboxUrl = this.cfg('seedboxUrl');
    let alwaysOn = false;
    if (seedboxUrl) {
      try {
        onProgress?.('Registering with seedbox…');
        const headers = { 'Content-Type': 'application/json' };
        const token = this.cfg('seedboxToken');
        if (token) headers.Authorization = `Bearer ${token}`;
        const res = await this.fetch(seedboxUrl, {
          method: 'POST', headers,
          body: JSON.stringify({ magnet: torrent.magnetURI, name: file.name }),
        });
        alwaysOn = res.ok;
        if (!res.ok) onProgress?.(`Seedbox refused (HTTP ${res.status}) — seeding in-tab only.`);
      } catch (err) {
        onProgress?.(`Seedbox unreachable (${err.message}) — seeding in-tab only.`);
      }
    }

    return {
      ref: torrent.magnetURI,
      scheme: 'magnet',
      name: file.name,
      extra: { torrent, alwaysOn },
    };
  }
}
