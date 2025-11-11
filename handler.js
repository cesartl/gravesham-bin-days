const { DateTime } = require('luxon');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const chromium = require('@sparticuz/chromium');
const puppeteer = require('puppeteer-core');
const { DynamoDBClient, UpdateItemCommand, GetItemCommand } = require('@aws-sdk/client-dynamodb');
const { SSMClient, GetParametersCommand } = require('@aws-sdk/client-ssm');
const axios = require('axios');
const { google } = require('googleapis');

const dynamo = new DynamoDBClient({});
const ssm = new SSMClient({});

const CONFIG_PATH = path.join(__dirname, 'config', 'recipients.json');

// Helpers
async function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

async function getGmailCredentials() {
  try {
    const serviceName = 'gravesham-bin-days'; // Use consistent service name
    const paramNames = [
      `/${serviceName}/gmail-client-id`,
      `/${serviceName}/gmail-client-secret`, 
      `/${serviceName}/gmail-refresh-token`,
      `/${serviceName}/gmail-sender`
    ];
    
    const command = new GetParametersCommand({
      Names: paramNames,
      WithDecryption: true
    });
    
    const response = await ssm.send(command);
    const params = {};
    
    response.Parameters?.forEach(param => {
      const key = param.Name.split('/').pop();
      params[key] = param.Value;
    });
    
    return {
      clientId: params['gmail-client-id'],
      clientSecret: params['gmail-client-secret'],
      refreshToken: params['gmail-refresh-token'],
      sender: params['gmail-sender']
    };
  } catch (error) {
    console.log('Failed to fetch Gmail credentials from Parameter Store:', error.message);
    // Fallback to environment variables for local development
    return {
      clientId: process.env.GMAIL_CLIENT_ID,
      clientSecret: process.env.GMAIL_CLIENT_SECRET,
      refreshToken: process.env.GMAIL_REFRESH_TOKEN,
      sender: process.env.GMAIL_SENDER
    };
  }
}
async function saveScreenshot(page, label) {
  try {
    const file = path.join(__dirname, `debug-${Date.now()}-${label}.png`);
    await page.screenshot({ path: file, fullPage: true });
    console.log(`Saved screenshot: ${file}`);
  } catch (err) {
    // ignore in lambda if not supported
  }
}
async function saveFrameHtml(frame, label) {
  try {
    const html = await frame.evaluate(() => document.documentElement.outerHTML);
    const file = path.join(__dirname, `debug-${Date.now()}-${label}.html`);
    fs.writeFileSync(file, html, 'utf-8');
    console.log(`Saved html: ${file}`);
  } catch (_) {}
}
async function clickByText(frame, texts) {
  const arr = Array.isArray(texts) ? texts : [texts];
  return frame.evaluate((labels) => {
    const norm = (s) => (s || '').trim().toLowerCase();
    const matches = (el, wanted) => norm(el.textContent) === wanted || norm(el.textContent).includes(wanted);
    const clickable = Array.from(document.querySelectorAll('button, a, [role="button"], .btn, .af-action, .af-button, div, span'));
    for (const wantedRaw of labels) {
      const wanted = norm(wantedRaw);
      const el = clickable.find(node => matches(node, wanted));
      if (el) {
        el.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
        el.dispatchEvent(new MouseEvent('click', { bubbles: true }));
        return true;
      }
    }
    return false;
  }, arr);
}

