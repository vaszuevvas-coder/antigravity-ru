'use strict';

const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');
const zlib = require('node:zlib');
const { inspectTargetDirectory, BACKUP_DIR_NAME } = require('./detector');
const { BackupManager, sha256File } = require('./backup');
const { readAsarHeader, listAsarEntries, transformAsarArchive } = require('./asar');
const { translateFileBuffer, translateHtml, extractUntranslatedCandidates, isLocalizationJsonPath } = require('./translator');
const { injectPreloadDomRuntime } = require('./dom-runtime');
const {
  patchMarketplaceCache,
  restoreMarketplaceCache,
  getDefaultMarketplacesDir,
  patchBuiltinPlugins,
  restoreBuiltinPlugins,
  getDefaultBuiltinPluginsDir,
} = require('./marketplace-cache');


/**
 * Проверяет доступность файла на запись (не заблокирован ли процессом Electron / Windows).
 */
function assertWritableOrExplain(filePath) {
  try {
    const fd = fs.openSync(filePath, 'r+');
    fs.closeSync(fd);
  } catch (err) {
    if (err && (err.code === 'EBUSY' || err.code === 'EPERM') && /\.exe$/i.test(filePath)) {
      // On Windows, running .exe blocks r+ write but allows atomic rename swap on the same volume.
      return;
    }
    if (err && (err.code === 'EBUSY' || err.code === 'EPERM')) {
      throw new Error(
        `Файл занят запущенным процессом (${path.basename(filePath)}). Полностью закройте Google Antigravity (включая значок в системном трее) и повторите попытку.`
      );
    }
    if (err && err.code === 'EACCES') {
      throw new Error(
        `Нет прав на запись в ${filePath}. Запустите «Запустить русификатор.bat» от имени администратора.`
      );
    }
    throw err;
  }
}

/**
 * Записывает исполняемый файл (.exe), используя атомарное переименование на лету, если процесс запущен.
 */
function writeExecutableWithRunningFallback(carrierPath, dataBuffer, backupRoot) {
  const staleDir = path.join(backupRoot, 'stale-exe');
  if (fs.existsSync(staleDir)) {
    for (const name of fs.readdirSync(staleDir)) {
      try {
        fs.unlinkSync(path.join(staleDir, name));
      } catch {}
    }
  }

  try {
    fs.writeFileSync(carrierPath, dataBuffer);
    return;
  } catch (err) {
    if (!err || (err.code !== 'EBUSY' && err.code !== 'EPERM')) {
      throw err;
    }
  }

  fs.mkdirSync(staleDir, { recursive: true });
  const newTmpPath = `${carrierPath}.ru-new-${process.pid}`;
  const stalePath = path.join(staleDir, `${path.basename(carrierPath)}.${Date.now()}-${process.pid}.old`);
  fs.writeFileSync(newTmpPath, dataBuffer);

  try {
    fs.renameSync(carrierPath, stalePath);
  } catch (renameErr) {
    try { fs.unlinkSync(newTmpPath); } catch {}
    throw new Error(
      `Файл занят запущенным процессом (${path.basename(carrierPath)}). Полностью закройте Google Antigravity и повторите попытку.`
    );
  }

  try {
    fs.renameSync(newTmpPath, carrierPath);
  } catch (swapErr) {
    try { fs.renameSync(stalePath, carrierPath); } catch {}
    try { fs.unlinkSync(newTmpPath); } catch {}
    throw swapErr;
  }
}

/**
 * Вычисляет контрольную сумму файла в том же формате, который уже используется в product.json (VS Code / Antigravity IDE).
 */
function computeMatchingChecksum(fileBuffer, existingHashSample) {
  const sample = String(existingHashSample || '');
  if (/^[0-9a-f]{32}$/i.test(sample)) {
    return crypto.createHash('md5').update(fileBuffer).digest('hex');
  }
  if (/^[0-9a-f]{64}$/i.test(sample)) {
    return crypto.createHash('sha256').update(fileBuffer).digest('hex');
  }
  const b64 = crypto.createHash('sha256').update(fileBuffer).digest('base64');
  if (sample.endsWith('=')) {
    return b64;
  }
  return b64.replace(/=+$/, '');
}

