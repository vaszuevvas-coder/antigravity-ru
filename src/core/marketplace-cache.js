'use strict';

const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { translateHtml } = require('./translator');
const { injectHtmlDomRuntime } = require('./dom-runtime');

const DEVELOPER_KNOWLEDGE_README_RU = `# Google Developer Knowledge

Предоставьте вашему агенту прямой доступ к официальной документации и базе знаний разработчиков Google. Ищите по документации, получайте полные справочные страницы и обоснованные ответы по всей экосистеме Google для разработчиков.

## Обзор

Плагин **Google Developer Knowledge** подключает вашего агента к официальному [Google Developer Knowledge API][dk-docs] и серверу Model Context Protocol (MCP). Вместо того чтобы полагаться на дату отсечки обучающих данных модели или непроверенные результаты поиска в интернете, ваш агент может напрямую запрашивать авторитетную документацию по следующим направлениям:

- **Google Cloud и Apigee** (\`cloud.google.com\`, \`docs.cloud.google.com\`, \`docs.apigee.com\`)
- **Google AI, Gemini и ML** (\`ai.google.dev\`, \`adk.dev\`, \`genkit.dev\`, \`antigravity.google\`, \`geminicli.com\`, \`www.tensorflow.org\`)
- **Android** (\`developer.android.com\`)
- **Firebase** (\`firebase.google.com\`)
- **Flutter и Dart** (\`docs.flutter.dev\`, \`dart.dev\`)
- **Chrome и веб** (\`developer.chrome.com\`, \`web.dev\`)
- **Google Developers, Workspace и Home** (\`developers.google.com\`, \`knowledge.workspace.google.com\`, \`developers.home.google.com\`)
- **Go, Google Maps Platform и Fuchsia** (\`go.dev\`, \`mapsplatform.google.com\`, \`fuchsia.dev\`)

## Аутентификация и настройка

Для использования Google Developer Knowledge API и MCP-сервера требуется проект Google Cloud с включенным **Developer Knowledge API** (\`developerknowledge.googleapis.com\`). Вы можете аутентифицироваться с помощью **Application Default Credentials (ADC)** или **API-ключа**.

### 1. Включите Developer Knowledge API

Включите API в вашем проекте Google Cloud с помощью [Google Cloud Console][dk-console] или через CLI \`gcloud\`:

\`\`\`bash
gcloud services enable developerknowledge.googleapis.com \\
  --project=YOUR_PROJECT_ID
\`\`\`

### 2. Настройте учетные данные

Выберите один из следующих способов аутентификации:

#### Вариант 1: Application Default Credentials (рекомендуется для MCP)

Встроенная конфигурация MCP-сервера \`google-developer-knowledge\` автоматически использует локальные учетные данные Google Cloud Application Default Credentials (\`google_credentials\`):

\`\`\`bash
gcloud auth application-default login
gcloud auth application-default set-quota-project YOUR_PROJECT_ID
\`\`\`

Убедитесь, что у вашего аккаунта есть роль IAM **Service Usage Consumer** (\`roles/serviceusage.serviceUsageConsumer\`) в \`YOUR_PROJECT_ID\`.

#### Вариант 2: API-ключ Developer Knowledge

Либо создайте API-ключ на [странице учетных данных Google Cloud Console][gcp-credentials] (с ограничением для **Developer Knowledge API**) и экспортируйте его в переменные среды для резервного вызова REST API навыка:

\`\`\`bash
export DEVELOPER_KNOWLEDGE_API_KEY="your-api-key"
export DEVELOPERKNOWLEDGE_API_KEY="your-api-key"
\`\`\`

Чтобы аутентифицировать удаленный MCP-сервер напрямую с помощью API-ключа вместо ADC, настройте заголовок \`X-Goog-Api-Key\` в конфигурации MCP-сервера:

\`\`\`json
{
  "mcpServers": {
    "google-developer-knowledge": {
      "serverUrl": "https://developerknowledge.googleapis.com/mcp",
      "headers": {
        "X-Goog-Api-Key": "YOUR_API_KEY"
      }
    }
  }
}
\`\`\`

## Входящие компоненты

### Удаленный MCP-сервер (\`google-developer-knowledge\`)

Подключается к \`https://developerknowledge.googleapis.com/mcp\` и предоставляет инструменты для поиска документации:

- **\`answer_query\`**: Задавайте технические вопросы на естественном языке и получайте структурированные ответы, основанные на официальной документации Google, со ссылками на первоисточники.
- **\`search_documents\`**: Поиск подходящих страниц и фрагментов по всей официальной документации для разработчиков Google.
- **\`get_documents\`**: Получение полного Markdown-содержимого одной или нескольких страниц документации по имени документа (до 20 документов за один вызов).

### Навык агента (\`retrieving-developer-knowledge\`)

Предоставляет структурированные рабочие процессы и рекомендации по фильтрации доменов, чтобы агент выбирал лучшую стратегию запросов, ограничивал поиск нужными доменами продуктов Google, проверял версии API и корректно переключался на резервные методы.

## Примеры запросов

- *«Найди точную команду gcloud CLI и роли IAM для развёртывания сервиса Cloud Run с Secret Manager»*
- *«Найди в официальной документации Google, как реализовать структурированный вывод в Gemini API»*
- *«Сравни Cloud Run, GKE Autopilot и App Engine на основе официальных архитектурных руководств Google Cloud»*
- *«Каковы современные рекомендации по навигации в Jetpack Compose согласно официальной документации Android?»*

## Ресурсы

- [Документация Google Developer Knowledge][dk-docs]
- [Руководство по MCP-серверу Developer Knowledge][dk-mcp]

[dk-docs]: https://developers.google.com/knowledge
[dk-mcp]: https://developers.google.com/knowledge/mcp
[dk-console]: https://console.cloud.google.com/apis/library/developerknowledge.googleapis.com
[gcp-credentials]: https://console.cloud.google.com/apis/credentials
`;

