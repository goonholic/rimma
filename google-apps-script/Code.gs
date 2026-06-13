/**
 * Google Apps Script — приём заявок с сайта Риммы Сабитовой.
 * Каждая заявка добавляется строкой в Google-таблицу и (по желанию) дублируется письмом.
 *
 * Полная инструкция — в файле НАСТРОЙКА_ЗАЯВКИ_GOOGLE.md. Кратко:
 *   1. Создайте Google-таблицу → меню «Расширения» → «Apps Script».
 *   2. Вставьте этот код, сохраните (значок дискеты).
 *   3. «Развернуть» → «Новое развёртывание» → тип «Веб-приложение»:
 *        • Запуск от имени: «От моего имени»
 *        • У кого есть доступ: «Все» (Anyone)
 *   4. Скопируйте URL развёртывания (…/exec) и вставьте в index.html
 *      в переменную SHEET_WEBAPP_URL.
 */

// Куда дублировать заявку письмом. Поставьте '' (пустую строку), чтобы письма не отправлялись.
var NOTIFY_EMAIL = 'rimma.kulmametova@yandex.ru';

// Заголовки столбцов (создаются автоматически в первой строке таблицы).
var HEADERS = ['Дата и время', 'Имя', 'Контакт', 'Услуга', 'Дата рождения', 'Вопрос'];

function doPost(e) {
  try {
    var data = {};
    if (e && e.postData && e.postData.contents) {
      data = JSON.parse(e.postData.contents);
    }

    // Ханипот: если скрытое поле заполнено — это бот. Тихо отвечаем «ок» и ничего не пишем.
    if (data.website && String(data.website).trim() !== '') {
      return json({ ok: true });
    }

    var name     = clip(data.name, 80);
    var contact  = clip(data.contact, 80);
    var service  = clip(data.service, 120);
    var birth    = clip(data.birth, 80);
    var question = clip(data.question, 1000);

    if (!name || !contact) {
      return json({ ok: false, error: 'validation' });
    }

    var ts = Utilities.formatDate(new Date(), 'Europe/Moscow', 'dd.MM.yyyy HH:mm');

    var sheet = SpreadsheetApp.getActiveSpreadsheet().getSheets()[0];
    if (sheet.getLastRow() === 0) {
      sheet.appendRow(HEADERS);
      sheet.getRange(1, 1, 1, HEADERS.length).setFontWeight('bold');
    }
    sheet.appendRow([ts, name, contact, service, birth, question]);

    if (NOTIFY_EMAIL) {
      var body =
        'Новая заявка с сайта\n\n' +
        'Имя: ' + name + '\n' +
        'Контакт: ' + contact + '\n' +
        'Услуга: ' + (service || '—') + '\n' +
        'Дата рождения: ' + (birth || '—') + '\n' +
        'Вопрос: ' + (question || '—') + '\n\n' +
        'Время (МСК): ' + ts;
      try {
        MailApp.sendEmail(NOTIFY_EMAIL, '🔮 Новая заявка с сайта — ' + name, body);
      } catch (mailErr) {
        // Если письмо не ушло — запись в таблицу всё равно сохранена, заявку не теряем.
      }
    }

    return json({ ok: true });
  } catch (err) {
    return json({ ok: false, error: 'server_error' });
  }
}

// Открыв URL развёртывания в браузере, вы увидите {"ok":true,...} — значит приложение живо.
function doGet() {
  return json({ ok: true, service: 'rimma-leads' });
}

function clip(s, n) {
  return String(s == null ? '' : s).trim().slice(0, n);
}

function json(obj) {
  return ContentService
    .createTextOutput(JSON.stringify(obj))
    .setMimeType(ContentService.MimeType.JSON);
}
