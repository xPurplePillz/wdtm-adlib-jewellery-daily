/**
 * WDTM DAILY AD LIBRARY HARVEST
 *
 * Our own scraper. No third-party scraping service.
 * Built on Kyle's harvester (v16): it opens the Ad Library like a normal
 * logged-out visitor, captures the search request the page makes, then replays
 * that request for each search term, newest ads first. Each search stops as
 * soon as it reaches ads older than the lookback window, so a daily run is a
 * small number of requests.
 *
 * Sends the new ads to your n8n webhook, which does the rest.
 *
 * RUN
 *   GitHub Actions runs this daily (see .github/workflows/daily.yml)
 *   Locally:  npm install && npx playwright install chromium && node harvest.js --dry-run
 *
 * SETTINGS (GitHub repo > Settings > Secrets and variables > Actions)
 *   N8N_WEBHOOK_URL      secret, the Production URL from the n8n webhook node
 *   N8N_WEBHOOK_SECRET   secret, any long random password, same as in n8n
 *   COUNTRIES            variable, optional, e.g. GB or GB,IE (default GB)
 *   LOOKBACK_HOURS       variable, optional (default 48)
 */
const { chromium } = require('playwright');
const fs = require('fs');

// ---- settings ---------------------------------------------------------------
const CONFIG = {
  countries: (process.env.COUNTRIES || 'GB').split(',').map(s => s.trim().toUpperCase()).filter(Boolean),
  lookbackHours: Number(process.env.LOOKBACK_HOURS || 48),
  maxPagesPerSearch: Number(process.env.MAX_PAGES || 6),
  adsPerRequest: 30,
  pauseMs: 1800,        // gap between requests, jittered
  termGapMs: 4000,      // gap between searches
  // Kyle's terms: exact phrases, trade words only, broadest first.
  terms: [
    'jewellery', 'jewelry', 'handmade jewellery', 'handmade jewelry', 'fine jewellery',
    'fine jewelry', 'jewellery brand', 'jewelry brand', 'personalised jewellery',
    'personalized jewelry', 'custom jewellery', 'custom jewelry', 'bridal jewellery',
    'bridal jewelry', 'demi fine jewellery', 'sterling silver jewellery', 'sterling silver jewelry',
    'gold plated jewellery', 'waterproof jewellery', '925 sterling silver', 'gold vermeil',
    '9ct gold', '18ct gold', '14k gold', 'lab grown diamond', 'tarnish free',
    'hypoallergenic jewellery', 'memorial jewellery', 'keepsake jewellery', 'independent jeweller',
    'jewellery designer', 'jewelry designer', 'goldsmith', 'hallmarked',
  ],
};

const WEBHOOK = process.env.N8N_WEBHOOK_URL || '';
const SECRET = process.env.N8N_WEBHOOK_SECRET || '';
const DRY_RUN = process.argv.includes('--dry-run');
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36';

const sleep = ms => new Promise(r => setTimeout(r, ms));
const jitter = (ms, j = 0.5) => Math.round(ms * (1 + (Math.random() * 2 - 1) * j));
const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a);
const quoteTerm = t => (/^".*"$/.test(t) ? t : '"' + t + '"');

// ---- Kyle's junk rules --------------------------------------------------------
const WHOLESALE_DEST = /alibaba\.|aliexpress\.|dhgate\.|made-in-china\.|globalsources\.|1688\.com|indiamart\./i;
const SHELL_NAME = /\.[A-Z]{2}\d{2}$|^[A-Z][a-z]{4,}(ly|ei|ip|um|ic)[-.](Pro|Plus|Max)$/;
const B2B_SUPPLY = /\bMOQ\b|\bOEM\b|\bODM\b|jewelry (packaging|display|showcase|box)|jewellery (packaging|display|showcase|box)|display (cabinet|showcase|props)|wholesale (price|supplier|enquir)|factory direct|custom logo printing|bulk order/gi;
const JUNK_DEST = /reelshort|netshort|dramawave|dramabox|minitvplay|sweetmaxbest|shortmax|goodshort|flextv|moboreels|melolo|topshort|joyshort|meganovel|novelove|words-fly|novelix|literiess|flashshow|kimo-culture|kwmobi|joytvdrama|storeel|storyreel|shortdramalabs|vibeshort|bestreels|tapread|novelhives|novelbars|b25reel|w2a\.|booksadvpage|book_id=|chapterid=|webnovel|dreame|goodnovel|readfun|joyread|anystories|bravonovel|play\.google\.com|apps\.apple\.com|temu\.com/i;
const FICTION = /\bchapter\b|\bepisode\b|billionaire|werewolf|\bheiress\b|contract marriage|to be continued|\bmafia\b|\bluna\b|stepbrother|stepsister|\brevenge\b|\bdivorce\b|\bCEO\b|\btycoon\b|\bbetrayed\b|watch (the )?full (episode|story|drama)/gi;
const JUNK_NAME = /\bdrama\b|dramabox|reelshort|shortmax|goodshort|funstory|plothub|storyreel|storyverse|luvflix|\bminitv\b|short ?tv\b|micro ?drama|short ?drama|web ?novel|\bnovel(s|hive|bar|ix)\b/i;

