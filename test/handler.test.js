const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { retryScrape, withTimeout } = require('../scrape-retry');

// Load the real handler with offline SDK stubs; no AWS calls, mail or Chrome launch.
function loadHandler(overrides = {}) {
  class Client {}
  const now = {
    setZone() { return this; },
    startOf: () => new Date('2026-10-14T00:00:00Z'),
    plus() { return { toISODate: () => '2026-10-15' }; },
    toISO: () => '2026-10-14T17:00:00+01:00'
  };
  const stubs = {
    luxon: { DateTime: { now: () => now, fromISO: value => ({
      isValid: Number.isFinite(Date.parse(value)), day: new Date(value).getUTCDate(),
      toFormat: () => 'October 2026', valueOf: () => Date.parse(value)
    }) } },
    '@sparticuz/chromium': {},
    'puppeteer-core': {},
    '@aws-sdk/client-dynamodb': { DynamoDBClient: Client },
    '@aws-sdk/client-ssm': { SSMClient: Client },
    axios: {},
    googleapis: {},
    './recipients-config': require('../recipients-config'),
    './scrape-retry': {
      withTimeout,
      retryScrape: (scrape, options) => retryScrape(scrape, { ...options, wait: async () => {}, logger: { log() {}, warn() {} } })
    }
  };
  const sandbox = vm.createContext({
    require: name => name in stubs ? stubs[name] : require(name),
    module: { exports: {} }, exports: {}, __dirname: path.resolve(__dirname, '..'),
    process: { env: {} }, Buffer, setTimeout, clearTimeout,
    console: { log() {}, warn() {}, error() {} }, overrides
  });
  const source = fs.readFileSync(path.join(__dirname, '../handler.js'), 'utf8');
  vm.runInContext(source + `
    for (const [name, fn] of Object.entries(overrides)) eval(name + ' = fn');
    module.exports = { daily: exports.daily, scrapeNextCollections, typeAndSelectAddress };
  `, sandbox);
  return { handler: sandbox.module.exports, sandbox };
}

test('exhausted scrape failures fail the invocation, continue other addresses and close the browser', async () => {
  const calls = [];
  let closed = false;
  const { handler } = loadHandler({
    loadConfig: () => ({ addresses: [{ label: 'failing' }, { label: 'healthy' }] }),
    fetchDadJokeWithTimeout: async () => null,
    launchBrowser: async () => ({ close: async () => { closed = true; } }),
    wasNotifiedForDate: async () => false,
    scrapeNextCollections: async (_, __, label) => {
      calls.push(label);
      if (label === 'failing') throw new Error('Address input not found');
      return { collections: [] };
    }
  });
  await assert.rejects(handler.daily({}, { getRemainingTimeInMillis: () => 300000 }), error => {
    assert.equal(error.name, 'AggregateError');
    assert.match(error.message, /Failed to scrape failing/);
    assert.match(error.errors[0].cause.cause.message, /Address input not found/);
    return true;
  });
  assert.deepEqual(calls, ['failing', 'failing', 'failing', 'healthy']);
  assert.equal(closed, true);
});

test('configuration-only checks await SSM config without scraping or sending notifications', async () => {
  let loaded = false;
  const { handler } = loadHandler({
    loadConfig: async () => {
      await Promise.resolve();
      loaded = true;
      return { timezone: 'Europe/London', addresses: [{ label: 'Example' }] };
    },
    launchBrowser: async () => { throw new Error('Browser must not start'); },
    fetchDadJokeWithTimeout: async () => { throw new Error('External requests must not start'); }
  });
  const result = await handler.daily({ validateConfigOnly: true });
  assert.equal(loaded, true);
  assert.equal(result.statusCode, 200);
  assert.equal(result.body, 'Recipient configuration is valid');
});

test('configuration failures stop the job before browser launch', async () => {
  const { handler } = loadHandler({
    loadConfig: async () => { throw new Error('SSM config unavailable'); },
    launchBrowser: async () => { throw new Error('Browser must not start'); }
  });
  await assert.rejects(handler.daily({}), /SSM config unavailable/);
});

