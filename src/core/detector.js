'use strict';

const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { readAsarHeader, listAsarEntries } = require('./asar');
const { inspectAgentPluginSettings } = require('./plugin-installer');

const BACKUP_DIR_NAME = '.antigravity-ru-backup';

/**
 * Нормализует путь установки (учитывая macOS .app и случай, когда пользователь выбрал подпапку resources).
 * @param {string} inputDir
 */
function normalizeInstallRoot(inputDir) {
  let dir = path.resolve(inputDir);
  if (path.basename(dir).toLowerCase() === 'resources') {
    dir = path.dirname(dir);
  }
  if (process.platform === 'darwin' && dir.endsWith('.app')) {
    const macContents = path.join(dir, 'Contents');
    if (fs.existsSync(macContents)) return macContents;
  }
  return dir;
}

/**
 * Определяет наличие встроенной проверки целостности ElectronAsarIntegrity в исполняемом файле / Info.plist (только чтение).
 * @param {string} installRoot
 * @param {string | null} currentHeaderHash
 */
function detectEmbeddedIntegrity(installRoot, currentHeaderHash) {
  try {
    // macOS Info.plist
    const plistPath = path.join(installRoot, 'Info.plist');
    if (fs.existsSync(plistPath)) {
      const plist = fs.readFileSync(plistPath, 'utf8');
      if (plist.includes('ElectronAsarIntegrity')) {
        return {
          present: true,
          carrierPath: plistPath,
          carrierType: 'plist',
          matchesCurrentHeader: currentHeaderHash ? plist.includes(currentHeaderHash) : false,
        };
      }
    }

    // Windows .exe в корне установки
    if (fs.existsSync(installRoot)) {
      const entries = fs.readdirSync(installRoot, { withFileTypes: true });
      for (const entry of entries) {
        if (entry.isFile() && entry.name.toLowerCase().endsWith('.exe') && !entry.name.toLowerCase().startsWith('unins')) {
          const exePath = path.join(installRoot, entry.name);
          const stat = fs.statSync(exePath);
          // Читаем только если размер разумный (до 300 МБ)
          if (stat.size > 0 && stat.size <= 300 * 1024 * 1024) {
            const buf = fs.readFileSync(exePath);
            if (buf.includes(Buffer.from('ELECTRONASAR', 'ascii')) || (currentHeaderHash && buf.includes(Buffer.from(currentHeaderHash, 'ascii')))) {
              return {
                present: true,
                carrierPath: exePath,
                carrierType: 'pe-exe',
                matchesCurrentHeader: currentHeaderHash ? buf.includes(Buffer.from(currentHeaderHash, 'ascii')) : false,
              };
            }
          }
        }
      }
    }
  } catch {
    // Ошибки чтения неблокирующие
  }
  return { present: false, carrierPath: null, carrierType: null, matchesCurrentHeader: false };
}

/**
 * Анализирует конкретную папку и определяет, установлена ли в ней Antigravity IDE или Antigravity 2.0.
 * @param {string} rawDir
 */
function inspectTargetDirectory(rawDir) {
  if (!rawDir) return null;
  const installRoot = normalizeInstallRoot(rawDir);
  if (!fs.existsSync(installRoot)) return null;

  const resourcesDir = fs.existsSync(path.join(installRoot, 'Resources'))
    ? path.join(installRoot, 'Resources')
    : path.join(installRoot, 'resources');

  if (!fs.existsSync(resourcesDir)) return null;

  const appDir = path.join(resourcesDir, 'app');
  const asarPath = path.join(resourcesDir, 'app.asar');
  const productJsonPath = path.join(appDir, 'product.json');
  const backupManifestPath = path.join(installRoot, BACKUP_DIR_NAME, 'manifest.json');

  let hasBackup = false;
  let backupMeta = null;
  if (fs.existsSync(backupManifestPath)) {
    try {
      backupMeta = JSON.parse(fs.readFileSync(backupManifestPath, 'utf8'));
      hasBackup = true;
    } catch {}
  }

  // Случай 1: Antigravity IDE (архитектура VS Code: resources/app/product.json + out/ или extensions/)
  if (fs.existsSync(productJsonPath)) {
    let product = {};
    try {
      product = JSON.parse(fs.readFileSync(productJsonPath, 'utf8'));
    } catch {}
    const nameLong = product.nameLong || product.nameShort || path.basename(installRoot);
    const version = product.version || product.distroVersion || 'unknown';

    return {
      kind: 'ide',
      label: `Antigravity IDE (${nameLong})`,
      version,
      installRoot,
      resourcesDir,
      appDir,
      asarPath: fs.existsSync(asarPath) ? asarPath : null,
      productJsonPath,
      hasBackup,
      patched: Boolean(backupMeta && backupMeta.active),
      backupCreatedAt: backupMeta ? backupMeta.createdAt : null,
      patchedStringsCount: backupMeta ? backupMeta.totalReplacements || 0 : 0,
      integrityInfo: { present: false, carrierPath: null, carrierType: null, matchesCurrentHeader: false },
    };
  }

  // Случай 2: Antigravity 2.0 (Electron-приложение с resources/app.asar или распакованной resources/app)
  if (fs.existsSync(asarPath)) {
    let version = '2.0';
    let appName = 'Google Antigravity 2.0';
    let headerHash = null;
    try {
      const asarInfo = readAsarHeader(asarPath);
      headerHash = asarInfo.headerHash;
      const entries = listAsarEntries(asarInfo.header);
      const pkgEntry = entries.find((e) => e.relPath === 'package.json');
      if (pkgEntry && !pkgEntry.meta.unpacked && pkgEntry.meta.size < 1024 * 1024) {
        const fd = fs.openSync(asarPath, 'r');
        try {
          const buf = Buffer.alloc(pkgEntry.meta.size);
          fs.readSync(fd, buf, 0, buf.length, asarInfo.dataOffset + Number(BigInt(pkgEntry.meta.offset)));
          const pkg = JSON.parse(buf.toString('utf8'));
          if (pkg.version) version = pkg.version;
          if (pkg.productName || pkg.name) appName = pkg.productName || pkg.name;
        } finally {
          fs.closeSync(fd);
        }
      }
    } catch {}

    const integrityInfo = detectEmbeddedIntegrity(installRoot, headerHash);

    return {
      kind: 'app2',
      label: `Antigravity 2.0 (${appName})`,
      version,
      installRoot,
      resourcesDir,
      appDir: fs.existsSync(appDir) ? appDir : null,
      asarPath,
      productJsonPath: null,
      hasBackup,
      patched: Boolean(backupMeta && backupMeta.active),
      backupCreatedAt: backupMeta ? backupMeta.createdAt : null,
      patchedStringsCount: backupMeta ? backupMeta.totalReplacements || 0 : 0,
      asarHeaderHash: headerHash,
      integrityInfo,
    };
  }

  if (fs.existsSync(path.join(appDir, 'package.json'))) {
    let pkg = {};
    try {
      pkg = JSON.parse(fs.readFileSync(path.join(appDir, 'package.json'), 'utf8'));
    } catch {}
    return {
      kind: 'app2',
      label: `Antigravity 2.0 (${pkg.productName || pkg.name || path.basename(installRoot)})`,
      version: pkg.version || '2.0',
      installRoot,
      resourcesDir,
      appDir,
      asarPath: null,
      productJsonPath: null,
      hasBackup,
      patched: Boolean(backupMeta && backupMeta.active),
      backupCreatedAt: backupMeta ? backupMeta.createdAt : null,
      patchedStringsCount: backupMeta ? backupMeta.totalReplacements || 0 : 0,
      integrityInfo: { present: false, carrierPath: null, carrierType: null, matchesCurrentHeader: false },
    };
  }

  return null;
}