function distinctCount(text, re) {
  return new Set((String(text || '').match(re) || []).map(h => h.toLowerCase())).size;
}
function junkReason(name, title, body, url) {
  if (url && JUNK_DEST.test(url)) return 'app funnel URL';
  if (url && WHOLESALE_DEST.test(url)) return 'wholesale B2B URL';
  if (name && JUNK_NAME.test(name)) return 'story app name';
  if (distinctCount(name + ' ' + title + ' ' + body, B2B_SUPPLY) >= 2) return 'trade supplier';
  if (name && SHELL_NAME.test(name.trim()) && (url === '' || /support@|\.shop$|\.store$/.test(url))) return 'shell name plus weak destination';
  if (body.length > 400 && distinctCount(body, FICTION) >= 3) return 'fiction copy';
  return '';
}

// ---- reading Meta's responses (Kyle's approach) ----------------------------------
// Meta sometimes streams several JSON objects in one body, newline separated.
function parseBodies(text) {
  const out = [];
  const t = String(text || '').replace(/^for \(;;\);/, '');
  try { out.push(JSON.parse(t)); return out; } catch (e) {}
  t.split('\n').forEach(l => {
    l = l.trim();
    if (l.length < 30 || l[0] !== '{') return;
    try { out.push(JSON.parse(l)); } catch (e) {}
  });
  return out;
}
// Walks the tree for anything shaped like an ad, rather than a fixed path,
// because Meta reshapes its payloads regularly.
function collectAds(node, depth, out) {
  if (!node || typeof node !== 'object' || depth > 14) return;
  if (Array.isArray(node)) { node.forEach(n => collectAds(n, depth + 1, out)); return; }
  const id = node.ad_archive_id || node.adArchiveID || node.adArchiveId;
  if (id && (node.page_name || node.pageName || node.page_id || node.snapshot)) out.set(String(id), node);
  for (const k of Object.keys(node)) {
    const v = node[k];
    if (v && typeof v === 'object') collectAds(v, depth + 1, out);
  }
}
function findCursor(node, depth) {
  if (!node || typeof node !== 'object' || depth > 14) return null;
  if (Array.isArray(node)) {
    for (const n of node) { const r = findCursor(n, depth + 1); if (r) return r; }
    return null;
  }
  const end = node.end_cursor || node.endCursor;
  let more = node.has_next_page;
  if (more === undefined) more = node.hasNextPage;
  if (end && more !== false) return end;
  for (const k of Object.keys(node)) {
    const v = node[k];
    if (v && typeof v === 'object') { const r = findCursor(v, depth + 1); if (r) return r; }
  }
  return null;
}