// Orchestration: exported Lambda handler
exports.daily = async (event) => {
  console.log('=== Daily bin check starting ===');
  console.log('Event:', JSON.stringify(event, null, 2));
  console.log('Environment variables:', {
    SOURCE_URL: !!process.env.SOURCE_URL,
    STATE_TABLE: process.env.STATE_TABLE,
    TZ: process.env.TZ,
    MESSAGE_SUFFIX: process.env.MESSAGE_SUFFIX,
    AWS_REGION: process.env.AWS_REGION
  });
  
  let config;
  try {
    config = loadConfig(CONFIG_PATH);
    console.log(`✓ Loaded config for ${config.addresses.length} addresses`);
    console.log('Config timezone:', config.timezone);
  } catch (error) {
    console.error('✗ Failed to load config:', error);
    throw error;
  }
  
  const sourceUrl = process.env.SOURCE_URL;
  const dadJokePromise = fetchDadJokeWithTimeout(5000).then((joke) => {
    if (joke) console.log('Dad joke fetched successfully');
    else console.log('Dad joke fetch completed but no joke returned');
    return joke;
  }).catch((err) => {
    console.warn('Dad joke fetch failed:', err.message);
    return null;
  });
  const now = DateTime.now().setZone(config.timezone || process.env.TZ || 'Europe/London');
  const tomorrow = now.plus({ days: 1 }).toISODate();
  const forceNotify = getForceNotify(event);
  
  console.log(`Current time (${config.timezone || process.env.TZ || 'Europe/London'}): ${now.toISO()}`);
  console.log(`Tomorrow's date: ${tomorrow}`);
  console.log(`Force notify mode: ${forceNotify}`);

  console.log('Launching browser...');
  const browser = await launchBrowser();
  console.log('✓ Browser launched successfully');
  let dadJoke;
  let dadJokeResolved = false;
  try {
    for (let i = 0; i < config.addresses.length; i++) {
      const address = config.addresses[i];
      const { label, recipients } = address;
      console.log(`\n--- Processing address ${i + 1}/${config.addresses.length}: ${label} ---`);
      console.log(`Recipients: ${recipients.join(', ')}`);
      
      let result;
      try {
        console.log('Starting scrape...');
        result = await scrapeNextCollections(browser, sourceUrl, label);
        console.log(`✓ Scraped ${result.collections.length} collections:`, result.collections);
      } catch (error) {
        console.error(`✗ Failed to scrape collections for ${label}:`, error);
        continue;
      }
      
      const hasTomorrow = result.collections.some(c => c.localDate === tomorrow);
      console.log(`Has collection tomorrow (${tomorrow}): ${hasTomorrow}`);

      if (!forceNotify && !hasTomorrow) {
        console.log('Skipping - no collection tomorrow and not in force mode');
        continue;
      }

      const addressHash = sha256(label);
      console.log(`Address hash: ${addressHash}`);
      
      let alreadyNotified = false;
      if (!forceNotify) {
        try {
          alreadyNotified = await wasNotifiedForDate(addressHash, tomorrow);
          console.log(`Already notified check: ${alreadyNotified}`);
        } catch (error) {
          console.error('Failed to check notification status:', error);
        }
        if (alreadyNotified) {
          console.log('Skipping - already notified for this date');
          continue;
        }
      }

      let announceDate = tomorrow;
      if (forceNotify && !hasTomorrow) {
        const upcoming = result.collections
          .map(c => ({ ...c, dt: DateTime.fromISO(c.localDate) }))
          .filter(c => c.dt.isValid && c.dt >= now.startOf('day'))
          .sort((a, b) => a.dt - b.dt);
        if (upcoming.length > 0) announceDate = upcoming[0].localDate;
      }

      const binsForAnnounce = result.collections.filter(c => c.localDate === announceDate).flatMap(c => c.bins);
      const uniqueBins = Array.from(new Set(binsForAnnounce));

      const isTomorrow = announceDate === tomorrow;
      const messageSuffix = config.notify?.messageSuffix || process.env.MESSAGE_SUFFIX || '';
      
      // Format date in UK style: "11th September 2025"
      const formatUKDate = (dateStr) => {
        const dt = DateTime.fromISO(dateStr);
        if (!dt.isValid) return dateStr;
        
        const day = dt.day;
        const suffix = day === 1 || day === 21 || day === 31 ? 'st' :
                      day === 2 || day === 22 ? 'nd' :
                      day === 3 || day === 23 ? 'rd' : 'th';
        
        return `${day}${suffix} ${dt.toFormat('MMMM yyyy')}`;
      };
      
      const ukFormattedDate = formatUKDate(announceDate);
      const whenText = isTomorrow ? 'tomorrow' : `on ${ukFormattedDate}`;
      const announceDetails = result.collections.filter(c => c.localDate === announceDate).map(c => c.bins.join(', ')).join(' | ');
      if (!dadJokeResolved) {
        dadJoke = await dadJokePromise;
        dadJokeResolved = true;
      }

      const binsText = announceDetails || uniqueBins.join(' + ');
      const summaryLine = `Collection ${whenText} for ${label} (${ukFormattedDate}): ${binsText}`;
      const textParts = [summaryLine, messageSuffix];
      if (dadJoke) textParts.push(`Dad joke of the day: ${dadJoke}`);
      const msg = textParts.filter(Boolean).join('\n\n').trim();
      const htmlBody = buildHtmlEmailBody(summaryLine, messageSuffix, result.tableHtml, dadJoke);
      const subject = `${binsText} collection on ${ukFormattedDate} - ${label}`;

      console.log(`Email subject: ${subject}`);
      console.log(`Email body: ${msg}`);
      if (result.tableHtml) {
        console.log(`Including HTML table (${result.tableHtml.length} chars) in email body`);
      }
      if (dadJoke) {
        console.log(`Including dad joke in email: ${dadJoke}`);
      }
      
      const emailLike = (v) => /.+@.+\..+/.test(String(v || ''));
      const toList = recipients.filter(emailLike);
      console.log(`Valid email recipients: ${toList.join(', ')}`);
      
      if (toList.length === 0) {
        console.log('⚠️ No valid email addresses found in recipients');
      } else {
        console.log(`Sending emails to ${toList.length} recipients...`);
        
        for (let j = 0; j < toList.length; j++) {
          const email = toList[j];
          console.log(`Sending email ${j + 1}/${toList.length} to: ${email}`);
          try {
            await sendEmail(email, subject, msg, htmlBody);
            console.log(`✓ Email sent successfully to ${email}`);
          } catch (error) {
            console.error(`✗ Failed to send email to ${email}:`, error.message);
            console.error('Error stack:', error.stack);
          }
        }
      }

      if (!forceNotify && isTomorrow) {
        try {
          await markNotified(addressHash, tomorrow, {
            collections: result.collections,
            tableHtml: result.tableHtml
          });
          console.log(`✓ Marked as notified for ${tomorrow}`);
        } catch (error) {
          console.error('Failed to mark as notified:', error);
        }
      }
    }
  } finally {
    console.log('Closing browser...');
    await browser.close();
    console.log('✓ Browser closed');
  }
  
  console.log('=== Daily bin check completed successfully ===');
  return { statusCode: 200, body: 'ok' };
};

