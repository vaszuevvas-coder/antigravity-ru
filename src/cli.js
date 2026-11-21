#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { detectEnvironment } = require('./core/detector');
const { loadDictionary } = require('./core/dictionary');
const { patchInstallation, restoreInstallation, extractCandidatesFromInstallation } = require('./core/patcher');
const { installAgentPlugin, uninstallAgentPlugin } = require('./core/plugin-installer');
const { startGuiServer } = require('./gui/server');

function parseArgs(argv) {
  const args = argv.slice(2);
  let command = 'gui';
  const flags = {
    dirs: [],
    target: 'all', // all | ui | plugin | app2 | ide
    dryRun: false,
    tokenEconomy: true,
    russianThinking: false,
    russianComments: false,
    patchIntegrity: true,
    noLocale: false,
    removePlugin: false,
    noOpen: false,
    port: 0,
    out: null,
    configDir: undefined,
  };

  let i = 0;
  if (args[0] && !args[0].startsWith('-')) {
    command = args[0].toLowerCase();
    i = 1;
  }

  for (; i < args.length; i++) {
    const a = args[i];
    if (a === '--help' || a === '-h') {
      command = 'help';
    } else if (a === '--dir' || a === '-d') {
      if (args[i + 1]) flags.dirs.push(args[++i]);
    } else if (a === '--target' || a === '-t') {
      if (args[i + 1]) flags.target = args[++i].toLowerCase();
    } else if (a === '--agent-only') {
      flags.target = 'plugin';
    } else if (a === '--dry-run' || a === '-n') {
      flags.dryRun = true;
    } else if (a === '--token-economy') {
      flags.tokenEconomy = true;
    } else if (a === '--no-token-economy') {
      flags.tokenEconomy = false;
    } else if (a === '--russian-thinking') {
      flags.russianThinking = true;
    } else if (a === '--compact-thinking' || a === '--no-russian-thinking') {
      flags.russianThinking = false;
    } else if (a === '--russian-comments') {
      flags.russianComments = true;
    } else if (a === '--patch-integrity') {
      flags.patchIntegrity = true;
    } else if (a === '--no-patch-integrity') {
      flags.patchIntegrity = false;
    } else if (a === '--no-locale') {
      flags.noLocale = true;
    } else if (a === '--remove-plugin') {
      flags.removePlugin = true;
    } else if (a === '--no-open') {
      flags.noOpen = true;
    } else if (a === '--port') {
      if (args[i + 1]) flags.port = Number(args[++i]) || 0;
    } else if (a === '--out' || a === '-o') {
      if (args[i + 1]) flags.out = args[++i];
    } else if (a === '--config-dir') {
      if (args[i + 1]) flags.configDir = args[++i];
    }
  }

  return { command, flags };
}

function printHelp() {
  console.log(`
Русификатор Google Antigravity (v2.3.6)
Поддержка: Antigravity 2.0 (Electron), Antigravity IDE (VS Code) и ИИ-агент

Использование:
  node src/cli.js [команда] [параметры]

Команды:
  gui                  Запустить графический установщик (по умолчанию)
  status               Показать найденные установки, бэкапы и статус плагина агента
  install (или apply)  Создать бэкап и применить русификатор UI + плагин ИИ-агента
  restore (или rollback) Восстановить оригинальные файлы из резервной копии
  extract              Найти непереведённые английские строки UI в папке программы
  help                 Показать эту справку

Параметры:
  --dir, -d <путь>     Указать папку установки Antigravity вручную (можно несколько раз)
  --target, -t <режим> Что русифицировать: all (всё), ui, plugin, app2, ide
  --agent-only         Установить только плагин ИИ-агента (аналог --target plugin)
  --dry-run, -n        Пробный запуск без изменения файлов на диске
  --token-economy      Включить профиль экономии токенов без потери качества (по умолчанию)
  --no-token-economy   Отключить секцию экономии токенов в AGENTS.md
  --compact-thinking   Компактный аналитический EN-режим внутренних рассуждений (по умолчанию)
  --russian-thinking   Вести внутренние размышления ИИ (Thinking) на русском языке
  --russian-comments   Включить правило русских комментариев для нового кода в плагине
  --patch-integrity    Обновить хеш ElectronAsarIntegrity при патчинге app.asar
  --remove-plugin      При команде restore также удалить плагин antigravity-ru-agent
  --out, -o <файл>     Сохранить результат команды extract в JSON-файл
`);
}