/**
 * Обновляет секцию checksums в resources/app/product.json (Antigravity IDE),
 * чтобы не появлялось уведомление о повреждённой установке.
 */
function updateIdeProductChecksums(appDir, productJsonPath, backupMgr, manifest, dryRun) {
  if (!productJsonPath || !fs.existsSync(productJsonPath)) {
    return 0;
  }

  const rawProduct = fs.readFileSync(productJsonPath, 'utf8');
  let product;
  try {
    product = JSON.parse(rawProduct);
  } catch {
    return 0;
  }

  if (!product.checksums || typeof product.checksums !== 'object') {
    return 0;
  }

  let updatedHashes = 0;
  for (const [relKey, oldHash] of Object.entries(product.checksums)) {
    const candidates = [
      path.join(appDir, 'out', relKey),
      path.join(appDir, relKey),
    ];
    const targetFile = candidates.find((p) => fs.existsSync(p) && fs.statSync(p).isFile());
    if (!targetFile) continue;

    const buf = fs.readFileSync(targetFile);
    const nextHash = computeMatchingChecksum(buf, oldHash);
    if (nextHash !== oldHash) {
      product.checksums[relKey] = nextHash;
      updatedHashes++;
    }
  }

  if (updatedHashes > 0 && !dryRun) {
    backupMgr.prepareCleanFile(manifest, productJsonPath, { dryRun: false });
    fs.writeFileSync(productJsonPath, JSON.stringify(product, null, '\t') + '\n', 'utf8');
    backupMgr.recordPatchedFile(manifest, productJsonPath);
  }

  return updatedHashes;
}

/**
 * Устанавливает "locale": "ru" в файле argv.json для Antigravity IDE (с сохранением JSONC-комментариев).
 */
function configureIdeLocaleArgv(argvPath, backupMgr, manifest, dryRun) {
  if (!argvPath) return false;
  let current = '';
  if (fs.existsSync(argvPath)) {
    current = fs.readFileSync(argvPath, 'utf8');
    if (/"locale"\s*:\s*"ru"/.test(current)) {
      return false; // Уже установлен русский язык
    }
  }

  if (dryRun) {
    return true;
  }

  backupMgr.backupExternalFile(manifest, 'ide-argv.json', argvPath);
  fs.mkdirSync(path.dirname(argvPath), { recursive: true });

  if (!current.trim()) {
    const fresh = [
      '// Конфигурация параметров запуска Antigravity IDE',
      '{',
      '\t"locale": "ru"',
      '}',
      '',
    ].join('\n');
    fs.writeFileSync(argvPath, fresh, 'utf8');
    return true;
  }

  let nextText;
  if (/"locale"\s*:\s*"[^"]*"/.test(current)) {
    nextText = current.replace(/"locale"\s*:\s*"[^"]*"/, '"locale": "ru"');
  } else {
    const lastBrace = current.lastIndexOf('}');
    if (lastBrace !== -1) {
      const before = current.slice(0, lastBrace).trimEnd();
      const needsComma = !before.endsWith('{') && !before.endsWith(',');
      nextText = `${before}${needsComma ? ',' : ''}\n\t"locale": "ru"\n}\n`;
    } else {
      nextText = `{\n\t"locale": "ru"\n}\n`;
    }
  }

  fs.writeFileSync(argvPath, nextText, 'utf8');
  return true;
}

/**
 * Рекурсивно собирает подходящие для локализации файлы в распакованной директории.
 */
