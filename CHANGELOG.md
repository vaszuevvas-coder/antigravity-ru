# История изменений (Changelog)

## [2.3.6] — Поддержка обновления Antigravity v2.34.0, 8 новых расширений Маркетплейса и GIF/Hive Swarm

### Исправлено и добавлено
- **Интерфейс Antigravity v2.34.0 (`embedded-ui/main.js` и `dom-runtime.js`)**:
  - переведены настройки **Оркестратора** (`Orchestrator Settings`, `Orchestrator Model`, `Executor Model` и их подробные описания) и подсказка глубины рассуждений (`Thinking effort`);
  - переведены элементы настройки и фильтрации **боковой панели** (`Customize Sidebar`, `Show Automation Conversations`, `Show Plugin Conversations`, `Show or Hide Plugins`, `Plugins Options`, `Filter and Sort`, `Filter plugins`, `Idle Conversations`, `Needs Input`, `Manual Order`, `Last Activity`, `Pinned`, `Show 5` / `Show 10`, `Select Sidebar Item 1–9`, `New conversation button`, `No plugins available`, `No sign-in required. This app is ready to use.`);
  - переведены параметры **песочницы и разрешений** (`Enable sandbox mode`, `Enable terminal sandbox`, `Terminal command auto execution`, `Commands outside sandbox`, `File access rules`, `Network access rules`, `Tool permissions`, `Permission approval scope`, `Permission preset`, `Security preset`, `Command setup script`, `Runtime permission`);
  - переведены новые строки поля ввода, черновиков, карточек ответов и автоматизаций (`Enter to send`, `Unsent draft`, `Instead of queueing…`, `Tell the agent what to do instead...`, `Resolved in chat`, `Retry requested`, `Ask to retry`, `Deny with note`, `New automation`, `Failed to create automation.`, сообщения `browserStream`).
- **Обновлённое расширение `Swarm` (`swarm_board/app.js`, `hive.js`)**:
  - добавлен перевод интерфейса **экспорта GIF-реплея** графа (`Export GIF`, `Exporting N%`, `Rendering …`, `Exported … (N frames · size)`, `Download …`, `GIF ready …`);
  - добавлены статические и динамические правила экрана **Hive/Overview** (`Fit the whole swarm`, `Message just sent`, `Swarm stalled — no agents working`, `Working for @…`, `Go to #N on the Board`, `Coordinator · A of B done`, `Shared … board …`, `Swarm start · N members`, таймеры `over …` / `for …` / `… ago` и подсказки копирования).
- **8 новых расширений Маркетплейса (`marketplace.json`)**:
  - переведены описания и 21 пример запроса для 7 официальных научных/Google-плагинов (**Google Health Developer**, **Google Home Developer**, **Chemistry**, **Genomics**, **Science Overview**, **Scientific Literature**, **Structural Biology**) и партнёрского плагина **n8n Skills**.
- **Оболочка Electron (`resources/app.asar` / `translator.js`)**:
  - добавлен перевод окна первичной настройки WSL (`dist/provisionSplash.js`) и подробных диалогов доступа к микрофону и входа в организацию (`dist/remote/remoteManager.js`).
- **Релиз v2.3.6**: словарь расширен (категория `v236_updates`), добавлен автотест #20, версия пакета, CLI и плагина `antigravity-ru-agent` повышена до **2.3.6**.

---

## [2.3.5] — Поддержка обновления Antigravity v2.33.1, экрана обзора Swarm и расширений Маркетплейса

### Исправлено и добавлено
- **Интерфейс Antigravity v2.33.1 (`embedded-ui/main.js` и `dom-runtime.js`)**:
  - переведены кнопки/подсказки паузы агента (`Pause this agent; it keeps its place and streams. Resume to continue.`), баннер выбора тем в настройках плагина (`Pick one of these themes under Preset in Settings > Appearance.`), предупреждение о дубликате имени (`An <type> with this name already exists…`), подсказки счётчика коннекторов (`N on for this conversation`), смены модели (`Agent: … Change it in the model menu.`), подтверждения ссылок (`links without asking`), иконки конструктора (`Sparkles`, `Wrench`, `Shield`, `Speedometer`, `Gauge`, `Eye`, `Flask`, `Radar`, `Bot`, `Robot`, `Sliders`, `Tree`, `Hub`) и действия с автоматизациями и проектами;
  - добавлена функция `translateSiblingTextGroup` для безопасного для React Fiber перевода составных текстовых узлов без разметки-обёртки (например, `An `, `extension`, ` with this name already exists...`).
