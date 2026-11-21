'use strict';

const fs = require('node:fs');
const path = require('node:path');

const DEFAULT_DICT_DIR = path.resolve(__dirname, '..', '..', 'dictionaries');

// Специфичные однословные термины Google Antigravity, которые безопасно переводить в строковых литералах UI
const SAFE_DOMAIN_SINGLE_WORDS = new Set([
  'Subagents',
  'Supercomplete',
  'Customizations',
  'Marketplace',
  'Workspaces',
  'Sidecars',
  'Walkthrough',
  'Regenerate',
  'Reconnect',
  'Shortcuts',
  'Automations',
  'Models',
  'Notifications',
  'Appearance',
  'Updater',
  'Microphone',
  'Telemetry',
  'Conversations',
  'Artifacts',
  'Plugins',
  'Skills',
  'Hooks',
  'Passkeys',
  'Quit',
]);

/**
 * Загружает основной словарь ui-ru.json и пользовательские переопределения user-overrides.json.
 * @param {string} [dictDir]
 */
function loadDictionary(dictDir = DEFAULT_DICT_DIR) {
  const basePath = path.join(dictDir, 'ui-ru.json');
  const overridesPath = path.join(dictDir, 'user-overrides.json');

  const rawBase = JSON.parse(fs.readFileSync(basePath, 'utf8'));
  let rawOverrides = { entries: {} };
  if (fs.existsSync(overridesPath)) {
    try {
      rawOverrides = JSON.parse(fs.readFileSync(overridesPath, 'utf8'));
    } catch {
      rawOverrides = { entries: {} };
    }
  }

  const allEntries = new Map();
  const categories = [];

  for (const [catId, catData] of Object.entries(rawBase.categories || {})) {
    const entriesObj = catData.entries || {};
    const count = Object.keys(entriesObj).length;
    categories.push({
      id: catId,
      title: catData.title || catId,
      count,
      entries: { ...entriesObj },
    });
    for (const [en, ru] of Object.entries(entriesObj)) {
      if (en && typeof ru === 'string' && ru.trim()) {
        allEntries.set(en, ru);
      }
    }
  }

  const userEntries = rawOverrides.entries || {};
  for (const [en, ru] of Object.entries(userEntries)) {
    if (en && typeof ru === 'string' && ru.trim()) {
      allEntries.set(en, ru);
    }
  }

  // Классифицируем фразы: многословные / с пунктуацией против коротких одиночных слов
  const phraseEntries = new Map();
  const contextOnlySingleWords = new Map();

  for (const [en, ru] of allEntries.entries()) {
    const hasSpaceOrPunct = /[\s.!?&/()-]/.test(en);
    if (hasSpaceOrPunct || SAFE_DOMAIN_SINGLE_WORDS.has(en)) {
      phraseEntries.set(en, ru);
    } else {
      contextOnlySingleWords.set(en, ru);
    }
  }

  return {
    meta: rawBase.meta || {},
    dictDir,
    basePath,
    overridesPath,
    categories,
    userOverrides: { ...userEntries },
    allEntries,
    phraseEntries,
    contextOnlySingleWords,
    totalCount: allEntries.size,
  };
}

/**
 * Сохраняет или удаляет пользовательское переопределение перевода в user-overrides.json.
 * @param {string} sourceEn
 * @param {string | null} targetRu Если null или пустая строка — удаляет переопределение
 * @param {string} [dictDir]
 */
function saveUserOverride(sourceEn, targetRu, dictDir = DEFAULT_DICT_DIR) {
  const overridesPath = path.join(dictDir, 'user-overrides.json');
  let data = {
    _comment: 'Пользовательские переопределения перевода. Строки здесь имеют приоритет над основным словарём ui-ru.json.',
    entries: {},
  };
  if (fs.existsSync(overridesPath)) {
    try {
      const parsed = JSON.parse(fs.readFileSync(overridesPath, 'utf8'));
      if (parsed && typeof parsed === 'object') {
        data = { ...data, ...parsed, entries: { ...(parsed.entries || {}) } };
      }
    } catch {}
  }

  const key = String(sourceEn || '').trim();
  if (!key) {
    throw new Error('Исходная английская строка не может быть пустой');
  }

  if (targetRu === null || targetRu === undefined || String(targetRu).trim() === '') {
    delete data.entries[key];
  } else {
    data.entries[key] = String(targetRu).trim();
  }

  fs.mkdirSync(path.dirname(overridesPath), { recursive: true });
  fs.writeFileSync(overridesPath, JSON.stringify(data, null, 2) + '\n', 'utf8');
  return loadDictionary(dictDir);
}

module.exports = {
  DEFAULT_DICT_DIR,
  SAFE_DOMAIN_SINGLE_WORDS,
  loadDictionary,
  saveUserOverride,
};
