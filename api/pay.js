// api/pay.js — Robokassa: инициация платежа.  Endpoint: /api/pay?service=<code>
//
// Браузер присылает только КОД услуги, а сумму берём из серверного прайса ниже —
// так пользователь не сможет подменить цену. Подпись считается секретным Паролём #1,
// который живёт ТОЛЬКО в переменных окружения Vercel и в коде страницы не виден.
//
// Переменные окружения (Vercel → Settings → Environment Variables):
//   ROBOKASSA_LOGIN        – идентификатор магазина (MerchantLogin)
//   ROBOKASSA_PASS1        – боевой Пароль #1
//   ROBOKASSA_TEST_PASS1   – тестовый Пароль #1
//   ROBOKASSA_IS_TEST      – '1' = тестовый режим (тестовые пароли + IsTest=1), иначе боевой
'use strict';
const crypto = require('crypto');

// Серверный прайс. Ключ — код услуги (его присылает кнопка на сайте), значение — цена и название.
const SERVICES = {
  now:       { amount: 3000,  title: 'Что со мной происходит?' },
  year:      { amount: 8000,  title: 'Годовой прогноз: личная стратегия' },
  career:    { amount: 5000,  title: 'Профессиональный путь' },
  situation: { amount: 5000,  title: 'Разбор вашей ситуации' },
  child:     { amount: 5000,  title: 'Карта потенциала ребёнка' },
  decision:  { amount: 10000, title: 'Большие решения' },
};

function md5(s) { return crypto.createHash('md5').update(s, 'utf8').digest('hex'); }
function redirect(res, location) { res.statusCode = 302; res.setHeader('Location', location); res.end(); }

module.exports = async (req, res) => {
  try {
    const code = (new URL(req.url, 'http://x').searchParams.get('service') || '').trim();
    const svc = SERVICES[code];
    if (!svc) return redirect(res, '/fail.html?e=service');

    const LOGIN = process.env.ROBOKASSA_LOGIN;
    const isTest = String(process.env.ROBOKASSA_IS_TEST || '') === '1';
    const PASS1 = isTest ? process.env.ROBOKASSA_TEST_PASS1 : process.env.ROBOKASSA_PASS1;

    // Робокасса ещё не настроена (нет ключей) — заявка уже ушла в Telegram, просто говорим спасибо.
    if (!LOGIN || !PASS1) return redirect(res, '/success.html');

    const outSum = svc.amount.toFixed(2);            // "3000.00" — одна и та же строка в подписи и в ссылке
    const invId = Math.floor(Date.now() / 1000);      // целое, влезает в диапазон Robokassa
    const shp = 'Shp_service=' + code;                // доп. параметр, чтобы в отстуке знать услугу

    // Подпись инициации: MD5(MerchantLogin:OutSum:InvId:Пароль#1[:Shp_* по алфавиту])
    const signature = md5([LOGIN, outSum, invId, PASS1, shp].join(':'));

    const params = new URLSearchParams({
      MerchantLogin: LOGIN,
      OutSum: outSum,
      InvId: String(invId),
      Description: svc.title,
      SignatureValue: signature,
      Culture: 'ru',
      Shp_service: code,
    });
    if (isTest) params.set('IsTest', '1');

    return redirect(res, 'https://auth.robokassa.ru/Merchant/Index.aspx?' + params.toString());
  } catch (e) {
    return redirect(res, '/fail.html?e=server');
  }
};