- **Встроенное расширение `Swarm` (`swarm_board` / `hive.js` / `app.js`) и навык `swarm_pane`**:
  - добавлен перевод описания нового встроенного навыка `swarm_pane` и недостающих строк интерфейса обзора и удалённых досок (`Remote · N machines`, `N in review`, `Now · A / B`, `N posts since the view was updated`, `Last change: «…»`, `Give feedback on this item`, уведомления состояния `view.json`).
- **Официальные и партнёрские плагины Маркетплейса**:
  - переведены описания и промпты **Spacefast**, обновлённые промпты **invideo**, описания навыков **Gemini API v2.7.0 / v2.8.0** и агента/навыков **SonarQube v2.7.0** (локальные авторские плагины не затрагивались).
- **Оболочка Electron (`resources/app.asar` / `translator.js`)**:
  - добавлены динамические патчи для `dist/remote/remoteManager.js` (перезапуск SSH-сервера при смене версии, запрос микрофона, вход в организацию), `dist/webauthn.js` и `dist/main.js` (уведомление об удалённом дистрибутиве WSL).
- **Релиз v2.3.5**: словарь обновлён и расширен (дополнительно `48` записей в категории `v235_updates`), версия пакета, CLI и плагина `antigravity-ru-agent` повышена до **2.3.5**.

---

## [2.3.4] — Полная локализация новых функций Antigravity v2.33.0 и обновление плагина

### Исправлено и добавлено
- **Новые разделы и экраны Web UI (`embedded-ui/main.js`)**:
  - **Данные браузера и cookies**: `Browsing Data` → **«Данные браузера»**, `Clear Browsing Data?` → **«Очистить данные браузера?»**, `Cookies by Site` → **«Файлы cookie по сайтам»**, `Sites with cookies`, поиск по сайтам, предупреждения об очистке и динамические шаблоны (`Deleted cookies for …`, `Couldn't delete cookies for …`, `No sites match “…”`);
  - **Схема сочетаний клавиш**: `Keybinding Scheme` → **«Схема сочетаний клавиш»**, `VS Code Default`, `Antigravity (AGY) Style`, `Customize Shortcuts`, `Open Keyboard Shortcuts` и описания сочетаний;
  - **Браузерный агент и голосовой ввод**: `Enable Browser Agent`, `Voice dictation unavailable`, `Stop transcription`, `Transcribing audio…`, `Retrying transcription (attempt N)…`, `Microphone silent` / `Microphone problem`;
  - **Боковые вопросы и бандлы**: `Side Question Selection`, `Insert into main conversation`, `Unarchive the main conversation to insert`, `Review bundle before adding`, `Installed separately`, `No longer available`, `Removed from the marketplace…`;
  - **Динамические правила (`dom-runtime.js`)**: добавлены правила для скрытых хостов (`N hidden hosts`), черновиков (`N Drafts`), выбора группы (`Select all in …`), хуков и дубликатов ID/имён.
- **Оболочка Electron (`resources/app.asar` / `translator.js`)**:
  - добавлены точечные патчи для `dist/ideInstall/wizardHtml.js` (мастер установки Antigravity IDE), `dist/computer/hud.js`, `hudState.js`, `hudAgents.js` (Desktop HUD), `dist/remote/sshPrompts.js`, `remoteManager.js` (SSH-диалоги) и `dist/deviceChooser.js` (подключение WebHID/WebUSB/Serial).
- **Кэш маркетплейса (`marketplace-cache.js` / `ui-ru.json`)**:
  - переведены описания и примеры запросов (`suggestedPrompts`) для 5 новых партнёрских плагинов: **Clerk**, **ClickUp**, **Docusign**, **Scandit**, **TestMu AI**;
  - словарь расширен до **`5 163` уникальных записей** (добавлено `220` новых строк под v2.33.0), версия плагина `antigravity-ru-agent` обновлена до **2.3.4**.