function collectPatchableFiles(rootDir) {
  const results = [];
  if (!rootDir || !fs.existsSync(rootDir)) return results;

  function walk(dir) {
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (entry.name === BACKUP_DIR_NAME || entry.name === '.git') continue;
      const fullPath = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        // Не углубляемся в тяжёлые сторонние пакеты, не имеющие отношения к UI
        if (entry.name === 'node_modules') {
          let pkgs = [];
          try { pkgs = fs.readdirSync(fullPath, { withFileTypes: true }); } catch {}
          for (const pkg of pkgs) {
            if (/(antigravity|gemini|agent|chat|ui|workbench|exa|codeium|^@)/i.test(pkg.name)) {
              walk(path.join(fullPath, pkg.name));
            }
          }
          continue;
        }
        walk(fullPath);
      } else if (entry.isFile()) {
        const ext = path.extname(entry.name).toLowerCase();
        if (['.js', '.mjs', '.cjs', '.html', '.htm', '.json'].includes(ext)) {
          results.push(fullPath);
        }
      }
    }
  }

  walk(rootDir);
  return results;
}

/**
 * Применяет русификатор к одной установке Antigravity 2.0 или Antigravity IDE.
 *
 * @param {string} targetDirPath
 * @param {ReturnType<typeof import('./dictionary').loadDictionary>} dict
 * @param {{
 *   dryRun?: boolean,
 *   patchExeIntegrity?: boolean,
 *   configureLocale?: boolean,
 *   ideArgvPath?: string
 * }} [options]
 */