async function main() {
  const { command, flags } = parseArgs(process.argv);

  if (command === 'help') {
    printHelp();
    return;
  }

  if (command === 'gui') {
    const info = await startGuiServer({
      port: flags.port,
      openWindow: !flags.noOpen,
      extraDirs: flags.dirs,
      geminiConfigDir: flags.configDir,
    });
    console.log('==============================================================');
    console.log(' Графический установщик русификатора Google Antigravity запущен');
    console.log(` Адрес окна: ${info.url}`);
    console.log(' Закройте окно установщика или нажмите Ctrl+C для завершения.');
    console.log('==============================================================');
    return;
  }

  const dict = loadDictionary();
  const env = detectEnvironment({ extraDirs: flags.dirs, geminiConfigDir: flags.configDir });

  if (command === 'status') {
    console.log(`\nСловарь интерфейса: ${dict.totalCount} строк (переопределений: ${Object.keys(dict.userOverrides).length})`);
    console.log(`Плагин ИИ-агента (${env.agentConfig.pluginDir}): ${env.agentConfig.installed ? 'УСТАНОВЛЕН' : 'НЕ УСТАНОВЛЕН'}`);
    if (env.agentConfig.installed && env.agentConfig.settings) {
      const s = env.agentConfig.settings;
      console.log(
        `  Профиль плагина: экономия токенов — ${s.tokenEconomy ? 'ВКЛ' : 'ВЫКЛ'}, ` +
          `Thinking — ${s.russianThinking ? 'RU (русский)' : 'EN (компактный быстрый)'}, ` +
          `комментарии в коде — ${s.russianCodeComments ? 'RU' : 'по стандарту проекта'}`
      );
    }
    console.log('\nОбнаруженные программы Google Antigravity:');
    if (env.installations.length === 0) {
      console.log('  - В стандартных путях не найдено (передайте путь через --dir "<путь>")');
    } else {
      for (const inst of env.installations) {
        const stateStr = inst.patched
          ? `РУСИФИЦИРОВАНО (${inst.patchedStringsCount} замен)`
          : 'ОРИГИНАЛ (EN)';
        console.log(`  - ${inst.label} v${inst.version}`);
        console.log(`    Путь:   ${inst.installRoot}`);
        console.log(`    Статус: ${stateStr}${inst.hasBackup ? ' [есть бэкап]' : ''}`);
      }
    }
    return;
  }

  if (command === 'install' || command === 'apply') {
    const doUi = ['all', 'ui', 'app2', 'ide'].includes(flags.target);
    const doPlugin = ['all', 'plugin'].includes(flags.target);

    if (flags.dryRun) {
      console.log('[РЕЖИМ ПРОВЕРКИ DRY-RUN] Файлы на диске изменены не будут.\n');
    }

    if (doUi) {
      const targets = env.installations.filter((inst) => {
        if (flags.target === 'app2') return inst.kind === 'app2';
        if (flags.target === 'ide') return inst.kind === 'ide';
        return true;
      });

      if (targets.length === 0) {
        console.log('Папки установки программ не найдены автоматически. При необходимости укажите --dir "<путь>".');
      } else {
        for (const inst of targets) {
          const res = patchInstallation(inst.installRoot, dict, {
            dryRun: flags.dryRun,
            patchExeIntegrity: flags.patchIntegrity,
            configureLocale: !flags.noLocale,
          });
          console.log(
            `${flags.dryRun ? '[Dry-Run]' : '[UI ОК]'} ${res.label}: обновлено файлов — ${res.patchedFilesCount}, записей словаря — ${res.totalReplacements}` +
              (res.domRuntimeInjected ? `, Web UI preload — ДА` : '') +
              (res.integrityHashUpdated ? `, ASAR Integrity — обновлён` : '') +
              (res.createdFilesCount ? `, создано NLS RU — ${res.createdFilesCount}` : '') +
              (res.updatedChecksumsCount ? `, обновлено чексумм product.json — ${res.updatedChecksumsCount}` : '')
          );
          for (const w of res.warnings) {
            console.log(`  [Внимание] ${w}`);
          }
        }
      }
    }

    if (doPlugin) {
      const pRes = await installAgentPlugin({
        geminiConfigDir: flags.configDir,
        tokenEconomy: flags.tokenEconomy,
        russianThinking: flags.russianThinking,
        russianCodeComments: flags.russianComments,
        dryRun: flags.dryRun,
      });
      const modeDesc =
        `экономия токенов: ${pRes.settings.tokenEconomy ? 'ВКЛ' : 'ВЫКЛ'}, ` +
        `Thinking: ${pRes.settings.russianThinking ? 'RU' : 'EN компактный'}, ` +
        `RU-комментарии: ${pRes.settings.russianCodeComments ? 'ВКЛ' : 'ВЫКЛ'}`;
      console.log(`${flags.dryRun ? '[Dry-Run]' : '[Плагин ОК]'} Путь: ${pRes.pluginDir} (${modeDesc})`);
      if (!flags.dryRun && pRes.restartRequired) {
        console.log('  -> Перезапустите Google Antigravity для подгрузки нового плагина и обновлённого интерфейса.');
      }
    }
    return;
  }

  if (command === 'restore' || command === 'rollback') {
    const dirsToRestore = flags.dirs.length > 0 ? flags.dirs : env.installations.map((i) => i.installRoot);
    for (const dir of dirsToRestore) {
      const r = restoreInstallation(dir);
      console.log(`[Откат UI] ${dir}: ${r.message}`);
    }
    if (flags.removePlugin) {
      const p = await uninstallAgentPlugin({ geminiConfigDir: flags.configDir });
      console.log(`[Откат плагина] ${p.message}`);
    }
    return;
  }

  if (command === 'extract') {
    const targetDir = flags.dirs[0] || (env.installations[0] && env.installations[0].installRoot);
    if (!targetDir) {
      throw new Error('Укажите папку установки через --dir "<путь>" для извлечения непереведённых строк.');
    }
    const extracted = extractCandidatesFromInstallation(targetDir, dict);
    console.log(`Найдено кандидатов для перевода в ${extracted.label}: ${extracted.count}`);
    const outPath = flags.out || path.resolve(__dirname, '..', 'dictionaries', 'untranslated-candidates.json');
    fs.writeFileSync(outPath, JSON.stringify(extracted, null, 2) + '\n', 'utf8');
    console.log(`Список сохранён в: ${outPath}`);
    return;
  }

  throw new Error(`Неизвестная команда: "${command}". Запустите с --help для справки.`);
}

if (require.main === module) {
  main().catch((err) => {
    console.error(`\n[ОШИБКА] ${err.message}`);
    process.exit(1);
  });
}

module.exports = { parseArgs, main };