---

## [2.3.3] — Локализация детальных страниц плагинов в «Кастомизации», документации Google Developer Knowledge и кэша маркетплейса

### Исправлено и добавлено
- **Полная локализация детальных страниц плагинов и кастомизаций (`plugin-detail`)**:
  - переведены все секции и заголовки вкладок: `Commands` → **«Команды»**, `Skills` → **«Навыки»**, `Agents` → **«Агенты»**, `MCP servers` → **«MCP-серверы»**, `Rules` → **«Правила»**, `Hooks` → **«Хуки»**, `UI extensions` → **«UI-расширения»**, `Automations` → **«Автоматизации»**, `Context Providers` → **«Провайдеры контекста»**, `Themes` → **«Темы»**;
  - переведены системные уведомления и действия: `Setup required` → **«Требуется настройка»**, `Sign in required.` → **«Требуется вход.»**, `Go to Accounts` → **«Перейти к аккаунтам»**, `Accounts tab` → **«Вкладка аккаунтов»**, `This plugin was force disabled.` → **«Этот плагин был принудительно отключен.»**, `Account connected.` → **«Аккаунт подключен.»**, `Connect an account so the agent can use this app.` → **«Подключите аккаунт, чтобы агент мог использовать это приложение.»**;
  - переведён подзаголовок плагина Google Developer Knowledge: *«Equip your agent with direct access to Google's official developer documentation...»* → *«Предоставьте вашему агенту прямой доступ к официальной документации и базе знаний разработчиков Google...»*.
- **Полная локализация документации `README.md` для плагинов маркетплейса**:
  - переведена вся документация плагина **Google Developer Knowledge** (Обзор, Аутентификация и настройка, Входящие компоненты, Примеры запросов, Ресурсы);
  - переведена документация **Google Slides**;
  - добавлен модуль `src/core/marketplace-cache.js`, автоматически обновляющий кэш каталогов `marketplace.json` и `README.md` в `~/.gemini/antigravity/cache/marketplaces/` при установке русификатора с созданием резервных копий (`.orig` / `manifest.externalFiles`) и безопасным откатом;
  - словарь расширен до **`4 108` уникальных записей** (`4 231` строка).

---

## [2.3.2] — Локализация строки ввода сообщений и приветствия в новых диалогах

### Исправлено и добавлено
- **Локализация начального плейсхолдера поля ввода чата**:
  - `Ask anything, @ to mention, / for actions` → **«Напишите задачу (@ — контекст, / — действия)»**;
  - `Ask anything, @ to mention` → **«Напишите задачу (@ — контекст)»**;
  - `Message subagent, @ to mention, / for actions` → **«Сообщение субагенту (@ — контекст, / — действия)»**;
  - `Message subagent, @ to mention` → **«Сообщение субагенту (@ — контекст)»**;
  - `Listening. Ask anything.` → **«Слушаю вас. Спросите о чём угодно.»**.
- **Локализация приветствия на домашнем экране и в новых диалогах (`home-greeting`)**:
  - `Hi <Name>, what can we get done today?` → **«Привет, <Name>! Какую задачу решим сегодня?»** (с поддержкой как латинских, так и русских имён профиля, например «Привет, Василий!»);
  - `What can we get done today?` → **«Какую задачу решим сегодня?»**;
  - скорректирована ранняя проверка кириллицы в `dom-runtime.js`, чтобы приветствия пользователей с русскими именами аккаунтов не отсекались до применения шаблонов;
  - словарь расширен до **`4 069` уникальных записей** (`4 176` строк).

---

## [2.3.1] — Локализация уведомлений об исчерпании квот и нехватке ИИ-кредитов (`Insufficient AI Credits`)

