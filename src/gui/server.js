'use strict';

const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawn, execFile } = require('node:child_process');

const { detectEnvironment, inspectTargetDirectory } = require('../core/detector');
const { loadDictionary, saveUserOverride } = require('../core/dictionary');
const { patchInstallation, restoreInstallation, extractCandidatesFromInstallation } = require('../core/patcher');
const { installAgentPlugin, uninstallAgentPlugin } = require('../core/plugin-installer');

const PUBLIC_DIR = path.join(__dirname, 'public');

const MIME_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.json': 'application/json; charset=utf-8',
};

function readJsonBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > 2 * 1024 * 1024) {
        reject(new Error('Превышен допустимый размер запроса'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      try {
        const raw = Buffer.concat(chunks).toString('utf8');
        resolve(raw ? JSON.parse(raw) : {});
      } catch {
        reject(new Error('Некорректный формат JSON'));
      }
    });
    req.on('error', reject);
  });
}

function sendJson(res, statusCode, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(statusCode, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'Content-Length': Buffer.byteLength(body),
  });
  res.end(body);
}

/**
 * Вызывает стандартное системное окно выбора папки в Windows (через встроенный .NET FolderBrowserDialog).
 * @returns {Promise<string | null>}
 */
function pickFolderNativeDialog() {
  return new Promise((resolve) => {
    if (process.platform !== 'win32') {
      resolve(null);
      return;
    }

    const psScript = [
      '[Console]::OutputEncoding = [System.Text.Encoding]::UTF8',
      'Add-Type -AssemblyName System.Windows.Forms',
      '$dlg = New-Object System.Windows.Forms.FolderBrowserDialog',
      '$dlg.Description = "Выберите папку установки Google Antigravity 2.0 или Antigravity IDE"',
      '$dlg.ShowNewFolderButton = $false',
      'if ($dlg.ShowDialog() -eq [System.Windows.Forms.DialogResult]::OK) { Write-Output $dlg.SelectedPath }',
    ].join('; ');

    execFile(
      'powershell.exe',
      ['-NoProfile', '-STA', '-ExecutionPolicy', 'Bypass', '-Command', psScript],
      { timeout: 120000, windowsHide: true },
      (err, stdout) => {
        if (err) {
          resolve(null);
          return;
        }
        const selected = String(stdout || '').trim();
        resolve(selected || null);
      }
    );
  });
}

/**
 * Открывает локальное GUI-окно в режиме отдельного десктопного приложения (--app) через Edge/Chrome или системный браузер.
 */
