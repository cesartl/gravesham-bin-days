const test = require('node:test');
const assert = require('node:assert/strict');
const { loadRecipientsConfig, validateRecipientsConfig } = require('../recipients-config');

const config = () => ({
  timezone: 'Europe/London',
  addresses: [{ label: '10 Example Road', recipients: ['you@example.com', { type: 'buttondown' }] }]
});

test('loads and decrypts the configured SSM parameter on every invocation', async () => {
  const inputs = [];
  const client = { send: async command => {
    inputs.push(command.input);
    const value = config();
    value.notify = { messageSuffix: `revision ${inputs.length}` };
    return { Parameter: { Value: JSON.stringify(value) } };
  } };
  assert.equal((await loadRecipientsConfig(client, '/test/recipients')).notify.messageSuffix, 'revision 1');
  assert.equal((await loadRecipientsConfig(client, '/test/recipients')).notify.messageSuffix, 'revision 2');
  assert.deepEqual(inputs, [
    { Name: '/test/recipients', WithDecryption: true },
    { Name: '/test/recipients', WithDecryption: true }
  ]);
});

test('rejects missing or malformed parameter values without exposing their contents', async () => {
  await assert.rejects(loadRecipientsConfig({ send: async () => ({}) }, '/test'), /empty/);
  const secret = 'private-recipient@example.com';
  await assert.rejects(loadRecipientsConfig({ send: async () => ({ Parameter: { Value: secret } }) }, '/test'), error => {
    assert.match(error.message, /valid JSON/);
    assert.equal(error.message.includes(secret), false);
    return true;
  });
});

test('propagates SSM access failures instead of silently using stale or empty config', async () => {
  const error = new Error('AccessDenied');
  await assert.rejects(loadRecipientsConfig({ send: async () => { throw error; } }, '/test'), error);
});

test('rejects invalid addresses, delivery targets and timezones before running the job', () => {
  for (const value of [null, {}, { addresses: [] }, { addresses: [null] },
    { addresses: [{ label: '', recipients: ['you@example.com'] }] },
    { addresses: [{ label: 'Example', recipients: [] }] },
    { addresses: [{ label: 'Example', recipients: ['invalid'] }] },
    { addresses: [{ label: 'Example', recipients: [{ type: 'unsupported' }] }] },
    { ...config(), timezone: 'Invalid/Timezone' }]) {
    assert.throws(() => validateRecipientsConfig(value), /config/i);
  }
});

test('accepts existing direct-email and Buttondown recipient formats', () => {
  const value = config();
  value.addresses[0].recipients = ['you@example.com', 'buttondown',
    { email: 'one@example.com' }, { channel: 'gmail', address: 'two@example.com' },
    { type: 'direct', email: 'three@example.com', hideLabelInSubject: true },
    { buttondown: true, hideAddressInSubject: true }];
  assert.equal(validateRecipientsConfig(value), value);
});
