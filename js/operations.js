'use strict';

(function() {
  const OPS_FRESH_TTL_MS = 90000;
  const OPS_STALE_TTL_MS = 600000;
  const OPS_CACHE = Object.create(null);
  const OPS_STORAGE_PREFIX = 'sona_os_ops_cache_v1_';

  function getOpsCache(key) {
    const now = Date.now();
    let entry = OPS_CACHE[key];
    if (!entry) {
      try {
        const raw = sessionStorage.getItem(OPS_STORAGE_PREFIX + key);
        if (raw) {
          entry = JSON.parse(raw);
          OPS_CACHE[key] = entry;
        }
      } catch (e) {}
    }
    if (!entry || !entry.ts || (now - entry.ts) > OPS_STALE_TTL_MS) {
      return null;
    }
    return { ts: entry.ts, data: entry.data, isStale: (now - entry.ts) > OPS_FRESH_TTL_MS };
  }

  function setOpsCache(key, data) {
    if (!data || data.success === false) return;
    const entry = { ts: Date.now(), data: data };
    OPS_CACHE[key] = entry;
    try {
      sessionStorage.setItem(OPS_STORAGE_PREFIX + key, JSON.stringify(entry));
    } catch (e) {}
  }

  function invalidateOpsCache(prefix) {
    if (!prefix) {
      Object.keys(OPS_CACHE).forEach(function(k) { delete OPS_CACHE[k]; });
      try {
        Object.keys(sessionStorage).forEach(function(k) {
          if (k.indexOf(OPS_STORAGE_PREFIX) === 0) sessionStorage.removeItem(k);
        });
      } catch (e) {}
      return;
    }
    Object.keys(OPS_CACHE).forEach(function(k) {
      if (k.indexOf(prefix) === 0) delete OPS_CACHE[k];
    });
    try {
      const sp = OPS_STORAGE_PREFIX + prefix;
      Object.keys(sessionStorage).forEach(function(k) {
        if (k.indexOf(sp) === 0) sessionStorage.removeItem(k);
      });
    } catch (e) {}
  }

  function clearCache(standortId) {
    if (!standortId) {
      invalidateOpsCache('');
      return;
    }
    const sid = String(standortId);
    ['summary::', 'reklam::', 'rating::', 'todo::', 'putz::', 'news::', 'list86::', 'feedback::'].forEach(function(p) {
      invalidateOpsCache(p + sid);
    });
  }

  function mutateOpsCache(cacheKey, mutatorFn) {
    const cached = getOpsCache(cacheKey);
    if (!cached || !cached.data) return null;
    try {
      const snapshot = JSON.parse(JSON.stringify(cached.data));
      const nextData = mutatorFn(JSON.parse(JSON.stringify(cached.data)));
      if (nextData) setOpsCache(cacheKey, nextData);
      return snapshot;
    } catch (e) {
      return null;
    }
  }

  function restoreOpsCacheSnapshot(cacheKey, snapshot) {
    if (snapshot) setOpsCache(cacheKey, snapshot);
  }

  async function fetchOpsSwr(cacheKey, fetcher, forceRefresh, onBackgroundUpdate) {
    const cached = !forceRefresh ? getOpsCache(cacheKey) : null;
    if (cached && cached.data) {
      if (cached.isStale && typeof onBackgroundUpdate === 'function') {
        Promise.resolve().then(fetcher).then(function(fresh) {
          if (fresh && fresh.success) {
            const prevJson = JSON.stringify(cached.data);
            setOpsCache(cacheKey, fresh);
            if (JSON.stringify(fresh) !== prevJson) {
              onBackgroundUpdate(fresh);
            }
          }
        }).catch(function() {});
      }
      return cached.data;
    }
    const fresh = await fetcher();
    if (fresh && fresh.success) {
      setOpsCache(cacheKey, fresh);
    }
    return fresh;
  }

  const OPS_STATE = {
    activeTab: 'reklamation',
    selectedMonth: '',
    selectedPeriod: '',
    selectedTodoDate: '',
    selectedPutzplanDate: '',
    ratingSubTab: 'staff',
    meta: null,
    selectedArt: 'Gäste im Haus',
    selectedBereich: ''
  };

  function esc(val) {
    return String(val == null ? '' : val).replace(/[&<>"']/g, function(m) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[m];
    });
  }

  function fmtEur(val) {
    if (val === null || val === undefined || isNaN(Number(val))) return '–';
    return Number(val).toLocaleString('de-DE', { style: 'currency', currency: 'EUR', minimumFractionDigits: 2, maximumFractionDigits: 2 });
  }

  function fmtNum(val, digits) {
    if (val === null || val === undefined || isNaN(Number(val))) return '–';
    const d = digits !== undefined ? digits : 2;
    return Number(val).toLocaleString('de-DE', { minimumFractionDigits: d, maximumFractionDigits: d });
  }

  function todayIsoLocal() {
    const d = new Date();
    return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
  }

  function getSavedOpsName(session) {
    const uid = (session && session.user && session.user.id) ? String(session.user.id) : '';
    const fallback = (session && session.user && session.user.name) ? String(session.user.name).trim() : '';
    if (!uid) return fallback;
    try {
      const saved = localStorage.getItem('sona_os_ops_name_' + uid);
      if (saved && saved.trim()) return saved.trim();
    } catch (e) {}
    return fallback;
  }

  function saveOpsName(session, nameVal) {
    const uid = (session && session.user && session.user.id) ? String(session.user.id) : '';
    const clean = String(nameVal || '').trim();
    if (!uid || !clean) return;
    try {
      localStorage.setItem('sona_os_ops_name_' + uid, clean);
    } catch (e) {}
  }

  function openExternalTab(url) {
    window.open(url, '_blank', 'noopener,noreferrer');
    return false;
  }

  function renderBreakdownRows(items, showPieces) {
    if (!items || !items.length) {
      return '<tr><td colspan="' + (showPieces ? 5 : 4) + '">Keine Einträge in dieser Periode.</td></tr>';
    }
    return items.map(function(it) {
      return '<tr>' +
        '<td><b>' + esc(it.label || '–') + '</b></td>' +
        '<td class="tabular">' + fmtEur(it.eur) + '</td>' +
        '<td class="tabular">' + fmtNum(it.sharePct, 1) + ' %</td>' +
        (showPieces ? '<td class="tabular">' + fmtNum(it.pieces || 0, 0) + ' Stk</td>' : '') +
        '<td class="tabular">' + esc(it.count || 0) + '</td>' +
      '</tr>';
    }).join('');
  }

  async function loadMonthlySummary(session, forceRefresh, periodKey, targetEl) {
    const slot = targetEl || document.getElementById('opsSchwundKpiSlot');
    if (!slot) return;
    const chosenPeriod = periodKey !== undefined ? periodKey : (OPS_STATE.selectedPeriod || '');
    const cacheKey = 'summary::' + session.standortId + '::' + (chosenPeriod || 'LATEST');
    if (forceRefresh || !getOpsCache(cacheKey)) {
      slot.innerHTML =
        '<div class="card">' +
          '<div class="kicker">Schwund- &amp; Bruch-Auswertung · ' + esc(session.standortName) + '</div>' +
          '<p class="module-desc">Lade Auswertung …</p>' +
        '</div>';
    }

    try {
      const res = await fetchOpsSwr(
        cacheKey,
        function() { return window.SonaApi.getOpsMonthlySummary(session.standortId, !!forceRefresh, chosenPeriod); },
        !!forceRefresh,
        function() {
          const curSlot = targetEl || document.getElementById('opsSchwundKpiSlot');
          if (curSlot && document.body.contains(curSlot)) {
            loadMonthlySummary(session, false, chosenPeriod, targetEl);
          }
        }
      );
      const currentSlot = targetEl || document.getElementById('opsSchwundKpiSlot');
      if (!currentSlot || !document.body.contains(currentSlot)) return;

      if (!res || res.success === false) {
        currentSlot.innerHTML =
          '<div class="card">' +
            '<div class="kicker">Schwund- &amp; Bruch-Auswertung</div>' +
            '<h3>Auswertung konnte nicht geladen werden</h3>' +
            '<p class="module-desc">' + esc((res && res.error) || 'Unbekannter Fehler.') + '</p>' +
          '</div>';
        return;
      }

      if (res.status === 'IN_VORBEREITUNG') {
        currentSlot.innerHTML =
          '<div class="card">' +
            '<div class="kicker">Schwund- &amp; Bruch-Auswertung · ' + esc(session.standortName) + '</div>' +
            '<h3>Noch nicht für diesen Standort verknüpft</h3>' +
            '<p class="module-desc">' + esc(res.message || 'Für diesen Standort sind noch keine Schwund- und Bruch-Tabellen hinterlegt.') + '</p>' +
          '</div>';
        return;
      }

      OPS_STATE.selectedPeriod = res.periodKey || chosenPeriod || '';
      const monthLabel = res.monthLabel || 'Aktuelle Periode';
      const periods = Array.isArray(res.availablePeriods) ? res.availablePeriods : [];
      const schwund = res.schwund || { totalEur: 0, count: 0, byStation: [], byCategory: [], byVerschulden: [], byReason: [] };
      const schwundByCategory = (Array.isArray(schwund.byCategory) && schwund.byCategory.length)
        ? schwund.byCategory
        : (function() {
            const agg = {
              'Personalverbrauch': { eur: 0, count: 0 },
              'Marketing': { eur: 0, count: 0 },
              'Sonstiger Schwund': { eur: 0, count: 0 }
            };
            (schwund.byReason || []).forEach(function(item) {
              const raw = String((item && item.label) || '').trim();
              const low = raw.toLowerCase();
              let cat = 'Sonstiger Schwund';
              if (/^4\b|^4\./.test(raw) || low.indexOf('personal') !== -1 || low.indexOf('verkostung') !== -1 || low.indexOf('probe') !== -1 || low.indexOf('mitarbeiter') !== -1) {
                cat = 'Personalverbrauch';
              } else if (/^5\b|^5\./.test(raw) || low.indexOf('marketing') !== -1 || low.indexOf('influencer') !== -1 || low.indexOf('werbung') !== -1 || /\bpr\b/.test(low)) {
                cat = 'Marketing';
              }
              agg[cat].eur += Number(item && item.eur) || 0;
              agg[cat].count += Number(item && item.count) || 0;
            });
            const tot = Number(schwund.totalEur) || 0;
            return Object.keys(agg).map(function(k) {
              const eur = Math.round(agg[k].eur * 100) / 100;
              return { label: k, eur: eur, sharePct: tot > 0 ? Math.round((eur / tot) * 1000) / 10 : 0, count: agg[k].count };
            }).sort(function(a, b) { return b.eur - a.eur || b.count - a.count; });
          })();
      const bruch = res.bruch || { totalEur: 0, pieces: 0, count: 0, byStation: [], byVerschulden: [] };
      const totalLossEur = Math.round(((Number(schwund.totalEur) || 0) + (Number(bruch.totalEur) || 0)) * 100) / 100;

      currentSlot.innerHTML =
        '<div class="card" style="margin-bottom:16px;">' +
          '<div class="card-head">' +
            '<div>' +
              '<div class="kicker">Operations · Auswertung (' + esc(session.standortName) + ')</div>' +
              '<h3>Schwund- &amp; Bruch-Auswertung · ' + esc(monthLabel) + '</h3>' +
            '</div>' +
            '<div style="display:flex;gap:8px;align-items:center;flex-wrap:wrap;">' +
              '<select id="opsStatsPeriodSelect" class="input-control" style="height:32px;width:auto;min-width:170px;">' +
                periods.map(function(p) {
                  return '<option value="' + esc(p.key) + '"' + (p.key === res.periodKey ? ' selected' : '') + '>' + esc(p.label) + '</option>';
                }).join('') +
              '</select>' +
              '<button type="button" id="btnReloadOpsSummary" class="btn btn-sm">Aktualisieren</button>' +
            '</div>' +
          '</div>' +
          '<div class="grid-4">' +
            '<div class="bv-kpi-card">' +
              '<div class="kicker">Monatsschwund (Netto)</div>' +
              '<div class="bv-kpi-val tabular">' + fmtEur(schwund.totalEur) + '</div>' +
              '<div style="margin-top:6px;font-size:12px;color:var(--os-silk);">' + esc(schwund.count || 0) + ' Buchungen</div>' +
            '</div>' +
            '<div class="bv-kpi-card">' +
              '<div class="kicker">Monatsbruch (Netto)</div>' +
              '<div class="bv-kpi-val tabular">' + fmtEur(bruch.totalEur) + '</div>' +
              '<div style="margin-top:6px;font-size:12px;color:var(--os-silk);">' + fmtNum(bruch.pieces || 0, 0) + ' Stück · ' + esc(bruch.count || 0) + ' Buchungen</div>' +
            '</div>' +
            '<div class="bv-kpi-card">' +
              '<div class="kicker">Bruchstücke gesamt</div>' +
              '<div class="bv-kpi-val tabular">' + fmtNum(bruch.pieces || 0, 0) + ' Stk</div>' +
              '<div style="margin-top:6px;font-size:12px;color:var(--os-silk);">aus BRUCH_NEU</div>' +
            '</div>' +
            '<div class="bv-kpi-card">' +
              '<div class="kicker">Gesamtverlust Schwund + Bruch</div>' +
              '<div class="bv-kpi-val tabular">' + fmtEur(totalLossEur) + '</div>' +
              '<div style="margin-top:6px;font-size:12px;color:var(--os-silk);">' + esc((schwund.count || 0) + (bruch.count || 0)) + ' Meldungen</div>' +
            '</div>' +
          '</div>' +
        '</div>' +

        '<div class="grid-2" style="margin-bottom:16px;">' +
          '<div class="card">' +
            '<div class="card-head"><div><div class="kicker">Schwund-Auswertung</div><h3>Schwund nach Bereich / Station</h3></div></div>' +
            '<div class="table-wrap"><table><thead><tr><th>Station</th><th>Verlust (Netto)</th><th>Anteil</th><th>Buchungen</th></tr></thead><tbody>' +
              renderBreakdownRows(schwund.byStation, false) +
            '</tbody></table></div>' +
          '</div>' +
          '<div class="card">' +
            '<div class="card-head"><div><div class="kicker">Schwund-Auswertung</div><h3>Schwund nach Grund</h3></div></div>' +
            '<div class="table-wrap"><table><thead><tr><th>Grund / Kategorie</th><th>Verlust (Netto)</th><th>Anteil</th><th>Buchungen</th></tr></thead><tbody>' +
              renderBreakdownRows(schwundByCategory, false) +
            '</tbody></table></div>' +
          '</div>' +
        '</div>' +

        '<div class="grid-2" style="margin-bottom:16px;">' +
          '<div class="card">' +
            '<div class="card-head"><div><div class="kicker">Bruch-Auswertung</div><h3>Bruch nach Station / Bereich</h3></div></div>' +
            '<div class="table-wrap"><table><thead><tr><th>Bereich</th><th>Bruchwert (Netto)</th><th>Anteil</th><th>Menge</th><th>Buchungen</th></tr></thead><tbody>' +
              renderBreakdownRows(bruch.byStation, true) +
            '</tbody></table></div>' +
          '</div>' +
          '<div class="card">' +
            '<div class="card-head"><div><div class="kicker">Bruch-Auswertung</div><h3>Bruch nach Verschulden / Verursacher</h3></div></div>' +
            '<div class="table-wrap"><table><thead><tr><th>Verschuldensart</th><th>Bruchwert (Netto)</th><th>Anteil</th><th>Menge</th><th>Buchungen</th></tr></thead><tbody>' +
              renderBreakdownRows(bruch.byVerschulden, true) +
            '</tbody></table></div>' +
          '</div>' +
        '</div>' +

        '<div class="card">' +
          '<div class="card-head"><div><div class="kicker">Schwund-Auswertung</div><h3>Top 5 Verlust-Artikel</h3></div></div>' +
          '<div class="table-wrap"><table><thead><tr><th>Artikel</th><th>Verlust (Netto)</th><th>Anteil</th><th>Buchungen</th></tr></thead><tbody>' +
            renderBreakdownRows(Array.isArray(schwund.topItems) ? schwund.topItems : [], false) +
          '</tbody></table></div>' +
        '</div>';

      const periodSel = currentSlot.querySelector('#opsStatsPeriodSelect');
      if (periodSel) {
        periodSel.addEventListener('change', function() {
          OPS_STATE.selectedPeriod = periodSel.value;
          loadMonthlySummary(session, false, periodSel.value, currentSlot);
        });
      }
      const reloadBtn = currentSlot.querySelector('#btnReloadOpsSummary');
      if (reloadBtn) {
        reloadBtn.addEventListener('click', function() {
          loadMonthlySummary(session, true, OPS_STATE.selectedPeriod, currentSlot);
        });
      }
    } catch (err) {
      const currentSlot = targetEl || document.getElementById('opsSchwundKpiSlot');
      if (!currentSlot) return;
      currentSlot.innerHTML =
        '<div class="card">' +
          '<div class="kicker">Schwund- &amp; Bruch-Auswertung</div>' +
          '<p class="module-desc">Fehler beim Laden: ' + esc(err && err.message ? err.message : String(err)) + '</p>' +
        '</div>';
    }
  }

  function renderReklamationChoices(containerId, options, selectedVal, onPick) {
    const box = document.getElementById(containerId);
    if (!box) return;
    box.innerHTML = (options || []).map(function(opt) {
      const active = opt === selectedVal ? ' active' : '';
      return '<button type="button" class="ops-choice-btn' + active + '" data-choice="' + esc(opt) + '">' + esc(opt) + '</button>';
    }).join('');
    box.querySelectorAll('.ops-choice-btn').forEach(function(btn) {
      btn.addEventListener('click', function() {
        box.querySelectorAll('.ops-choice-btn').forEach(function(b) { b.classList.remove('active'); });
        btn.classList.add('active');
        onPick(btn.dataset.choice);
      });
    });
  }

  function renderReklamationRecentTable(meta) {
    const tbody = document.getElementById('opsRekRecentBody');
    const titleEl = document.getElementById('opsRekRecentTitle');
    const badgeEl = document.getElementById('opsRekCountBadge');
    if (titleEl && meta && meta.sheetName) {
      titleEl.textContent = 'Letzte Einträge – ' + meta.sheetName;
    }
    if (badgeEl && meta) {
      badgeEl.textContent = String(meta.totalMonthCount || 0) + ' Einträge';
    }
    if (!tbody) return;
    const list = (meta && Array.isArray(meta.recentEntries)) ? meta.recentEntries : [];
    if (!list.length) {
      tbody.innerHTML = '<tr><td colspan="5">Noch keine Einträge in diesem Monat.</td></tr>';
      return;
    }
    tbody.innerHTML = list.map(function(e) {
      return '<tr>' +
        '<td style="white-space:nowrap;">' + esc(e.date || '–') + '</td>' +
        '<td style="white-space:nowrap;"><span class="badge">' + esc(e.art || '–') + '</span></td>' +
        '<td style="white-space:nowrap;"><span class="badge badge-warn">' + esc(e.bereich || '–') + '</span></td>' +
        '<td style="max-width:440px;white-space:pre-wrap;line-height:1.45;">' + esc(e.bemerkung || '') + '</td>' +
        '<td style="white-space:nowrap;"><b>' + esc(e.name || '–') + '</b></td>' +
      '</tr>';
    }).join('');
  }

  async function loadReklamationTab(session, requestedMonth, forceRefresh) {
    const pane = document.getElementById('opsTabPane');
    if (!pane) return;
    const reqMonth = requestedMonth || OPS_STATE.selectedMonth || '';
    const cacheKey = 'reklam::' + session.standortId + '::' + (reqMonth || 'LATEST');

    if (forceRefresh || !getOpsCache(cacheKey)) {
      pane.innerHTML =
        '<div class="card">' +
          '<div class="kicker">Gäste-Reklamation · ' + esc(session.standortName) + '</div>' +
          '<p class="module-desc">Lade Monatsblatt &amp; Dropdown-Optionen aus der Reklamations-Tabelle …</p>' +
        '</div>';
    }

    try {
      const res = await fetchOpsSwr(
        cacheKey,
        function() { return window.SonaApi.getOpsReklamationMeta(session.standortId, reqMonth); },
        !!forceRefresh,
        function() {
          if (document.getElementById('opsTabPane')) {
            loadReklamationTab(session, reqMonth, false);
          }
        }
      );
      if (!document.getElementById('opsTabPane')) return;

      if (!res || !res.success) {
        pane.innerHTML =
          '<div class="card">' +
            '<div class="kicker">Gäste-Reklamation</div>' +
            '<h3>Tabelle konnte nicht geladen werden</h3>' +
            '<p class="module-desc">' + esc((res && res.error) || 'Unbekannter Fehler.') + '</p>' +
          '</div>';
        return;
      }

      if (res.status === 'IN_VORBEREITUNG') {
        pane.innerHTML =
          '<div class="card">' +
            '<div class="kicker">Gäste-Reklamation · ' + esc(session.standortName) + '</div>' +
            '<h3>Noch nicht für diesen Standort verknüpft</h3>' +
            '<p class="module-desc">' + esc(res.message || 'Für diesen Standort ist noch keine Reklamations-Tabelle hinterlegt.') + '</p>' +
          '</div>';
        return;
      }

      OPS_STATE.meta = res;
      OPS_STATE.selectedMonth = res.sheetName || '';
      OPS_STATE.selectedArt = res.defaultArt || 'Gäste im Haus';
      OPS_STATE.selectedBereich = res.defaultBereich || (res.bereichOptions && res.bereichOptions[0]) || 'Beschwerde';

      const defaultName = getSavedOpsName(session);
      const months = Array.isArray(res.availableMonths) && res.availableMonths.length ? res.availableMonths : [res.sheetName];

      pane.innerHTML =
        '<div class="card" style="margin-bottom:16px;">' +
          '<div class="card-head">' +
            '<div>' +
              '<div class="kicker">Operations · ' + esc(session.standortName) + '</div>' +
              '<h3>Reklamation und Beschwerden</h3>' +
            '</div>' +
            '<div style="display:flex;gap:8px;align-items:center;flex-wrap:wrap;">' +
              '<select id="opsRekMonthSelect" class="input-control" style="height:32px;width:auto;min-width:130px;">' +
                months.map(function(m) {
                  return '<option value="' + esc(m) + '"' + (m === res.sheetName ? ' selected' : '') + '>' + esc(m) + '</option>';
                }).join('') +
              '</select>' +
              '<span id="opsRekCountBadge" class="badge">' + esc(res.totalMonthCount || 0) + ' Einträge</span>' +
              '<button type="button" id="btnReloadReklamation" class="btn btn-sm">Aktualisieren</button>' +
            '</div>' +
          '</div>' +

          '<div id="opsRekError" class="lock-error hidden"></div>' +
          '<div id="opsRekSuccess" class="lock-success hidden"></div>' +

          '<div class="user-modal-grid">' +
            '<div class="form-field">' +
              '<label class="kicker" for="opsRekDate">1. Datum</label>' +
              '<input type="date" id="opsRekDate" class="input-control" value="' + esc(todayIsoLocal()) + '">' +
            '</div>' +
            '<div class="form-field">' +
              '<label class="kicker" for="opsRekName">5. Name (automatisch aus Profil)</label>' +
              '<input type="text" id="opsRekName" class="input-control" maxlength="80" value="' + esc(defaultName) + '" placeholder="Mitarbeitername">' +
            '</div>' +
          '</div>' +

          '<div class="form-field">' +
            '<label class="kicker">2. Art (Standard: Gäste im Haus)</label>' +
            '<div id="opsRekArtGroup" class="ops-choice-group"></div>' +
          '</div>' +

          '<div class="form-field">' +
            '<label class="kicker">3. Bereich</label>' +
            '<div id="opsRekBereichGroup" class="ops-choice-group"></div>' +
          '</div>' +

          '<div class="form-field">' +
            '<label class="kicker" for="opsRekBemerkung">4. Bemerkung / Ablauf &amp; Maßnahme</label>' +
            '<textarea id="opsRekBemerkung" class="input-control ops-textarea" rows="4" maxlength="2000" placeholder="z. B. T23: Gericht zu trocken / Wartezeit – entschuldigt, Küche informiert, Getränk aufs Haus …"></textarea>' +
          '</div>' +

          '<div style="display:flex;justify-content:flex-end;align-items:center;gap:10px;flex-wrap:wrap;">' +
            '<button type="button" id="btnSaveReklamation" class="btn btn-primary">Eintrag speichern</button>' +
          '</div>' +
        '</div>' +

        '<div class="card">' +
          '<div class="card-head">' +
            '<div>' +
              '<div class="kicker">Live-Protokoll</div>' +
              '<h3 id="opsRekRecentTitle">Letzte Einträge – ' + esc(res.sheetName) + '</h3>' +
            '</div>' +
          '</div>' +
          '<div class="table-wrap"><table><thead><tr>' +
            '<th>Datum</th><th>Art</th><th>Bereich</th><th>Bemerkung</th><th>Name</th>' +
          '</tr></thead><tbody id="opsRekRecentBody"></tbody></table></div>' +
        '</div>';

      renderReklamationChoices('opsRekArtGroup', res.artOptions || [], OPS_STATE.selectedArt, function(val) {
        OPS_STATE.selectedArt = val;
      });
      renderReklamationChoices('opsRekBereichGroup', res.bereichOptions || [], OPS_STATE.selectedBereich, function(val) {
        OPS_STATE.selectedBereich = val;
      });
      renderReklamationRecentTable(res);

      const monthSel = document.getElementById('opsRekMonthSelect');
      if (monthSel) {
        monthSel.addEventListener('change', function() {
          OPS_STATE.selectedMonth = monthSel.value;
          loadReklamationTab(session, monthSel.value);
        });
      }
      const reloadBtn = document.getElementById('btnReloadReklamation');
      if (reloadBtn) {
        reloadBtn.addEventListener('click', function() {
          loadReklamationTab(session, OPS_STATE.selectedMonth);
        });
      }

      const saveFn = async function() {
        const errEl = document.getElementById('opsRekError');
        const okEl = document.getElementById('opsRekSuccess');
        const showMsg = function(errMsg, okMsg) {
          if (errEl) {
            errEl.textContent = errMsg || '';
            errEl.classList.toggle('hidden', !errMsg);
          }
          if (okEl) {
            okEl.textContent = okMsg || '';
            okEl.classList.toggle('hidden', !okMsg);
          }
        };

        const dateVal = (document.getElementById('opsRekDate') && document.getElementById('opsRekDate').value) || todayIsoLocal();
        const nameVal = (document.getElementById('opsRekName') && document.getElementById('opsRekName').value || '').trim();
        const bemVal = (document.getElementById('opsRekBemerkung') && document.getElementById('opsRekBemerkung').value || '').trim();

        if (!OPS_STATE.selectedArt) {
          showMsg('Bitte eine Art auswählen.', '');
          return;
        }
        if (!OPS_STATE.selectedBereich) {
          showMsg('Bitte einen Bereich auswählen.', '');
          return;
        }
        if (bemVal.length < 3) {
          showMsg('Bitte eine Bemerkung eingeben (mind. 3 Zeichen).', '');
          return;
        }
        if (!nameVal) {
          showMsg('Bitte deinen Namen angeben.', '');
          return;
        }

        const btn = document.getElementById('btnSaveReklamation');
        if (btn) {
          btn.disabled = true;
          btn.textContent = 'Speichert…';
        }
        showMsg('', '');

        try {
          const saveRes = await window.SonaApi.saveOpsReklamation(session.standortId, {
            date: dateVal,
            art: OPS_STATE.selectedArt,
            bereich: OPS_STATE.selectedBereich,
            bemerkung: bemVal,
            name: nameVal
          });
          if (!saveRes || !saveRes.success) {
            showMsg((saveRes && saveRes.error) || 'Speichern fehlgeschlagen.', '');
            return;
          }
          saveOpsName(session, nameVal);
          const bemInput = document.getElementById('opsRekBemerkung');
          if (bemInput) bemInput.value = '';

          showMsg('', 'Gespeichert im Blatt „' + saveRes.sheetName + '“ (Zeile ' + saveRes.rowNumber + ').');
          if (window.SonaApp && window.SonaApp.toast) {
            window.SonaApp.toast('Gäste-Reklamation gespeichert (' + saveRes.sheetName + ').');
          }

          // Cache invalidieren & Liste direkt aktualisieren
          invalidateOpsCache('reklam::' + session.standortId + '::');
          const fresh = await window.SonaApi.getOpsReklamationMeta(session.standortId, saveRes.sheetName);
          if (fresh && fresh.success && fresh.status === 'AKTIV') {
            setOpsCache('reklam::' + session.standortId + '::' + (fresh.sheetName || 'LATEST'), fresh);
            OPS_STATE.meta = fresh;
            OPS_STATE.selectedMonth = fresh.sheetName;
            if (monthSel && fresh.sheetName) monthSel.value = fresh.sheetName;
            renderReklamationRecentTable(fresh);
          }
        } catch (err) {
          showMsg('Verbindungsfehler: ' + (err && err.message ? err.message : String(err)), '');
        } finally {
          if (btn) {
            btn.disabled = false;
            btn.textContent = 'Reklamation speichern';
          }
        }
      };

      const saveBtn = document.getElementById('btnSaveReklamation');
      if (saveBtn) saveBtn.addEventListener('click', saveFn);

      const bemEl = document.getElementById('opsRekBemerkung');
      if (bemEl) {
        bemEl.addEventListener('keydown', function(ev) {
          if ((ev.ctrlKey || ev.metaKey) && ev.key === 'Enter') {
            ev.preventDefault();
            saveFn();
          }
        });
      }
    } catch (err) {
      const currentPane = document.getElementById('opsTabPane');
      if (!currentPane) return;
      currentPane.innerHTML =
        '<div class="card">' +
          '<div class="kicker">Gäste-Reklamation</div>' +
          '<p class="module-desc">Verbindungsfehler: ' + esc(err && err.message ? err.message : String(err)) + '</p>' +
        '</div>';
    }
  }

  const STAR_BY_NUM = [
    '☆☆☆☆☆ (0)',
    '★☆☆☆☆ (1)',
    '★★☆☆☆ (2)',
    '★★★☆☆ (3)',
    '★★★★☆ (4)',
    '★★★★★ (5)'
  ];

  function starToNum(starVal) {
    const s = String(starVal || '');
    const m = s.match(/\((\d)\)/);
    if (m) return Math.max(0, Math.min(5, parseInt(m[1], 10)));
    return 2;
  }

  function calcClientAvgScore(stars, isAw) {
    if (isAw) return '-';
    let sum = 0;
    let cnt = 0;
    (stars || []).forEach(function(s) {
      const str = String(s || '');
      if (!str || str.toLowerCase().indexOf('außer') !== -1 || str.toLowerCase().indexOf('ausser') !== -1) return;
      const m = str.match(/\((\d)\)/);
      if (m) {
        sum += parseInt(m[1], 10);
        cnt++;
      }
    });
    return cnt ? (sum / cnt).toFixed(1) : '-';
  }

  function renderSliderCell(val, cIdx, disabledAttr) {
    const num = starToNum(val);
    return '<td class="ops-slider-cell">' +
      '<div class="ops-slider-wrap">' +
        '<input type="range" class="ops-slider" min="0" max="5" step="1" value="' + num + '" data-crit-idx="' + cIdx + '"' + disabledAttr + '>' +
        '<span class="ops-slider-val tabular">' + num + '★</span>' +
      '</div>' +
    '</td>';
  }

  async function loadRatingTab(session, forceRefresh) {
    const pane = document.getElementById('opsTabPane');
    if (!pane) return;
    const cacheKey = 'rating::' + session.standortId;

    if (forceRefresh || !getOpsCache(cacheKey)) {
      pane.innerHTML =
        '<div class="card">' +
          '<div class="kicker">Mitarbeiter Ranking · ' + esc(session.standortName) + '</div>' +
          '<p class="module-desc">Lade Tabelle aus SONA HUB …</p>' +
        '</div>';
    }

    try {
      const res = await fetchOpsSwr(
        cacheKey,
        function() { return window.SonaApi.getOpsRatingMeta(session.standortId); },
        !!forceRefresh,
        function() {
          if (document.getElementById('opsTabPane')) {
            loadRatingTab(session, false);
          }
        }
      );
      if (!document.getElementById('opsTabPane')) return;

      if (!res || !res.success) {
        pane.innerHTML =
          '<div class="card">' +
            '<div class="kicker">Mitarbeiter Ranking</div>' +
            '<h3>Tabelle konnte nicht geladen werden</h3>' +
            '<p class="module-desc">' + esc((res && res.error) || 'Unbekannter Fehler.') + '</p>' +
          '</div>';
        return;
      }

      if (res.status === 'IN_VORBEREITUNG') {
        pane.innerHTML =
          '<div class="card">' +
            '<div class="kicker">Mitarbeiter Ranking · ' + esc(session.standortName) + '</div>' +
            '<h3>Noch nicht für diesen Standort verknüpft</h3>' +
            '<p class="module-desc">' + esc(res.message || 'Für diesen Standort ist noch kein SONA HUB hinterlegt.') + '</p>' +
          '</div>';
        return;
      }

      const staffCriteria = Array.isArray(res.staffCriteria) ? res.staffCriteria : ['Fach/Service', 'Zuverl.', 'Team', 'Fleiß'];
      const azubiCriteria = Array.isArray(res.azubiCriteria) ? res.azubiCriteria : ['Zuverl.', 'Fleiß', 'Service', 'Sprache'];
      const azubiStatuses = Array.isArray(res.azubiStatusOptions) ? res.azubiStatusOptions : ['Vollstaendig', 'Rueckstand', 'Fehlt'];
      const staffList = Array.isArray(res.staff) ? res.staff : [];
      const azubiList = Array.isArray(res.azubis) ? res.azubis : [];
      const disabledAttr = res.canWrite ? '' : ' disabled';
      const dirtyMap = {};
      let showAddForm = false;

      const updateSaveButtonLabel = function() {
        const btn = document.getElementById('btnSaveAllRatings');
        if (!btn) return;
        const count = Object.keys(dirtyMap).length;
        btn.textContent = count > 0 ? ('Änderungen speichern & Sync (' + count + ')') : 'Speichern & Sync';
        btn.disabled = !res.canWrite || count === 0;
      };

      const renderRatingBody = function() {
        const isStaff = OPS_STATE.ratingSubTab !== 'azubi';
        const list = isStaff ? staffList : azubiList;
        const criteria = isStaff ? staffCriteria : azubiCriteria;
        const typeKey = isStaff ? 'staff' : 'azubi';

        const addFormHtml = (res.canWrite && showAddForm)
          ? '<div class="ops-add-member-bar">' +
              '<input type="text" id="opsAddMemberName" class="input-control" style="height:32px;max-width:200px;" maxlength="80" placeholder="' + (isStaff ? 'Name Mitarbeiter' : 'Name Azubi') + '">' +
              '<select id="opsAddMemberDept" class="input-control" style="height:32px;width:auto;">' +
                '<option value="Service">Service</option>' +
                '<option value="Kueche">Küche</option>' +
                '<option value="Bar">Bar</option>' +
              '</select>' +
              (!isStaff
                ? '<select id="opsAddAzubiStatus" class="input-control" style="height:32px;width:auto;">' +
                    azubiStatuses.map(function(st) { return '<option value="' + esc(st) + '">' + esc(st) + '</option>'; }).join('') +
                  '</select>'
                : '') +
              '<button type="button" id="btnConfirmAddMember" class="btn btn-primary btn-sm">Anlegen</button>' +
              '<button type="button" id="btnCancelAddMember" class="btn btn-sm">Abbrechen</button>' +
            '</div>'
          : '';

        let tableHtml = '';
        if (isStaff) {
          const rowsHtml = list.length
            ? list.map(function(item, idx) {
                const key = 'staff_' + item.row;
                const dirtyCls = dirtyMap[key] ? ' is-dirty' : '';
                return '<tr class="ops-rating-row' + dirtyCls + '" data-type="staff" data-idx="' + idx + '" data-row="' + esc(item.row) + '">' +
                  '<td style="white-space:nowrap;">' + esc(item.dept || 'Service') + '</td>' +
                  '<td style="white-space:nowrap;"><b>' + esc(item.name) + '</b></td>' +
                  renderSliderCell(item.stars[0], 0, disabledAttr) +
                  renderSliderCell(item.stars[1], 1, disabledAttr) +
                  renderSliderCell(item.stars[2], 2, disabledAttr) +
                  renderSliderCell(item.stars[3], 3, disabledAttr) +
                  '<td class="tabular"><span class="badge ops-row-score">' + esc(item.score || '-') + '</span></td>' +
                  '<td><input type="text" class="input-control ops-rating-inline-input ops-rating-notes" maxlength="2000" value="' + esc(item.notes || '') + '" placeholder="Notiz …"' + disabledAttr + '></td>' +
                  '<td class="chk-cell"><input type="checkbox" class="ops-rating-aw"' + (item.isAw ? ' checked' : '') + disabledAttr + ' title="Außer Wertung"></td>' +
                '</tr>';
              }).join('')
            : '<tr><td colspan="9">Keine Mitarbeiter vorhanden.</td></tr>';

          tableHtml =
            '<div class="table-wrap"><table class="ops-rating-table"><thead><tr>' +
              '<th>Bereich</th><th>Mitarbeiter</th>' +
              criteria.map(function(c) { return '<th>' + esc(c) + '</th>'; }).join('') +
              '<th>Ø</th><th>Notizen</th><th>A.W.</th>' +
            '</tr></thead><tbody>' + rowsHtml + '</tbody></table></div>';
        } else {
          const rowsHtml = list.length
            ? list.map(function(item, idx) {
                const key = 'azubi_' + item.row;
                const dirtyCls = dirtyMap[key] ? ' is-dirty' : '';
                return '<tr class="ops-rating-row' + dirtyCls + '" data-type="azubi" data-idx="' + idx + '" data-row="' + esc(item.row) + '">' +
                  '<td style="white-space:nowrap;"><b>' + esc(item.name) + '</b></td>' +
                  '<td style="white-space:nowrap;">' + esc(item.dept || 'Service') + '</td>' +
                  '<td><select class="input-control ops-rating-status" style="height:30px;padding:2px 6px;font-size:11px;"' + disabledAttr + '>' +
                    azubiStatuses.map(function(st) {
                      return '<option value="' + esc(st) + '"' + (st === item.status ? ' selected' : '') + '>' + esc(st) + '</option>';
                    }).join('') +
                  '</select></td>' +
                  renderSliderCell(item.stars[0], 0, disabledAttr) +
                  renderSliderCell(item.stars[1], 1, disabledAttr) +
                  renderSliderCell(item.stars[2], 2, disabledAttr) +
                  renderSliderCell(item.stars[3], 3, disabledAttr) +
                  '<td class="tabular"><span class="badge ops-row-score">' + esc(item.score || '-') + '</span></td>' +
                  '<td><input type="text" class="input-control ops-rating-inline-input ops-rating-feedback" maxlength="2000" value="' + esc(item.feedback || '') + '" placeholder="Feedback …"' + disabledAttr + '></td>' +
                  '<td><input type="text" class="input-control ops-rating-inline-input ops-rating-todo" maxlength="2000" value="' + esc(item.todo || '') + '" placeholder="To-Dos …"' + disabledAttr + '></td>' +
                '</tr>';
              }).join('')
            : '<tr><td colspan="10">Keine Azubis vorhanden.</td></tr>';

          tableHtml =
            '<div class="table-wrap"><table class="ops-rating-table"><thead><tr>' +
              '<th>Azubi</th><th>Abt.</th><th>Berichtsheft</th>' +
              criteria.map(function(c) { return '<th>' + esc(c) + '</th>'; }).join('') +
              '<th>Ø</th><th>Feedback</th><th>To-Dos</th>' +
            '</tr></thead><tbody>' + rowsHtml + '</tbody></table></div>';
        }

        pane.innerHTML =
          '<div class="card">' +
            '<div class="card-head">' +
              '<div>' +
                '<div class="kicker">' + esc(res.kwBanner || ('Mitarbeiter Ranking · ' + session.standortName)) + '</div>' +
                '<h3>' + esc(isStaff ? 'Personal Scorecard' : 'Azubi-Entwicklung') + '</h3>' +
              '</div>' +
              '<div style="display:flex;gap:8px;align-items:center;flex-wrap:wrap;">' +
                '<button type="button" id="btnRatingSubStaff" class="bv-tab-btn' + (isStaff ? ' active' : '') + '">Personal (' + esc(staffList.length) + ')</button>' +
                '<button type="button" id="btnRatingSubAzubi" class="bv-tab-btn' + (!isStaff ? ' active' : '') + '">Azubis (' + esc(azubiList.length) + ')</button>' +
                (res.canWrite ? '<button type="button" id="btnToggleAddMember" class="btn btn-sm">+ ' + (isStaff ? 'Mitarbeiter' : 'Azubi') + '</button>' : '') +
                (res.canWrite ? '<button type="button" id="btnSaveAllRatings" class="btn btn-primary btn-sm">Speichern &amp; Sync</button>' : '') +
                '<button type="button" id="btnReloadRatings" class="btn btn-sm">Neu laden</button>' +
              '</div>' +
            '</div>' +
            addFormHtml +
            '<div id="opsRatingMsg" style="margin-bottom:10px;font-size:12px;"></div>' +
            tableHtml +
          '</div>';

        updateSaveButtonLabel();

        const btnStaff = document.getElementById('btnRatingSubStaff');
        const btnAzubi = document.getElementById('btnRatingSubAzubi');
        const btnReload = document.getElementById('btnReloadRatings');
        const btnToggleAdd = document.getElementById('btnToggleAddMember');
        if (btnStaff) btnStaff.addEventListener('click', function() { OPS_STATE.ratingSubTab = 'staff'; showAddForm = false; renderRatingBody(); });
        if (btnAzubi) btnAzubi.addEventListener('click', function() { OPS_STATE.ratingSubTab = 'azubi'; showAddForm = false; renderRatingBody(); });
        if (btnReload) btnReload.addEventListener('click', function() { loadRatingTab(session); });
        if (btnToggleAdd) btnToggleAdd.addEventListener('click', function() { showAddForm = !showAddForm; renderRatingBody(); });

        const btnCancelAdd = document.getElementById('btnCancelAddMember');
        if (btnCancelAdd) btnCancelAdd.addEventListener('click', function() { showAddForm = false; renderRatingBody(); });

        const btnConfirmAdd = document.getElementById('btnConfirmAddMember');
        if (btnConfirmAdd) {
          btnConfirmAdd.addEventListener('click', async function() {
            const nameInput = document.getElementById('opsAddMemberName');
            const deptSelect = document.getElementById('opsAddMemberDept');
            const statusSelect = document.getElementById('opsAddAzubiStatus');
            const msgEl = document.getElementById('opsRatingMsg');
            const cleanName = nameInput ? nameInput.value.trim() : '';
            if (cleanName.length < 2) {
              if (msgEl) { msgEl.style.color = '#f87171'; msgEl.textContent = 'Bitte einen Namen eingeben (mind. 2 Zeichen).'; }
              return;
            }
            btnConfirmAdd.disabled = true;
            btnConfirmAdd.textContent = 'Legt an…';
            try {
              const addRes = await window.SonaApi.addOpsRatingMember(session.standortId, {
                type: typeKey,
                name: cleanName,
                dept: deptSelect ? deptSelect.value : 'Service',
                status: statusSelect ? statusSelect.value : 'Vollstaendig'
              });
              if (!addRes || !addRes.success) {
                if (msgEl) { msgEl.style.color = '#f87171'; msgEl.textContent = (addRes && addRes.error) || 'Anlegen fehlgeschlagen.'; }
                return;
              }
              if (isStaff && addRes.member) staffList.push(addRes.member);
              if (!isStaff && addRes.member) azubiList.push(addRes.member);
              invalidateOpsCache('rating::' + session.standortId);
              showAddForm = false;
              renderRatingBody();
              if (window.SonaApp && window.SonaApp.toast) {
                window.SonaApp.toast(cleanName + ' angelegt und mit SONA HUB synchronisiert.');
              }
            } catch (eAdd) {
              if (msgEl) { msgEl.style.color = '#f87171'; msgEl.textContent = 'Verbindungsfehler: ' + (eAdd && eAdd.message ? eAdd.message : String(eAdd)); }
            } finally {
              btnConfirmAdd.disabled = false;
              btnConfirmAdd.textContent = 'Anlegen';
            }
          });
        }

        pane.querySelectorAll('.ops-rating-row').forEach(function(tr) {
          const idx = parseInt(tr.dataset.idx, 10);
          const item = list[idx];
          if (!item) return;
          const rowKey = typeKey + '_' + item.row;

          const markDirty = function() {
            dirtyMap[rowKey] = { type: typeKey, item: item };
            tr.classList.add('is-dirty');
            const scoreBadge = tr.querySelector('.ops-row-score');
            if (scoreBadge) {
              item.score = calcClientAvgScore(item.stars, !!item.isAw);
              scoreBadge.textContent = item.score;
            }
            updateSaveButtonLabel();
          };

          tr.querySelectorAll('.ops-slider').forEach(function(slider) {
            slider.addEventListener('input', function() {
              const cIdx = parseInt(slider.dataset.critIdx, 10);
              const valNum = parseInt(slider.value, 10);
              item.stars[cIdx] = STAR_BY_NUM[valNum] || '★★☆☆☆ (2)';
              const valSpan = slider.parentNode && slider.parentNode.querySelector('.ops-slider-val');
              if (valSpan) valSpan.textContent = valNum + '★';
              const awBox = tr.querySelector('.ops-rating-aw');
              if (awBox && awBox.checked) {
                awBox.checked = false;
                item.isAw = false;
              }
              markDirty();
            });
          });

          const awBox = tr.querySelector('.ops-rating-aw');
          if (awBox) {
            awBox.addEventListener('change', function() {
              item.isAw = !!awBox.checked;
              markDirty();
            });
          }

          const notesEl = tr.querySelector('.ops-rating-notes');
          if (notesEl) {
            notesEl.addEventListener('input', function() {
              item.notes = notesEl.value;
              markDirty();
            });
          }

          const statusEl = tr.querySelector('.ops-rating-status');
          if (statusEl) {
            statusEl.addEventListener('change', function() {
              item.status = statusEl.value;
              markDirty();
            });
          }

          const fbEl = tr.querySelector('.ops-rating-feedback');
          if (fbEl) {
            fbEl.addEventListener('input', function() {
              item.feedback = fbEl.value;
              markDirty();
            });
          }

          const todoEl = tr.querySelector('.ops-rating-todo');
          if (todoEl) {
            todoEl.addEventListener('input', function() {
              item.todo = todoEl.value;
              markDirty();
            });
          }
        });

        const btnSaveAll = document.getElementById('btnSaveAllRatings');
        if (btnSaveAll) {
          btnSaveAll.addEventListener('click', async function() {
            const keys = Object.keys(dirtyMap);
            if (!keys.length) return;
            const msgEl = document.getElementById('opsRatingMsg');
            btnSaveAll.disabled = true;
            btnSaveAll.textContent = 'Synchronisiert…';
            if (msgEl) msgEl.textContent = '';

            const entries = keys.map(function(k) {
              const d = dirtyMap[k];
              const it = d.item;
              if (d.type === 'staff') {
                return {
                  type: 'staff',
                  row: it.row,
                  expectedName: it.name,
                  stars: it.stars.slice(0, 4),
                  notes: it.notes || '',
                  isAw: !!it.isAw
                };
              }
              return {
                type: 'azubi',
                row: it.row,
                expectedName: it.name,
                status: it.status || 'Vollstaendig',
                stars: it.stars.slice(0, 4),
                feedback: it.feedback || '',
                todo: it.todo || ''
              };
            });

            try {
              const saveRes = await window.SonaApi.saveOpsRatingBatch(session.standortId, entries);
              if (!saveRes || !saveRes.success) {
                if (msgEl) {
                  msgEl.style.color = '#f87171';
                  msgEl.textContent = (saveRes && saveRes.error) || 'Synchronisation fehlgeschlagen.';
                }
                return;
              }
              keys.forEach(function(k) { delete dirtyMap[k]; });
              invalidateOpsCache('rating::' + session.standortId);
              pane.querySelectorAll('.ops-rating-row.is-dirty').forEach(function(tr) { tr.classList.remove('is-dirty'); });
              if (msgEl) {
                msgEl.style.color = '#4ade80';
                msgEl.textContent = '✓ ' + saveRes.savedCount + ' Bewertung(en) mit SONA HUB synchronisiert.';
              }
              if (window.SonaApp && window.SonaApp.toast) {
                window.SonaApp.toast(saveRes.savedCount + ' Bewertung(en) im SONA HUB gespeichert.');
              }
            } catch (err) {
              if (msgEl) {
                msgEl.style.color = '#f87171';
                msgEl.textContent = 'Verbindungsfehler: ' + (err && err.message ? err.message : String(err));
              }
            } finally {
              updateSaveButtonLabel();
            }
          });
        }
      };

      renderRatingBody();
    } catch (err) {
      const currentPane = document.getElementById('opsTabPane');
      if (!currentPane) return;
      currentPane.innerHTML =
        '<div class="card">' +
          '<div class="kicker">Mitarbeiter Ranking</div>' +
          '<p class="module-desc">Verbindungsfehler: ' + esc(err && err.message ? err.message : String(err)) + '</p>' +
        '</div>';
    }
  }

  function shiftIsoDateDays(dateIso, deltaDays) {
    const base = dateIso ? new Date(dateIso + 'T12:00:00') : new Date();
    base.setDate(base.getDate() + deltaDays);
    return base.getFullYear() + '-' + String(base.getMonth() + 1).padStart(2, '0') + '-' + String(base.getDate()).padStart(2, '0');
  }

  async function loadTodoTab(session, targetDateIso, forceRefresh) {
    const pane = document.getElementById('opsTabPane');
    if (!pane) return;
    const dateIso = targetDateIso || OPS_STATE.selectedTodoDate || todayIsoLocal();
    OPS_STATE.selectedTodoDate = dateIso;
    const cacheKey = 'todo::' + session.standortId + '::' + dateIso;

    if (forceRefresh || !getOpsCache(cacheKey)) {
      pane.innerHTML =
        '<div class="card">' +
          '<div class="kicker">To-Do-Liste · ' + esc(session.standortName) + '</div>' +
          '<p class="module-desc">Lade Tagesaufgaben …</p>' +
        '</div>';
    }

    try {
      const res = await fetchOpsSwr(
        cacheKey,
        function() { return window.SonaApi.getOpsTodoDay(session.standortId, dateIso, !!forceRefresh); },
        !!forceRefresh,
        function() {
          if (document.getElementById('opsTabPane') && OPS_STATE.selectedTodoDate === dateIso) {
            loadTodoTab(session, dateIso, false);
          }
        }
      );
      if (!document.getElementById('opsTabPane')) return;

      if (!res || !res.success) {
        pane.innerHTML =
          '<div class="card">' +
            '<div class="kicker">To-Do-Liste</div>' +
            '<h3>Tagesaufgaben konnten nicht geladen werden</h3>' +
            '<p class="module-desc">' + esc((res && res.error) || 'Unbekannter Fehler.') + '</p>' +
          '</div>';
        return;
      }

      if (res.status === 'IN_VORBEREITUNG') {
        pane.innerHTML =
          '<div class="card">' +
            '<div class="kicker">To-Do-Liste · ' + esc(session.standortName) + '</div>' +
            '<h3>Noch nicht für diesen Standort verknüpft</h3>' +
            '<p class="module-desc">' + esc(res.message || 'Für diesen Standort ist noch kein To-Do-Ordner hinterlegt.') + '</p>' +
          '</div>';
        return;
      }

      const weekDays = Array.isArray(res.weekDays) ? res.weekDays : [];
      const dayButtonsHtml = weekDays.length
        ? '<div class="ops-todo-days">' +
            weekDays.map(function(d) {
              const active = d.dateIso === res.dateIso ? ' active' : '';
              const cntTxt = d.total !== undefined ? (d.done + '/' + d.total) : d.dateShort;
              return '<button type="button" class="ops-todo-day-btn' + active + '" data-todo-date="' + esc(d.dateIso) + '">' +
                '<b>' + esc(d.dayKey) + '</b>' +
                '<span class="day-count">' + esc(d.dateShort) + '</span>' +
                (d.total !== undefined ? '<span class="day-count">' + esc(cntTxt) + '</span>' : '') +
              '</button>';
            }).join('') +
          '</div>'
        : '';

      if (res.status === 'KEIN_BLATT') {
        pane.innerHTML =
          '<div class="card">' +
            '<div class="card-head">' +
              '<div>' +
                '<div class="kicker">' + esc(res.kwLabel || '') + '</div>' +
                '<h3>To-Do-Liste · ' + esc(res.dayLabel || '') + '</h3>' +
              '</div>' +
              '<div style="display:flex;gap:6px;flex-wrap:wrap;">' +
                '<button type="button" id="btnTodoPrevWeek" class="btn btn-sm">← Vorwoche</button>' +
                '<button type="button" id="btnTodoToday" class="btn btn-sm">Heute</button>' +
                '<button type="button" id="btnTodoNextWeek" class="btn btn-sm">Nächste Woche →</button>' +
              '</div>' +
            '</div>' +
            dayButtonsHtml +
            '<p class="module-desc">' + esc(res.message || 'Für diese Kalenderwoche liegt noch keine Liste vor.') + '</p>' +
          '</div>';
      } else {
        const tasks = Array.isArray(res.tasks) ? res.tasks : [];
        const fruehTasks = tasks.filter(function(t) { return t.shift !== 'Spät'; });
        const spaetTasks = tasks.filter(function(t) { return t.shift === 'Spät'; });

        const renderShiftBlock = function(title, list) {
          if (!list.length) return '';
          return '<div style="margin-bottom:14px;">' +
            '<div class="kicker" style="margin-bottom:8px;">' + esc(title) + '</div>' +
            '<div class="ops-todo-list">' +
              list.map(function(t) {
                return '<label class="ops-todo-item' + (t.done ? ' is-done' : '') + '" data-row="' + esc(t.row) + '" data-col="' + esc(t.checkCol) + '">' +
                  '<input type="checkbox" class="ops-todo-chk"' + (t.done ? ' checked' : '') + '>' +
                  '<span class="ops-todo-text">' + esc(t.text) + '</span>' +
                '</label>';
              }).join('') +
            '</div>' +
          '</div>';
        };

        const noteBlockHtml = (res.hasRatingRow || res.hasNoteRow)
          ? '<div class="card" style="margin-top:14px;">' +
              '<div class="card-head"><div><div class="kicker">Tagesabschluss</div><h3>Bewertung &amp; Notiz (' + esc(res.dayLabel) + ')</h3></div></div>' +
              (res.hasRatingRow
                ? '<div class="form-field">' +
                    '<label class="kicker">Tagesbewertung</label>' +
                    '<div class="ops-choice-group" id="opsTodoRatingGroup">' +
                      ['Gut', 'Mittel', 'Schlecht'].map(function(r) {
                        return '<button type="button" class="ops-choice-btn' + (res.dayRating === r ? ' active' : '') + '" data-rating="' + esc(r) + '">' + esc(r) + '</button>';
                      }).join('') +
                    '</div>' +
                  '</div>'
                : '') +
              (res.hasNoteRow
                ? '<div class="form-field">' +
                    '<label class="kicker" for="opsTodoNoteInput">Tagesnotiz</label>' +
                    '<textarea id="opsTodoNoteInput" class="input-control ops-textarea" rows="2" maxlength="1000" placeholder="Hinweise für die nächste Schicht …">' + esc(res.dayNote || '') + '</textarea>' +
                  '</div>'
                : '') +
              '<div style="display:flex;justify-content:flex-end;">' +
                '<button type="button" id="btnSaveTodoNote" class="btn btn-primary btn-sm">Notiz speichern</button>' +
              '</div>' +
            '</div>'
          : '';

        pane.innerHTML =
          '<div class="card">' +
            '<div class="card-head">' +
              '<div>' +
                '<div class="kicker">' + esc(res.kwLabel || '') + '</div>' +
                '<h3>' + esc(res.dayLabel) + ' · ' + esc(res.dateShort || res.dateIso) + '</h3>' +
              '</div>' +
              '<div style="display:flex;gap:6px;align-items:center;flex-wrap:wrap;">' +
                '<span id="opsTodoQuoteBadge" class="badge">' + esc(res.doneCount || 0) + ' / ' + esc(res.totalCount || 0) + ' (' + esc(res.quotePct || 0) + ' %)</span>' +
                '<button type="button" id="btnTodoPrevWeek" class="btn btn-sm">←</button>' +
                '<button type="button" id="btnTodoToday" class="btn btn-sm">Heute</button>' +
                '<button type="button" id="btnTodoNextWeek" class="btn btn-sm">→</button>' +
                '<button type="button" id="btnTodoReload" class="btn btn-sm">Aktualisieren</button>' +
              '</div>' +
            '</div>' +
            dayButtonsHtml +
            '<div class="ops-todo-progress-track"><div id="opsTodoProgressFill" class="ops-todo-progress-fill" style="width:' + esc(res.quotePct || 0) + '%;"></div></div>' +
            '<div class="ops-add-member-bar">' +
              '<input type="text" id="opsTodoNewText" class="input-control" style="height:34px;flex:1;min-width:200px;" maxlength="200" placeholder="Neue Tagesaufgabe für ' + esc(res.dayLabel) + ' …">' +
              '<select id="opsTodoNewShift" class="input-control" style="height:34px;width:auto;">' +
                '<option value="Früh">Frühschicht</option>' +
                '<option value="Spät">Spätschicht</option>' +
              '</select>' +
              '<button type="button" id="btnAddTodoTask" class="btn btn-primary btn-sm">+ Hinzufügen</button>' +
            '</div>' +
            '<div id="opsTodoMsg" style="margin-bottom:10px;font-size:12px;"></div>' +
            (tasks.length
              ? renderShiftBlock('Frühschicht', fruehTasks) + renderShiftBlock('Spätschicht', spaetTasks)
              : '<p class="module-desc">Für ' + esc(res.dayLabel) + ' sind noch keine Aufgaben eingetragen.</p>') +
          '</div>' +
          noteBlockHtml;

        // Checkbox-Toggle Events
        let localDone = res.doneCount || 0;
        const localTotal = res.totalCount || 0;
        const updateProgressUi = function() {
          const pct = localTotal > 0 ? Math.round((localDone / localTotal) * 100) : 0;
          const badge = document.getElementById('opsTodoQuoteBadge');
          const fill = document.getElementById('opsTodoProgressFill');
          if (badge) badge.textContent = localDone + ' / ' + localTotal + ' (' + pct + ' %)';
          if (fill) fill.style.width = pct + '%';
        };

        pane.querySelectorAll('.ops-todo-item').forEach(function(itemEl) {
          const chk = itemEl.querySelector('.ops-todo-chk');
          if (!chk) return;
          chk.addEventListener('change', async function() {
            const newDone = !!chk.checked;
            itemEl.classList.toggle('is-done', newDone);
            localDone += newDone ? 1 : -1;
            updateProgressUi();
            try {
              const tRes = await window.SonaApi.toggleOpsTodoTask(
                session.standortId,
                res.dateIso,
                parseInt(itemEl.dataset.row, 10),
                parseInt(itemEl.dataset.col, 10),
                newDone
              );
              if (!tRes || !tRes.success) {
                chk.checked = !newDone;
                itemEl.classList.toggle('is-done', !newDone);
                localDone += newDone ? -1 : 1;
                updateProgressUi();
                const msgEl = document.getElementById('opsTodoMsg');
                if (msgEl) { msgEl.style.color = '#f87171'; msgEl.textContent = (tRes && tRes.error) || 'Speichern fehlgeschlagen.'; }
              } else {
                invalidateOpsCache('todo::' + session.standortId + '::' + res.dateIso);
              }
            } catch (eTog) {
              chk.checked = !newDone;
              itemEl.classList.toggle('is-done', !newDone);
              localDone += newDone ? -1 : 1;
              updateProgressUi();
            }
          });
        });

        // Neue Tagesaufgabe hinzufügen
        const addTaskFn = async function() {
          const txtEl = document.getElementById('opsTodoNewText');
          const shiftEl = document.getElementById('opsTodoNewShift');
          const btn = document.getElementById('btnAddTodoTask');
          const msgEl = document.getElementById('opsTodoMsg');
          const val = txtEl ? txtEl.value.trim() : '';
          if (val.length < 2) {
            if (msgEl) { msgEl.style.color = '#f87171'; msgEl.textContent = 'Bitte eine Aufgabe eingeben.'; }
            return;
          }
          if (btn) { btn.disabled = true; btn.textContent = 'Speichert…'; }
          try {
            const addRes = await window.SonaApi.addOpsTodoTask(session.standortId, res.dateIso, shiftEl ? shiftEl.value : 'Früh', val);
            if (!addRes || !addRes.success) {
              if (msgEl) { msgEl.style.color = '#f87171'; msgEl.textContent = (addRes && addRes.error) || 'Hinzufügen fehlgeschlagen.'; }
              return;
            }
            if (window.SonaApp && window.SonaApp.toast) window.SonaApp.toast('Tagesaufgabe hinzugefügt.');
            invalidateOpsCache('todo::' + session.standortId + '::' + res.dateIso);
            loadTodoTab(session, res.dateIso, true);
          } catch (eAdd) {
            if (msgEl) { msgEl.style.color = '#f87171'; msgEl.textContent = 'Verbindungsfehler.'; }
          } finally {
            if (btn) { btn.disabled = false; btn.textContent = '+ Hinzufügen'; }
          }
        };
        const btnAdd = document.getElementById('btnAddTodoTask');
        if (btnAdd) btnAdd.addEventListener('click', addTaskFn);
        const newTxtEl = document.getElementById('opsTodoNewText');
        if (newTxtEl) {
          newTxtEl.addEventListener('keydown', function(ev) {
            if (ev.key === 'Enter') { ev.preventDefault(); addTaskFn(); }
          });
        }

        // Tagesbewertung & Notiz speichern
        let selectedRating = res.dayRating || '';
        const ratingGrp = document.getElementById('opsTodoRatingGroup');
        if (ratingGrp) {
          ratingGrp.querySelectorAll('.ops-choice-btn').forEach(function(b) {
            b.addEventListener('click', function() {
              ratingGrp.querySelectorAll('.ops-choice-btn').forEach(function(x) { x.classList.remove('active'); });
              b.classList.add('active');
              selectedRating = b.dataset.rating || '';
            });
          });
        }
        const btnNote = document.getElementById('btnSaveTodoNote');
        if (btnNote) {
          btnNote.addEventListener('click', async function() {
            const noteEl = document.getElementById('opsTodoNoteInput');
            btnNote.disabled = true;
            btnNote.textContent = 'Speichert…';
            try {
              const nRes = await window.SonaApi.saveOpsTodoNote(session.standortId, res.dateIso, selectedRating, noteEl ? noteEl.value : undefined);
              if (nRes && nRes.success) {
                invalidateOpsCache('todo::' + session.standortId + '::' + res.dateIso);
                if (window.SonaApp && window.SonaApp.toast) {
                  window.SonaApp.toast('Tagesnotiz gespeichert.');
                }
              }
            } finally {
              btnNote.disabled = false;
              btnNote.textContent = 'Notiz speichern';
            }
          });
        }
      }

      // Navigation Events (Tage & Wochen)
      pane.querySelectorAll('.ops-todo-day-btn').forEach(function(b) {
        b.addEventListener('click', function() {
          loadTodoTab(session, b.dataset.todoDate, false);
        });
      });
      const prevBtn = document.getElementById('btnTodoPrevWeek');
      const todayBtn = document.getElementById('btnTodoToday');
      const nextBtn = document.getElementById('btnTodoNextWeek');
      const reloadBtn = document.getElementById('btnTodoReload');
      if (prevBtn) prevBtn.addEventListener('click', function() { loadTodoTab(session, shiftIsoDateDays(dateIso, -7), false); });
      if (todayBtn) todayBtn.addEventListener('click', function() { loadTodoTab(session, todayIsoLocal(), false); });
      if (nextBtn) nextBtn.addEventListener('click', function() { loadTodoTab(session, shiftIsoDateDays(dateIso, 7), false); });
      if (reloadBtn) reloadBtn.addEventListener('click', function() { loadTodoTab(session, dateIso, true); });
    } catch (err) {
      const currentPane = document.getElementById('opsTabPane');
      if (!currentPane) return;
      currentPane.innerHTML =
        '<div class="card">' +
          '<div class="kicker">To-Do-Liste</div>' +
          '<p class="module-desc">Verbindungsfehler: ' + esc(err && err.message ? err.message : String(err)) + '</p>' +
        '</div>';
    }
  }

  async function loadPutzplanTab(session, targetDateIso, forceRefresh) {
    const pane = document.getElementById('opsTabPane');
    if (!pane) return;
    const dateIso = targetDateIso || OPS_STATE.selectedPutzplanDate || todayIsoLocal();
    OPS_STATE.selectedPutzplanDate = dateIso;
    const cacheKey = 'putz::' + session.standortId + '::' + dateIso;

    if (forceRefresh || !getOpsCache(cacheKey)) {
      pane.innerHTML =
        '<div class="card">' +
          '<div class="kicker">Putzplan · ' + esc(session.standortName) + '</div>' +
          '<p class="module-desc">Lade Tagesaufgaben …</p>' +
        '</div>';
    }

    try {
      const res = await fetchOpsSwr(
        cacheKey,
        function() { return window.SonaApi.getOpsPutzplanDay(session.standortId, dateIso); },
        !!forceRefresh,
        function() {
          if (document.getElementById('opsTabPane') && OPS_STATE.selectedPutzplanDate === dateIso) {
            loadPutzplanTab(session, dateIso, false);
          }
        }
      );
      if (!document.getElementById('opsTabPane')) return;

      if (!res || !res.success) {
        pane.innerHTML =
          '<div class="card">' +
            '<div class="kicker">Putzplan</div>' +
            '<h3>Putzplan konnte nicht geladen werden</h3>' +
            '<p class="module-desc">' + esc((res && res.error) || 'Unbekannter Fehler.') + '</p>' +
          '</div>';
        return;
      }

      if (res.status === 'IN_VORBEREITUNG') {
        pane.innerHTML =
          '<div class="card">' +
            '<div class="kicker">Putzplan · ' + esc(session.standortName) + '</div>' +
            '<h3>Noch nicht für diesen Standort verknüpft</h3>' +
            '<p class="module-desc">' + esc(res.message || 'Für diesen Standort ist noch kein Putzplan hinterlegt.') + '</p>' +
          '</div>';
        return;
      }

      const weekDays = Array.isArray(res.weekDays) ? res.weekDays : [];
      const dayButtonsHtml = weekDays.length
        ? '<div class="ops-todo-days">' +
            weekDays.map(function(d) {
              const active = d.dateIso === res.dateIso ? ' active' : '';
              return '<button type="button" class="ops-todo-day-btn' + active + '" data-putz-date="' + esc(d.dateIso) + '">' +
                '<b>' + esc(d.dayKey) + '</b>' +
                '<span class="day-count">' + esc(d.dateShort) + '</span>' +
                '<span class="day-count">' + esc(d.done) + '/' + esc(d.total) + '</span>' +
              '</button>';
            }).join('') +
          '</div>'
        : '';

      if (res.status === 'KEINE_ZEILE') {
        pane.innerHTML =
          '<div class="card">' +
            '<div class="card-head">' +
              '<div>' +
                '<div class="kicker">' + esc(res.kwLabel || '') + '</div>' +
                '<h3>Putzplan · ' + esc(res.dayLabel || '') + ' (' + esc(res.dateShort || res.dateIso) + ')</h3>' +
              '</div>' +
              '<div style="display:flex;gap:6px;flex-wrap:wrap;">' +
                '<button type="button" id="btnPutzPrevWeek" class="btn btn-sm">←</button>' +
                '<button type="button" id="btnPutzToday" class="btn btn-sm">Heute</button>' +
                '<button type="button" id="btnPutzNextWeek" class="btn btn-sm">→</button>' +
              '</div>' +
            '</div>' +
            dayButtonsHtml +
            '<p class="module-desc">' + esc(res.message || 'Für diesen Tag ist noch keine Zeile angelegt.') + '</p>' +
          '</div>';
      } else {
        const tasks = Array.isArray(res.tasks) ? res.tasks : [];
        const defaultPerson = res.person || getSavedOpsName(session);

        pane.innerHTML =
          '<div class="card">' +
            '<div class="card-head">' +
              '<div>' +
                '<div class="kicker">' + esc(res.kwLabel || '') + ' · ' + esc(res.sheetName || 'Putzplan') + '</div>' +
                '<h3>' + esc(res.dayLabel) + ' · ' + esc(res.dateShort || res.dateIso) + '</h3>' +
              '</div>' +
              '<div style="display:flex;gap:6px;align-items:center;flex-wrap:wrap;">' +
                '<span id="opsPutzQuoteBadge" class="badge">' + esc(res.doneCount || 0) + ' / ' + esc(res.totalCount || 5) + ' (' + esc(res.quotePct || 0) + ' %)</span>' +
                '<button type="button" id="btnPutzPrevWeek" class="btn btn-sm">←</button>' +
                '<button type="button" id="btnPutzToday" class="btn btn-sm">Heute</button>' +
                '<button type="button" id="btnPutzNextWeek" class="btn btn-sm">→</button>' +
                '<button type="button" id="btnPutzReload" class="btn btn-sm">Aktualisieren</button>' +
              '</div>' +
            '</div>' +
            dayButtonsHtml +
            '<div class="ops-todo-progress-track"><div id="opsPutzProgressFill" class="ops-todo-progress-fill" style="width:' + esc(res.quotePct || 0) + '%;"></div></div>' +
            '<div id="opsPutzMsg" style="margin-bottom:10px;font-size:12px;"></div>' +
            '<div class="ops-todo-list" style="margin-bottom:16px;">' +
              tasks.map(function(t) {
                return '<label class="ops-todo-item' + (t.done ? ' is-done' : '') + '" data-col="' + esc(t.col) + '">' +
                  '<input type="checkbox" class="ops-putz-chk"' + (t.done ? ' checked' : '') + '>' +
                  '<span class="ops-todo-text">' + esc(t.name) + '</span>' +
                '</label>';
              }).join('') +
            '</div>' +
            '<div class="user-modal-grid">' +
              '<div class="form-field">' +
                '<label class="kicker" for="opsPutzPerson">Mitarbeiter / Name</label>' +
                '<input type="text" id="opsPutzPerson" class="input-control" maxlength="80" value="' + esc(defaultPerson) + '" placeholder="Name">' +
              '</div>' +
              '<div class="form-field">' +
                '<label class="kicker" for="opsPutzRemark">Bemerkung (optional)</label>' +
                '<input type="text" id="opsPutzRemark" class="input-control" maxlength="1000" value="' + esc(res.remark || '') + '" placeholder="Hinweise …">' +
              '</div>' +
            '</div>' +
            '<div style="display:flex;justify-content:flex-end;">' +
              '<button type="button" id="btnSavePutzMeta" class="btn btn-primary btn-sm">Name &amp; Bemerkung speichern</button>' +
            '</div>' +
          '</div>';

        let localDone = res.doneCount || 0;
        const localTotal = res.totalCount || tasks.length || 5;
        const updatePutzProgress = function() {
          const pct = localTotal > 0 ? Math.round((localDone / localTotal) * 100) : 0;
          const badge = document.getElementById('opsPutzQuoteBadge');
          const fill = document.getElementById('opsPutzProgressFill');
          if (badge) badge.textContent = localDone + ' / ' + localTotal + ' (' + pct + ' %)';
          if (fill) fill.style.width = pct + '%';
        };

        pane.querySelectorAll('.ops-todo-item').forEach(function(itemEl) {
          const chk = itemEl.querySelector('.ops-putz-chk');
          if (!chk) return;
          chk.addEventListener('change', async function() {
            const newDone = !!chk.checked;
            itemEl.classList.toggle('is-done', newDone);
            localDone += newDone ? 1 : -1;
            updatePutzProgress();
            const personEl = document.getElementById('opsPutzPerson');
            const personVal = personEl ? personEl.value.trim() : '';
            try {
              const tRes = await window.SonaApi.toggleOpsPutzplanTask(
                session.standortId,
                res.dateIso,
                parseInt(itemEl.dataset.col, 10),
                newDone,
                personVal
              );
              if (!tRes || !tRes.success) {
                chk.checked = !newDone;
                itemEl.classList.toggle('is-done', !newDone);
                localDone += newDone ? -1 : 1;
                updatePutzProgress();
                const msgEl = document.getElementById('opsPutzMsg');
                if (msgEl) { msgEl.style.color = '#f87171'; msgEl.textContent = (tRes && tRes.error) || 'Speichern fehlgeschlagen.'; }
              } else {
                invalidateOpsCache('putz::' + session.standortId + '::' + res.dateIso);
                if (tRes.person && personEl && !personEl.value.trim()) {
                  personEl.value = tRes.person;
                }
              }
            } catch (eTog) {
              chk.checked = !newDone;
              itemEl.classList.toggle('is-done', !newDone);
              localDone += newDone ? -1 : 1;
              updatePutzProgress();
            }
          });
        });

        const btnMeta = document.getElementById('btnSavePutzMeta');
        if (btnMeta) {
          btnMeta.addEventListener('click', async function() {
            const personEl = document.getElementById('opsPutzPerson');
            const remarkEl = document.getElementById('opsPutzRemark');
            const pVal = personEl ? personEl.value.trim() : '';
            const rVal = remarkEl ? remarkEl.value.trim() : '';
            btnMeta.disabled = true;
            btnMeta.textContent = 'Speichert…';
            try {
              const mRes = await window.SonaApi.saveOpsPutzplanMeta(session.standortId, res.dateIso, pVal, rVal);
              if (mRes && mRes.success) {
                invalidateOpsCache('putz::' + session.standortId + '::' + res.dateIso);
                if (pVal) saveOpsName(session, pVal);
                if (window.SonaApp && window.SonaApp.toast) window.SonaApp.toast('Putzplan aktualisiert.');
              }
            } finally {
              btnMeta.disabled = false;
              btnMeta.textContent = 'Name & Bemerkung speichern';
            }
          });
        }
      }

      pane.querySelectorAll('.ops-todo-day-btn').forEach(function(b) {
        b.addEventListener('click', function() {
          loadPutzplanTab(session, b.dataset.putzDate);
        });
      });
      const prevBtn = document.getElementById('btnPutzPrevWeek');
      const todayBtn = document.getElementById('btnPutzToday');
      const nextBtn = document.getElementById('btnPutzNextWeek');
      const reloadBtn = document.getElementById('btnPutzReload');
      if (prevBtn) prevBtn.addEventListener('click', function() { loadPutzplanTab(session, shiftIsoDateDays(dateIso, -7)); });
      if (todayBtn) todayBtn.addEventListener('click', function() { loadPutzplanTab(session, todayIsoLocal()); });
      if (nextBtn) nextBtn.addEventListener('click', function() { loadPutzplanTab(session, shiftIsoDateDays(dateIso, 7)); });
      if (reloadBtn) reloadBtn.addEventListener('click', function() { loadPutzplanTab(session, dateIso, true); });
    } catch (err) {
      const currentPane = document.getElementById('opsTabPane');
      if (!currentPane) return;
      currentPane.innerHTML =
        '<div class="card">' +
          '<div class="kicker">Putzplan</div>' +
          '<p class="module-desc">Verbindungsfehler: ' + esc(err && err.message ? err.message : String(err)) + '</p>' +
        '</div>';
    }
  }

  // ============================================================================
  // TAGESÜBERSICHT & WAS GIBT'S NEUES? (Tages-/Wochen-/Monatsinfos + Dokumente)
  // ============================================================================
  function newsTypeLabel(typ) {
    const t = String(typ || 'TAG').toUpperCase();
    if (t === 'WOCHE') return { label: 'Wocheninfo', cls: 'news-badge-woche' };
    if (t === 'MONAT') return { label: 'Monatsinfo', cls: 'news-badge-monat' };
    if (t === 'DAUERHAFT') return { label: 'Wichtig / Dauerhaft', cls: 'news-badge-dauerhaft' };
    return { label: 'Tagesinfo', cls: 'news-badge-tag' };
  }

  function formatIsoShortDe(isoStr) {
    const s = String(isoStr || '').trim();
    const m = s.match(/^(\d{4})-(\d{2})-(\d{2})$/);
    if (!m) return s;
    return m[3] + '.' + m[2] + '.' + m[1];
  }

  function addDaysToIso(baseIso, days) {
    const d = new Date((baseIso || todayIsoLocal()) + 'T12:00:00Z');
    d.setUTCDate(d.getUTCDate() + (days || 0));
    return d.toISOString().slice(0, 10);
  }

  function formatTsShortDe(isoStr) {
    const s = String(isoStr || '').trim();
    if (!s) return '–';
    const d = new Date(s);
    if (isNaN(d.getTime())) return s;
    return d.toLocaleString('de-DE', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' });
  }

  function canViewOpsActivity(session) {
    if (!session || !session.permissions) return false;
    if (session.permissions.adminMatrix) return true;
    const role = String((session.user && session.user.role) || '').toUpperCase();
    if (role === 'ADMIN') return true;
    const opTabs = session.permissions.tabPermissions && session.permissions.tabPermissions.operations;
    if (Array.isArray(opTabs)) {
      return opTabs.indexOf('ops_verlauf') !== -1;
    }
    const lvl = String(session.permissions.accessLevel || '').toUpperCase();
    return lvl === 'ADMIN' || lvl === 'WRITE' || ['FB_MANAGER', 'SERVICELEITUNG', 'SERVICECHEF', 'KUECHENCHEF', 'BARCHEF'].indexOf(role) !== -1;
  }

  function applyRoutineCardState(cardEl, textEl, done, total) {
    if (!cardEl || !textEl) return;
    cardEl.classList.remove('routine-state-low', 'routine-state-mid', 'routine-state-good');
    const barFill = cardEl.querySelector('.routine-progress-fill');
    const t = Number(total) || 0;
    const d = Number(done) || 0;
    if (t <= 0) {
      textEl.textContent = '';
      if (barFill) barFill.style.width = '0%';
      return;
    }
    const pct = Math.max(0, Math.min(100, Math.round((d / t) * 100)));
    textEl.textContent = 'Heute: ' + d + ' / ' + t + ' erledigt (' + pct + ' %)';
    if (barFill) barFill.style.width = (d <= 0 ? 12 : pct) + '%';
    if (d <= 0) {
      cardEl.classList.add('routine-state-low');
    } else if (pct >= 80) {
      cardEl.classList.add('routine-state-good');
    } else {
      cardEl.classList.add('routine-state-mid');
    }
  }

  function hydrateRoutineProgress(session) {
    if (!session || !session.standortId) return;
    const sid = session.standortId;
    const today = todayIsoLocal();

    const putzCard = document.getElementById('homeRoutinePutzCard');
    const putzTxt = document.getElementById('homeRoutinePutzProgress');
    if (putzCard && putzTxt) {
      const putzKey = 'putz::' + sid + '::' + today;
      fetchOpsSwr(putzKey, function() { return window.SonaApi.getOpsPutzplanDay(sid, today); }, false)
        .then(function(r) {
          if (r && r.success && r.status !== 'IN_VORBEREITUNG' && r.status !== 'KEINE_ZEILE') {
            applyRoutineCardState(document.getElementById('homeRoutinePutzCard'), document.getElementById('homeRoutinePutzProgress'), r.doneCount, r.totalCount);
          }
        }).catch(function() {});
    }

    const todoCard = document.getElementById('homeRoutineTodoCard');
    const todoTxt = document.getElementById('homeRoutineTodoProgress');
    if (todoCard && todoTxt) {
      const todoKey = 'todo::' + sid + '::' + today;
      fetchOpsSwr(todoKey, function() { return window.SonaApi.getOpsTodoDay(sid, today, false); }, false)
        .then(function(r) {
          if (r && r.success && r.status !== 'IN_VORBEREITUNG') {
            const tasks = Array.isArray(r.tasks) ? r.tasks : [];
            const total = r.totalCount !== undefined ? r.totalCount : tasks.length;
            const done = r.doneCount !== undefined ? r.doneCount : tasks.filter(function(x) { return !!x.done; }).length;
            applyRoutineCardState(document.getElementById('homeRoutineTodoCard'), document.getElementById('homeRoutineTodoProgress'), done, total);
          }
        }).catch(function() {});
    }

    const schwundValEl = document.getElementById('homeQuickSchwundVal');
    const bruchValEl = document.getElementById('homeQuickBruchVal');
    if (schwundValEl || bruchValEl) {
      const sumKey = 'summary::' + sid + '::LATEST';
      fetchOpsSwr(sumKey, function() { return window.SonaApi.getOpsMonthlySummary(sid, false, ''); }, false)
        .then(function(r) {
          if (!r || r.success === false || r.status === 'IN_VORBEREITUNG') return;
          const sEl = document.getElementById('homeQuickSchwundVal');
          const bEl = document.getElementById('homeQuickBruchVal');
          if (sEl && r.schwund) {
            sEl.textContent = fmtEur(r.schwund.totalEur || 0);
          }
          if (bEl && r.bruch) {
            bEl.textContent = fmtEur(r.bruch.totalEur || 0);
          }
        }).catch(function() {});
    }
  }

  function renderNewsCardsHtml(entries, opts) {
    const o = opts || {};
    if (!entries || !entries.length) {
      return '<p class="home-empty-hint">Aktuell liegen keine neuen Meldungen oder Dokumente vor.</p>';
    }
    return '<div class="home-news-grid">' +
      entries.map(function(item) {
        const meta = newsTypeLabel(item.typ);
        const rangeTxt = item.typ === 'DAUERHAFT'
          ? 'Dauerhaft'
          : ('Bis ' + formatIsoShortDe(item.gueltigBis || item.gueltigAb));
        const docHtml = item.docUrl
          ? '<a class="news-doc-link" href="' + esc(item.docUrl) + '" target="_blank" rel="noopener noreferrer">📄 ' + esc(item.docName || 'Dokument öffnen') + ' ↗</a>'
          : '';
        const readActionHtml = o.allowReadAck
          ? (item.readByMe
              ? '<span class="news-read-done">✓ Gelesen</span>'
              : '<button type="button" class="btn btn-sm news-read-btn" data-news-read-id="' + esc(item.id) + '">Gelesen ✓</button>')
          : '';
        const readersHtml = (o.showReaders && Array.isArray(item.readers))
          ? '<details class="news-readers-details">' +
              '<summary>Gelesen: ' + esc(item.readCount || item.readers.length) + '</summary>' +
              (item.readers.length
                ? '<ul class="news-readers-list">' + item.readers.map(function(rd) {
                    return '<li><b>' + esc(rd.name || 'Mitarbeiter') + '</b>' + (rd.email ? ' (' + esc(rd.email) + ')' : '') + ' · ' + esc(formatTsShortDe(rd.readAt)) + '</li>';
                  }).join('') + '</ul>'
                : '<div style="margin-top:4px;opacity:0.75;">Noch keine Bestätigungen.</div>') +
            '</details>'
          : '';
        return '<article class="home-news-card' + (item.pinned ? ' is-pinned' : '') + '">' +
          '<div>' +
            '<div class="home-news-meta">' +
              '<span class="badge ' + meta.cls + '">' + esc(meta.label) + '</span>' +
              (item.bereich && item.bereich !== 'ALLE' ? '<span class="badge">' + esc(item.bereich) + '</span>' : '') +
              (item.pinned ? '<span class="badge badge-warn">Wichtig</span>' : '') +
            '</div>' +
            '<h4 class="home-news-title">' + esc(item.titel) + '</h4>' +
            (item.inhalt ? '<div class="home-news-body">' + esc(item.inhalt) + '</div>' : '') +
            readersHtml +
          '</div>' +
          '<div class="home-news-footer">' +
            '<span>' + esc(item.autor || 'Leitung') + ' · ' + esc(rangeTxt) + '</span>' +
            '<div style="display:flex;align-items:center;gap:8px;flex-wrap:wrap;">' +
              docHtml +
              readActionHtml +
            '</div>' +
          '</div>' +
        '</article>';
      }).join('') +
    '</div>';
  }

  function wireNewsReadButtons(rootEl, session) {
    if (!rootEl || !session) return;
    rootEl.querySelectorAll('[data-news-read-id]').forEach(function(btn) {
      btn.addEventListener('click', async function() {
        const nid = btn.dataset.newsReadId;
        if (!nid) return;
        btn.disabled = true;
        btn.textContent = '✓ Gelesen';
        try {
          const r = await window.SonaApi.markOpsNewsRead(session.standortId, nid);
          if (r && r.success) {
            invalidateOpsCache('news::' + session.standortId);
            const span = document.createElement('span');
            span.className = 'news-read-done';
            span.textContent = '✓ Gelesen';
            btn.replaceWith(span);
          } else {
            btn.disabled = false;
            btn.textContent = 'Gelesen ✓';
          }
        } catch (e) {
          btn.disabled = false;
          btn.textContent = 'Gelesen ✓';
        }
      });
    });
  }

  async function renderNewsBoardInto(targetEl, session, forceRefresh) {
    if (!targetEl || !session || !session.standortId) return;
    const cacheKey = 'news::' + session.standortId;
    if (forceRefresh || !getOpsCache(cacheKey)) {
      targetEl.innerHTML = '<div class="card"><p class="module-desc" style="margin:0;">Lade aktuelle Infos …</p></div>';
    }

    try {
      const res = await fetchOpsSwr(
        cacheKey,
        function() { return window.SonaApi.getOpsNewsList(session.standortId); },
        !!forceRefresh,
        function() {
          if (document.body.contains(targetEl)) {
            renderNewsBoardInto(targetEl, session, false);
          }
        }
      );
      if (!document.body.contains(targetEl)) return;
      if (!res || !res.success) {
        const msg = (res && res.error) || '';
        if (msg.indexOf('Unbekannte Aktion') !== -1) {
          targetEl.innerHTML = '<div class="card"><p class="module-desc" style="margin:0;">Infoboard wird nach dem nächsten Backend-Sync (<code>@sync</code>) automatisch aktiviert.</p></div>';
          return;
        }
        targetEl.innerHTML = '<div class="card"><p class="module-desc" style="margin:0;">Infos konnten nicht geladen werden.</p></div>';
        return;
      }
      targetEl.innerHTML = renderNewsCardsHtml(res.activeEntries || [], { allowReadAck: true, showReaders: false });
      wireNewsReadButtons(targetEl, session);
    } catch (err) {
      if (document.body.contains(targetEl)) {
        targetEl.innerHTML = '<div class="card"><p class="module-desc" style="margin:0;">Aktuell keine Verbindung zum Infoboard.</p></div>';
      }
    }
  }

  async function loadTagesuebersichtTab(session, forceRefresh) {
    const pane = document.getElementById('opsTabPane');
    if (!pane || !session) return;
    const cacheKey = 'news::' + session.standortId;

    if (forceRefresh || !getOpsCache(cacheKey)) {
      pane.innerHTML =
        '<div class="card">' +
          '<div class="kicker">Tagesübersicht · ' + esc(session.standortName) + '</div>' +
          '<p class="module-desc">Lade Tagesübersicht &amp; Meldungen …</p>' +
        '</div>';
    }

    let res = null;
    try {
      res = await fetchOpsSwr(
        cacheKey,
        function() { return window.SonaApi.getOpsNewsList(session.standortId); },
        !!forceRefresh,
        function() {
          if (document.getElementById('opsTabPane')) {
            loadTagesuebersichtTab(session, false);
          }
        }
      );
    } catch (err) {
      res = { success: false, error: err && err.message ? err.message : String(err) };
    }
    if (!document.getElementById('opsTabPane')) return;

    const todayIso = (res && res.todayIso) || todayIsoLocal();
    const canManage = !!(res && res.canManage);
    const canDelete = (res && res.canDelete !== undefined) ? !!res.canDelete : canManage;
    const activeEntries = (res && res.success && Array.isArray(res.activeEntries)) ? res.activeEntries : [];
    const allEntries = (res && res.success && Array.isArray(res.allEntries)) ? res.allEntries : [];
    const backendPending = !!(res && !res.success && String(res.error || '').indexOf('Unbekannte Aktion') !== -1);

    const routineCardHtml =
      '<div class="home-routine-card" style="margin-bottom:18px;">' +
        '<div class="card-head" style="margin-bottom:4px;">' +
          '<div>' +
            '<div class="kicker">Tägliche Basis</div>' +
            '<h3>Routineaufgaben</h3>' +
          '</div>' +
          '<button type="button" id="btnOpsNewsReload" class="btn btn-sm">Aktualisieren</button>' +
        '</div>' +
        '<p class="module-desc" style="margin:0;">Feste Tagesroutinen für Küche, Bar &amp; Service – täglich abhaken und dokumentieren.</p>' +
        '<div class="home-routine-links">' +
          '<button type="button" class="home-routine-link" data-routine-view="ops_putzplan">' +
            '<div><div class="home-routine-link-title">Putzplan</div><div class="home-routine-link-sub">Tägliche &amp; wöchentliche Reinigung</div></div>' +
            '<span>→</span>' +
          '</button>' +
          '<button type="button" class="home-routine-link" data-routine-view="ops_todo">' +
            '<div><div class="home-routine-link-title">To-Do-Liste</div><div class="home-routine-link-sub">Checkliste für Früh- &amp; Spätschicht</div></div>' +
            '<span>→</span>' +
          '</button>' +
        '</div>' +
      '</div>';

    const editorHtml = canManage ? (
      '<div class="card" style="margin-bottom:18px;">' +
        '<div class="card-head">' +
          '<div>' +
            '<div class="kicker">Serviceleitung · Veröffentlichung für Startseite</div>' +
            '<h3>Neue Info oder Dokument eintragen</h3>' +
          '</div>' +
        '</div>' +
        '<div id="opsNewsMsg" style="font-size:12.5px;margin-bottom:10px;"></div>' +
        '<div class="form-field">' +
          '<label class="kicker">Zeitraum / Info-Typ (steuert die Anzeigedauer auf der Startseite)</label>' +
          '<div class="ops-news-type-pills" id="opsNewsTypePills">' +
            '<button type="button" class="btn btn-sm btn-primary" data-news-type="TAG">Tagesinfo (Heute)</button>' +
            '<button type="button" class="btn btn-sm" data-news-type="WOCHE">Wocheninfo (7 Tage)</button>' +
            '<button type="button" class="btn btn-sm" data-news-type="MONAT">Monatsinfo (30 Tage)</button>' +
            '<button type="button" class="btn btn-sm" data-news-type="DAUERHAFT">Dauerhaft / Wichtig</button>' +
          '</div>' +
        '</div>' +
        '<div class="user-modal-grid">' +
          '<div class="form-field">' +
            '<label class="kicker" for="opsNewsTitel">Titel (z. B. Neue Karte)</label>' +
            '<input type="text" id="opsNewsTitel" class="input-control" maxlength="140" placeholder="z. B. Neue Winterkarte ab sofort">' +
          '</div>' +
          '<div class="form-field">' +
            '<label class="kicker" for="opsNewsBereich">Bereich</label>' +
            '<select id="opsNewsBereich" class="input-control">' +
              '<option value="ALLE">Alle Bereiche</option>' +
              '<option value="SERVICE">Service</option>' +
              '<option value="BAR">Bar</option>' +
              '<option value="KUECHE">Küche</option>' +
            '</select>' +
          '</div>' +
          '<div class="form-field">' +
            '<label class="kicker" for="opsNewsAb">Gültig ab</label>' +
            '<input type="date" id="opsNewsAb" class="input-control" value="' + esc(todayIso) + '">' +
          '</div>' +
          '<div class="form-field" id="opsNewsBisWrap">' +
            '<label class="kicker" for="opsNewsBis">Sichtbar bis (automatisch ausgeblendet danach)</label>' +
            '<input type="date" id="opsNewsBis" class="input-control" value="' + esc(todayIso) + '">' +
          '</div>' +
        '</div>' +
        '<div class="form-field">' +
          '<label class="kicker" for="opsNewsInhalt">Info-Text (optional auch reine Textmeldung)</label>' +
          '<textarea id="opsNewsInhalt" class="input-control" rows="3" maxlength="4000" placeholder="Wichtige Hinweise, Änderungen, Briefings für das Team …"></textarea>' +
        '</div>' +
        '<div class="user-modal-grid">' +
          '<div class="form-field">' +
            '<label class="kicker" for="opsNewsFile">Dokument zur Ansicht hochladen (optional, PDF/Bild max. 8 MB)</label>' +
            '<input type="file" id="opsNewsFile" class="input-control" accept=".pdf,image/*,.doc,.docx,.xls,.xlsx">' +
          '</div>' +
          '<div class="form-field">' +
            '<label class="kicker" for="opsNewsDocName">Dokumentname auf der Startseite</label>' +
            '<input type="text" id="opsNewsDocName" class="input-control" maxlength="120" placeholder="z. B. Neue Getränkekarte 2026">' +
          '</div>' +
        '</div>' +
        '<div style="display:flex;justify-content:space-between;align-items:center;gap:12px;flex-wrap:wrap;margin-top:6px;">' +
          '<label class="rbac-tab-chip"><input type="checkbox" id="opsNewsPinned"><span>Oben anheften (Wichtig)</span></label>' +
          '<button type="button" id="btnSaveOpsNews" class="btn btn-primary">Auf Startseite veröffentlichen</button>' +
        '</div>' +
      '</div>'
    ) : '';

    const listRowsHtml = allEntries.length
      ? '<div class="table-wrap"><table><thead><tr><th>Status</th><th>Typ</th><th>Titel &amp; Info</th><th>Dokument</th><th>Gültigkeit</th>' + (canDelete ? '<th>Aktion</th>' : '') + '</tr></thead><tbody>' +
          allEntries.map(function(it) {
            const meta = newsTypeLabel(it.typ);
            const statusBadge = it.isActive
              ? '<span class="badge badge-ok">Aktiv</span>'
              : '<span class="badge">Abgelaufen</span>';
            const docCol = it.docUrl
              ? '<a class="news-doc-link" href="' + esc(it.docUrl) + '" target="_blank" rel="noopener noreferrer">📄 ' + esc(it.docName || 'Öffnen') + ' ↗</a>'
              : '—';
            const rangeCol = it.typ === 'DAUERHAFT'
              ? 'Dauerhaft'
              : (formatIsoShortDe(it.gueltigAb) + ' – ' + formatIsoShortDe(it.gueltigBis));
            return '<tr>' +
              '<td>' + statusBadge + '</td>' +
              '<td><span class="badge ' + meta.cls + '">' + esc(meta.label) + '</span></td>' +
              '<td><b>' + esc(it.titel) + '</b>' + (it.inhalt ? '<div style="font-size:12px;color:var(--os-silk);margin-top:2px;max-width:420px;white-space:pre-wrap;">' + esc(it.inhalt.slice(0, 200)) + (it.inhalt.length > 200 ? '…' : '') + '</div>' : '') + '</td>' +
              '<td>' + docCol + '</td>' +
              '<td style="white-space:nowrap;font-size:12px;">' + esc(rangeCol) + '</td>' +
              (canDelete ? '<td><button type="button" class="btn btn-danger btn-sm ops-news-del-btn" data-news-id="' + esc(it.id) + '">Entfernen</button></td>' : '') +
            '</tr>';
          }).join('') +
        '</tbody></table></div>'
      : '<p class="module-desc" style="margin:0;">Noch keine Meldungen hinterlegt.</p>';

    pane.innerHTML =
      routineCardHtml +
      (backendPending
        ? '<div class="card" style="margin-bottom:18px;"><p class="module-desc" style="margin:0;">Hinweis: Das Backend für <b>Tagesübersicht &amp; Infoboard</b> wartet noch auf <code>@sync</code>. Sobald synchronisiert wurde, können hier Meldungen &amp; PDFs veröffentlicht werden.</p></div>'
        : editorHtml) +
      '<div class="card" style="margin-bottom:18px;">' +
        '<div class="card-head"><div><div class="kicker">Vorschau Startseite</div><h3>Aktive Meldungen („Was gibt\'s Neues?“)</h3></div></div>' +
        renderNewsCardsHtml(activeEntries, { allowReadAck: false, showReaders: !!(res && res.canViewActivity) || canViewOpsActivity(session) }) +
      '</div>' +
      '<div class="card">' +
        '<div class="card-head"><div><div class="kicker">Verlauf &amp; Verwaltung</div><h3>Alle Einträge (' + esc(allEntries.length) + ')</h3></div></div>' +
        listRowsHtml +
      '</div>';

    pane.querySelectorAll('[data-routine-view]').forEach(function(btn) {
      btn.addEventListener('click', function() {
        if (window.SonaApp && window.SonaApp.openView) {
          window.SonaApp.openView(btn.dataset.routineView);
        }
      });
    });

    const reloadBtn = document.getElementById('btnOpsNewsReload');
    if (reloadBtn) {
      reloadBtn.addEventListener('click', function() {
        loadTagesuebersichtTab(session, true);
      });
    }

    if (canManage && !backendPending) {
      let selectedType = 'TAG';
      const pillsWrap = document.getElementById('opsNewsTypePills');
      const abEl = document.getElementById('opsNewsAb');
      const bisEl = document.getElementById('opsNewsBis');
      const bisWrap = document.getElementById('opsNewsBisWrap');

      const syncDateDefaults = function() {
        if (!abEl || !bisEl || !bisWrap) return;
        const base = abEl.value || todayIso;
        if (selectedType === 'DAUERHAFT') {
          bisWrap.classList.add('hidden');
          return;
        }
        bisWrap.classList.remove('hidden');
        const add = selectedType === 'MONAT' ? 30 : (selectedType === 'WOCHE' ? 7 : 0);
        bisEl.value = addDaysToIso(base, add);
      };

      if (pillsWrap) {
        pillsWrap.querySelectorAll('[data-news-type]').forEach(function(b) {
          b.addEventListener('click', function() {
            selectedType = b.dataset.newsType || 'TAG';
            pillsWrap.querySelectorAll('[data-news-type]').forEach(function(x) {
              x.classList.toggle('btn-primary', x === b);
            });
            syncDateDefaults();
          });
        });
      }
      if (abEl) abEl.addEventListener('change', syncDateDefaults);

      const fileEl = document.getElementById('opsNewsFile');
      const docNameEl = document.getElementById('opsNewsDocName');
      if (fileEl && docNameEl) {
        fileEl.addEventListener('change', function() {
          const f = fileEl.files && fileEl.files[0];
          if (f && !docNameEl.value.trim()) {
            docNameEl.value = f.name.replace(/\.[^.]+$/, '');
          }
        });
      }

      const btnSave = document.getElementById('btnSaveOpsNews');
      if (btnSave) {
        btnSave.addEventListener('click', async function() {
          const msgEl = document.getElementById('opsNewsMsg');
          const titel = (document.getElementById('opsNewsTitel') && document.getElementById('opsNewsTitel').value || '').trim();
          const inhalt = (document.getElementById('opsNewsInhalt') && document.getElementById('opsNewsInhalt').value || '').trim();
          const bereich = (document.getElementById('opsNewsBereich') && document.getElementById('opsNewsBereich').value) || 'ALLE';
          const gueltigAb = abEl ? abEl.value : todayIso;
          const gueltigBis = (selectedType !== 'DAUERHAFT' && bisEl) ? bisEl.value : '';
          const pinned = !!(document.getElementById('opsNewsPinned') && document.getElementById('opsNewsPinned').checked);

          if (titel.length < 2) {
            if (msgEl) { msgEl.style.color = '#f87171'; msgEl.textContent = 'Bitte einen Titel eingeben (mind. 2 Zeichen).'; }
            return;
          }

          let docBase64 = '';
          let docMimeType = '';
          let docFileName = '';
          const fileObj = fileEl && fileEl.files && fileEl.files[0];
          if (fileObj) {
            if (fileObj.size > 8 * 1024 * 1024) {
              if (msgEl) { msgEl.style.color = '#f87171'; msgEl.textContent = 'Datei ist zu groß (maximal 8 MB erlaubt).'; }
              return;
            }
            docFileName = fileObj.name;
            docMimeType = fileObj.type || 'application/pdf';
            docBase64 = await new Promise(function(resolve, reject) {
              const reader = new FileReader();
              reader.onload = function() { resolve(String(reader.result || '')); };
              reader.onerror = function() { reject(new Error('Datei konnte nicht gelesen werden.')); };
              reader.readAsDataURL(fileObj);
            });
          }

          const newsKey = 'news::' + session.standortId;
          const payload = {
            typ: selectedType,
            bereich: bereich,
            titel: titel,
            inhalt: inhalt,
            gueltigAb: gueltigAb,
            gueltigBis: gueltigBis,
            pinned: pinned,
            docName: docNameEl ? docNameEl.value.trim() : '',
            docFileName: docFileName,
            docMimeType: docMimeType,
            docBase64: docBase64
          };

          // Bei Text-Infos ohne Datei-Upload: Sofortige Optimistic UI (0 ms)
          if (!docBase64) {
            const optimisticEntry = {
              id: 'TMP-NEWS-' + Date.now(),
              typ: selectedType,
              bereich: bereich,
              titel: titel,
              inhalt: inhalt,
              gueltigAb: gueltigAb,
              gueltigBis: gueltigBis,
              pinned: pinned,
              autor: (session.user && session.user.name) || 'Team',
              erstelltAm: new Date().toISOString(),
              gelesen: true,
              readCount: 1,
              readers: []
            };
            const snap = mutateOpsCache(newsKey, function(d) {
              d.entries = Array.isArray(d.entries) ? [optimisticEntry].concat(d.entries) : [optimisticEntry];
              return d;
            });
            if (window.SonaApp && window.SonaApp.toast) {
              window.SonaApp.toast('Info auf Startseite veröffentlicht.');
            }
            loadTagesuebersichtTab(session, false);
            window.SonaApi.saveOpsNews(session.standortId, payload).then(function(saveRes) {
              if (!saveRes || !saveRes.success) {
                restoreOpsCacheSnapshot(newsKey, snap);
                loadTagesuebersichtTab(session, false);
                if (window.SonaApp && window.SonaApp.toast) {
                  window.SonaApp.toast((saveRes && saveRes.error) || 'Speichern fehlgeschlagen.');
                }
                return;
              }
              fetchOpsSwr(newsKey, function() { return window.SonaApi.getOpsNewsList(session.standortId); }, true, function() {
                const p = document.getElementById('opsTagesuebersichtPane');
                if (p && document.body.contains(p)) loadTagesuebersichtTab(session, false);
              });
            }).catch(function() {
              restoreOpsCacheSnapshot(newsKey, snap);
              loadTagesuebersichtTab(session, false);
              if (window.SonaApp && window.SonaApp.toast) window.SonaApp.toast('Verbindungsfehler beim Speichern.');
            });
            return;
          }

          btnSave.disabled = true;
          btnSave.textContent = 'Lädt hoch…';
          if (msgEl) msgEl.textContent = '';

          try {
            const saveRes = await window.SonaApi.saveOpsNews(session.standortId, payload);
            if (!saveRes || !saveRes.success) {
              if (msgEl) { msgEl.style.color = '#f87171'; msgEl.textContent = (saveRes && saveRes.error) || 'Speichern fehlgeschlagen.'; }
              return;
            }
            invalidateOpsCache(newsKey);
            if (window.SonaApp && window.SonaApp.toast) {
              window.SonaApp.toast('Info & Dokument veröffentlicht.');
            }
            loadTagesuebersichtTab(session, true);
          } catch (eSave) {
            if (msgEl) { msgEl.style.color = '#f87171'; msgEl.textContent = 'Verbindungsfehler: ' + (eSave && eSave.message ? eSave.message : String(eSave)); }
          } finally {
            btnSave.disabled = false;
            btnSave.textContent = 'Auf Startseite veröffentlichen';
          }
        });
      }

      pane.querySelectorAll('.ops-news-del-btn').forEach(function(btn) {
        btn.addEventListener('click', function() {
          const nid = btn.dataset.newsId;
          if (!nid) return;
          const newsKey = 'news::' + session.standortId;
          const snap = mutateOpsCache(newsKey, function(d) {
            d.entries = (d.entries || []).filter(function(it) { return String(it.id) !== String(nid); });
            return d;
          });
          if (window.SonaApp && window.SonaApp.toast) window.SonaApp.toast('Eintrag entfernt.');
          loadTagesuebersichtTab(session, false);
          window.SonaApi.deleteOpsNews(session.standortId, nid).then(function(dRes) {
            if (!dRes || !dRes.success) {
              restoreOpsCacheSnapshot(newsKey, snap);
              loadTagesuebersichtTab(session, false);
              if (window.SonaApp && window.SonaApp.toast) window.SonaApp.toast((dRes && dRes.error) || 'Löschen fehlgeschlagen.');
            }
          }).catch(function() {
            restoreOpsCacheSnapshot(newsKey, snap);
            loadTagesuebersichtTab(session, false);
          });
        });
      });
    }
  }

  // ============================================================================
  // 86-LISTE (Aktuell nicht verfügbar + tägliche "Noch aktuell?"-Prüfung)
  // ============================================================================
  async function render86BoardInto(targetEl, session, forceRefresh) {
    if (!targetEl || !session || !session.standortId) return;
    const cacheKey = 'list86::' + session.standortId;
    if (forceRefresh || !getOpsCache(cacheKey)) {
      targetEl.innerHTML = '<p class="module-desc" style="margin:8px 0 0;">Lade 86-Liste …</p>';
    }

    try {
      const res = await fetchOpsSwr(
        cacheKey,
        function() { return window.SonaApi.getOps86List(session.standortId); },
        !!forceRefresh,
        function() {
          if (document.body.contains(targetEl)) {
            render86BoardInto(targetEl, session, false);
          }
        }
      );
      if (!document.body.contains(targetEl)) return;
      if (!res || !res.success) {
        const msg = (res && res.error) || '';
        if (msg.indexOf('Unbekannte Aktion') !== -1) {
          targetEl.innerHTML = '<p class="module-desc" style="margin:8px 0 0;">86-Liste wird nach dem nächsten Backend-Sync (<code>@sync</code>) automatisch aktiviert.</p>';
          return;
        }
        targetEl.innerHTML = '<p class="module-desc" style="margin:8px 0 0;">86-Liste konnte nicht geladen werden.</p>';
        return;
      }

      const items = Array.isArray(res.items) ? res.items : [];
      if (!items.length) {
        targetEl.innerHTML = '<div class="ops-86-empty">✓ Alles verfügbar – aktuell keine 86-Artikel</div>';
        return;
      }

      const checkWarnHtml = res.needsCheckCount > 0
        ? '<div class="ops-86-banner" style="margin:10px 0 0;">' +
            '<span>⚠ <b>' + esc(res.needsCheckCount) + '</b> Artikel von gestern/älter müssen heute geprüft werden („Noch aktuell?“).</span>' +
            '<button type="button" class="btn btn-sm" data-open-86-tab="1">Jetzt prüfen →</button>' +
          '</div>'
        : '';

      targetEl.innerHTML =
        checkWarnHtml +
        '<div class="home-86-grid">' +
          items.map(function(it) {
            return '<div class="home-86-item' + (it.needsDailyCheck ? ' is-needs-check' : '') + '">' +
              '<div class="home-86-item-top">' +
                '<span class="home-86-name">' + esc(it.artikel) + '</span>' +
                '<span class="badge ' + (it.needsDailyCheck ? 'badge-warn' : 'badge-err') + '">' +
                  (it.needsDailyCheck ? 'Heute prüfen' : esc(it.bereich || '86')) +
                '</span>' +
              '</div>' +
              (it.notiz ? '<div class="home-86-note">' + esc(it.notiz) + '</div>' : '') +
            '</div>';
          }).join('') +
        '</div>';

      targetEl.querySelectorAll('[data-open-86-tab]').forEach(function(b) {
        b.addEventListener('click', function() {
          if (window.SonaApp && window.SonaApp.openView) window.SonaApp.openView('ops_86');
        });
      });
    } catch (err) {
      if (document.body.contains(targetEl)) {
        targetEl.innerHTML = '<p class="module-desc" style="margin:8px 0 0;">Aktuell keine Verbindung zur 86-Liste.</p>';
      }
    }
  }

  async function load86Tab(session, forceRefresh) {
    const pane = document.getElementById('opsTabPane');
    if (!pane || !session) return;
    const cacheKey = 'list86::' + session.standortId;

    if (forceRefresh || !getOpsCache(cacheKey)) {
      pane.innerHTML =
        '<div class="card">' +
          '<div class="kicker">86-Liste · ' + esc(session.standortName) + '</div>' +
          '<p class="module-desc">Lade aktuelle 86-Liste …</p>' +
        '</div>';
    }

    let res = null;
    try {
      res = await fetchOpsSwr(
        cacheKey,
        function() { return window.SonaApi.getOps86List(session.standortId); },
        !!forceRefresh,
        function() {
          if (document.getElementById('opsTabPane')) {
            load86Tab(session, false);
          }
        }
      );
    } catch (err) {
      res = { success: false, error: err && err.message ? err.message : String(err) };
    }
    if (!document.getElementById('opsTabPane')) return;

    const backendPending = !!(res && !res.success && String(res.error || '').indexOf('Unbekannte Aktion') !== -1);
    const items = (res && res.success && Array.isArray(res.items)) ? res.items : [];
    const needsCheckCount = (res && res.success && res.needsCheckCount) ? res.needsCheckCount : 0;
    const canResolve86 = !(res && res.canResolve === false);

    const alertBannerHtml = needsCheckCount > 0
      ? '<div class="ops-86-banner">' +
          '<span>⚠ <b>' + esc(needsCheckCount) + ' Artikel</b> wurden heute noch nicht bestätigt – bitte prüfen, ob noch 86 („Noch aktuell?“) oder wieder verfügbar („Wieder da“).</span>' +
        '</div>'
      : '';

    const rowsHtml = items.length
      ? '<div class="table-wrap"><table><thead><tr><th>Artikel / Gericht</th><th>Bereich</th><th>Notiz</th><th>Tagesstatus</th><th>Aktionen</th></tr></thead><tbody>' +
          items.map(function(it) {
            const statusHtml = it.needsDailyCheck
              ? '<span class="badge badge-warn">Prüfung fällig (zuletzt ' + esc(formatIsoShortDe(it.bestaetigtAm)) + ')</span>'
              : '<span class="badge badge-ok">Heute bestätigt (' + esc(it.bestaetigtVon || it.eingetragenVon || 'Team') + ')</span>';
            const actionsHtml =
              '<div style="display:flex;gap:6px;flex-wrap:wrap;">' +
                (it.needsDailyCheck
                  ? '<button type="button" class="btn btn-primary btn-sm ops-86-confirm-btn" data-id="' + esc(it.id) + '">Noch aktuell? ✓</button>'
                  : '') +
                (canResolve86
                  ? '<button type="button" class="btn btn-sm ops-86-resolve-btn" data-id="' + esc(it.id) + '">Wieder da ✓</button>'
                  : '') +
              '</div>';
            return '<tr class="' + (it.needsDailyCheck ? 'is-dirty' : '') + '">' +
              '<td><b>' + esc(it.artikel) + '</b><div style="font-size:11.5px;color:var(--os-silk);">Eingetragen von ' + esc(it.eingetragenVon || 'Team') + '</div></td>' +
              '<td><span class="badge">' + esc(it.bereich || 'ALLE') + '</span></td>' +
              '<td style="font-size:12.5px;color:var(--os-silk);">' + esc(it.notiz || '—') + '</td>' +
              '<td>' + statusHtml + '</td>' +
              '<td style="white-space:nowrap;">' + actionsHtml + '</td>' +
            '</tr>';
          }).join('') +
        '</tbody></table></div>'
      : '<div class="ops-86-empty">✓ Alles verfügbar – aktuell stehen keine Artikel auf der 86-Liste.</div>';

    pane.innerHTML =
      alertBannerHtml +
      (backendPending
        ? '<div class="card" style="margin-bottom:16px;"><p class="module-desc" style="margin:0;">Hinweis: Das Backend für die <b>86-Liste</b> wartet noch auf <code>@sync</code>.</p></div>'
        : '<div class="card" style="margin-bottom:16px;">' +
            '<div class="card-head">' +
              '<div><div class="kicker">Operations · ' + esc(session.standortName) + '</div><h3>Artikel auf 86 setzen (aktuell nicht verfügbar)</h3></div>' +
              '<button type="button" id="btnOps86Reload" class="btn btn-sm">Aktualisieren</button>' +
            '</div>' +
            '<div id="ops86Msg" style="font-size:12.5px;margin-bottom:8px;"></div>' +
            '<div class="user-modal-grid">' +
              '<div class="form-field">' +
                '<label class="kicker" for="ops86Artikel">Artikel / Gericht / Getränk</label>' +
                '<input type="text" id="ops86Artikel" class="input-control" maxlength="120" placeholder="z. B. Lachs Sashimi, Matcha Latte …">' +
              '</div>' +
              '<div class="form-field">' +
                '<label class="kicker" for="ops86Bereich">Bereich</label>' +
                '<select id="ops86Bereich" class="input-control">' +
                  '<option value="KUECHE">Küche</option>' +
                  '<option value="BAR">Bar</option>' +
                  '<option value="SERVICE">Service</option>' +
                  '<option value="DESSERT">Dessert</option>' +
                  '<option value="ALLE">Alle</option>' +
                '</select>' +
              '</div>' +
            '</div>' +
            '<div style="display:flex;gap:10px;align-items:flex-end;flex-wrap:wrap;">' +
              '<div class="form-field" style="flex:1;min-width:220px;margin-bottom:0;">' +
                '<label class="kicker" for="ops86Notiz">Notiz / Grund (optional)</label>' +
                '<input type="text" id="ops86Notiz" class="input-control" maxlength="300" placeholder="z. B. Lieferung erst morgen, ausverkauft">' +
              '</div>' +
              '<button type="button" id="btnAddOps86" class="btn btn-primary">Auf 86 setzen</button>' +
            '</div>' +
          '</div>') +
      '<div class="card">' +
        '<div class="card-head"><div><div class="kicker">Aktive 86-Liste</div><h3>Aktuell nicht verfügbar (' + esc(items.length) + ')</h3></div></div>' +
        rowsHtml +
      '</div>';

    const reloadBtn = document.getElementById('btnOps86Reload');
    if (reloadBtn) {
      reloadBtn.addEventListener('click', function() { load86Tab(session, true); });
    }

    const addFn = async function() {
      const artEl = document.getElementById('ops86Artikel');
      const berEl = document.getElementById('ops86Bereich');
      const notizEl = document.getElementById('ops86Notiz');
      const msgEl = document.getElementById('ops86Msg');
      const btn = document.getElementById('btnAddOps86');
      const artikel = artEl ? artEl.value.trim() : '';
      if (artikel.length < 2) {
        if (msgEl) { msgEl.style.color = '#f87171'; msgEl.textContent = 'Bitte Artikelnamen eingeben (mind. 2 Zeichen).'; }
        return;
      }
      const list86Key = 'list86::' + session.standortId;
      const berVal = berEl ? berEl.value : 'KUECHE';
      const notizVal = notizEl ? notizEl.value.trim() : '';
      const optimistic86 = {
        id: 'TMP-86-' + Date.now(),
        artikel: artikel,
        bereich: berVal,
        notiz: notizVal,
        gemeldetVon: (session.user && session.user.name) || 'Team',
        erstelltAm: new Date().toISOString(),
        bestaetigtAm: new Date().toISOString().slice(0, 10),
        bestaetigtHeute: true
      };
      const snap86 = mutateOpsCache(list86Key, function(d) {
        d.items = Array.isArray(d.items) ? [optimistic86].concat(d.items) : [optimistic86];
        return d;
      });
      if (window.SonaApp && window.SonaApp.toast) window.SonaApp.toast('„' + artikel + '“ auf 86 gesetzt.');
      load86Tab(session, false);

      window.SonaApi.addOps86Item(session.standortId, {
        artikel: artikel,
        bereich: berVal,
        notiz: notizVal
      }).then(function(addRes) {
        if (!addRes || !addRes.success) {
          restoreOpsCacheSnapshot(list86Key, snap86);
          load86Tab(session, false);
          if (window.SonaApp && window.SonaApp.toast) window.SonaApp.toast((addRes && addRes.error) || 'Eintragen fehlgeschlagen.');
          return;
        }
        fetchOpsSwr(list86Key, function() { return window.SonaApi.getOps86List(session.standortId); }, true, function() {
          const p = document.getElementById('ops86Pane');
          if (p && document.body.contains(p)) load86Tab(session, false);
        });
      }).catch(function() {
        restoreOpsCacheSnapshot(list86Key, snap86);
        load86Tab(session, false);
        if (window.SonaApp && window.SonaApp.toast) window.SonaApp.toast('Verbindungsfehler.');
      });
    };

    const btnAdd = document.getElementById('btnAddOps86');
    if (btnAdd) btnAdd.addEventListener('click', addFn);
    const artInput = document.getElementById('ops86Artikel');
    if (artInput) {
      artInput.addEventListener('keydown', function(ev) {
        if (ev.key === 'Enter') { ev.preventDefault(); addFn(); }
      });
    }

    pane.querySelectorAll('.ops-86-confirm-btn').forEach(function(b) {
      b.addEventListener('click', function() {
        const id = b.dataset.id;
        const list86Key = 'list86::' + session.standortId;
        const snap = mutateOpsCache(list86Key, function(d) {
          d.items = (d.items || []).map(function(it) {
            if (String(it.id) === String(id)) {
              it.bestaetigtHeute = true;
              it.bestaetigtAm = new Date().toISOString().slice(0, 10);
            }
            return it;
          });
          return d;
        });
        if (window.SonaApp && window.SonaApp.toast) window.SonaApp.toast('Für heute als noch 86 bestätigt.');
        load86Tab(session, false);
        window.SonaApi.confirmOps86Item(session.standortId, id).then(function(cRes) {
          if (!cRes || !cRes.success) {
            restoreOpsCacheSnapshot(list86Key, snap);
            load86Tab(session, false);
          }
        }).catch(function() {
          restoreOpsCacheSnapshot(list86Key, snap);
          load86Tab(session, false);
        });
      });
    });

    pane.querySelectorAll('.ops-86-resolve-btn').forEach(function(b) {
      b.addEventListener('click', function() {
        const id = b.dataset.id;
        const list86Key = 'list86::' + session.standortId;
        const snap = mutateOpsCache(list86Key, function(d) {
          d.items = (d.items || []).filter(function(it) { return String(it.id) !== String(id); });
          return d;
        });
        if (window.SonaApp && window.SonaApp.toast) window.SonaApp.toast('Artikel wieder verfügbar (von 86 entfernt).');
        load86Tab(session, false);
        window.SonaApi.resolveOps86Item(session.standortId, id).then(function(rRes) {
          if (!rRes || !rRes.success) {
            restoreOpsCacheSnapshot(list86Key, snap);
            load86Tab(session, false);
          }
        }).catch(function() {
          restoreOpsCacheSnapshot(list86Key, snap);
          load86Tab(session, false);
        });
      });
    });
  }

  // ============================================================================
  // FEEDBACK & IDEEN (1 Woche sichtbar auf Startseite, Admin kann verlängern)
  // ============================================================================
  function renderFeedbackCardsHtml(entries) {
    if (!entries || !entries.length) {
      return '<p class="home-empty-hint">Aktuell kein offenes Team-Feedback aus den letzten 7 Tagen.</p>';
    }
    return '<div class="home-feedback-grid">' +
      entries.map(function(item) {
        const untilTxt = item.dauerhaft
          ? 'Dauerhaft'
          : ('Sichtbar bis ' + formatIsoShortDe(item.gueltigBis));
        return '<article class="home-feedback-card">' +
          '<div>' +
            '<div style="display:flex;align-items:center;justify-content:space-between;gap:6px;flex-wrap:wrap;">' +
              '<span class="badge">' + esc(item.thema || 'Allgemein') + '</span>' +
              '<span style="font-size:11px;color:var(--os-silk);">' + esc(formatTsShortDe(item.erstelltAm)) + '</span>' +
            '</div>' +
            '<div class="home-feedback-title">' + esc(item.titel) + '</div>' +
            (item.inhalt ? '<div class="home-feedback-body">' + esc(item.inhalt) + '</div>' : '') +
          '</div>' +
          '<div class="home-feedback-meta">' +
            '<span>Von <b>' + esc(item.autor || 'Mitarbeiter') + '</b></span>' +
            '<span>' + esc(untilTxt) + '</span>' +
          '</div>' +
        '</article>';
      }).join('') +
    '</div>';
  }

  async function renderFeedbackBoardInto(targetEl, session, forceRefresh) {
    if (!targetEl || !session || !session.standortId) return;
    const cacheKey = 'feedback::' + session.standortId;
    if (forceRefresh || !getOpsCache(cacheKey)) {
      targetEl.innerHTML = '<p class="home-empty-hint">Lade Feedback …</p>';
    }

    try {
      const res = await fetchOpsSwr(
        cacheKey,
        function() { return window.SonaApi.getOpsFeedbackList(session.standortId); },
        !!forceRefresh,
        function() {
          if (document.body.contains(targetEl)) {
            renderFeedbackBoardInto(targetEl, session, false);
          }
        }
      );
      if (!document.body.contains(targetEl)) return;
      if (!res || !res.success) {
        const msg = (res && res.error) || '';
        if (msg.indexOf('Unbekannte Aktion') !== -1) {
          targetEl.innerHTML = '<p class="home-empty-hint">Feedback-Board wird nach dem nächsten <code>@sync</code> automatisch aktiv.</p>';
          return;
        }
        targetEl.innerHTML = '<p class="home-empty-hint">Feedback konnte nicht geladen werden.</p>';
        return;
      }
      targetEl.innerHTML = renderFeedbackCardsHtml(res.activeEntries || []);
    } catch (err) {
      if (document.body.contains(targetEl)) {
        targetEl.innerHTML = '<p class="home-empty-hint">Aktuell keine Verbindung zum Feedback-Board.</p>';
      }
    }
  }

  async function loadFeedbackTab(session, forceRefresh) {
    const pane = document.getElementById('opsTabPane');
    if (!pane || !session) return;
    const cacheKey = 'feedback::' + session.standortId;

    if (forceRefresh || !getOpsCache(cacheKey)) {
      pane.innerHTML =
        '<div class="card">' +
          '<div class="kicker">Feedback &amp; Ideen</div>' +
          '<p class="module-desc">Lade Einträge …</p>' +
        '</div>';
    }

    let res = null;
    try {
      res = await fetchOpsSwr(
        cacheKey,
        function() { return window.SonaApi.getOpsFeedbackList(session.standortId); },
        !!forceRefresh,
        function() {
          if (document.getElementById('opsTabPane')) {
            loadFeedbackTab(session, false);
          }
        }
      );
    } catch (err) {
      res = { success: false, error: err && err.message ? err.message : String(err) };
    }
    if (!document.getElementById('opsTabPane')) return;

    const backendPending = !!(res && !res.success && String(res.error || '').indexOf('Unbekannte Aktion') !== -1);
    const isAdmin = !!(res && res.isAdmin);
    const allEntries = (res && res.success && Array.isArray(res.allEntries)) ? res.allEntries : [];

    const adminDurationHtml = isAdmin
      ? '<div class="form-field">' +
          '<label class="kicker" for="opsFbDuration">Sichtbarkeit auf Startseite (Admin)</label>' +
          '<select id="opsFbDuration" class="input-control">' +
            '<option value="7">1 Woche (Standard)</option>' +
            '<option value="14">2 Wochen</option>' +
            '<option value="30">1 Monat (30 Tage)</option>' +
            '<option value="DAUERHAFT">Dauerhaft sichtbar</option>' +
          '</select>' +
        '</div>'
      : '';

    const rowsHtml = allEntries.length
      ? '<div class="table-wrap"><table><thead><tr><th>Status</th><th>Thema</th><th>Feedback</th><th>Von</th><th>Sichtbar bis</th>' + (isAdmin ? '<th>Admin</th>' : '') + '</tr></thead><tbody>' +
          allEntries.map(function(it) {
            const statusBadge = it.isActive
              ? '<span class="badge badge-ok">Aktiv</span>'
              : '<span class="badge">Abgelaufen</span>';
            const bisTxt = it.dauerhaft ? 'Dauerhaft' : formatIsoShortDe(it.gueltigBis);
            const adminBtns = isAdmin
              ? '<div style="display:flex;gap:5px;flex-wrap:wrap;">' +
                  '<button type="button" class="btn btn-sm ops-fb-ext-btn" data-id="' + esc(it.id) + '" data-days="14">+2 Wo.</button>' +
                  '<button type="button" class="btn btn-sm ops-fb-ext-btn" data-id="' + esc(it.id) + '" data-days="30">+30 T.</button>' +
                  '<button type="button" class="btn btn-sm ops-fb-ext-btn" data-id="' + esc(it.id) + '" data-perm="1">Dauerhaft</button>' +
                  '<button type="button" class="btn btn-danger btn-sm ops-fb-del-btn" data-id="' + esc(it.id) + '">×</button>' +
                '</div>'
              : '';
            return '<tr>' +
              '<td>' + statusBadge + '</td>' +
              '<td><span class="badge">' + esc(it.thema || 'Allgemein') + '</span></td>' +
              '<td><b>' + esc(it.titel) + '</b>' + (it.inhalt ? '<div style="font-size:12px;color:var(--os-silk);margin-top:2px;max-width:380px;white-space:pre-wrap;">' + esc(it.inhalt) + '</div>' : '') + '</td>' +
              '<td style="white-space:nowrap;font-size:12px;"><b>' + esc(it.autor) + '</b><div style="font-size:11px;color:var(--os-silk);">' + esc(formatTsShortDe(it.erstelltAm)) + '</div></td>' +
              '<td style="white-space:nowrap;font-size:12px;">' + esc(bisTxt) + '</td>' +
              (isAdmin ? '<td style="white-space:nowrap;">' + adminBtns + '</td>' : '') +
            '</tr>';
          }).join('') +
        '</tbody></table></div>'
      : '<p class="home-empty-hint">Noch kein Feedback vorhanden.</p>';

    pane.innerHTML =
      (backendPending
        ? '<div class="card" style="margin-bottom:16px;"><p class="module-desc" style="margin:0;">Hinweis: Das Backend für <b>Feedback</b> wartet noch auf <code>@sync</code>.</p></div>'
        : '<div class="card" style="margin-bottom:16px;">' +
            '<div class="card-head">' +
              '<div><div class="kicker">Team-Feedback · 1 Woche auf Startseite sichtbar</div><h3>Feedback oder Idee eintragen</h3></div>' +
              '<button type="button" id="btnOpsFbReload" class="btn btn-sm">Aktualisieren</button>' +
            '</div>' +
            '<div id="opsFbMsg" style="font-size:12.5px;margin-bottom:8px;"></div>' +
            '<div class="user-modal-grid">' +
              '<div class="form-field">' +
                '<label class="kicker" for="opsFbThema">Thema / Kategorie</label>' +
                '<select id="opsFbThema" class="input-control">' +
                  '<option value="Veranstaltung">Veranstaltung / Event</option>' +
                  '<option value="Verbesserung">Mögliche Verbesserung</option>' +
                  '<option value="Service">Service / Ablauf</option>' +
                  '<option value="Küche / Bar">Küche / Bar</option>' +
                  '<option value="Allgemein">Allgemein</option>' +
                '</select>' +
              '</div>' +
              '<div class="form-field">' +
                '<label class="kicker" for="opsFbTitel">Kurztitel / Betreff</label>' +
                '<input type="text" id="opsFbTitel" class="input-control" maxlength="140" placeholder="z. B. Firmenfeier Freitag, Ablauf Bar …">' +
              '</div>' +
              adminDurationHtml +
            '</div>' +
            '<div class="form-field">' +
              '<label class="kicker" for="opsFbInhalt">Feedback / Verbesserungsvorschlag</label>' +
              '<textarea id="opsFbInhalt" class="input-control" rows="3" maxlength="3000" placeholder="Was lief gut? Was können wir beim nächsten Mal verbessern?"></textarea>' +
            '</div>' +
            '<div style="display:flex;justify-content:flex-end;">' +
              '<button type="button" id="btnSaveOpsFb" class="btn btn-primary">Feedback veröffentlichen</button>' +
            '</div>' +
          '</div>') +
      '<div class="card">' +
        '<div class="card-head"><div><div class="kicker">Übersicht</div><h3>Alle Feedback-Einträge (' + esc(allEntries.length) + ')</h3></div></div>' +
        rowsHtml +
      '</div>';

    const reloadBtn = document.getElementById('btnOpsFbReload');
    if (reloadBtn) reloadBtn.addEventListener('click', function() { loadFeedbackTab(session, true); });

    const btnSave = document.getElementById('btnSaveOpsFb');
    if (btnSave) {
      btnSave.addEventListener('click', async function() {
        const msgEl = document.getElementById('opsFbMsg');
        const thema = (document.getElementById('opsFbThema') && document.getElementById('opsFbThema').value) || 'Allgemein';
        const titel = (document.getElementById('opsFbTitel') && document.getElementById('opsFbTitel').value || '').trim();
        const inhalt = (document.getElementById('opsFbInhalt') && document.getElementById('opsFbInhalt').value || '').trim();
        const durEl = document.getElementById('opsFbDuration');
        const durVal = durEl ? durEl.value : '7';

        if (titel.length < 2 && inhalt.length < 3) {
          if (msgEl) { msgEl.style.color = '#f87171'; msgEl.textContent = 'Bitte Titel oder Feedback-Text eingeben.'; }
          return;
        }
        btnSave.disabled = true;
        btnSave.textContent = 'Speichert…';
        if (msgEl) msgEl.textContent = '';

        try {
          const fbKey = 'feedback::' + session.standortId;
          const payload = { thema: thema, titel: titel, inhalt: inhalt };
          if (isAdmin) {
            if (durVal === 'DAUERHAFT') payload.dauerhaft = true;
            else payload.durationDays = parseInt(durVal, 10) || 7;
          }
          const days = payload.durationDays || 7;
          const optimisticFb = {
            id: 'TMP-FB-' + Date.now(),
            thema: thema,
            titel: titel || thema,
            inhalt: inhalt,
            autor: (session.user && session.user.name) || 'Team',
            erstelltAm: new Date().toISOString(),
            dauerhaft: !!payload.dauerhaft,
            gueltigBis: payload.dauerhaft ? '' : new Date(Date.now() + days * 86400000).toISOString().slice(0, 10)
          };
          const snapFb = mutateOpsCache(fbKey, function(d) {
            d.entries = Array.isArray(d.entries) ? [optimisticFb].concat(d.entries) : [optimisticFb];
            return d;
          });
          if (window.SonaApp && window.SonaApp.toast) window.SonaApp.toast('Feedback veröffentlicht.');
          loadFeedbackTab(session, false);

          window.SonaApi.addOpsFeedback(session.standortId, payload).then(function(sRes) {
            if (!sRes || !sRes.success) {
              restoreOpsCacheSnapshot(fbKey, snapFb);
              loadFeedbackTab(session, false);
              if (window.SonaApp && window.SonaApp.toast) window.SonaApp.toast((sRes && sRes.error) || 'Speichern fehlgeschlagen.');
              return;
            }
            fetchOpsSwr(fbKey, function() { return window.SonaApi.getOpsFeedbackList(session.standortId); }, true, function() {
              const p = document.getElementById('opsFeedbackPane');
              if (p && document.body.contains(p)) loadFeedbackTab(session, false);
            });
          }).catch(function() {
            restoreOpsCacheSnapshot(fbKey, snapFb);
            loadFeedbackTab(session, false);
            if (window.SonaApp && window.SonaApp.toast) window.SonaApp.toast('Verbindungsfehler.');
          });
        });
      }

    if (isAdmin) {
      pane.querySelectorAll('.ops-fb-ext-btn').forEach(function(b) {
        b.addEventListener('click', function() {
          const fbKey = 'feedback::' + session.standortId;
          const fbId = b.dataset.id;
          const opts = b.dataset.perm === '1'
            ? { dauerhaft: true }
            : { durationDays: parseInt(b.dataset.days, 10) || 14 };
          const snap = mutateOpsCache(fbKey, function(d) {
            d.entries = (d.entries || []).map(function(it) {
              if (String(it.id) === String(fbId)) {
                if (opts.dauerhaft) { it.dauerhaft = true; it.gueltigBis = ''; }
                else { it.dauerhaft = false; it.gueltigBis = new Date(Date.now() + (opts.durationDays * 86400000)).toISOString().slice(0, 10); }
              }
              return it;
            });
            return d;
          });
          if (window.SonaApp && window.SonaApp.toast) window.SonaApp.toast('Sichtbarkeitsdauer aktualisiert.');
          loadFeedbackTab(session, false);
          window.SonaApi.extendOpsFeedback(session.standortId, fbId, opts).then(function(eRes) {
            if (!eRes || !eRes.success) {
              restoreOpsCacheSnapshot(fbKey, snap);
              loadFeedbackTab(session, false);
            }
          }).catch(function() {
            restoreOpsCacheSnapshot(fbKey, snap);
            loadFeedbackTab(session, false);
          });
        });
      });
      pane.querySelectorAll('.ops-fb-del-btn').forEach(function(b) {
        b.addEventListener('click', function() {
          const fbKey = 'feedback::' + session.standortId;
          const fbId = b.dataset.id;
          const snap = mutateOpsCache(fbKey, function(d) {
            d.entries = (d.entries || []).filter(function(it) { return String(it.id) !== String(fbId); });
            return d;
          });
          if (window.SonaApp && window.SonaApp.toast) window.SonaApp.toast('Feedback entfernt.');
          loadFeedbackTab(session, false);
          window.SonaApi.deleteOpsFeedback(session.standortId, fbId).then(function(dRes) {
            if (!dRes || !dRes.success) {
              restoreOpsCacheSnapshot(fbKey, snap);
              loadFeedbackTab(session, false);
            }
          }).catch(function() {
            restoreOpsCacheSnapshot(fbKey, snap);
            loadFeedbackTab(session, false);
          });
        });
      });
    }
  }

  function prefetch(session, sectionKey) {
    if (!session || !session.standortId) return;
    const sid = session.standortId;
    const today = todayIsoLocal();
    if (sectionKey === 'ops_todo') {
      const d = OPS_STATE.selectedTodoDate || today;
      if (!getOpsCache('todo::' + sid + '::' + d)) {
        window.SonaApi.getOpsTodoDay(sid, d, false).then(function(r) {
          if (r && r.success) setOpsCache('todo::' + sid + '::' + d, r);
        }).catch(function() {});
      }
    } else if (sectionKey === 'ops_putzplan') {
      const d = OPS_STATE.selectedPutzplanDate || today;
      if (!getOpsCache('putz::' + sid + '::' + d)) {
        window.SonaApi.getOpsPutzplanDay(sid, d).then(function(r) {
          if (r && r.success) setOpsCache('putz::' + sid + '::' + d, r);
        }).catch(function() {});
      }
    } else if (sectionKey === 'ops_reklamation') {
      const m = OPS_STATE.selectedMonth || '';
      if (!getOpsCache('reklam::' + sid + '::' + (m || 'LATEST'))) {
        window.SonaApi.getOpsReklamationMeta(sid, m).then(function(r) {
          if (r && r.success) setOpsCache('reklam::' + sid + '::' + (m || 'LATEST'), r);
        }).catch(function() {});
      }
    } else if (sectionKey === 'ops_ranking') {
      if (!getOpsCache('rating::' + sid)) {
        window.SonaApi.getOpsRatingMeta(sid).then(function(r) {
          if (r && r.success) setOpsCache('rating::' + sid, r);
        }).catch(function() {});
      }
    } else if (sectionKey === 'ops_tagesuebersicht') {
      if (!getOpsCache('news::' + sid)) {
        window.SonaApi.getOpsNewsList(sid).then(function(r) {
          if (r && r.success) setOpsCache('news::' + sid, r);
        }).catch(function() {});
      }
    } else if (sectionKey === 'ops_86') {
      if (!getOpsCache('list86::' + sid)) {
        window.SonaApi.getOps86List(sid).then(function(r) {
          if (r && r.success) setOpsCache('list86::' + sid, r);
        }).catch(function() {});
      }
    } else if (sectionKey === 'ops_feedback') {
      if (!getOpsCache('feedback::' + sid)) {
        window.SonaApi.getOpsFeedbackList(sid).then(function(r) {
          if (r && r.success) setOpsCache('feedback::' + sid, r);
        }).catch(function() {});
      }
    }
  }

  window.SonaOperationsModule = {
    openExternalTab: openExternalTab,
    clearCache: clearCache,
    prefetch: prefetch,
    hydrateRoutineProgress: hydrateRoutineProgress,
    renderNewsBoardInto: renderNewsBoardInto,
    render86BoardInto: render86BoardInto,
    renderFeedbackBoardInto: renderFeedbackBoardInto,
    renderAuswertungInto: function(targetEl, session) {
      if (!targetEl || !session) return;
      loadMonthlySummary(session, false, OPS_STATE.selectedPeriod, targetEl);
    },
    mount: function(session, mod, sectionKey) {
      const container = document.getElementById('osMainContent');
      if (!container) return;

      const rawSchwundUrl = (mod && mod.schwundUrl) || '';
      const rawBruchUrl = (mod && mod.bruchUrl) || '';
      const userName = getSavedOpsName(session);
      const appendUserParam = function(u) {
        if (!u || !userName) return u;
        return u + (u.indexOf('?') === -1 ? '?' : '&') + 'user=' + encodeURIComponent(userName);
      };
      const schwundUrl = appendUserParam(rawSchwundUrl);
      const bruchUrl = appendUserParam(rawBruchUrl);

      const perms = (session && session.permissions) || {};
      const opTabs = (perms.tabPermissions && perms.tabPermissions.operations !== undefined)
        ? perms.tabPermissions.operations
        : 'ALL';

      const canReklamation = (opTabs === 'ALL') || (Array.isArray(opTabs) && opTabs.indexOf('reklamation') !== -1);
      const canSchwundInput = (opTabs === 'ALL') || (Array.isArray(opTabs) && opTabs.indexOf('schwund_eingabe') !== -1);
      const canBruchInput = (opTabs === 'ALL') || (Array.isArray(opTabs) && opTabs.indexOf('bruch_eingabe') !== -1);
      const canStaffRating = (opTabs === 'ALL') || (Array.isArray(opTabs) && opTabs.indexOf('mitarbeiterbewertung') !== -1);

      const activeSection = sectionKey || 'home';

      const renderOpsHome = function() {
        const cards = [];
        cards.push(
          '<button type="button" class="home-tile" data-ops-nav="ops_tagesuebersicht">' +
            '<div class="home-tile-head"><h4 class="home-tile-title">Tagesübersicht &amp; Infos</h4><span class="home-tile-arrow">→</span></div>' +
            '<p class="home-tile-desc">Routineaufgaben, Neuerungen &amp; Dokumente verwalten</p>' +
          '</button>'
        );
        if (canSchwundInput) {
          cards.push(
            '<button type="button" class="home-tile" data-ops-ext="' + esc(schwundUrl) + '">' +
              '<div class="home-tile-head"><h4 class="home-tile-title">Schwund</h4><span class="home-tile-arrow">↗</span></div>' +
              '<p class="home-tile-desc">Verderb &amp; Überproduktion erfassen</p>' +
            '</button>'
          );
        }
        if (canBruchInput) {
          cards.push(
            '<button type="button" class="home-tile" data-ops-ext="' + esc(bruchUrl) + '">' +
              '<div class="home-tile-head"><h4 class="home-tile-title">Bruch</h4><span class="home-tile-arrow">↗</span></div>' +
              '<p class="home-tile-desc">Glas-, Geschirr- &amp; Flaschenbruch erfassen</p>' +
            '</button>'
          );
        }
        if (canReklamation) {
          cards.push(
            '<button type="button" class="home-tile" data-ops-nav="ops_reklamation">' +
              '<div class="home-tile-head"><h4 class="home-tile-title">Reklamation und Beschwerden</h4><span class="home-tile-arrow">→</span></div>' +
              '<p class="home-tile-desc">Gästefeedback &amp; Reklamationen dokumentieren</p>' +
            '</button>'
          );
        }
        cards.push(
          '<button type="button" class="home-tile" data-ops-nav="ops_todo">' +
            '<div class="home-tile-head"><h4 class="home-tile-title">To-Do-Liste</h4><span class="home-tile-arrow">→</span></div>' +
            '<p class="home-tile-desc">Aufgaben für Küche, Bar &amp; Service</p>' +
          '</button>'
        );
        cards.push(
          '<button type="button" class="home-tile" data-ops-nav="ops_putzplan">' +
            '<div class="home-tile-head"><h4 class="home-tile-title">Putzplan</h4><span class="home-tile-arrow">→</span></div>' +
            '<p class="home-tile-desc">Tägliche &amp; wöchentliche Reinigungspläne</p>' +
          '</button>'
        );
        if (canStaffRating) {
          cards.push(
            '<button type="button" class="home-tile" data-ops-nav="ops_ranking">' +
              '<div class="home-tile-head"><h4 class="home-tile-title">Mitarbeiter Ranking</h4><span class="home-tile-arrow">→</span></div>' +
              '<p class="home-tile-desc">Personal Scorecard &amp; Azubi-Entwicklung</p>' +
            '</button>'
          );
        }
        cards.push(
          '<button type="button" class="home-tile" data-ops-nav="ops_86">' +
            '<div class="home-tile-head"><h4 class="home-tile-title">86-Liste</h4><span class="home-tile-arrow">→</span></div>' +
            '<p class="home-tile-desc">Ausverkaufte Artikel eintragen &amp; täglich prüfen</p>' +
          '</button>'
        );
        cards.push(
          '<button type="button" class="home-tile" data-ops-nav="ops_feedback">' +
            '<div class="home-tile-head"><h4 class="home-tile-title">Feedback</h4><span class="home-tile-arrow">→</span></div>' +
            '<p class="home-tile-desc">Ideen, Veranstaltungen &amp; Verbesserungen teilen</p>' +
          '</button>'
        );

        container.innerHTML =
          '<div class="pillar-section">' +
            '<div class="pillar-head"><h3>Operations</h3></div>' +
            '<div class="grid-3">' + cards.join('') + '</div>' +
          '</div>';

        container.querySelectorAll('[data-ops-ext]').forEach(function(btn) {
          btn.addEventListener('click', function() {
            if (btn.dataset.opsExt) openExternalTab(btn.dataset.opsExt);
          });
        });
        container.querySelectorAll('[data-ops-nav]').forEach(function(btn) {
          btn.addEventListener('click', function() {
            if (window.SonaApp && window.SonaApp.openView) {
              window.SonaApp.openView(btn.dataset.opsNav);
            }
          });
        });
      };

      const renderSectionWrapper = function(title, sectionKeyForLog) {
        const showActivity = canViewOpsActivity(session);
        const activityHtml = showActivity
          ? '<details id="opsActivityDetails" class="ops-activity-details">' +
              '<summary>Verlauf &amp; Details (Wer hat was wann eingetragen?)</summary>' +
              '<div id="opsActivityBody" class="ops-activity-body"><p class="module-desc" style="margin:0;">Klicken zum Laden …</p></div>' +
            '</details>'
          : '';
        container.innerHTML =
          '<div style="display:flex;align-items:center;justify-content:space-between;gap:12px;margin-bottom:14px;flex-wrap:wrap;">' +
            '<button type="button" id="btnOpsBackHome" class="btn btn-sm">← Zurück zu Operations</button>' +
            '<span class="kicker">' + esc(title) + '</span>' +
          '</div>' +
          '<div id="opsTabPane"></div>' +
          activityHtml;
        const backBtn = document.getElementById('btnOpsBackHome');
        if (backBtn) {
          backBtn.addEventListener('click', function() {
            if (window.SonaApp && window.SonaApp.openView) {
              window.SonaApp.openView('mod_operations');
            } else {
              renderOpsHome();
            }
          });
        }
        const detailsEl = document.getElementById('opsActivityDetails');
        if (detailsEl) {
          let loadedOnce = false;
          detailsEl.addEventListener('toggle', async function() {
            if (!detailsEl.open || loadedOnce) return;
            loadedOnce = true;
            const bodyEl = document.getElementById('opsActivityBody');
            if (!bodyEl) return;
            bodyEl.innerHTML = '<p class="module-desc" style="margin:0;">Lade Verlauf …</p>';
            try {
              const aRes = await window.SonaApi.getOpsActivityLog(session.standortId, sectionKeyForLog || 'all', 35);
              if (!document.body.contains(bodyEl)) return;
              if (!aRes || !aRes.success) {
                bodyEl.innerHTML = '<p class="module-desc" style="margin:0;">' + esc((aRes && aRes.error) || 'Verlauf noch nicht aktiv (Backend-@sync erforderlich).') + '</p>';
                return;
              }
              const list = Array.isArray(aRes.entries) ? aRes.entries : [];
              if (!list.length) {
                bodyEl.innerHTML = '<p class="module-desc" style="margin:0;">Noch keine Einträge im Verlauf für diesen Bereich.</p>';
                return;
              }
              bodyEl.innerHTML =
                '<div class="table-wrap"><table><thead><tr><th>Zeitpunkt</th><th>Benutzer</th><th>Aktion</th><th>Detail</th></tr></thead><tbody>' +
                  list.map(function(it) {
                    return '<tr>' +
                      '<td style="white-space:nowrap;font-size:11.5px;color:var(--os-silk);">' + esc(formatTsShortDe(it.timestamp)) + '</td>' +
                      '<td style="font-size:12px;"><b>' + esc(it.name || 'System') + '</b>' + (it.email ? '<div class="rbac-user-email">' + esc(it.email) + '</div>' : '') + '</td>' +
                      '<td style="white-space:nowrap;font-size:11px;">' + esc(it.aktion) + '</td>' +
                      '<td style="font-size:12px;color:var(--os-silk);">' + esc(it.detail || '—') + '</td>' +
                    '</tr>';
                  }).join('') +
                '</tbody></table></div>';
            } catch (eAct) {
              if (document.body.contains(bodyEl)) {
                bodyEl.innerHTML = '<p class="module-desc" style="margin:0;">Verlauf konnte nicht geladen werden.</p>';
              }
            }
          });
        }
      };

      if (activeSection === 'tagesuebersicht') {
        renderSectionWrapper('Tagesübersicht', 'tagesuebersicht');
        loadTagesuebersichtTab(session, false);
        return;
      }

      if (activeSection === '86') {
        renderSectionWrapper('86-Liste', '86');
        load86Tab(session, false);
        return;
      }

      if (activeSection === 'feedback') {
        renderSectionWrapper('Feedback & Ideen', 'feedback');
        loadFeedbackTab(session, false);
        return;
      }

      if (activeSection === 'reklamation') {
        if (!canReklamation) {
          container.innerHTML = '<div class="card"><p class="module-desc">Kein Zugriff auf Reklamation und Beschwerden.</p></div>';
          return;
        }
        renderSectionWrapper('Reklamation und Beschwerden', 'reklamation');
        loadReklamationTab(session, OPS_STATE.selectedMonth);
        return;
      }

      if (activeSection === 'ranking') {
        if (!canStaffRating) {
          container.innerHTML = '<div class="card"><p class="module-desc">Kein Zugriff auf Mitarbeiter Ranking.</p></div>';
          return;
        }
        renderSectionWrapper('Mitarbeiter Ranking', 'ranking');
        loadRatingTab(session);
        return;
      }

      if (activeSection === 'todo') {
        renderSectionWrapper('To-Do-Liste', 'todo');
        loadTodoTab(session, OPS_STATE.selectedTodoDate || todayIsoLocal(), false);
        return;
      }

      if (activeSection === 'putzplan') {
        renderSectionWrapper('Putzplan', 'putzplan');
        loadPutzplanTab(session, OPS_STATE.selectedPutzplanDate || todayIsoLocal());
        return;
      }

      renderOpsHome();
    }
  };
})();
