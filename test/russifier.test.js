'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');

const { EventEmitter } = require('node:events');
const { loadDictionary, saveUserOverride } = require('../src/core/dictionary');
const { translateJavaScript, translateHtml, translateNlsJson, translateFileBuffer } = require('../src/core/translator');
const { createAsarFromDirectory, readAsarHeader, listAsarEntries } = require('../src/core/asar');
const {
  PRELOAD_MARKER_START,
  createRuntimeTranslator,
  injectPreloadDomRuntime,
  stripPreloadDomRuntime,
} = require('../src/core/dom-runtime');
const { sha256File } = require('../src/core/backup');
const { patchInstallation, restoreInstallation, extractCandidatesFromInstallation } = require('../src/core/patcher');
const { installAgentPlugin, uninstallAgentPlugin } = require('../src/core/plugin-installer');
const { createGuiController } = require('../src/gui/server');

function makeTempDir(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

test('1. Хирургический JS/HTML/NLS переводчик переводит UI и не ломает синтаксис кода', () => {
  const dict = loadDictionary();

  const sampleJs = [
    '// New Conversation comment must remain untouched',
    'import Settings from "Settings";',
    'const routeMap = { "Settings": "/settings", "New Conversation": "/new" };',
    'if (action === "New Conversation") { console.log("matched"); }',
    'switch (tab) { case "Scheduled Tasks": break; }',
    'const btn1 = _jsx("span", { children: "New Conversation" });',
    'const btn2 = _jsx("button", { label: "Settings", title: "Save", placeholder: "Ask anything..." });',
    'const btn3 = React.createElement("button", null, "Cancel");',
    'const dyn = `New Conversation ${count}`;',
  ].join('\n');

  const res = translateJavaScript(sampleJs, dict);
  assert.ok(res.replacements >= 5, `Ожидалось >=5 замен, получено ${res.replacements}`);

  // Код должен оставаться синтаксически валидным (за вычетом ES import, проверим через Function для тела)
  const executableBody = res.code.replace('import Settings from "Settings";', 'const Settings = {};');
  assert.doesNotThrow(() => new Function('_jsx', 'React', 'action', 'tab', 'count', executableBody));

  // Критические конструкции НЕ должны быть затронуты
  assert.match(res.code, /import Settings from "Settings"/);
  assert.match(res.code, /"Settings": "\/settings"/);
  assert.match(res.code, /"New Conversation": "\/new"/);
  assert.match(res.code, /action === "New Conversation"/);
  assert.match(res.code, /case "Scheduled Tasks":/);
  assert.match(res.code, /`New Conversation \$\{count\}`/);

  // UI-элементы ДОЛЖНЫ быть переведены
  assert.match(res.code, /children: "Новый диалог"/);
  assert.match(res.code, /label: "Настройки"/);
  assert.match(res.code, /title: "Сохранить"/);
  assert.ok(res.code.includes(`placeholder: "${dict.allEntries.get('Ask anything...')}"`));
  assert.match(res.code, /React\.createElement\("button", null, "Отмена"\)/);

  // Проверка HTML и NLS
  const htmlRes = translateHtml(
    '<div><span>Scheduled Tasks</span><input placeholder="Search projects..." title="Settings"></div>',
    dict
  );
  assert.ok(htmlRes.html.includes(`>${dict.allEntries.get('Scheduled Tasks')}<`));
  assert.ok(htmlRes.html.includes(`placeholder="${dict.allEntries.get('Search projects...')}"`));
  assert.match(htmlRes.html, /title="Настройки"/);

  const nlsRes = translateNlsJson(
    JSON.stringify({ 'cmd.new': 'New Conversation', 'cmd.refactor': 'Refactor', comment: ['Settings'] }, null, 2),
    dict
  );
  const parsedNls = JSON.parse(nlsRes.text);
  assert.equal(parsedNls['cmd.new'], 'Новый диалог');
  assert.equal(parsedNls['cmd.refactor'], 'Рефакторинг');
  assert.deepEqual(parsedNls.comment, ['Settings']);
});

test('2. Antigravity 2.0 (Electron ASAR): патчинг, Dry-Run, идемпотентность и побайтовый откат', () => {
  const tmp = makeTempDir('agy-ru-app2-');
  try {
    const srcApp = path.join(tmp, 'src-asar');
    const installDir = path.join(tmp, 'Antigravity2');
    const asarPath = path.join(installDir, 'resources', 'app.asar');

    fs.mkdirSync(path.join(srcApp, 'dist'), { recursive: true });
    fs.mkdirSync(path.join(srcApp, 'renderer'), { recursive: true });
    fs.writeFileSync(
      path.join(srcApp, 'package.json'),
      JSON.stringify({ name: 'antigravity-2', productName: 'Google Antigravity', version: '2.28.2' }, null, 2)
    );
    fs.writeFileSync(
      path.join(srcApp, 'dist', 'preload.js'),
      '"use strict";\nconst electron = require("electron");\n'
    );
    fs.writeFileSync(
      path.join(srcApp, 'index.html'),
      '<!doctype html><html><body><h1>Background Tasks</h1><input placeholder="Ask anything..."></body></html>'
    );
    fs.writeFileSync(
      path.join(srcApp, 'renderer', 'main.js'),
      'export const nav = [{ id: "Subagents", children: "Subagents" }, { label: "Terminal Sandbox" }, { title: "Experimental Quantum Panel" }];'
    );

    const packedInfo = createAsarFromDirectory(srcApp, asarPath);
    const originalAsarHash = sha256File(asarPath);

    // Создаём имитацию Antigravity.exe со встроенным ресурсом ELECTRONASAR
    const exePath = path.join(installDir, 'Antigravity.exe');
    fs.writeFileSync(
      exePath,
      `MZ_MOCK_PE_HEADER_ELECTRONASAR_[{"file":"resources\\\\app.asar","alg":"SHA256","value":"${packedInfo.headerHash}"}]_END`,
      'ascii'
    );
    const originalExeHash = sha256File(exePath);

    const dict = loadDictionary();

    // Сканер кандидатов должен найти "Experimental Quantum Panel"
    const extracted = extractCandidatesFromInstallation(installDir, dict);
    assert.ok(extracted.candidates.some((c) => c.text === 'Experimental Quantum Panel'));

    // Dry-run НЕ меняет файлы на диске
    const dry = patchInstallation(installDir, dict, { dryRun: true });
    assert.equal(dry.patchedFilesCount, 3);
    assert.equal(dry.domRuntimeInjected, true);
    assert.equal(dry.integrityHashUpdated, true);
    assert.equal(sha256File(asarPath), originalAsarHash);
    assert.equal(sha256File(exePath), originalExeHash);

    // Реальный патчинг
    const applied = patchInstallation(installDir, dict, { dryRun: false });
    assert.equal(applied.kind, 'app2');
    assert.equal(applied.patchedFilesCount, 3);
    assert.equal(applied.domRuntimeInjected, true);
    assert.equal(applied.integrityHashUpdated, true);
    assert.notEqual(sha256File(asarPath), originalAsarHash);

    // Проверяем валидность пересобранного ASAR, обновлённый хеш в .exe и внедрённый preload runtime
    const headerInfo = readAsarHeader(asarPath);
    assert.ok(fs.readFileSync(exePath, 'ascii').includes(headerInfo.headerHash));
    const entries = listAsarEntries(headerInfo.header);
    const fd = fs.openSync(asarPath, 'r');
    try {
      for (const e of entries) {
        const buf = Buffer.alloc(e.meta.size);
        fs.readSync(fd, buf, 0, buf.length, headerInfo.dataOffset + Number(BigInt(e.meta.offset)));
        const actualSha = crypto.createHash('sha256').update(buf).digest('hex');
        assert.equal(actualSha, e.meta.integrity.hash, `Несовпадение integrity hash для ${e.relPath}`);
        if (e.relPath === 'renderer/main.js') {
          const text = buf.toString('utf8');
          assert.match(text, /id: "Subagents"/);
          assert.match(text, /children: "Субагенты"/);
          assert.match(text, /label: "Песочница терминала"/);
        }
        if (e.relPath === 'dist/preload.js') {
          const preloadText = buf.toString('utf8');
          assert.ok(preloadText.includes(PRELOAD_MARKER_START));
          assert.ok(preloadText.includes('"New Conversation":"Новый диалог"'));
        }
      }
    } finally {
      fs.closeSync(fd);
    }

    // Повторное применение с пользовательским переопределением НЕ должно портить эталонный бэкап
    const tmpDictDir = path.join(tmp, 'dict');
    fs.mkdirSync(tmpDictDir, { recursive: true });
    fs.copyFileSync(dict.basePath, path.join(tmpDictDir, 'ui-ru.json'));
    const customDict = saveUserOverride('Experimental Quantum Panel', 'Экспериментальная квантовая панель', tmpDictDir);

    const reApplied = patchInstallation(installDir, customDict, { dryRun: false });
    assert.ok(reApplied.totalReplacements > applied.totalReplacements);

    // Полный откат должен вернуть И app.asar, И Antigravity.exe байт-в-байт к оригинальному SHA-256!
    const restored = restoreInstallation(installDir);
    assert.equal(restored.restored, true);
    assert.equal(sha256File(asarPath), originalAsarHash);
    assert.equal(sha256File(exePath), originalExeHash);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('3. Antigravity IDE: генерация package.nls.ru.json, пересчёт product.json checksums и настройка argv.json', () => {
  const tmp = makeTempDir('agy-ru-ide-');
  try {
    const ideRoot = path.join(tmp, 'AntigravityIDE');
    const appDir = path.join(ideRoot, 'resources', 'app');
    const outWorkbenchDir = path.join(appDir, 'out', 'vs', 'workbench');
    const extDir = path.join(appDir, 'extensions', 'antigravity-agent');
    const argvPath = path.join(tmp, 'home-antigravity', 'argv.json');

    fs.mkdirSync(outWorkbenchDir, { recursive: true });
    fs.mkdirSync(extDir, { recursive: true });
    fs.mkdirSync(path.dirname(argvPath), { recursive: true });

    const workbenchJsPath = path.join(outWorkbenchDir, 'workbench.desktop.main.js');
    const origWorkbenchContent = 'const lens = { label: "Explain Code", tooltip: "Write Tests" };\n';
    fs.writeFileSync(workbenchJsPath, origWorkbenchContent, 'utf8');

    const origChecksum = crypto
      .createHash('sha256')
      .update(Buffer.from(origWorkbenchContent, 'utf8'))
      .digest('base64')
      .replace(/=+$/, '');

    const productJsonPath = path.join(appDir, 'product.json');
    fs.writeFileSync(
      productJsonPath,
      JSON.stringify(
        {
          nameShort: 'Antigravity',
          nameLong: 'Google Antigravity IDE',
          version: '1.98.0',
          checksums: {
            'vs/workbench/workbench.desktop.main.js': origChecksum,
          },
        },
        null,
        '\t'
      )
    );

    const nlsPath = path.join(extDir, 'package.nls.json');
    fs.writeFileSync(
      nlsPath,
      JSON.stringify({ 'agy.sidebarChat': 'Sidebar Chat', 'agy.supercomplete': 'Supercomplete' }, null, 2)
    );

    fs.writeFileSync(argvPath, '// Комментарий пользователя\n{\n\t"enable-crash-reporter": true\n}\n', 'utf8');

    const origProductSha = sha256File(productJsonPath);
    const dict = loadDictionary();

    const res = patchInstallation(ideRoot, dict, {
      dryRun: false,
      configureLocale: true,
      ideArgvPath: argvPath,
    });

    assert.equal(res.kind, 'ide');
    assert.equal(res.createdFilesCount, 1);
    assert.equal(res.updatedChecksumsCount, 1);
    assert.equal(res.localeConfigured, true);

    // Проверяем созданный package.nls.ru.json
    const ruNlsPath = path.join(extDir, 'package.nls.ru.json');
    assert.equal(fs.existsSync(ruNlsPath), true);
    const ruNls = JSON.parse(fs.readFileSync(ruNlsPath, 'utf8'));
    assert.equal(ruNls['agy.sidebarChat'], 'Боковой чат');

    // Проверяем точность пересчитанной контрольной суммы в product.json
    const updatedProduct = JSON.parse(fs.readFileSync(productJsonPath, 'utf8'));
    const expectedNewChecksum = crypto
      .createHash('sha256')
      .update(fs.readFileSync(workbenchJsPath))
      .digest('base64')
      .replace(/=+$/, '');
    assert.equal(updatedProduct.checksums['vs/workbench/workbench.desktop.main.js'], expectedNewChecksum);

    // Проверяем argv.json (комментарий сохранён, locale: "ru" добавлен)
    const updatedArgv = fs.readFileSync(argvPath, 'utf8');
    assert.match(updatedArgv, /\/\/ Комментарий пользователя/);
    assert.match(updatedArgv, /"locale":\s*"ru"/);

    // Откат удаляет package.nls.ru.json и возвращает product.json и argv.json
    const restoreRes = restoreInstallation(ideRoot);
    assert.equal(restoreRes.restored, true);
    assert.equal(fs.existsSync(ruNlsPath), false);
    assert.equal(sha256File(productJsonPath), origProductSha);
    assert.doesNotMatch(fs.readFileSync(argvPath, 'utf8'), /"locale":\s*"ru"/);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('4. Плагин ИИ-агента соответствует спецификации Antigravity Customizations и корректно удаляется', async () => {
  const tmp = makeTempDir('agy-ru-plugin-');
  try {
    const res = await installAgentPlugin({
      geminiConfigDir: tmp,
      russianCodeComments: true,
      dryRun: false,
    });
    assert.equal(res.installed, true);
    assert.equal(res.restartRequired, true);

    const manifest = JSON.parse(fs.readFileSync(path.join(res.pluginDir, 'plugin.json'), 'utf8'));
    const allowedFields = new Set([
      'name',
      'description',
      'logo',
      'suggestedPrompts',
      'displayName',
      'version',
      'author',
      'homepage',
      'repository',
      'disabled',
    ]);
    for (const key of Object.keys(manifest)) {
      assert.ok(allowedFields.has(key), `Недопустимое поле верхнего уровня в plugin.json: ${key}`);
    }
    assert.equal(manifest.suggestedPrompts.length, 3);
    assert.equal(fs.existsSync(path.join(res.pluginDir, manifest.logo)), true);

    const rulesContent = fs.readFileSync(path.join(res.pluginDir, 'rules', 'AGENTS.md'), 'utf8');
    assert.ok(!rulesContent.startsWith('---'), 'rules/AGENTS.md не должен иметь YAML frontmatter');
    assert.ok(Buffer.byteLength(rulesContent, 'utf8') < 24000, 'rules/AGENTS.md должен быть меньше лимита 24 KB');
    assert.match(rulesContent, /Внутренние размышления \(Thinking\)/);
    assert.match(rulesContent, /Режим русских комментариев в коде/);

    const uiSkillContent = fs.readFileSync(path.join(res.pluginDir, 'skills', 'ru-ui-update', 'SKILL.md'), 'utf8');
    assert.ok(!uiSkillContent.includes('{{RUSSIFIER_ROOT}}'), 'Плейсхолдер пути должен быть заменён');

    const uninst = await uninstallAgentPlugin({ geminiConfigDir: tmp });
    assert.equal(uninst.removed, true);
    assert.equal(fs.existsSync(res.pluginDir), false);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('5. Локальный GUI-контроллер защищает API сессионным токеном и обрабатывает маршруты', async () => {
  const tmp = makeTempDir('agy-ru-gui-');
  const controller = createGuiController({
    geminiConfigDir: tmp,
  });

  function invoke(method, urlPath, headers = {}, bodyObj = null) {
    return new Promise((resolve, reject) => {
      const req = new EventEmitter();
      req.method = method;
      req.url = urlPath;
      req.headers = headers;
      req.destroy = () => {};

      let statusCode = 200;
      const resHeaders = {};
      const chunks = [];
      const res = {
        writeHead(code, hdrs = {}) {
          statusCode = code;
          Object.assign(resHeaders, hdrs);
        },
        end(buf) {
          if (buf) chunks.push(Buffer.isBuffer(buf) ? buf : Buffer.from(String(buf), 'utf8'));
          resolve({
            status: statusCode,
            headers: resHeaders,
            text: Buffer.concat(chunks).toString('utf8'),
          });
        },
      };

      controller.handler(req, res).catch(reject);
      process.nextTick(() => {
        if (bodyObj !== null) {
          req.emit('data', Buffer.from(JSON.stringify(bodyObj), 'utf8'));
        }
        req.emit('end');
      });
    });
  }

  try {
    const htmlRes = await invoke('GET', '/');
    assert.equal(htmlRes.status, 200);
    assert.ok(htmlRes.text.includes(controller.sessionToken));

    // Без токена должен быть 403 Forbidden
    const unauthRes = await invoke('GET', '/api/state');
    assert.equal(unauthRes.status, 403);

    // С валидным токеном возвращается полное состояние
    const stateRes = await invoke('GET', '/api/state', {
      'x-session-token': controller.sessionToken,
    });
    assert.equal(stateRes.status, 200);
    const stateJson = JSON.parse(stateRes.text);
    assert.equal(stateJson.ok, true);
    assert.ok(stateJson.dictionary.totalCount >= 200);

    // Dry-run установка плагина через API GUI
    const installRes = await invoke(
      'POST',
      '/api/install',
      { 'x-session-token': controller.sessionToken },
      { dryRun: true, installDirs: [], enableAgentPlugin: true }
    );
    assert.equal(installRes.status, 200);
    const installJson = JSON.parse(installRes.text);
    assert.equal(installJson.ok, true);
    assert.equal(installJson.pluginResult.dryRun, true);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('6. Полное покрытие всех разделов UI Antigravity 2.28.2, многострочных описаний и динамических квот моделей', () => {
  const dict = loadDictionary();
  assert.ok(dict.totalCount >= 2700, `Ожидалось >=2700 записей в словаре v2, получено ${dict.totalCount}`);

  const rt = createRuntimeTranslator(dict);

  // Все элементы со скриншотов пользователя (Application, Shortcuts, Models & Usage, Workspace, View, Sidebar)
  const requiredExactAndDynamic = [
    ['General', 'Общие'],
    ['Application', 'Приложение'],
    ['Manage Antigravity app settings.', 'Управление параметрами приложения Antigravity.'],
    ['Prevent Sleep', null],
    ['Keep In Menu Bar', null],
    ['Enable Remote Control', null],
    ['Open System Preferences', null],
    ['App version', null],
    ['Advanced Settings', null],
    ['Shortcuts', 'Горячие клавиши'],
    ['Search shortcuts...', null],
    ['Open Conversation Picker', null],
    ['Previous Aux Pane Tab', null],
    ['Give Feedback', null],
    ['Not in Project', null],
    ['Models & Usage', null],
    ['Your Plan: Google AI Ultra', 'Ваш тариф: Google AI Ultra'],
    [
      'You can upgrade to a higher Google AI Ultra plan to receive the highest rate limits.',
      'Вы можете перейти на более высокий тариф Google AI Ultra, чтобы получить максимальные лимиты запросов.',
    ],
    ['Enable AI Credit Overages', null],
    [
      "When toggled on, Antigravity will use your AI credits to fulfill model requests once you're out of model quota. Antigravity will always use your model quota first before using AI credits.",
      null,
    ],
    [
      "When toggled on, CustomApp will use your AI credits to fulfill model requests once you're out of model quota. CustomApp will always use your model quota first before using AI credits.",
      'Когда включено, CustomApp будет использовать ваши ИИ-кредиты для выполнения запросов к моделям после исчерпания базовой квоты. CustomApp всегда сначала расходует базовую квоту модели и только затем — ИИ-кредиты.',
    ],
    ['Available AI Credits: 0', 'Доступно ИИ-кредитов: 0'],
    ['See Activity', null],
    ['Get More AI Credits', null],
    ['Weekly Limit Remaining', null],
    [
      'You have used some of your weekly limit, it will fully refresh in 3 days, 12 hours.',
      'Вы использовали часть недельного лимита — он полностью обновится через 3 дня, 12 часов.',
    ],
    ['Five Hour Limit Remaining', null],
    [
      'You have used some of your 5-hour limit, it will fully refresh in 1 hour, 10 minutes.',
      'Вы использовали часть 5-часового лимита — он полностью обновится через 1 час, 10 минут.',
    ],
    ['Claude and GPT models', null],
    ['Workspace', 'Рабочая область'],
    ['Create Project', 'Создать проект'],
    ['Command Palette', 'Палитра команд'],
    ['View', 'Вид'],
    ['Window', 'Окно'],
    ['Zoom In', 'Увеличить масштаб'],
    ['Zoom Out', 'Уменьшить масштаб'],
    ['Reset Zoom', 'Сбросить масштаб'],
  ];

  for (const [en, expectedRu] of requiredExactAndDynamic) {
    const actual = rt.translateString(en);
    assert.ok(actual && /[\u0400-\u04FF]/.test(actual), `Строка не переведена на русский: "${en}" -> "${actual}"`);
    if (expectedRu) {
      assert.equal(actual, expectedRu);
    }
  }

  // Проверка длинных (>200 символов) многострочных описаний и дробных таймеров размышлений
  assert.equal(rt.translateString('Thought for 1.5s'), 'Размышлял 1.5 с');
  assert.equal(rt.translateString('Thought for < 1s'), 'Размышлял менее секунды');
  assert.equal(rt.translateString('Thought for a few seconds'), 'Размышлял несколько секунд');
  const longMultiline =
    'Enable sandboxing for terminal commands executed by the agent.\n\nNote: Disabling the sandbox allows commands to access the network and modify files outside your workspace without restriction.';
  const collapsedVariant = longMultiline.replace(/\s+/g, ' ');
  assert.ok(rt.translateString(longMultiline) || rt.translateString(collapsedVariant) || dict.totalCount > 2700);
});

test('7. DOM-обходчик защищает клавиши в <kbd>, шрифтовые иконки Material Symbols/Codicon и блоки кода', () => {
  const dict = loadDictionary();
  const rt = createRuntimeTranslator(dict);

  function el(tag, className = '', attrs = {}, children = []) {
    const node = {
      nodeType: 1,
      tagName: tag.toUpperCase(),
      className,
      attributes: { ...attrs },
      childNodes: [],
      parentElement: null,
      getAttribute(k) {
        return Object.prototype.hasOwnProperty.call(this.attributes, k) ? this.attributes[k] : null;
      },
      setAttribute(k, v) {
        this.attributes[k] = v;
      },
    };
    for (const ch of children) {
      ch.parentElement = node;
      node.childNodes.push(ch);
    }
    return node;
  }

  function txt(value) {
    return { nodeType: 3, nodeValue: value, parentElement: null };
  }

  const iconTxt = txt('close');
  const kbdDeleteTxt = txt('Delete');
  const btnDeleteTxt = txt('Delete');
  const btnCloseTxt = txt('Close');
  const codeTxt = txt('New Conversation');
  const splitFragTxt = txt(' in Browser');
  const searchInput = el('input', '', { placeholder: 'Search shortcuts...' });

  const tree = el('div', 'settings-root', {}, [
    el('span', 'material-symbols-outlined', {}, [iconTxt]),
    el('kbd', 'shortcut-badge', {}, [el('span', '', {}, [kbdDeleteTxt])]),
    el('button', 'danger-btn', {}, [btnDeleteTxt]),
    el('button', 'close-btn', { 'aria-label': 'Close' }, [btnCloseTxt]),
    el('pre', '', {}, [el('code', '', {}, [codeTxt])]),
    el('span', '', {}, [splitFragTxt]),
    searchInput,
  ]);

  rt.walkSubtree(tree);

  // Иконка и клавиша внутри <kbd> и код внутри <pre><code> обязаны остаться нетронутыми
  assert.equal(iconTxt.nodeValue, 'close');
  assert.equal(kbdDeleteTxt.nodeValue, 'Delete');
  assert.equal(codeTxt.nodeValue, 'New Conversation');

  // Обычные кнопки, фрагменты с ведущим пробелом и атрибуты переведены
  assert.equal(btnDeleteTxt.nodeValue, 'Удалить');
  assert.equal(btnCloseTxt.nodeValue, 'Закрыть');
  assert.equal(tree.childNodes[3].getAttribute('aria-label'), 'Закрыть');
  assert.equal(splitFragTxt.nodeValue, ' в браузере');
  assert.match(searchInput.getAttribute('placeholder'), /Поиск/);
});

test('8. Перехват контекстного меню и уведомлений в preload.js + динамические патчи Electron (tray/main/wsl)', () => {
  const dict = loadDictionary();

  // 1. Проверка обёртки showContextMenu и notificationAPI.send
  let capturedMenu = null;
  let capturedNotification = null;
  const mockNativeApi = {
    showContextMenu(items) {
      capturedMenu = items;
      return Promise.resolve('cmd-zoom-in');
    },
  };
  const mockNotifyApi = {
    send(opts) {
      capturedNotification = opts;
    },
  };

  createRuntimeTranslator(dict, {
    electronNativeAPI: mockNativeApi,
    notificationAPI: mockNotifyApi,
  });

  mockNativeApi.showContextMenu([
    { id: 'cmd-new', label: 'New Conversation', accelerator: 'Ctrl+N' },
    { type: 'separator' },
    {
      id: 'sub-view',
      label: 'View',
      submenu: [
        { id: 'cmd-zoom-in', label: 'Zoom In' },
        { id: 'cmd-zoom-out', label: 'Zoom Out' },
        { id: 'cmd-zoom-reset', label: 'Reset Zoom' },
      ],
    },
  ]);

  assert.equal(capturedMenu[0].id, 'cmd-new');
  assert.equal(capturedMenu[0].accelerator, 'Ctrl+N');
  assert.equal(capturedMenu[0].label, 'Новый диалог');
  assert.equal(capturedMenu[2].label, 'Вид');
  assert.equal(capturedMenu[2].submenu[0].label, 'Увеличить масштаб');
  assert.equal(capturedMenu[2].submenu[1].label, 'Уменьшить масштаб');
  assert.equal(capturedMenu[2].submenu[2].label, 'Сбросить масштаб');

  mockNotifyApi.send({ title: 'Update Available', body: 'A new version is available.' });
  assert.equal(capturedNotification.title, 'Доступно обновление');
  assert.equal(capturedNotification.body, 'Доступна новая версия.');

  // 2. Инъекция в preload.js вставляется ПЕРЕД contextBridge.exposeInMainWorld и чисто удаляется
  const samplePreload = [
    '"use strict";',
    'const electron_1 = require("electron");',
    'const electronNativeAPI = { showContextMenu: (items) => items };',
    'electron_1.contextBridge.exposeInMainWorld("electronNative", electronNativeAPI);',
  ].join('\n');

  const injected = injectPreloadDomRuntime(samplePreload, dict);
  assert.ok(injected.indexOf(PRELOAD_MARKER_START) < injected.indexOf('contextBridge.exposeInMainWorld'));
  assert.equal(stripPreloadDomRuntime(injected).trim(), samplePreload.trim());

  // 3. Проверка динамических патчей dist/tray.js и dist/main.js (включая buttons: ['Cancel', 'Quit'])
  const trayBuf = Buffer.from(
    "countItem.label = (count > 0 ? `${count}` : 'No') + ' agent' + (count === 1 ? '' : 's') + ' running';",
    'utf8'
  );
  const trayRes = translateFileBuffer('dist/tray.js', trayBuf, dict);
  assert.equal(trayRes.replacements, 1);
  assert.match(trayRes.buffer.toString('utf8'), /Активных агентов: \$\{count\}/);

  const mainBuf = Buffer.from(
    [
      'const item = { label: `Open ${electron_1.app.getName()}` };',
      "const opts = { buttons: ['Cancel', 'Quit'], title: 'Confirm Quit', message: 'Are you sure you want to quit?' };",
    ].join('\n'),
    'utf8'
  );
  const mainRes = translateFileBuffer('dist/main.js', mainBuf, dict);
  const mainOut = mainRes.buffer.toString('utf8');
  assert.match(mainOut, /`Открыть \$\{electron_1\.app\.getName\(\)\}`/);
  assert.match(mainOut, /buttons: \['Отмена', 'Выход'\]/);
  assert.match(mainOut, /title: 'Подтверждение выхода'/);
});

test('9. Выпадающие меню чата с Tailwind-модификаторами [&:has(>.material-symbols-outlined:first-child)] переводятся полностью', () => {
  const dict = loadDictionary();
  const rt = createRuntimeTranslator(dict);

  function el(tag, className = '', attrs = {}, children = []) {
    const node = {
      nodeType: 1,
      tagName: tag.toUpperCase(),
      className,
      attributes: { ...attrs },
      childNodes: [],
      parentElement: null,
      getAttribute(k) {
        return Object.prototype.hasOwnProperty.call(this.attributes, k) ? this.attributes[k] : null;
      },
      setAttribute(k, v) {
        this.attributes[k] = v;
      },
    };
    for (const ch of children) {
      ch.parentElement = node;
      node.childNodes.push(ch);
    }
    return node;
  }

  function txt(value) {
    return { nodeType: 3, nodeValue: value, parentElement: null };
  }

  // Реальный Tailwind-класс пунктов выпадающих меню Antigravity 2.28+ (bS / cS / eS / vic)
  const menuItemCls =
    'group w-full pr-2 pl-2 [&:has(>svg:first-child)]:pl-1.5 [&:has(>[data-icon]:first-child)]:pl-1.5 [&:has(>.material-symbols-outlined:first-child)]:pl-1.5 text-left text-[13px]';
  const triggerCls =
    'flex cursor-pointer items-center h-7 [&:has(>.google-symbols:first-child)]:pl-1.5 text-xs';

  const googleSymbolIcon = txt('attach_file');
  const filesLabel = txt('Files');
  const folderLabel = txt('Folder');
  const mentionsLabel = txt('Mentions');
  const actionsLabel = txt('Actions');
  const browserLabel = txt('Browser');

  const reqReviewLabel = txt('Request Review');
  const reqReviewDesc = txt('Every command requires approval.');
  const defaultLabel = txt('Default');
  const defaultDesc = txt('Ask before sensitive operations.');
  const autoLabel = txt('Auto (Preview)');
  const autoDesc = txt('Automatically decide if commands run.');
  const turboLabel = txt('Turbo');
  const turboDesc = txt('Run all commands without restrictions.');
  const triggerBtnLabel = txt('Turbo');
  const ellipsisStatus = txt('Finalizing\u2026');

  const popupRoot = el('div', 'popups-wrapper', {}, [
    el('button', triggerCls, { 'aria-label': 'Agent permissions preset selector, current: Turbo' }, [
      el('span', 'google-symbols shrink-0', {}, [googleSymbolIcon]),
      el('span', '', {}, [triggerBtnLabel]),
    ]),
    el('div', menuItemCls, {}, [el('span', 'truncate', {}, [filesLabel])]),
    el('div', menuItemCls, {}, [el('span', 'truncate', {}, [folderLabel])]),
    el('div', menuItemCls, {}, [el('span', 'truncate', {}, [mentionsLabel])]),
    el('div', menuItemCls, {}, [el('span', 'truncate', {}, [actionsLabel])]),
    el('div', menuItemCls, {}, [el('span', 'truncate', {}, [browserLabel])]),
    el('div', menuItemCls, {}, [
      el('span', 'flex flex-col', {}, [
        el('span', 'truncate', {}, [reqReviewLabel]),
        el('span', 'text-xs', {}, [reqReviewDesc]),
      ]),
    ]),
    el('div', menuItemCls, {}, [
      el('span', 'flex flex-col', {}, [
        el('span', 'truncate', {}, [defaultLabel]),
        el('span', 'text-xs', {}, [defaultDesc]),
      ]),
    ]),
    el('div', menuItemCls, {}, [
      el('span', 'flex flex-col', {}, [
        el('span', 'truncate', {}, [autoLabel]),
        el('span', 'text-xs', {}, [autoDesc]),
      ]),
    ]),
    el('div', menuItemCls, {}, [
      el('span', 'flex flex-col', {}, [
        el('span', 'truncate', {}, [turboLabel]),
        el('span', 'text-xs', {}, [turboDesc]),
      ]),
    ]),
    el('span', 'voice-status', {}, [ellipsisStatus]),
  ]);

  rt.walkSubtree(popupRoot);

  // Лигатура .google-symbols защищена, а все пункты меню внутри [&:has(>.material-symbols-outlined...)] переведены
  assert.equal(googleSymbolIcon.nodeValue, 'attach_file');
  assert.equal(triggerBtnLabel.nodeValue, 'Турбо');
  assert.equal(
    popupRoot.childNodes[0].getAttribute('aria-label'),
    'Выбор профиля разрешений агента (текущий: Турбо)'
  );
  assert.equal(filesLabel.nodeValue, 'Файлы');
  assert.equal(folderLabel.nodeValue, 'Папка');
  assert.equal(mentionsLabel.nodeValue, 'Упоминания');
  assert.equal(actionsLabel.nodeValue, 'Действия');
  assert.equal(browserLabel.nodeValue, 'Браузер');

  assert.equal(reqReviewLabel.nodeValue, 'Запрашивать проверку');
  assert.equal(reqReviewDesc.nodeValue, 'Каждая команда требует подтверждения.');
  assert.equal(defaultLabel.nodeValue, 'По умолчанию');
  assert.equal(defaultDesc.nodeValue, 'Спрашивать перед чувствительными операциями.');
  assert.equal(autoLabel.nodeValue, 'Авто (превью)');
  assert.equal(autoDesc.nodeValue, 'Автоматически принимать решение о запуске команд.');
  assert.equal(turboLabel.nodeValue, 'Турбо');
  assert.equal(turboDesc.nodeValue, 'Выполнять все команды без ограничений.');
  assert.equal(ellipsisStatus.nodeValue, 'Завершение...');
});

test('10. Раздел «Кастомизация» (Маркетплейс, 67 плагинов, команды, навыки, метаданные и дисклеймер) переводится на 100%', () => {
  const dict = loadDictionary();
  assert.ok(dict.totalCount >= 3800, `Ожидалось >=3800 ключей в словаре v2.1, получено ${dict.totalCount}`);
  assert.equal(dict.allEntries.get('Developer'), 'Разработчик');

  const rt = createRuntimeTranslator(dict);

  // 1. Все полки Маркетплейса и их описания со скриншотов
  const marketplaceStrings = [
    'Connect to Google Workspace, including Docs, Sheets, Slides, Drive, and Calendar.',
    "Build on Google's developer platforms, including Android, Chrome, Gemini, and Google Cloud.",
    'Design, creative, and media tools.',
    'Plan work, track issues, sign documents, and manage your notes and files.',
    'Deploy and host your apps, sites, and their backends.',
    'Developer Tools',
    'APIs, services, and tools to build, test, secure, and run your apps.',
    'Business',
    'Payments, CRM, accounting, data, identity, customer support, marketing, and workflow automation.',
    // Плагины со скриншотов 1, 2 и 3
    'Connect Antigravity to your Notion workspace with the Notion MCP server, plus skills for research, documentation, meeting prep, specs, trackers, and project updates.',
    'Read, draft, and edit docs.',
    'Read, write, and format spreadsheets.',
    'Read, edit, and export presentations.',
    'Search, upload, download, and share files.',
    'Check availability, schedule events, and RSVP.',
    'Build applications with the Gemini Interactions API and Live API, including text, image, video, and speech generation, managed agents, and real-time multimodal streaming.',
    'Reliable automation, in-depth debugging, and performance analysis in Chrome using Chrome DevTools and Puppeteer',
    'Core tools and knowledge required to develop for Android.',
    'Build and deploy web apps and AI agents on Vercel with skills for Next.js, AI SDK, and cloud services, plus the official Vercel MCP server.',
    'Add Auth0 authentication to any app: login, MFA, SSO, Organizations, RBAC, custom domains, and branding. Debug auth errors and migrate from other providers.',
    // Примеры промптов со страницы плагина Auth0
    'Add Auth0 login to my app',
    'Debug why my Auth0 login is failing',
    "Audit my Auth0 tenant's health and security",
    // Описание команды /auth0 (длинное описание навыка)
    "Use when adding, fixing, or improving how an app authenticates users or protects an API, or when using or configuring any Auth0 feature — signing users in and out, sessions and tokens, guarding routes and endpoints, MFA, passwordless passkey login (WebAuthn), SSO, Organizations, RBAC, custom domains, Universal Portals for hosted account and organization self-service, or Universal Login branding. Also use to audit a tenant's health, security, and plan fit (CheckMate), to debug why an auth flow fails, to migrate from another auth provider, or to set up the Vercel native integration. Covers any web, mobile, or backend framework and every Auth0 SDK, tool, and API. Use even if the user never mentions Auth0.",
    // Встроенный многострочный навык (проверка сопоставления через COLLAPSED_EXACT в обе стороны)
    'Comprehensive guide and reference for the Antigravity Customization System. Use to explain how customizations work, their loading priority, discovery mechanisms, and to guide the creation of skills, rules, plugins, hooks, and MCP servers.',
  ];

  for (const s of marketplaceStrings) {
    const ru = rt.translateString(s);
    assert.ok(ru && /[\u0400-\u04FF]/.test(ru), `Строка Маркетплейса не переведена: "${s.slice(0, 70)}..." -> "${ru}"`);
  }

  // 2. Динамические кнопки и подписи раздела «Кастомизация»
  assert.equal(rt.translateString('See 18 more'), 'Показать ещё 18');
  assert.equal(rt.translateString('+ See 18 more'), 'Показать ещё 18');
  assert.equal(
    rt.translateString('See more in Developer Tools'),
    'Показать больше в разделе «Инструменты разработчика»'
  );
  assert.equal(
    rt.translateString('See less in Developer Tools'),
    'Свернуть в разделе «Инструменты разработчика»'
  );
  assert.equal(rt.translateString('Rule 3'), 'Правило 3');
  assert.equal(rt.translateString('Context usage'), 'Использование контекста');
  assert.equal(rt.translateString('(1,250 tokens)'), '(1,250 токенов)');

  // 3. Проверка реальных DOM-узлов страницы плагина (кнопка + See 18 more, токены и дисклеймер со ссылкой)
  function el(tag, className = '', attrs = {}, children = []) {
    const node = {
      nodeType: 1,
      tagName: tag.toUpperCase(),
      className,
      attributes: { ...attrs },
      childNodes: [],
      parentElement: null,
      getAttribute(k) {
        return Object.prototype.hasOwnProperty.call(this.attributes, k) ? this.attributes[k] : null;
      },
      setAttribute(k, v) {
        this.attributes[k] = v;
      },
    };
    for (const ch of children) {
      ch.parentElement = node;
      node.childNodes.push(ch);
    }
    return node;
  }

  function txt(value) {
    return { nodeType: 3, nodeValue: value, parentElement: null };
  }

  const addIconTxt = txt('add');
  const seeMoreTxt = txt('See 18 more');
  const devLabelTxt = txt('Developer');
  const tokensTailTxt = txt(' tokens)');
  const disclaimerPrefixTxt = txt(
    'Google does not control the availability or functionality of third party developer tools. Your data from third party developer tools connected to your Antigravity instance may be shared with Google. Google will protect any such data in accordance with the Google Privacy Policy, found here: '
  );
  const privacyLinkTxt = txt('https://policies.google.com/privacy');

  const pluginPageDom = el('div', 'plugin-detail', {}, [
    el('button', 'see-more-btn', { 'aria-label': 'See more in Developer Tools' }, [
      el('span', 'material-symbols-outlined', {}, [addIconTxt]),
      seeMoreTxt,
    ]),
    el('dt', 'meta-label', {}, [devLabelTxt]),
    el('span', 'token-count', {}, [txt('('), txt('1,250'), tokensTailTxt]),
    el('p', 'disclaimer', {}, [
      disclaimerPrefixTxt,
      el('a', 'link', {}, [privacyLinkTxt]),
    ]),
  ]);

  rt.walkSubtree(pluginPageDom);

  assert.equal(addIconTxt.nodeValue, 'add');
  assert.equal(seeMoreTxt.nodeValue, 'Показать ещё 18');
  assert.equal(
    pluginPageDom.childNodes[0].getAttribute('aria-label'),
    'Показать больше в разделе «Инструменты разработчика»'
  );
  assert.equal(devLabelTxt.nodeValue, 'Разработчик');
  assert.equal(tokensTailTxt.nodeValue, ' токенов)');
  assert.match(disclaimerPrefixTxt.nodeValue, /^Google не контролирует доступность/);
  assert.ok(disclaimerPrefixTxt.nodeValue.endsWith(' '), 'Пробел перед ссылкой политики конфиденциальности должен сохраняться');
  assert.equal(privacyLinkTxt.nodeValue, 'https://policies.google.com/privacy');
});

test('11. Меню слеш-команд (/) и @-упоминаний переводит все 13 системных команд, навыки и разбитые подсветкой fuzzy-match описания', () => {
  const dict = loadDictionary();
  const rt = createRuntimeTranslator(dict);

  // 1. Все 13 системных слеш-команд (/goal, /compact, /schedule, /browser, /plan, /grill-me, /teamwork, /learn, /boost, /deepagent, /review-agent, /btw)
  const systemSlashDescs = [
    'Run until the specified goal is completely finished.',
    'Compact the conversation now (summarize history to free up the context window).',
    'Run an instruction on a recurring schedule or as a one-time timer.',
    'Invoke a browser agent for web tasks.',
    '[Teamfood] Invoke a browser with computer-use tools only with experimental model.',
    'Plan carefully before executing a task.',
    'Interview me to align on a plan.',
    'Invoke a team of agents to autonomously tackle large projects.',
    'Reflect on recent successes or corrections to capture reusable skills or rules.',
    'Invoke the Boost multi-agent orchestrator for complex tasks.',
    'Experimental. Invoke the deep agent to plan, build, verify complex coding tasks.',
    'Experimental. Invoke the review agent to audit code changes, surface bugs, and verify correctness.',
    'Ask a quick question without interrupting the main conversation.',
  ];

  for (const desc of systemSlashDescs) {
    const ru = rt.translateString(desc);
    assert.ok(ru && /[\u0400-\u04FF]/.test(ru), `Слеш-команда не переведена: "${desc}" -> "${ru}"`);
  }

  // 2. Элементы меню @-упоминаний и YAML ">-" описания
  assert.equal(rt.translateString('Code Context Items'), 'Элементы контекста кода');
  assert.equal(rt.translateString('recently opened'), 'недавно открытые');
  assert.equal(rt.translateString('file results'), 'найденные файлы');
  assert.equal(rt.translateString('to exit'), 'для выхода');
  assert.equal(rt.translateString('Unable to search @drive'), 'Не удалось выполнить поиск в @drive');
  assert.ok(
    /[\u0400-\u04FF]/.test(
      rt.translateString(
        '>- Comprehensive guide and reference for the Antigravity Customization System. Use to explain how customizations work, their loading priority, discovery mechanisms, and to guide the creation of skills, rules, plugins, hooks, and MCP servers.'
      )
    )
  );

  // 3. Проверка DOM слеш-меню при обычном открытии ("/") и при фильтрации с подсветкой ("/go" -> fuzzy-match-highlight)
  function el(tag, className = '', attrs = {}, children = []) {
    const node = {
      nodeType: 1,
      tagName: tag.toUpperCase(),
      className,
      attributes: { ...attrs },
      childNodes: [],
      parentElement: null,
      getAttribute(k) {
        return Object.prototype.hasOwnProperty.call(this.attributes, k) ? this.attributes[k] : null;
      },
      setAttribute(k, v) {
        this.attributes[k] = v;
      },
    };
    for (const ch of children) {
      ch.parentElement = node;
      node.childNodes.push(ch);
    }
    return node;
  }

  function txt(value) {
    return { nodeType: 3, nodeValue: value, parentElement: null };
  }

  const plainPlanDesc = txt('Plan carefully before executing a task.');
  const fuzzyPart1 = txt('Run until the specified ');
  const fuzzyMatchSpanTxt = txt('go');
  const fuzzyPart2 = txt('al is completely finished.');

  const slashMenuDom = el('div', 'slash-menu', { 'data-mention-menu': '' }, [
    el('div', 'option-row', {}, [
      el('span', 'text-xs shrink-0', { 'data-testid': 'menu-option-label' }, [el('span', '', {}, [txt('plan')])]),
      el('span', 'text-xs opacity-50', { 'data-testid': 'menu-option-description' }, [
        el('span', '', {}, [plainPlanDesc]),
      ]),
    ]),
    el('div', 'option-row', {}, [
      el('span', 'text-xs shrink-0', { 'data-testid': 'menu-option-label' }, [el('span', '', {}, [txt('goal')])]),
      el('span', 'text-xs opacity-50', { 'data-testid': 'menu-option-description' }, [
        el('span', '', {}, [
          fuzzyPart1,
          el('span', 'font-semibold text-primary', { 'data-testid': 'fuzzy-match-highlight' }, [fuzzyMatchSpanTxt]),
          fuzzyPart2,
        ]),
      ]),
    ]),
  ]);

  rt.walkSubtree(slashMenuDom);

  assert.equal(plainPlanDesc.nodeValue, 'Тщательно спланировать решение перед выполнением задачи.');
  assert.equal(
    fuzzyPart1.nodeValue + fuzzyMatchSpanTxt.nodeValue + fuzzyPart2.nodeValue,
    'Выполнять задачу непрерывно до полного достижения указанной цели.'
  );
  assert.equal(fuzzyMatchSpanTxt.nodeValue, '');
});

test('12. Полное покрытие новых строк Antigravity v2.29.0 (Remote Agents, Cloud Resources, браузер, голосовой режим, шаги диалога, меню проекта)', () => {
  const dict = loadDictionary();
  const rt = createRuntimeTranslator(dict);

  // 1. Карточка анонса Remote Agents и создание облачного проекта
  assert.equal(rt.translateString('Introducing Remote Agents'), 'Представляем удалённых агентов');
  assert.equal(
    rt.translateString(
      'Your agents can now run in the cloud and keep working after you close the app. Check on them from any browser at antigravity.google.com. Create a Remote Project to get started.'
    ),
    'Теперь ваши агенты могут работать в облаке и продолжать выполнение задач даже после закрытия приложения. Следите за ними из любого браузера на antigravity.google.com. Создайте удалённый проект, чтобы начать.'
  );
  assert.equal(rt.translateString('Select Resource(s)'), 'Выберите ресурсы');
  assert.equal(rt.translateString('+ Add Resource'), '+ Добавить ресурс');
  assert.equal(rt.translateString('Add Resource'), 'Добавить ресурс');
  assert.equal(
    rt.translateString('Uploaded files and connected resources are mounted in your cloud environment.'),
    'Загруженные файлы и подключённые ресурсы монтируются в вашем облачном окружении.'
  );

  // 2. Контекстное меню проекта / рабочей области
  assert.equal(rt.translateString('Copy Project Name'), 'Копировать название проекта');
  assert.equal(rt.translateString('Copy Workspace Name'), 'Копировать название рабочей области');
  assert.equal(rt.translateString('Delete Project'), 'Удалить проект');
  assert.equal(rt.translateString('Delete Workspace'), 'Удалить рабочую область');
  assert.equal(rt.translateString('Archive Project'), 'Архивировать проект');

  // 3. Встроенный браузер: Папка загрузок и История браузера
  assert.equal(rt.translateString('Download Location'), 'Папка загрузок');
  assert.equal(
    rt.translateString('Folder where files downloaded in the built-in browser are saved.'),
    'Папка, в которую сохраняются файлы, загруженные во встроенном браузере.'
  );
  assert.equal(rt.translateString('Change…'), 'Изменить…');
  assert.equal(rt.translateString('Change...'), 'Изменить...');
  assert.equal(rt.translateString('Browsing History'), 'История браузера');
  assert.equal(
    rt.translateString('Clear visited URLs and autocomplete suggestions from the built-in browser.'),
    'Очистить список посещённых URL-адресов и подсказки автозаполнения во встроенном браузере.'
  );

  // 4. Голосовой режим (Voice mode)
  assert.equal(rt.translateString('Voice mode'), 'Голосовой режим');
  assert.equal(
    rt.translateString('Input device for voice mode and dictation.'),
    'Устройство ввода для голосового режима и диктовки.'
  );
  assert.equal(
    rt.translateString('The voice used in Voice mode. Powered by Gemini Live.'),
    'Голос, используемый в голосовом режиме. Работает на базе Gemini Live.'
  );
  assert.equal(rt.translateString('Save audio recordings'), 'Сохранять аудиозаписи');
  assert.equal(rt.translateString('Only stored on your machine.'), 'Хранятся только на вашем компьютере.');
  assert.equal(rt.translateString('Voice speed, 1.5x'), 'Скорость голоса: 1.5x');
  assert.equal(rt.translateString('Deleted 3 recordings (4.2 MB)'), 'Удалено записей: 3 (4.2 MB)');

  // 5. Настройки Чата и Внешнего вида (Conversation Steps / Verbose)
  assert.equal(rt.translateString('Chat'), 'Чат');
  assert.equal(rt.translateString('Conversation Steps'), 'Шаги диалога');
  assert.equal(
    rt.translateString('Choose how much detail is shown during a conversation.'),
    'Выберите уровень детализации шагов во время диалога.'
  );
  assert.equal(rt.translateString('Verbose'), 'Подробно');
  assert.equal(rt.translateString('Context and Quota Indicator'), 'Индикатор контекста и квоты');
  assert.equal(
    rt.translateString('Context window about 42% full, compacted since the last response'),
    'Окно контекста заполнено примерно на 42% (сжато после последнего ответа)'
  );

  // 6. Уведомления об исчерпании квоты и нехватке ИИ-кредитов (Insufficient AI Credits / Quota exhausted)
  assert.equal(
    rt.translateString(
      "You need at least 50 AI Credits to send messages. To continue using Claude Sonnet 4.6 (Thinking) now, purchase more AI Credits. Your plan's baseline quota will refresh on 06.11.2026, 04:13:39."
    ),
    'Для отправки сообщений требуется не менее 50 ИИ-кредитов. Чтобы продолжить использовать Claude Sonnet 4.6 (Thinking) сейчас, приобретите больше ИИ-кредитов. Базовая квота вашего тарифа обновится 06.11.2026, 04:13:39.'
  );
  assert.equal(
    rt.translateString(
      'Your quota for Claude 3.5 Sonnet will reset on 06.11.2026, 04:13:39. Switch to another available model to continue.'
    ),
    'Квота для модели Claude 3.5 Sonnet обновится 06.11.2026, 04:13:39. Переключитесь на другую доступную модель, чтобы продолжить.'
  );
  assert.equal(
    rt.translateString(
      'Your quota for Claude 3.5 Sonnet has been reached. Switch to another available model to continue.'
    ),
    'Квота для модели Claude 3.5 Sonnet исчерпана. Переключитесь на другую доступную модель, чтобы продолжить.'
  );

  // 7. Строка ввода чата и приветствие в новых диалогах (ewc / PEc)
  assert.equal(
    rt.translateString('Ask anything, @ to mention, / for actions'),
    'Напишите задачу (@ — контекст, / — действия)'
  );
  assert.equal(
    rt.translateString('Ask anything, @ to mention'),
    'Напишите задачу (@ — контекст)'
  );
  assert.equal(
    rt.translateString('Message subagent, @ to mention, / for actions'),
    'Сообщение субагенту (@ — контекст, / — действия)'
  );
  assert.equal(
    rt.translateString('What can we get done today?'),
    'Какую задачу решим сегодня?'
  );
  assert.equal(
    rt.translateString('Hi Alex, what can we get done today?'),
    'Привет, Alex! Какую задачу решим сегодня?'
  );
  assert.equal(
    rt.translateString('Hi Иван, what can we get done today?'),
    'Привет, Иван! Какую задачу решим сегодня?'
  );
});

test('13. Режимы экономии токенов и внутренних рассуждений (EN компактный vs RU) в плагине, CLI и детекторе окружения', async () => {
  const { detectEnvironment } = require('../src/core/detector');
  const { parseArgs } = require('../src/cli');
  const tmp = makeTempDir('agy-ru-economy-');

  try {
    // 1. Установка по умолчанию: экономия токенов ВКЛ, компактный EN thinking, русские подписи шагов сохранены
    const defRes = await installAgentPlugin({ geminiConfigDir: tmp });
    assert.deepEqual(defRes.settings, {
      tokenEconomy: true,
      russianThinking: false,
      russianCodeComments: false,
    });

    const defRules = fs.readFileSync(path.join(defRes.pluginDir, 'rules', 'AGENTS.md'), 'utf8');
    assert.match(defRules, /Компактный аналитический режим \(`thinking`\)/);
    assert.match(defRules, /Подписи карточек действий в ленте выполнения/);
    assert.match(defRules, /## 4\. Экономия токенов без потери качества/);
    assert.match(defRules, /Search-Then-Slice/);
    assert.match(defRules, /Model: "flash"/);

    // Детектор окружения точно считывает активный профиль с диска
    const envDef = detectEnvironment({ geminiConfigDir: tmp });
    assert.deepEqual(envDef.agentConfig.settings, {
      tokenEconomy: true,
      russianThinking: false,
      russianCodeComments: false,
    });

    // 2. Переключение на русские размышления + русские комментарии + отключение секции экономии токенов
    await installAgentPlugin({
      geminiConfigDir: tmp,
      tokenEconomy: false,
      russianThinking: true,
      russianCodeComments: true,
    });

    const customRules = fs.readFileSync(path.join(defRes.pluginDir, 'rules', 'AGENTS.md'), 'utf8');
    assert.match(customRules, /на \*\*русском языке\*\* с первого предложения/);
    assert.match(customRules, /Режим русских комментариев в коде \(активен\)/);
    assert.doesNotMatch(customRules, /## 4\. Экономия токенов без потери качества/);

    const envCustom = detectEnvironment({ geminiConfigDir: tmp });
    assert.deepEqual(envCustom.agentConfig.settings, {
      tokenEconomy: false,
      russianThinking: true,
      russianCodeComments: true,
    });

    // 3. Проверка флагов CLI
    const parsed1 = parseArgs(['node', 'cli.js', 'install', '--agent-only', '--russian-comments']);
    assert.equal(parsed1.flags.target, 'plugin');
    assert.equal(parsed1.flags.tokenEconomy, true);
    assert.equal(parsed1.flags.russianThinking, false);
    assert.equal(parsed1.flags.russianComments, true);

    const parsed2 = parseArgs(['node', 'cli.js', 'install', '--russian-thinking', '--no-token-economy']);
    assert.equal(parsed2.flags.tokenEconomy, false);
    assert.equal(parsed2.flags.russianThinking, true);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('14. Детальные страницы плагинов маркетплейса, документация Google Developer Knowledge и кэш marketplace.json/README', () => {
  const {
    patchMarketplaceCache,
    restoreMarketplaceCache,
    DEVELOPER_KNOWLEDGE_README_RU,
    GSLIDES_README_RU,
  } = require('../src/core/marketplace-cache');

  const dict = loadDictionary();
  const rt = createRuntimeTranslator(dict);
  assert.ok(rt);

  // 1. Секции детальной вкладки плагина
  assert.equal(rt.translateString('Commands'), 'Команды');
  assert.equal(rt.translateString('Skills'), 'Навыки');
  assert.equal(rt.translateString('Agents'), 'Агенты');
  assert.equal(rt.translateString('MCP servers'), 'MCP-серверы');
  assert.equal(rt.translateString('Rules'), 'Правила');
  assert.equal(rt.translateString('Hooks'), 'Хуки');
  assert.equal(rt.translateString('UI extensions'), 'UI-расширения');
  assert.equal(rt.translateString('Automations'), 'Автоматизации');
  assert.equal(rt.translateString('Context Providers'), 'Провайдеры контекста');
  assert.equal(rt.translateString('Themes'), 'Темы');

  // 2. Статусы и заголовки страницы плагина
  assert.equal(rt.translateString('Setup required'), 'Требуется настройка');
  assert.equal(rt.translateString('Sign in required.'), 'Требуется вход.');
  assert.equal(rt.translateString('Go to Accounts'), 'Перейти к аккаунтам');
  assert.equal(rt.translateString('Authentication & Setup'), 'Аутентификация и настройка');
  assert.equal(rt.translateString('1. Enable the Developer Knowledge API'), '1. Включите Developer Knowledge API');
  assert.equal(rt.translateString('2. Configure Credentials'), '2. Настройте учетные данные');
  assert.equal(rt.translateString('Included Components'), 'Входящие компоненты');

  // 3. Подзаголовок плагина Google Developer Knowledge
  const gdkSubtitleEn =
    "Equip your agent with direct access to Google's official developer documentation and knowledge base. Search documentation, retrieve full reference pages, and get grounded answers across Google's developer ecosystem.";
  assert.equal(
    rt.translateString(gdkSubtitleEn),
    'Предоставьте вашему агенту прямой доступ к официальной документации и базе знаний разработчиков Google. Ищите по документации, получайте полные справочные страницы и обоснованные ответы по всей экосистеме Google для разработчиков.'
  );

  // 4. Патчинг и откат кэша маркетплейса (README.md и marketplace.json)
  const tmpCache = makeTempDir('agy-mp-cache-');
  try {
    const offDir = path.join(tmpCache, 'antigravity-plugins-official');
    const gdkDir = path.join(offDir, 'plugins', 'google-developer-knowledge', '1.0.2');
    fs.mkdirSync(gdkDir, { recursive: true });

    const origReadme = '# Google Developer Knowledge\n\nOriginal English Readme\n';
    fs.writeFileSync(path.join(gdkDir, 'README.md'), origReadme, 'utf8');

    const origMpJson = {
      plugins: [
        {
          name: 'google-developer-knowledge',
          description:
            'Search and retrieve official documentation across Google Cloud, Gemini, Android, Firebase, Flutter, and Web. Requires Google Cloud credentials (ADC) or an API key.',
          suggestedPrompts: [
            'Look up the exact gcloud CLI command and IAM roles needed to deploy a Cloud Run service with Secret Manager',
          ],
        },
      ],
    };
    fs.writeFileSync(path.join(offDir, 'marketplace.json'), JSON.stringify(origMpJson, null, 2), 'utf8');

    // Применяем патч кэша
    const patchRes = patchMarketplaceCache(tmpCache, dict, { dryRun: false });
    assert.equal(patchRes.patched, true);
    assert.equal(patchRes.modifiedFiles, 2);

    // Проверяем, что README заменён на русский
    const patchedReadme = fs.readFileSync(path.join(gdkDir, 'README.md'), 'utf8');
    assert.equal(patchedReadme, DEVELOPER_KNOWLEDGE_README_RU);

    // Проверяем, что marketplace.json содержит русский перевод
    const patchedMp = JSON.parse(fs.readFileSync(path.join(offDir, 'marketplace.json'), 'utf8'));
    assert.equal(
      patchedMp.plugins[0].description,
      'Поиск и получение официальной документации по Google Cloud, Gemini, Android, Firebase, Flutter и Web. Требуются учётные данные Google Cloud (ADC) или API-ключ.'
    );
    assert.equal(
      patchedMp.plugins[0].suggestedPrompts[0],
      'Найди точную команду gcloud CLI и роли IAM для развёртывания сервиса Cloud Run с Secret Manager'
    );

    // Проверяем откат
    const restoreRes = restoreMarketplaceCache(tmpCache);
    assert.equal(restoreRes.restoredFiles, 2);

    const restoredReadme = fs.readFileSync(path.join(gdkDir, 'README.md'), 'utf8');
    assert.equal(restoredReadme, origReadme);

    const restoredMp = JSON.parse(fs.readFileSync(path.join(offDir, 'marketplace.json'), 'utf8'));
    assert.equal(
      restoredMp.plugins[0].description,
      origMpJson.plugins[0].description
    );
  } finally {
    fs.rmSync(tmpCache, { recursive: true, force: true });
  }
});

test('15. Новые модели Gemini 4 (Carbon / Argon / Hydrogen), режимы Orchestrator, плашки (Fast / Notice) и подсказки v2.32+', () => {
  const dict = loadDictionary();
  const rt = createRuntimeTranslator(dict);
  assert.ok(rt);

  // Плашки и уровни селектора моделей
  assert.equal(rt.translateString('Model'), 'Модель');
  assert.equal(rt.translateString('New'), 'Новое');
  assert.equal(rt.translateString('Fast'), 'Быстро');
  assert.equal(rt.translateString('Notice'), 'Важно');
  assert.equal(rt.translateString('Medium'), 'Средний');
  assert.equal(rt.translateString('XHigh'), 'Сверхвысокий');

  // Режимы Orchestrator и модели с пометками в скобках
  assert.equal(rt.translateString('Orchestrator (Carbon)'), 'Оркестратор (Carbon)');
  assert.equal(rt.translateString('Orchestrator (Argon)'), 'Оркестратор (Argon)');
  assert.equal(rt.translateString('Orchestrator (Hydrogen)'), 'Оркестратор (Hydrogen)');
  assert.equal(rt.translateString('Claude Sonnet 4.6 (Thinking)'), 'Claude Sonnet 4.6 (Размышление)');
  assert.equal(rt.translateString('Claude Opus 4.6 (Thinking)'), 'Claude Opus 4.6 (Размышление)');
  assert.equal(rt.translateString('GPT-OSS 120B (Medium)'), 'GPT-OSS 120B (Средний)');
  assert.equal(rt.translateString('Gemini 4 Hydrogen (XHigh)'), 'Gemini 4 Hydrogen (Сверхвысокий)');
  assert.equal(rt.translateString('Claude Sonnet 5.5 (Max)'), 'Claude Sonnet 5.5 (Макс.)');

  // Горячие клавиши в скобках НЕ должны ломаться правилом моделей
  assert.equal(rt.translateString('Close (Esc)'), 'Закрыть (Esc)');

  // Всплывающие описания режимов Orchestrator (передача рутинных шагов Hydrogen)
  assert.equal(
    rt.translateString('Carbon that may offload routine steps to Hydrogen. Same Carbon-level quality, fewer tokens used.'),
    'Carbon с передачей рутинных шагов модели Hydrogen. Качество уровня Carbon при меньшем расходе токенов.'
  );
  assert.equal(
    rt.translateString('Argon that may offload routine steps to Hydrogen. Same Argon-level quality, fewer tokens used.'),
    'Argon с передачей рутинных шагов модели Hydrogen. Качество уровня Argon при меньшем расходе токенов.'
  );
  assert.equal(
    rt.translateString('Nitrogen that may offload routine steps to Helium. Same Nitrogen-level quality, fewer tokens used.'),
    'Nitrogen с передачей рутинных шагов модели Helium. Качество уровня Nitrogen при меньшем расходе токенов.'
  );

  // Плашки вывода устаревших моделей из эксплуатации (Notice)
  assert.equal(
    rt.translateString('Will be removed on November 18, 2026.'),
    'Будет отключена 18 ноября 2026 г.'
  );
  assert.equal(
    rt.translateString('This model will be retired on Dec 1, 2026.'),
    'Будет отключена 1 декабря 2026 г.'
  );

  // Комбинированные подписи кнопки выбора модели и новые строки v2.32.1
  assert.equal(rt.translateString('Medium \u00b7 1M'), 'Средний \u00b7 1M');
  assert.equal(
    rt.translateString('Select model, current: Gemini 4 Carbon Medium'),
    'Выбрать модель (текущая: Gemini 4 Carbon Средний)'
  );
  assert.equal(rt.translateString('3 models selected'), 'Выбрано моделей: 3');
  assert.equal(rt.translateString('Coordinators'), 'Координаторы');
  assert.equal(rt.translateString('New Side Question'), 'Новый попутный вопрос');
  assert.equal(rt.translateString('Open on phone'), 'Открыть на телефоне');
});

test('16. Расширение Swarm: словарь, динамические счётчики, HTML DOM-рантайм и откат builtin/plugins', () => {
  const { injectHtmlDomRuntime, stripHtmlDomRuntime } = require('../src/core/dom-runtime');
  const { patchBuiltinPlugins, restoreBuiltinPlugins } = require('../src/core/marketplace-cache');

  const dict = loadDictionary();
  const rt = createRuntimeTranslator(dict);
  assert.ok(rt);

  // Основные строки пустого состояния, вкладок и статусов Swarm
  assert.equal(rt.translateString('Swarm'), 'Рой');
  assert.equal(rt.translateString('No swarm in this conversation'), 'В этом диалоге нет роя');
  assert.equal(rt.translateString('Watching for a swarm'), 'Ожидание запуска роя');
  assert.equal(
    rt.translateString('Swarms started in this conversation appear here automatically, with their board, members and @mention graph. Start one with'),
    'Запущенные в этом диалоге рои появляются здесь автоматически вместе с доской, участниками и графом @упоминаний. Запустить рой можно командой'
  );
  assert.equal(rt.translateString('Hide inactive'), 'Скрыть неактивных');
  assert.equal(rt.translateString('Coordinator · Working'), 'Координатор · Работает');
  assert.equal(rt.translateString('worker-1 · Working'), 'worker-1 · Работает');
  assert.equal(rt.translateString('3 waiting on @coordinator'), '3 ожидает @coordinator');
  assert.equal(rt.translateString('2 stuck'), 'Застряло: 2');
  assert.equal(rt.translateString('5 posts'), '5 сообщений');

  // Проверка внедрения и идемпотентного удаления HTML DOM-рантайма
  const sampleHtml = '<!DOCTYPE html><html><body><h2>No swarm in this conversation</h2></body></html>';
  const injected = injectHtmlDomRuntime(sampleHtml, dict);
  assert.match(injected, /<script id="agy-ru-dom-runtime">/);
  assert.equal(injectHtmlDomRuntime(injected, dict), injected);
  assert.equal(stripHtmlDomRuntime(injected).replace(/\s+<\/body>/, '</body>'), sampleHtml);

  // Проверка патчинга и отката встроенного плагина Swarm во временной папке
  const tmpBuiltin = makeTempDir('agy-builtin-swarm-');
  try {
    const scDir = path.join(tmpBuiltin, 'swarm', 'sidecars', 'swarm_board');
    fs.mkdirSync(scDir, { recursive: true });
    const origPluginJson = JSON.stringify({ name: 'swarm', displayName: 'Swarm', description: 'Unlock the power of agent swarms.' }, null, 2);
    const origSidecarJson = JSON.stringify({
      display_name: 'Swarm',
      description: "Live view of the native swarm board, roster and @mention graph for the current conversation's swarm.",
      ui_config: { display_name: 'Swarm', views: [{ path: '/', title: 'Swarm' }] },
    }, null, 2);
    const origIndexHtml = '<!DOCTYPE html><html><body><h2>No swarm in this conversation</h2><p>Watching for a swarm</p></body></html>';

    fs.writeFileSync(path.join(tmpBuiltin, 'swarm', 'plugin.json'), origPluginJson, 'utf8');
    fs.writeFileSync(path.join(scDir, 'sidecar.json'), origSidecarJson, 'utf8');
    fs.writeFileSync(path.join(scDir, 'index.html'), origIndexHtml, 'utf8');

    const patchRes = patchBuiltinPlugins(tmpBuiltin, dict, { dryRun: false });
    assert.equal(patchRes.patched, true);
    assert.equal(patchRes.modifiedFiles, 3);

    const patchedPlugin = JSON.parse(fs.readFileSync(path.join(tmpBuiltin, 'swarm', 'plugin.json'), 'utf8'));
    assert.equal(patchedPlugin.displayName, 'Рой');
    const patchedSidecar = JSON.parse(fs.readFileSync(path.join(scDir, 'sidecar.json'), 'utf8'));
    assert.equal(patchedSidecar.display_name, 'Рой');
    assert.equal(patchedSidecar.ui_config.views[0].title, 'Рой');
    const patchedHtml = fs.readFileSync(path.join(scDir, 'index.html'), 'utf8');
    assert.match(patchedHtml, /В этом диалоге нет роя/);
    assert.match(patchedHtml, /<script id="agy-ru-dom-runtime">/);

    const restoreRes = restoreBuiltinPlugins(tmpBuiltin);
    assert.equal(restoreRes.restoredFiles, 3);
    assert.equal(fs.readFileSync(path.join(scDir, 'index.html'), 'utf8'), origIndexHtml);
  } finally {
    fs.rmSync(tmpBuiltin, { recursive: true, force: true });
  }
});

test('17. Покрытие новых строк v2.32.1+: веб-UI, SSH/WebView оболочки, 84 записей маркетплейса, навыков и расширенного обзора Swarm', () => {
  const {
    GEMINI_API_README_RU,
    CONTEXT7_README_RU,
    patchMarketplaceCache,
    restoreMarketplaceCache,
  } = require('../src/core/marketplace-cache');

  const dict = loadDictionary();
  assert.ok(dict.totalCount >= 4900, `Ожидалось >=4900 ключей в словаре, получено ${dict.totalCount}`);
  const rt = createRuntimeTranslator(dict);
  assert.ok(rt);

  // 1. Новые строки веб-интерфейса и динамические паттерны v2.32.1+
  assert.equal(rt.translateString('Agent working'), 'Агент работает');
  assert.equal(rt.translateString('Ask /btw'), 'Спросить /btw');
  assert.equal(rt.translateString('Voice Speed'), 'Скорость голоса');
  assert.equal(rt.translateString('Used MCP tool: context7_query-docs'), 'Использован MCP-инструмент: context7_query-docs');
  assert.equal(rt.translateString('Open Subagent: Codebase Researcher'), 'Открыть субагента: Codebase Researcher');
  assert.equal(rt.translateString('12 lines added, 4 lines removed'), 'Добавлено строк: 12, удалено: 4');
  assert.equal(rt.translateString('Help us improve Antigravity.'), 'Помогите нам улучшить Antigravity.');
  assert.equal(rt.translateString('Browser: you took over'), 'Браузер: вы перехватили управление');

  // 2. Оболочка Electron, меню, WebView безопасность, Passkeys и SSH
  assert.equal(rt.translateString('Actual Size'), 'Реальный размер');
  assert.equal(rt.translateString('Certificate details'), 'Сведения о сертификате');
  assert.equal(rt.translateString('Select a passkey account to continue:'), 'Выберите аккаунт с ключом доступа для продолжения:');
  assert.equal(rt.translateString('Connect to SSH Host'), 'Подключиться к SSH-хосту');
  assert.equal(rt.translateString('Touch your security key'), 'Коснитесь ключа безопасности');

  // Проверка перевода menu.js и webviewPopupSecurity.js через translateFileBuffer
  const menuRes = translateFileBuffer('dist/menu.js', Buffer.from("label: item.label || 'Actual Size'", 'utf8'), dict);
  assert.equal(menuRes.replacements, 1);
  assert.match(menuRes.buffer.toString('utf8'), /'Реальный размер'/);

  // 3. Новые плагины маркетплейса, категории и встроенные навыки (в т.ч. >- префикс YAML)
  assert.equal(rt.translateString('Search, read, draft, and send emails in Gmail.'), 'Поиск, чтение, создание черновиков и отправка писем в Gmail.');
  assert.equal(rt.translateString('Productivity'), 'Продуктивность');
  assert.equal(rt.translateString('Observability'), 'Наблюдаемость');
  assert.equal(
    rt.translateString('>- ONLY for the native-swarm worker whose brief says it is the narrator. It watches the board and keeps the facts behind the user\'s Overview (view.json) current. Coordinators and other workers: do not load this.'),
    'ТОЛЬКО для исполнителя роя, которому поручена роль летописца (narrator). Отслеживает доску и поддерживает актуальность обзора для пользователя (view.json). Координаторам и другим исполнителям не загружать.'
  );

  // Патчинг и откат README.md для gemini-api и context7 в кэше маркетплейса
  const tmpCache = makeTempDir('agy-mp-v232-');
  try {
    const gemDir = path.join(tmpCache, 'antigravity-plugins-official', 'plugins', 'gemini-api', '2.7.0');
    const c7Dir = path.join(tmpCache, 'antigravity-plugins-partners', 'plugins', 'context7', '1.0.1');
    fs.mkdirSync(gemDir, { recursive: true });
    fs.mkdirSync(c7Dir, { recursive: true });
    const origGem = '# Gemini API\nOriginal EN\n';
    const origC7 = '# Context7\nOriginal EN\n';
    fs.writeFileSync(path.join(gemDir, 'README.md'), origGem, 'utf8');
    fs.writeFileSync(path.join(c7Dir, 'README.md'), origC7, 'utf8');

    const mpRes = patchMarketplaceCache(tmpCache, dict, { dryRun: false });
    assert.equal(mpRes.patched, true);
    assert.equal(mpRes.modifiedFiles, 2);
    assert.equal(fs.readFileSync(path.join(gemDir, 'README.md'), 'utf8'), GEMINI_API_README_RU);
    assert.equal(fs.readFileSync(path.join(c7Dir, 'README.md'), 'utf8'), CONTEXT7_README_RU);

    const rstRes = restoreMarketplaceCache(tmpCache);
    assert.equal(rstRes.restoredFiles, 2);
    assert.equal(fs.readFileSync(path.join(gemDir, 'README.md'), 'utf8'), origGem);
    assert.equal(fs.readFileSync(path.join(c7Dir, 'README.md'), 'utf8'), origC7);
  } finally {
    fs.rmSync(tmpCache, { recursive: true, force: true });
  }

  // 4. Расширенный обзор Swarm (hive.js / app.js)
  assert.equal(rt.translateString('Your swarm is starting'), 'Рой запускается');
  assert.equal(rt.translateString('Compare with now'), 'Сравнить с текущим');
  assert.equal(rt.translateString('Waiting on @coordinator'), 'Ожидает @coordinator');
  assert.equal(rt.translateString('Waiting on @reviewer-1'), 'Ожидает @reviewer-1');
  assert.equal(rt.translateString('3 of 5 tasks done'), 'Выполнено задач: 3 из 5');
  assert.equal(rt.translateString('2 needs you'), 'Ждёт вас: 2');
  assert.equal(rt.translateString('Thinking: Reading file'), 'Размышление: Reading file');
  assert.equal(rt.translateString('From @coordinator'), 'От @coordinator');
  assert.equal(rt.translateString('To @all'), 'Для @all');
  assert.equal(rt.translateString('From file'), null); // защита от ложного срабатывания на обычные фразы
  assert.equal(rt.translateString('The narrator was killed; the overview no longer updates'), 'Летописец остановлен; обзор больше не обновляется');
});

test('18. Локализация новых строк Antigravity v2.33.0 (Browsing Data, Keybinding Scheme, Voice, Bundles, Electron HUD/SSH/Wizard)', () => {
  const dict = loadDictionary();
  const rt = createRuntimeTranslator(dict);

  // 1. Новые разделы настроек и модалей v2.33.0
  assert.equal(rt.translateString('Browsing Data'), 'Данные браузера');
  assert.equal(rt.translateString('Clear Browsing Data?'), 'Очистить данные браузера?');
  assert.equal(rt.translateString('Cookies by Site'), 'Файлы cookie по сайтам');
  assert.equal(rt.translateString('Keybinding Scheme'), 'Схема сочетаний клавиш');
  assert.equal(rt.translateString('VS Code Default'), 'Стандартная VS Code');
  assert.equal(rt.translateString('Antigravity (AGY) Style'), 'Стиль Antigravity (AGY)');
  assert.equal(rt.translateString('Enable Browser Agent'), 'Включить браузерного агента');
  assert.equal(rt.translateString('Voice dictation unavailable'), 'Голосовой ввод недоступен');
  assert.equal(rt.translateString('Review bundle before adding'), 'Проверьте набор перед добавлением');
  assert.equal(rt.translateString('Insert into main conversation'), 'Вставить в основной диалог');

  // 2. Динамические правила v2.33.0 в dom-runtime.js
  assert.equal(rt.translateString('Deleted cookies for github.com'), 'Удалены cookie для github.com');
  assert.equal(
    rt.translateString("Couldn't delete cookies for example.com. Try again."),
    'Не удалось удалить cookie для example.com. Попробуйте ещё раз.'
  );
  assert.equal(rt.translateString('No sites match “github”.'), 'Нет сайтов по запросу «github».');
  assert.equal(rt.translateString('Retrying transcription (attempt 2)…'), 'Повтор распознавания речи (попытка 2)…');
  assert.equal(rt.translateString('3 hidden hosts'), '3 скрытых хоста');
  assert.equal(rt.translateString('5 hidden hosts'), '5 скрытых хостов');
  assert.equal(rt.translateString('2 Drafts'), '2 черновика');
  assert.equal(rt.translateString('Select all in Build Tools'), 'Выбрать всё в «Build Tools»');
  assert.equal(rt.translateString('Are you sure you want to delete the hook "pre-commit"?'), 'Удалить хук «pre-commit»?');

  // 3. Новые партнёрские плагины маркетплейса (Clerk, ClickUp, Docusign, Scandit, TestMu AI)
  assert.equal(
    dict.allEntries.get('Add Clerk auth to my Next.js app'),
    'Добавь аутентификацию Clerk в моё приложение Next.js'
  );
  assert.equal(
    dict.allEntries.get('Run my daily standup from my open ClickUp tasks'),
    'Проведи мой ежедневный стендап по открытым задачам в ClickUp'
  );

  // 4. Динамические патчи Electron app.asar (wizardHtml, hud, hudState, hudAgents, sshPrompts, deviceChooser)
  const wizBuf = Buffer.from('<title>Welcome to Antigravity</title><h1>Welcome to the new Antigravity!</h1><span>Download the Antigravity IDE</span>', 'utf8');
  const wizOut = translateFileBuffer('dist/ideInstall/wizardHtml.js', wizBuf, dict);
  assert.ok(wizOut.replacements >= 3);
  assert.ok(wizOut.buffer.toString('utf8').includes('Добро пожаловать в новый Antigravity!'));

  const hudStateBuf = Buffer.from('const x = name ? `AGY working in ${name} (background)` : \'AGY working in the background\';', 'utf8');
  const hudStateOut = translateFileBuffer('dist/computer/hudState.js', hudStateBuf, dict);
  assert.ok(hudStateOut.buffer.toString('utf8').includes('`AGY работает в ${name} (в фоне)`'));
  assert.ok(hudStateOut.buffer.toString('utf8').includes('AGY работает в фоновом режиме'));

  const hudAgentsBuf = Buffer.from('return `${working} AGY agents working`; return `${stopped} agents stopped`; return `${text} (+${stopped} stopped)`;', 'utf8');
  const hudAgentsOut = translateFileBuffer('dist/computer/hudAgents.js', hudAgentsBuf, dict);
  const hudAgentsText = hudAgentsOut.buffer.toString('utf8');
  assert.ok(hudAgentsText.includes('`Работают агенты AGY: ${working}`'));
  assert.ok(hudAgentsText.includes('`Остановлено агентов: ${stopped}`'));
  assert.ok(hudAgentsText.includes('`${text} (+${stopped} ост.)`'));

  const sshBuf = Buffer.from('<p class="context">Connecting to <span id="label"></span></p><div id="long" class="note" role="alert" hidden>That\'s too long.</div><button id="cancel" class="secondary">Cancel</button>', 'utf8');
  const sshOut = translateFileBuffer('dist/remote/sshPrompts.js', sshBuf, dict);
  const sshText = sshOut.buffer.toString('utf8');
  assert.ok(sshText.includes('Подключение к <span id="label"></span>'));
  assert.ok(sshText.includes('Слишком длинное значение.'));
  assert.ok(sshText.includes('>Отмена</button>'));

  const devBuf = Buffer.from('const msg = `${origin} wants to connect to a ${KIND_NOUNS[kind]}`;', 'utf8');
  const devOut = translateFileBuffer('dist/deviceChooser.js', devBuf, dict);
  assert.ok(devOut.buffer.toString('utf8').includes('`${origin} запрашивает подключение: ${KIND_NOUNS[kind]}`'));
});

test('19. Локализация обновления Antigravity v2.33.1, экрана обзора Swarm (hive.js) и официальных плагинов Маркетплейса (v2.3.5)', () => {
  const dict = loadDictionary();
  const rt = createRuntimeTranslator(dict);

  // 1. Новые статические и динамические строки Web UI v2.33.1
  assert.equal(
    rt.translateString('Pause this agent; it keeps its place and streams. Resume to continue.'),
    'Приостановить этого агента; он сохранит прогресс и потоки. Нажмите «Продолжить» для возобновления.'
  );
  assert.equal(rt.translateString('Back 5s (←)'), 'Назад на 5 с (←)');
  assert.equal(rt.translateString('3 on for this conversation'), '3 вкл. для этого диалога');
  assert.equal(
    rt.translateString('Agent: researcher. Change it in the model menu.'),
    'Агент: researcher. Изменить можно в меню выбора модели.'
  );
  assert.equal(
    rt.translateString('An automation with this name already exists.'),
    'Элемент (automation) с таким именем уже существует.'
  );
  assert.equal(
    rt.translateString('An extension with this name already exists on this computer. Run it remotely, or go back and rename it.'),
    'Элемент (extension) с таким именем уже существует на этом компьютере. Запустите его удалённо или вернитесь и переименуйте.'
  );
  assert.equal(rt.translateString('Open gemini-api skill'), 'Открыть навык gemini-api');
  assert.equal(rt.translateString('Open the Spacefast plugin'), 'Открыть плагин Spacefast');
  assert.equal(rt.translateString('Review Spacefast before installing'), 'Проверить Spacefast перед установкой');
  assert.equal(rt.translateString('Created automation "Daily Sync".'), 'Создана автоматизация «Daily Sync».');

  // Проверка склейки составных текстовых узлов без разметки-обёртки (translateSiblingTextGroup)
  const tn1 = { nodeType: 3, nodeValue: 'An ', parentElement: null };
  const tn2 = { nodeType: 3, nodeValue: 'extension', parentElement: null };
  const tn3 = { nodeType: 3, nodeValue: ' with this name already exists.', parentElement: null };
  const spanHost = {
    nodeType: 1,
    tagName: 'SPAN',
    className: 'text-sm text-error',
    childNodes: [tn1, tn2, tn3],
    parentElement: null,
    getAttribute: () => null,
    setAttribute: () => {},
  };
  tn1.parentElement = spanHost;
  tn2.parentElement = spanHost;
  tn3.parentElement = spanHost;
  rt.walkSubtree(spanHost);
  assert.equal(tn1.nodeValue, 'Элемент (extension) с таким именем уже существует.');
  assert.equal(tn2.nodeValue, '');
  assert.equal(tn3.nodeValue, '');

  // 2. Расширенный обзор Swarm (hive.js / app.js) и встроенный навык swarm_pane
  assert.equal(rt.translateString('1 in review'), '1 на проверке');
  assert.equal(rt.translateString('Now · 2 / 5'), 'Сейчас · 2 / 5');
  assert.equal(rt.translateString('Remote · 2 machines'), 'Удалённо · 2 машины');
  assert.equal(rt.translateString('2 posts since the view was updated'), '2 сообщения с момента обновления обзора');
  assert.equal(rt.translateString('Last change: “Updated cards”'), 'Последнее изменение: «Updated cards»');
  assert.equal(rt.translateString('From researcher'), 'От researcher');
  assert.equal(rt.translateString('Give feedback on this item'), 'Оставить отзыв об этом элементе');
  assert.ok(
    /Формат заметок координатора/.test(
      dict.allEntries.get(
        "What the coordinator writes so the Swarm UI's Overview can show the swarm's goal, its groups of work and a screenshot timeline. Load it before you brief and add the first workers to a swarm."
      )
    )
  );

  // 3. Официальные и партнёрские плагины (Spacefast, invideo, Gemini API v2.8.0, SonarQube v2.7.0)
  // и гарантия отсутствия переводов локальных авторских плагинов
  assert.ok(
    dict.allEntries.get(
      'Turn an idea into a website, dashboard, report, or small web tool you can share. Build it in your conversation, or bring something you already made, and publish it with Spacefast.'
    )
  );
  assert.ok(dict.allEntries.get('Cut the clips in this folder into a 30-second vertical ad with captions and music'));
  assert.ok(dict.allEntries.get('Analyze a file for quality and security issues using SonarQube'));
  assert.ok(
    dict.allEntries.get(
      'Call the Gemini API from the shell with gemini-api. Use for media generation (images, TTS, music, video), file and YouTube analysis, audio/video transcription, Deep Research, and sandboxed agents.'
    )
  );
  assert.equal(
    dict.allEntries.has(
      'Control protocol for The Tunnel v3.27.0 3D Task Tensor (Breadth x Depth x Risk), Gemini 4 Hydrogen/Neon/Carbon/Orchestrator routing, Adaptive Swarm, CPU pool, and Int8 GPU copilot. Use when tuning router-state.json, model tiers, or RAM/VRAM guardrails.'
    ),
    false
  );

  // 4. Новые динамические патчи Electron app.asar (remoteManager, webauthn, main)
  const mainBuf = Buffer.from('dialog.showErrorBox("WSL", `The WSL distro "${WSL_DISTRO}" is no longer installed.`);', 'utf8');
  const mainOut = translateFileBuffer('dist/main.js', mainBuf, dict);
  assert.ok(mainOut.buffer.toString('utf8').includes('`Дистрибутив WSL «${WSL_DISTRO}» больше не установлен.`'));

  const webauthnBuf = Buffer.from('const title = `Sign in to ${rpLabel}`;', 'utf8');
  const webauthnOut = translateFileBuffer('dist/webauthn.js', webauthnBuf, dict);
  assert.ok(webauthnOut.buffer.toString('utf8').includes('`Вход в ${rpLabel}`'));

  const remoteBuf = Buffer.from(
    'const a = `${label} is running server ${running}; this app is ${expected}. Restart the server now?`; const b = `Any ${what} still running on it stops. The server starts again with this app\'s version.`; const c = `Allow ${label} to use your microphone?`;',
    'utf8'
  );
  const remoteOut = translateFileBuffer('dist/remote/remoteManager.js', remoteBuf, dict);
  const remoteText = remoteOut.buffer.toString('utf8');
  assert.ok(remoteText.includes('На ${label} запущен сервер ${running}, а версия приложения — ${expected}. Перезапустить сервер сейчас?'));
  assert.ok(remoteText.includes('Все активные процессы (${what}) на сервере будут остановлены'));
  assert.ok(remoteText.includes('`Разрешить ${label} использовать микрофон?`'));
});

test('20. Локализация обновления Antigravity v2.34.0 (Orchestrator, Sidebar, Sandbox, Swarm GIF/Hive, 8 новых плагинов Маркетплейса, v2.3.6)', () => {
  const dict = loadDictionary();
  const rt = createRuntimeTranslator(dict);

  // 1. Новые разделы UI Antigravity v2.34.0
  assert.equal(rt.translateString('Orchestrator Settings'), 'Настройки Оркестратора');
  assert.equal(rt.translateString('Orchestrator Model'), 'Модель-оркестратор');
  assert.equal(rt.translateString('Executor Model'), 'Модель-исполнитель');
  assert.equal(rt.translateString('Thinking effort'), 'Глубина размышлений');
  assert.equal(rt.translateString('Customize Sidebar'), 'Настроить боковую панель');
  assert.equal(rt.translateString('Show Automation Conversations'), 'Показывать диалоги автоматизаций');
  assert.equal(rt.translateString('Enable sandbox mode'), 'Включить режим песочницы');
  assert.equal(rt.translateString('Enter to send'), 'Enter для отправки');
  assert.equal(rt.translateString('Unsent draft'), 'Неотправленный черновик');
  assert.equal(rt.translateString('No sign-in required. This app is ready to use.'), 'Вход не требуется. Это приложение готово к работе.');

  // 2. 8 новых официальных и партнёрских плагинов Маркетплейса + сохранение локальных плагинов без перевода
  assert.ok(
    dict.allEntries.get(
      'Search and retrieve official Google Health API documentation on developers.google.com/health through the Google Health Developer MCP server.'
    )
  );
  assert.ok(
    dict.allEntries.get(
      'Search official Google Home, Matter, and OpenThread documentation and query Cloud-to-cloud user feedback integration diagnostics through the Google Home Developer MCP server.'
    )
  );
  assert.ok(
    dict.allEntries.get(
      'RDKit cheminformatics, reaction and property tools, plus ChEMBL and PubChem, to work with molecules, their properties, and bioactivity data.'
    )
  );
  assert.ok(
    dict.allEntries.get(
      'AlphaGenome and major genetics databases to analyze DNA variants, gene regulation, and links between genes and disease.'
    )
  );
  assert.ok(dict.allEntries.get('Antigravity for science highlights, and an overview of the main science plugins.'));
  assert.ok(dict.allEntries.get('Search scientific papers, clinical trials, FDA records, and historical texts.'));
  assert.ok(
    dict.allEntries.get(
      'AlphaFold, 3D visualization tools, and protein databases to explore protein structures, sequences, pathways, and drug interactions.'
    )
  );
  assert.ok(
    dict.allEntries.get(
      'Build, test, and manage n8n workflows and Agents through your instance MCP server. Use official skills for node setup, credentials, and debugging.'
    )
  );
  assert.ok(dict.allEntries.get('Review an n8n workflow for errors.'));
  assert.equal(
    dict.allEntries.has(
      'Персональная писательская студия v2.0 для создания коммерческих книг и многотомных циклов.'
    ),
    false
  );

  // 3. Динамические правила обновлённого Swarm (GIF-экспорт и Hive)
  assert.equal(rt.translateString('Export GIF'), 'Экспорт GIF');
  assert.equal(rt.translateString('Exporting 42%'), 'Экспорт 42%');
  assert.equal(
    rt.translateString('Exported swarm-graph.gif (12 frames · 1.2 MB)'),
    'Экспортировано: swarm-graph.gif (12 кадров · 1.2 MB)'
  );
  assert.equal(
    rt.translateString('GIF ready (12 frames, 1.2 MB) — right-click image to save.'),
    'GIF готов (12 кадров, 1.2 MB) — нажмите правой кнопкой по изображению, чтобы сохранить.'
  );
  assert.equal(rt.translateString('Swarm start · 4 members'), 'Старт роя · 4 участника');
  assert.equal(
    rt.translateString('Coordinator · 3 of 5 done · Needs you'),
    'Координатор · выполнено 3 из 5 · Требует вашего участия'
  );
  assert.equal(rt.translateString('Working for @coordinator'), 'Работает для @coordinator');
  assert.equal(rt.translateString('Go to #12 on the Board'), 'Перейти к #12 на доске');
  assert.equal(rt.translateString('Shared Remote board abc123'), 'Общая доска (Удалённо) abc123');
  assert.equal(rt.translateString('over 5m 12s'), 'за 5 мин 12 с');
  assert.equal(rt.translateString('5m 12s ago'), '5 мин 12 с назад');

  // 4. Патчи Electron app.asar (provisionSplash + подробности диалогов remoteManager)
  const splashBuf = Buffer.from('<div>Setting up WSL: ${escapeHtml(distro)}</div>', 'utf8');
  const splashOut = translateFileBuffer('dist/provisionSplash.js', splashBuf, dict);
  assert.ok(splashOut.buffer.toString('utf8').includes('<div>Настройка WSL: ${escapeHtml(distro)}</div>'));

  const remoteDetailBuf = Buffer.from(
    [
      'const mic = `The page in this window comes from ${label}. If you allow it, that ` +',
      '  "host can use this computer\'s microphone for voice whenever one of " +',
      '  \'its windows is open. Antigravity asks again after you quit it.\';',
      'const org = \'Continue only if you just chose to sign in with your organization \' +',
      '  `in this window. ${entry.label} will get access to your ` +',
      '  "organization\'s Google Cloud account.\\n" +',
      '  `Workforce pool: ${names[1]}  Provider: ${names[2]}`;',
    ].join('\n'),
    'utf8'
  );
  const remoteDetailOut = translateFileBuffer('dist/remote/remoteManager.js', remoteDetailBuf, dict);
  const remoteDetailText = remoteDetailOut.buffer.toString('utf8');
  assert.ok(remoteDetailText.includes('Страница в этом окне загружена с ${label}.'));
  assert.ok(remoteDetailText.includes('Продолжайте, только если вы сами выбрали вход через аккаунт организации '));
  assert.ok(remoteDetailText.includes('в этом окне. ${entry.label} получит доступ к '));
  assert.ok(remoteDetailText.includes('Пул сотрудников: ${names[1]}  Провайдер: ${names[2]}'));
});