function openStandaloneAppWindow(url) {
  if (process.platform === 'win32') {
    const localAppData = process.env.LOCALAPPDATA || '';
    const programFiles = process.env.ProgramFiles || 'C:\\Program Files';
    const programFilesX86 = process.env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)';

    const appBrowsers = [
      path.join(programFilesX86, 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
      path.join(programFiles, 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
      path.join(programFiles, 'Google', 'Chrome', 'Application', 'chrome.exe'),
      path.join(programFilesX86, 'Google', 'Chrome', 'Application', 'chrome.exe'),
      localAppData ? path.join(localAppData, 'Google', 'Chrome', 'Application', 'chrome.exe') : '',
    ].filter(Boolean);

    for (const exe of appBrowsers) {
      if (fs.existsSync(exe)) {
        const child = spawn(exe, [`--app=${url}`, '--window-size=1020,760'], {
          detached: true,
          stdio: 'ignore',
        });
        child.unref();
        return { mode: 'app-window', executable: path.basename(exe) };
      }
    }

    const fallback = spawn('cmd.exe', ['/c', 'start', '', url], {
      detached: true,
      stdio: 'ignore',
    });
    fallback.unref();
    return { mode: 'browser', executable: 'default' };
  }

  if (process.platform === 'darwin') {
    const child = spawn('open', [url], { detached: true, stdio: 'ignore' });
    child.unref();
    return { mode: 'browser', executable: 'open' };
  }

  const child = spawn('xdg-open', [url], { detached: true, stdio: 'ignore' });
  child.unref();
  return { mode: 'browser', executable: 'xdg-open' };
}

/**
 * Запускает локальный сервер графического установщика на 127.0.0.1.
 *
 * @param {{
 *   port?: number,
 *   openWindow?: boolean,
 *   dictDir?: string,
 *   geminiConfigDir?: string,
 *   extraDirs?: string[]
 * }} [options]
 */
/**
 * Создаёт контроллер и HTTP-обработчик запросов GUI (удобно как для живого сервера, так и для модульных тестов в песочнице).
 */
function createGuiController(options = {}) {
  const {
    dictDir,
    geminiConfigDir,
    extraDirs = [],
    onShutdown = null,
  } = options;

  const sessionToken = crypto.randomBytes(24).toString('hex');
  const customDirs = new Set(extraDirs.map((d) => path.resolve(d)));

  const handler = async (req, res) => {
    try {
      const parsedUrl = new URL(req.url || '/', 'http://127.0.0.1');
      const pathname = parsedUrl.pathname;

      // API маршруты защищены сессионным токеном
      if (pathname.startsWith('/api/')) {
        const headerToken = req.headers['x-session-token'];
        if (headerToken !== sessionToken) {
          sendJson(res, 403, { ok: false, error: 'Недействительный токен сессии.' });
          return;
        }

        if (req.method === 'GET' && pathname === '/api/state') {
          const env = detectEnvironment({ extraDirs: [...customDirs], geminiConfigDir });
          const dict = loadDictionary(dictDir);
          sendJson(res, 200, {
            ok: true,
            environment: env,
            dictionary: {
              totalCount: dict.totalCount,
              overridesCount: Object.keys(dict.userOverrides).length,
              categories: dict.categories,
              userOverrides: dict.userOverrides,
            },
          });
          return;
        }

        if (req.method === 'POST' && pathname === '/api/add-dir') {
          const body = await readJsonBody(req);
          let dirPath = body.dirPath ? String(body.dirPath).trim() : '';
          if (body.browseNative) {
            const picked = await pickFolderNativeDialog();
            if (!picked) {
              sendJson(res, 200, { ok: true, cancelled: true });
              return;
            }
            dirPath = picked;
          }

          if (!dirPath) {
            sendJson(res, 400, { ok: false, error: 'Укажите путь к папке установки.' });
            return;
          }

          const info = inspectTargetDirectory(dirPath);
          if (!info) {
            sendJson(res, 400, {
              ok: false,
              error: `В папке «${dirPath}» не найдена структура Google Antigravity (ожидается папка resources/app.asar или resources/app/product.json).`,
            });
            return;
          }

          customDirs.add(info.installRoot);
          sendJson(res, 200, { ok: true, installation: info });
          return;
        }

        if (req.method === 'POST' && pathname === '/api/install') {
          const body = await readJsonBody(req);
          const dryRun = Boolean(body.dryRun);
          const installDirs = Array.isArray(body.installDirs) ? body.installDirs : [];
          const enableAgentPlugin = Boolean(body.enableAgentPlugin);
          const tokenEconomy = body.tokenEconomy !== false;
          const russianThinking = Boolean(body.russianThinking);
          const russianCodeComments = Boolean(body.russianCodeComments);
          const configureLocale = body.configureLocale !== false;
          const patchExeIntegrity = Boolean(body.patchExeIntegrity);

          const dict = loadDictionary(dictDir);
          const uiResults = [];
          const errors = [];

          for (const dir of installDirs) {
            try {
              const resPatch = patchInstallation(dir, dict, {
                dryRun,
                configureLocale,
                patchExeIntegrity,
              });
              uiResults.push(resPatch);
            } catch (err) {
              errors.push({ dir, message: err.message });
            }
          }

          let pluginResult = null;
          if (enableAgentPlugin) {
            try {
              pluginResult = await installAgentPlugin({
                geminiConfigDir,
                tokenEconomy,
                russianThinking,
                russianCodeComments,
                dryRun,
              });
            } catch (err) {
              errors.push({ dir: 'agent-plugin', message: `Ошибка установки плагина агента: ${err.message}` });
            }
          }

          sendJson(res, 200, {
            ok: errors.length === 0,
            dryRun,
            uiResults,
            pluginResult,
            errors,
          });
          return;
        }

        if (req.method === 'POST' && pathname === '/api/restore') {
          const body = await readJsonBody(req);
          const installDirs = Array.isArray(body.installDirs) ? body.installDirs : [];
          const removeAgentPlugin = Boolean(body.removeAgentPlugin);

          const restoreResults = [];
          const errors = [];

          for (const dir of installDirs) {
            try {
              const r = restoreInstallation(dir);
              restoreResults.push({ dir, ...r });
            } catch (err) {
              errors.push({ dir, message: err.message });
            }
          }

          let pluginResult = null;
          if (removeAgentPlugin) {
            try {
              pluginResult = await uninstallAgentPlugin({ geminiConfigDir });
            } catch (err) {
              errors.push({ dir: 'agent-plugin', message: err.message });
            }
          }

          sendJson(res, 200, {
            ok: errors.length === 0,
            restoreResults,
            pluginResult,
            errors,
          });
          return;
        }

        if (req.method === 'POST' && pathname === '/api/override') {
          const body = await readJsonBody(req);
          const updatedDict = saveUserOverride(body.sourceEn, body.targetRu, dictDir);
          sendJson(res, 200, {
            ok: true,
            totalCount: updatedDict.totalCount,
            overridesCount: Object.keys(updatedDict.userOverrides).length,
            userOverrides: updatedDict.userOverrides,
          });
          return;
        }

        if (req.method === 'POST' && pathname === '/api/extract') {
          const body = await readJsonBody(req);
          if (!body.dirPath) {
            sendJson(res, 400, { ok: false, error: 'Выберите папку установки для сканирования.' });
            return;
          }
          const dict = loadDictionary(dictDir);
          const extracted = extractCandidatesFromInstallation(body.dirPath, dict);
          sendJson(res, 200, {
            ok: true,
            ...extracted,
            candidates: extracted.candidates.slice(0, 300),
          });
          return;
        }

        if (req.method === 'POST' && pathname === '/api/shutdown') {
          sendJson(res, 200, { ok: true });
          if (typeof onShutdown === 'function') {
            onShutdown();
          }
          return;
        }

        sendJson(res, 404, { ok: false, error: 'Маршрут API не найден' });
        return;
      }

      // Отдача логотипа плагина для шапки GUI
      if (pathname === '/logo.svg') {
        const logoPath = path.resolve(__dirname, '..', '..', 'plugin', 'antigravity-ru-agent', 'assets', 'logo.svg');
        const svg = fs.readFileSync(logoPath);
        res.writeHead(200, { 'Content-Type': 'image/svg+xml', 'Cache-Control': 'no-cache' });
        res.end(svg);
        return;
      }

      // Статические файлы интерфейса
      const safeRel = pathname === '/' ? 'index.html' : pathname.replace(/^\/+/, '');
      const filePath = path.resolve(PUBLIC_DIR, safeRel);
      if (!filePath.startsWith(PUBLIC_DIR) || !fs.existsSync(filePath) || !fs.statSync(filePath).isFile()) {
        res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
        res.end('404 Не найдено');
        return;
      }

      const ext = path.extname(filePath).toLowerCase();
      let content = fs.readFileSync(filePath);
      if (ext === '.html') {
        // Встраиваем одноразовый сессионный токен прямо в HTML при отдаче
        const htmlStr = content.toString('utf8').replace('__SESSION_TOKEN__', sessionToken);
        content = Buffer.from(htmlStr, 'utf8');
      }

      res.writeHead(200, {
        'Content-Type': MIME_TYPES[ext] || 'application/octet-stream',
        'Cache-Control': 'no-store',
      });
      res.end(content);
    } catch (err) {
      sendJson(res, 500, { ok: false, error: err.message || 'Внутренняя ошибка сервера' });
    }
  };

  return { sessionToken, customDirs, handler };
}

/**
 * Запускает локальный сервер графического установщика на 127.0.0.1.
 */
function startGuiServer(options = {}) {
  const { port = 0, openWindow = true } = options;
  let serverRef = null;
  const controller = createGuiController({
    ...options,
    onShutdown: () => {
      setTimeout(() => {
        if (serverRef) {
          serverRef.close(() => process.exit(0));
        }
      }, 150);
    },
  });

  const server = http.createServer(controller.handler);
  serverRef = server;

  return new Promise((resolve, reject) => {
    server.on('error', reject);
    server.listen(port, '127.0.0.1', () => {
      const addr = server.address();
      const url = `http://127.0.0.1:${addr.port}/`;
      let launchInfo = null;
      if (openWindow) {
        try {
          launchInfo = openStandaloneAppWindow(url);
        } catch {
          launchInfo = { mode: 'manual', executable: null };
        }
      }
      resolve({
        server,
        port: addr.port,
        url,
        sessionToken: controller.sessionToken,
        launchInfo,
      });
    });
  });
}

module.exports = {
  createGuiController,
  startGuiServer,
};