const GSLIDES_README_RU = `Создавайте и оформляйте презентации Google Slides. Превращайте заметки в слайды, добавляйте изображения и заметки докладчика, а также экспортируйте результат в PDF или PowerPoint.
`;

const GEMINI_API_README_RU = `# Gemini API

Предоставьте вашему агенту актуальные шаблоны SDK, CLI-сценарии, идентификаторы моделей
и поиск по живой документации для разработки с помощью
[Gemini API](https://aistudio.google.com/docs).

## Что входит в плагин

### Навыки

| Навык | Описание |
| :--- | :--- |
| \`gemini-api-dev\` | Создание приложений с [Interactions API](https://aistudio.google.com/docs/interactions-overview) и [Decisions API](https://aistudio.google.com/docs/decisions-api). Охватывает генерацию текста, многоходовый чат с состоянием, потоковую передачу, вызов функций, структурированный вывод, калиброванные решения, генерацию изображений, синтез речи (TTS), Voice Design, Voice Replication, управляемых агентов, Deep Research и миграцию с \`generateContent\`. |
| \`gemini-live-api-dev\` | Создание двунаправленных голосовых и видеоприложений с низкой задержкой по WebSocket на базе [Gemini Live API](https://aistudio.google.com/docs/live-api). Включает потоковую передачу аудио/видео в реальном времени, фоновые рассуждения (extended thinking), асинхронный неблокирующий вызов инструментов, транскрибацию, живой перевод речи и управление сессиями. |
| \`gemini-omni-flash-api\` | Генерация и редактирование видео с помощью Gemini Omni Flash через Interactions API: text-to-video, переходы по первому и последнему кадру, генерация по референсам и продление видео. |
| \`gemini-api-cli\` | Вызов Gemini API из терминала через [\`gemini-api\` CLI](https://aistudio.google.com/docs/cli). Поддерживает генерацию медиа (изображения, TTS, музыка, видео), анализ локальных файлов и YouTube, транскрибацию аудио и видео, Deep Research и изолированных агентов. |

### MCP-сервер

- **\`gemini-api-docs\`** (\`https://gemini-api-docs-mcp.dev\`): Предоставляет инструменты
  \`gemini_search_docs\` и \`gemini_get_doc\`, чтобы агент мог искать и читать
  официальную документацию Gemini API напрямую без ручного парсинга страниц.

## Предварительные требования

1. **API-ключ**: Задайте переменную среды \`GEMINI_API_KEY\` ключом из
   [Google AI Studio](https://aistudio.google.com/apikey).
2. **Установка SDK**:
   - **Python**: \`pip install -U google-genai\`
   - **JavaScript / TypeScript**: \`npm install @google/genai\`
3. **Установка CLI** *(необязательно, для сценариев в оболочке)*:
   - \`curl -fsSL https://raw.githubusercontent.com/google-gemini/gemini-api-cli/main/scripts/install.sh | bash\`

## Примеры запросов

- *«Напиши скрипт многоходового чата с сохранением состояния на базе Interactions API и актуальных моделей.»*
- *«Создай голосового агента реального времени с помощью Gemini Live API и неблокирующего вызова функций.»*
- *«Сгенерируй диалоговое аудио с несколькими дикторами на новейших моделях Gemini TTS и разметкой \`speech_metadata\`.»*
- *«Используй \`gemini-api\` CLI, чтобы расшифровать \`./interview.mp4\` в файл SRT и подвести итоги по задачам.»*
- *«Мигрируй \`src/\` с \`client.models.generate_content\` на \`client.interactions.create\`.»*

## Ресурсы

- [Документация Gemini API в Google AI Studio](https://aistudio.google.com/docs)
- [Руководство по Interactions API](https://aistudio.google.com/docs/interactions-overview)
- [Репозиторий на GitHub (\`google-gemini/gemini-skills\`)](https://github.com/google-gemini/gemini-skills)
`;