function getForceNotify(event) {
  if (process.env.FORCE_NOTIFY && /^(1|true|yes)$/i.test(process.env.FORCE_NOTIFY)) return true;
  if (event && (event.forceNotify === true || /^(1|true|yes)$/i.test(String(event.forceNotify || '')))) return true;
  return false;
}

function loadConfig(p) {
  const raw = fs.readFileSync(p, 'utf-8');
  const cfg = JSON.parse(raw);
  if (!cfg.addresses || !Array.isArray(cfg.addresses)) {
    throw new Error('config.addresses must be an array');
  }
  return cfg;
}

async function launchBrowser() {
  if (process.env.LOCAL_CHROME === '1' || process.env.LOCAL_CHROME === 'true') {
    const pptr = require('puppeteer');
    const headful = process.env.LOCAL_HEADFUL === '1' || process.env.LOCAL_HEADFUL === 'true';
    return pptr.launch({ headless: !headful, defaultViewport: headful ? null : { width: 1280, height: 1024 }, args: headful ? ['--start-maximized'] : [] });
  }
  const executablePath = await chromium.executablePath();
  return puppeteer.launch({
    args: [...chromium.args, '--no-sandbox', '--disable-dev-shm-usage'],
    defaultViewport: { width: 1280, height: 1024 },
    executablePath,
    headless: true
  });
}

