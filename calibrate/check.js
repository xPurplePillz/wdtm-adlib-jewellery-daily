// One-off: fetch each homepage and measure how much of it is about jewellery.
// Same logic as the n8n homepage check. Prints one line per site. Sends nothing anywhere.
const sites = require('./sites.json');
const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36';
const JEWEL_TERMS = ['jewellery','jewelry','jeweller','jeweler','jewel','necklace','pendant','earring','ear stack','hoops','studs','bracelet','bangle','anklet','charm','locket','signet','choker','cufflink','brooch','tiara','925','sterling silver','9ct','18ct','14ct','22ct','9k','14k','18k','24k','carat','vermeil','gold plated','gold-plated','gold filled','solid gold','hallmark','diamond','moissanite','lab grown','lab-grown','sapphire','emerald','ruby','opal','pearl','gemstone','birthstone','engagement ring','wedding ring','wedding band','eternity','solitaire','tarnish','hypoallergenic','piercing','goldsmith','silversmith','engraved','keepsake','memorial','ring'];
const JEWEL_RE = new RegExp('\\b(' + JEWEL_TERMS.map(t => t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|') + ')s?\\b', 'gi');
const OTHER_RE = /\b(kitchen\w*|cookware|car accessor\w*|automotive|power tools?|drills?|garden\w*|furniture|sofas?|bedding|pet food|dog food|toys?|phone cases?|electronics?|gadgets?|laptops?|headphones?|skincare|serums?|supplements?|vitamins?|trainers|sneakers|t-shirts?|hoodies?|paraglid\w*|webinars?|software|subscription box|candles?|mugs?|home decor|homeware|lighting)\b/gi;
function visibleText(html) {
  const h = String(html || '').replace(/data:[a-z]+\/[a-z0-9.+-]+;base64,[a-z0-9+\/=]+/gi, ' ').replace(/<style[\s\S]*?<\/style>/gi, ' ').replace(/<svg[\s\S]*?<\/svg>/gi, ' ').slice(0, 1500000);
  const meta = (h.match(/<meta[^>]+(name|property)=["'](description|og:title|og:description)["'][^>]*>/gi) || []).map(m => (m.match(/content=["']([^"']*)["']/i) || [])[1] || '').join(' ');
  return (meta + ' ' + h.replace(/<script[\s\S]*?<\/script>/gi, ' ').replace(/<noscript[\s\S]*?<\/noscript>/gi, ' ').replace(/<[^>]+>/g, ' ')).replace(/&[a-z#0-9]+;/gi, ' ').replace(/\s+/g, ' ');
}
async function check(s) {
  const ctrl = new AbortController(); const t = setTimeout(() => ctrl.abort(), 15000);
  try {
    const r = await fetch('https://' + s.domain + '/', { headers: { 'User-Agent': UA, 'Accept': 'text/html' }, signal: ctrl.signal, redirect: 'follow' });
    const html = r.status < 400 ? await r.text() : '';
    const text = visibleText(html);
    const j = text.match(JEWEL_RE) || [], o = text.match(OTHER_RE) || [];
    const title = (html.match(/<title[^>]*>([^<]{0,90})/i) || [])[1] || '';
    return { d: s.domain, st: r.status, len: text.length, j: j.length, jd: new Set(j.map(x => x.toLowerCase().replace(/s$/, ''))).size, o: o.length, od: new Set(o.map(x => x.toLowerCase())).size, title: title.replace(/\s+/g, ' ').trim() };
  } catch (e) { return { d: s.domain, st: 0, err: String(e.name || e).slice(0, 30) }; }
  finally { clearTimeout(t); }
}
(async () => {
  let i = 0;
  async function worker() { while (i < sites.length) { const s = sites[i++]; const r = await check(s); console.log('HP\t' + JSON.stringify(r)); } }
  await Promise.all(Array.from({ length: 10 }, worker));
})();