function patchInstallation(targetDirPath, dict, options = {}) {
  const {
    dryRun = false,
    patchExeIntegrity = true,
    injectDomRuntime = true,
    configureLocale = true,
    ideArgvPath = path.join(os.homedir(), '.antigravity', 'argv.json'),
  } = options;

  const target = inspectTargetDirectory(targetDirPath);
  if (!target) {
    throw new Error(`В папке "${targetDirPath}" не обнаружена структура Google Antigravity 2.0 или Antigravity IDE.`);
  }

  const backupMgr = new BackupManager(target.installRoot);
  const manifest = backupMgr.ensureManifest(target.kind, target.version);

  let patchedFilesCount = 0;
  let totalReplacements = 0;
  let createdFilesCount = 0;
  let updatedChecksumsCount = 0;
  let domRuntimeInjected = false;
  let integrityHashUpdated = false;
  let localeConfigured = false;
  const warnings = [];
  const sampleMatchedKeys = new Set();

  // 1. Обработка Electron архива resources/app.asar (основной формат для Antigravity 2.0)
  if (target.asarPath && fs.existsSync(target.asarPath)) {
    if (!dryRun) {
      assertWritableOrExplain(target.asarPath);
    }

    const asarRelKey = path.relative(target.installRoot, target.asarPath).replace(/\\/g, '/');
    const existingRecord = manifest.files[asarRelKey];
    const backupAsarPath = path.join(backupMgr.filesStoreDir, asarRelKey);

    let asarSourceForDryRun = target.asarPath;
    if (existingRecord && fs.existsSync(backupAsarPath)) {
      const currSha = sha256File(target.asarPath);
      if (currSha === existingRecord.patchedSha256) {
        if (dryRun) {
          asarSourceForDryRun = backupAsarPath;
        } else {
          fs.copyFileSync(backupAsarPath, target.asarPath);
        }
      }
    }

    // Если исполняемый файл уже был пропатчен нами, при повторном применении восстановим эталон для чистого обновления хеша
    if (target.integrityInfo && target.integrityInfo.carrierPath && fs.existsSync(target.integrityInfo.carrierPath)) {
      const carrierRelKey = path.relative(target.installRoot, target.integrityInfo.carrierPath).replace(/\\/g, '/');
      const carrierRecord = manifest.files[carrierRelKey];
      const backupCarrierPath = path.join(backupMgr.filesStoreDir, carrierRelKey);
      if (!dryRun && carrierRecord && fs.existsSync(backupCarrierPath)) {
        if (sha256File(target.integrityInfo.carrierPath) === carrierRecord.patchedSha256) {
          assertWritableOrExplain(target.integrityInfo.carrierPath);
          writeExecutableWithRunningFallback(
            target.integrityInfo.carrierPath,
            fs.readFileSync(backupCarrierPath),
            backupMgr.backupRoot
          );
        }
      }
    }

    if (!dryRun) {
      backupMgr.prepareCleanFile(manifest, target.asarPath, { dryRun: false });
    }

    let asarReplacements = 0;
    const asarRes = transformAsarArchive(
      dryRun ? asarSourceForDryRun : target.asarPath,
      (relPath, buf) => {
        const normRel = relPath.replace(/\\/g, '/');

        // Внедряем живой React-безопасный переводчик DOM в preload.js для веб-интерфейса Antigravity 2.0
        if (
          injectDomRuntime &&
          target.kind === 'app2' &&
          (normRel === 'dist/preload.js' || normRel === 'preload.js')
        ) {
          const baseRes = translateFileBuffer(relPath, buf, dict);
          const baseText = (baseRes.buffer || buf).toString('utf8');
          const withRuntime = injectPreloadDomRuntime(baseText, dict);
          domRuntimeInjected = true;
          asarReplacements += baseRes.replacements + dict.totalCount;
          return Buffer.from(withRuntime, 'utf8');
        }

        // Поддержка HTML-шаблонов внутри *Html.js (например dist/ideInstall/wizardHtml.js)
        if (/html\.js$/i.test(normRel)) {
          const htmlRes = translateHtml(buf.toString('utf8'), dict);
          if (htmlRes.replacements > 0) {
            asarReplacements += htmlRes.replacements;
            for (const k of htmlRes.matchedKeys.slice(0, 15)) sampleMatchedKeys.add(k);
            return Buffer.from(htmlRes.html, 'utf8');
          }
        }

        const res = translateFileBuffer(relPath, buf, dict);
        if (res.replacements > 0 && res.buffer) {
          asarReplacements += res.replacements;
          for (const k of res.matchedKeys.slice(0, 15)) sampleMatchedKeys.add(k);
          return res.buffer;
        }
        return null;
      },
      { dryRun }
    );

    if (asarRes.changed) {
      patchedFilesCount += asarRes.modifiedFilesCount;
      totalReplacements += asarReplacements;

      if (!dryRun) {
        backupMgr.recordPatchedFile(manifest, target.asarPath);
      }

      // Обновление встроенного хеша ElectronAsarIntegrity (с созданием бэкапа исполняемого файла)
      if (target.integrityInfo && target.integrityInfo.present && (dryRun || asarRes.oldHeaderHash !== asarRes.newHeaderHash)) {
        const carrier = target.integrityInfo.carrierPath;
        if (patchExeIntegrity && carrier && fs.existsSync(carrier)) {
          if (dryRun) {
            integrityHashUpdated = true;
          } else {
            assertWritableOrExplain(carrier);
            backupMgr.prepareCleanFile(manifest, carrier, { dryRun: false });
            const rawCarrier = fs.readFileSync(carrier);
            const oldHexBuf = Buffer.from(asarRes.oldHeaderHash, 'ascii');
            const newHexBuf = Buffer.from(asarRes.newHeaderHash, 'ascii');
            const idx = rawCarrier.indexOf(oldHexBuf);
            if (idx !== -1 && oldHexBuf.length === newHexBuf.length) {
              newHexBuf.copy(rawCarrier, idx);
              writeExecutableWithRunningFallback(carrier, rawCarrier, backupMgr.backupRoot);
              backupMgr.recordPatchedFile(manifest, carrier);
              integrityHashUpdated = true;
            } else {
              warnings.push('Не удалось найти точное совпадение хеша заголовка ASAR внутри исполняемого файла.');
            }
          }
        } else {
          warnings.push(
            'Обнаружена проверка ElectronAsarIntegrity в исполняемом файле, но обновление хеша отключено. Для запуска потребуется включить опцию обновления хеша целостности ASAR.'
          );
        }
      }
    }
  }

  // 2. Обработка распакованных директорий: resources/app и resources/app.asar.unpacked
  const unpackedDirs = [
    target.appDir,
    target.asarPath ? `${target.asarPath}.unpacked` : null,
  ].filter((d) => d && fs.existsSync(d));

  for (const dir of unpackedDirs) {
    const files = collectPatchableFiles(dir);
    for (const absFile of files) {
      const relKey = path.relative(target.installRoot, absFile).replace(/\\/g, '/');
      if (relKey.toLowerCase().endsWith('/product.json')) continue;

      const existingRecord = manifest.files[relKey];
      const backupFilePath = path.join(backupMgr.filesStoreDir, relKey);
      let sourceBuf;

      // Если файл уже был пропатчен нами ранее, берём чистый оригинал из бэкапа
      if (existingRecord && fs.existsSync(backupFilePath) && sha256File(absFile) === existingRecord.patchedSha256) {
        sourceBuf = fs.readFileSync(backupFilePath);
      } else {
        sourceBuf = fs.readFileSync(absFile);
      }

      const res = translateFileBuffer(relKey, sourceBuf, dict);
      if (res.replacements > 0 && res.buffer) {
        patchedFilesCount++;
        totalReplacements += res.replacements;
        for (const k of res.matchedKeys.slice(0, 15)) sampleMatchedKeys.add(k);

        if (!dryRun) {
          assertWritableOrExplain(absFile);
          backupMgr.prepareCleanFile(manifest, absFile, { dryRun: false });
          fs.writeFileSync(absFile, res.buffer);
          backupMgr.recordPatchedFile(manifest, absFile);
        }

        // Для расширений VS Code / Antigravity IDE дополнительно создаём package.nls.ru.json
        if (path.basename(absFile).toLowerCase() === 'package.nls.json') {
          const ruNlsPath = path.join(path.dirname(absFile), 'package.nls.ru.json');
          const existedBefore = fs.existsSync(ruNlsPath);
          if (!dryRun) {
            if (existedBefore) {
              backupMgr.prepareCleanFile(manifest, ruNlsPath, { dryRun: false });
              fs.writeFileSync(ruNlsPath, res.buffer);
              backupMgr.recordPatchedFile(manifest, ruNlsPath);
            } else {
              fs.writeFileSync(ruNlsPath, res.buffer);
              backupMgr.recordCreatedFile(manifest, ruNlsPath);
              createdFilesCount++;
            }
          } else if (!existedBefore) {
            createdFilesCount++;
          }
        }
      }
    }
  }

  // 3. Специфичные шаги для Antigravity IDE: пересчёт контрольных сумм product.json и настройка locale: "ru"
  if (target.kind === 'ide') {
    if (target.appDir && target.productJsonPath) {
      updatedChecksumsCount = updateIdeProductChecksums(
        target.appDir,
        target.productJsonPath,
        backupMgr,
        manifest,
        dryRun
      );
    }

    if (configureLocale && ideArgvPath) {
      try {
        localeConfigured = configureIdeLocaleArgv(ideArgvPath, backupMgr, manifest, dryRun);
      } catch (err) {
        warnings.push(`Не удалось обновить параметр locale в ${ideArgvPath}: ${err.message}`);
      }
    }
  }

  // 4. Локализация кэша маркетплейса плагинов (~/.gemini/antigravity/cache/marketplaces)
  const isTempTestRoot = target.installRoot.toLowerCase().startsWith(os.tmpdir().toLowerCase());
  const mpCacheDir =
    options.marketplacesDir !== undefined
      ? options.marketplacesDir
      : isTempTestRoot
        ? null
        : getDefaultMarketplacesDir();
  if (mpCacheDir && fs.existsSync(mpCacheDir)) {
    try {
      const mpRes = patchMarketplaceCache(mpCacheDir, dict, {
        dryRun,
        backupMgr,
        manifest,
      });
      if (mpRes.patched) {
        patchedFilesCount += mpRes.modifiedFiles;
      }
    } catch (err) {
      warnings.push(`Предупреждение при локализации кэша маркетплейса: ${err.message}`);
    }
  }

  // 5. Локализация встроенных плагинов и их сайдкаров (~/.gemini/antigravity/builtin/plugins, напр. Swarm)
  const builtinPluginsDir =
    options.builtinPluginsDir !== undefined
      ? options.builtinPluginsDir
      : isTempTestRoot
        ? null
        : getDefaultBuiltinPluginsDir();
  if (builtinPluginsDir && fs.existsSync(builtinPluginsDir)) {
    try {
      const bpRes = patchBuiltinPlugins(builtinPluginsDir, dict, {
        dryRun,
        backupMgr,
        manifest,
      });
      if (bpRes.patched) {
        patchedFilesCount += bpRes.modifiedFiles;
      }
    } catch (err) {
      warnings.push(`Предупреждение при локализации встроенных плагинов: ${err.message}`);
    }
  }

  if (!dryRun && (patchedFilesCount > 0 || createdFilesCount > 0 || updatedChecksumsCount > 0 || localeConfigured)) {
    manifest.active = true;
    manifest.totalReplacements = totalReplacements;
    manifest.updatedAt = new Date().toISOString();
    backupMgr.saveManifest(manifest);
  }

  return {
    kind: target.kind,
    label: target.label,
    installRoot: target.installRoot,
    dryRun,
    patchedFilesCount,
    totalReplacements,
    createdFilesCount,
    updatedChecksumsCount,
    domRuntimeInjected,
    integrityHashUpdated,
    localeConfigured,
    sampleMatchedKeys: [...sampleMatchedKeys].slice(0, 20),
    warnings,
  };
}