async function scrapeNextCollections(browser, url, addressLabel) {
  const page = await browser.newPage();
  try {
    await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/127.0.0.0 Safari/537.36');
    await page.goto(url, { waitUntil: 'networkidle2', timeout: 90000 });
    await saveScreenshot(page, 'after-goto');
    await sleep(1500);

    const frame = await getFormFrame(page);
    await saveScreenshot(page, 'after-frame');

    await ensureFormOpen(frame);
    await saveFrameHtml(frame, 'after-open');

    await typeAndSelectAddress(frame, page, addressLabel, getForceNotify());

    const tableOk = await waitForResultsTable(frame, 120000);
    if (!tableOk) {
      await saveFrameHtml(frame, 'no-results-timeout');
      throw new Error('Results table did not render in time');
    }
    await saveFrameHtml(frame, 'after-results');

    const { collections, tableHtml } = await extractCollections(frame);
    return { collections, tableHtml };
  } finally {
    await page.close();
  }
}

async function getFormFrame(page) {
  const iframeHandle = await page.waitForSelector('#fillform-frame-1', { timeout: 60000 });
  const frame = await iframeHandle.contentFrame();
  if (frame) {
    await new Promise(r => setTimeout(r, 1000));
    return frame;
  }
  const start = Date.now();
  while (Date.now() - start < 60000) {
    const frames = page.frames();
    for (const fr of frames) {
      try {
        const hasInputs = await fr.evaluate(() => !!document && document.querySelectorAll('input').length > 0);
        if (hasInputs) return fr;
      } catch (_) {}
    }
    await new Promise(r => setTimeout(r, 500));
  }
  throw new Error('Could not find a loaded form frame with inputs');
}

async function ensureFormOpen(frame) {
  const candidates = ['Section 1', 'Start', 'Begin', 'Check your bin day', 'Next', 'Continue'];
  for (const text of candidates) {
    try {
      const ok = await clickByText(frame, text);
      if (ok) {
        await sleep(1000);
        const has = await frame.evaluate(() => !!document.querySelector('input, [role="combobox"], [contenteditable="true"]'));
        if (has) return;
      }
    } catch (_) {}
  }
}

async function typeAndSelectAddress(frame, page, label, forceNotify) {
  // 1) Find the address entry control (input/combobox/contenteditable or autoLookup field)
  const handle = await frame.evaluateHandle(() => {
    const isVisible = (el) => {
      if (!el) return false;
      const rect = el.getBoundingClientRect();
      const style = window.getComputedStyle(el);
      return !!(rect.width && rect.height) && style.visibility !== 'hidden' && style.display !== 'none';
    };
    // Prefer an input/combobox tied to the address lookup
    let candidates = Array.from(document.querySelectorAll('input[aria-autocomplete="list"], input[role="combobox"], input[type="search"], input'))
      .filter(isVisible);
    if (candidates.length === 0) {
      // Try contenteditable or the AchieveForms autoLookup container
      const auto = document.querySelector('div[data-type="autoLookup"], [data-field-type="autoLookup"]');
      if (auto) {
        const inAuto = auto.querySelector('input, [contenteditable="true"], [role="combobox"]');
        if (inAuto && isVisible(inAuto)) return inAuto;
      }
      candidates = Array.from(document.querySelectorAll('[contenteditable="true"], [role="combobox"], input')).filter(isVisible);
    }
    const scoreOf = (el) => {
      const attrs = [el.name, el.id, el.getAttribute?.('role'), el.getAttribute?.('aria-label'), el.placeholder, el.className]
        .filter(Boolean).join(' ').toLowerCase();
      let score = 0;
      if (/address|lookup|find|search/.test(attrs)) score += 5;
      if (/text|search/.test(el.type || '')) score += 2;
      if (/date|time/.test(el.type || '')) score -= 3;
      const field = el.closest?.('.field, .fieldContent, .af-block, fieldset, form');
      if (field) {
        const txt = (field.textContent || '').toLowerCase();
        if (txt.includes('address')) score += 3;
        if (txt.includes('postcode')) score += 1;
      }
      return score;
    };
    let best = null; let bestScore = -Infinity;
    for (const el of candidates) {
      const sc = scoreOf(el);
      if (sc > bestScore) { best = el; bestScore = sc; }
    }
    return best;
  });

  const inputHandle = handle && handle.asElement ? handle.asElement() : null;
  if (!inputHandle) {
    await saveFrameHtml(frame, 'no-address-input');
    throw new Error('Address input not found');
  }

  await inputHandle.scrollIntoView?.().catch(() => {});
  await inputHandle.click({ delay: 50 }).catch(() => {});
  await inputHandle.focus().catch(() => {});
  const couldClear = await frame.evaluate((el) => { try { el.value=''; el.dispatchEvent(new Event('input',{ bubbles:true })); return true; } catch { return false; } }, inputHandle).catch(() => false);
  if (!couldClear) {
    await page.keyboard.down('Control').catch(() => {});
    await page.keyboard.press('KeyA').catch(() => {});
    await page.keyboard.up('Control').catch(() => {});
    await page.keyboard.press('Backspace').catch(() => {});
  }
  // 2) Type the address
  try { await inputHandle.type(label, { delay: 60 }); } catch { await page.keyboard.type(label, { delay: 60 }); }
  // 3) Wait for the select dropdown to be populated and select the first option
  await new Promise(r => setTimeout(r, 700)); // Wait for lookup to trigger
  
  // Wait for the select dropdown to have options (not just "Select...")
  const selectHandle = await frame.waitForFunction(() => {
    const select = document.querySelector('select[name="YourAddress"], select#YourAddress');
    if (!select) return null;
    const options = select.querySelectorAll('option:not([value=""])');
    return options.length > 0 ? select : null;
  }, { timeout: 60000 });

  if (!selectHandle) {
    await saveFrameHtml(frame, 'no-select-options');
    throw new Error('Address select dropdown not populated');
  }

  // Select the first non-empty option
  await frame.evaluate((select) => {
    const firstOption = select.querySelector('option:not([value=""])');
    if (firstOption) {
      select.value = firstOption.value;
      select.dispatchEvent(new Event('change', { bubbles: true }));
      select.dispatchEvent(new Event('input', { bubbles: true }));
    }
  }, selectHandle);
  // 4) Do not click any extra button here; caller will wait for #table2
}

