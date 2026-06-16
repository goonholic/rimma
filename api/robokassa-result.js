// api/robokassa-result.js — Robokassa Result URL (подтверждение оплаты, сервер→сервер).
//
// Сюда Робокасса сама стучится ПОСЛЕ успешной оплаты. Мы:
//   1) проверяем подпись Паролём #2 — так нельзя подделать «оплачено»;
//   2) отвечаем строкой "OK{InvId}" (иначе Робокасса будет повторять запрос);
//   3) шлём уведомление в ту же Telegram-беседу, что и заявки.
//
// Переменные окружения:
//   ROBOKASSA_PASS2        – боевой Пароль #2
//   ROBOKASSA_TEST_PASS2   – тестовый Пароль #2
//   ROBOKASSA_IS_TEST      – '1' = тестовый режим (берём тестовый Пароль #2)
//   TELEGRAM_BOT_TOKEN / TELEGRAM_CHAT_ID – те же, что у заявок (для отстука об оплате)
'use strict';
const crypto = require('crypto');

const TITLES = {
  now: 'Что со мной происходит?',
  year: 'Годовой прогноз: личная стратегия',
  career: 'Профессиональный путь',
  situation: 'Разбор вашей ситуации',
  child: 'Карта потенциала ребёнка',
  decision: 'Большие решения',
};

function md5(s) { return crypto.createHash('md5').update(s, 'utf8').digest('hex'); }
function esc(s) { return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;'); }
// "79991234567" -> "+7 999 123-45-67" (красивое отображение телефона)
function fmtPhone(d) {
  d = String(d).replace(/\D/g, '');
  if (d.length === 11 && (d[0] === '7' || d[0] === '8')) {
    return '+7 ' + d.slice(1, 4) + ' ' + d.slice(4, 7) + '-' + d.slice(7, 9) + '-' + d.slice(9, 11);
  }
  return d ? ('+' + d) : '';
}
// Дата/время по Москве: DD.MM.YYYY HH:MM
function moscowNow() {
  return new Date().toLocaleString('ru-RU', {
    timeZone: 'Europe/Moscow', day: '2-digit', month: '2-digit', year: 'numeric',
    hour: '2-digit', minute: '2-digit',
  }).replace(',', '');
}

// Robokassa повторяет Result-запрос, пока не получит "OK{InvId}". Чтобы не слать в беседу
// дубли «Оплата получена» на эти повторы, помним уже обработанные заказы (в рамках инстанса).
const SEEN = new Set();

// Робокасса может прислать параметры в query (GET) или form-urlencoded (POST). Собираем из обоих.
function readParams(req) {
  const out = {};
  new URL(req.url, 'http://x').searchParams.forEach((v, k) => { out[k] = v; });
  if (req.method === 'POST') {
    let body = req.body;
    if (Buffer.isBuffer(body)) body = body.toString('utf8');
    if (typeof body === 'string') new URLSearchParams(body).forEach((v, k) => { out[k] = v; });
    else if (body && typeof body === 'object') Object.assign(out, body);
  }
  return out;
}

module.exports = async (req, res) => {
  try {
    const p = readParams(req);
    const outSum = p.OutSum || p.outSum || '';
    const invId = p.InvId || p.invId || '';
    const sigIn = (p.SignatureValue || p.signatureValue || '').toLowerCase();

    // Все Shp_*-параметры, что вернула Robokassa, — в АЛФАВИТНОМ порядке (как при инициации).
    const shpKeys = Object.keys(p).filter(function (k) { return /^Shp_/i.test(k); }).sort();
    const shpPairs = shpKeys.map(function (k) { return k + '=' + p[k]; });
    function shpVal(lowerName) {
      for (var i = 0; i < shpKeys.length; i++) {
        if (shpKeys[i].toLowerCase() === lowerName) return p[shpKeys[i]];
      }
      return '';
    }
    const code   = shpVal('shp_service');
    const cname  = shpVal('shp_name');
    const cphone = shpVal('shp_phone');

    const isTest = String(process.env.ROBOKASSA_IS_TEST || '') === '1';
    const PASS2 = isTest ? process.env.ROBOKASSA_TEST_PASS2 : process.env.ROBOKASSA_PASS2;
    if (!PASS2) { res.statusCode = 500; return res.end('not_configured'); }

    // Подпись Result: MD5(OutSum:InvId:Пароль#2[:Shp_* по алфавиту])
    const expect = md5([outSum, invId, PASS2].concat(shpPairs).join(':'));
    if (expect !== sigIn) { res.statusCode = 400; return res.end('bad_sign'); }

    // Подпись верна → оплата настоящая. Отстук шлём ОДИН раз на заказ и не дольше пары секунд,
    // чтобы быстро ответить Robokasse "OK" и не плодить дубли при её повторных запросах.
    const TOKEN = process.env.TELEGRAM_BOT_TOKEN, CHAT = process.env.TELEGRAM_CHAT_ID;
    if (TOKEN && CHAT && !SEEN.has(invId)) {
      SEEN.add(invId);
      const title = TITLES[code] || code || '—';
      const lines = ['✅ <b>Оплата получена</b>', '━━━━━━━━━━━━━━'];
      if (cname)  lines.push('👤 <b>Имя:</b> ' + esc(cname));
      if (cphone) lines.push('📞 <b>Телефон:</b> ' + esc(fmtPhone(cphone)));
      lines.push('✨ <b>Услуга:</b> ' + esc(title));
      lines.push('💰 <b>Сумма:</b> ' + esc(outSum) + ' ₽');
      lines.push('🧾 <b>Заказ №</b> ' + esc(invId));
      lines.push('🕐 ' + esc(moscowNow()));
      const text = lines.join('\n');
      try {
        const ctrl = new AbortController();
        const timer = setTimeout(() => ctrl.abort(), 3000);
        await fetch('https://api.telegram.org/bot' + TOKEN + '/sendMessage', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ chat_id: CHAT, text, parse_mode: 'HTML', disable_web_page_preview: true }),
          signal: ctrl.signal,
        });
        clearTimeout(timer);
      } catch (_) { /* отстук не критичен — главное ответить Робокассе OK */ }
    }

    res.statusCode = 200;
    res.setHeader('Content-Type', 'text/plain');
    return res.end('OK' + invId);   // строго так — иначе Robokassa повторяет запрос
  } catch (e) {
    res.statusCode = 500;
    return res.end('error');
  }
};
