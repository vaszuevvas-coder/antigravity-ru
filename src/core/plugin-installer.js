'use strict';

const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const http = require('node:http');

const PLUGIN_FOLDER_NAME = 'antigravity-ru-agent';
const RUSSIFIER_ROOT = path.resolve(__dirname, '..', '..');
const SOURCE_PLUGIN_DIR = path.join(RUSSIFIER_ROOT, 'plugin', PLUGIN_FOLDER_NAME);

/**
 * Рекурсивное копирование директории.
 */
function copyDirSync(src, dest) {
  fs.mkdirSync(dest, { recursive: true });
  const entries = fs.readdirSync(src, { withFileTypes: true });
  for (const entry of entries) {
    const srcPath = path.join(src, entry.name);
    const destPath = path.join(dest, entry.name);
    if (entry.isDirectory()) {
      copyDirSync(srcPath, destPath);
    } else if (entry.isFile()) {
      fs.copyFileSync(srcPath, destPath);
    }
  }
}

/**
 * Пытается уведомить локальный Language Server Google Antigravity о включении/выключении плагина
 * по документированному RPC JetboxWriteState (если переменные окружения активны).
 * @param {boolean} enabled
 * @returns {Promise<boolean>}
 */
function notifyLanguageServerPluginState(enabled) {
  return new Promise((resolve) => {
    const lsAddress = process.env.ANTIGRAVITY_LS_ADDRESS;
    const csrfToken = process.env.ANTIGRAVITY_CSRF_TOKEN;
    if (!lsAddress || !csrfToken) {
      resolve(false);
      return;
    }

    const [host, portStr] = lsAddress.split(':');
    const port = Number(portStr);
    if (!host || !port) {
      resolve(false);
      return;
    }

    const payload = JSON.stringify({
      userConfig: {
        plugins: {
          [PLUGIN_FOLDER_NAME]: { enabled: Boolean(enabled) },
        },
      },
    });

    const req = http.request(
      {
        hostname: host,
        port,
        path: '/exa.language_server_pb.LanguageServerService/JetboxWriteState',
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(payload),
          'x-codeium-csrf-token': csrfToken,
        },
        timeout: 1500,
      },
      (res) => {
        res.resume();
        resolve(res.statusCode >= 200 && res.statusCode < 300);
      }
    );

    req.on('error', () => resolve(false));
    req.on('timeout', () => {
      req.destroy();
      resolve(false);
    });
    req.write(payload);
    req.end();
  });
}

/**
 * Считывает активные настройки уже установленного плагина antigravity-ru-agent по содержимому rules/AGENTS.md.
 * @param {string} pluginDir
 */
function inspectAgentPluginSettings(pluginDir) {
  const defaults = {
    tokenEconomy: true,
    russianThinking: false,
    russianCodeComments: false,
  };

  try {
    const rulesPath = path.join(pluginDir, 'rules', 'AGENTS.md');
    if (!fs.existsSync(rulesPath)) return defaults;
    const text = fs.readFileSync(rulesPath, 'utf8');
    return {
      tokenEconomy: /## 4\. Экономия токенов без потери качества/.test(text),
      russianThinking: /на \*\*русском языке\*\* с (?:самого )?первого предложения/.test(text),
      russianCodeComments: /Режим русских комментариев в коде/.test(text),
    };
  } catch {
    return defaults;
  }
}

/**
 * Устанавливает или обновляет плагин русификации ИИ-агента и артефактов в ~/.gemini/config/plugins/antigravity-ru-agent.
 *
 * @param {{
 *   geminiConfigDir?: string,
 *   tokenEconomy?: boolean,
 *   russianThinking?: boolean,
 *   russianCodeComments?: boolean,
 *   dryRun?: boolean
 * }} [options]
 */