### Исправлено и добавлено
- **Локализация комбинированных уведомлений об исчерпании квоты модели и требовании ИИ-кредитов**:
  - добавлен динамический шаблон для тостов и всплывающих предупреждений вида `You need at least 50 AI Credits to send messages. To continue using Claude Sonnet 4.6 (Thinking) now, purchase more AI Credits. Your plan's baseline quota will refresh on 06.11.2026, 04:13:39.` → *«Для отправки сообщений требуется не менее 50 ИИ-кредитов. Чтобы продолжить использовать Claude Sonnet 4.6 (Thinking) сейчас, приобретите больше ИИ-кредитов. Базовая квота вашего тарифа обновится 06.11.2026, 04:13:39.»*;
  - добавлены шаблоны для альтернативных вариантов: с указанием `more` (*«больше ИИ-кредитов»*), опциональным предложением включить расход сверх квоты (*«To continue using this model now, enable AI Credit overages.»* → *«Чтобы продолжить использовать эту модель сейчас, включите расход ИИ-кредитов сверх квоты.»*) и предложением переключиться на другую модель (*«Switch to another available model to continue.»* → *«Переключитесь на другую доступную модель, чтобы продолжить.»*);
  - словарь расширен до **`4 062` уникальных записей** (`4 169` строк).

---

## [2.3.0] — Режим экономии токенов без потери качества и оптимизация внутренних рассуждений ИИ (`Thinking`)

### Добавлено и улучшено
- **Встроенный профиль экономии токенов без потери качества в плагине `antigravity-ru-agent` (`tokenEconomy: true` по умолчанию)**:
  - **Search-Then-Slice**: предварительный точечный поиск строк (`rg` / `Select-String`) и чтение узких срезов `StartLine`–`EndLine` вместо загрузки больших файлов целиком;
  - **Batching**: группировка независимых чтений и проверок в один параллельный пакет за ход;
  - **Делегирование разведки субагентам на лёгких моделях**: обход незнакомых участков кода через субагента `research` с `Model: "flash"` / `"flash_lite"` и компактным телеграфным ответом;
  - **Narration-Free и тихий терминал**: отказ от пустых вступлений и дублирования диффов в чате; тихие флаги для сборок и тестов с сохранением информативных стектрейсов ошибок.
- **Ускоренный компактный режим внутренних рассуждений (`Thinking`) по умолчанию (`russianThinking: false`)**:
  - внутренний черновик мыслей модели переведён на телеграфный технический английский без потери русских ответов, карточек шагов (`toolSummary`, `Role`) и артефактов — это экономит ~35–45% выходных токенов и ускоряет отклик;
  - при необходимости русскоязычный блок *«Размышлял...»* можно включить одной галочкой в GUI или флагом `--russian-thinking` в CLI (исправлено прежнее удаление русских подписей шагов при снятии галочки).
- **Сжаты описания навыков `/ru-docs` и `/ru-ui-update`** во frontmatter `SKILL.md` для уменьшения постоянного следа в системном промпте.
- **Обновлены GUI, CLI и детектор окружения**: добавлены чекбокс `chkTokenEconomy`, автосинхронизация галочек GUI с уже установленным `AGENTS.md`, а также флаги CLI `--token-economy` / `--no-token-economy`, `--compact-thinking` / `--russian-thinking` и `--agent-only`.

---

## [2.2.0] — Полная поддержка обновления Google Antigravity `v2.29.0` (Remote Agents, Cloud Resources, браузер, голосовой режим, шаги диалога)