/**
 * Возвращает список стандартных путей поиска Antigravity 2.0 и Antigravity IDE в ОС пользователя.
 */
function getCandidatePaths() {
  const home = os.homedir();
  const candidates = [];

  if (process.platform === 'win32') {
    const localAppData = process.env.LOCALAPPDATA || path.join(home, 'AppData', 'Local');
    const programFiles = process.env.ProgramFiles || 'C:\\Program Files';
    const programFilesX86 = process.env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)';

    const winNames = [
      'Antigravity',
      'Antigravity 2',
      'Antigravity 2.0',
      'Google Antigravity',
      'Antigravity IDE',
      path.join('Google', 'Antigravity'),
      path.join('Google', 'Antigravity 2'),
      path.join('Google', 'Antigravity IDE'),
    ];

    for (const sub of winNames) {
      candidates.push(path.join(localAppData, 'Programs', sub));
      candidates.push(path.join(localAppData, sub));
      candidates.push(path.join(programFiles, sub));
      candidates.push(path.join(programFilesX86, sub));
    }
  } else if (process.platform === 'darwin') {
    const macApps = [
      'Antigravity.app',
      'Antigravity 2.app',
      'Google Antigravity.app',
      'Antigravity IDE.app',
    ];
    for (const app of macApps) {
      candidates.push(path.join('/Applications', app));
      candidates.push(path.join(home, 'Applications', app));
    }
  } else {
    candidates.push(
      '/opt/antigravity',
      '/opt/google/antigravity',
      '/opt/antigravity-2',
      '/usr/share/antigravity',
      path.join(home, '.local', 'share', 'antigravity'),
      path.join(home, '.local', 'share', 'antigravity-ide')
    );
  }

  return [...new Set(candidates)];
}

/**
 * Автоматически ищет все установленные копии Antigravity 2.0 и Antigravity IDE, а также проверяет конфиг агента.
 * @param {{ extraDirs?: string[], geminiConfigDir?: string }} [options]
 */
function detectEnvironment(options = {}) {
  const { extraDirs = [], geminiConfigDir } = options;
  const seenRoots = new Set();
  const installations = [];

  const allDirs = [...extraDirs, ...getCandidatePaths()];
  for (const dir of allDirs) {
    if (!dir) continue;
    try {
      const info = inspectTargetDirectory(dir);
      if (info && !seenRoots.has(info.installRoot.toLowerCase())) {
        seenRoots.add(info.installRoot.toLowerCase());
        installations.push(info);
      }
    } catch {
      // В песочнице или без прав чтения просто пропускаем недоступный путь
    }
  }

  const resolvedConfigDir = geminiConfigDir || path.join(os.homedir(), '.gemini', 'config');
  const pluginDir = path.join(resolvedConfigDir, 'plugins', 'antigravity-ru-agent');
  const pluginManifestPath = path.join(pluginDir, 'plugin.json');

  let pluginInstalled = false;
  let pluginAccessible = true;
  try {
    pluginInstalled = fs.existsSync(pluginManifestPath);
  } catch {
    pluginAccessible = false;
  }

  const settings = pluginInstalled
    ? inspectAgentPluginSettings(pluginDir)
    : { tokenEconomy: true, russianThinking: false, russianCodeComments: false };

  return {
    platform: process.platform,
    installations,
    agentConfig: {
      configDir: resolvedConfigDir,
      pluginDir,
      installed: pluginInstalled,
      accessible: pluginAccessible,
      settings,
    },
  };
}

module.exports = {
  BACKUP_DIR_NAME,
  normalizeInstallRoot,
  inspectTargetDirectory,
  getCandidatePaths,
  detectEnvironment,
};