/**
 * Откатывает русификатор для выбранной папки установки.
 * @param {string} targetDirPath
 */
function restoreInstallation(targetDirPath, options = {}) {
  const target = inspectTargetDirectory(targetDirPath);
  const root = target ? target.installRoot : path.resolve(targetDirPath);
  const backupMgr = new BackupManager(root);
  const res = backupMgr.restoreAll();
  const isTempTestRoot = root.toLowerCase().startsWith(os.tmpdir().toLowerCase());
  const mpCacheDir =
    options.marketplacesDir !== undefined
      ? options.marketplacesDir
      : isTempTestRoot
        ? null
        : getDefaultMarketplacesDir();
  if (mpCacheDir && fs.existsSync(mpCacheDir)) {
    try {
      const mpRestored = restoreMarketplaceCache(mpCacheDir);
      if (mpRestored && mpRestored.restoredFiles > 0) {
        res.restoredFilesCount += mpRestored.restoredFiles;
      }
    } catch {}
  }
  const builtinPluginsDir =
    options.builtinPluginsDir !== undefined
      ? options.builtinPluginsDir
      : isTempTestRoot
        ? null
        : getDefaultBuiltinPluginsDir();
  if (builtinPluginsDir && fs.existsSync(builtinPluginsDir)) {
    try {
      const bpRestored = restoreBuiltinPlugins(builtinPluginsDir);
      if (bpRestored && bpRestored.restoredFiles > 0) {
        res.restoredFilesCount += bpRestored.restoredFiles;
      }
    } catch {}
  }
  return res;
}

