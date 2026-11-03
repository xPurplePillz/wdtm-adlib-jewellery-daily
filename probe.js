// Temporary experiment: what does Facebook let GitHub's computer see?
// Loads a few Ad Library URLs like a normal visitor and reports what each one
// contains. Sends nothing anywhere.
const { chromium } = require('playwright');

const sleep = ms => new Promise(r => setTimeout(r, ms));
const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a);
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36';

function collectAds(node, depth, out) {
  if (!node || typeof node !== 'object' || depth > 40) return;
  if (Array.isArray(node)) { node.forEach(n => collectAds(n, depth + 1, out)); return; }
  const id = node.ad_archive_id || node.adArchiveID;
  if (id && (node.page_name || node.page_id || node.snapshot)) out.set(String(id), node);
  for (const k of Object.keys(node)) { const v = node[k]; if (v && typeof v === 'object') collectAds(v, depth + 1, out); }
}
function parseBodies(text) {
  const out = []; const t = String(text || '').replace(/^for \(;;\);/, '');
  try { out.push(JSON.parse(t)); return out; } catch (e) {}
  t.split('\n').forEach(l => { l = l.trim(); if (l[0] === '{') { try { out.push(JSON.parse(l)); } catch (e) {} } });
  return out;
}
const day = s => (s ? new Date(s * 1000).toISOString().slice(0, 16).replace('T', ' ') : '-');
function summary(ads) {
  const d = [...ads.values()].map(a => Number(a.start_date || 0)).filter(Boolean);
  return `${ads.size} ads, newest ${day(Math.max(...d))}, oldest ${day(Math.min(...d))}, ` +
         `first five starts: ${[...ads.values()].slice(0, 5).map(a => day(Number(a.start_date || 0)).slice(5, 10)).join(' ')}`;
}

async function embeddedAds(page) {
  const scripts = await page.$$eval('script', ss => ss.map(s => s.textContent || '').filter(t => t.includes('ad_archive_id')));
  const ads = new Map();
  scripts.forEach(t => parseBodies(t).forEach(b => collectAds(b, 0, ads)));
  return { ads, scripts: scripts.length };
}

(async () => {
  const browser = await chromium.launch({ headless: true, args: ['--disable-blink-features=AutomationControlled'] });
  const context = await browser.newContext({ userAgent: UA, locale: 'en-GB', viewport: { width: 1366, height: 900 } });
  const page = await context.newPage();

  const gql = [];
  page.on('response', async res => {
    const url = res.url();
    if (!url.includes('/api/graphql')) return;
    let name = '';
    try { name = new URLSearchParams(res.request().postData() || '').get('fb_api_req_friendly_name') || ''; } catch (e) {}
    let text = '';
    try { text = await res.text(); } catch (e) {}
    const ads = new Map(); const bodies = parseBodies(text); bodies.forEach(b => collectAds(b, 0, ads));
    const err = bodies.map(b => b && b.errors).filter(Boolean);
    gql.push(`${name} HTTP ${res.status()} ${text.length} chars, ${ads.size} ads${err.length ? ' ERR ' + JSON.stringify(err).slice(0, 150) : ''}`);
  });

  const base = 'https://www.facebook.com/ads/library/?active_status=active&ad_type=all&country=GB&q=%22jewellery%22&search_type=keyword_exact_phrase&media_type=all';
  const variants = [
    ['default', ''],
    ['sort start date desc', '&sort_data[mode]=SORT_BY_START_DATE&sort_data[direction]=desc'],
    ['sort relevancy_monthly_grouped', '&sort_data[mode]=relevancy_monthly_grouped&sort_data[direction]=desc'],
    ['sort total_impressions', '&sort_data[mode]=total_impressions&sort_data[direction]=desc'],
    ['impressions since yesterday', '&start_date[min]=' + new Date(Date.now() - 86400000).toISOString().slice(0, 10) + '&start_date[max]='],
  ];

  for (const [label, extra] of variants) {
    gql.length = 0;
    log(`---- ${label}`);
    await page.goto(base + extra, { waitUntil: 'domcontentloaded', timeout: 60000 });
    await sleep(6000);
    for (const n of [/allow all cookies/i, /decline optional cookies/i]) {
      try { const b = page.getByRole('button', { name: n }).first(); if (await b.isVisible({ timeout: 500 })) await b.click(); } catch (e) {}
    }
    const visible = await page.getByText(/Library ID/i).count().catch(() => -1);
    const emb = await embeddedAds(page);
    log(`visible cards: ${visible} | embedded in page HTML (${emb.scripts} scripts): ${summary(emb.ads)}`);
    // Scroll like a person and watch what the page's own requests get back
    for (let i = 0; i < 4; i++) { await page.mouse.wheel(0, 4000); await sleep(4000); }
    const visible2 = await page.getByText(/Library ID/i).count().catch(() => -1);
    log(`after scrolling, visible cards: ${visible2}`);
    gql.forEach(g => log('   page request: ' + g));
    if (label === 'default') {
      // Pull dates straight off the visible cards too ("Started running on ...")
      const started = await page.getByText(/Started running on/i).allInnerTexts().catch(() => []);
      log(`card date labels (first 8): ${started.slice(0, 8).join(' | ')}`);
    }
    await sleep(8000);
  }
  await browser.close();
})().catch(e => { console.error('PROBE FAILED:', e.message); process.exit(1); });
