'use strict';

const PRELOAD_MARKER_START = '/* __AGY_RU_PRELOAD_START__ */';
const PRELOAD_MARKER_END = '/* __AGY_RU_PRELOAD_END__ */';

/**
 * Удаляет ранее внедрённый блок DOM-русификатора из кода preload.js (для полной идемпотентности).
 * Корректно работает независимо от того, вставлен блок перед contextBridge или в конец файла.
 * @param {string} preloadCode
 */
function stripPreloadDomRuntime(preloadCode) {
  const startIdx = preloadCode.indexOf(PRELOAD_MARKER_START);
  if (startIdx === -1) return preloadCode;
  const endIdx = preloadCode.indexOf(PRELOAD_MARKER_END, startIdx);
  if (endIdx === -1) return preloadCode;
  const before = preloadCode.slice(0, startIdx).trimEnd();
  const after = preloadCode.slice(endIdx + PRELOAD_MARKER_END.length).trimStart();
  if (!after) {
    return before + '\n';
  }
  return before + '\n' + after;
}

/**
 * Автономная среда живой русификации интерфейса Antigravity 2.0.
 * Сериализуется через Function.prototype.toString() и внедряется в dist/preload.js:
 * 1) Перехватывает нативные контекстные меню (electronNativeAPI.showContextMenu) и системные уведомления (notificationAPI.send)
 *    до их заморозки в contextBridge.exposeInMainWorld.
 * 2) Запускает безопасный для React Fiber наблюдатель DOM (MutationObserver), который переводит статические,
 *    многострочные, составные и динамические строки (квоты моделей, таймеры, счётчики), не затрагивая <kbd>, иконки и код.
 *
 * @param {Record<string, string>} EXACT
 * @param {object} [scopeOverrides] Используется в модульных тестах для передачи тестовых объектов API/DOM
 */
