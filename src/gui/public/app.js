'use strict';

(() => {
  const token = window.__AGY_RU_TOKEN__ || '';
  let appState = null;
  let initialPluginSettingsSynced = false;

  const els = {
    tabBtns: document.querySelectorAll('.tab-btn'),
    tabPanels: document.querySelectorAll('.tab-panel'),
    dictCountBadge: document.getElementById('dictCountBadge'),
    pluginStatusBadge: document.getElementById('pluginStatusBadge'),
    pluginPathText: document.getElementById('pluginPathText'),
    chkEnablePlugin: document.getElementById('chkEnablePlugin'),
    chkTokenEconomy: document.getElementById('chkTokenEconomy'),
    chkRussianThinking: document.getElementById('chkRussianThinking'),
    chkRussianComments: document.getElementById('chkRussianComments'),
    chkConfigureLocale: document.getElementById('chkConfigureLocale'),
    chkPatchIntegrity: document.getElementById('chkPatchIntegrity'),
    installationsList: document.getElementById('installationsList'),
    inputManualPath: document.getElementById('inputManualPath'),
    btnAddManualPath: document.getElementById('btnAddManualPath'),
    btnBrowseFolder: document.getElementById('btnBrowseFolder'),
    btnInstall: document.getElementById('btnInstall'),
    btnDryRun: document.getElementById('btnDryRun'),
    btnRestore: document.getElementById('btnRestore'),
    btnRefresh: document.getElementById('btnRefresh'),
    btnQuit: document.getElementById('btnQuit'),
    btnClearLog: document.getElementById('btnClearLog'),
    logOutput: document.getElementById('logOutput'),
    inputSourceEn: document.getElementById('inputSourceEn'),
    inputTargetRu: document.getElementById('inputTargetRu'),
    btnSaveOverride: document.getElementById('btnSaveOverride'),
    inputDictSearch: document.getElementById('inputDictSearch'),
    dictCategoriesContainer: document.getElementById('dictCategoriesContainer'),
    selectScanDir: document.getElementById('selectScanDir'),
    btnScanUntranslated: document.getElementById('btnScanUntranslated'),
    scanResultsBox: document.getElementById('scanResultsBox'),
  };

  function log(msg) {
    const time = new Date().toLocaleTimeString('ru-RU');
    els.logOutput.textContent += `\n[${time}] ${msg}`;
    els.logOutput.scrollTop = els.logOutput.scrollHeight;
  }

  async function api(pathUrl, method = 'GET', body = null) {
    const opts = {
      method,
      headers: {
        'X-Session-Token': token,
      },
    };
    if (body !== null) {
      opts.headers['Content-Type'] = 'application/json';
      opts.body = JSON.stringify(body);
    }
    const res = await fetch(pathUrl, opts);
    const data = await res.json();
    if (!res.ok && data && data.error) {
      throw new Error(data.error);
    }
    return data;
  }

  function escapeHtml(s) {
    return String(s)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  function getSelectedInstallDirs() {
    const boxes = els.installationsList.querySelectorAll('input[type="checkbox"][data-install-dir]');
    const dirs = [];
    boxes.forEach((b) => {
      if (b.checked) dirs.push(b.getAttribute('data-install-dir'));
    });
    return dirs;
  }

  function renderInstallations(env) {
    const agent = env.agentConfig;
    els.pluginPathText.textContent = agent.pluginDir;
    if (agent.installed) {
      els.pluginStatusBadge.textContent = 'Установлен';
      els.pluginStatusBadge.className = 'status-badge ok';
      if (!initialPluginSettingsSynced && agent.settings) {
        if (els.chkTokenEconomy) els.chkTokenEconomy.checked = Boolean(agent.settings.tokenEconomy);
        if (els.chkRussianThinking) els.chkRussianThinking.checked = Boolean(agent.settings.russianThinking);
        if (els.chkRussianComments) els.chkRussianComments.checked = Boolean(agent.settings.russianCodeComments);
        initialPluginSettingsSynced = true;
      }
    } else {
      els.pluginStatusBadge.textContent = 'Не установлен';
      els.pluginStatusBadge.className = 'status-badge en';
    }

    const list = env.installations || [];
    els.selectScanDir.innerHTML = '';

    if (list.length === 0) {
      els.installationsList.innerHTML = `
        <div class="empty-state">
          Стандартные папки установки не найдены автоматически.<br>
          Нажмите <b>«+ Обзор папки...»</b> или вставьте путь к установленному Google Antigravity выше.
        </div>`;
      const opt = document.createElement('option');
      opt.value = '';
      opt.textContent = 'Нет выбранных папок';
      els.selectScanDir.appendChild(opt);
      return;
    }

    els.installationsList.innerHTML = list
      .map((inst) => {
        const statusBadge = inst.patched
          ? `<span class="status-badge ok">Русифицировано (${inst.patchedStringsCount} замен)</span>`
          : `<span class="status-badge en">Оригинал (EN)</span>`;
        const backupNote = inst.hasBackup ? ' • Бэкап создан' : '';
        return `
          <label class="target-row">
            <input type="checkbox" data-install-dir="${escapeHtml(inst.installRoot)}" checked>
            <div class="target-info">
              <div class="target-title">
                <span>${escapeHtml(inst.label)}</span>
                <span class="muted">v${escapeHtml(inst.version)}</span>
                ${statusBadge}
              </div>
              <div class="target-path">${escapeHtml(inst.installRoot)}${backupNote}</div>
            </div>
          </label>
        `;
      })
      .join('');

    for (const inst of list) {
      const opt = document.createElement('option');
      opt.value = inst.installRoot;
      opt.textContent = `${inst.label} (${inst.installRoot})`;
      els.selectScanDir.appendChild(opt);
    }
  }

  function renderDictionary(dictData, filterQuery = '') {
    els.dictCountBadge.textContent = String(dictData.totalCount || 0);
    const q = filterQuery.trim().toLowerCase();
    const overrides = dictData.userOverrides || {};
    const blocks = [];

    const overrideKeys = Object.keys(overrides);
    if (overrideKeys.length > 0) {
      const filteredOv = overrideKeys.filter(
        (k) => !q || k.toLowerCase().includes(q) || String(overrides[k]).toLowerCase().includes(q)
      );
      if (filteredOv.length > 0) {
        blocks.push(`
          <div class="dict-category">
            <h4>Пользовательские переопределения (${filteredOv.length})</h4>
            <table class="dict-table">
              <tbody>
                ${filteredOv
                  .map(
                    (en) => `
                  <tr data-en="${escapeHtml(en)}" data-ru="${escapeHtml(overrides[en])}">
                    <td class="dict-en">${escapeHtml(en)}</td>
                    <td class="dict-ru">${escapeHtml(overrides[en])}</td>
                  </tr>`
                  )
                  .join('')}
              </tbody>
            </table>
          </div>
        `);
      }
    }

    for (const cat of dictData.categories || []) {
      const pairs = Object.entries(cat.entries || {}).filter(([en, ru]) => {
        const effectiveRu = overrides[en] || ru;
        return !q || en.toLowerCase().includes(q) || effectiveRu.toLowerCase().includes(q);
      });
      if (pairs.length === 0) continue;

      blocks.push(`
        <div class="dict-category">
          <h4>${escapeHtml(cat.title)} (${pairs.length})</h4>
          <table class="dict-table">
            <tbody>
              ${pairs
                .map(([en, ru]) => {
                  const effectiveRu = overrides[en] || ru;
                  return `
                  <tr data-en="${escapeHtml(en)}" data-ru="${escapeHtml(effectiveRu)}" title="Нажмите, чтобы изменить перевод">
                    <td class="dict-en">${escapeHtml(en)}</td>
                    <td class="dict-ru">${escapeHtml(effectiveRu)}</td>
                  </tr>`;
                })
                .join('')}
            </tbody>
          </table>
        </div>
      `);
    }

    els.dictCategoriesContainer.innerHTML =
      blocks.join('') || '<div class="empty-state">Ничего не найдено по вашему запросу.</div>';
  }

  // Делегирование клика по строкам словаря (мгновенная работа при 2800+ строках)
  els.dictCategoriesContainer.addEventListener('click', (e) => {
    const row = e.target.closest('tr[data-en]');
    if (!row) return;
    els.inputSourceEn.value = row.getAttribute('data-en') || '';
    els.inputTargetRu.value = row.getAttribute('data-ru') || '';
    els.inputTargetRu.focus();
  });

  async function refreshState() {
    try {
      const res = await api('/api/state');
      appState = res;
      renderInstallations(res.environment);
      renderDictionary(res.dictionary, els.inputDictSearch.value);
    } catch (err) {
      log(`Ошибка обновления состояния: ${err.message}`);
    }
  }

  async function runInstallFlow(dryRun) {
    const installDirs = getSelectedInstallDirs();
    const enableAgentPlugin = els.chkEnablePlugin.checked;

    if (installDirs.length === 0 && !enableAgentPlugin) {
      log('Выберите хотя бы один компонент (плагин ИИ-агента или папку установки программы).');
      return;
    }

    els.btnInstall.disabled = true;
    els.btnDryRun.disabled = true;
    log(dryRun ? 'Запуск пробной проверки (Dry-Run)...' : 'Начинаю установку русификатора и создание резервных копий...');

    try {
      const res = await api('/api/install', 'POST', {
        dryRun,
        installDirs,
        enableAgentPlugin,
        tokenEconomy: els.chkTokenEconomy ? els.chkTokenEconomy.checked : true,
        russianThinking: els.chkRussianThinking ? els.chkRussianThinking.checked : false,
        russianCodeComments: els.chkRussianComments.checked,
        configureLocale: els.chkConfigureLocale.checked,
        patchExeIntegrity: els.chkPatchIntegrity.checked,
      });

      for (const ui of res.uiResults || []) {
        const prefix = dryRun ? '[Проверка]' : '[Готово]';
        log(
          `${prefix} ${ui.label}: файлов обновлено — ${ui.patchedFilesCount}, переведено записей — ${ui.totalReplacements}` +
            (ui.domRuntimeInjected ? `, внедрён живой переводчик Web UI (preload)` : '') +
            (ui.integrityHashUpdated ? `, обновлён хеш ElectronAsarIntegrity` : '') +
            (ui.createdFilesCount ? `, создано NLS RU — ${ui.createdFilesCount}` : '') +
            (ui.updatedChecksumsCount ? `, пересчитано контрольных сумм product.json — ${ui.updatedChecksumsCount}` : '') +
            (ui.localeConfigured ? `, настроен locale="ru" в argv.json` : '')
        );
        for (const w of ui.warnings || []) {
          log(`  [Внимание] ${w}`);
        }
      }

      if (res.pluginResult) {
        const ps = res.pluginResult.settings || {};
        const summary = `экономия токенов: ${ps.tokenEconomy ? 'ВКЛ' : 'ВЫКЛ'}, Thinking: ${ps.russianThinking ? 'RU' : 'EN компактный'}`;
        if (dryRun) {
          log(`[Проверка] Плагин ИИ-агента будет установлен в: ${res.pluginResult.pluginDir} (${summary})`);
        } else {
          log(`[Готово] Плагин ИИ-агента установлен: ${res.pluginResult.pluginDir} (${summary})`);
          if (res.pluginResult.restartRequired) {
            log('  -> Перезапустите Google Antigravity, чтобы новый плагин и перевод интерфейса вступили в силу.');
          }
        }
      }

      for (const e of res.errors || []) {
        log(`[ОШИБКА] (${e.dir}): ${e.message}`);
      }

      await refreshState();
    } catch (err) {
      log(`[ОШИБКА] ${err.message}`);
    } finally {
      els.btnInstall.disabled = false;
      els.btnDryRun.disabled = false;
    }
  }

  // Переключение вкладок
  els.tabBtns.forEach((btn) => {
    btn.addEventListener('click', () => {
      const target = btn.getAttribute('data-tab');
      els.tabBtns.forEach((b) => b.classList.toggle('active', b === btn));
      els.tabPanels.forEach((p) => p.classList.toggle('active', p.id === `tab-${target}`));
    });
  });

  els.btnBrowseFolder.addEventListener('click', async () => {
    els.btnBrowseFolder.disabled = true;
    try {
      const res = await api('/api/add-dir', 'POST', { browseNative: true });
      if (!res.cancelled && res.installation) {
        log(`Добавлена папка: ${res.installation.label} (${res.installation.installRoot})`);
        await refreshState();
      }
    } catch (err) {
      log(`[ОШИБКА] ${err.message}`);
    } finally {
      els.btnBrowseFolder.disabled = false;
    }
  });

  els.btnAddManualPath.addEventListener('click', async () => {
    const dirPath = els.inputManualPath.value.trim();
    if (!dirPath) return;
    try {
      const res = await api('/api/add-dir', 'POST', { dirPath });
      els.inputManualPath.value = '';
      log(`Добавлена папка: ${res.installation.label} (${res.installation.installRoot})`);
      await refreshState();
    } catch (err) {
      log(`[ОШИБКА] ${err.message}`);
    }
  });

  els.btnInstall.addEventListener('click', () => runInstallFlow(false));
  els.btnDryRun.addEventListener('click', () => runInstallFlow(true));

  els.btnRestore.addEventListener('click', async () => {
    const installDirs = getSelectedInstallDirs();
    const removeAgentPlugin = window.confirm(
      'Восстановить оригинальные английские файлы интерфейса из бэкапа?\n\nНажмите ОК для продолжения.'
    );
    if (!removeAgentPlugin) return;

    const alsoRemovePlugin = window.confirm(
      'Удалить также плагин русификации ИИ-агента (antigravity-ru-agent)?\n(Нажмите «Отмена», если хотите откатить только интерфейс UI, но оставить русскоязычного агента)'
    );

    try {
      const res = await api('/api/restore', 'POST', {
        installDirs,
        removeAgentPlugin: alsoRemovePlugin,
      });
      for (const r of res.restoreResults || []) {
        log(`[Откат] ${r.dir}: ${r.message}`);
      }
      if (res.pluginResult) {
        log(`[Откат плагина] ${res.pluginResult.message}`);
      }
      for (const e of res.errors || []) {
        log(`[ОШИБКА] ${e.message}`);
      }
      await refreshState();
    } catch (err) {
      log(`[ОШИБКА] ${err.message}`);
    }
  });

  els.btnSaveOverride.addEventListener('click', async () => {
    const sourceEn = els.inputSourceEn.value.trim();
    const targetRu = els.inputTargetRu.value.trim();
    if (!sourceEn) {
      log('Введите исходную английскую строку для сохранения в словарь.');
      return;
    }
    try {
      await api('/api/override', 'POST', { sourceEn, targetRu });
      log(
        targetRu
          ? `Сохранено в user-overrides.json: "${sourceEn}" -> "${targetRu}". Нажмите «Установить русификатор» для применения.`
          : `Удалено пользовательское переопределение для "${sourceEn}".`
      );
      els.inputSourceEn.value = '';
      els.inputTargetRu.value = '';
      await refreshState();
    } catch (err) {
      log(`[ОШИБКА] ${err.message}`);
    }
  });

  els.inputDictSearch.addEventListener('input', () => {
    if (appState && appState.dictionary) {
      renderDictionary(appState.dictionary, els.inputDictSearch.value);
    }
  });

  els.btnScanUntranslated.addEventListener('click', async () => {
    const dirPath = els.selectScanDir.value;
    if (!dirPath) {
      log('Сначала добавьте папку установки Google Antigravity во вкладке «Установка и откат».');
      return;
    }
    els.btnScanUntranslated.disabled = true;
    try {
      const res = await api('/api/extract', 'POST', { dirPath });
      els.scanResultsBox.classList.remove('hidden');
      if (!res.candidates || res.candidates.length === 0) {
        els.scanResultsBox.innerHTML = '<div class="muted">Новых непереведённых строк UI не обнаружено.</div>';
      } else {
        els.scanResultsBox.innerHTML = res.candidates
          .map(
            (c) => `
            <div class="scan-item">
              <div>
                <code>${escapeHtml(c.text)}</code>
                <span class="muted"> — ${escapeHtml(c.sourceFile)}</span>
              </div>
              <button class="btn btn-secondary btn-pick-cand" data-cand="${escapeHtml(c.text)}">Перевести</button>
            </div>`
          )
          .join('');
        els.scanResultsBox.querySelectorAll('.btn-pick-cand').forEach((b) => {
          b.addEventListener('click', () => {
            els.inputSourceEn.value = b.getAttribute('data-cand') || '';
            els.inputTargetRu.value = '';
            els.inputTargetRu.focus();
          });
        });
      }
      log(`Сканирование завершено: найдено ${res.count} строк-кандидатов.`);
    } catch (err) {
      log(`[ОШИБКА сканирования] ${err.message}`);
    } finally {
      els.btnScanUntranslated.disabled = false;
    }
  });

  els.btnRefresh.addEventListener('click', () => refreshState());
  els.btnClearLog.addEventListener('click', () => {
    els.logOutput.textContent = 'Журнал очищен.';
  });

  els.btnQuit.addEventListener('click', async () => {
    try {
      await api('/api/shutdown', 'POST', {});
    } catch {}
    window.close();
  });

  refreshState();
})();