// Shapes one ad down to what n8n needs. Falls back to carousel cards when the
// top level is empty, like Kyle's flatten script.
function slim(a, term, country) {
  const s = a.snapshot || {};
  const cards = Array.isArray(s.cards) ? s.cards : [];
  let body = String((s.body && (s.body.text || (s.body.markup && s.body.markup.__html))) || '').trim();
  if (!body) { const cd = cards.find(x => String(x.body || '').trim()); if (cd) body = String(cd.body).trim(); }
  let title = String(s.title || '').trim();
  if (!title) { const cd = cards.find(x => String(x.title || '').trim()); if (cd) title = String(cd.title).trim(); }
  const links = [s.link_url, ...cards.map(x => x.link_url)].filter(Boolean);
  const name = String(a.page_name || a.pageName || s.page_name || '').trim();
  return {
    ad_id: String(a.ad_archive_id || a.adArchiveID || ''),
    page_id: String(a.page_id || a.pageID || s.page_id || ''),
    page_name: name,
    start_date: Number(a.start_date || a.startDate || 0),
    is_active: a.is_active !== false,
    page_is_deleted: !!a.page_is_deleted,
    followers: Number(s.page_like_count || 0),
    page_profile_uri: s.page_profile_uri || '',
    page_categories: s.page_categories || [],
    links,
    caption: String(s.caption || ''),
    title: title.slice(0, 200),
    body: body.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 1500),
    cta: s.cta_text || '',
    term,
    country,
    junk_reason: junkReason(name, title, body, links[0] || ''),
  };
}

// ---- browser bits -------------------------------------------------------------
async function dismissPopups(page) {
  const names = [/allow all cookies/i, /decline optional cookies/i, /only allow essential cookies/i, /accept all/i];
  for (const n of names) {
    try {
      const b = page.getByRole('button', { name: n }).first();
      if (await b.isVisible({ timeout: 500 })) { await b.click({ timeout: 2000 }); await sleep(800); }
    } catch (e) {}
  }
  try { await page.keyboard.press('Escape'); } catch (e) {}
}

function pickHeaders(h) {
  const out = {};
  Object.keys(h || {}).forEach(k => {
    const lk = k.toLowerCase();
    if (lk === 'content-type' || (lk.startsWith('x-') && lk !== 'x-client-data')) out[k] = h[k];
  });
  return out;
}