/**
 * Ищет встроенный ZIP-архив веб-интерфейса внутри бинарника language_server* (Antigravity 2.0)
 * и извлекает непереведённые строки из его .js / .html ресурсов без модификации самого исполняемого файла.
 * @param {string} binPath
 * @param {ReturnType<typeof import('./dictionary').loadDictionary>} dict
 * @param {(relPath: string, list: string[]) => void} recordCandidates
 */
function scanEmbeddedZipInLanguageServer(binPath, dict, recordCandidates) {
  try {
    const stat = fs.statSync(binPath);
    if (!stat.isFile() || stat.size < 1024 || stat.size > 350 * 1024 * 1024) return;
    const raw = fs.readFileSync(binPath);

    // Ищем сигнатуру End of Central Directory (PK\x05\x06) с валидным смещением Central Directory
    const eocdSig = Buffer.from([0x50, 0x4b, 0x05, 0x06]);
    let searchFrom = 0;
    while (searchFrom < raw.length - 22) {
      const eocdPos = raw.indexOf(eocdSig, searchFrom);
      if (eocdPos === -1) break;
      searchFrom = eocdPos + 4;

      const totalEntries = raw.readUInt16LE(eocdPos + 10);
      const cdSize = raw.readUInt32LE(eocdPos + 12);
      const cdRelOffset = raw.readUInt32LE(eocdPos + 16);
      if (totalEntries === 0 || totalEntries > 12000 || cdSize === 0 || cdSize > 50 * 1024 * 1024) {
        continue;
      }

      const cdStart = eocdPos - cdSize;
      if (cdStart < 0 || raw.readUInt32LE(cdStart) !== 0x02014b50) {
        continue;
      }

      const zipBaseOffset = cdStart - cdRelOffset;
      if (zipBaseOffset < 0) continue;

      let ptr = cdStart;
      for (let idx = 0; idx < totalEntries && ptr + 46 <= eocdPos; idx++) {
        if (raw.readUInt32LE(ptr) !== 0x02014b50) break;
        const method = raw.readUInt16LE(ptr + 10);
        const compSize = raw.readUInt32LE(ptr + 20);
        const uncompSize = raw.readUInt32LE(ptr + 24);
        const nameLen = raw.readUInt16LE(ptr + 28);
        const extraLen = raw.readUInt16LE(ptr + 30);
        const commentLen = raw.readUInt16LE(ptr + 32);
        const localHdrRel = raw.readUInt32LE(ptr + 42);
        const entryName = raw.slice(ptr + 46, ptr + 46 + nameLen).toString('utf8');
        ptr += 46 + nameLen + extraLen + commentLen;

        const lowerName = entryName.toLowerCase();
        if (uncompSize > 25 * 1024 * 1024 || lowerName.endsWith('.map')) continue;
        const kind = (lowerName.endsWith('.html') || lowerName.endsWith('.htm'))
          ? 'html'
          : ((lowerName.endsWith('.js') || lowerName.endsWith('.mjs')) ? 'js' : null);
        if (!kind) continue;

        const localPos = zipBaseOffset + localHdrRel;
        if (localPos + 30 > raw.length || raw.readUInt32LE(localPos) !== 0x04034b50) continue;
        const lNameLen = raw.readUInt16LE(localPos + 26);
        const lExtraLen = raw.readUInt16LE(localPos + 28);
        const dataStart = localPos + 30 + lNameLen + lExtraLen;
        if (dataStart + compSize > raw.length) continue;

        const compSlice = raw.subarray(dataStart, dataStart + compSize);
        let contentBuf = null;
        if (method === 0) contentBuf = compSlice;
        else if (method === 8) contentBuf = zlib.inflateRawSync(compSlice);
        if (!contentBuf) continue;

        const list = extractUntranslatedCandidates(contentBuf.toString('utf8'), kind, dict);
        recordCandidates(`embedded-ui/${entryName}`, list);
      }
      // Продолжаем поиск дальше: в бинарнике Go перед архивом веб-UI может идти архив часовых поясов (tzdata)
      searchFrom = eocdPos + 22;
    }
  } catch {
    // Игнорируем нестандартные или заблокированные бинарные файлы при сканировании кандидатов
  }
}

