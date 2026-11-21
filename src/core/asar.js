'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const ASAR_BLOCK_SIZE = 4 * 1024 * 1024; // 4 MB standard Electron integrity block size

/**
 * Вычисляет структуру integrity (SHA256 + 4MB блоки), совместимую с Electron 22+.
 * @param {Buffer} buffer
 */
function computeIntegrity(buffer) {
  const hash = crypto.createHash('sha256').update(buffer).digest('hex');
  const blocks = [];
  if (buffer.length === 0) {
    blocks.push(crypto.createHash('sha256').update(Buffer.alloc(0)).digest('hex'));
  } else {
    for (let offset = 0; offset < buffer.length; offset += ASAR_BLOCK_SIZE) {
      const chunk = buffer.subarray(offset, Math.min(offset + ASAR_BLOCK_SIZE, buffer.length));
      blocks.push(crypto.createHash('sha256').update(chunk).digest('hex'));
    }
  }
  return {
    algorithm: 'SHA256',
    hash,
    blockSize: ASAR_BLOCK_SIZE,
    blocks,
  };
}

/**
 * Сериализует объект заголовка ASAR в бинарный буфер Chromium Pickle (16 байт префикса + JSON + выравнивание 4 байта).
 * @param {object} headerObj
 * @returns {{ prefixBuffer: Buffer, headerString: string, headerHash: string }}
 */
function serializeAsarHeader(headerObj) {
  const headerString = JSON.stringify(headerObj);
  const strBuf = Buffer.from(headerString, 'utf8');
  const strLen = strBuf.length;
  const padding = (4 - (strLen % 4)) % 4;
  const headerPayloadLen = 4 + strLen + padding;
  const headerBufLen = 4 + headerPayloadLen; // 8 + strLen + padding

  const prefixBuffer = Buffer.alloc(8 + headerBufLen, 0);
  prefixBuffer.writeUInt32LE(4, 0); // sizePickle payload length
  prefixBuffer.writeUInt32LE(headerBufLen, 4); // headerPickle total length
  prefixBuffer.writeUInt32LE(headerPayloadLen, 8); // headerPickle payload length
  prefixBuffer.writeUInt32LE(strLen, 12); // JSON string byte length
  strBuf.copy(prefixBuffer, 16);

  const headerHash = crypto.createHash('sha256').update(strBuf).digest('hex');
  return { prefixBuffer, headerString, headerHash };
}

/**
 * Читает заголовок архива Electron .asar без загрузки всего архива в память.
 * @param {string} asarPath
 */
function readAsarHeader(asarPath) {
  const fd = fs.openSync(asarPath, 'r');
  try {
    const fixed = Buffer.alloc(16);
    const bytesRead = fs.readSync(fd, fixed, 0, 16, 0);
    if (bytesRead < 16) {
      throw new Error(`Файл ASAR слишком мал или повреждён: ${asarPath}`);
    }

    const sizePicklePayload = fixed.readUInt32LE(0);
    const headerBufLen = fixed.readUInt32LE(4);
    const headerPayloadLen = fixed.readUInt32LE(8);
    const strLen = fixed.readUInt32LE(12);

    if (sizePicklePayload !== 4 || strLen === 0 || strLen > headerBufLen || headerBufLen > 256 * 1024 * 1024) {
      throw new Error(`Некорректная сигнатура заголовка ASAR в файле: ${asarPath}`);
    }

    const strBuf = Buffer.alloc(strLen);
    const strRead = fs.readSync(fd, strBuf, 0, strLen, 16);
    if (strRead !== strLen) {
      throw new Error(`Неожиданный конец заголовка ASAR: ${asarPath}`);
    }

    const headerString = strBuf.toString('utf8');
    const header = JSON.parse(headerString);
    const headerHash = crypto.createHash('sha256').update(strBuf).digest('hex');
    const dataOffset = 8 + headerBufLen;

    return {
      header,
      headerString,
      headerHash,
      headerPayloadLen,
      dataOffset,
    };
  } finally {
    fs.closeSync(fd);
  }
}

/**
 * Возвращает плоский список всех файлов в заголовке ASAR.
 * @param {object} header
 * @returns {Array<{ relPath: string, meta: object }>}
 */
function listAsarEntries(header) {
  const entries = [];
  function walk(node, prefix) {
    if (!node || typeof node !== 'object' || !node.files) return;
    for (const [name, child] of Object.entries(node.files)) {
      const relPath = prefix ? `${prefix}/${name}` : name;
      if (child && typeof child === 'object' && child.files) {
        walk(child, relPath);
      } else if (child && typeof child === 'object') {
        entries.push({ relPath, meta: child });
      }
    }
  }
  walk(header, '');
  return entries;
}