const CONTEXT7_README_RU = `# Плагин Context7 для Antigravity

Context7 решает частую проблему ИИ-ассистентов для разработки — устаревшие обучающие данные и вымышленные API. Вместо опоры на старые знания Context7 загружает актуальную документацию напрямую из репозиториев библиотек.

## Что входит в плагин

- **MCP-сервер** — подключает Antigravity к сервису документации Context7
- **Навыки** — навык \`context7-mcp\` с инструкциями по поиску библиотек и загрузке документации

## Аутентификация

После установки плагина откройте **Настройки агента → Кастомизации** и нажмите **Войти** напротив сервера \`context7_context7\`. Авторизуйтесь в Context7 в браузере для подключения.

## Доступные инструменты

### resolve-library-id

Выполняет поиск библиотек и возвращает идентификаторы, совместимые с Context7.

\`\`\`
Input: "next.js"
Output: { id: "/vercel/next.js", name: "Next.js", versions: ["v16.2.9", "v15.1.8", ...] }
\`\`\`

### query-docs

Загружает документацию по выбранной библиотеке, отсортированную по релевантности вашему вопросу.

\`\`\`
Input: { libraryId: "/vercel/next.js", query: "app router proxy" }
Output: Релевантные фрагменты документации с примерами кода
\`\`\`

## Примеры использования

Плагин срабатывает автоматически, когда вы спрашиваете о библиотеках:

- «Как настроить аутентификацию в Next.js 16?»
- «Покажи примеры React Server Components»
- «Какой синтаксис связей используется в Prisma?»

## Фиксация версии

Чтобы получить документацию для конкретной версии, укажите её в идентификаторе библиотеки:

\`\`\`
/vercel/next.js/v16.2.9
/supabase/supabase/v2.45.0
\`\`\`

Инструмент \`resolve-library-id\` возвращает список доступных версий, чтобы вы могли выбрать подходящую для вашего проекта.
`;

