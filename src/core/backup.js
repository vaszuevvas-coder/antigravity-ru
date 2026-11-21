'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { BACKUP_DIR_NAME } = require('./detector');

function sha256File(filePath) {
  const hash = crypto.createHash('sha256');
  const fd = fs.openSync(filePath, 'r');
  const buf = Buffer.alloc(1024 * 1024);
  try {
    let bytes = 0;
    while ((bytes = fs.readSync(fd, buf, 0, buf.length, null)) > 0) {
      hash.update(buf.subarray(0, bytes));
    }
  } finally {
    fs.closeSync(fd);
  }
  return hash.digest('hex');
}

/**
 * Менеджер атомарного резервного копирования и отката для конкретной папки установки Antigravity.
 * Умно обрабатывает как повторное применение словаря (берёт за основу чистый английский оригинал из бэкапа),
 * так и обновление самого приложения Antigravity (обновляет эталонный бэкап, если хеш файла изменился извне).
 */
class BackupManager {
  /**
   * @param {string} installRoot
   */
  constructor(installRoot) {
    this.installRoot = path.resolve(installRoot);
    this.backupRoot = path.join(this.installRoot, BACKUP_DIR_NAME);
    this.filesStoreDir = path.join(this.backupRoot, 'files');
    this.manifestPath = path.join(this.backupRoot, 'manifest.json');
  }

  loadManifest() {
    if (!fs.existsSync(this.manifestPath)) {
      return null;
    }
    try {
      return JSON.parse(fs.readFileSync(this.manifestPath, 'utf8'));
    } catch {
      return null;
    }
  }

  saveManifest(manifest) {
    fs.mkdirSync(this.backupRoot, { recursive: true });
    const tmp = `${this.manifestPath}.tmp-${process.pid}`;
    fs.writeFileSync(tmp, JSON.stringify(manifest, null, 2) + '\n', 'utf8');
    fs.renameSync(tmp, this.manifestPath);
  }

  ensureManifest(appKind, appVersion) {
    const existing = this.loadManifest();
    if (existing) {
      existing.appKind = appKind || existing.appKind;
      existing.appVersion = appVersion || existing.appVersion;
      existing.files = existing.files || {};
      existing.createdFiles = existing.createdFiles || [];
      existing.externalFiles = existing.externalFiles || {};
      return existing;
    }
    return {
      schemaVersion: 1,
      appKind,
      appVersion,
      active: false,
      totalReplacements: 0,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      files: {},
      createdFiles: [],
      externalFiles: {},
    };
  }

  /**
   * Подготавливает чистый исходный файл для патчинга:
   * - Если файл ещё не в бэкапе -> копирует оригинал в .antigravity-ru-backup/files/...
   * - Если файл уже был пропатчен нами (его текущий SHA256 совпадает с patchedSha256) ->
   *   восстанавливает оригинал из бэкапа перед новым патчингом, чтобы словарь применялся чисто!
   * - Если приложение обновилось (текущий SHA256 не равен patchedSha256) -> обновляет эталонный бэкап новым оригиналом!
   *
   * @param {object} manifest
   * @param {string} absFilePath
   * @param {{ dryRun?: boolean }} [options]
   * @returns {{ cleanSourcePath: string, wasUpdatedByVendor: boolean }}
   */
  prepareCleanFile(manifest, absFilePath, options = {}) {
    const { dryRun = false } = options;
    const relKey = path.relative(this.installRoot, absFilePath).replace(/\\/g, '/');
    const backupFilePath = path.join(this.filesStoreDir, relKey);
    const currentHash = sha256File(absFilePath);
    const record = manifest.files[relKey];

    // Файл уже пропатчен нашей прошлой сессией и его эталонный бэкап цел
    if (record && record.patchedSha256 === currentHash && fs.existsSync(backupFilePath)) {
      if (!dryRun) {
        fs.copyFileSync(backupFilePath, absFilePath);
      }
      return {
        cleanSourcePath: backupFilePath,
        wasUpdatedByVendor: false,
      };
    }

    // Либо первый запуск, либо программа Antigravity обновилась!
    const wasUpdatedByVendor = Boolean(record && record.patchedSha256 && record.patchedSha256 !== currentHash && record.originalSha256 !== currentHash);
    if (!dryRun) {
      fs.mkdirSync(path.dirname(backupFilePath), { recursive: true });
      fs.copyFileSync(absFilePath, backupFilePath);
      manifest.files[relKey] = {
        relPath: relKey,
        originalSha256: currentHash,
        patchedSha256: currentHash,
        backedUpAt: new Date().toISOString(),
      };
    }

    return {
      cleanSourcePath: absFilePath,
      wasUpdatedByVendor,
    };
  }