/**
 * Читает один упакованный файл из ASAR.
 * @param {string} asarPath
 * @returns {Map<string, Buffer>}
 */
function readAsarFile(fd, dataOffset, meta) {
  const offset = dataOffset + Number(BigInt(meta.offset));
  const buf = Buffer.alloc(meta.size);
  if (meta.size > 0) {
    const read = fs.readSync(fd, buf, 0, meta.size, offset);
    if (read !== meta.size) {
      throw new Error(`Ошибка чтения данных из ASAR по смещению ${offset}`);
    }
  }
  return buf;
}

/**
 * Трансформирует файлы внутри .asar архива с помощью callback(relPath, buffer) => newBuffer | null.
 * При dryRun = true не изменяет архив на диске, но возвращает точную статистику.
 *
 * @param {string} asarPath
 * @param {(relPath: string, content: Buffer) => Buffer | null} transformFn
 * @param {{ dryRun?: boolean }} [options]
 */
function transformAsarArchive(asarPath, transformFn, options = {}) {
  const { dryRun = false } = options;
  const info = readAsarHeader(asarPath);
  const newHeader = structuredClone(info.header);
  const modifiedBuffers = new Map();
  let modifiedFilesCount = 0;

  const srcFd = fs.openSync(asarPath, 'r');
  try {
    function scanNode(node, prefix) {
      if (!node || !node.files) return;
      for (const [name, child] of Object.entries(node.files)) {
        const relPath = prefix ? `${prefix}/${name}` : name;
        if (child && child.files) {
          scanNode(child, relPath);
        } else if (child && !child.unpacked && typeof child.link !== 'string' && typeof child.size === 'number') {
          const ext = path.posix.extname(relPath).toLowerCase();
          if (['.js', '.mjs', '.cjs', '.html', '.htm', '.json'].includes(ext)) {
            const origBuf = readAsarFile(srcFd, info.dataOffset, child);
            const nextBuf = transformFn(relPath, origBuf);
            if (nextBuf && !nextBuf.equals(origBuf)) {
              modifiedBuffers.set(relPath, nextBuf);
              modifiedFilesCount += 1;
            }
          }
        }
      }
    }

    scanNode(newHeader, '');

    if (modifiedFilesCount === 0 || dryRun) {
      return {
        changed: modifiedFilesCount > 0,
        modifiedFilesCount,
        oldHeaderHash: info.headerHash,
        newHeaderHash: info.headerHash,
      };
    }

    // Пересчёт смещений (offset), размеров (size) и SHA256 integrity
    let currentOffset = 0n;
    const writePlan = [];

    function rebuildNode(origNode, targetNode, prefix) {
      if (!targetNode || !targetNode.files) return;
      for (const [name, child] of Object.entries(targetNode.files)) {
        const relPath = prefix ? `${prefix}/${name}` : name;
        const origChild = origNode.files[name];
        if (child && child.files) {
          rebuildNode(origChild, child, relPath);
        } else if (child && !child.unpacked && typeof child.link !== 'string' && typeof child.size === 'number') {
          if (modifiedBuffers.has(relPath)) {
            const buf = modifiedBuffers.get(relPath);
            child.size = buf.length;
            child.offset = currentOffset.toString();
            child.integrity = computeIntegrity(buf);
            writePlan.push({ type: 'buffer', buf });
            currentOffset += BigInt(buf.length);
          } else {
            const origOffset = info.dataOffset + Number(BigInt(origChild.offset));
            const size = origChild.size;
            child.size = size;
            child.offset = currentOffset.toString();
            if (!child.integrity) {
              const tmpBuf = readAsarFile(srcFd, info.dataOffset, origChild);
              child.integrity = computeIntegrity(tmpBuf);
            }
            writePlan.push({ type: 'copy', srcOffset: origOffset, size });
            currentOffset += BigInt(size);
          }
        }
      }
    }

    rebuildNode(info.header, newHeader, '');

    const { prefixBuffer, headerHash: newHeaderHash } = serializeAsarHeader(newHeader);
    const tmpPath = `${asarPath}.ru-tmp-${process.pid}`;
    const outFd = fs.openSync(tmpPath, 'w');
    const copyChunk = Buffer.alloc(Math.min(ASAR_BLOCK_SIZE, 1024 * 1024));

    try {
      fs.writeSync(outFd, prefixBuffer, 0, prefixBuffer.length);
      for (const item of writePlan) {
        if (item.type === 'buffer') {
          if (item.buf.length > 0) {
            fs.writeSync(outFd, item.buf, 0, item.buf.length);
          }
        } else {
          let remaining = item.size;
          let readPos = item.srcOffset;
          while (remaining > 0) {
            const toRead = Math.min(remaining, copyChunk.length);
            const bytes = fs.readSync(srcFd, copyChunk, 0, toRead, readPos);
            if (bytes <= 0) {
              throw new Error(`Не удалось скопировать блок ASAR из смещения ${readPos}`);
            }
            fs.writeSync(outFd, copyChunk, 0, bytes);
            readPos += bytes;
            remaining -= bytes;
          }
        }
      }
    } catch (err) {
      try { fs.closeSync(outFd); } catch {}
      try { fs.unlinkSync(tmpPath); } catch {}
      throw err;
    }

    fs.closeSync(outFd);
    fs.closeSync(srcFd);

    try {
      fs.renameSync(tmpPath, asarPath);
    } catch (renameErr) {
      if (renameErr && (renameErr.code === 'EPERM' || renameErr.code === 'EBUSY')) {
        // When Antigravity is running on Windows, app.asar is opened with FILE_SHARE_WRITE but without FILE_SHARE_DELETE.
        // Overwrite in-place via r+ file descriptor and remove temp file.
        let srcTmpFd = null;
        let destAsarFd = null;
        try {
          srcTmpFd = fs.openSync(tmpPath, 'r');
          destAsarFd = fs.openSync(asarPath, 'r+');
          const buf = Buffer.alloc(1024 * 1024);
          let pos = 0;
          while (true) {
            const bytesRead = fs.readSync(srcTmpFd, buf, 0, buf.length, pos);
            if (bytesRead <= 0) break;
            fs.writeSync(destAsarFd, buf, 0, bytesRead, pos);
            pos += bytesRead;
          }
          fs.ftruncateSync(destAsarFd, pos);
        } finally {
          if (srcTmpFd !== null) try { fs.closeSync(srcTmpFd); } catch {}
          if (destAsarFd !== null) try { fs.closeSync(destAsarFd); } catch {}
          try { fs.unlinkSync(tmpPath); } catch {}
        }
      } else {
        try { fs.unlinkSync(tmpPath); } catch {}
        throw renameErr;
      }
    }

    return {
      changed: true,
      modifiedFilesCount,
      oldHeaderHash: info.headerHash,
      newHeaderHash,
    };
  } finally {
    try { fs.closeSync(srcFd); } catch {}
  }
}

