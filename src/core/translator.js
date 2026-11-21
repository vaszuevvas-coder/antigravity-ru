'use strict';

/**
 * Хирургический переводчик строковых ресурсов для JS/MJS, HTML и JSON/NLS файлов.
 * В отличие от наивных regex-замен, анализирует строковые токены и окружающий синтаксический контекст,
 * чтобы никогда не повредить ключи объектов, условия case/===, импорты, маршруты и идентификаторы кода.
 */

// Свойства в JS/React/VSCode/Electron-дескрипторах, в значениях которых безопасно переводить даже одиночные слова ("Save", "Cancel", "Quit", "OK")
const UI_PROP_PREFIX_RE = /(?:(?:children|label|title|text|tooltip|placeholder|ariaLabel|"aria-label"|'aria-label'|header|buttonText|confirmText|cancelText|description|caption|heading|sublabel|emptyText|statusText|message|detail|warning)\s*:\s*|buttons\s*:\s*\[\s*(?:(?:["'][^"']*["'])\s*,\s*)*|\bshowErrorBox\s*\(\s*)$/;

// Паттерн вызова React.createElement / jsx(..., "Label") — аргумент после `},` или `null,`
const JSX_CHILD_CALL_PREFIX_RE = /(?:\}\s*,\s*|null\s*,\s*|void 0\s*,\s*)$/;

// Контексты, где строковый литерал является техническим идентификатором, ключом записи, маршрутом или проверкой и НЕ должен переводиться
const FORBIDDEN_BEFORE_RE = /(?:(?:\b(?:id|key|type|kind|role|mode|route|path|slug|command|event|channel|action|variant|field|prop|param|code|icon|iconName|symbol|tag|className)\s*:\s*)|\bcase\s+|===?\s*|!==?\s*|\bfrom\s+|\bimport\s*\(\s*|\brequire\s*\(\s*|\bgetElementById\s*\(\s*|\bquerySelector(?:All)?\s*\(\s*|\baddEventListener\s*\(\s*|\bremoveEventListener\s*\(\s*|\bgetAttribute\s*\(\s*|\bsetAttribute\s*\(\s*|\bcreateElement\s*\(\s*|\b_?jsx(?:s|DEV)?\s*\(\s*)$/;

/**
 * Декодирует простой строковый литерал JS (без выражений ${}) в обычную строку.
 * Возвращает null, если литерал содержит сложные последовательности, которые лучше не трогать.
 * @param {string} rawInner Содержимое между кавычками
 */
function unescapeJsString(rawInner) {
  if (!rawInner.includes('\\')) return rawInner;
  let out = '';
  for (let i = 0; i < rawInner.length; i++) {
    const ch = rawInner[i];
    if (ch !== '\\') {
      out += ch;
      continue;
    }
    i++;
    if (i >= rawInner.length) return null;
    const esc = rawInner[i];
    switch (esc) {
      case 'n': out += '\n'; break;
      case 'r': out += '\r'; break;
      case 't': out += '\t'; break;
      case '"': out += '"'; break;
      case "'": out += "'"; break;
      case '`': out += '`'; break;
      case '\\': out += '\\'; break;
      case '/': out += '/'; break;
      case 'u': {
        if (rawInner[i + 1] === '{') {
          const endBrace = rawInner.indexOf('}', i + 2);
          if (endBrace === -1) return null;
          const codePoint = parseInt(rawInner.slice(i + 2, endBrace), 16);
          if (Number.isNaN(codePoint)) return null;
          out += String.fromCodePoint(codePoint);
          i = endBrace;
        } else {
          const hex = rawInner.slice(i + 1, i + 5);
          if (!/^[0-9a-fA-F]{4}$/.test(hex)) return null;
          out += String.fromCharCode(parseInt(hex, 16));
          i += 4;
        }
        break;
      }
      case 'x': {
        const hex = rawInner.slice(i + 1, i + 3);
        if (!/^[0-9a-fA-F]{2}$/.test(hex)) return null;
        out += String.fromCharCode(parseInt(hex, 16));
        i += 2;
        break;
      }
      default:
        return null;
    }
  }
  return out;
}

/**
 * Безопасно экранирует переведённую строку обратно в кавычки исходного типа.
 * @param {string} str
 * @param {'"' | "'" | '`'} quote
 * @param {boolean} asciiSafe Если исходный файл использует ASCII-only, можно кодировать кириллицу в \uXXXX
 */
function escapeJsString(str, quote, asciiSafe = false) {
  let out = '';
  for (let i = 0; i < str.length; i++) {
    const ch = str[i];
    const code = str.charCodeAt(i);
    if (ch === '\\') out += '\\\\';
    else if (ch === quote) out += '\\' + quote;
    else if (ch === '\n') out += '\\n';
    else if (ch === '\r') out += '\\r';
    else if (ch === '\t') out += '\\t';
    else if (quote === '`' && ch === '$' && str[i + 1] === '{') out += '\\$';
    else if (asciiSafe && code > 127) {
      out += '\\u' + code.toString(16).padStart(4, '0');
    } else {
      out += ch;
    }
  }
  return out;
}

/**
 * Возвращает первый непробельный символ после позиции pos.
 */
function peekNextNonWs(source, pos) {
  let i = pos;
  while (i < source.length) {
    const c = source[i];
    if (c !== ' ' && c !== '\t' && c !== '\r' && c !== '\n') return c;
    i++;
  }
  return '';
}

/**
 * Переводит строковые литералы в JS/MJS/CJS-коде с проверкой лексического контекста.
 * @param {string} source
 * @param {ReturnType<typeof import('./dictionary').loadDictionary>} dict
 * @returns {{ code: string, replacements: number, matchedKeys: string[] }}
 */
function translateJavaScript(source, dict) {
  const len = source.length;
  let i = 0;
  let lastCopyIdx = 0;
  const parts = [];
  let replacements = 0;
  const matchedKeys = [];

  while (i < len) {
    const ch = source[i];

    // Пропускаем однострочные комментарии //
    if (ch === '/' && source[i + 1] === '/') {
      i += 2;
      while (i < len && source[i] !== '\n') i++;
      continue;
    }

    // Пропускаем многострочные комментарии /* ... */
    if (ch === '/' && source[i + 1] === '*') {
      i += 2;
      while (i < len && !(source[i] === '*' && source[i + 1] === '/')) i++;
      i += 2;
      continue;
    }

    // Строковые литералы: "...", '...', `...`
    if (ch === '"' || ch === "'" || ch === '`') {
      const quote = ch;
      const startQuote = i;
      i++;
      let hasTemplateExpr = false;
      let unterminated = false;

      while (i < len) {
        const c = source[i];
        if (c === '\\') {
          i += 2;
          continue;
        }
        if (quote === '`' && c === '$' && source[i + 1] === '{') {
          hasTemplateExpr = true;
          // Доходим до конца шаблонного литерала, поддерживая вложенные скобки в базовом виде
          i += 2;
          let depth = 1;
          while (i < len && depth > 0) {
            if (source[i] === '\\') { i += 2; continue; }
            if (source[i] === '{') depth++;
            else if (source[i] === '}') depth--;
            i++;
          }
          continue;
        }
        if (c === quote) {
          break;
        }
        if (quote !== '`' && (c === '\n' || c === '\r')) {
          unterminated = true;
          break;
        }
        i++;
      }

      if (unterminated || i >= len) {
        i++;
        continue;
      }

      const endQuote = i; // индекс закрывающей кавычки
      i++; // двигаемся за закрывающую кавычку

      if (hasTemplateExpr) {
        continue;
      }

      const rawInner = source.slice(startQuote + 1, endQuote);
      if (rawInner.length < 2 || rawInner.length > 2000) {
        continue;
      }

      const decoded = unescapeJsString(rawInner);
      if (!decoded || !dict.allEntries.has(decoded)) {
        continue;
      }

      // Проверяем токен ПОСЛЕ строки: если сразу идёт двоеточие ':', это ключ объекта { "Settings": ... }
      // (кроме тернарного оператора `cond ? "Settings" : "Other"`, где перед строкой был `?`)
      const nextChar = peekNextNonWs(source, i);
      const beforeSlice = source.slice(Math.max(0, startQuote - 120), startQuote);
      const trimmedBefore = beforeSlice.trimEnd();
      const prevChar = trimmedBefore.length > 0 ? trimmedBefore[trimmedBefore.length - 1] : '';

      if (nextChar === ':' && prevChar !== '?') {
        continue;
      }

      // Не переводим сравнения ===, case, импорты, DOM-селекторы и имена тегов createElement("div")
      if (FORBIDDEN_BEFORE_RE.test(beforeSlice)) {
        continue;
      }

      // Проверяем уровень безопасности: фраза или однословная кнопка в UI-контексте
      let allowed = false;
      if (dict.phraseEntries.has(decoded)) {
        allowed = true;
      } else if (dict.contextOnlySingleWords.has(decoded)) {
        if (UI_PROP_PREFIX_RE.test(beforeSlice) || JSX_CHILD_CALL_PREFIX_RE.test(beforeSlice)) {
          allowed = true;
        }
      }

      if (!allowed) {
        continue;
      }

      const ruText = dict.allEntries.get(decoded);
      if (!ruText || ruText === decoded) {
        continue;
      }

      const encodedRu = escapeJsString(ruText, quote, false);
      parts.push(source.slice(lastCopyIdx, startQuote + 1));
      parts.push(encodedRu);
      lastCopyIdx = endQuote;
      replacements++;
      matchedKeys.push(decoded);
      continue;
    }

    i++;
  }

  if (replacements === 0) {
    return { code: source, replacements: 0, matchedKeys: [] };
  }

  parts.push(source.slice(lastCopyIdx));
  return {
    code: parts.join(''),
    replacements,
    matchedKeys,
  };
}

/**
 * Переводит JSON-файлы локализации VS Code / Antigravity IDE (package.nls.json, nls.messages.json, locales/en.json).
 * @param {string} jsonText
 * @param {ReturnType<typeof import('./dictionary').loadDictionary>} dict
 */
function translateNlsJson(jsonText, dict) {
  let parsed;
  try {
    parsed = JSON.parse(jsonText);
  } catch {
    return { text: jsonText, replacements: 0, matchedKeys: [] };
  }

  let replacements = 0;
  const matchedKeys = [];

  function transformValue(val) {
    if (typeof val === 'string') {
      const trimmed = val.trim();
      // Поддержка мнемоник меню VS Code вида "&Settings" или "&&Settings" -> убираем & при поиске
      const cleanMnemonic = trimmed.replace(/&&/g, '');
      if (dict.allEntries.has(val)) {
        const next = dict.allEntries.get(val);
        if (next !== val) {
          replacements++;
          matchedKeys.push(val);
          return next;
        }
      } else if (cleanMnemonic !== trimmed && dict.allEntries.has(cleanMnemonic)) {
        const next = dict.allEntries.get(cleanMnemonic);
        if (next !== cleanMnemonic) {
          replacements++;
          matchedKeys.push(cleanMnemonic);
          return next;
        }
      }
      return val;
    }
    if (Array.isArray(val)) {
      return val.map(transformValue);
    }
    if (val && typeof val === 'object') {
      const out = {};
      for (const [k, v] of Object.entries(val)) {
        // В формате package.nls.json иногда значение — объект { message: "...", comment: [...] }
        if (k === 'comment' || k === '_comment') {
          out[k] = v;
        } else {
          out[k] = transformValue(v);
        }
      }
      return out;
    }
    return val;
  }

  const updated = transformValue(parsed);
  if (replacements === 0) {
    return { text: jsonText, replacements: 0, matchedKeys: [] };
  }

  const indentMatch = jsonText.match(/^\{\r?\n(\s+)/);
  const indent = indentMatch ? indentMatch[1] : 2;
  return {
    text: JSON.stringify(updated, null, indent) + '\n',
    replacements,
    matchedKeys,
  };
}

/**
 * Переводит HTML-шаблоны: текстовые узлы >Text<, атрибуты placeholder/title/aria-label/alt и встроенные <script>-блоки.
 * @param {string} html
 * @param {ReturnType<typeof import('./dictionary').loadDictionary>} dict
 */
function translateHtml(html, dict) {
  let replacements = 0;
  const matchedKeys = [];

  // 1. Встроенные <script>...</script> (не JSON-конфиги и не внешние src без тела)
  let result = html.replace(/(<script\b[^>]*>)([\s\S]*?)(<\/script>)/gi, (full, openTag, body, closeTag) => {
    if (!body || !body.trim()) return full;
    if (/type\s*=\s*["']application\/(?:ld\+)?json["']/i.test(openTag)) return full;
    const jsRes = translateJavaScript(body, dict);
    if (jsRes.replacements > 0) {
      replacements += jsRes.replacements;
      matchedKeys.push(...jsRes.matchedKeys);
      return openTag + jsRes.code + closeTag;
    }
    return full;
  });

  // 2. Безопасные текстовые атрибуты HTML
  result = result.replace(/\b(placeholder|title|aria-label|alt|data-tooltip)\s*=\s*(["'])([^"'\r\n]{2,2000})\2/gi, (full, attr, quote, val) => {
    if (dict.allEntries.has(val)) {
      const ru = dict.allEntries.get(val);
      if (ru && ru !== val) {
        replacements++;
        matchedKeys.push(val);
        return `${attr}=${quote}${ru}${quote}`;
      }
    }
    return full;
  });

  // 3. Текстовые узлы между тегами >Text< (вне script/style)
  result = result.replace(/>(\s*)([^<>]{2,2000}?)(\s*)</g, (full, leadWs, textBody, trailWs) => {
    const trimmed = textBody.trim();
    if (trimmed && dict.allEntries.has(trimmed)) {
      const ru = dict.allEntries.get(trimmed);
      if (ru && ru !== trimmed) {
        replacements++;
        matchedKeys.push(trimmed);
        return `>${leadWs}${ru}${trailWs}<`;
      }
    }
    return full;
  });

  return {
    html: result,
    replacements,
    matchedKeys,
  };
}

/**
 * Проверяет, является ли JSON-файл файлом локализации (NLS / i18n).
 * @param {string} relPath
 */
function isLocalizationJsonPath(relPath) {
  const norm = relPath.replace(/\\/g, '/').toLowerCase();
  const base = norm.split('/').pop() || '';
  if (base.endsWith('.nls.json') || base === 'nls.messages.json') return true;
  if (/\/(locales?|i18n|translations)\/(en|en-us|messages)\.json$/.test(norm)) return true;
  return false;
}

/**
 * Точечный перевод составных JS-выражений и шаблонных литералов основного процесса Electron (dist/tray.js, dist/main.js, dist/wsl.js).
 * @param {string} normRel
 * @param {string} code
 */
function applyElectronDynamicPatches(normRel, code) {
  let out = code;
  let count = 0;
  const matched = [];

  // 1. dist/tray.js: динамический счётчик агентов в системном трее
  const trayCountRe = /\(\s*count\s*>\s*0\s*\?\s*`\$\{count\}`\s*:\s*['"]No['"]\s*\)\s*\+\s*['"] agent['"]\s*\+\s*\(\s*count\s*===\s*1\s*\?\s*['"]{2}\s*:\s*['"]s['"]\s*\)\s*\+\s*['"] running['"]/g;
  if (trayCountRe.test(out)) {
    out = out.replace(trayCountRe, '(count > 0 ? `Активных агентов: ${count}` : \'Нет активных агентов\')');
    count++;
    matched.push('tray:updateTrayAgentCount');
  }

  // 2. dist/main.js: пункт меню трея `Open ${electron_1.app.getName()}`
  const openAppRe = /(label\s*:\s*)`Open\s+\$\{([^}]+)\}`/g;
  if (openAppRe.test(out)) {
    out = out.replace(openAppRe, '$1`Открыть ${$2}`');
    count++;
    matched.push('main:Open ${app.getName()}');
  }

  // 3. dist/wsl.js: динамические сообщения статуса и ошибок WSL
  const wslDistroMismatchRe = /`This folder belongs to the WSL distro "\$\{([^}]+)\}", but this window is connected to "\$\{([^}]+)\}"\.`/g;
  if (wslDistroMismatchRe.test(out)) {
    out = out.replace(
      wslDistroMismatchRe,
      '`Эта папка относится к дистрибутиву WSL «${$1}», а текущее окно подключено к «${$2}»`'
    );
    count++;
    matched.push('wsl:distroMismatch');
  }

  const wslCannotOpenRe = /`This location cannot be opened in WSL:\s*\$\{([^}]+)\}`/g;
  if (wslCannotOpenRe.test(out)) {
    out = out.replace(wslCannotOpenRe, '`Невозможно открыть это расположение в WSL: ${$1}`');
    count++;
    matched.push('wsl:cannotOpen');
  }

  const wslInstallingIntoRe = /`Installing into\s+\$\{([^}]+)\}(\\u2026|…)`/g;
  if (wslInstallingIntoRe.test(out)) {
    out = out.replace(wslInstallingIntoRe, '`Установка сервера в WSL (${$1})…`');
    count++;
    matched.push('wsl:installingInto');
  }

  const wslDownloadingBinRe = /(['"])Downloading the Antigravity binary(?:\\u2026|…)\1/g;
  if (wslDownloadingBinRe.test(out)) {
    out = out.replace(wslDownloadingBinRe, '$1Загрузка серверного компонента Antigravity…$1');
    count++;
    matched.push('wsl:downloadingBinary');
  }

  // 4. dist/ideInstall/wizardHtml.js: HTML-мастер перехода на новый Antigravity / установки IDE
  if (normRel.endsWith('wizardhtml.js')) {
    const wizardPairs = [
      ['<title>Welcome to Antigravity</title>', '<title>Добро пожаловать в Antigravity</title>'],
      ['>Setting up…</div>', '>Настройка…</div>'],
      ['<h1>Welcome to the new Antigravity!</h1>', '<h1>Добро пожаловать в новый Antigravity!</h1>'],
      [
        "<p>Antigravity has been redesigned to put agents first with new capabilities. If you'd still like a code editor, you can download it as a separate app named <b>Antigravity IDE</b>.</p>",
        '<p>Antigravity обновлён с фокусом на ИИ-агентов и новые возможности. Если вам по-прежнему нужен редактор кода, вы можете скачать его отдельным приложением — <b>Antigravity IDE</b>.</p>',
      ],
      ['<span>Download the Antigravity IDE</span>', '<span>Скачать Antigravity IDE</span>'],
      ['>Explore the new Antigravity</button>', '>Открыть новый Antigravity</button>'],
    ];
    for (const [en, ru] of wizardPairs) {
      if (out.includes(en)) {
        out = out.split(en).join(ru);
        count++;
        matched.push('wizardHtml:' + en.slice(0, 32));
      }
    }
  }

  // 5. dist/computer/hud.js, hudState.js, hudAgents.js: HUD управления рабочим столом
  if (normRel.endsWith('computer/hud.js')) {
    const hudPairs = [
      ['<div id="status">AGY is controlling your Mac</div>', '<div id="status">AGY управляет вашим Mac</div>'],
      ['<button id="stop">Stop</button>', '<button id="stop">Стоп</button>'],
      ['<button id="resume">Resume</button>', '<button id="resume">Продолжить</button>'],
    ];
    for (const [en, ru] of hudPairs) {
      if (out.includes(en)) {
        out = out.split(en).join(ru);
        count++;
        matched.push('hud:' + en.slice(0, 28));
      }
    }
  }

  if (normRel.endsWith('computer/hudstate.js')) {
    const hudBgRe = /`AGY working in \$\{([^}]+)\} \(background\)`/g;
    if (hudBgRe.test(out)) {
      out = out.replace(hudBgRe, '`AGY работает в ${$1} (в фоне)`');
      count++;
      matched.push('hudState:workingInBackground');
    }
  }

  if (normRel.endsWith('computer/hudagents.js')) {
    const workingRe = /`\$\{([^}]+)\} AGY agents working`/g;
    if (workingRe.test(out)) {
      out = out.replace(workingRe, '`Работают агенты AGY: ${$1}`');
      count++;
      matched.push('hudAgents:working');
    }
    const stoppedRe = /`\$\{([^}]+)\} agents stopped`/g;
    if (stoppedRe.test(out)) {
      out = out.replace(stoppedRe, '`Остановлено агентов: ${$1}`');
      count++;
      matched.push('hudAgents:stopped');
    }
    const plusStoppedRe = /`\$\{([^}]+)\} \(\+\$\{([^}]+)\} stopped\)`/g;
    if (plusStoppedRe.test(out)) {
      out = out.replace(plusStoppedRe, '`${$1} (+${$2} ост.)`');
      count++;
      matched.push('hudAgents:plusStopped');
    }
  }

  // 6. dist/remote/sshPrompts.js: HTML-окно ввода пароля / подтверждения SSH
  if (normRel.endsWith('remote/sshprompts.js')) {
    const sshPairs = [
      ['<p class="context">Connecting to <span id="label"></span></p>', '<p class="context">Подключение к <span id="label"></span></p>'],
      ['>Asked again: your last answer may not have worked.</div>', '>Повторный запрос: предыдущий ответ, возможно, не подошёл.</div>'],
      [">That's too long.</div>", '>Слишком длинное значение.</div>'],
      ['<button id="cancel" class="secondary">Cancel</button>', '<button id="cancel" class="secondary">Отмена</button>'],
      ['<button id="continue" class="primary">Continue</button>', '<button id="continue" class="primary">Продолжить</button>'],
    ];
    for (const [en, ru] of sshPairs) {
      if (out.includes(en)) {
        out = out.split(en).join(ru);
        count++;
        matched.push('sshPrompts:' + en.slice(0, 28));
      }
    }
  }

  // 7. dist/deviceChooser.js: системный запрос подключения WebHID / WebUSB / Serial
  if (normRel.endsWith('devicechooser.js')) {
    const devConnectRe = /`\$\{([^}]+)\} wants to connect to a \$\{([^}]+)\}`/g;
    if (devConnectRe.test(out)) {
      out = out.replace(devConnectRe, '`${$1} запрашивает подключение: ${$2}`');
      count++;
      matched.push('deviceChooser:wantsToConnect');
    }
  }

  // 8. dist/main.js: уведомление об удалённом из системы дистрибутиве WSL
  if (normRel.endsWith('dist/main.js')) {
    const wslRemovedRe = /`The WSL distro "\$\{([^}]+)\}" is no longer installed\.`/g;
    if (wslRemovedRe.test(out)) {
      out = out.replace(wslRemovedRe, '`Дистрибутив WSL «${$1}» больше не установлен.`');
      count++;
      matched.push('main:wslNoLongerInstalled');
    }
  }

  // 9. dist/webauthn.js: заголовок окна входа WebAuthn / Passkey
  if (normRel.endsWith('webauthn.js')) {
    const webauthnRe = /`Sign in to \$\{([^}]+)\}`/g;
    if (webauthnRe.test(out)) {
      out = out.replace(webauthnRe, '`Вход в ${$1}`');
      count++;
      matched.push('webauthn:signInTo');
    }
  }

  // 10. dist/remote/remoteManager.js: диалоги SSH-конфига, микрофона, организации и перезапуска сервера
  if (normRel.endsWith('remote/remotemanager.js')) {
    const remoteReplacements = [
      [
        /`\$\{([^}]+)\} can't be the SSH config file`/g,
        '`${$1} не может использоваться как файл конфигурации SSH`',
        'remoteManager:cantBeSshConfig',
      ],
      [
        /`\$\{([^}]+)\} still runs Antigravity server \$\{([^}]+)\}\.`/g,
        '`На ${$1} всё ещё запущен сервер Antigravity ${$2}.`',
        'remoteManager:stillRunsServer',
      ],
      [
        /`Stop the Antigravity server on \$\{([^}]+)\}\?`/g,
        '`Остановить сервер Antigravity на ${$1}?`',
        'remoteManager:stopServer',
      ],
      [
        /`Not connected to \$\{([^}]+)\}`/g,
        '`Нет подключения к ${$1}`',
        'remoteManager:notConnected',
      ],
      [
        /`Allow \$\{([^}]+)\} to use your microphone\?`/g,
        '`Разрешить ${$1} использовать микрофон?`',
        'remoteManager:allowMic',
      ],
      [
        /`Sign in to your organization for \$\{([^}]+)\}\?`/g,
        '`Войти в организацию для ${$1}?`',
        'remoteManager:signInOrg',
      ],
      [
        /`Finish this sign-in on \$\{([^}]+)\}\?`/g,
        '`Завершить вход на ${$1}?`',
        'remoteManager:finishSignIn',
      ],
      [
        /`\$\{([^}]+)\} is running server \$\{([^}]+)\}; this app is \$\{([^}]+)\}\. Restart the server now\?`/g,
        '`На ${$1} запущен сервер ${$2}, а версия приложения — ${$3}. Перезапустить сервер сейчас?`',
        'remoteManager:restartServerVersion',
      ],
      [
        /`Any \$\{([^}]+)\} still running on it stops\. The server starts again with this app's version\.`/g,
        '`Все активные процессы (${$1}) на сервере будут остановлены, после чего сервер перезапустится с версией этого приложения.`',
        'remoteManager:restartServerDetail',
      ],
      [
        /`The page in this window comes from \$\{([^}]+)\}\. If you allow it, that `\s*\+\s*["']host can use this computer's microphone for voice whenever one of ["']\s*\+\s*['"]its windows is open\. Antigravity asks again after you quit it\.['"]/g,
        '`Страница в этом окне загружена с ${$1}. Если вы разрешите, этот хост сможет использовать микрофон этого компьютера для голосового ввода, пока открыто хотя бы одно его окно. Antigravity снова спросит после перезапуска.`',
        'remoteManager:allowMicDetail',
      ],
      [
        /`in this window\. \$\{([^}]+)\} will get access to your `/g,
        '`в этом окне. ${$1} получит доступ к `',
        'remoteManager:signInOrgDetailMiddle',
      ],
      [
        /`Workforce pool: \$\{([^}]+)\}  Provider: \$\{([^}]+)\}`/g,
        '`Пул сотрудников: ${$1}  Провайдер: ${$2}`',
        'remoteManager:workforcePool',
      ],
      [
        /`Identity provider: \$\{([^}]+)\}`/g,
        '`Провайдер удостоверений: ${$1}`',
        'remoteManager:identityProvider',
      ],
    ];
    for (const [re, repl, tag] of remoteReplacements) {
      if (re.test(out)) {
        out = out.replace(re, repl);
        count++;
        matched.push(tag);
      }
    }
  }

  // 11. dist/provisionSplash.js: окно первичной настройки WSL
  if (normRel.endsWith('provisionsplash.js')) {
    const wslSplashRe = /<div>Setting up WSL:\s*\$\{([^}]+)\}<\/div>/g;
    if (wslSplashRe.test(out)) {
      out = out.replace(wslSplashRe, '<div>Настройка WSL: ${$1}</div>');
      count++;
      matched.push('provisionSplash:settingUpWsl');
    }
  }

  return { code: out, replacements: count, matchedKeys: matched };
}

/**
 * Универсальный обработчик буфера файла по его относительному пути.
 * @param {string} relPath
 * @param {Buffer} buffer
 * @param {ReturnType<typeof import('./dictionary').loadDictionary>} dict
 */
function translateFileBuffer(relPath, buffer, dict) {
  const norm = relPath.replace(/\\/g, '/').toLowerCase();
  // Пропускаем уже русские NLS файлы, sourcemaps и lock/manifest файлы
  if (norm.endsWith('.nls.ru.json') || norm.endsWith('.map')) {
    return { buffer: null, replacements: 0, matchedKeys: [] };
  }

  if (norm.endsWith('.json')) {
    if (!isLocalizationJsonPath(norm)) {
      return { buffer: null, replacements: 0, matchedKeys: [] };
    }
    const text = buffer.toString('utf8');
    const res = translateNlsJson(text, dict);
    if (res.replacements > 0) {
      return { buffer: Buffer.from(res.text, 'utf8'), replacements: res.replacements, matchedKeys: res.matchedKeys };
    }
    return { buffer: null, replacements: 0, matchedKeys: [] };
  }

  if (norm.endsWith('.html') || norm.endsWith('.htm')) {
    const text = buffer.toString('utf8');
    const res = translateHtml(text, dict);
    if (res.replacements > 0) {
      return { buffer: Buffer.from(res.html, 'utf8'), replacements: res.replacements, matchedKeys: res.matchedKeys };
    }
    return { buffer: null, replacements: 0, matchedKeys: [] };
  }

  if (norm.endsWith('.js') || norm.endsWith('.mjs') || norm.endsWith('.cjs')) {
    // Пропускаем сторонние низкоуровневые библиотеки node_modules и тестовые моки
    if (norm.includes('/__mocks__/') || norm.includes('/test/')) {
      return { buffer: null, replacements: 0, matchedKeys: [] };
    }
    if (norm.includes('/node_modules/') && !/(antigravity|gemini|agent|chat|ui|workbench|exa|codeium|electron-updater)/.test(norm)) {
      return { buffer: null, replacements: 0, matchedKeys: [] };
    }
    const text = buffer.toString('utf8');
    const res = translateJavaScript(text, dict);
    const dynRes = applyElectronDynamicPatches(norm, res.code);
    const totalRep = res.replacements + dynRes.replacements;
    if (totalRep > 0) {
      return {
        buffer: Buffer.from(dynRes.code, 'utf8'),
        replacements: totalRep,
        matchedKeys: [...res.matchedKeys, ...dynRes.matchedKeys],
      };
    }
    return { buffer: null, replacements: 0, matchedKeys: [] };
  }

  return { buffer: null, replacements: 0, matchedKeys: [] };
}

/**
 * Сканер непереведённых человекочитаемых английских UI-строк (для обновления словаря под новые релизы Antigravity).
 * @param {string} content
 * @param {'js' | 'json' | 'html'} fileKind
 * @param {ReturnType<typeof import('./dictionary').loadDictionary>} dict
 * @returns {string[]}
 */
function extractUntranslatedCandidates(content, fileKind, dict) {
  const found = new Set();

  function looksLikeHumanUiText(s) {
    if (!s || s.length < 3 || s.length > 300) return false;
    if (dict.allEntries.has(s)) return false;
    if (/[\u0400-\u04FF]/.test(s)) return false; // Уже содержит кириллицу
    if (!/^[A-Z]/.test(s)) return false; // UI заголовки/кнопки начинаются с заглавной буквы
    if (/[{}[\];=<>\\|_*#$@^~`]/.test(s)) return false;
    if (/^(https?:|file:|data:|application\/|text\/|image\/)/.test(s)) return false;
    if (/^[A-Z0-9_.-]+$/.test(s)) return false; // КОНСТАНТЫ
    if (/^[A-Za-z0-9]+(?:\.[A-Za-z0-9]+)+$/.test(s)) return false; // идентификаторы a.b.c
    if (/^[A-Z][a-z]+(?:[A-Z][a-z0-9]+)+$/.test(s)) return false; // CamelCase идентификаторы классов
    // Требуем хотя бы одну прописную и строчные буквы, и предпочтительно пробел или UI-контекст
    return /[a-z]{2,}/.test(s);
  }

  if (fileKind === 'json') {
    try {
      const obj = JSON.parse(content);
      const visit = (v) => {
        if (typeof v === 'string') {
          if (looksLikeHumanUiText(v)) found.add(v);
        } else if (Array.isArray(v)) {
          v.forEach(visit);
        } else if (v && typeof v === 'object') {
          for (const [k, child] of Object.entries(v)) {
            if (k !== 'comment' && k !== '_comment') visit(child);
          }
        }
      };
      visit(obj);
    } catch {}
    return [...found];
  }

  // Для JS и HTML ищем явные UI-свойства (children, label, title, placeholder, tooltip, description и вложенные поля)
  const uiPropRegex = /(?:children|label|title|tooltip|tooltipText|placeholder|ariaLabel|"aria-label"|header|buttonText|description|text|summary|subtitle|heading|message|detail|emptyMessage)\s*:\s*(["'])([^"'\\\r\n]{3,300})\1/g;
  let match;
  while ((match = uiPropRegex.exec(content)) !== null) {
    const candidate = match[2];
    if (looksLikeHumanUiText(candidate)) {
      found.add(candidate);
    }
  }

  if (fileKind === 'html') {
    const htmlAttrRegex = /\b(?:placeholder|title|aria-label)\s*=\s*(["'])([^"'\r\n]{3,300})\1/gi;
    while ((match = htmlAttrRegex.exec(content)) !== null) {
      if (looksLikeHumanUiText(match[2])) found.add(match[2]);
    }
  }

  return [...found];
}

module.exports = {
  unescapeJsString,
  escapeJsString,
  translateJavaScript,
  translateNlsJson,
  translateHtml,
  isLocalizationJsonPath,
  translateFileBuffer,
  extractUntranslatedCandidates,
};