/**
 * Сканирует папку установки Antigravity и возвращает непереведённые английские строки UI.
 * @param {string} targetDirPath
 * @param {ReturnType<typeof import('./dictionary').loadDictionary>} dict
 */
function extractCandidatesFromInstallation(targetDirPath, dict) {
  const target = inspectTargetDirectory(targetDirPath);
  if (!target) {
    throw new Error(`Папка "${targetDirPath}" не содержит установки Google Antigravity.`);
  }

  const foundMap = new Map(); // string -> first file where seen

  const recordCandidates = (relPath, list) => {
    for (const item of list) {
      if (!foundMap.has(item)) {
        foundMap.set(item, relPath);
      }
    }
  };

  if (target.asarPath && fs.existsSync(target.asarPath)) {
    const info = readAsarHeader(target.asarPath);
    const entries = listAsarEntries(info.header);
    const fd = fs.openSync(target.asarPath, 'r');
    try {
      for (const { relPath, meta } of entries) {
        if (meta.unpacked || typeof meta.link === 'string' || typeof meta.size !== 'number' || meta.size > 15 * 1024 * 1024) {
          continue;
        }
        const lower = relPath.toLowerCase();
        if (lower.startsWith('node_modules/') || lower.includes('/__mocks__/') || lower.includes('/test/')) {
          continue;
        }
        let kind = null;
        if (isLocalizationJsonPath(lower)) kind = 'json';
        else if (lower.endsWith('.html') || lower.endsWith('.htm')) kind = 'html';
        else if (lower.endsWith('.js') || lower.endsWith('.mjs')) kind = 'js';
        if (!kind) continue;

        const buf = Buffer.alloc(meta.size);
        fs.readSync(fd, buf, 0, meta.size, info.dataOffset + Number(BigInt(meta.offset)));
        const list = extractUntranslatedCandidates(buf.toString('utf8'), kind, dict);
        recordCandidates(relPath, list);
      }
    } finally {
      fs.closeSync(fd);
    }
  }

  const unpackedDirs = [
    target.appDir,
    target.asarPath ? `${target.asarPath}.unpacked` : null,
  ].filter((d) => d && fs.existsSync(d));

  for (const dir of unpackedDirs) {
    const files = collectPatchableFiles(dir);
    for (const absFile of files) {
      const stat = fs.statSync(absFile);
      if (stat.size > 15 * 1024 * 1024) continue;
      const relPath = path.relative(target.installRoot, absFile).replace(/\\/g, '/');
      const lower = relPath.toLowerCase();
      let kind = null;
      if (isLocalizationJsonPath(lower)) kind = 'json';
      else if (lower.endsWith('.html') || lower.endsWith('.htm')) kind = 'html';
      else if (lower.endsWith('.js') || lower.endsWith('.mjs')) kind = 'js';
      if (!kind) continue;

      const content = fs.readFileSync(absFile, 'utf8');
      const list = extractUntranslatedCandidates(content, kind, dict);
      recordCandidates(relPath, list);
    }
  }

  // Дополнительно сканируем встроенный ZIP-бандл веб-интерфейса внутри resources/bin/language_server*
  const binDir = path.join(target.installRoot, 'resources', 'bin');
  if (fs.existsSync(binDir)) {
    try {
      const binEntries = fs.readdirSync(binDir, { withFileTypes: true });
      for (const b of binEntries) {
        if (b.isFile() && /^language_server/i.test(b.name)) {
          scanEmbeddedZipInLanguageServer(path.join(binDir, b.name), dict, recordCandidates);
        }
      }
    } catch {}
  }

  const candidates = [...foundMap.entries()]
    .map(([text, sourceFile]) => ({ text, sourceFile }))
    .sort((a, b) => a.text.localeCompare(b.text));

  return {
    installRoot: target.installRoot,
    label: target.label,
    count: candidates.length,
    candidates,
  };
}

module.exports = {
  computeMatchingChecksum,
  updateIdeProductChecksums,
  configureIdeLocaleArgv,
  patchInstallation,
  restoreInstallation,
  extractCandidatesFromInstallation,
};
