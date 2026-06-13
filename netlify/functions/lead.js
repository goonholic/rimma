// netlify/functions/lead.js
// Receives a lead from the site's contact form and forwards it to Telegram,
// and (optionally) archives it to a Google Sheet.
//
// No npm dependencies — uses the global `fetch` built into Node 18+.
//
// Secrets live ONLY in Netlify environment variables (never in this file or the public site):
//   TELEGRAM_BOT_TOKEN   – bot token from @BotFather
//   TELEGRAM_CHAT_ID     – numeric chat id of the recipient (or a group id starting with -)
//   GSHEET_WEBHOOK_URL   – (optional) Google Apps Script web-app URL for the archive

'use strict';

// ── Simple in-memory rate limit (per warm function instance) ──
// Note: instance memory resets on cold starts — that's fine, this is only a barrier
// against primitive flooding, not a hard guarantee.
const HITS = new Map(); // ip -> [timestamps]
const MIN_GAP_MS = 10 * 1000;        // at most 1 request / 10 s per IP
const MAX_PER_HOUR = 5;              // at most 5 requests / hour per IP

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

// ── CORS ──
// '*' is fine for a public contact form. To lock it to your domain, replace '*' with
// e.g. 'https://rimma-astro.netlify.app' (or your custom domain).
const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
};

function reply(statusCode, obj) {
  return {
    statusCode,
    headers: { 'Content-Type': 'application/json', ...CORS },
    body: JSON.stringify(obj),
  };
}

// Escape user text before putting it into an HTML-parsed Telegram message.
function esc(s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}
// Trim + hard-limit length (defensive; never throws).
function clip(s, n) {
  return String(s == null ? '' : s).trim().slice(0, n);
}

exports.handler = async (event) => {
  // CORS preflight
  if (event.httpMethod === 'OPTIONS') return { statusCode: 204, headers: CORS, body: '' };
  // POST only
  if (event.httpMethod !== 'POST') return reply(405, { ok: false, error: 'method_not_allowed' });

  try {
    let body;
    try {
      body = JSON.parse(event.body || '{}');
    } catch (_) {
      return reply(400, { ok: false, error: 'bad_json' });
    }

    // Honeypot: if filled, it's a bot. Pretend success but send nothing.
    if (body.website && String(body.website).trim() !== '') {
      return reply(200, { ok: true });
    }

    // Rate limit by client IP
    const headers = event.headers || {};
    const ip = (
      headers['x-nf-client-connection-ip'] ||
      (headers['x-forwarded-for'] || '').split(',')[0] ||
      'unknown'
    ).trim();
    if (rateLimited(ip)) return reply(429, { ok: false, error: 'rate_limited' });

    // Validate + clip
    const name = clip(body.name, 60);
    const contact = clip(body.contact, 40);
    const service = clip(body.service, 60);
    const birth = clip(body.birth, 40);
    const question = clip(body.question, 600);

    if (!name || !contact) return reply(400, { ok: false, error: 'validation' });

    const TOKEN = process.env.TELEGRAM_BOT_TOKEN;
    const CHAT = process.env.TELEGRAM_CHAT_ID;
    if (!TOKEN || !CHAT) {
      console.error('lead: missing TELEGRAM_BOT_TOKEN / TELEGRAM_CHAT_ID env vars');
      return reply(502, { ok: false, error: 'not_configured' });
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
      return reply(502, { ok: false, error: 'telegram_failed' });
    }

    // ── Optional archive to Google Sheets (never breaks the user response) ──
    const sheetUrl = process.env.GSHEET_WEBHOOK_URL;
    if (sheetUrl) {
      try {
        await fetch(sheetUrl, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ name, contact, service, birth, question, ts }),
        });
      } catch (err) {
        console.error('lead: google sheets error (ignored)', err);
      }
    }

    return reply(200, { ok: true });
  } catch (err) {
    console.error('lead: unexpected error', err);
    return reply(502, { ok: false, error: 'server_error' });
  }
};
