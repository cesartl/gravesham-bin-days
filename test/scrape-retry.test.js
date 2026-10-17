const test = require('node:test');
const assert = require('node:assert/strict');
const { retryScrape, withTimeout } = require('../scrape-retry');

const logger = { log() {}, warn() {} };
const options = { label: '101 old road west', logger };

test('returns immediately on a successful scrape', async () => {
  const result = { collections: [] };
  let calls = 0;
  assert.equal(await retryScrape(async () => { calls++; return result; }, options), result);
  assert.equal(calls, 1);
});

test('recovers from transient address-input failures with exponential delays', async () => {
  const delays = [];
  let calls = 0;
  const result = await retryScrape(async timeoutMs => {
    assert.equal(timeoutMs, 60000);
    if (++calls < 3) throw new Error('Address input not found');
    return 'recovered';
  }, { ...options, wait: async ms => delays.push(ms) });
  assert.equal(result, 'recovered');
  assert.deepEqual(delays, [2000, 4000]);
  assert.equal(calls, 3);
});

test('persistent errors stop after three attempts and retain the original error', async () => {
  const failure = new Error('Address input not found');
  let calls = 0;
  await assert.rejects(retryScrape(async () => { calls++; throw failure; }, {
    ...options, wait: async () => {}
  }), error => /after 3 attempts/.test(error.message) && error.cause === failure);
  assert.equal(calls, 3);
});

test('shortens an attempt to reserve time for delivery and cleanup', async () => {
  await retryScrape(async timeoutMs => assert.equal(timeoutMs, 15000), {
    ...options, getRemainingTimeInMillis: () => 35000
  });
});

test('does not retry when there is insufficient Lambda time remaining', async () => {
  const failure = new Error('Address input not found');
  let remaining = 90000;
  let calls = 0;
  const delays = [];
  await assert.rejects(retryScrape(async () => {
    calls++;
    remaining = 31000; // Below the 20s reserve + 2s delay + 10s minimum attempt.
    throw failure;
  }, {
    ...options,
    getRemainingTimeInMillis: () => remaining,
    wait: async ms => delays.push(ms)
  }), error => /Not enough time/.test(error.message) && error.cause === failure);
  assert.equal(calls, 1);
  assert.deepEqual(delays, []);
});

test('bounds stalled operations and also propagates immediate errors', async () => {
  await assert.rejects(withTimeout(() => new Promise(() => {}), 10), /Scrape timed out/);
  const failure = new Error('navigation failed');
  await assert.rejects(withTimeout(async () => { throw failure; }, 1000), error => error === failure);
  assert.equal(await withTimeout(async () => 'ok', 1000), 'ok');
});
