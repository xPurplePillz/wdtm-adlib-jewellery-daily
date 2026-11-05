// One-off spot check: open each homepage and report what's there. Sends nothing anywhere.
const domains = process.argv.slice(2);
const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36';
const strip = h => h.replace(/<script[\s\S]*?<\/script>/gi, ' ').replace(/<style[\s\S]*?<\/style>/gi, ' ').replace(/<[^>]+>/g, ' ').replace(/&[a-z#0-9]+;/gi, ' ').replace(/\s+/g, ' ');
async function get(url, json) {
  const c = new AbortController(); const t = setTimeout(() => c.abort(), 15000);
  try { const r = await fetch(url, { headers: { 'User-Agent': UA }, signal: c.signal, redirect: 'follow' }); return { st: r.status, url: r.url, body: await (json ? r.json().catch(() => null) : r.text()) }; }
  catch (e) { return { st: 0, err: String(e.name) }; } finally { clearTimeout(t); }
}
(async () => {
  for (const d of domains) {
    const h = await get('https://' + d + '/');
    if (!h.st || h.st >= 400) { console.log('SPOT\t' + JSON.stringify({ d, st: h.st, err: h.err })); continue; }
    const html = h.body || '', text = strip(html);
    const title = ((html.match(/<title[^>]*>([^<]{0,140})/i) || [])[1] || '').trim();
    const desc = ((html.match(/<meta[^>]+name=["']description["'][^>]*content=["']([^"']{0,220})/i) || [])[1] || '');
    const p = await get('https://' + d + '/products.json?limit=250', true);
    const prods = (p.body && p.body.products) || [];
    const prices = prods.flatMap(x => (x.variants || []).map(v => Number(v.price))).filter(n => n > 0).sort((a, b) => a - b);
    const about = (text.match(/(founded|since \d{4}|est\.? ?\d{4}|our story|family[- ]run|handmade in|based in|workshop|studio in)[^.]{0,140}/i) || [''])[0];
    const flags = {
      sale: (text.match(/up to \d{2}% off|\d{2}% off|clearance|closing down|final sale|goodbye/gi) || []).slice(0, 4),
      currency: { gbp: (html.match(/£/g) || []).length, usd: (html.match(/\$/g) || []).length, eur: (html.match(/€/g) || []).length },
      phoneUK: /\+44|0\d{3,4} ?\d{3} ?\d{3,4}/.test(text), address: (text.match(/[A-Z]{1,2}\d[A-Z\d]? ?\d[A-Z]{2}/) || [''])[0],
    };
    console.log('SPOT\t' + JSON.stringify({ d, st: h.st, final: h.url, title, desc, about, products: prods.length, price_low: prices[0], price_mid: prices[Math.floor(prices.length / 2)], vendors: [...new Set(prods.map(x => x.vendor))].slice(0, 3), ...flags, snippet: text.slice(0, 300) }));
  }
})();
