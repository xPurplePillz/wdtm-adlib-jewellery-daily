// Quick check: can GitHub get through n8n's door? Sends an empty delivery
// (no ads), so n8n does nothing with it. Takes a few seconds.
const crypto = require('crypto');
const url = process.env.N8N_WEBHOOK_URL || '';
const secret = process.env.N8N_WEBHOOK_SECRET || '';
const fp = s => crypto.createHash('sha256').update(s).digest('hex').slice(0, 12);
console.log('Webhook URL set:', !!url, '| ends with:', url.slice(-30));
console.log('Secret length:', secret.length, '| fingerprint:', fp(secret),
            '| has spaces or line breaks at the ends:', secret !== secret.trim());
(async () => {
  for (const [label, s] of [['secret as saved', secret], ['secret trimmed', secret.trim()]]) {
    const r = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-WDTM-Secret': s },
                                 body: JSON.stringify({ check: true, ads: [] }) });
    console.log(`${label}: n8n answered HTTP ${r.status} ${(await r.text()).slice(0, 120)}`);
  }
})().catch(e => { console.error('FAILED:', e.message); process.exit(1); });