async function waitForResultsTable(frame, timeoutMs = 120000) {
  // Explicitly wait for the results table with id="table2" to render
  try {
    await frame.waitForSelector('#table2', { timeout: timeoutMs });
    await frame.waitForSelector('#table2 tr td, #table2 tr th', { timeout: timeoutMs });
    return true;
  } catch (e) {
    return false;
  }
}

async function extractCollections(frame) {
  const tableData = await frame.evaluate(() => {
    const norm = (s) => (s || '').replace(/\s+/g, ' ').trim();
    const extractRows = (table) => {
      const rows = [];
      const trs = Array.from(table.querySelectorAll('tr'));
      for (const tr of trs) {
        const cells = Array.from(tr.querySelectorAll('td, th'));
        if (cells.length < 2) continue;
        const col1 = norm(cells[0].textContent);
        const col2 = norm(cells[1].textContent);
        const isHeader = /collection\s*date/i.test(col1) && /bin\s*type/i.test(col2);
        if (isHeader) continue;
        if (col1 && col2) rows.push({ dateText: col1, binsText: col2 });
      }
      return rows;
    };

    const tableOrder = [];
    const table2 = document.getElementById('table2') || document.querySelector('#table2');
    if (table2) tableOrder.push(table2);
    tableOrder.push(...Array.from(document.querySelectorAll('table')));

    const seen = new Set();
    for (const table of tableOrder) {
      if (!table || seen.has(table)) continue;
      seen.add(table);
      const rows = extractRows(table);
      if (rows.length > 0) {
        return { rows, html: table.outerHTML };
      }
    }

    return { rows: [], html: null };
  });

  const byDateFromTables = new Map();
  for (const row of tableData.rows || []) {
    const dt = parseDateToLocal(row.dateText);
    if (!dt || !row.binsText) continue;
    const localDate = dt.toISODate();
    const existing = byDateFromTables.get(localDate) || [];
    if (!existing.includes(row.binsText)) {
      byDateFromTables.set(localDate, [...existing, row.binsText]);
    }
  }

  if (byDateFromTables.size > 0) {
    const collections = Array.from(byDateFromTables.entries()).map(([localDate, bins]) => ({ localDate, bins }));
    return { collections, tableHtml: tableData.html?.trim() || null };
  }

  const raw = await frame.evaluate(() => document.body.innerText || '');
  const lines = raw.split(/\n+/).map(s => s.trim()).filter(Boolean);
  const dateRegex = /(\b\d{1,2}\/\d{1,2}\/\d{2,4}\b)|(\b\d{1,2}\s+[A-Za-z]{3,9}\s+\d{4}\b)|(\b\d{4}-\d{2}-\d{2}\b)/;
  const results = [];
  for (let i = 0; i < lines.length; i++) {
    if (dateRegex.test(lines[i])) {
      const dateStr = (lines[i].match(dateRegex) || [])[0];
      const ctx = [lines[i - 1], lines[i], lines[i + 1]].filter(Boolean).join(' ');
      const dt = parseDateToLocal(dateStr);
      if (dt) results.push({ localDate: dt.toISODate(), bins: [ctx] });
    }
  }
  const byDate = new Map();
  for (const r of results) {
    const existing = byDate.get(r.localDate) || [];
    byDate.set(r.localDate, Array.from(new Set([...existing, ...r.bins])));
  }
  return {
    collections: Array.from(byDate.entries()).map(([localDate, bins]) => ({ localDate, bins })),
    tableHtml: tableData.html?.trim() || null
  };
}