function loadDryRunHandler(overrides = {}) {
  const effects = [];
  let closed = false;
  const { handler } = loadHandler({
    loadConfig: async () => ({ addresses: [{ label: 'Example Road', recipients: [
      { email: 'you@example.com', hideLabelInSubject: true },
      { type: 'buttondown', hideLabelInSubject: true }
    ] }] }),
    fetchDadJokeWithTimeout: async () => null,
    launchBrowser: async () => ({ close: async () => { closed = true; } }),
    wasNotifiedForDate: async () => false,
    scrapeNextCollections: async () => ({ collections: [{ localDate: '2026-10-15', bins: ['Recycling'] }], tableHtml: null }),
    sendEmail: async () => effects.push('email'),
    sendButtondownEmail: async () => effects.push('buttondown'),
    markNotified: async () => effects.push('markNotified'),
    ...overrides
  });
  return { handler, effects, closed: () => closed };
}

test('dry runs preview both delivery channels without sending or changing notification state', async () => {
  const { handler, effects, closed } = loadDryRunHandler();
  const response = await handler.daily({ dryRun: true });
  const result = JSON.parse(response.body);
  assert.equal(response.statusCode, 200);
  assert.equal(result.dryRun, true);
  assert.equal(result.results[0].status, 'would_notify');
  const preview = result.results[0].notification;
  assert.equal(preview.directEmails[0].to, 'you@example.com');
  assert.match(preview.directEmails[0].subject, /Recycling collection on 15th October 2026/);
  assert.equal(preview.directEmails[0].subject.includes('Example Road'), false);
  assert.equal(preview.buttondown.subject, preview.directEmails[0].subject);
  assert.match(preview.text, /Collection tomorrow/);
  assert.match(preview.html, /Recycling/);
  assert.deepEqual(effects, []);
  assert.equal(closed(), true);
});

test('dry runs respect tomorrow-only selection and notification deduplication', async () => {
  const noCollection = loadDryRunHandler({ scrapeNextCollections: async () => ({ collections: [] }) });
  assert.equal(JSON.parse((await noCollection.handler.daily({ dryRun: true })).body).results[0].status, 'no_collection_tomorrow');
  const alreadySent = loadDryRunHandler({
    wasNotifiedForDate: async () => true,
    scrapeNextCollections: async () => { throw new Error('Already notified addresses should not be scraped'); }
  });
  assert.equal(JSON.parse((await alreadySent.handler.daily({ dryRun: true })).body).results[0].status, 'already_notified');
  assert.deepEqual(noCollection.effects, []);
  assert.deepEqual(alreadySent.effects, []);
});

test('forceNotify can preview an upcoming collection and cannot override dry-run safety', async () => {
  const { handler, effects } = loadDryRunHandler({
    wasNotifiedForDate: async () => { throw new Error('Force mode must bypass deduplication'); },
    scrapeNextCollections: async () => ({ collections: [{ localDate: '2026-10-20', bins: ['Food'] }] })
  });
  const result = JSON.parse((await handler.daily({ dryRun: true, forceNotify: true })).body);
  assert.equal(result.results[0].notification.date, '2026-10-20');
  assert.match(result.results[0].notification.text, /on 20th October 2026/);
  assert.deepEqual(effects, []);
});

test('dry runs propagate exhausted scrape failures and close the browser without side effects', async () => {
  const { handler, effects, closed } = loadDryRunHandler({
    scrapeNextCollections: async () => { throw new Error('Website unavailable'); }
  });
  await assert.rejects(handler.daily({ dryRun: true }), /Failed to scrape/);
  assert.deepEqual(effects, []);
  assert.equal(closed(), true);
});

test('invalid dryRun values fail before any live processing', async () => {
  const { handler, effects } = loadDryRunHandler({
    loadConfig: async () => { throw new Error('Configuration should not be loaded'); }
  });
  for (const dryRun of ['true', 'false', 1, null]) {
    await assert.rejects(handler.daily({ dryRun }), /dryRun must be a boolean/);
  }
  assert.deepEqual(effects, []);
});

test('dryRun false preserves normal Gmail, Buttondown and notification-state updates', async () => {
  const { handler, effects } = loadDryRunHandler();
  assert.equal((await handler.daily({ dryRun: false })).body, 'ok');
  assert.deepEqual(effects, ['email', 'buttondown', 'markNotified']);
});