/**
 * Упаковывает обычную директорию в файл .asar (удобно для тестов и сборки).
 * @param {string} srcDir
 * @param {string} destAsarPath
 */
function createAsarFromDirectory(srcDir, destAsarPath) {
  const header = { files: {} };
  const chunks = [];
  let currentOffset = 0n;

  function addDir(absDir, node) {
    const items = fs.readdirSync(absDir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name));
    for (const item of items) {
      const fullPath = path.join(absDir, item.name);
      if (item.isDirectory()) {
        node.files[item.name] = { files: {} };
        addDir(fullPath, node.files[item.name]);
      } else if (item.isFile()) {
        const buf = fs.readFileSync(fullPath);
        node.files[item.name] = {
          size: buf.length,
          offset: currentOffset.toString(),
          integrity: computeIntegrity(buf),
        };
        chunks.push(buf);
        currentOffset += BigInt(buf.length);
      }
    }
  }

  addDir(srcDir, header);
  const { prefixBuffer, headerHash } = serializeAsarHeader(header);
  fs.mkdirSync(path.dirname(destAsarPath), { recursive: true });
  const fd = fs.openSync(destAsarPath, 'w');
  try {
    fs.writeSync(fd, prefixBuffer, 0, prefixBuffer.length);
    for (const buf of chunks) {
      if (buf.length > 0) {
        fs.writeSync(fd, buf, 0, buf.length);
      }
    }
  } finally {
    fs.closeSync(fd);
  }
  return { header, headerHash };
}

module.exports = {
  ASAR_BLOCK_SIZE,
  computeIntegrity,
  serializeAsarHeader,
  readAsarHeader,
  listAsarEntries,
  transformAsarArchive,
  createAsarFromDirectory,
};
