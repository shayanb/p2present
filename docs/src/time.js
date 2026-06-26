// time.js — timestamp parsing & formatting utilities.
//
// The manifest stores time as a float number of SECONDS (sub-second precision).
// For author convenience we also accept human strings like "HH:MM:SS.mmm",
// "MM:SS", or "SS". parseTime() normalises any of these into float seconds.

/**
 * Parse a timestamp into float seconds.
 * Accepts: number (returned as-is), "1:02:03.5", "12:30", "75.5", "75".
 * @param {number|string} value
 * @returns {number} seconds
 */
export function parseTime(value) {
  if (typeof value === 'number' && isFinite(value)) return value;
  if (typeof value !== 'string') {
    throw new TypeError(`parseTime: unsupported value ${JSON.stringify(value)}`);
  }
  const s = value.trim();
  if (s === '') return 0;

  // Plain number string ("75.5")
  if (/^\d*\.?\d+$/.test(s)) return parseFloat(s);

  // Colon form: [HH:]MM:SS[.mmm]
  const parts = s.split(':');
  if (parts.length < 2 || parts.length > 3) {
    throw new Error(`parseTime: cannot parse "${value}"`);
  }
  const nums = parts.map((p) => {
    const n = parseFloat(p);
    if (!isFinite(n)) throw new Error(`parseTime: cannot parse "${value}"`);
    return n;
  });
  let seconds = 0;
  for (const n of nums) seconds = seconds * 60 + n;
  return seconds;
}

/**
 * Format float seconds as a display string.
 * @param {number} seconds
 * @param {{ms?: boolean}} [opts]
 * @returns {string} "M:SS" or "H:MM:SS" (optionally with .mmm)
 */
export function formatTime(seconds, opts = {}) {
  if (!isFinite(seconds) || seconds < 0) seconds = 0;
  const whole = Math.floor(seconds);
  const ms = Math.round((seconds - whole) * 1000);
  const h = Math.floor(whole / 3600);
  const m = Math.floor((whole % 3600) / 60);
  const s = whole % 60;
  const pad = (n) => String(n).padStart(2, '0');
  let out = h > 0 ? `${h}:${pad(m)}:${pad(s)}` : `${m}:${pad(s)}`;
  if (opts.ms) out += '.' + String(ms).padStart(3, '0');
  return out;
}