async function installAgentPlugin(options = {}) {
  const {
    geminiConfigDir = path.join(os.homedir(), '.gemini', 'config'),
    tokenEconomy = true,
    russianThinking = false,
    russianCodeComments = false,
    dryRun = false,
  } = options;

  const targetPluginDir = path.join(geminiConfigDir, 'plugins', PLUGIN_FOLDER_NAME);
  const alreadyExisted = fs.existsSync(path.join(targetPluginDir, 'plugin.json'));
  const appliedSettings = {
    tokenEconomy: Boolean(tokenEconomy),
    russianThinking: Boolean(russianThinking),
    russianCodeComments: Boolean(russianCodeComments),
  };

  if (dryRun) {
    return {
      installed: true,
      dryRun: true,
      pluginDir: targetPluginDir,
      alreadyExisted,
      restartRequired: !alreadyExisted,
      liveRpcUpdated: false,
      settings: appliedSettings,
    };
  }

  copyDirSync(SOURCE_PLUGIN_DIR, targetPluginDir);

  // Проставляем фактический путь к русификатору в навыке ru-ui-update
  const uiSkillPath = path.join(targetPluginDir, 'skills', 'ru-ui-update', 'SKILL.md');
  if (fs.existsSync(uiSkillPath)) {
    const normalizedRoot = RUSSIFIER_ROOT.replace(/\\/g, '/');
    const content = fs.readFileSync(uiSkillPath, 'utf8').replace(/\{\{RUSSIFIER_ROOT\}\}/g, normalizedRoot);
    fs.writeFileSync(uiSkillPath, content, 'utf8');
  }

  // Настройка режима внутренних размышлений, русских комментариев в коде и экономии токенов
  const rulesPath = path.join(targetPluginDir, 'rules', 'AGENTS.md');
  if (fs.existsSync(rulesPath)) {
    let rulesText = fs.readFileSync(rulesPath, 'utf8');

    if (russianThinking) {
      rulesText = rulesText.replace(
        /- \*\*Компактный аналитический режим \(`thinking`\)\*\*:[^\r\n]*/,
        '- **Цепочка рассуждений (`thinking` / Chain-of-Thought)**: веди внутренние рассуждения тезисно и без воды на **русском языке** с первого предложения (имена файлов, идентификаторы кода и флаги команд оставляй в оригинале).'
      );
    }

    if (russianCodeComments) {
      const commentRule =
        '\n- **Режим русских комментариев в коде (активен)**: при написании нового кода добавляй поясняющие комментарии и docstrings на русском языке (сохраняя нетронутыми чужие старые комментарии).';
      if (rulesText.includes('\n\n## 4.')) {
        rulesText = rulesText.replace('\n\n## 4.', `${commentRule}\n\n## 4.`);
      } else {
        rulesText = `${rulesText.trimEnd()}${commentRule}\n`;
      }
    }

    if (!tokenEconomy) {
      rulesText = rulesText
        .replace(' и экономии токенов', '')
        .replace(/\r?\n\r?\n## 4\. Экономия токенов без потери качества[\s\S]*$/, '\n');
    }

    fs.writeFileSync(rulesPath, rulesText.trimEnd() + '\n', 'utf8');
  }

  const liveRpcUpdated = await notifyLanguageServerPluginState(true);

  return {
    installed: true,
    dryRun: false,
    pluginDir: targetPluginDir,
    alreadyExisted,
    restartRequired: !alreadyExisted,
    liveRpcUpdated,
    settings: appliedSettings,
  };
}

/**
 * Удаляет плагин русификации ИИ-агента из ~/.gemini/config/plugins/antigravity-ru-agent.
 * @param {{ geminiConfigDir?: string }} [options]
 */
async function uninstallAgentPlugin(options = {}) {
  const { geminiConfigDir = path.join(os.homedir(), '.gemini', 'config') } = options;
  const targetPluginDir = path.join(geminiConfigDir, 'plugins', PLUGIN_FOLDER_NAME);

  if (!fs.existsSync(targetPluginDir)) {
    return {
      removed: false,
      pluginDir: targetPluginDir,
      message: 'Плагин antigravity-ru-agent не установлен.',
    };
  }

  // Согласно документации плагинов Antigravity, перед удалением оставляем enabled: true, чтобы не оставалось зависшего disabled-ключа
  await notifyLanguageServerPluginState(true);
  fs.rmSync(targetPluginDir, { recursive: true, force: true });

  return {
    removed: true,
    pluginDir: targetPluginDir,
    message: 'Плагин русификации ИИ-агента успешно удалён.',
  };
}

module.exports = {
  PLUGIN_FOLDER_NAME,
  RUSSIFIER_ROOT,
  SOURCE_PLUGIN_DIR,
  inspectAgentPluginSettings,
  installAgentPlugin,
  uninstallAgentPlugin,
};
