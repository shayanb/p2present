// persist/pinning.js — IPFS pinning-service provider (ipfs://).
//
// "Rent" model: a pinning service keeps your CID online for as long as you pay
// (or stay on its free tier). Two services are supported, each with the user's
// OWN token, entered in the UI and stored only in localStorage — the file + token
// go directly to the service, never to p2present.
//
//   • Pinata        — JWT  → POST /pinning/pinFileToIPFS  → { IpfsHash }
//   • web3.storage  — token → POST /upload                → { cid }   (legacy API)

import { BasePersistenceProvider } from './base.js';

const SERVICES = {
  pinata: {
    label: 'Pinata (JWT)',
    async upload(file, token, fetchFn, onProgress) {
      const fd = new FormData();
      fd.append('file', file, file.name);
      onProgress?.('Uploading to Pinata…');
      const res = await fetchFn('https://api.pinata.cloud/pinning/pinFileToIPFS', {
        method: 'POST', headers: { Authorization: `Bearer ${token}` }, body: fd,
      });
      if (!res.ok) throw new Error(`Pinata HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`);
      const j = await res.json();
      if (!j.IpfsHash) throw new Error('Pinata response had no IpfsHash.');
      return j.IpfsHash;
    },
  },
  web3storage: {
    label: 'web3.storage (legacy API token)',
    async upload(file, token, fetchFn, onProgress) {
      onProgress?.('Uploading to web3.storage…');
      const res = await fetchFn('https://api.web3.storage/upload', {
        method: 'POST', headers: { Authorization: `Bearer ${token}` }, body: file,
      });
      if (!res.ok) throw new Error(`web3.storage HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`);
      const j = await res.json();
      if (!j.cid) throw new Error('web3.storage response had no cid.');
      return j.cid;
    },
  },
};

export class PinningProvider extends BasePersistenceProvider {
  static id = 'pinning';
  static label = 'IPFS pinning service (rent)';
  static scheme = 'ipfs';
  static action = 'Upload & pin';
  static blurb = 'Pin a file to IPFS with your own service token. Returns an ipfs:// reference.';
  static note =
    'Stored only as long as the service keeps it pinned (your account / paid plan). ' +
    'Your token is kept ONLY in this browser and sent directly to the service — never to p2present.';
  static fields = [
    {
      key: 'service', label: 'Service', type: 'select', default: 'pinata',
      options: [
        { value: 'pinata', label: 'Pinata (JWT)' },
        { value: 'web3storage', label: 'web3.storage (legacy API token)' },
      ],
    },
    { key: 'token', label: 'API token', type: 'password', placeholder: 'paste your token' },
  ];

  async put(file, { onProgress } = {}) {
    const service = SERVICES[this.cfg('service')] || SERVICES.pinata;
    const token = this.require('token', `Enter your ${service.label} token (your own token — never shared).`);
    const cid = await service.upload(file, token, this.fetch, onProgress);
    return {
      ref: `ipfs://${cid}`,
      scheme: 'ipfs',
      name: file.name,
      gateway: `https://${cid}.ipfs.dweb.link`,
      extra: { cid },
    };
  }
}
