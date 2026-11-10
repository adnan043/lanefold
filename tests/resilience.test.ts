import {describe, expect, it} from 'vitest';

import {ApiError} from '../src/app/api';
import {codeForStatus, isSessionLost, parseRetryAfter, retryDelay, shouldRetryQuery} from '../src/app/resilience';
import {errorText} from '../src/i18n/errors';
import en from '../src/i18n/messages/en.json';

const lookup = (key: string) => (en as Record<string, string>)[key];

describe('codeForStatus', () => {
  it('maps bare statuses to catalog codes that exist', () => {
    for (const status of [0, 401, 403, 404, 429, 500, 503]) {
      const code = codeForStatus(status)!;
      expect(lookup(`errors.${code}`), `status ${status}`).toBeTruthy();
    }
    expect(codeForStatus(422)).toBeUndefined();
  });
  it('turns a message-less 429 into the rate-limit text', () => {
    expect(errorText(lookup, {code: codeForStatus(429), message: 'Request failed (429)'})).toBe(en['errors.rate_limited']);
  });
});

describe('parseRetryAfter', () => {
  it('reads seconds, caps and ignores junk', () => {
    expect(parseRetryAfter('30')).toBe(30);
    expect(parseRetryAfter('99999')).toBe(300);
    expect(parseRetryAfter('Wed, 21 Oct 2026 07:28:00 GMT')).toBeUndefined();
    expect(parseRetryAfter(null)).toBeUndefined();
  });
});

describe('shouldRetryQuery', () => {
  const err = (status: number) => new ApiError('x', status);
  it('never retries a 4xx', () => {
    for (const s of [401, 403, 404, 409, 422, 429]) expect(shouldRetryQuery(0, err(s))).toBe(false);
  });
  it('retries a network failure twice, a gateway error once, then stops', () => {
    expect(shouldRetryQuery(0, err(0))).toBe(true);
    expect(shouldRetryQuery(1, err(0))).toBe(true);
    expect(shouldRetryQuery(2, err(0))).toBe(false);
    expect(shouldRetryQuery(0, err(503))).toBe(true);
    expect(shouldRetryQuery(1, err(503))).toBe(false);
    expect(shouldRetryQuery(0, err(500))).toBe(false);
  });
  it('treats an unknown error (a thrown bug) as one retry', () => {
    expect(shouldRetryQuery(0, new Error('x'))).toBe(true);
    expect(shouldRetryQuery(1, new Error('x'))).toBe(false);
  });
});

describe('retryDelay', () => {
  it('grows, is jittered and capped', () => {
    expect(retryDelay(0, () => 0.5)).toBe(1000);
    expect(retryDelay(2, () => 0.5)).toBe(4000);
    expect(retryDelay(20, () => 1)).toBe(37_500);
    expect(retryDelay(0, () => 0)).toBe(750);
  });
});

describe('isSessionLost', () => {
  it('is true for a 401 only', () => {
    expect(isSessionLost(new ApiError('x', 401))).toBe(true);
    expect(isSessionLost(new ApiError('x', 403))).toBe(false);
    expect(isSessionLost(null)).toBe(false);
  });
});