function getDefaultMarketplacesDir() {
  return path.join(os.homedir(), '.gemini', 'antigravity', 'cache', 'marketplaces');
}

function getDictTranslation(dict, str) {
  if (!str || typeof str !== 'string' || !dict) return null;
  if (typeof dict.translate === 'function') return dict.translate(str);
  if (dict.allEntries instanceof Map) {
    if (dict.allEntries.has(str)) return dict.allEntries.get(str);
    const collapsed = str.replace(/\s+/g, ' ').trim();
    if (dict.allEntries.has(collapsed)) return dict.allEntries.get(collapsed);
  }
  return null;
}

/**
 * Локализует кэш маркетплейса плагинов (README.md и marketplace.json).
 */
function patchMarketplaceCache(cacheDir, dict, options = {}) {
  const targetDir = cacheDir || getDefaultMarketplacesDir();
  if (!fs.existsSync(targetDir)) return { patched: false, modifiedFiles: 0 };

  const dryRun = !!options.dryRun;
  const backupMgr = options.backupMgr;
  const manifest = options.manifest;
  let modifiedFiles = 0;

  function backupFile(absPath, keyName) {
    if (dryRun) return;
    if (backupMgr && manifest) {
      backupMgr.backupExternalFile(manifest, keyName, absPath);
    }
    const bakPath = `${absPath}.orig`;
    if (!fs.existsSync(bakPath)) {
      fs.copyFileSync(absPath, bakPath);
    }
  }

  // 1. Поиск и локализация README.md для плагинов с известной документацией
  const pluginReadmes = [
    {
      id: 'google-developer-knowledge',
      relPath: path.join('antigravity-plugins-official', 'plugins', 'google-developer-knowledge'),
      content: DEVELOPER_KNOWLEDGE_README_RU,
    },
    {
      id: 'gslides',
      relPath: path.join('antigravity-plugins-official', 'plugins', 'gslides'),
      content: GSLIDES_README_RU,
    },
    {
      id: 'gemini-api',
      relPath: path.join('antigravity-plugins-official', 'plugins', 'gemini-api'),
      content: GEMINI_API_README_RU,
    },
    {
      id: 'context7',
      relPath: path.join('antigravity-plugins-partners', 'plugins', 'context7'),
      content: CONTEXT7_README_RU,
    },
  ];

  for (const item of pluginReadmes) {
    const pluginBase = path.join(targetDir, item.relPath);
    if (!fs.existsSync(pluginBase)) continue;

    let versions;
    try {
      versions = fs.readdirSync(pluginBase);
    } catch {
      continue;
    }

    for (const ver of versions) {
      const readmePath = path.join(pluginBase, ver, 'README.md');
      if (fs.existsSync(readmePath)) {
        const curText = fs.readFileSync(readmePath, 'utf8');
        if (curText.trim() !== item.content.trim()) {
          backupFile(readmePath, `mp_readme_${item.id}_${ver}`);
          if (!dryRun) {
            fs.writeFileSync(readmePath, item.content, 'utf8');
          }
          modifiedFiles++;
        }
      }
    }
  }

  // 2. Локализация описаний и подсказок в каталогах marketplace.json
  const catalogs = ['antigravity-plugins-official', 'antigravity-plugins-partners'];
  for (const cat of catalogs) {
    const mpPath = path.join(targetDir, cat, 'marketplace.json');
    if (!fs.existsSync(mpPath)) continue;

    try {
      const raw = fs.readFileSync(mpPath, 'utf8');
      const mp = JSON.parse(raw);
      let changed = false;

      if (Array.isArray(mp.plugins)) {
        for (const p of mp.plugins) {
          if (p.description) {
            const ru = getDictTranslation(dict, p.description);
            if (ru && ru !== p.description) {
              p.description = ru;
              changed = true;
            }
          }
          if (Array.isArray(p.suggestedPrompts)) {
            p.suggestedPrompts = p.suggestedPrompts.map((sp) => {
              const ru = getDictTranslation(dict, sp);
              if (ru && ru !== sp) {
                changed = true;
                return ru;
              }
              return sp;
            });
          }
        }
      }

      if (changed) {
        backupFile(mpPath, `mp_catalog_${cat}`);
        if (!dryRun) {
          fs.writeFileSync(mpPath, JSON.stringify(mp, null, 2), 'utf8');
        }
        modifiedFiles++;
      }
    } catch {
      // Игнорируем ошибки парсинга невалидного JSON
    }
  }

  return { patched: modifiedFiles > 0, modifiedFiles };
}


