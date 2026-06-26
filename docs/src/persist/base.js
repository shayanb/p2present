// persist/base.js — BasePersistenceProvider, in its own module so provider
// subclasses can `extends` it without a circular dependency on the registry in
// index.js. See index.js for the full PersistenceProvider interface contract.
//
// A persistence provider turns a File into a *manifest reference* — the string
// you paste into a video / deck / subtitle source: an ar:// tx, an ipfs:// CID,
// a magnet:, or a plain https URL. Tokens the provider needs are user-supplied
// (entered in the host UI, kept in localStorage) and passed in via `config`.

export class BasePersistenceProvider {
  // --- static descriptor (drives the host UI; read off the subclass) ---------
  static id = 'base';
  static label = 'Base';
  static scheme = 'https';      // ref scheme produced: 'ar' | 'ipfs' | 'magnet' | 'https'
  static permanent = false;     // true = pay-once permanence (Arweave)
  static blurb = '';            // one-line description shown under the picker
  static note = '';             // longer security / how-it-works note
  // Config inputs beyond the file, rendered as form fields. Each:
  //   { key, label, type:'text'|'password'|'select'|'textarea', placeholder?,
  //     options?:[{value,label}], default?, optional? }
  static fields = [];
  // Label for the primary action button (e.g. "Upload & pin", "Make permanent").
  static action = 'Upload';

  /**
   * @param {object} config   { [fieldKey]: value } collected from the UI
   * @param {object} deps      injectables (defaulted for the browser; mocked in tests)
   *   - fetch       : (url, init) => Promise<Response>
   *   - getWebTorrent: () => Promise<WebTorrentClient>   (seedbox only)
   *   - payments    : payment-hook adapter (arweave "make permanent")
   */
  constructor(config = {}, deps = {}) {
    this.config = config || {};
    this.fetch = deps.fetch || ((...a) => globalThis.fetch(...a));
    this.getWebTorrent = deps.getWebTorrent;
    this.payments = deps.payments;
  }

  /** Read a config value, falling back to the field's declared default. */
  cfg(key) {
    if (this.config[key] != null && this.config[key] !== '') return this.config[key];
    const f = this.constructor.fields.find((x) => x.key === key);
    return f ? f.default : undefined;
  }

  /** Throw a friendly error if a required config field is missing. */
  require(key, hint) {
    const v = this.cfg(key);
    if (v == null || v === '') {
      const f = this.constructor.fields.find((x) => x.key === key);
      throw new Error(hint || `${f?.label || key} is required.`);
    }
    return v;
  }

  /**
   * Upload `file` and resolve to a reference descriptor.
   * @param {File|Blob} file
   * @param {{ onProgress?: (msg:string)=>void }} ctx
   * @returns {Promise<{ ref:string, scheme:string, name?:string, gateway?:string,
   *                     permanent?:boolean, extra?:object }>}
   */
  async put(/* file, ctx */) {
    throw new Error(`${this.constructor.id}.put() is not implemented`);
  }
}
