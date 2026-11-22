// Shared settings for the k6 load tests (run with k6, never with vitest: see ../README.md).
//
//   BASE_URL      the site to test, e.g. http://localhost:4321 (required: no default, so a
//                 test never hits the live site by accident)
//   PROFILE       smoke (default) | load | stress | spike | soak
//   CONFIRM_LIVE  must be "yes" to run anything heavier than smoke against a non-local address

const PROFILES = {
  // Does it work at all? A handful of users, half a minute.
  smoke: {vus: 2, duration: '30s'},
  // The traffic we expect on a normal busy day.
  load: {
    stages: [
      {duration: '1m', target: 20},
      {duration: '3m', target: 20},
      {duration: '30s', target: 0},
    ],
  },
  // Past normal, to see where it bends.
  stress: {
    stages: [
      {duration: '1m', target: 50},
      {duration: '2m', target: 100},
      {duration: '2m', target: 150},
      {duration: '1m', target: 0},
    ],
  },
  // A sudden rush (a link shared somewhere big), then calm again.
  spike: {
    stages: [
      {duration: '20s', target: 5},
      {duration: '10s', target: 150},
      {duration: '1m', target: 150},
      {duration: '10s', target: 5},
      {duration: '30s', target: 0},
    ],
  },
  // Steady for a long time: leaks, slow drift, sessions refreshing.
  soak: {
    stages: [
      {duration: '2m', target: 20},
      {duration: '30m', target: 20},
      {duration: '1m', target: 0},
    ],
  },
};

function isLocal(url) {
  const host = url.replace(/^https?:\/\//, '').split(/[/:]/)[0];
  return host === 'localhost' || host === '127.0.0.1' || host.endsWith('.localhost');
}

export const BASE_URL = (__ENV.BASE_URL || '').replace(/\/+$/, '');
// VUS=<n> (optional): ramp to n users over 1 minute, hold for HOLD (default 3m), ramp down.
const VUS = __ENV.VUS ? Number(__ENV.VUS) : 0;
if (__ENV.VUS && !(Number.isInteger(VUS) && VUS > 0 && VUS <= 2000)) throw new Error('VUS must be a whole number from 1 to 2000.');
if (VUS) {
  PROFILES.custom = {
    stages: [
      {duration: '1m', target: VUS},
      {duration: __ENV.HOLD || '3m', target: VUS},
      {duration: '30s', target: 0},
    ],
  };
}
export const PROFILE = VUS ? 'custom' : __ENV.PROFILE || 'smoke';

if (!BASE_URL) throw new Error('Set BASE_URL, e.g. BASE_URL=http://localhost:4321 k6 run tests/load/public.js');
if (!PROFILES[PROFILE]) throw new Error(`PROFILE must be one of: ${Object.keys(PROFILES).join(', ')}`);
if (PROFILE !== 'smoke' && !isLocal(BASE_URL) && __ENV.CONFIRM_LIVE !== 'yes') {
  throw new Error(
    `PROFILE=${PROFILE} against ${BASE_URL} sends real, billed traffic. Add CONFIRM_LIVE=yes if that is intended.`
  );
}

/** k6 `options` for the chosen profile, with this test's thresholds. */
export function optionsFor(thresholds, overrides = {}) {
  return {...PROFILES[PROFILE], ...overrides, thresholds, summaryTrendStats: ['avg', 'med', 'p(90)', 'p(95)', 'p(99)', 'max']};
}
