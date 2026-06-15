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

    // Фискальный чек (Робочеки СМЗ для самозанятого). Robokassa сам отправит чек покупателю и в «Мой налог».
    //  • sno НЕ передаём — в рамках Робочеки СМЗ система подставит корректный СНО сама.
    //  • tax:'none' (самозанятый — без НДС); при необходимости Robokassa скорректирует.
    //  • sum по позиции = OutSum (одна услуга, кол-во 1).
    const receipt = {
      items: [{
        name: svc.title,                 // ≤128 символов — попадёт в чек покупателю
        quantity: 1,
        sum: svc.amount,
        payment_method: 'full_payment',  // полный расчёт (предоплата консультации)
        payment_object: 'service',       // услуга
        tax: 'none',
      }],
    };
    // ВАЖНО: одна и та же URL-кодированная строка Receipt идёт И в подпись, И в ссылку.
    // Поэтому ссылку собираем вручную (URLSearchParams закодировал бы '%' повторно и сломал подпись).
    const receiptEnc = encodeURIComponent(JSON.stringify(receipt));

    // Подпись инициации: MD5(MerchantLogin:OutSum:InvId:Receipt:Пароль#1[:Shp_* по алфавиту]),
    // Receipt — в URL-кодированном виде.
    const signature = md5([LOGIN, outSum, invId, receiptEnc, PASS1, shp].join(':'));

    const query =
      'MerchantLogin=' + encodeURIComponent(LOGIN) +
      '&OutSum=' + outSum +
      '&InvId=' + invId +
      '&Description=' + encodeURIComponent(svc.title) +
      '&Receipt=' + receiptEnc +
      '&SignatureValue=' + signature +
      '&Culture=ru' +
      '&Encoding=utf-8' +
      '&Shp_service=' + encodeURIComponent(code) +
      (isTest ? '&IsTest=1' : '');

    return redirect(res, 'https://auth.robokassa.ru/Merchant/Index.aspx?' + query);
  } catch (e) {
    return redirect(res, '/fail.html?e=server');
  }
};