/* istanbul ignore next */
function antigravityPreloadRuntime(EXACT, scopeOverrides) {
  var apiResult = null;
  try {
    // 1. Индексируем словарь: точные ключи, ключи без крайних пробелов и ключи со схлопнутыми переносами строк
    var TRIMMED_EXACT = Object.create(null);
    var COLLAPSED_EXACT = Object.create(null);
    var rawKeys = Object.keys(EXACT);
    for (var k = 0; k < rawKeys.length; k++) {
      var rk = rawKeys[k];
      var rv = EXACT[rk];
      if (!rk || typeof rv !== 'string') continue;
      var tk = rk.trim();
      var tv = rv.trim();
      if (tk && !Object.prototype.hasOwnProperty.call(TRIMMED_EXACT, tk)) {
        TRIMMED_EXACT[tk] = tv;
      }
      var ck = tk.replace(/\s+/g, ' ');
      if (ck && !Object.prototype.hasOwnProperty.call(COLLAPSED_EXACT, ck)) {
        COLLAPSED_EXACT[ck] = tv;
      }
    }

    // Склонение русских существительных по числительному: pluralRu(5, 'день', 'дня', 'дней')
    function pluralRu(num, one, few, many) {
      var parsed = Math.abs(parseFloat(String(num).replace(/,/g, '')));
      if (isNaN(parsed)) return many;
      if (Math.floor(parsed) !== parsed) return few;
      var n = parsed % 100;
      var n1 = n % 10;
      if (n > 10 && n < 20) return many;
      if (n1 > 1 && n1 < 5) return few;
      if (n1 === 1) return one;
      return many;
    }

    // Перевод развёрнутых английских интервалов времени ("3 days, 12 hours", "1 hour, 10 minutes", "45 seconds")
    function translateDurationEnToRu(durStr, accusative) {
      if (!durStr) return durStr;
      var s = durStr.trim();
      if (/^(?:less than a minute|<\s*1\s*min(?:ute)?)$/i.test(s)) {
        return 'менее минуты';
      }
      if (/^(?:less than a second|<\s*1\s*s(?:ec(?:ond)?)?)$/i.test(s)) {
        return accusative ? 'менее секунды' : 'менее 1 с';
      }
      if (/^(?:a few seconds|several seconds)$/i.test(s)) {
        return 'несколько секунд';
      }
      if (/^soon$/i.test(s)) {
        return 'скоро';
      }
      if (/^now$/i.test(s)) {
        return 'сейчас';
      }

      var replacedAny = false;
      var out = s
        .replace(/(\d+(?:\.\d+)?)\s+weeks?\b/gi, function (_, n) {
          replacedAny = true;
          return n + ' ' + pluralRu(n, accusative ? 'неделю' : 'неделя', 'недели', 'недель');
        })
        .replace(/(\d+(?:\.\d+)?)\s+days?\b/gi, function (_, n) {
          replacedAny = true;
          return n + ' ' + pluralRu(n, 'день', 'дня', 'дней');
        })
        .replace(/(\d+(?:\.\d+)?)\s+(?:hours?|hrs?)\b/gi, function (_, n) {
          replacedAny = true;
          return n + ' ' + pluralRu(n, 'час', 'часа', 'часов');
        })
        .replace(/(\d+(?:\.\d+)?)\s+(?:minutes?|mins?)\b/gi, function (_, n) {
          replacedAny = true;
          return n + ' ' + pluralRu(n, accusative ? 'минуту' : 'минута', 'минуты', 'минут');
        })
        .replace(/(\d+(?:\.\d+)?)\s+(?:seconds?|secs?)\b/gi, function (_, n) {
          replacedAny = true;
          return n + ' ' + pluralRu(n, accusative ? 'секунду' : 'секунда', 'секунды', 'секунд');
        })
        .replace(/\s+and\s+/gi, ' и ');

      if (replacedAny) return out;

      // Короткий формат вида "2d 5h", "1h 10m", "45m", "1.5s", "350ms"
      if (/^\d+(?:\.\d+)?\s*(?:ms|[wdhms])(?:\s+\d+(?:\.\d+)?\s*(?:ms|[wdhms]))*$/i.test(s)) {
        return s
          .replace(/(\d+(?:\.\d+)?)\s*ms\b/gi, '$1 мс')
          .replace(/(\d+(?:\.\d+)?)\s*w\b/gi, '$1 нед.')
          .replace(/(\d+(?:\.\d+)?)\s*d\b/gi, '$1 дн.')
          .replace(/(\d+(?:\.\d+)?)\s*h\b/gi, '$1 ч')
          .replace(/(\d+(?:\.\d+)?)\s*m\b/gi, '$1 мин')
          .replace(/(\d+(?:\.\d+)?)\s*s\b/gi, '$1 с');
      }

      return durStr;
    }

    // Перевод названия периода квоты в родительном или винительном падеже
    function translateQuotaPeriod(periodRaw, caseKind) {
      var p = periodRaw.trim().toLowerCase();
      var genMap = {
        'weekly': 'недельного',
        'week': 'недельного',
        '5-hour': '5-часового',
        'five-hour': '5-часового',
        'five hour': '5-часового',
        'daily': 'дневного',
        'day': 'дневного',
        'hourly': 'часового',
        'hour': 'часового',
        'monthly': 'месячного',
        'month': 'месячного'
      };
      var accMap = {
        'weekly': 'недельный',
        'week': 'недельный',
        '5-hour': '5-часовой',
        'five-hour': '5-часовой',
        'five hour': '5-часовой',
        'daily': 'дневной',
        'day': 'дневной',
        'hourly': 'часовой',
        'hour': 'часовой',
        'monthly': 'месячный',
        'month': 'месячный'
      };
      var nMatch = p.match(/^(\d+)[\s-]hour$/);
      if (nMatch) {
        return nMatch[1] + (caseKind === 'acc' ? '-часовой' : '-часового');
      }
      if (caseKind === 'acc' && accMap[p]) return accMap[p];
      if (genMap[p]) return genMap[p];
      return null;
    }

    // Перевод вложенного названия вкладки или команды, если оно есть в словаре
    function translateInnerTerm(term) {
      if (!term) return term;
      var t = term.trim();
      if (Object.prototype.hasOwnProperty.call(TRIMMED_EXACT, t)) {
        return TRIMMED_EXACT[t];
      }
      return t;
    }

    // Перевод английских дат вида "November 18, 2026" / "Nov 18, 2026" / "18 November 2026"
    function translateEnDateToRu(rawDate) {
      if (!rawDate) return rawDate;
      var s = rawDate.trim().replace(/\.$/, '');
      var months = {
        january: 'января', jan: 'января',
        february: 'февраля', feb: 'февраля',
        march: 'марта', mar: 'марта',
        april: 'апреля', apr: 'апреля',
        may: 'мая',
        june: 'июня', jun: 'июня',
        july: 'июля', jul: 'июля',
        august: 'августа', aug: 'августа',
        september: 'сентября', sep: 'сентября', sept: 'сентября',
        october: 'октября', oct: 'октября',
        november: 'ноября', nov: 'ноября',
        december: 'декабря', dec: 'декабря'
      };
      var m1 = s.match(/^([A-Za-z]+)\.?\s+(\d{1,2})(?:,\s*(\d{4}))?$/);
      if (m1) {
        var mon1 = months[m1[1].toLowerCase()];
        if (mon1) {
          return m1[2] + ' ' + mon1 + (m1[3] ? (' ' + m1[3] + ' г.') : '');
        }
      }
      var m2 = s.match(/^(\d{1,2})\s+([A-Za-z]+)\.?(?:,?\s*(\d{4}))?$/);
      if (m2) {
        var mon2 = months[m2[2].toLowerCase()];
        if (mon2) {
          return m2[1] + ' ' + mon2 + (m2[3] ? (' ' + m2[3] + ' г.') : '');
        }
      }
      return s;
    }

    // Перевод уровня размышления / режима модели в скобках или суффиксах селектора
    function translateModelEffortQualifier(qual) {
      if (!qual) return qual;
      var q = qual.trim().toLowerCase().replace(/\s+/g, ' ');
      var map = {
        'thinking': 'Размышление',
        'low': 'Низкий',
        'medium': 'Средний',
        'high': 'Высокий',
        'xhigh': 'Сверхвысокий',
        'extra': 'Повышенный',
        'extra high': 'Сверхвысокий',
        'extra low': 'Сверхнизкий',
        'max': 'Макс.',
        'fast': 'Быстро'
      };
      if (map[q]) return map[q];
      var thMatch = q.match(/^(low|medium|high|xhigh|extra|max)\s+thinking$/);
      if (thMatch && map[thMatch[1]]) {
        return map[thMatch[1]] + ', размышление';
      }
      return qual;
    }

    // 2. Полный набор регулярных выражений для динамических строк UI и серверных сообщений квот
    var DYNAMIC_PATTERNS = [
      // --- Настройки приложения и телеметрии с подстановкой имени продукта ---
      [/^Manage\s+(.+?)\s+app settings\.?$/i, function (_, app) {
        return 'Управление параметрами приложения ' + app + '.';
      }],
      [/^When toggled on,\s*(.+?)\s+will use your AI credits to fulfill model requests once you(?:'re| are) out of model quota\.\s*(.+?)\s+will always use your model quota first before using AI credits\.?$/i, function (_, app1, app2) {
        return 'Когда включено, ' + app1 + ' будет использовать ваши ИИ-кредиты для выполнения запросов к моделям после исчерпания базовой квоты. ' + app2 + ' всегда сначала расходует базовую квоту модели и только затем — ИИ-кредиты.';
      }],
      [/^When toggled on,\s*(.+?)\s+collects usage data to help Google enhance performance and features\.?$/i, function (_, app) {
        return 'Когда включено, ' + app + ' собирает обезличенные данные об использовании, помогая Google улучшать производительность и функции.';
      }],
      [/^Receive product updates, tips, and promotions from Google\s+(.+?)\s+via email\.?$/i, function (_, app) {
        return 'Получать новости об обновлениях, полезные советы и спецпредложения Google ' + app + ' по электронной почте.';
      }],
      [/^For\s+(.+?),\s*telemetry is force disabled\.?$/i, function (_, who) {
        return 'Для ' + who + ' сбор телеметрии принудительно отключён.';
      }],
      [/^For\s+(.+?),\s*this setting is disabled\.?$/i, function (_, who) {
        return 'Для ' + who + ' этот параметр отключён.';
      }],

      // --- Раздел «Модели и использование» (тарифы, ИИ-кредиты, лимиты и таймеры обновления) ---
      [/^Your Plan:\s*(.+)$/i, function (_, plan) {
        return 'Ваш тариф: ' + translateInnerTerm(plan);
      }],
      [/^You can upgrade to a higher\s+(.+?)\s+plan to receive the highest rate limits\.?$/i, function (_, plan) {
        return 'Вы можете перейти на более высокий тариф ' + plan + ', чтобы получить максимальные лимиты запросов.';
      }],
      [/^Upgrade to\s+(.+?)\s+(?:plan\s+)?(?:to receive|for)\s+higher(?:\s+rate)?\s+limits\.?$/i, function (_, plan) {
        return 'Перейдите на тариф ' + plan + ', чтобы получить увеличенные лимиты запросов.';
      }],
      [/^Available AI Credits:\s*(.+)$/i, function (_, count) {
        return 'Доступно ИИ-кредитов: ' + count;
      }],
      [/^AI Credits:\s*(.+)$/i, function (_, count) {
        return 'ИИ-кредиты: ' + count;
      }],
      [/^You have used some of your\s+(.+?)\s+limit,\s*it will (?:fully )?refresh in\s+(.+?)\.?$/i, function (_, period, dur) {
        var pGen = translateQuotaPeriod(period, 'gen');
        var durRu = translateDurationEnToRu(dur, true);
        if (pGen) {
          return 'Вы использовали часть ' + pGen + ' лимита — он полностью обновится через ' + durRu + '.';
        }
        return 'Вы использовали часть лимита (' + period + ') — он полностью обновится через ' + durRu + '.';
      }],
      [/^You have (?:used all of|exhausted) your\s+(.+?)\s+limit,\s*it will (?:fully )?refresh in\s+(.+?)\.?$/i, function (_, period, dur) {
        var pAcc = translateQuotaPeriod(period, 'acc');
        var durRu = translateDurationEnToRu(dur, true);
        if (pAcc) {
          return 'Вы исчерпали ' + pAcc + ' лимит — он полностью обновится через ' + durRu + '.';
        }
        return 'Вы исчерпали лимит (' + period + ') — он полностью обновится через ' + durRu + '.';
      }],
      [/^You have reached your\s+(.+?)\s+limit(?:[,.;]\s*it will (?:fully )?refresh in\s+(.+?))?\.?$/i, function (_, period, dur) {
        var pAcc = translateQuotaPeriod(period, 'acc');
        var prefix = pAcc ? ('Достигнут ' + pAcc + ' лимит') : ('Достигнут лимит (' + period + ')');
        if (dur) {
          return prefix + ' — он полностью обновится через ' + translateDurationEnToRu(dur, true) + '.';
        }
        return prefix + '.';
      }],
      [/^You haven't used any of your\s+(.+?)\s+limit\.?$/i, function (_, period) {
        var pGen = translateQuotaPeriod(period, 'gen');
        return pGen ? ('Вы ещё не расходовали часть ' + pGen + ' лимита.') : ('Лимит (' + period + ') ещё не расходовался.');
      }],
      [/^(.+?)\s+Limit Remaining$/i, function (_, period) {
        var pGen = translateQuotaPeriod(period, 'gen');
        if (pGen) return 'Остаток ' + pGen + ' лимита';
        return 'Остаток лимита (' + translateInnerTerm(period) + ')';
      }],
      [/^(?:Resets|Refreshes)\s+in\s+(.+?)\.?$/i, function (_, dur) {
        return 'Обновится через ' + translateDurationEnToRu(dur, true);
      }],
      [/^(?:Resets|Refreshes)\s+at\s+(.+?)\.?$/i, function (_, timeStr) {
        return 'Обновится в ' + timeStr;
      }],
      [/^Your plan's baseline quota will refresh on\s+(.+?)\.?$/i, function (_, dateStr) {
        return 'Базовая квота вашего тарифа обновится ' + dateStr + '.';
      }],
      [/^You need\s+(?:at least\s+(\d+)|more)\s+AI Credits to send messages\.\s*To continue using\s+(.+?)\s+now,\s*purchase more AI Credits\.(?:\s*Your plan's baseline quota will refresh on\s+(.+?)\.)?(?:\s*To continue using this model now,\s*enable AI Credit overages\.)?$/i, function (full, minCredits, model, refreshDate) {
        var needed = minCredits ? ('не менее ' + minCredits + ' ИИ-кредитов') : 'больше ИИ-кредитов';
        var target = /^this model$/i.test(model) ? 'эту модель' : model;
        var res = 'Для отправки сообщений требуется ' + needed + '. Чтобы продолжить использовать ' + target + ' сейчас, приобретите больше ИИ-кредитов.';
        if (refreshDate) {
          res += ' Базовая квота вашего тарифа обновится ' + refreshDate + '.';
        }
        if (/enable AI Credit overages/i.test(full)) {
          res += ' Чтобы продолжить использовать эту модель сейчас, включите расход ИИ-кредитов сверх квоты.';
        }
        return res;
      }],
      [/^Your quota for\s+(.+?)\s+will (?:reset|refresh) on\s+(.+?)\.\s*Switch to another available model to continue\.?$/i, function (_, model, when) {
        return 'Квота для модели ' + model + ' обновится ' + when + '. Переключитесь на другую доступную модель, чтобы продолжить.';
      }],
      [/^Your quota for\s+(.+?)\s+has been reached\.\s*Switch to another available model to continue\.?$/i, function (_, model) {
        return 'Квота для модели ' + model + ' исчерпана. Переключитесь на другую доступную модель, чтобы продолжить.';
      }],
      [/^To continue using this model now,\s*enable AI Credit overages\.?$/i, function () {
        return 'Чтобы продолжить использовать эту модель сейчас, включите расход ИИ-кредитов сверх квоты.';
      }],
      [/^Your quota for\s+(.+?)\s+has been reached\.?$/i, function (_, model) {
        return 'Квота для модели ' + model + ' исчерпана.';
      }],
      [/^Your quota for\s+(.+?)\s+will (?:reset|refresh) (?:on|in)\s+(.+?)\.?$/i, function (full, model, when) {
        var isIn = /\bwill (?:reset|refresh) in\b/i.test(full);
        return 'Квота для модели ' + model + ' обновится ' + (isIn ? ('через ' + translateDurationEnToRu(when, true)) : when) + '.';
      }],
      [/^Shared with:\s*(.+)$/i, function (_, models) {
        return 'Общий лимит с: ' + models;
      }],
      [/^(\d+(?:\.\d+)?)%\s+left$/i, function (_, pct) {
        return 'Осталось ' + pct + '%';
      }],
      [/^(\d+(?:\.\d+)?)%\s+used$/i, function (_, pct) {
        return 'Использовано ' + pct + '%';
      }],

      // --- Версии, заголовки окон и системные статусы ---
      [/^Version\s+([0-9A-Za-z._+-]+)$/i, function (_, v) {
        return 'Версия ' + v;
      }],
      [/^App version\s+([0-9A-Za-z._+-]+)$/i, function (_, v) {
        return 'Версия приложения ' + v;
      }],
      [/^v?(\d+\.\d+\.\d+(?:-[0-9A-Za-z.]+)?)\s+\((?:latest|up to date)\)$/i, function (_, v) {
        return v + ' (актуальная версия)';
      }],
      [/^Update available:\s*(.+)$/i, function (_, v) {
        return 'Доступно обновление: ' + v;
      }],
      [/^Settings\s*[-—:]\s*(.+)$/i, function (_, section) {
        return 'Настройки — ' + translateInnerTerm(section);
      }],
      [/^Welcome to\s+(.+)$/i, function (_, app) {
        return 'Добро пожаловать в ' + app;
      }],
      [/^Open\s+(Google Antigravity|Antigravity(?:\s+IDE)?)$/i, function (_, app) {
        return 'Открыть ' + app;
      }],
      [/^Send feedback as\s+(.+)$/i, function (_, email) {
        return 'Отправить отзыв от имени ' + email;
      }],
      [/^Signed in as\s+(.+)$/i, function (_, user) {
        return 'Вы вошли как ' + user;
      }],
      [/^(.+?)\s+\(disabled by admin\)$/i, function (_, label) {
        return translateInnerTerm(label) + ' (отключено администратором)';
      }],

      // --- Динамические подсказки и конфликты в «Сочетаниях клавиш» ---
      [/^Conflict:\s*also assigned to\s+(.+)$/i, function (_, cmd) {
        return 'Конфликт: уже назначено для «' + translateInnerTerm(cmd) + '»';
      }],
      [/^Conflicts with\s+"(.+?)"\s*\(press Enter to replace\)$/i, function (_, cmd) {
        return 'Конфликтует с «' + translateInnerTerm(cmd) + '» (нажмите Enter для замены)';
      }],
      [/^Recording shortcut for\s+(.+?)\.\.\.$/i, function (_, cmd) {
        return 'Запись сочетания клавиш для «' + translateInnerTerm(cmd) + '»...';
      }],
      [/^Shortcut\s+(.+?)\s+for\s+(.+)$/i, function (_, key, cmd) {
        return 'Сочетание ' + key + ' для «' + translateInnerTerm(cmd) + '»';
      }],
      [/^Remove shortcut\s+(.+?)\s+for\s+(.+)$/i, function (_, key, cmd) {
        return 'Удалить сочетание ' + key + ' для «' + translateInnerTerm(cmd) + '»';
      }],
      [/^Add shortcut for\s+(.+)$/i, function (_, cmd) {
        return 'Добавить сочетание клавиш для «' + translateInnerTerm(cmd) + '»';
      }],
      [/^Reset\s+"?(.+?)"?\s+to default$/i, function (_, cmd) {
        return 'Сбросить «' + translateInnerTerm(cmd) + '» по умолчанию';
      }],
      [/^Reset\s+(\d+)\s+overrides?$/i, function (_, n) {
        return 'Сбросить ' + n + ' ' + pluralRu(n, 'переопределение', 'переопределения', 'переопределений');
      }],

      // --- Таймеры размышления агента, шаги, файлы, инструменты и плагины ---
      [/^Thought for\s+(.+)$/i, function (_, dur) {
        return 'Размышлял ' + translateDurationEnToRu(dur, true);
      }],
      [/^Thinking for\s+(.+?)\.{0,3}$/i, function (_, dur) {
        return 'Размышляет ' + translateDurationEnToRu(dur, true) + '...';
      }],
      [/^Still thinking,\s*(\d+)\s*seconds?$/i, function (_, s) {
        return 'Продолжает размышлять (' + s + ' с)';
      }],
      [/^Worked for\s+(.+)$/i, function (_, dur) {
        return 'Работал ' + translateDurationEnToRu(dur, true);
      }],
      [/^Ran for\s+(.+)$/i, function (_, dur) {
        return 'Выполнялось ' + translateDurationEnToRu(dur, true);
      }],
      [/^Exited with code\s+(-?\d+)\.?$/i, function (_, code) {
        return 'Завершено с кодом ' + code + '.';
      }],
      [/^Failed to open workspace:\s*(.+)$/i, function (_, err) {
        return 'Не удалось открыть рабочую область: ' + err;
      }],
      [/^Failed to load\s+(.+?):\s*(.+)$/i, function (_, what, err) {
        return 'Не удалось загрузить ' + translateInnerTerm(what) + ': ' + err;
      }],
      [/^(\d+)\s+Files?\s+With\s+Changes$/i, function (_, n) {
        return n + ' ' + pluralRu(n, 'файл с изменениями', 'файла с изменениями', 'файлов с изменениями');
      }],
      [/^(\d+)\s+files?\s+changed$/i, function (_, n) {
        return 'Изменено файлов: ' + n;
      }],
      [/^(\d+)\s+agents?\s+running$/i, function (_, n) {
        return 'Активных агентов: ' + n;
      }],
      [/^(\d+)\s+running\s+tasks?$/i, function (_, n) {
        return 'Активных задач: ' + n;
      }],
      [/^(\d+)\s+tools?\s+enabled$/i, function (_, n) {
        return 'Включено инструментов: ' + n;
      }],
      [/^(\d+)\s+tools?\s+disabled$/i, function (_, n) {
        return 'Отключено инструментов: ' + n;
      }],
      [/^(\d+)\s+tools?$/i, function (_, n) {
        return n + ' ' + pluralRu(n, 'инструмент', 'инструмента', 'инструментов');
      }],
      [/^(\d+)\s+servers?$/i, function (_, n) {
        return n + ' ' + pluralRu(n, 'сервер', 'сервера', 'серверов');
      }],
      [/^(\d+)\s+plugins?\s+available\.?$/i, function (_, n) {
        return 'Доступно плагинов: ' + n;
      }],
      [/^(\d+)\s+skills?$/i, function (_, n) {
        return n + ' ' + pluralRu(n, 'навык', 'навыка', 'навыков');
      }],
      [/^(\d+)\s+subagents?$/i, function (_, n) {
        return n + ' ' + pluralRu(n, 'субагент', 'субагента', 'субагентов');
      }],
      [/^(\d+)\s+comments?$/i, function (_, n) {
        return n + ' ' + pluralRu(n, 'комментарий', 'комментария', 'комментариев');
      }],
      [/^(\d+)\s+items?(?:\s+selected)?$/i, function (full, n) {
        if (/selected/i.test(full)) {
          return 'Выбрано элементов: ' + n;
        }
        return n + ' ' + pluralRu(n, 'элемент', 'элемента', 'элементов');
      }],
      [/^(\d+)\s+results?$/i, function (_, n) {
        return n + ' ' + pluralRu(n, 'результат', 'результата', 'результатов');
      }],
      [/^(\d+)\s+matches$/i, function (_, n) {
        return n + ' ' + pluralRu(n, 'совпадение', 'совпадения', 'совпадений');
      }],
      [/^Show\s+(\d+)\s+breakdowns?$/i, function (_, n) {
        return 'Показать детализацию (' + n + ')';
      }],
      [/^Show\s+(\d+)\s+more$/i, function (_, n) {
        return 'Показать ещё ' + n;
      }],
      [/^(\d+)\s+more$/i, function (_, n) {
        return 'Ещё ' + n;
      }],
      [/^(\d+)\s+demoted$/i, function (_, n) {
        return 'Понижено: ' + n;
      }],
      [/^(\d+)\s+excluded$/i, function (_, n) {
        return 'Исключено: ' + n;
      }],
      [/^Step\s+(\d+)\s+of\s+(\d+)$/i, function (_, a, b) {
        return 'Шаг ' + a + ' из ' + b;
      }],
      [/^Turn\s+(\d+)\s+of\s+(\d+)$/i, function (_, a, b) {
        return 'Ход ' + a + ' из ' + b;
      }],
      [/^Question\s+(\d+)\s+of\s+(\d+)$/i, function (_, a, b) {
        return 'Вопрос ' + a + ' из ' + b;
      }],
      [/^Page\s+(\d+)\s+of\s+(\d+)$/i, function (_, a, b) {
        return 'Страница ' + a + ' из ' + b;
      }],

      // --- Селектор режимов разрешений, автономного режима и подменю чата ---
      [/^Agent permissions preset selector,\s*current:\s*(.+)$/i, function (_, cur) {
        return 'Выбор профиля разрешений агента (текущий: ' + translateInnerTerm(cur) + ')';
      }],
      [/^Select modes,\s*current:\s*(.+)$/i, function (_, cur) {
        return 'Выбрать режимы (активно: ' + translateInnerTerm(cur) + ')';
      }],
      [/^(\d+)\s+active\s+modes?$/i, function (_, n) {
        return n + ' ' + pluralRu(n, 'активный режим', 'активных режима', 'активных режимов');
      }],
      [/^Best of N\s*\((\d+)\)$/i, function (_, n) {
        return 'Лучший из ' + n;
      }],
      [/^This\s+(project|conversation|workspace)\s+overrides your global permission settings\.?$/i, function (_, kind) {
        var k = kind.toLowerCase();
        var subject = k === 'project' ? 'Этот проект' : (k === 'conversation' ? 'Этот диалог' : 'Эта рабочая область');
        return subject + ' переопределяет ваши глобальные настройки разрешений.';
      }],
      [/^Inherits your Global Permissions when working\s+(.+?)\.?$/i, function (_, where) {
        return 'Наследует глобальные настройки разрешений (' + translateInnerTerm(where) + ').';
      }],
      [/^Failed to save settings:\s*(.+)$/i, function (_, err) {
        return 'Не удалось сохранить настройки: ' + err;
      }],

      // --- Раздел «Кастомизация», «Маркетплейс» и страницы плагинов ---
      [/^(?:\+\s*)?See\s+(\d+)\s+more$/i, function (_, n) {
        return 'Показать ещё ' + n;
      }],
      [/^(?:\+\s*)?See\s+(\d+)\s+more\s+(.+)$/i, function (_, n, noun) {
        return 'Показать ещё ' + n + ' (' + translateInnerTerm(noun) + ')';
      }],
      [/^See\s+more\s+in\s+(.+)$/i, function (_, shelf) {
        return 'Показать больше в разделе «' + translateInnerTerm(shelf) + '»';
      }],
      [/^See\s+less\s+in\s+(.+)$/i, function (_, shelf) {
        return 'Свернуть в разделе «' + translateInnerTerm(shelf) + '»';
      }],
      [/^Plugins\s+in\s+(.+)$/i, function (_, title) {
        return 'Плагины: ' + translateInnerTerm(title);
      }],
      [/^More\s+actions\s+for\s+(.+)$/i, function (_, name) {
        return 'Действия для ' + name;
      }],
      [/^No\s+apps\s+found\s+for\s+["«]?(.+?)["»]?\.?$/i, function (_, q) {
        return 'Приложения по запросу «' + q + '» не найдены.';
      }],
      [/^(\d+)\s+matching\s+bundles?$/i, function (_, n) {
        return 'Найдено наборов: ' + n;
      }],
      [/^(Added|Removed)\s+(\d+)\s+plugins?\s+(?:to|from)\s+(.+?)\.?$/i, function (_, action, n, bundle) {
        var b = translateInnerTerm(bundle);
        if (/^added$/i.test(action)) {
          return 'Добавлено плагинов в «' + b + '»: ' + n;
        }
        return 'Удалено плагинов из «' + b + '»: ' + n;
      }],
      [/^Couldn't\s+(add|remove)\s+(\d+)\s+plugins?\s+(?:to|from)\s+(.+?)\.?$/i, function (_, action, n, bundle) {
        var b = translateInnerTerm(bundle);
        if (/^add$/i.test(action)) {
          return 'Не удалось добавить плагины (' + n + ') в «' + b + '».';
        }
        return 'Не удалось удалить плагины (' + n + ') из «' + b + '».';
      }],
      [/^Rule\s+(\d+)$/i, function (_, n) {
        return 'Правило ' + n;
      }],
      [/^Unnamed\s+skill\s+(\d+)$/i, function (_, n) {
        return 'Навык без названия ' + n;
      }],
      [/^Unnamed\s+Agent\s+(\d+)$/i, function (_, n) {
        return 'Агент без названия ' + n;
      }],
      [/^Sign\s+in\s+to\s+(.+?)\s+on\s+this\s+computer$/i, function (_, app) {
        return 'Войти в ' + app + ' на этом компьютере';
      }],
      [/^Disconnect\s+(.+)$/i, function (_, app) {
        return 'Отключить ' + app;
      }],
      [/^Unable\s+to\s+search\s+@(.+)$/i, function (_, trig) {
        return 'Не удалось выполнить поиск в @' + trig;
      }],
      [/^\(([0-9,.\s]+)\s+tokens?\)$/i, function (_, n) {
        var cleanNum = n.replace(/[\s,]/g, '');
        return '(' + n.trim() + ' ' + pluralRu(cleanNum, 'токен', 'токена', 'токенов') + ')';
      }],
      [/^([0-9,.\s]+)\s+tokens?$/i, function (_, n) {
        var cleanNum = n.replace(/[\s,]/g, '');
        return n.trim() + ' ' + pluralRu(cleanNum, 'токен', 'токена', 'токенов');
      }],
      [/^Google does not control the availability or functionality of third[- ]party developer tools\.\s*Your data from third[- ]party developer tools connected to your (.+?) instance may be shared with Google\.\s*Google will protect any such data in accordance with the Google Privacy Policy,\s*found here:?$/i, function (_, app) {
        return 'Google не контролирует доступность и функциональность сторонних инструментов разработки. Данные из сторонних инструментов, подключённых к вашему экземпляру ' + app + ', могут передаваться в Google. Google защищает такие данные в соответствии с Политикой конфиденциальности Google:';
      }],

      // --- Голосовой режим, индикатор контекста, браузер и попутные вопросы (v2.29.0) ---
      [/^Voice\s+speed,\s*(.+)$/i, function (_, spd) {
        return 'Скорость голоса: ' + spd;
      }],
      [/^Voice\s+mode,\s*(.+)$/i, function (_, dur) {
        return 'Голосовой режим, ' + dur;
      }],
      [/^Started\s+voice\s+chat\s*\u00b7\s*(.+)$/i, function (_, rest) {
        return 'Голосовой чат начат \u00b7 ' + rest;
      }],
      [/^Stopped\s+voice\s+chat\s*\u00b7\s*(.+)$/i, function (_, rest) {
        return 'Голосовой чат завершён \u00b7 ' + rest;
      }],
      [/^Voice\s+chat\s*\u00b7\s*(.+)$/i, function (_, rest) {
        return 'Голосовой чат \u00b7 ' + rest;
      }],
      [/^(\d+)\s+calls?\s*\u00b7\s*(.+)$/i, function (_, n, size) {
        return n + ' ' + pluralRu(n, 'вызов', 'вызова', 'вызовов') + ' \u00b7 ' + size;
      }],
      [/^Deleted\s+(\d+)\s+recordings?\s*\((.+?)\)\.?$/i, function (_, n, size) {
        return 'Удалено записей: ' + n + ' (' + size + ')';
      }],
      [/^This\s+deletes\s+(\d+)\s+call\s+recordings?\s*\((.+?)\)\.?\s*(?:This\s+cannot\s+be\s+undone\.?)?$/i, function (_, n, size) {
        return 'Будет удалено записей вызовов: ' + n + ' (' + size + '). Отменить это действие нельзя.';
      }],
      [/^Unmute\s+(Antigravity|Jetski|mic|microphone|speaker)$/i, function (_, target) {
        var t = /^mic/i.test(target) ? 'микрофон' : (/^speaker$/i.test(target) ? 'динамик' : 'звук ' + target);
        return 'Включить ' + t;
      }],
      [/^Mute\s+(Antigravity|Jetski|mic|microphone|speaker)$/i, function (_, target) {
        var t = /^mic/i.test(target) ? 'микрофон' : (/^speaker$/i.test(target) ? 'динамик' : 'звук ' + target);
        return 'Выключить ' + t;
      }],
      [/^Downloads,\s*(\d+)%\s*complete$/i, function (_, pct) {
        return 'Загрузки: завершено ' + pct + '%';
      }],
      [/^Context\s+window\s+about\s+(\d+)%\s+full,\s*compacted\s+since\s+the\s+last\s+response$/i, function (_, pct) {
        return 'Окно контекста заполнено примерно на ' + pct + '% (сжато после последнего ответа)';
      }],
      [/^Context\s+window\s+(?:about\s+)?(\d+)%\s+full$/i, function (_, pct) {
        return 'Окно контекста заполнено на ' + pct + '%';
      }],
      [/^View\s+(\d+)\s+side\s+questions?$/i, function (_, n) {
        return 'Показать ' + n + ' ' + pluralRu(n, 'попутный вопрос', 'попутных вопроса', 'попутных вопросов');
      }],
      [/^Side\s+Question:\s*(.+)$/i, function (_, q) {
        return 'Попутный вопрос: ' + q;
      }],
      [/^Edit\s+side\s+question\s+title:\s*(.+)$/i, function (_, q) {
        return 'Изменить заголовок попутного вопроса: ' + q;
      }],
      [/^Side\s+question\s+failed:\s*(.+)$/i, function (_, err) {
        return 'Ошибка попутного вопроса: ' + err;
      }],

      // --- Строка ввода чата и плейсхолдеры (ewc) ---
      [/^Ask anything,\s*@ to mention,\s*\/ for actions$/i, function () {
        return 'Напишите задачу (@ — контекст, / — действия)';
      }],
      [/^Ask anything,\s*@ to mention$/i, function () {
        return 'Напишите задачу (@ — контекст)';
      }],
      [/^Message subagent,\s*@ to mention,\s*\/ for actions$/i, function () {
        return 'Сообщение субагенту (@ — контекст, / — действия)';
      }],
      [/^Message subagent,\s*@ to mention$/i, function () {
        return 'Сообщение субагенту (@ — контекст)';
      }],
      [/^Listening\.\s*Ask anything\.?$/i, function () {
        return 'Слушаю вас. Спросите о чём угодно.';
      }],

      // --- Приветствие на домашнем экране и в новых диалогах (PEc) ---
      [/^Hi\s+(.+?),\s*what can we get done today\??$/i, function (_, name) {
        return 'Привет, ' + name + '! Какую задачу решим сегодня?';
      }],
      [/^What can we get done today\??$/i, function () {
        return 'Какую задачу решим сегодня?';
      }],

      // --- Относительное время и автономные таймеры ---
      [/^(\d+)\s*s\s+ago$/i, function (_, n) { return n + ' с назад'; }],
      [/^(\d+)\s*m(?:in)?\s+ago$/i, function (_, n) { return n + ' мин назад'; }],
      [/^(\d+)\s*h(?:r|ours?)?\s+ago$/i, function (_, n) { return n + ' ч назад'; }],
      [/^(\d+)\s*d(?:ays?)?\s+ago$/i, function (_, n) { return n + ' дн. назад'; }],
      [/^(\d+)\s*w(?:ks?|eeks?)?\s+ago$/i, function (_, n) { return n + ' нед. назад'; }],
      [/^(\d+)\s*mo(?:nths?)?\s+ago$/i, function (_, n) { return n + ' мес. назад'; }],
      [/^(\d+)\s*y(?:rs?|ears?)?\s+ago$/i, function (_, n) { return n + ' г. назад'; }],
      [/^in\s+(\d+\s+(?:weeks?|days?|hours?|hrs?|minutes?|mins?|seconds?|secs?)(?:(?:,\s*|\s+and\s+|\s+)\d+\s+(?:days?|hours?|hrs?|minutes?|mins?|seconds?|secs?))*)$/i, function (_, dur) {
        return 'через ' + translateDurationEnToRu(dur, true);
      }],
      [/^(\d+\s+(?:weeks?|days?|hours?|hrs?|minutes?|mins?|seconds?|secs?)(?:(?:,\s*|\s+and\s+|\s+)\d+\s+(?:days?|hours?|hrs?|minutes?|mins?|seconds?|secs?))+)$/i, function (_, dur) {
        return translateDurationEnToRu(dur, false);
      }],

      // --- Новые модели Gemini 4 (Carbon / Argon / Hydrogen), режимы Orchestrator и плашки селектора (v2.32+) ---
      [/^Orchestrator\s*\((.+?)\)$/i, function (_, model) {
        return 'Оркестратор (' + translateInnerTerm(model) + ')';
      }],
      [/^(.+?)\s+that\s+may\s+offload\s+routine\s+steps\s+to\s+(.+?)\.\s*Same\s+(.+?)-level\s+quality,\s*fewer\s+tokens\s+used\.?$/i, function (_, primary, helper, lvl) {
        return primary.trim() + ' с передачей рутинных шагов модели ' + helper.trim() + '. Качество уровня ' + lvl.trim() + ' при меньшем расходе токенов.';
      }],
      [/^(\*\s*)?(?:This\s+model\s+)?will\s+be\s+(?:removed|retired|deprecated)\s+on\s+(.+?)\.?$/i, function (_, star, dt) {
        return (star ? '* ' : '') + 'Будет отключена ' + translateEnDateToRu(dt) + (/г\.$/.test(translateEnDateToRu(dt)) ? '' : '.');
      }],
      [/^([A-Za-z0-9][A-Za-z0-9._\s+-]*?)\s*\((Thinking|(?:Extra\s+)?(?:Low|Medium|High)|XHigh|Extra|Max|Fast)(?:\s+Thinking)?\)$/i, function (full, base, qual) {
        var b = base.trim();
        if (/^(?:Close|Fullscreen|Exit fullscreen|Zoom in|Zoom out|Reset zoom|Submit Prompt)$/i.test(b)) return full;
        var rawQual = full.slice(full.lastIndexOf('(') + 1, full.lastIndexOf(')'));
        return b + ' (' + translateModelEffortQualifier(rawQual) + ')';
      }],
      [/^(Low|Medium|High|XHigh|Extra|Max)\s*\u00b7\s*(.+)$/i, function (_, eff, ctx) {
        return translateModelEffortQualifier(eff) + ' \u00b7 ' + translateInnerTerm(ctx);
      }],
      [/^Select\s+model,\s*current:\s*(.+)$/i, function (_, cur) {
        var c = cur.trim();
        var mEff = c.match(/^(.+?)\s+(Low|Medium|High|XHigh|Extra|Max)(?:\s*\u00b7\s*(.+))?$/i);
        if (mEff) {
          var baseRu = translateInnerTerm(mEff[1]);
          var effRu = translateModelEffortQualifier(mEff[2]);
          return 'Выбрать модель (текущая: ' + baseRu + ' ' + effRu + (mEff[3] ? (' \u00b7 ' + mEff[3]) : '') + ')';
        }
        return 'Выбрать модель (текущая: ' + translateInnerTerm(c) + ')';
      }],
      [/^(\d+)\s+models?\s+selected$/i, function (_, n) {
        return 'Выбрано моделей: ' + n;
      }],
      [/^Connected\s+to\s+(.+)$/i, function (_, host) {
        return 'Подключено к ' + host;
      }],
      [/^This\s+window's\s+agents,\s*files,\s*and\s+terminals\s+are\s+on\s+(.+?)\.?$/i, function (_, host) {
        return 'Агенты, файлы и терминалы этого окна работают на хосте ' + host + '.';
      }],
      [/^(.+?),\s*(\d+)\s+grants?$/i, function (_, label, n) {
        return translateInnerTerm(label) + ': ' + n + ' ' + pluralRu(n, 'разрешение', 'разрешения', 'разрешений');
      }],
      [/^Your\s+(Remote|This\s+Computer)\s+setting$/i, function (_, scope) {
        var sc = /^remote$/i.test(scope) ? 'удалённого хоста' : 'этого компьютера';
        return 'Ваша настройка для ' + sc;
      }],
      [/^Resume\s+(\d+)\s+comment\s+drafts?$/i, function (_, n) {
        return 'Продолжить ' + n + ' ' + pluralRu(n, 'черновик комментария', 'черновика комментариев', 'черновиков комментариев');
      }],
      [/^(.+?)\s+may\s+be\s+slow\s+or\s+fail(?:\s+in\s+[A-Za-z0-9_-]+)?\s+due\s+to\s+capacity\s+issues\.?(?:\s*Follow\s+updates\s+at\s+(.+?)\.?)?$/i, function (_, models, link) {
        var msg = models + ': возможны замедления или сбои из-за высокой нагрузки на серверы.';
        if (link) msg += ' Обновления статуса: ' + link + '.';
        return msg;
      }],

      // --- Расширение Swarm (доска, статусы участников, обзор и граф) ---
      [/^(\d+)\s+waiting\s+on\s+@([A-Za-z0-9_-]+)$/i, function (_, n, who) {
        return n + ' ожидает @' + who;
      }],
      [/^(\d+)\s+stuck$/i, function (_, n) {
        return 'Застряло: ' + n;
      }],
      [/^(\d+)\s+posts?$/i, function (_, n) {
        return n + ' ' + pluralRu(n, 'сообщение', 'сообщения', 'сообщений');
      }],
      [/^([A-Za-z0-9_-]+)\s*\u00b7\s*Working$/i, function (_, who) {
        return translateInnerTerm(who) + ' \u00b7 Работает';
      }],
      [/^Waiting on\s+@([A-Za-z0-9_.-]+)$/i, function (_, who) {
        return 'Ожидает @' + who;
      }],
      [/^Waiting on\s+(\d+)$/i, function (_, n) {
        return 'Ожидает участников: ' + n;
      }],
      [/^(\d+)\s+of\s+(\d+)\s+tasks?\s+done$/i, function (_, a, b) {
        return 'Выполнено задач: ' + a + ' из ' + b;
      }],
      [/^Up next\s*\u00b7\s*(\d+)$/i, function (_, n) {
        return 'Далее в очереди \u00b7 ' + n;
      }],
      [/^(\d+)\s+needs?\s+you$/i, function (_, n) {
        return 'Ждёт вас: ' + n;
      }],
      [/^(\d+)\s+threads?\s+open$/i, function (_, n) {
        return 'Открыто потоков: ' + n;
      }],
      [/^(\d+)\s+active$/i, function (_, n) {
        return 'Активно: ' + n;
      }],
      [/^(Thinking|Latest action):\s*(.+)$/i, function (_, kind, txt) {
        return (/^thinking$/i.test(kind) ? 'Размышление: ' : 'Последнее действие: ') + txt;
      }],
      [/^Runs on\s+(.+)$/i, function (_, host) {
        return 'Выполняется на ' + host;
      }],
      [/^last seen\s+(\d+)(m|h|d)\s+ago$/i, function (_, n, unit) {
        var u = unit.toLowerCase();
        return 'активность ' + n + (u === 'm' ? ' мин' : (u === 'h' ? ' ч' : ' дн.')) + ' назад';
      }],
      [/^(From|To)\s+(@[A-Za-z0-9_.-]+|coordinator|narrator|monitor|verifier|reviewer|researcher|planner|coder|tester|writer|auditor|[a-z][a-z0-9_]*-\d+)$/i, function (_, prep, who) {
        return (/^from$/i.test(prep) ? 'От ' : 'Кому: ') + who;
      }],
      [/^Go to\s+#(\d+)(?:\s*\((.+)\))?$/i, function (_, seq, ag) {
        return 'Перейти к #' + seq + (ag ? ' (' + ag + ')' : '');
      }],
      [/^Posted in\s+#([A-Za-z0-9_.-]+);\s*click to show only\s+#([A-Za-z0-9_.-]+)$/i, function (_, c1, c2) {
        return 'Опубликовано в #' + c1 + ' (нажмите, чтобы показать только #' + c2 + ')';
      }],
      [/^Everyone in\s+#([A-Za-z0-9_.-]+)$/i, function (_, c) {
        return 'Все участники в #' + c;
      }],
      [/^#([A-Za-z0-9_.-]+)\s+is archived:\s*this addresses nobody$/i, function (_, c) {
        return 'Канал #' + c + ' в архиве: сообщение никому не адресовано';
      }],
      [/^The narrator's last step failed:\s*(.+)$/i, function (_, d) {
        return 'Ошибка на последнем шаге летописца: ' + d;
      }],
      [/^Narrator read up to\s+#(\d+)\s+of\s+(\d+)$/i, function (_, a, b) {
        return 'Летописец прочитал до #' + a + ' из ' + b;
      }],
      [/^@([A-Za-z0-9_.-]+)\s+(ran out of quota|looks stuck|hit an error)$/i, function (_, m, st) {
        return '@' + m + (/quota/i.test(st) ? ': исчерпана квота' : (/stuck/i.test(st) ? ': похоже, завис' : ': произошла ошибка'));
      }],
      [/^Opening\s+(.+?)'s conversation needs the app\.?$/i, function (_, target) {
        return 'Чтобы открыть диалог ' + target + ', требуется приложение.';
      }],

      // --- Веб-интерфейс v2.32+: инструменты, субагенты, диффы, браузер, MCP и голос ---
      [/^Used MCP tool:\s*(.+)$/i, function (_, m) {
        return 'Использован MCP-инструмент: ' + m;
      }],
      [/^Used tool:\s*(.+)$/i, function (_, m) {
        return 'Использован инструмент: ' + m;
      }],
      [/^Using browser\s*\u00b7\s*(.+)$/i, function (_, m) {
        return 'Работа в браузере \u00b7 ' + translateInnerTerm(m);
      }],
      [/^Open Subagent:\s*(.+)$/i, function (_, m) {
        return 'Открыть субагента: ' + m;
      }],
      [/^Invoked subagent:\s*(.+)$/i, function (_, m) {
        return 'Запущен субагент: ' + m;
      }],
      [/^(Messaging|Messaged)\s+(.+)$/i, function (_, act, who) {
        return (/^messaging$/i.test(act) ? 'Отправка сообщения: ' : 'Сообщение отправлено: ') + who;
      }],
      [/^Message from\s+(.+)$/i, function (_, who) {
        return 'Сообщение от ' + who;
      }],
      [/^Agent finished:\s*(.+)$/i, function (_, s) {
        return 'Агент завершил работу: ' + s;
      }],
      [/^Read URL:\s*(.+)$/i, function (_, u) {
        return 'Прочитан URL: ' + u;
      }],
      [/^Browser task:\s*"(.+)"$/i, function (_, t) {
        return 'Задача в браузере: «' + t + '»';
      }],
      [/^Generated image:\s*"(.+)"$/i, function (_, p) {
        return 'Сгенерировано изображение: «' + p + '»';
      }],
      [/^Wants to run:\s*(.+)$/i, function (_, c) {
        return 'Запрашивает запуск: ' + c;
      }],
      [/^Fix with Agent:\s*(.+)$/i, function (_, c) {
        return 'Исправить с помощью агента: ' + c;
      }],
      [/^Delete side question:\s*(.+)$/i, function (_, q) {
        return 'Удалить попутный вопрос: ' + q;
      }],
      [/^Reply to\s+(.+?)\.\.\.\s*\(Esc to minimize\)$/i, function (_, t) {
        return 'Ответить в ' + t + '... (Esc — свернуть)';
      }],
      [/^(\d+)\s+lines?\s+added,\s*(\d+)\s+lines?\s+removed$/i, function (_, a, d) {
        return 'Добавлено строк: ' + a + ', удалено: ' + d;
      }],
      [/^Unfold lines\s+(\d+)-(\d+)$/i, function (_, a, b) {
        return 'Развернуть строки ' + a + '\u2013' + b;
      }],
      [/^Show\s+(\d+)\s+earlier\s+steps?$/i, function (_, n) {
        return 'Показать ещё ' + n + ' ' + pluralRu(n, 'предыдущий шаг', 'предыдущих шага', 'предыдущих шагов');
      }],
      [/^Go to page\s+(\d+)$/i, function (_, p) {
        return 'Перейти на страницу ' + p;
      }],
      [/^Go to slide\s+(\d+)$/i, function (_, s) {
        return 'Перейти к слайду ' + s;
      }],
      [/^Go to turn\s+(\d+)\s+of\s+(\d+)$/i, function (_, a, b) {
        return 'Перейти к ходу ' + a + ' из ' + b;
      }],
      [/^Page\s+(\d+)\s+failed to load$/i, function (_, p) {
        return 'Не удалось загрузить страницу ' + p;
      }],
      [/^Playback speed\s+([0-9.]+)x$/i, function (_, s) {
        return 'Скорость воспроизведения ' + s + 'x';
      }],
      [/^Zoom\s+(\d+)%,\s*reset to fit$/i, function (_, z) {
        return 'Масштаб ' + z + '% (сбросить по размеру)';
      }],
      [/^View Diff for\s+(.+)$/i, function (_, f) {
        return 'Показать изменения: ' + f;
      }],
      [/^Detached at\s+([0-9a-f]{6,40})$/i, function (_, h) {
        return 'Отделённый HEAD на ' + h;
      }],
      [/^All changes since\s+(.+)$/i, function (_, b) {
        return 'Все изменения начиная с ' + b;
      }],
      [/^Help us improve\s+(.+?)\.?$/i, function (_, app) {
        return 'Помогите нам улучшить ' + app + '.';
      }],
      [/^(Skill|Plugin)\s+installed:\s*(.+)$/i, function (_, kind, name) {
        return (/^skill$/i.test(kind) ? 'Установлен навык: ' : 'Установлен плагин: ') + name;
      }],
      [/^Account this MCP server uses:\s*(.+)$/i, function (_, acc) {
        return 'Аккаунт для этого MCP-сервера: ' + acc;
      }],
      [/^The\s+(.+?)\s+MCP server requires configuration parameters before it can be started\.?$/i, function (_, srv) {
        return 'Для запуска MCP-сервера ' + srv + ' необходимо указать параметры конфигурации.';
      }],
      [/^(Disable|Enable)\s+(.+?)\s+tool for\s+(.+)$/i, function (_, act, tool, scope) {
        return (/^disable$/i.test(act) ? 'Отключить' : 'Включить') + ' инструмент ' + tool + ' для ' + scope;
      }],
      [/^Filter skills and rules:\s*(.+)$/i, function (_, v) {
        return 'Фильтр навыков и правил: ' + translateInnerTerm(v);
      }],
      [/^Auth(?:orization)? code for\s+(.+)$/i, function (_, x) {
        return 'Код авторизации для ' + x;
      }],
      [/^Signed in:\s*(.+)$/i, function (_, x) {
        return 'Выполнен вход: ' + x;
      }],
      [/^Sign in to\s+(.+?)\s+remotely$/i, function (_, x) {
        return 'Войти в ' + x + ' удалённо';
      }],
      [/^The browser blocked the download of\s+(.+)$/i, function (_, f) {
        return 'Браузер заблокировал загрузку файла ' + f;
      }],
      [/^Blocked (?:external )?popup (?:navigation )?to\s+"(.+)"$/i, function (_, u) {
        return 'Заблокировано всплывающее окно: «' + u + '»';
      }],
      [/^Blocked navigation to\s+"(.+)"$/i, function (_, u) {
        return 'Заблокирован переход по адресу «' + u + '»';
      }],
      [/^Blocked cross-origin subframe\s+"(.+)"$/i, function (_, u) {
        return 'Заблокирован межсайтовый фрейм «' + u + '»';
      }],
      [/^Preview unavailable\s*[\u2014-]\s*(.+)$/i, function (_, r) {
        return 'Предпросмотр недоступен — ' + translateInnerTerm(r);
      }],
      [/^Microphone blocked\.\s*Allow in\s+(.+?)\.?$/i, function (_, s) {
        return 'Микрофон заблокирован. Разрешите доступ в разделе «' + translateInnerTerm(s) + '».';
      }],
      [/^Microphone access for\s+(.+?)\s+was denied\.\s*Quit and reopen the app to be asked again\.?$/i, function (_, app) {
        return 'Доступ к микрофону для ' + app + ' отклонён. Перезапустите приложение, чтобы запросить разрешение повторно.';
      }],
      [/^System default\s*\((.+)\)$/i, function (_, d) {
        return 'Системный по умолчанию (' + d + ')';
      }],
      [/^Switch environment\s*\((.+)\)$/i, function (_, env) {
        return 'Сменить окружение (' + translateInnerTerm(env) + ')';
      }],
      [/^\+(\d+)\s+more$/i, function (_, n) {
        return '+ ещё ' + n;
      }],
      // Antigravity v2.33.0 dynamic rules (Cookies by Site, Voice retry, Hidden hosts, Drafts, Select all, Hooks/IDs)
      [/^Deleted cookies for\s+(.+)$/i, function (_, site) {
        return 'Удалены cookie для ' + site;
      }],
      [/^Couldn't delete cookies for\s+(.+?)\.\s*Try again\.?$/i, function (_, site) {
        return 'Не удалось удалить cookie для ' + site + '. Попробуйте ещё раз.';
      }],
      [/^No sites match\s+["\u201c](.+?)["\u201d]\.?$/i, function (_, q) {
        return 'Нет сайтов по запросу «' + q + '».';
      }],
      [/^Retrying transcription\s*\(attempt\s+(\d+)\)(?:\.{3}|\u2026)?$/i, function (_, n) {
        return 'Повтор распознавания речи (попытка ' + n + ')…';
      }],
      [/^(\d+)\s+hidden hosts?$/i, function (_, n) {
        return n + ' ' + pluralRu(n, 'скрытый хост', 'скрытых хоста', 'скрытых хостов');
      }],
      [/^(\d+)\s+Drafts?$/i, function (_, n) {
        return n + ' ' + pluralRu(n, 'черновик', 'черновика', 'черновиков');
      }],
      [/^Select all in\s+(.+)$/i, function (_, title) {
        return 'Выбрать всё в «' + title + '»';
      }],
      [/^An?\s+(.+?)\s+with the ID\s+["\u201c](.+?)["\u201d]\s+already exists\.?$/i, function (_, kind, id) {
        return 'Элемент (' + translateInnerTerm(kind) + ') с ID «' + id + '» уже существует.';
      }],
      [/^An?\s+(.+?)\s+with this name already exists on this computer\.\s*Run it remotely, or go back and rename it\.?$/i, function (_, kind) {
        return 'Элемент (' + translateInnerTerm(kind) + ') с таким именем уже существует на этом компьютере. Запустите его удалённо или вернитесь и переименуйте.';
      }],
      [/^An?\s+(.+?)\s+with this name already exists\.?$/i, function (_, kind) {
        return 'Элемент (' + translateInnerTerm(kind) + ') с таким именем уже существует.';
      }],
      [/^Are you sure you want to delete the hook\s+"(.+?)"\?$/i, function (_, name) {
        return 'Удалить хук «' + name + '»?';
      }],
      [/^Hook with this name already exists$/i, function () {
        return 'Хук с таким именем уже существует';
      }],
      [/^Canceled (bookmark|creation|deletion|edit) (?:of|to)\s+(.+)$/i, function (_, kind, target) {
        var map = {
          bookmark: 'Отменено добавление в закладки: ',
          creation: 'Отменено создание: ',
          deletion: 'Отменено удаление: ',
          edit: 'Отменено изменение: '
        };
        return (map[kind.toLowerCase()] || 'Отменено: ') + target;
      }],
      // Antigravity v2.33.1 и расширенный экран обзора Swarm (hive.js / app.js)
      [/^(\d+)\s+on for this conversation$/i, function (_, n) {
        return n + ' вкл. для этого диалога';
      }],
      [/^Agent:\s*(.+?)\.\s*Change it in the model menu\.?$/i, function (_, name) {
        return 'Агент: ' + name + '. Изменить можно в меню выбора модели.';
      }],
      [/^(\d+)\s+of\s+(\d+)$/i, function (_, a, b) {
        return a + ' из ' + b;
      }],
      [/^(\d+)\/(\d+)\s+done$/i, function (_, a, b) {
        return 'Выполнено: ' + a + '/' + b;
      }],
      [/^(\d+)\s+in review$/i, function (_, n) {
        return n + ' на проверке';
      }],
      [/^Now\s*\u00b7\s*(\d+)\s*\/\s*(\d+)$/i, function (_, a, b) {
        return 'Сейчас \u00b7 ' + a + ' / ' + b;
      }],
      [/^(\d+)\s+posts?\s+since the view was updated$/i, function (_, n) {
        return n + ' ' + pluralRu(n, 'сообщение', 'сообщения', 'сообщений') + ' с момента обновления обзора';
      }],
      [/^Last change:\s*[“"](.+?)[”"]$/i, function (_, txt) {
        return 'Последнее изменение: «' + txt + '»';
      }],
      [/^(.+?)\s+runs on\s+(.+?);\s*open it there\.?$/i, function (_, name, host) {
        return name + ' выполняется на ' + host + '; откройте его там.';
      }],
      [/^(.+?)\s*\u00b7\s*(\d+)\s+machines?$/i, function (_, label, n) {
        return translateInnerTerm(label) + ' \u00b7 ' + n + ' ' + pluralRu(n, 'машина', 'машины', 'машин');
      }],
      [/^(.+?)\s*\u00b7\s*(reconnecting|connecting|unavailable)$/i, function (_, label, st) {
        var map = { reconnecting: 'переподключение', connecting: 'подключение', unavailable: 'недоступно' };
        return translateInnerTerm(label) + ' \u00b7 ' + (map[st.toLowerCase()] || st);
      }],
      [/^Narrator view\s*\u00b7\s*(\d+)\s+posts?\s+behind$/i, function (_, n) {
        return 'Обзор летописца \u00b7 отставание: ' + n + ' ' + pluralRu(n, 'сообщение', 'сообщения', 'сообщений');
      }],
      [/^Open\s+(.+?)\s+skill$/i, function (_, name) {
        return 'Открыть навык ' + name;
      }],
      [/^Open the\s+(.+?)\s+plugin$/i, function (_, name) {
        return 'Открыть плагин ' + name;
      }],
      [/^Review\s+(.+?)\s+before installing$/i, function (_, name) {
        return 'Проверить ' + name + ' перед установкой';
      }],
      [/^Remove\s+(.+?)\s+from Recent$/i, function (_, host) {
        return 'Удалить ' + host + ' из недавних';
      }],
      [/^Move to Group:\s*(.+)$/i, function (_, name) {
        return 'Переместить в группу: ' + name;
      }],
      [/^Created automation\s+"(.+?)"\.?$/i, function (_, name) {
        return 'Создана автоматизация «' + name + '».';
      }],
      [/^(Deleted|Enabled|Restarted|Started)\s+"(.+?)"\.?$/i, function (_, act, name) {
        var map = { deleted: 'Удалено', enabled: 'Включено', restarted: 'Перезапущено', started: 'Запущено' };
        return (map[act.toLowerCase()] || act) + ': «' + name + '».';
      }],
      [/^Failed to (save|delete|update|start)\s+"(.+?)"\.?$/i, function (_, act, name) {
        var map = { save: 'сохранить', delete: 'удалить', update: 'обновить', start: 'запустить' };
        return 'Не удалось ' + (map[act.toLowerCase()] || act) + ' «' + name + '»';
      }],

      // Antigravity v2.34.0 и обновлённое расширение Swarm (GIF-экспорт и обзор Hive)
      [/^Exporting\s+(\d+)%$/i, function (_, pct) {
        return 'Экспорт ' + pct + '%';
      }],
      [/^Exporting\s+(.+?)(?:\.{3}|\u2026)?$/i, function (_, file) {
        return 'Экспорт ' + file + '…';
      }],
      [/^Rendering\s+(.+?)(?:\.{3}|\u2026)?$/i, function (_, file) {
        return 'Рендеринг ' + file + '…';
      }],
      [/^Download\s+([A-Za-z0-9._-]+\.gif)$/i, function (_, file) {
        return 'Скачать ' + file;
      }],
      [/^Exported\s+(.+?)\s*\((\d+)\s+frames?\s*(?:\u00b7|,)\s*(.+?)\)$/i, function (_, file, n, sz) {
        return 'Экспортировано: ' + file + ' (' + n + ' ' + pluralRu(n, 'кадр', 'кадра', 'кадров') + ' \u00b7 ' + sz + ')';
      }],
      [/^GIF ready\s*\((\d+)\s+frames?(?:\s*(?:\u00b7|,)\s*(.+?))?\)\s*[\u2014-]\s*right-click image to save\.?$/i, function (_, n, sz) {
        return 'GIF готов (' + n + ' ' + pluralRu(n, 'кадр', 'кадра', 'кадров') + (sz ? ', ' + sz : '') + ') — нажмите правой кнопкой по изображению, чтобы сохранить.';
      }],
      [/^Swarm start\s*\u00b7\s*(\d+)\s+members?$/i, function (_, n) {
        return 'Старт роя \u00b7 ' + n + ' ' + pluralRu(n, 'участник', 'участника', 'участников');
      }],
      [/^(\d+)\s+posts?\s*\u00b7\s*(\d+)\s+members?$/i, function (_, p, m) {
        return p + ' ' + pluralRu(p, 'сообщение', 'сообщения', 'сообщений') + ' \u00b7 ' + m + ' ' + pluralRu(m, 'участник', 'участника', 'участников');
      }],
      [/^(\d+)\s+frames?\s*(\u00b7|,)\s*(.+)$/i, function (_, n, sep, sz) {
        return n + ' ' + pluralRu(n, 'кадр', 'кадра', 'кадров') + (sep === ',' ? ', ' : ' \u00b7 ') + sz;
      }],
      [/^([A-Za-z0-9_.-]+)\s+\(not on the roster\)$/i, function (_, name) {
        return name + ' (нет в составе)';
      }],
      [/^Working for\s+@([A-Za-z0-9_.-]+)$/i, function (_, who) {
        return 'Работает для @' + who;
      }],
      [/^Go to\s+#(\d+)\s+on the Board$/i, function (_, seq) {
        return 'Перейти к #' + seq + ' на доске';
      }],
      [/^Open\s+@([A-Za-z0-9_.-]+)$/i, function (_, who) {
        return 'Открыть @' + who;
      }],
      [/^(\d+)\s+of\s+(\d+)\s+done$/i, function (_, a, b) {
        return 'Выполнено: ' + a + ' из ' + b;
      }],
      [/^Coordinator\s*\u00b7\s*(\d+)\s+of\s+(\d+)\s+done(?:\s*\u00b7\s*(.+))?$/i, function (_, a, b, tail) {
        return 'Координатор \u00b7 выполнено ' + a + ' из ' + b + (tail ? ' \u00b7 ' + translateInnerTerm(tail) : '');
      }],
      [/^Shared\s+(.+?)\s+board(?:\s+(.+))?$/i, function (_, lbl, id) {
        return 'Общая доска (' + translateInnerTerm(lbl) + ')' + (id ? ' ' + id : '');
      }],
      [/^Copied\s+[“"](.+?)[”"]\.\s*Paste it to the coordinator and say what you want changed\.?$/i, function (_, txt) {
        return 'Скопировано «' + txt + '». Вставьте в чат координатору и укажите, что нужно изменить.';
      }],
      [/^Tell the coordinator:\s*[“"](.+?)[”"]$/i, function (_, txt) {
        return 'Написать координатору: «' + txt + '»';
      }],
      [/^the narrator's view failed\s*\((.+?)\)$/i, function (_, reason) {
        return 'ошибка обзора летописца (' + reason + ')';
      }],
      [/^(over|for)\s+(\d+(?:\.\d+)?\s*(?:ms|[wdhms])(?:\s+\d+(?:\.\d+)?\s*(?:ms|[wdhms]))*)$/i, function (_, prep, dur) {
        return (/^over$/i.test(prep) ? 'за ' : 'уже ') + translateDurationEnToRu(dur, true);
      }],
      [/^(\d+(?:\.\d+)?\s*(?:ms|[wdhms])(?:\s+\d+(?:\.\d+)?\s*(?:ms|[wdhms]))*)\s+ago$/i, function (_, dur) {
        return translateDurationEnToRu(dur, true) + ' назад';
      }]
    ];

    function translateString(trimmed) {
      if (!trimmed || trimmed.length < 2 || trimmed.length > 4500) return null;
      // Быстрая отсечка: если в строке вообще нет латинских букв (чистая кириллица, знаки, цифры)
      if (!/[A-Za-z]/.test(trimmed)) return null;

      // Если в строке есть кириллица И она НЕ начинается с "Hi " (приветствие с русским именем аккаунта),
      // значит это уже переведённая строка, содержащая латинские названия брендов (напр. "Модель Gemini Pro")
      if (/[\u0400-\u04FF]/.test(trimmed) && !/^Hi\s+/i.test(trimmed)) return null;

      if (Object.prototype.hasOwnProperty.call(EXACT, trimmed)) {
        return EXACT[trimmed];
      }
      if (Object.prototype.hasOwnProperty.call(TRIMMED_EXACT, trimmed)) {
        return TRIMMED_EXACT[trimmed];
      }

      // Нормализация символа многоточия Unicode ("…" -> "...") для полного совпадения со словарём
      if (trimmed.indexOf('\u2026') !== -1) {
        var normEllipsis = trimmed.replace(/\u2026/g, '...');
        if (Object.prototype.hasOwnProperty.call(TRIMMED_EXACT, normEllipsis)) {
          return TRIMMED_EXACT[normEllipsis];
        }
      }

      // Безусловный поиск по нормализованным пробелам/переносам строк (для многострочных YAML-описаний навыков и плагинов)
      var collapsed = trimmed.replace(/\s+/g, ' ');
      if (Object.prototype.hasOwnProperty.call(COLLAPSED_EXACT, collapsed)) {
        return COLLAPSED_EXACT[collapsed];
      }
      if (collapsed.indexOf('>- ') === 0) {
        var strippedYaml = collapsed.slice(3).trim();
        if (Object.prototype.hasOwnProperty.call(COLLAPSED_EXACT, strippedYaml)) {
          return COLLAPSED_EXACT[strippedYaml];
        }
      }
      if (collapsed.indexOf('\u2026') !== -1) {
        var collapsedNorm = collapsed.replace(/\u2026/g, '...');
        if (Object.prototype.hasOwnProperty.call(COLLAPSED_EXACT, collapsedNorm)) {
          return COLLAPSED_EXACT[collapsedNorm];
        }
      }
      // Если длинное описание слеш-команды в меню поиска усечено слева через "…" (функция g9a в main.js)
      if (collapsed.charCodeAt(0) === 0x2026 && collapsed.length >= 20) {
        var suffix = collapsed.slice(1).trim();
        if (suffix.length >= 18) {
          for (var ckKey in COLLAPSED_EXACT) {
            if (ckKey.length > suffix.length && ckKey.slice(ckKey.length - suffix.length) === suffix) {
              return COLLAPSED_EXACT[ckKey];
            }
          }
        }
      }

      var targetForRegex = collapsed;
      for (var i = 0; i < DYNAMIC_PATTERNS.length; i++) {
        var entry = DYNAMIC_PATTERNS[i];
        if (entry[0].test(targetForRegex)) {
          return targetForRegex.replace(entry[0], entry[1]);
        }
      }
      return null;
    }

    // Рекурсивный перевод пунктов нативного контекстного меню Electron (без изменения id/role/accelerator)
    function translateMenuItems(items) {
      if (!Array.isArray(items)) return items;
      return items.map(function (item) {
        if (!item || typeof item !== 'object') return item;
        var copy = Object.assign({}, item);
        if (typeof copy.label === 'string' && copy.label.trim()) {
          var rawLabel = copy.label.trim();
          var cleanMnemonic = rawLabel.replace(/&(?=[A-Za-z])/g, '');
          var ruLabel = translateString(rawLabel) || translateString(cleanMnemonic);
          if (ruLabel && ruLabel !== copy.label) {
            copy.label = ruLabel;
          }
        }
        if (Array.isArray(copy.submenu)) {
          copy.submenu = translateMenuItems(copy.submenu);
        }
        return copy;
      });
    }

    // 3. Перехват API preload.js до вызова contextBridge.exposeInMainWorld
    var targetNativeApi = (scopeOverrides && scopeOverrides.electronNativeAPI) ||
      (typeof electronNativeAPI !== 'undefined' ? electronNativeAPI : null);
    if (targetNativeApi && typeof targetNativeApi.showContextMenu === 'function' && !targetNativeApi.__agyRuWrapped) {
      var origShowContextMenu = targetNativeApi.showContextMenu;
      targetNativeApi.showContextMenu = function (items) {
        return origShowContextMenu.call(this, translateMenuItems(items));
      };
      Object.defineProperty(targetNativeApi, '__agyRuWrapped', { value: true, enumerable: false });
    }

    var targetNotifyApi = (scopeOverrides && scopeOverrides.notificationAPI) ||
      (typeof notificationAPI !== 'undefined' ? notificationAPI : null);
    if (targetNotifyApi && typeof targetNotifyApi.send === 'function' && !targetNotifyApi.__agyRuWrapped) {
      var origNotifySend = targetNotifyApi.send;
      targetNotifyApi.send = function (options) {
        if (options && typeof options === 'object') {
          var nextOpts = Object.assign({}, options);
          if (typeof nextOpts.title === 'string') {
            var ruTitle = translateString(nextOpts.title.trim());
            if (ruTitle) nextOpts.title = ruTitle;
          }
          if (typeof nextOpts.body === 'string') {
            var ruBody = translateString(nextOpts.body.trim());
            if (ruBody) nextOpts.body = ruBody;
          }
          return origNotifySend.call(this, nextOpts);
        }
        return origNotifySend.apply(this, arguments);
      };
      Object.defineProperty(targetNotifyApi, '__agyRuWrapped', { value: true, enumerable: false });
    }

    // Теги и селекторы, внутри которых текст НЕ переводится:
    // - KBD сохраняет названия клавиш (Ctrl, Shift, Alt, Delete, Enter, Escape)
    // - .material-symbols* / .codicon сохраняет лигатуры шрифтовых иконок ("close", "check", "refresh")
    // - CODE / PRE / .monaco-editor / .xterm / .cm-editor сохраняет программный код и вывод терминала
    var SKIP_TAGS = {
      CODE: 1,
      PRE: 1,
      SCRIPT: 1,
      STYLE: 1,
      TEXTAREA: 1,
      INPUT: 1,
      KBD: 1,
      SAMP: 1,
      SVG: 1,
      MATH: 1,
      NOSCRIPT: 1
    };

    // Важно: используем только точные токены классов шрифтовых иконок (.google-symbols, .material-symbols*, .codicon),
    // без подстрочных селекторов [class*="..."], чтобы НЕ задевать произвольные модификаторы Tailwind на пунктах меню
    // вида "[&:has(>.material-symbols-outlined:first-child)]:pl-1.5" или "[&:has(>.google-symbols:first-child)]:pl-1.5".
    var SKIP_CLOSEST_SELECTOR = [
      'kbd',
      'code',
      'pre',
      'textarea',
      '.monaco-editor',
      '.xterm',
      '.cm-editor',
      '.katex',
      '.google-symbols',
      '.material-symbols',
      '.material-symbols-outlined',
      '.material-symbols-rounded',
      '.material-symbols-sharp',
      '.material-icons',
      '.codicon',
      '[contenteditable="true"]',
      '[data-agy-no-ru]'
    ].join(', ');

    var ICON_FONT_TOKEN_RE = /(?:^|\s)(?:google-symbols|material-symbols(?:-(?:outlined|rounded|sharp))?|material-icons|codicon(?:-[A-Za-z0-9_-]+)?)(?=\s|$)/;

    function hasIconFontClass(el) {
      if (!el || typeof el.className !== 'string' || !el.className) return false;
      return ICON_FONT_TOKEN_RE.test(el.className);
    }

    function shouldSkipElement(el) {
      if (!el || el.nodeType !== 1) return true;
      if (SKIP_TAGS[el.tagName]) return true;
      if (hasIconFontClass(el)) return true;
      if (typeof el.closest === 'function' && el.closest(SKIP_CLOSEST_SELECTOR)) return true;
      // Резервная проверка родителей на случай упрощённого DOM-окружения без el.closest
      if (typeof el.closest !== 'function') {
        var cur = el;
        while (cur && cur.nodeType === 1) {
          if (SKIP_TAGS[cur.tagName] || hasIconFontClass(cur)) return true;
          cur = cur.parentElement;
        }
      }
      return false;
    }

    // Поиск родительского контейнера описания слеш-команды или @-упоминания (до 4 уровней вверх)
    function findAncestorMenuDescription(el) {
      var cur = el;
      for (var d = 0; cur && cur.nodeType === 1 && d < 4; d++) {
        if (typeof cur.getAttribute === 'function' && cur.getAttribute('data-testid') === 'menu-option-description') {
          return cur;
        }
        cur = cur.parentElement || cur.parentNode;
      }
      return null;
    }

    function collectTextNodes(rootNode, out) {
      if (!rootNode) return;
      if (rootNode.nodeType === 3) {
        out.push(rootNode);
        return;
      }
      var children = rootNode.childNodes;
      if (!children) return;
      for (var i = 0; i < children.length; i++) {
        collectTextNodes(children[i], out);
      }
    }

    // Безопасный для React Fiber перевод описаний слеш-команд, разбитых подсветкой fuzzy-match-highlight при вводе после "/"
    function translateFuzzySplitDescription(descEl) {
      var textNodes = [];
      collectTextNodes(descEl, textNodes);
      if (textNodes.length <= 1) return false;

      var parts = [];
      for (var i = 0; i < textNodes.length; i++) {
        var tn = textNodes[i];
        var curVal = tn.nodeValue || '';
        if (tn.__agyLastSet !== undefined && curVal === tn.__agyLastSet && typeof tn.__agyOrig === 'string') {
          parts.push(tn.__agyOrig);
        } else {
          tn.__agyOrig = curVal;
          parts.push(curVal);
        }
      }

      var combined = parts.join('').trim();
      if (!combined) return false;
      var ru = translateString(combined);
      if (!ru) return true;

      var targetNode = null;
      for (var j = 0; j < textNodes.length; j++) {
        var p = textNodes[j].parentElement || textNodes[j].parentNode;
        var isHighlight = p && typeof p.getAttribute === 'function' && p.getAttribute('data-testid') === 'fuzzy-match-highlight';
        if (!isHighlight) {
          targetNode = textNodes[j];
          break;
        }
      }
      if (!targetNode) targetNode = textNodes[0];

      for (var m = 0; m < textNodes.length; m++) {
        var nodeItem = textNodes[m];
        var nextText = nodeItem === targetNode ? ru : '';
        nodeItem.__agyLastSet = nextText;
        if (nodeItem.nodeValue !== nextText) {
          nodeItem.nodeValue = nextText;
        }
      }
      return true;
    }

    // Безопасная склейка соседних текстовых узлов внутри однородного контейнера (напр. "An ", vb, " with this name...")
    function translateSiblingTextGroup(parentEl) {
      var children = parentEl && parentEl.childNodes;
      if (!children || children.length < 2 || children.length > 5) return false;
      var textNodes = [];
      for (var i = 0; i < children.length; i++) {
        if (children[i].nodeType !== 3) return false;
        textNodes.push(children[i]);
      }

      var parts = [];
      for (var j = 0; j < textNodes.length; j++) {
        var tn = textNodes[j];
        var curVal = tn.nodeValue || '';
        if (tn.__agyLastSet !== undefined && curVal === tn.__agyLastSet && typeof tn.__agyOrig === 'string') {
          parts.push(tn.__agyOrig);
        } else {
          tn.__agyOrig = curVal;
          parts.push(curVal);
        }
      }

      var combined = parts.join('').trim();
      if (!combined || combined.length > 4500) return false;
      if (/^\(\s*[\d,.\s]+\s+tokens?\s*\)$/i.test(combined)) return false;
      var ru = translateString(combined);
      if (!ru || ru === combined) return false;

      for (var k = 0; k < textNodes.length; k++) {
        var nodeItem = textNodes[k];
        var nextText = k === 0 ? ru : '';
        nodeItem.__agyLastSet = nextText;
        if (nodeItem.nodeValue !== nextText) {
          nodeItem.nodeValue = nextText;
        }
      }
      return true;
    }

    function translateTextNode(node) {
      var parent = node.parentElement || node.parentNode;
      if (!parent || parent.nodeType !== 1 || shouldSkipElement(parent)) return;

      var descContainer = findAncestorMenuDescription(parent);
      if (descContainer && translateFuzzySplitDescription(descContainer)) {
        return;
      }

      if (translateSiblingTextGroup(parent)) {
        return;
      }

      var raw = node.nodeValue;
      if (!raw || raw.length < 2 || raw.length > 4800) return;

      // Сначала проверяем точное совпадение с учётом ведущих/замыкающих пробелов (для фрагментов JSX)
      if (!/[\u0400-\u04FF]/.test(raw) && Object.prototype.hasOwnProperty.call(EXACT, raw)) {
        var exactRu = EXACT[raw];
        if (exactRu && exactRu !== raw && node.nodeValue !== exactRu) {
          node.nodeValue = exactRu;
          return;
        }
      }

      var trimmed = raw.trim();
      if (!trimmed) return;
      var ru = translateString(trimmed);
      if (ru && ru !== trimmed) {
        var idx = raw.indexOf(trimmed);
        if (idx !== -1) {
          var nextVal = raw.slice(0, idx) + ru + raw.slice(idx + trimmed.length);
          if (node.nodeValue !== nextVal) {
            node.nodeValue = nextVal;
          }
        }
      }
    }

    var ATTRS = ['placeholder', 'title', 'aria-label', 'aria-description', 'alt', 'data-tooltip'];

    function translateElementAttrs(el) {
      if (!el || el.nodeType !== 1 || typeof el.getAttribute !== 'function') return;
      if (typeof el.closest === 'function' && el.closest('.monaco-editor, .xterm, .cm-editor')) return;
      for (var i = 0; i < ATTRS.length; i++) {
        var attr = ATTRS[i];
        var val = el.getAttribute(attr);
        if (val && val.length >= 2 && val.length <= 4500) {
          var trimmed = val.trim();
          var ru = translateString(trimmed);
          if (ru && ru !== val) {
            el.setAttribute(attr, ru);
          }
        }
      }
    }

    var win = (scopeOverrides && scopeOverrides.window) || (typeof window !== 'undefined' ? window : null);
    var doc = (scopeOverrides && scopeOverrides.document) || (typeof document !== 'undefined' ? document : null);
    var observedRoots = typeof WeakSet !== 'undefined' ? new WeakSet() : null;

    function observeRoot(rootNode, obs) {
      if (!rootNode || !obs) return;
      if (observedRoots) {
        if (observedRoots.has(rootNode)) return;
        observedRoots.add(rootNode);
      }
      obs.observe(rootNode, {
        childList: true,
        subtree: true,
        characterData: true,
        attributes: true,
        attributeFilter: ATTRS
      });
    }

    function walkSubtree(root, obs) {
      if (!root) return;
      if (root.nodeType === 3) {
        translateTextNode(root);
        return;
      }
      if (root.nodeType !== 1 && root.nodeType !== 11) return;

      if (root.nodeType === 1) {
        if (SKIP_TAGS[root.tagName]) {
          if (root.tagName === 'INPUT' || root.tagName === 'TEXTAREA') {
            translateElementAttrs(root);
          }
          return;
        }
        translateElementAttrs(root);
        if (root.shadowRoot) {
          observeRoot(root.shadowRoot, obs);
          walkSubtree(root.shadowRoot, obs);
        }
      }

      if (doc && typeof doc.createTreeWalker === 'function') {
        var walker = doc.createTreeWalker(root, 5 /* SHOW_ELEMENT | SHOW_TEXT */);
        var cur = walker.nextNode();
        while (cur) {
          if (cur.nodeType === 3) {
            translateTextNode(cur);
          } else if (cur.nodeType === 1) {
            translateElementAttrs(cur);
            if (cur.shadowRoot) {
              observeRoot(cur.shadowRoot, obs);
              walkSubtree(cur.shadowRoot, obs);
            }
          }
          cur = walker.nextNode();
        }
      } else if (root.childNodes) {
        for (var c = 0; c < root.childNodes.length; c++) {
          walkSubtree(root.childNodes[c], obs);
        }
      }
    }

    function translateDocumentTitle() {
      if (!doc || typeof doc.title !== 'string' || !doc.title.trim()) return;
      var ruTitle = translateString(doc.title.trim());
      if (ruTitle && ruTitle !== doc.title) {
        doc.title = ruTitle;
      }
    }

    apiResult = {
      translateString: translateString,
      translateDurationEnToRu: translateDurationEnToRu,
      translateMenuItems: translateMenuItems,
      walkSubtree: walkSubtree,
      shouldSkipElement: shouldSkipElement
    };

    // 4. Активация живого DOM-переводчика только на локальном хосте интерфейса и в plugin:// сайдкарах Antigravity
    if (!win || !doc) return apiResult;
    var loc = win.location;
    if (
      loc &&
      loc.protocol !== 'file:' &&
      loc.protocol !== 'about:' &&
      loc.protocol !== 'plugin:' &&
      loc.hostname !== '127.0.0.1' &&
      loc.hostname !== 'localhost'
    ) {
      return apiResult;
    }

    var pendingNodes = new Set();
    var rafScheduled = false;
    var activeObserver = null;

    function flushMutations() {
      rafScheduled = false;
      translateDocumentTitle();
      pendingNodes.forEach(function (n) {
        walkSubtree(n, activeObserver);
      });
      pendingNodes.clear();
    }

    function scheduleFlush() {
      if (rafScheduled) return;
      rafScheduled = true;
      if (typeof win.requestAnimationFrame === 'function') {
        win.requestAnimationFrame(flushMutations);
      } else {
        setTimeout(flushMutations, 16);
      }
    }

    var observedDocEl = null;

    function startObserver() {
      if (!doc || !doc.documentElement) return;
      translateDocumentTitle();
      if (observedDocEl !== doc.documentElement) {
        observedDocEl = doc.documentElement;
        if (typeof MutationObserver === 'function') {
          if (!activeObserver) {
            activeObserver = new MutationObserver(function (mutations) {
              for (var i = 0; i < mutations.length; i++) {
                var m = mutations[i];
                if (m.type === 'characterData' && m.target) {
                  pendingNodes.add(m.target);
                } else if (m.type === 'attributes' && m.target) {
                  translateElementAttrs(m.target);
                } else if (m.addedNodes && m.addedNodes.length > 0) {
                  for (var j = 0; j < m.addedNodes.length; j++) {
                    pendingNodes.add(m.addedNodes[j]);
                  }
                }
              }
              if (pendingNodes.size > 0) {
                scheduleFlush();
              }
            });
          }
          observeRoot(doc.documentElement, activeObserver);
        }
      }
      walkSubtree(doc.documentElement, activeObserver);
    }

    startObserver();
    if (typeof doc.addEventListener === 'function') {
      doc.addEventListener('DOMContentLoaded', startObserver);
    }
    if (typeof win.addEventListener === 'function') {
      if (doc.readyState === 'loading') {
        win.addEventListener('DOMContentLoaded', startObserver, { once: true });
      }
      win.addEventListener('load', startObserver);
    }
  } catch (_err) {
    // Безопасный fallback: никогда не прерываем работу preload.js
  }
  return apiResult;
}