### Добавлено и исправлено
- **Полная локализация всех новых функций и экранов Antigravity `v2.29.0`**: словарь расширен до **`4 057` уникальных записей** (`4 164` строки):
  - **Удалённые агенты (`Remote Agents`) и облачные ресурсы (`Cloud Resources`)**: переведены карточка анонса `Introducing Remote Agents`, модальное окно создания удалённого проекта (`Select Resource(s)`, `+ Add Resource`, `Uploaded files and connected resources are mounted in your cloud environment.`), окно раскрытия информации о хранении данных в облачной среде и раздел `Remote Agents Data` / `Delete All Remote Agents Data`;
  - **Контекстное меню проектов и рабочих областей**: переведены пункты `Copy Project Name` («Копировать название проекта»), `Copy Workspace Name`, `Delete Project` («Удалить проект»), `Delete Workspace`, `Archive Project` и связанные диалоги подтверждения удаления;
  - **Настройки встроенного браузера**: переведены разделы `Download Location` («Папка загрузок»), `Folder where files downloaded in the built-in browser are saved.`, кнопка `Change…` («Изменить…»), `Browsing History` («История браузера») и `Clear visited URLs and autocomplete suggestions from the built-in browser.`;
  - **Обновлённый голосовой режим (`Voice mode`)**: переведены `Voice mode` («Голосовой режим»), `Input device for voice mode and dictation.`, `The voice used in Voice mode. Powered by Gemini Live.`, `Save audio recordings`, `Only stored on your machine.`, характеристики голосов и динамические шаблоны (`Voice speed, 1.5x`, `Deleted N recordings`, `Started/Stopped voice chat`);
  - **Настройки Чата и Внешнего вида**: переведены `Chat` («Чат»), `Conversation Steps` («Шаги диалога»), `Choose how much detail is shown during a conversation.`, переключатель `Verbose` («Подробно»), `Screen Reader Mode`, `Terminal Placement` (`Bottom Panel` / `Side Panel`), `Context and Quota Indicator` и новые разделы `Cloud Permissions`, `New Conversation Button`, `Side Question` (`/btw`) и `Automations`.

---

## [2.1.1] — Полная локализация меню слеш-команд (`/`) и `@`-упоминаний в чате

### Добавлено и исправлено
- **Переведены все 13 встроенных системных слеш-команд** во всплывающем меню при вводе `/` в поле чата (`/goal`, `/compact`, `/schedule`, `/browser`, `/browser-vision`, `/plan`, `/grill-me`, `/teamwork`, `/learn`, `/boost`, `/deepagent`, `/review-agent`, `/btw`), которые загружаются напрямую из языкового сервера `language_server`.
- **Безопасный для React Fiber перевод при фильтрации по буквам после `/` и `@`**: в `dom-runtime.js` добавлена функция `translateFuzzySplitDescription`, которая склеивает описания, разбитые подсветкой `<span data-testid="fuzzy-match-highlight">`, и подставляет русский перевод без удаления DOM-узлов React, а также переводит длинные описания, усечённые слева символом `…`.
- **Переведены категории и подсказки меню `@`-упоминаний и встроенные субагенты**: `Code Context Items` («Элементы контекста кода»), `Directories` («Папки»), `recently opened`, `file results`, `from CLI`, `from IDE`, `to exit` (`esc для выхода`), описания субагентов `self`, `research`, `image-generator` и др. Словарь расширен до **`3 838` уникальных записей** (`3 912` строк).

---

## [2.1.0] — Полная локализация раздела «Кастомизация», Маркетплейса и всех 67 плагинов

### Добавлено и исправлено
- **100% перевод раздела «Кастомизация» (`Маркетплейс` и `Установлено`)**: словарь расширен до **`3 815` уникальных записей** (`3 884` строки с учётом вариантов экранирования):
  - переведены названия и подзаголовки всех **7 тематических полок Маркетплейса** (*Google Workspace*, *Разработка с Google*, *Дизайн, креатив и медиа*, *Продуктивность и управление проектами*, *Облачный хостинг и деплой*, *Инструменты разработчика*, *Бизнес*) и раздела *Наборы плагинов*;
  - переведены полные и краткие описания всех **67 официальных и партнёрских плагинов** каталога (*Notion*, *Google Docs/Sheets/Slides/Drive/Calendar*, *Gemini API*, *Chrome DevTools*, *Android CLI*, *Firebase*, *Vercel*, *Netlify*, *Railway*, *Auth0*, *Stripe*, *Supabase*, *Figma*, *Linear*, *Sentry*, *Databricks* и др.) и все **185 готовых промптов (`suggestedPrompts`)** на страницах плагинов;
  - переведены все **618 описаний команд, навыков (`SKILL.md`), субагентов и хуков** внутри всех 67 плагинов Маркетплейса, а также все **9 встроенных навыков** Antigravity;
  - переведён юридический дисклеймер сторонних инструментов разработки внизу страниц плагинов и раздела Маркетплейса с сохранением кликабельной ссылки на политику конфиденциальности.