async function main() {
  if (!DRY_RUN && !WEBHOOK) throw new Error('N8N_WEBHOOK_URL is not set. Add it as a GitHub secret.');
  const cutoff = Math.floor(Date.now() / 1000) - CONFIG.lookbackHours * 3600;
  log(`Looking for ads started since ${new Date(cutoff * 1000).toISOString()} in ${CONFIG.countries.join(', ')}`);

  const browser = await chromium.launch({ headless: true, executablePath: process.env.CHROME_PATH || undefined,
                                           args: ['--disable-blink-features=AutomationControlled'] });
  const context = await browser.newContext({ userAgent: UA, locale: 'en-GB', viewport: { width: 1366, height: 900 } });
  const page = await context.newPage();

  // 1. Load a real search and capture the request the page makes when you scroll
  let captured = null;
  page.on('request', req => {
    if (captured) return;
    const url = req.url();
    const body = req.postData() || '';
    if (url.includes('/api/graphql') && body.includes('variables') && body.includes('queryString')) {
      captured = { url, body, headers: pickHeaders(req.headers()) };
    }
  });

  const startUrl = (process.env.ADLIB_BASE || 'https://www.facebook.com') + '/ads/library/?active_status=active&ad_type=all'
    + '&country=' + CONFIG.countries[0]
    + '&q=' + encodeURIComponent(quoteTerm(CONFIG.terms[0]))
    + '&search_type=keyword_exact_phrase&media_type=all';
  log('Opening the Ad Library');
  await page.goto(startUrl, { waitUntil: 'domcontentloaded', timeout: 60000 });
  await sleep(4000);
  await dismissPopups(page);
  for (let i = 0; i < 15 && !captured; i++) {
    await page.mouse.wheel(0, 3000);
    await sleep(2500);
    if (i % 3 === 2) await dismissPopups(page);
  }
  if (!captured) {
    await page.screenshot({ path: 'debug.png' }).catch(() => {});
    fs.writeFileSync('debug.html', await page.content().catch(() => ''));
    throw new Error('Could not capture the Ad Library search request. Meta may be blocking this connection. See debug.png in the run artifacts.');
  }
  log('Captured the search request. Starting searches.');

  const baseParams = new URLSearchParams(captured.body);
  const baseVars = JSON.parse(baseParams.get('variables'));

  async function replay(vars) {
    baseParams.set('variables', JSON.stringify(vars));
    return page.evaluate(async ({ url, body, headers }) => {
      const ctrl = new AbortController();
      const t = setTimeout(() => ctrl.abort(), 45000);
      try {
        const r = await fetch(url, { method: 'POST', body, headers, credentials: 'include', signal: ctrl.signal });
        return { status: r.status, text: await r.text() };
      } catch (e) {
        return { status: 0, text: '', error: String(e) };
      } finally { clearTimeout(t); }
    }, { url: captured.url, body: baseParams.toString(), headers: captured.headers });
  }

  // 2. Every term in every country, newest first, stop at the cutoff
  const kept = new Map();
  const stats = { searches: 0, requests: 0, ads_seen: 0, ads_kept: 0, empty_searches: 0, failures: 0, throttled: false };
  let consecutiveFails = 0;

  outer:
  for (const term of CONFIG.terms) {
    for (const country of CONFIG.countries) {
      stats.searches++;
      const vars = JSON.parse(JSON.stringify(baseVars));
      vars.queryString = quoteTerm(term);
      vars.countries = [country];
      vars.cursor = null;
      vars.first = CONFIG.adsPerRequest;
      vars.mediaType = 'all';
      vars.sortData = Object.assign({}, vars.sortData || {}, { mode: 'SORT_BY_START_DATE', direction: 'DESCENDING' });
      if ('searchType' in vars) vars.searchType = 'keyword_exact_phrase';

      let newHere = 0;
      for (let p = 1; p <= CONFIG.maxPagesPerSearch; p++) {
        let res = await replay(vars);
        stats.requests++;
        if (res.status === 429 || res.status >= 500 || res.status === 0) {
          stats.failures++;
          log(`  "${term}" [${country}] pushback (HTTP ${res.status}). Waiting 90s and trying once more.`);
          await sleep(90000);
          res = await replay(vars);
          stats.requests++;
        }
        if (res.status !== 200) {
          stats.failures++;
          consecutiveFails++;
          if (consecutiveFails >= 3) {
            stats.throttled = true;
            log('Three failed searches in a row. Meta is pushing back, so stopping here and sending what we have.');
            break outer;
          }
          break;
        }
        consecutiveFails = 0;

        const ads = new Map();
        let cursor = null;
        parseBodies(res.text).forEach(b => { collectAds(b, 0, ads); if (!cursor) cursor = findCursor(b, 0); });
        stats.ads_seen += ads.size;

        let oldest = Infinity;
        for (const [id, a] of ads) {
          const sd = Number(a.start_date || a.startDate || 0);
          if (sd && sd < oldest) oldest = sd;
          if (sd >= cutoff && !kept.has(id)) { kept.set(id, slim(a, term, country)); newHere++; }
        }
        if (!ads.size || !cursor || oldest < cutoff) break;
        vars.cursor = cursor;
        await sleep(jitter(CONFIG.pauseMs));
      }
      if (!newHere) stats.empty_searches++;
      log(`  "${term}" [${country}] +${newHere} new ads`);
      await sleep(jitter(CONFIG.termGapMs, 0.3));
    }
  }
  await browser.close();

  stats.ads_kept = kept.size;
  log('Done.', JSON.stringify(stats));
  if (stats.ads_seen === 0) {
    throw new Error('Every search came back empty. That usually means Meta blocked this connection rather than there being no ads.');
  }

  // 3. Hand over to n8n
  const payload = { generated_at: new Date().toISOString(), cutoff: new Date(cutoff * 1000).toISOString(),
                    countries: CONFIG.countries, stats, ads: [...kept.values()] };
  if (DRY_RUN) {
    fs.writeFileSync('ads.json', JSON.stringify(payload, null, 2));
    log(`Dry run: wrote ${kept.size} ads to ads.json, nothing sent to n8n.`);
    return;
  }
  const r = await fetch(WEBHOOK, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-WDTM-Secret': SECRET },
    body: JSON.stringify(payload),
  });
  if (!r.ok) throw new Error(`n8n webhook answered HTTP ${r.status}. Is the workflow switched on and the secret the same in both places?`);
  log(`Sent ${kept.size} ads to n8n.`);
}

main().catch(e => { console.error('FAILED:', e.message); process.exit(1); });
