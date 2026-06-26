// registry.js — a tiny generic plugin registry.
//
// Deck adapters, video providers, and slide transitions are all registered
// through small instances of this class. Keeping the mechanism in one place
// makes "how do I add a new X?" a one-line answer in every category.

export class Registry {
  /** @param {string} kind human label used in error messages, e.g. "video provider" */
  constructor(kind) {
    this.kind = kind;
    this._map = new Map();
  }

  /**
   * @param {string} name unique key (e.g. "youtube", "pdf", "fade")
   * @param {*} factory the thing to store (a class, factory fn, or object)
   */
  register(name, factory) {
    if (this._map.has(name)) {
      console.warn(`[registry] overriding ${this.kind} "${name}"`);
    }
    this._map.set(name, factory);
    return this;
  }

  has(name) {
    return this._map.has(name);
  }

  get(name) {
    const f = this._map.get(name);
    if (!f) {
      throw new Error(
        `Unknown ${this.kind} "${name}". Registered: ${this.list().join(', ') || '(none)'}`
      );
    }
    return f;
  }

  list() {
    return [...this._map.keys()];
  }
}