/**
 * Восстанавливает оригинальный кэш маркетплейса из резервных копий .orig.
 */
function restoreMarketplaceCache(cacheDir) {
  const targetDir = cacheDir || getDefaultMarketplacesDir();
  if (!fs.existsSync(targetDir)) return { restoredFiles: 0 };

  let restoredFiles = 0;

  function walkAndRestore(dir) {
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }

    for (const ent of entries) {
      const full = path.join(dir, ent.name);
      if (ent.isDirectory()) {
        walkAndRestore(full);
      } else if (ent.isFile() && ent.name.endsWith('.orig')) {
        const originalTarget = full.slice(0, -5);
        try {
          fs.copyFileSync(full, originalTarget);
          fs.unlinkSync(full);
          restoredFiles++;
        } catch {
          // Игнорируем заблокированные файлы
        }
      }
    }
  }

  walkAndRestore(targetDir);
  return { restoredFiles };
}

function getDefaultBuiltinPluginsDir() {
  return path.join(os.homedir(), '.gemini', 'antigravity', 'builtin', 'plugins');
}

/**
 * Локализует встроенные плагины и их веб-сайдкары (~/.gemini/antigravity/builtin/plugins), включая Swarm.
 */
function patchBuiltinPlugins(builtinDir, dict, options = {}) {
  const targetDir = builtinDir || getDefaultBuiltinPluginsDir();
  if (!fs.existsSync(targetDir)) return { patched: false, modifiedFiles: 0 };

  const dryRun = !!options.dryRun;
  const backupMgr = options.backupMgr;
  const manifest = options.manifest;
  let modifiedFiles = 0;

  function backupFile(absPath, keyName) {
    if (dryRun) return;
    if (backupMgr && manifest) {
      backupMgr.backupExternalFile(manifest, keyName, absPath);
    }
    const bakPath = `${absPath}.orig`;
    if (!fs.existsSync(bakPath)) {
      fs.copyFileSync(absPath, bakPath);
    }
  }

  let pluginFolders = [];
  try {
    pluginFolders = fs.readdirSync(targetDir, { withFileTypes: true }).filter((d) => d.isDirectory());
  } catch {
    return { patched: false, modifiedFiles: 0 };
  }

  for (const pluginEnt of pluginFolders) {
    const pluginRoot = path.join(targetDir, pluginEnt.name);

    // 1. plugin.json (displayName, description)
    const pluginJsonPath = path.join(pluginRoot, 'plugin.json');
    if (fs.existsSync(pluginJsonPath)) {
      try {
        const raw = fs.readFileSync(pluginJsonPath, 'utf8');
        const parsed = JSON.parse(raw);
        let changed = false;
        for (const field of ['displayName', 'description']) {
          if (typeof parsed[field] === 'string') {
            const ru = getDictTranslation(dict, parsed[field]);
            if (ru && ru !== parsed[field]) {
              parsed[field] = ru;
              changed = true;
            }
          }
        }
        if (changed) {
          backupFile(pluginJsonPath, `builtin_${pluginEnt.name}_plugin_json`);
          if (!dryRun) {
            fs.writeFileSync(pluginJsonPath, JSON.stringify(parsed, null, 2) + '\n', 'utf8');
          }
          modifiedFiles++;
        }
      } catch {}
    }

    // 2. sidecars/*/ (sidecar.json и index.html)
    const sidecarsDir = path.join(pluginRoot, 'sidecars');
    if (!fs.existsSync(sidecarsDir)) continue;

    let sidecarDirs = [];
    try {
      sidecarDirs = fs.readdirSync(sidecarsDir, { withFileTypes: true }).filter((d) => d.isDirectory());
    } catch {
      continue;
    }

    for (const scEnt of sidecarDirs) {
      const scRoot = path.join(sidecarsDir, scEnt.name);

      const sidecarJsonPath = path.join(scRoot, 'sidecar.json');
      if (fs.existsSync(sidecarJsonPath)) {
        try {
          const raw = fs.readFileSync(sidecarJsonPath, 'utf8');
          const sc = JSON.parse(raw);
          let changed = false;
          for (const field of ['display_name', 'description']) {
            if (typeof sc[field] === 'string') {
              const ru = getDictTranslation(dict, sc[field]);
              if (ru && ru !== sc[field]) {
                sc[field] = ru;
                changed = true;
              }
            }
          }
          if (sc.ui_config && typeof sc.ui_config === 'object') {
            if (typeof sc.ui_config.display_name === 'string') {
              const ru = getDictTranslation(dict, sc.ui_config.display_name);
              if (ru && ru !== sc.ui_config.display_name) {
                sc.ui_config.display_name = ru;
                changed = true;
              }
            }
            if (Array.isArray(sc.ui_config.views)) {
              for (const view of sc.ui_config.views) {
                if (view && typeof view.title === 'string') {
                  const ru = getDictTranslation(dict, view.title);
                  if (ru && ru !== view.title) {
                    view.title = ru;
                    changed = true;
                  }
                }
              }
            }
          }
          if (changed) {
            backupFile(sidecarJsonPath, `builtin_${pluginEnt.name}_${scEnt.name}_sidecar_json`);
            if (!dryRun) {
              fs.writeFileSync(sidecarJsonPath, JSON.stringify(sc, null, 2) + '\n', 'utf8');
            }
            modifiedFiles++;
          }
        } catch {}
      }

      const indexHtmlPath = path.join(scRoot, 'index.html');
      if (fs.existsSync(indexHtmlPath)) {
        try {
          const origHtmlPath = `${indexHtmlPath}.orig`;
          const baseHtml = fs.existsSync(origHtmlPath)
            ? fs.readFileSync(origHtmlPath, 'utf8')
            : fs.readFileSync(indexHtmlPath, 'utf8');
          const translated = translateHtml(baseHtml, dict);
          const nextHtml = injectHtmlDomRuntime(translated.html, dict);
          const curHtml = fs.readFileSync(indexHtmlPath, 'utf8');
          if (nextHtml !== curHtml) {
            backupFile(indexHtmlPath, `builtin_${pluginEnt.name}_${scEnt.name}_index_html`);
            if (!dryRun) {
              fs.writeFileSync(indexHtmlPath, nextHtml, 'utf8');
            }
            modifiedFiles++;
          }
        } catch {}
      }
    }
  }

  return { patched: modifiedFiles > 0, modifiedFiles };
}

/**
 * Восстанавливает оригинальные файлы встроенных плагинов из резервных копий .orig.
 */
function restoreBuiltinPlugins(builtinDir) {
  return restoreMarketplaceCache(builtinDir || getDefaultBuiltinPluginsDir());
}

module.exports = {
  DEVELOPER_KNOWLEDGE_README_RU,
  GSLIDES_README_RU,
  GEMINI_API_README_RU,
  CONTEXT7_README_RU,
  getDefaultMarketplacesDir,
  getDefaultBuiltinPluginsDir,
  patchMarketplaceCache,
  restoreMarketplaceCache,
  patchBuiltinPlugins,
  restoreBuiltinPlugins,
};
