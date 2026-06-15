// api/lead.js  —  Vercel Serverless Function (Node.js).  Endpoint: /api/lead
// Same job as the Netlify version: takes a lead from the contact form and sends it to Telegram.
//
// No npm dependencies — uses the global `fetch` built into Node 18+ on Vercel.
//
// Secrets live ONLY in Vercel environment variables (Project → Settings → Environment
// Variables), never in this file or the public site:
//   TELEGRAM_BOT_TOKEN   – bot token from @BotFather
//   TELEGRAM_CHAT_ID     – numeric chat id of the recipient (or a group id starting with -)

'use strict';

// ── Simple in-memory rate limit (per warm instance) ──
// Instance memory resets on cold starts — that's fine, this is only a barrier against
// primitive flooding, not a hard guarantee.
const HITS = new Map(); // ip -> [timestamps]
const MIN_GAP_MS = 10 * 1000; // at most 1 request / 10 s per IP
const MAX_PER_HOUR = 5;       // at most 5 requests / hour per IP

function rateLimited(ip) {
  const now = Date.now();
  let arr = (HITS.get(ip) || []).filter((t) => now - t < 3600 * 1000);
  let limited = false;
  if (arr.length && now - arr[arr.length - 1] < MIN_GAP_MS) limited = true;
  else if (arr.length >= MAX_PER_HOUR) limited = true;
  else arr.push(now);
  HITS.set(ip, arr);
  return limited;
}

// Escape user text before putting it into an HTML-parsed Telegram message.
function esc(s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}
// Trim + hard-limit length (defensive; never throws).
function clip(s, n) {
  return String(s == null ? '' : s).trim().slice(0, n);
}

// CORS. '*' is fine for a public contact form. To lock it to your domain, replace '*'
// with e.g. 'https://your-project.vercel.app' (or your custom domain).
function setCors(res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
}
function send(res, code, obj) {
  setCors(res);
  res.setHeader('Content-Type', 'application/json');
  res.status(code).send(JSON.stringify(obj));
}

module.exports = async (req, res) => {
  // CORS preflight
  if (req.method === 'OPTIONS') {
    setCors(res);
    return res.status(204).end();
  }
  // POST only
  if (req.method !== 'POST') return send(res, 405, { ok: false, error: 'method_not_allowed' });

  try {
    // Vercel auto-parses JSON bodies, but be defensive (string / Buffer / undefined).
    let body = req.body;
    if (Buffer.isBuffer(body)) body = body.toString('utf8');
    if (typeof body === 'string') {
      try { body = JSON.parse(body || '{}'); } catch (_) { return send(res, 400, { ok: false, error: 'bad_json' }); }
    }
    if (!body || typeof body !== 'object') body = {};

    // Honeypot: if filled, it's a bot. Pretend success but send nothing.
    if (body.website && String(body.website).trim() !== '') return send(res, 200, { ok: true });

    // Rate limit by client IP (Vercel sets x-forwarded-for / x-real-ip).
    const h = req.headers || {};
    const ip = ((h['x-forwarded-for'] || '').split(',')[0].trim()) || h['x-real-ip'] || 'unknown';
    if (rateLimited(ip)) return send(res, 429, { ok: false, error: 'rate_limited' });

    // Validate + clip
    const name = clip(body.name, 60);
    const contact = clip(body.contact, 40);
    const service = clip(body.service, 60);
    const birth = clip(body.birth, 40);
    const question = clip(body.question, 600);

    if (!name || !contact) return send(res, 400, { ok: false, error: 'validation' });

    const TOKEN = process.env.TELEGRAM_BOT_TOKEN;
    const CHAT = process.env.TELEGRAM_CHAT_ID;
    if (!TOKEN || !CHAT) {
      console.error('lead: missing TELEGRAM_BOT_TOKEN / TELEGRAM_CHAT_ID env vars');
      return send(res, 502, { ok: false, error: 'not_configured' });
    }

    // Moscow date/time: DD.MM.YYYY HH:MM
    const ts = new Date().toLocaleString('ru-RU', {
      timeZone: 'Europe/Moscow',
      day: '2-digit', month: '2-digit', year: 'numeric',
      hour: '2-digit', minute: '2-digit',
    }).replace(',', '');

    const text =
      '🔮 <b>Новая заявка с сайта</b>\n' +
      '━━━━━━━━━━━━━━\n' +
      '👤 <b>Имя:</b> ' + esc(name) + '\n' +
      '📞 <b>Контакт:</b> ' + esc(contact) + '\n' +
      '✨ <b>Услуга:</b> ' + esc(service || '—') + '\n' +
      '🎂 <b>Дата рождения:</b> ' + esc(birth || '—') + '\n' +
      '💬 <b>Вопрос:</b> ' + esc(question || '—') + '\n' +
      '━━━━━━━━━━━━━━\n' +
      '🕐 ' + esc(ts);

    // ── Send to Telegram (primary channel) ──
    const tgRes = await fetch('https://api.telegram.org/bot' + TOKEN + '/sendMessage', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        chat_id: CHAT,
        text,
        parse_mode: 'HTML',
        disable_web_page_preview: true,
      }),
    });

    if (!tgRes.ok) {
      const detail = await tgRes.text().catch(() => '');
      console.error('lead: telegram error', tgRes.status, detail);
      return send(res, 502, { ok: false, error: 'telegram_failed' });
    }

    return send(res, 200, { ok: true });
  } catch (err) {
    console.error('lead: unexpected error', err);
    return send(res, 502, { ok: false, error: 'server_error' });
  }
};