function parseDateToLocal(str) {
  const zone = process.env.TZ || 'Europe/London';
  const s = String(str || '').trim();
  let dt = DateTime.fromFormat(s, 'd/M/yyyy', { zone });
  if (dt.isValid) return dt.startOf('day');
  dt = DateTime.fromFormat(s, 'd/M/yy', { zone });
  if (dt.isValid) return dt.startOf('day');
  dt = DateTime.fromFormat(s, 'd LLL yyyy', { zone });
  if (dt.isValid) return dt.startOf('day');
  dt = DateTime.fromISO(s, { zone });
  if (dt.isValid) return dt.startOf('day');
  const m = s.match(/\b(\d{1,2}\/\d{1,2}\/\d{4})\b/);
  if (m) {
    const inner = m[1];
    const innerDt = DateTime.fromFormat(inner, 'd/M/yyyy', { zone });
    if (innerDt.isValid) return innerDt.startOf('day');
  }
  return null;
}

async function wasNotifiedForDate(addressHash, localDate) {
  const cmd = new GetItemCommand({
    TableName: process.env.STATE_TABLE,
    Key: { addressHash: { S: addressHash } },
    ProjectionExpression: 'lastNotifiedForLocalDate'
  });
  const res = await dynamo.send(cmd);
  const last = res.Item?.lastNotifiedForLocalDate?.S;
  return last === localDate;
}

async function markNotified(addressHash, localDate, snapshot) {
  const cmd = new UpdateItemCommand({
    TableName: process.env.STATE_TABLE,
    Key: { addressHash: { S: addressHash } },
    UpdateExpression: 'SET lastNotifiedForLocalDate = :d, lastSnapshot = :s, updatedAt = :u',
    ExpressionAttributeValues: {
      ':d': { S: localDate },
      ':s': { S: JSON.stringify(snapshot).slice(0, 3500) },
      ':u': { S: new Date().toISOString() }
    }
  });
  await dynamo.send(cmd);
}

function buildHtmlEmailBody(summaryLine, messageSuffix, tableHtml, dadJoke) {
  const parts = [];
  if (!tableHtml && summaryLine) {
    parts.push(`<p>${escapeHtml(summaryLine)}</p>`);
  }
  if (tableHtml) {
    parts.push(tableHtml);
  }
  const suffix = (messageSuffix || '').trim();
  if (suffix) {
    const suffixHtml = escapeHtml(suffix).replace(/\n/g, '<br>');
    parts.push(`<p>${suffixHtml}</p>`);
  }
  if (dadJoke) {
    parts.push(`<p><em>Dad joke of the day:</em> ${escapeHtml(dadJoke)}</p>`);
  }
  return parts.length > 0 ? parts.join('\n') : null;
}