  /**
   * Фиксирует новый SHA256 после успешного патчинга файла.
   */
  recordPatchedFile(manifest, absFilePath) {
    const relKey = path.relative(this.installRoot, absFilePath).replace(/\\/g, '/');
    if (manifest.files[relKey]) {
      manifest.files[relKey].patchedSha256 = sha256File(absFilePath);
      manifest.files[relKey].patchedAt = new Date().toISOString();
    }
  }

  /**
   * Регистрирует файл, созданный русификатором с нуля (например package.nls.ru.json),
   * чтобы при откате (restore) аккуратно удалить его.
   */
  recordCreatedFile(manifest, absFilePath) {
    const relKey = path.relative(this.installRoot, absFilePath).replace(/\\/g, '/');
    if (!manifest.createdFiles.includes(relKey)) {
      manifest.createdFiles.push(relKey);
    }
  }

  /**
   * Бэкапит внешний конфигурационный файл (например ~/.antigravity/argv.json).
   */
  backupExternalFile(manifest, keyName, absExternalPath) {
    const storePath = path.join(this.backupRoot, 'external', keyName);
    fs.mkdirSync(path.dirname(storePath), { recursive: true });
    if (fs.existsSync(absExternalPath)) {
      if (!manifest.externalFiles[keyName]) {
        fs.copyFileSync(absExternalPath, storePath);
        manifest.externalFiles[keyName] = {
          targetPath: absExternalPath,
          existedBefore: true,
        };
      }
    } else if (!manifest.externalFiles[keyName]) {
      manifest.externalFiles[keyName] = {
        targetPath: absExternalPath,
        existedBefore: false,
      };
    }
  }

  /**
   * Полностью откатывает все пропатченные и созданные файлы к оригинальному состоянию.
   */
  restoreAll() {
    const manifest = this.loadManifest();
    if (!manifest) {
      return {
        restored: false,
        restoredFilesCount: 0,
        removedCreatedFilesCount: 0,
        message: 'Резервная копия в этой папке не найдена — откат не требуется.',
      };
    }

    let restoredFilesCount = 0;
    let removedCreatedFilesCount = 0;

    for (const [relKey, entry] of Object.entries(manifest.files || {})) {
      const backupFilePath = path.join(this.filesStoreDir, relKey);
      const targetPath = path.join(this.installRoot, entry.relPath || relKey);
      if (fs.existsSync(backupFilePath)) {
        fs.mkdirSync(path.dirname(targetPath), { recursive: true });
        fs.copyFileSync(backupFilePath, targetPath);
        restoredFilesCount++;
      }
    }

    for (const relKey of manifest.createdFiles || []) {
      const targetPath = path.join(this.installRoot, relKey);
      if (fs.existsSync(targetPath)) {
        fs.unlinkSync(targetPath);
        removedCreatedFilesCount++;
      }
    }

    for (const [keyName, extEntry] of Object.entries(manifest.externalFiles || {})) {
      const storePath = path.join(this.backupRoot, 'external', keyName);
      if (extEntry.existedBefore && fs.existsSync(storePath)) {
        fs.mkdirSync(path.dirname(extEntry.targetPath), { recursive: true });
        fs.copyFileSync(storePath, extEntry.targetPath);
      } else if (!extEntry.existedBefore && fs.existsSync(extEntry.targetPath)) {
        fs.unlinkSync(extEntry.targetPath);
      }
    }

    // Удаляем каталог резервной копии после чистого восстановления
    fs.rmSync(this.backupRoot, { recursive: true, force: true });

    return {
      restored: true,
      restoredFilesCount,
      removedCreatedFilesCount,
      message: `Оригинальные файлы успешно восстановлены (${restoredFilesCount} восст., ${removedCreatedFilesCount} созд. удалено).`,
    };
  }
}

module.exports = {
  sha256File,
  BackupManager,
};