/**
 * Создаёт экземпляр переводчика времени выполнения в памяти Node.js (для тестирования и верификации словаря).
 * @param {ReturnType<typeof import('./dictionary').loadDictionary>} dict
 * @param {object} [scopeOverrides]
 */
function createRuntimeTranslator(dict, scopeOverrides = {}) {
  const mapObject = {};
  for (const [en, ru] of dict.allEntries.entries()) {
    if (en !== ru) {
      mapObject[en] = ru;
    }
  }
  return antigravityPreloadRuntime(mapObject, scopeOverrides);
}

/**
 * Внедряет самодостаточный блок живой русификации в dist/preload.js внутри app.asar.
 * Если в файле присутствует вызов contextBridge.exposeInMainWorld, вставляет блок непосредственно перед ним,
 * чтобы перехватить также вызовы нативных контекстных меню и системных уведомлений Electron.
 *
 * @param {string} preloadCode
 * @param {ReturnType<typeof import('./dictionary').loadDictionary>} dict
 */
function injectPreloadDomRuntime(preloadCode, dict) {
  const cleanBase = stripPreloadDomRuntime(preloadCode);

  const mapObject = {};
  for (const [en, ru] of dict.allEntries.entries()) {
    if (en !== ru) {
      mapObject[en] = ru;
    }
  }

  const serializedMap = JSON.stringify(mapObject);
  const runtimeBlock = [
    PRELOAD_MARKER_START,
    `(${antigravityPreloadRuntime.toString()})(${serializedMap});`,
    PRELOAD_MARKER_END,
  ].join('\n');

  // Ищем первую точку экспорта API в main world, чтобы успеть обернуть showContextMenu и notificationAPI.send
  const exposeMatch = cleanBase.match(/(?:electron_1\s*\.\s*)?contextBridge\s*\.\s*exposeInMainWorld\s*\(/);
  if (exposeMatch && typeof exposeMatch.index === 'number') {
    const idx = exposeMatch.index;
    const before = cleanBase.slice(0, idx).trimEnd();
    const after = cleanBase.slice(idx);
    return `${before}\n${runtimeBlock}\n${after}`;
  }

  return `${cleanBase.trimEnd()}\n${runtimeBlock}\n`;
}

const HTML_SCRIPT_START = '<!-- __AGY_RU_HTML_RUNTIME_START__ -->';
const HTML_SCRIPT_END = '<!-- __AGY_RU_HTML_RUNTIME_END__ -->';

/**
 * Удаляет ранее внедрённый <script> живой русификации из HTML-файла сайдкара (для идемпотентности).
 * @param {string} htmlCode
 */
function stripHtmlDomRuntime(htmlCode) {
  const startIdx = htmlCode.indexOf(HTML_SCRIPT_START);
  if (startIdx === -1) return htmlCode;
  const endIdx = htmlCode.indexOf(HTML_SCRIPT_END, startIdx);
  if (endIdx === -1) return htmlCode;
  const before = htmlCode.slice(0, startIdx).trimEnd();
  const after = htmlCode.slice(endIdx + HTML_SCRIPT_END.length).trimStart();
  return after ? `${before}\n${after}` : `${before}\n`;
}

/**
 * Внедряет живой DOM-русификатор в HTML-страницу UI-расширения / сайдкара (например, swarm_board/index.html).
 * @param {string} htmlCode
 * @param {ReturnType<typeof import('./dictionary').loadDictionary>} dict
 */
function injectHtmlDomRuntime(htmlCode, dict) {
  const cleanHtml = stripHtmlDomRuntime(htmlCode);
  const mapObject = {};
  for (const [en, ru] of dict.allEntries.entries()) {
    if (en !== ru) {
      mapObject[en] = ru;
    }
  }
  // Экранируем "</script" на случай упоминания тега внутри строк словаря
  const serializedMap = JSON.stringify(mapObject).replace(/<\/(script)/gi, '<\\/$1');
  const scriptBlock = [
    HTML_SCRIPT_START,
    `<script id="agy-ru-dom-runtime">(${antigravityPreloadRuntime.toString()})(${serializedMap});</script>`,
    HTML_SCRIPT_END,
  ].join('\n');

  const bodyCloseIdx = cleanHtml.lastIndexOf('</body>');
  if (bodyCloseIdx !== -1) {
    const beforeBody = cleanHtml.slice(0, bodyCloseIdx).trimEnd();
    return `${beforeBody}\n${scriptBlock}\n${cleanHtml.slice(bodyCloseIdx)}`;
  }
  return `${cleanHtml.trimEnd()}\n${scriptBlock}\n`;
}

module.exports = {
  PRELOAD_MARKER_START,
  PRELOAD_MARKER_END,
  stripPreloadDomRuntime,
  stripHtmlDomRuntime,
  antigravityPreloadRuntime,
  createRuntimeTranslator,
  injectPreloadDomRuntime,
  injectHtmlDomRuntime,
};