test('a retry of a partial run skips successful notifications before scraping', async () => {
  const marked = new Set();
  const sent = [];
  const scraped = [];
  let firstRun = true;
  const { handler } = loadHandler({
    loadConfig: () => ({ addresses: ['failing', 'healthy'].map(label => ({ label, recipients: [label + '@example.com'] })) }),
    fetchDadJokeWithTimeout: async () => null,
    launchBrowser: async () => ({ close: async () => {} }),
    wasNotifiedForDate: async hash => marked.has(hash),
    markNotified: async hash => marked.add(hash),
    sendEmail: async email => sent.push(email),
    scrapeNextCollections: async (_, __, label) => {
      scraped.push(label);
      if (firstRun && label === 'failing') throw new Error('Address input not found');
      return { collections: [{ localDate: '2026-10-15', bins: ['Recycling'] }], tableHtml: null };
    }
  });
  await assert.rejects(handler.daily({}), /Failed to scrape failing/);
  firstRun = false;
  const result = await handler.daily({});
  assert.equal(result.statusCode, 200);
  assert.deepEqual(sent, ['healthy@example.com', 'failing@example.com']);
  assert.deepEqual(scraped, ['failing', 'failing', 'failing', 'healthy', 'failing']);
});

test('each failed scrape closes its tab before the next attempt opens one', async () => {
  const events = [];
  let number = 0;
  const browser = { newPage: async () => {
    const id = ++number;
    events.push(`open ${id}`);
    return {
      setUserAgent: async () => {},
      goto: async () => { throw new Error('navigation failed'); },
      close: async () => events.push(`close ${id}`)
    };
  } };
  const { handler } = loadHandler();
  await assert.rejects(retryScrape(ms => handler.scrapeNextCollections(browser, 'url', 'label', ms), {
    label: 'label', wait: async () => {}, logger: { log() {}, warn() {} }
  }), /after 3 attempts/);
  assert.deepEqual(events, ['open 1', 'close 1', 'open 2', 'close 2', 'open 3', 'close 3']);
});

test('a stalled page is closed when the attempt budget expires', async () => {
  let closed = false;
  const page = {
    setUserAgent: async () => {},
    goto: () => new Promise(() => {}),
    close: async () => { closed = true; }
  };
  const { handler } = loadHandler();
  await assert.rejects(handler.scrapeNextCollections({ newPage: async () => page }, 'url', 'label', 10), /Scrape timed out/);
  assert.equal(closed, true);
});

test('waits for a late visible address field rather than failing the first DOM check', async () => {
  const { handler, sandbox } = loadHandler({ saveFrameHtml: async () => {} });
  let ready = false;
  let typed;
  const input = {
    name: 'address', type: 'text',
    getBoundingClientRect: () => ({ width: 100, height: 20 }),
    click: async () => {}, focus: async () => {},
    type: async label => { typed = label; }
  };
  sandbox.window = { getComputedStyle: () => ({ visibility: 'visible', display: 'block' }) };
  sandbox.document = { querySelectorAll: () => ready ? [input] : [], querySelector: () => null };
  let waits = 0;
  const frame = {
    waitForFunction: async (fn, options) => {
      if (++waits === 1) {
        assert.equal(options.timeout, 15000);
        assert.equal(options.polling, 250);
        assert.equal(fn(), null);
        ready = true;
        assert.equal(fn(), input);
        return { asElement: () => input };
      }
      return {};
    },
    evaluate: async () => true
  };
  await handler.typeAndSelectAddress(frame, {}, '101 old road west');
  assert.equal(typed, '101 old road west');
});

test('a missing address field preserves the timeout cause for retry diagnostics', async () => {
  let diagnostics = 0;
  const { handler } = loadHandler({ saveFrameHtml: async () => { diagnostics++; } });
  const timeout = new Error('Waiting failed: 15000ms exceeded');
  const frame = { waitForFunction: async () => { throw timeout; } };
  await assert.rejects(handler.typeAndSelectAddress(frame, {}, '101 old road west'), error => {
    assert.equal(error.message, 'Address input not found');
    assert.equal(error.cause, timeout);
    return true;
  });
  assert.equal(diagnostics, 1);
});