- **Улучшен DOM-переводчик (`dom-runtime.js`)**:
  - лимит длины переводимых текстовых узлов и атрибутов увеличен с `2000` до **`4500` символов** для длинных описаний навыков и команд;
  - включено безусловное сопоставление по нормализованным пробелам (`COLLAPSED_EXACT`) за $O(1)$, чтобы многострочные YAML-описания навыков переводились независимо от переносов строк;
  - добавлены динамические шаблоны для кнопок раскрытия полок (`+ See 18 more` → `+ Показать ещё 18`, `See more in ...` / `See less in ...`), счётчиков токенов контекста (`Context usage`, `(N tokens)` → `(N токенов)`), карточек правил (`Rule N` → `Правило N`) и управления аккаунтами плагинов;
  - исправлен перевод мета-метки `"Developer"` на страницах плагинов и в настройках на **«Разработчик»**.

---

## [2.0.1] — Исправление перевода всех выпадающих меню и селекторов чата

### Исправлено и добавлено
- **Исправлен пропуск выпадающих меню в DOM-наблюдателе (`dom-runtime.js`)**: убраны подстрочные селекторы `[class*="material-symbols"]` и `[class*="codicon"]`, которые ложно срабатывали на произвольных модификаторах Tailwind вида `[&:has(>.material-symbols-outlined:first-child)]:pl-1.5` на пунктах меню («Добавить контекст», профили разрешений, выбор модели и уровня размышления). Защита шрифтовых иконок переведена на строгую проверку токенов классов (`.google-symbols`, `.material-symbols*`, `.codicon`).
- **Словарь расширен до `2 907` уникальных записей**: добавлены `Turbo` («Турбо»), уровни размышления моделей (`Low`, `Medium`, `High`, `Extra`, `Max`), режимы `Autonomous Mode` и `Best of N`, пункты `Screen Recording`, `Drive`, типы прикрепляемых файлов, уведомления Git Worktree и автоматизаций.
- Добавлена автоматическая нормализация типографского многоточия (`…` → `...`) и новые динамические шаблоны для селекторов разрешений и режимов.

---

## [2.0.0] — Полная локализация Antigravity 2.28+ и размышлений ИИ

### Добавлено
- **Полный словарь UI (`2808` уникальных записей)** по всем экранам и меню Google Antigravity 2.0 (v2.28+) и Antigravity IDE: «Общие», «Приложение», «Внешний вид», «Горячие клавиши» (~190 команд), «Уведомления», «Модели и использование», «Автоматизации», «Кастомизация», диалоги Git/WSL/браузера и артефактов.
- **Русификация внутренних размышлений ИИ (`Thinking` / Chain-of-Thought) и подписей шагов** в плагине `antigravity-ru-agent` с возможностью включения/отключения в графическом установщике.
- **Движок динамических шаблонов (55+ правил)** со склонением русских числительных и интервалов времени для квот моделей, таймеров обновления лимитов, счётчика ИИ-кредитов и таймеров размышлений (`Thought for 1.5s` → `Размышлял 1.5 с`).
- **Перехват нативных контекстных меню и системных уведомлений Electron** в `preload.js` до `contextBridge.exposeInMainWorld`, а также локализация меню системного трея (`dist/tray.js`, `dist/main.js`, `dist/wsl.js`).
- **Встроенный сканер UI-бандла `language_server`** для автоматического поиска новых строк после будущих обновлений Google Antigravity.

### Улучшено и исправлено
- Снято ограничение длины многострочных описаний настроек (лимит увеличен со 160 до 2000 символов).
- Добавлена защита названий клавиш внутри `<kbd>` (`Ctrl`, `Shift`, `Alt`, `Delete`) и шрифтовых лигатур иконок Material Symbols / Codicon (`close`, `check`, `refresh`).
- Ускорена таблица словаря в графическом установщике за счёт делегирования событий.

---

## [1.0.0] — Первый выпуск
- Графический установщик (GUI) и интерфейс командной строки (CLI) на чистом Node.js без внешних зависимостей.
- Бинарный патчер `app.asar` с пересчётом SHA-256 блоков целостности и `ElectronAsarIntegrity`.
- Поддержка Antigravity IDE (`package.nls.ru.json`, `argv.json`, пересчёт `product.json`).
- Автоматическое создание эталонного бэкапа и побайтовый откат в один клик.