function escapeHtml(value) {
  return String(value || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

async function sendEmail(toEmail, subject, text, html) {
  console.log(`📧 Attempting to send email to: ${toEmail}`);
  console.log(`📧 Subject: ${subject}`);
  
  let credentials;
  try {
    console.log('🔐 Fetching Gmail credentials...');
    credentials = await getGmailCredentials();
    console.log('🔐 Credentials fetched:', {
      hasClientId: !!credentials.clientId,
      hasClientSecret: !!credentials.clientSecret,
      hasRefreshToken: !!credentials.refreshToken,
      sender: credentials.sender || '(not set)'
    });
  } catch (error) {
    console.error('🔐 Failed to fetch credentials:', error);
    throw error;
  }
  
  const { clientId, clientSecret, refreshToken, sender } = credentials;
  if (!clientId || !clientSecret || !refreshToken || !sender) {
    console.log('📧 Email (dry-run - missing credentials):', { toEmail, subject, text, hasHtml: !!html });
    console.log('📧 Missing credentials:', {
      clientId: !clientId,
      clientSecret: !clientSecret,
      refreshToken: !refreshToken,
      sender: !sender
    });
    return;
  }
  console.log('🔐 Creating OAuth2 client...');
  const oAuth2Client = new google.auth.OAuth2(clientId, clientSecret);
  oAuth2Client.setCredentials({ refresh_token: refreshToken });
  
  console.log('📧 Initializing Gmail API...');
  const gmail = google.gmail({ version: 'v1', auth: oAuth2Client });

  const plainText = text || '';
  const htmlBody = html && html.trim().length > 0 ? html : null;
  let message;
  if (htmlBody) {
    const boundary = `----=_Part_${Date.now()}_${Math.random().toString(36).slice(2)}`;
    const messageParts = [
      `From: ${sender}`,
      `To: ${toEmail}`,
      `Subject: ${subject}`,
      'MIME-Version: 1.0',
      `Content-Type: multipart/alternative; boundary="${boundary}"`,
      '',
      `--${boundary}`,
      'Content-Type: text/plain; charset=utf-8',
      'Content-Transfer-Encoding: 7bit',
      '',
      plainText,
      '',
      `--${boundary}`,
      'Content-Type: text/html; charset=utf-8',
      'Content-Transfer-Encoding: 7bit',
      '',
      htmlBody,
      '',
      `--${boundary}--`,
      ''
    ];
    message = messageParts.join('\n');
  } else {
    const messageParts = [
      `From: ${sender}`,
      `To: ${toEmail}`,
      `Subject: ${subject}`,
      'MIME-Version: 1.0',
      'Content-Type: text/plain; charset=utf-8',
      '',
      plainText,
    ];
    message = messageParts.join('\n');
  }

  console.log('📧 Encoding message...');
  const encodedMessage = Buffer.from(message, 'utf8').toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  
  console.log('📧 Sending email via Gmail API...');
  try {
    const result = await gmail.users.messages.send({ userId: 'me', requestBody: { raw: encodedMessage } });
    console.log('📧 Email sent successfully! Message ID:', result.data.id);
  } catch (error) {
    console.error('📧 Gmail API error:', error.message);
    if (error.response?.data) {
      console.error('📧 Gmail API response:', JSON.stringify(error.response.data, null, 2));
    }
    throw error;
  }
}

function sha256(s) {
  return crypto.createHash('sha256').update(s).digest('hex');
}

async function fetchDadJokeWithTimeout(timeoutMs = 5000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await axios.get('https://icanhazdadjoke.com/', {
      headers: {
        Accept: 'application/json',
        'User-Agent': 'gravesham-bin-days/1.0'
      },
      signal: controller.signal,
      timeout: timeoutMs
    });
    const joke = response.data?.joke;
    if (typeof joke === 'string' && joke.trim()) {
      return joke.trim();
    }
    return null;
  } catch (error) {
    if (error.name === 'CanceledError') {
      throw new Error('Dad joke fetch timed out');
    }
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

module.exports = { daily: exports.daily };
