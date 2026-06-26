// persist/s3.js — plain HTTPS provider (https). The escape hatch for "I already
// have somewhere to put files": an S3 bucket, R2, a presigned PUT URL, or any
// endpoint that accepts the raw bytes via PUT (or POST).
//
// You upload to one URL and reference another: e.g. PUT to a presigned, expiring
// URL but reference the stable public object URL. Both are entered in the UI and
// stored only in localStorage. No p2present server is involved.

import { BasePersistenceProvider } from './base.js';

export class HttpsProvider extends BasePersistenceProvider {
  static id = 's3';
  static label = 'S3 / HTTPS (presigned PUT)';
  static scheme = 'https';
  static action = 'Upload';
  static blurb = 'Upload to a bucket / presigned URL you control. Returns a plain https reference.';
  static note =
    'Upload the bytes to the PUT URL (e.g. an S3 presigned URL); the manifest then ' +
    'references the public URL. Make sure the object is publicly readable and sends ' +
    'CORS headers so the player can fetch it cross-origin.';
  static fields = [
    { key: 'putUrl', label: 'Upload URL (PUT target)', type: 'text', placeholder: 'https://bucket.s3.amazonaws.com/key?X-Amz-Signature=…' },
    {
      key: 'publicUrl', label: 'Public URL (reference)', type: 'text', optional: true,
      placeholder: 'optional — defaults to the upload URL without its query string',
    },
    {
      key: 'method', label: 'HTTP method', type: 'select', default: 'PUT',
      options: [{ value: 'PUT', label: 'PUT' }, { value: 'POST', label: 'POST' }],
    },
  ];

  async put(file, { onProgress } = {}) {
    const putUrl = this.require('putUrl', 'Enter the upload (PUT) URL.');
    const method = (this.cfg('method') || 'PUT').toUpperCase();
    onProgress?.(`Uploading via ${method}…`);
    const res = await this.fetch(putUrl, {
      method,
      headers: { 'Content-Type': file.type || 'application/octet-stream' },
      body: file,
    });
    if (!res.ok) {
      throw new Error(`Upload HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`);
    }
    // Reference = explicit public URL, else the PUT URL stripped of its (signing) query.
    const ref = (this.cfg('publicUrl') || '').trim() || putUrl.split('?')[0];
    return { ref, scheme: 'https', name: file.name, gateway: ref };
  }
}
