/**
 * WDTM DAILY AD LIBRARY HARVEST
 *
 * Our own scraper. No third-party scraping service.
 * Opens Ad Library search pages like a normal logged-out visitor, sorted most
 * recent first, and reads the ads Facebook builds into each page (30 per page).
 * It never scrolls or asks for "more": Facebook throttles those requests from
 * GitHub's computers, but plain page loads come back fine.
 * Big searches are split by ad type (image / video / meme) so each part gets
 * its own 30. Keeps ads that started in the lookback window. Search terms and
 * junk rules are Kyle's.
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
 *   LOOKBACK_DAYS        variable, optional (default 1 = ads that started yesterday or today)
 */
const { chromium } = require('playwright');
const fs = require('fs');

// ---- settings ---------------------------------------------------------------
const CONFIG = {
  countries: (process.env.COUNTRIES || 'GB').split(',').map(s => s.trim().toUpperCase()).filter(Boolean),
  // Facebook only records the DATE an ad started, not the time. So "the last
  // 24 hours" is done as "started yesterday or today", which never misses a day
  // even if GitHub starts the run a bit late (it sometimes does).
  lookbackDays: Number(process.env.LOOKBACK_DAYS || 1),
  pageGapMs: 2500,      // gap between page loads, jittered
  fullPage: 30,         // Facebook shows 30 ads per page. A full page means there's more to split out.
  splitBy: ['image', 'video', 'meme'],
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
  if (!node || typeof node !== 'object' || depth > 40) return;
  if (Array.isArray(node)) { node.forEach(n => collectAds(n, depth + 1, out)); return; }
  const id = node.ad_archive_id || node.adArchiveID || node.adArchiveId;
  if (id && (node.page_name || node.pageName || node.page_id || node.snapshot)) out.set(String(id), node);
  for (const k of Object.keys(node)) {
    const v = node[k];
    if (v && typeof v === 'object') collectAds(v, depth + 1, out);
  }
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
}

function searchUrl(term, country, media) {
  return (process.env.ADLIB_BASE || 'https://www.facebook.com') + '/ads/library/?active_status=active&ad_type=all'
    + '&country=' + country
    + '&q=' + encodeURIComponent(quoteTerm(term))
    + '&search_type=keyword_exact_phrase'
    + '&media_type=' + media
    + '&sort_data[mode]=relevancy_monthly_grouped&sort_data[direction]=desc';
}

// Reads the ads Facebook builds into the page itself (no extra requests).
async function adsOnPage(page) {
  const ads = new Map();
  for (let tries = 0; tries < 6; tries++) {
    const scripts = await page.$$eval('script', ss => ss.map(s => s.textContent || '').filter(t => t.includes('ad_archive_id'))).catch(() => []);
    scripts.forEach(t => parseBodies(t).forEach(b => collectAds(b, 0, ads)));
    if (ads.size) break;
    await sleep(1000);
  }
  return ads;
}

async function main() {
  if (!DRY_RUN && !WEBHOOK) throw new Error('N8N_WEBHOOK_URL is not set. Add it as a GitHub secret.');
  const today = new Date();
  const cutoff = Math.floor(Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate()) / 1000)
                 - CONFIG.lookbackDays * 86400;
  log(`Looking for ads started since ${new Date(cutoff * 1000).toISOString()} in ${CONFIG.countries.join(', ')}`);

  const browser = await chromium.launch({ headless: true, executablePath: process.env.CHROME_PATH || undefined,
                                           args: ['--disable-blink-features=AutomationControlled'] });
  const context = await browser.newContext({ userAgent: UA, locale: 'en-GB', viewport: { width: 1366, height: 900 } });
  const page = await context.newPage();
  // The page tries to load more results by itself. Facebook throttles those
  // from GitHub, and they only add noise, so block them.
  await page.route('**/api/graphql/**', r => r.abort()).catch(() => {});

  const kept = new Map();
  const stats = { page_loads: 0, ads_seen: 0, ads_kept: 0, empty_pages: 0, blank_in_a_row: 0, blocked: false };
  let firstPage = true;

  async function load(term, country, media) {
    stats.page_loads++;
    try {
      await page.goto(searchUrl(term, country, media), { waitUntil: 'domcontentloaded', timeout: 60000 });
    } catch (e) {
      log(`  "${term}" [${country}/${media}] page didn't load: ${e.message.split('\n')[0]}`);
      return null;
    }
    if (firstPage) { firstPage = false; await sleep(2000); await dismissPopups(page); }
    const ads = await adsOnPage(page);
    stats.ads_seen += ads.size;
    let fresh = 0;
    for (const [id, a] of ads) {
      const sd = Number(a.start_date || a.startDate || 0);
      if (sd >= cutoff && !kept.has(id)) { kept.set(id, slim(a, term, country)); fresh++; }
    }
    if (!ads.size) stats.empty_pages++;
    return { total: ads.size, fresh };
  }

  outer:
  for (const term of CONFIG.terms) {
    for (const country of CONFIG.countries) {
      const all = await load(term, country, 'all');
      let line = `  "${term}" [${country}] ${all ? all.total : '?'} on page, +${all ? all.fresh : 0} new`;

      // The first, broadest search should always have ads. If it's blank, we're blocked.
      if (all && all.total === 0) stats.blank_in_a_row++; else stats.blank_in_a_row = 0;
      if (term === CONFIG.terms[0] && all && all.total === 0) {
        await page.screenshot({ path: 'page.png' }).catch(() => {});
        stats.blocked = true;
        log(line);
        log('The broadest search came back blank, so Facebook is likely blocking this connection today. Stopping.');
        break outer;
      }

      // A full page means there are more ads than fit: split by ad type so each gets its own 30
      if (all && all.total >= CONFIG.fullPage) {
        for (const media of CONFIG.splitBy) {
          await sleep(jitter(CONFIG.pageGapMs));
          const part = await load(term, country, media);
          if (part) line += ` | ${media} +${part.fresh}`;
        }
      }
      log(line);
      await sleep(jitter(CONFIG.pageGapMs));
    }
  }
  await page.screenshot({ path: 'page.png' }).catch(() => {});
  await browser.close();

  stats.ads_kept = kept.size;
  log('Done.', JSON.stringify(stats));
  if (stats.ads_seen === 0) {
    throw new Error('No ads on any page. Facebook is most likely blocking GitHub today. See page.png in the debug download.');
  }

  // Hand over to n8n
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
  log(`Sent ${kept.size} new ads (from ${new Set([...kept.values()].map(a => a.page_id)).size} brands) to n8n.`);
}

main().catch(e => { console.error('FAILED:', e.message); process.exit(1); });
