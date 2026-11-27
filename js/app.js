'use strict';

(function() {
  const STATE = {
    session: null,
    lastLoginSecret: '',
    activeAuthTab: 'login',
    activeView: 'overview',
    rbacEntries: [],
    pendingRequests: [],
    rbacLocations: [],
    allowedRoles: ['ADMIN', 'FB_MANAGER', 'KUECHENCHEF', 'BARCHEF', 'SERVICELEITUNG', 'SERVICECHEF', 'SERVICE-MITARBEITER', 'AZUBI', 'ADMIN_VIEWER', 'VIEWER'],
    allowedBereiche: ['ALLE', 'FOOD_SUSHI', 'BEVERAGE_DESSERT', 'KUECHE', 'BAR', 'SERVICE'],
    adminNotificationEmail: 'j.helmeke97@gmail.com',
    lastOtpResult: null,
    tabCatalog: { rezeptur: [], einkauf: [], operations: [], performance: [], admin: [] },
    openPillars: { OPERATIONS: false, EVENTS: false, WARENWIRTSCHAFT: false, CONTROLLING: false, PERFORMANCE: false, ADMIN: false },
    auditEntries: [],
    moduleFrames: {},
    sidebarCollapsed: false,
    deferredInstallPrompt: null
  };

  const SESSION_CACHE_KEY = 'sona_os_session_cache_v1';
  const SESSION_CACHE_TTL_MS = 24 * 60 * 60 * 1000;
  const ADMIN_CACHE_FRESH_MS = 60000;
  const ADMIN_CACHE_STALE_MS = 300000;
  const ADMIN_CACHE = { rbac: null, audit: Object.create(null) };
  const PRELOAD_STATE = {
    urls: Object.create(null),
    inFlight: Object.create(null),
    warmedKey: '',
    timers: []
  };

  function saveSessionCache(sess) {
    if (!sess || !sess.success || !sess.user) return;
    const token = window.SonaApi.getToken();
    if (!token) return;
    const payload = JSON.stringify({ token: token, ts: Date.now(), session: sess });
    try {
      if (window.SonaApi.isRemembered()) {
        localStorage.setItem(SESSION_CACHE_KEY, payload);
        sessionStorage.removeItem(SESSION_CACHE_KEY);
      } else {
        sessionStorage.setItem(SESSION_CACHE_KEY, payload);
        localStorage.removeItem(SESSION_CACHE_KEY);
      }
    } catch (e) {}
  }

  function loadSessionCache() {
    const token = window.SonaApi.getToken();
    if (!token) return null;
    try {
      const raw = sessionStorage.getItem(SESSION_CACHE_KEY) || localStorage.getItem(SESSION_CACHE_KEY);
      if (!raw) return null;
      const parsed = JSON.parse(raw);
      if (!parsed || parsed.token !== token || !parsed.session) return null;
      if ((Date.now() - (parsed.ts || 0)) > SESSION_CACHE_TTL_MS) return null;
      return parsed.session;
    } catch (e) {
      return null;
    }
  }

  function clearSessionCache() {
    try {
      sessionStorage.removeItem(SESSION_CACHE_KEY);
      localStorage.removeItem(SESSION_CACHE_KEY);
    } catch (e) {}
  }

  function clearWarmupTimers() {
    PRELOAD_STATE.timers.forEach(id => clearTimeout(id));
    PRELOAD_STATE.timers = [];
    PRELOAD_STATE.warmedKey = '';
  }

  function shortLocName(name) {
    return String(name || '').replace(/^sona\s+/i, '').trim() || String(name || '');
  }

  function $(id) {
    return document.getElementById(id);
  }

  function esc(val) {
    return String(val == null ? '' : val).replace(/[&<>"']/g, function(m) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[m];
    });
  }

  function showToast(msg) {
    const existing = document.querySelector('.toast');
    if (existing) existing.remove();
    const el = document.createElement('div');
    el.className = 'toast';
    el.textContent = msg;
    document.body.appendChild(el);
    setTimeout(() => {
      el.style.opacity = '0';
      el.style.transition = 'opacity 0.25s ease';
      setTimeout(() => el.remove(), 260);
    }, 3400);
  }

  function setAuthMessages(errorMsg, successMsg) {
    const errEl = $('lockError');
    const okEl = $('lockSuccess');
    if (errEl) {
      if (errorMsg) {
        errEl.textContent = errorMsg;
        errEl.classList.remove('hidden');
      } else {
        errEl.textContent = '';
        errEl.classList.add('hidden');
      }
    }
    if (okEl) {
      if (successMsg) {
        okEl.textContent = successMsg;
        okEl.classList.remove('hidden');
      } else {
        okEl.textContent = '';
        okEl.classList.add('hidden');
      }
    }
  }

  function switchAuthTab(tab) {
    STATE.activeAuthTab = tab === 'register' ? 'register' : 'login';
    const isReg = STATE.activeAuthTab === 'register';
    const btnLogin = $('tabBtnLogin');
    const btnReg = $('tabBtnRegister');
    const paneLogin = $('loginFormPane');
    const paneReg = $('registerFormPane');
    if (btnLogin) {
      btnLogin.classList.toggle('active', !isReg);
      btnLogin.setAttribute('aria-selected', isReg ? 'false' : 'true');
    }
    if (btnReg) {
      btnReg.classList.toggle('active', isReg);
      btnReg.setAttribute('aria-selected', isReg ? 'true' : 'false');
    }
    if (paneLogin) paneLogin.classList.toggle('hidden', isReg);
    if (paneReg) paneReg.classList.toggle('hidden', !isReg);
    setAuthMessages('', '');
  }

  function clearModuleFrames() {
    STATE.moduleFrames = {};
    const host = $('osModuleFrameHost');
    if (host) {
      host.innerHTML = '';
      host.classList.add('hidden');
    }
    const main = $('osMainContent');
    if (main) main.classList.remove('hidden');
  }

  function clearAllModuleCaches() {
    clearWarmupTimers();
    clearModuleFrames();
    ADMIN_CACHE.rbac = null;
    ADMIN_CACHE.audit = Object.create(null);
    PRELOAD_STATE.urls = Object.create(null);
    PRELOAD_STATE.inFlight = Object.create(null);
    if (window.SonaBestandModule) window.SonaBestandModule.clearCache();
    if (window.SonaControllingModule) window.SonaControllingModule.clearCache();
    if (window.SonaEinkaufModule) window.SonaEinkaufModule.clearCache();
    if (window.SonaRezepturModule) window.SonaRezepturModule.clearCache();
    if (window.SonaOperationsModule && window.SonaOperationsModule.clearCache) {
      window.SonaOperationsModule.clearCache();
    }
  }

  function lockApp(reasonMsg) {
    clearSessionCache();
    window.SonaApi.setToken('');
    STATE.session = null;
    STATE.lastLoginSecret = '';
    STATE.rbacEntries = [];
    STATE.pendingRequests = [];
    STATE.lastOtpResult = null;
    clearAllModuleCaches();
    $('osAppShell').classList.add('hidden');
    $('forcePasswordScreen').classList.add('hidden');
    $('changePasswordModal').classList.add('hidden');
    $('userProfileModal').classList.add('hidden');
    if ($('forgotPasswordModal')) $('forgotPasswordModal').classList.add('hidden');
    $('osNavList').innerHTML = '';
    $('osMobileNav').innerHTML = '';
    $('osMainContent').innerHTML = '';
    if ($('loginPassword')) $('loginPassword').value = '';
    if ($('forcePwCurrent')) $('forcePwCurrent').value = '';
    if ($('forcePwNew')) $('forcePwNew').value = '';
    if ($('forcePwConfirm')) $('forcePwConfirm').value = '';
    $('lockScreen').classList.remove('hidden');
    switchAuthTab('login');
    setAuthMessages(reasonMsg || '', '');
    loadPublicMeta();
  }

  async function loadPublicMeta() {
    const locSel = $('regLocation');
    const renderLocOptions = locs => {
      if (!locSel) return;
      locSel.innerHTML = (locs || window.SONA_OS_DEFAULTS.LOCATIONS).map(l =>
        '<option value="' + esc(l.id) + '">' + esc(l.name) + ' (' + esc(l.id) + ')</option>'
      ).join('');
    };
    renderLocOptions(window.SONA_OS_DEFAULTS.LOCATIONS);
    try {
      const res = await window.SonaApi.listUsers();
      if (res && res.success && Array.isArray(res.locations) && res.locations.length) {
        renderLocOptions(res.locations);
      }
    } catch (err) {
      // Fallback-Standorte bleiben aktiv; Verbindungsfehler werden beim Submit angezeigt
    }
  }

  function showForcePasswordScreen() {
    const s = STATE.session;
    if (!s || !s.user) {
      lockApp();
      return;
    }
    $('lockScreen').classList.add('hidden');
    $('osAppShell').classList.add('hidden');
    const lbl = $('forcePwUserLabel');
    if (lbl) {
      lbl.textContent = s.user.name + (s.user.email ? ' · ' + s.user.email : '');
    }
    if ($('forcePwError')) {
      $('forcePwError').textContent = '';
      $('forcePwError').classList.add('hidden');
    }
    if ($('forcePwCurrent')) $('forcePwCurrent').value = STATE.lastLoginSecret || '';
    if ($('forcePwNew')) $('forcePwNew').value = '';
    if ($('forcePwConfirm')) $('forcePwConfirm').value = '';
    $('forcePasswordScreen').classList.remove('hidden');
  }

  async function submitLogin() {
    const email = ($('loginEmail') && $('loginEmail').value || '').trim().toLowerCase();
    const password = ($('loginPassword') && $('loginPassword').value || '').trim();
    const rememberMe = !!($('loginRememberMe') && $('loginRememberMe').checked);

    if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      setAuthMessages('Bitte gültige Gmail / E-Mail-Adresse eingeben.', '');
      return;
    }
    if (!password) {
      setAuthMessages('Bitte Passwort oder Einmal-Passwort eingeben.', '');
      return;
    }

    setAuthMessages('', '');
    window.SonaLoader.show(120);
    try {
      const res = await window.SonaApi.login(email, password, '', rememberMe);
      if (!res || !res.success || !res.token) {
        if ($('loginPassword')) $('loginPassword').value = '';
        setAuthMessages((res && res.error) || 'Anmeldung fehlgeschlagen.', '');
        return;
      }
      window.SonaApi.setToken(res.token, rememberMe);
      STATE.session = res;
      saveSessionCache(res);
      if ($('loginPassword')) $('loginPassword').value = '';
      if (res.mustChangePassword) {
        STATE.lastLoginSecret = password;
        showForcePasswordScreen();
        return;
      }
      STATE.lastLoginSecret = '';
      STATE.activeView = 'overview';
      renderAuthenticatedShell();
    } catch (err) {
      if ($('loginPassword')) $('loginPassword').value = '';
      setAuthMessages('Verbindungsfehler: ' + (err && err.message ? err.message : String(err)), '');
    } finally {
      window.SonaLoader.hide();
    }
  }

  async function submitRegisterRequest() {
    const name = ($('regName') && $('regName').value || '').trim();
    const email = ($('regEmail') && $('regEmail').value || '').trim().toLowerCase();
    const standortId = ($('regLocation') && $('regLocation').value) || '001';
    const bereich = ($('regBereich') && $('regBereich').value) || 'ALLE';
    const note = ($('regNote') && $('regNote').value || '').trim();

    if (name.length < 2) {
      setAuthMessages('Bitte vollständigen Namen eingeben (mind. 2 Zeichen).', '');
      return;
    }
    if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      setAuthMessages('Bitte gültige Gmail / E-Mail-Adresse eingeben.', '');
      return;
    }

    setAuthMessages('', '');
    window.SonaLoader.show(0);
    try {
      const res = await window.SonaApi.registerRequest({
        name: name,
        email: email,
        standortId: standortId,
        bereich: bereich,
        note: note
      });
      if (!res || !res.success) {
        setAuthMessages((res && res.error) || 'Anfrage konnte nicht gesendet werden.', '');
        return;
      }
      if ($('regName')) $('regName').value = '';
      if ($('regEmail')) $('regEmail').value = '';
      if ($('regNote')) $('regNote').value = '';
      const extraInfo = res.notifiedAdmin ? ' Die Administration wurde per E-Mail benachrichtigt.' : '';
      setAuthMessages('', (res.message || 'Zugangs-Anfrage gesendet.') + extraInfo);
    } catch (err) {
      setAuthMessages('Verbindungsfehler: ' + (err && err.message ? err.message : String(err)), '');
    } finally {
      window.SonaLoader.hide();
    }
  }

  async function submitForcePasswordChange() {
    const curPw = ($('forcePwCurrent') && $('forcePwCurrent').value || '').trim();
    const newPw = ($('forcePwNew') && $('forcePwNew').value || '').trim();
    const confirmPw = ($('forcePwConfirm') && $('forcePwConfirm').value || '').trim();
    const errEl = $('forcePwError');
    const showForceErr = msg => {
      if (!errEl) return;
      if (msg) {
        errEl.textContent = msg;
        errEl.classList.remove('hidden');
      } else {
        errEl.textContent = '';
        errEl.classList.add('hidden');
      }
    };

    if (!curPw) {
      showForceErr('Bitte aktuelles Passwort / Einmal-Passwort eingeben.');
      return;
    }
    if (newPw.length < 6 || newPw.length > 64) {
      showForceErr('Das neue Passwort muss zwischen 6 und 64 Zeichen lang sein.');
      return;
    }
    if (newPw !== confirmPw) {
      showForceErr('Die beiden neuen Passwörter stimmen nicht überein.');
      return;
    }

    showForceErr('');
    window.SonaLoader.show(0);
    try {
      const res = await window.SonaApi.changePassword(curPw, newPw);
      if (!res || !res.success || !res.token) {
        showForceErr((res && res.error) || 'Passwort konnte nicht gespeichert werden.');
        return;
      }
      window.SonaApi.setToken(res.token, window.SonaApi.isRemembered());
      STATE.session = res;
      STATE.lastLoginSecret = '';
      if ($('forcePwCurrent')) $('forcePwCurrent').value = '';
      if ($('forcePwNew')) $('forcePwNew').value = '';
      if ($('forcePwConfirm')) $('forcePwConfirm').value = '';
      $('forcePasswordScreen').classList.add('hidden');
      STATE.activeView = 'overview';
      renderAuthenticatedShell();
      showToast('Persönliches Passwort gespeichert. Willkommen im SONA OS!');
    } catch (err) {
      showForceErr('Verbindungsfehler: ' + (err && err.message ? err.message : String(err)));
    } finally {
      window.SonaLoader.hide();
    }
  }

  function getIsoWeekNumber(dateObj) {
    const d = new Date(Date.UTC(dateObj.getFullYear(), dateObj.getMonth(), dateObj.getDate()));
    d.setUTCDate(d.getUTCDate() + 4 - (d.getUTCDay() || 7));
    const yearStart = new Date(Date.UTC(d.getUTCFullYear(), 0, 1));
    return Math.ceil((((d - yearStart) / 86400000) + 1) / 7);
  }

  function updateGlobalPeriodBar(session) {
    const now = new Date();
    const dateEl = $('osPeriodDate');
    const monthEl = $('osPeriodMonth');
    const kwEl = $('osPeriodKw');
    const locEl = $('osPeriodLocation');
    if (dateEl) {
      dateEl.textContent = now.toLocaleDateString('de-DE', { weekday: 'short', day: '2-digit', month: '2-digit', year: 'numeric' });
    }
    if (monthEl) {
      monthEl.textContent = now.toLocaleDateString('de-DE', { month: 'long', year: 'numeric' });
    }
    if (kwEl) {
      kwEl.textContent = 'KW ' + String(getIsoWeekNumber(now)).padStart(2, '0');
    }
    if (locEl) {
      locEl.textContent = '';
    }
  }

  function hasAdminTab(session, tabId) {
    if (!session || !session.permissions) return false;
    const tp = session.permissions.tabPermissions || {};
    const adm = tp.admin;
    if (session.permissions.adminMatrix) {
      return !adm || adm === 'ALL' || (Array.isArray(adm) && adm.indexOf(tabId) !== -1);
    }
    return Array.isArray(adm) && adm.indexOf(tabId) !== -1;
  }

  function renderAuthenticatedShell() {
    const s = STATE.session;
    if (!s || !s.permissions) {
      lockApp();
      return;
    }

    $('lockScreen').classList.add('hidden');
    $('osAppShell').classList.remove('hidden');
    updateGlobalPeriodBar(s);

    const mods = s.ecosystemModules || [];
    const opsMod = mods.find(m => m.key === 'operations');
    const perms = (s && s.permissions) || {};
    const opTabs = (perms.tabPermissions && perms.tabPermissions.operations !== undefined)
      ? perms.tabPermissions.operations
      : 'ALL';
    const hasOpTab = id => opTabs === 'ALL' || (Array.isArray(opTabs) && opTabs.indexOf(id) !== -1);

    const opsNavItems = [];
    if (opsMod) {
      if (hasOpTab('tagesuebersicht')) {
        opsNavItems.push({ key: 'ops_tagesuebersicht', title: 'Tagesübersicht', pillar: 'OPERATIONS' });
      }
      if (hasOpTab('schwund_eingabe') && opsMod.schwundUrl) {
        opsNavItems.push({ key: 'ops_schwund', title: 'Schwund', pillar: 'OPERATIONS', externalUrl: buildQuickOpsUrl(opsMod.schwundUrl, s) });
      }
      if (hasOpTab('bruch_eingabe') && opsMod.bruchUrl) {
        opsNavItems.push({ key: 'ops_bruch', title: 'Bruch', pillar: 'OPERATIONS', externalUrl: buildQuickOpsUrl(opsMod.bruchUrl, s) });
      }
      if (hasOpTab('reklamation')) {
        opsNavItems.push({ key: 'ops_reklamation', title: 'Reklamation und Beschwerden', pillar: 'OPERATIONS' });
      }
      if (hasOpTab('todo')) {
        opsNavItems.push({ key: 'ops_todo', title: 'To-Do-Liste', pillar: 'OPERATIONS' });
      }
      if (hasOpTab('putzplan')) {
        opsNavItems.push({ key: 'ops_putzplan', title: 'Putzplan', pillar: 'OPERATIONS' });
      }
      if (hasOpTab('mitarbeiterbewertung')) {
        opsNavItems.push({ key: 'ops_ranking', title: 'Mitarbeiter Ranking', pillar: 'OPERATIONS' });
      }
      if (hasOpTab('liste86')) {
        opsNavItems.push({ key: 'ops_86', title: '86-Liste', pillar: 'OPERATIONS' });
      }
      if (hasOpTab('feedback')) {
        opsNavItems.push({ key: 'ops_feedback', title: 'Feedback', pillar: 'OPERATIONS' });
      }
    }

    const navItems = [
      { key: 'overview', title: 'Startseite', pillar: 'ROOT' }
    ]
      .concat(opsNavItems)
      .concat(mods.filter(m => m.key !== 'operations').map(m => ({ key: 'mod_' + m.key, title: m.title, pillar: m.pillar || 'WARENWIRTSCHAFT' })));

    const hasWwOrOps = mods.some(m => (m.pillar || 'WARENWIRTSCHAFT') === 'WARENWIRTSCHAFT') ||
      !!(opsMod && (hasOpTab('schwund_eingabe') || hasOpTab('bruch_eingabe')));
    if (hasWwOrOps) {
      navItems.push({ key: 'ww_auswertung', title: 'Schwund & Bruch', pillar: 'WARENWIRTSCHAFT' });
    }

    const adminNavItems = [];
    if (hasAdminTab(s, 'rbac')) {
      adminNavItems.push({ key: 'rbac', title: 'Rechte-Matrix', pillar: 'ADMIN' });
    }
    if (hasAdminTab(s, 'audit_log')) {
      adminNavItems.push({ key: 'audit_log', title: 'Aktivitätsprotokoll', pillar: 'ADMIN' });
    }
    if (hasAdminTab(s, 'rundmail')) {
      adminNavItems.push({ key: 'rundmail', title: 'Rundmail', pillar: 'ADMIN' });
    }
    if (hasAdminTab(s, 'quellen')) {
      adminNavItems.push({ key: 'quellen', title: 'Quellen', pillar: 'ADMIN' });
    }
    if (hasAdminTab(s, 'direktnachricht')) {
      adminNavItems.push({ key: 'direktnachricht', title: 'Direktnachrichten', pillar: 'ADMIN' });
    }
    adminNavItems.forEach(it => navItems.push(it));

    const validNonNavView = STATE.activeView === 'mod_operations' || STATE.activeView === 'support_help';
    if (!validNonNavView && !navItems.some(x => x.key === STATE.activeView)) {
      STATE.activeView = 'overview';
    }

    const pillarGroups = [
      { id: 'OPERATIONS', label: 'Operations' },
      { id: 'EVENTS', label: 'Events' },
      { id: 'WARENWIRTSCHAFT', label: 'Warenwirtschaft' },
      { id: 'CONTROLLING', label: 'Controlling' },
      { id: 'PERFORMANCE', label: 'Performance' }
    ];

    let navHtml =
      '<button type="button" class="os-nav-btn' + (STATE.activeView === 'overview' ? ' active' : '') + '" data-view="overview">' +
        '<span>Startseite</span>' +
      '</button>';

    const isOpsView = STATE.activeView === 'mod_operations' || STATE.activeView.indexOf('ops_') === 0;
    const renderPillarGroupHtml = group => {
      const items = navItems.filter(it => it.pillar === group.id);
      if (!items.length) return '';
      const isOpen = !!STATE.openPillars[group.id] || items.some(it => it.key === STATE.activeView) || (group.id === 'OPERATIONS' && isOpsView);
      STATE.openPillars[group.id] = isOpen;
      return '<div class="os-nav-group' + (isOpen ? ' open' : '') + '" data-pillar="' + esc(group.id) + '">' +
        '<button type="button" class="os-nav-group-btn" data-toggle-pillar="' + esc(group.id) + '">' +
          '<span>' + esc(group.label) + '</span>' +
          '<span class="os-nav-chevron">▸</span>' +
        '</button>' +
        '<div class="os-nav-group-items">' +
          items.map(item =>
            item.externalUrl
              ? '<a class="os-nav-btn" href="' + esc(item.externalUrl) + '" target="_blank" rel="noopener noreferrer" onclick="window.open(this.href, \'_blank\', \'noopener,noreferrer\'); return false;">' +
                  '<span>' + esc(item.title) + '</span>' +
                '</a>'
              : '<button type="button" class="os-nav-btn' + (STATE.activeView === item.key ? ' active' : '') + '" data-view="' + esc(item.key) + '">' +
                  '<span>' + esc(item.title) + '</span>' +
                '</button>'
          ).join('') +
        '</div>' +
      '</div>';
    };

    navHtml += pillarGroups.map(renderPillarGroupHtml).join('');

    if (adminNavItems.length) {
      navHtml +=
        '<div class="os-nav-divider"></div>' +
        renderPillarGroupHtml({ id: 'ADMIN', label: 'Admin' });
    }

    $('osNavList').innerHTML = navHtml;

    // Standort-Theme aktivieren (001 Karli = Dark Charcoal, 002 Prager = Izakaya Bordeaux)
    const activeStandortId = String(s.standortId || '001');
    document.body.dataset.standort = activeStandortId;
    const themeMeta = document.querySelector('meta[name="theme-color"]');
    if (themeMeta) {
      themeMeta.setAttribute('content', activeStandortId === '002' ? '#1E0D0E' : '#000000');
    }

    // Schlanke 3er Mobile Bottom-Bar: Startseite, Menü (Accordion-Drawer), Einstellungen (Zahnrad)
    const homeIconSvg = '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M3 10.5L12 3l9 7.5"/><path d="M5 9.5V20h14V9.5"/></svg>';
    const menuIconSvg = '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><line x1="4" y1="6" x2="20" y2="6"/><line x1="4" y1="12" x2="20" y2="12"/><line x1="4" y1="18" x2="20" y2="18"/></svg>';
    const gearIconSvg = '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 1 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 1 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 1 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9c.26.6.85 1 1.51 1H21a2 2 0 1 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"/></svg>';

    $('osMobileNav').innerHTML =
      '<button type="button" class="' + (STATE.activeView === 'overview' ? 'active' : '') + '" data-view="overview">' +
        '<span class="mnav-ico">' + homeIconSvg + '</span><span>Startseite</span>' +
      '</button>' +
      '<button type="button" id="btnOpenMobileMenuDrawer" data-mobile-drawer="1">' +
        '<span class="mnav-ico">' + menuIconSvg + '</span><span>Menü</span>' +
      '</button>' +
      '<button type="button" id="btnOpenMobileSettingsDrawer" data-mobile-settings="1">' +
        '<span class="mnav-ico">' + gearIconSvg + '</span><span>Einstellungen</span>' +
      '</button>';

    let drawerEl = document.getElementById('mobileMenuSheet');
    if (!drawerEl) {
      drawerEl = document.createElement('div');
      drawerEl.id = 'mobileMenuSheet';
      drawerEl.className = 'mobile-menu-sheet hidden';
      document.body.appendChild(drawerEl);
      drawerEl.addEventListener('click', ev => {
        if (ev.target === drawerEl || ev.target.closest('[data-close-mobile-drawer]')) {
          drawerEl.classList.add('hidden');
          return;
        }
        const accBtn = ev.target.closest('button[data-mobile-pillar]');
        if (accBtn) {
          const grp = accBtn.closest('.mobile-acc-group');
          const wasOpen = grp && grp.classList.contains('open');
          drawerEl.querySelectorAll('.mobile-acc-group.open').forEach(g => g.classList.remove('open'));
          if (grp && !wasOpen) grp.classList.add('open');
          return;
        }
        const extBtn = ev.target.closest('button[data-ext-url]');
        if (extBtn && extBtn.dataset.extUrl) {
          drawerEl.classList.add('hidden');
          window.open(extBtn.dataset.extUrl, '_blank', 'noopener,noreferrer');
          return;
        }
        const vBtn = ev.target.closest('button[data-view]');
        if (vBtn && vBtn.dataset.view) {
          drawerEl.classList.add('hidden');
          window.SonaApp.openView(vBtn.dataset.view);
        }
      });
    }

    const mobileGroups = pillarGroups.slice();
    if (adminNavItems.length) {
      mobileGroups.push({ id: 'ADMIN', label: 'Admin' });
    }
    const mobileGroupsHtml = mobileGroups.map(grp => {
      const grpItems = navItems.filter(it => it.pillar === grp.id);
      if (!grpItems.length) return '';
      const hasActive = grpItems.some(it => it.key === STATE.activeView);
      return '<div class="mobile-acc-group' + (hasActive ? ' open' : '') + '">' +
        '<button type="button" class="mobile-acc-header" data-mobile-pillar="' + esc(grp.id) + '">' +
          '<span>' + esc(grp.label) + '</span>' +
          '<span class="mobile-acc-caret">▸</span>' +
        '</button>' +
        '<div class="mobile-acc-body">' +
          grpItems.map(item =>
            item.externalUrl
              ? '<button type="button" class="mobile-menu-item" data-ext-url="' + esc(item.externalUrl) + '"><span>' + esc(item.title) + '</span><span>↗</span></button>'
              : '<button type="button" class="mobile-menu-item' + (STATE.activeView === item.key ? ' active' : '') + '" data-view="' + esc(item.key) + '"><span>' + esc(item.title) + '</span></button>'
          ).join('') +
        '</div>' +
      '</div>';
    }).join('');

    drawerEl.innerHTML =
      '<div class="mobile-menu-sheet-card">' +
        '<div class="card-head" style="margin-bottom:8px;">' +
          '<div><div class="kicker">Navigation · ' + esc(shortLocName(s.standortName)) + '</div><h3>Menü</h3></div>' +
          '<button type="button" class="btn btn-sm" data-close-mobile-drawer="1">Schließen</button>' +
        '</div>' +
        '<button type="button" class="mobile-menu-item' + (STATE.activeView === 'overview' ? ' active' : '') + '" data-view="overview" style="margin-bottom:8px;"><span>Startseite</span></button>' +
        '<div class="mobile-menu-acc-list">' + mobileGroupsHtml + '</div>' +
      '</div>';

    // Mobile Einstellungen Sheet (Standortwechsel, Support & Hilfe, Passwort, Abmelden)
    let settingsSheetEl = document.getElementById('mobileSettingsSheet');
    if (!settingsSheetEl) {
      settingsSheetEl = document.createElement('div');
      settingsSheetEl.id = 'mobileSettingsSheet';
      settingsSheetEl.className = 'mobile-menu-sheet hidden';
      document.body.appendChild(settingsSheetEl);
      settingsSheetEl.addEventListener('click', ev => {
        if (ev.target === settingsSheetEl || ev.target.closest('[data-close-mobile-settings]')) {
          settingsSheetEl.classList.add('hidden');
          return;
        }
        const locBtn = ev.target.closest('button[data-mobile-loc]');
        if (locBtn && locBtn.dataset.mobileLoc) {
          settingsSheetEl.classList.add('hidden');
          const sel = $('globalLocationSelect');
          if (sel && sel.value !== locBtn.dataset.mobileLoc) {
            sel.value = locBtn.dataset.mobileLoc;
            sel.dispatchEvent(new Event('change'));
          }
          return;
        }
        const actBtn = ev.target.closest('button[data-mobile-setting-act]');
        if (actBtn) {
          const act = actBtn.dataset.mobileSettingAct;
          settingsSheetEl.classList.add('hidden');
          if (act === 'install_pwa') {
            triggerPwaInstallFlow();
          } else if (act === 'support') {
            const b = $('btnOpenSupportHelp');
            if (b) b.click();
          } else if (act === 'pw') {
            const b = $('btnOpenChangePw');
            if (b) b.click();
          } else if (act === 'logout') {
            const b = $('btnLockLogout');
            if (b) b.click();
          }
        }
      });
    }
    const allowedLocsForMobile = s.locations || [{ id: s.standortId, name: s.standortName }];
    const mobileLocSwitchHtml = allowedLocsForMobile.length > 1
      ? '<div class="kicker" style="margin:6px 0 4px;">Standort wechseln</div>' +
        '<div class="mobile-settings-loc-row">' +
          allowedLocsForMobile.map(l =>
            '<button type="button" class="mobile-menu-item' + (l.id === s.standortId ? ' active' : '') + '" data-mobile-loc="' + esc(l.id) + '">' +
              '<span>' + esc(shortLocName(l.name)) + '</span><span style="font-size:11px;opacity:.75;">' + esc(l.id) + '</span>' +
            '</button>'
          ).join('') +
        '</div>'
      : '';

    const pwaInstalledNow = isPwaStandalone();
    const mobileInstallBtnHtml = pwaInstalledNow
      ? '<button type="button" class="mobile-menu-item" disabled style="opacity:0.6;cursor:default;"><span>✓ Bereits als App installiert</span></button>'
      : '<button type="button" class="mobile-menu-item" data-mobile-setting-act="install_pwa" style="border-color:rgba(245,236,215,0.34);color:var(--os-cream);"><span>App auf Gerät installieren</span><span>📲</span></button>';

    settingsSheetEl.innerHTML =
      '<div class="mobile-menu-sheet-card">' +
        '<div class="card-head" style="margin-bottom:8px;">' +
          '<div><div class="kicker">' + esc(s.user.role) + ' · ' + esc(shortLocName(s.standortName)) + '</div><h3>' + esc(s.user.name) + '</h3></div>' +
          '<button type="button" class="btn btn-sm" data-close-mobile-settings="1">Schließen</button>' +
        '</div>' +
        mobileLocSwitchHtml +
        '<div class="mobile-settings-stack">' +
          mobileInstallBtnHtml +
          '<button type="button" class="mobile-menu-item" data-mobile-setting-act="support"><span>Support &amp; Hilfe</span><span>?</span></button>' +
          '<button type="button" class="mobile-menu-item" data-mobile-setting-act="pw"><span>Passwort ändern</span></button>' +
          '<button type="button" class="mobile-menu-item" data-mobile-setting-act="logout" style="color:#f2b8b5;border-color:rgba(229,115,104,0.35);"><span>Abmelden</span></button>' +
        '</div>' +
      '</div>';

    syncPwaInstallButtons();

    const openDrawerBtn = document.getElementById('btnOpenMobileMenuDrawer');
    if (openDrawerBtn) {
      openDrawerBtn.addEventListener('click', ev => {
        ev.stopPropagation();
        settingsSheetEl.classList.add('hidden');
        drawerEl.classList.remove('hidden');
      });
    }
    const openSettingsBtn = document.getElementById('btnOpenMobileSettingsDrawer');
    if (openSettingsBtn) {
      openSettingsBtn.addEventListener('click', ev => {
        ev.stopPropagation();
        drawerEl.classList.add('hidden');
        settingsSheetEl.classList.remove('hidden');
      });
    }

    $('sidebarUserMeta').innerHTML =
      '<div style="font-weight:600;color:var(--os-cream);font-size:13px;">' + esc(s.user.name) + '</div>' +
      '<div style="font-size:11px;color:var(--os-silk);">' + esc(s.user.role) + '</div>';

    const locSelect = $('globalLocationSelect');
    const allowedLocs = s.locations || [{ id: s.standortId, name: s.standortName }];
    if (locSelect) {
      locSelect.innerHTML = allowedLocs.map(l =>
        '<option value="' + esc(l.id) + '"' + (l.id === s.standortId ? ' selected' : '') + '>' + esc(shortLocName(l.name)) + '</option>'
      ).join('');
      locSelect.disabled = allowedLocs.length <= 1;
    }

    const brandLocName = $('sidebarBrandLocName');
    const brandLocCaret = $('sidebarBrandLocCaret');
    const locMenu = $('locationSwitcherMenu');
    if (brandLocName) brandLocName.textContent = shortLocName(s.standortName);
    if (brandLocCaret) brandLocCaret.classList.toggle('hidden', allowedLocs.length <= 1);
    if (locMenu) {
      locMenu.classList.add('hidden');
      locMenu.innerHTML = allowedLocs.map(l =>
        '<button type="button" class="loc-switcher-item' + (l.id === s.standortId ? ' active' : '') + '" data-loc-id="' + esc(l.id) + '">' +
          '<span>' + esc(l.name) + '</span>' +
          '<span style="font-size:10px;opacity:0.75;">' + esc(l.id) + '</span>' +
        '</button>'
      ).join('');
    }

    renderActiveView();
    scheduleBackgroundWarmup(s);
    maybeStartFirstLoginTour(s);
    setTimeout(() => checkAndShowPendingDirectMessages(s), 250);
  }

  function getTourStorageKey(session) {
    const uid = (session && session.user && (session.user.id || session.user.email)) || 'default';
    return 'sona_os_tour_done_v1_' + String(uid).trim();
  }

  function maybeStartFirstLoginTour(session) {
    if (!session || !session.user) return;
    try {
      if (localStorage.getItem(getTourStorageKey(session)) === '1') return;
    } catch (e) {
      return;
    }
    setTimeout(() => {
      if (!STATE.session || document.getElementById('sonaOnboardingOverlay')) return;
      startOnboardingTour(false);
    }, 450);
  }

  function startOnboardingTour(forceStart) {
    const s = STATE.session;
    if (!s || !s.user) return;
    const existing = document.getElementById('sonaOnboardingOverlay');
    if (existing) existing.remove();
    const existingRing = document.getElementById('sonaTourSpotlight');
    if (existingRing) existingRing.remove();
    const existingPop = document.getElementById('sonaTourPopover');
    if (existingPop) existingPop.remove();

    if (STATE.activeView !== 'overview') {
      STATE.activeView = 'overview';
      renderActiveView();
    }

    const markDone = () => {
      try { localStorage.setItem(getTourStorageKey(s), '1'); } catch (e) {}
    };

    const cleanup = () => {
      ['sonaOnboardingOverlay', 'sonaTourSpotlight', 'sonaTourPopover'].forEach(id => {
        const el = document.getElementById(id);
        if (el) el.remove();
      });
      document.removeEventListener('keydown', onKey);
    };

    const finishTour = () => {
      markDone();
      cleanup();
    };

    const steps = [
      {
        selector: '.home-quick-toolbar',
        title: 'Schnellzugriff',
        text: 'Hier erfasst du Schwund, Bruch oder Reklamationen mit einem Klick – inklusive aktuellem Monatswert direkt darunter.'
      },
      {
        selector: '#homeQuickSearch',
        title: 'Schnellsuche',
        text: 'Tippe einfach ein Stichwort ein, um jedes Modul, jede Liste oder Aktion im gesamten System sofort zu öffnen.'
      },
      {
        selector: '.home-info-stack',
        title: 'Deine Startseite auf einen Blick',
        text: 'Dein täglicher Kompass: Routineaufgaben (Putzplan & To-Do mit Live-Fortschritt), aktuelle Team-Infos („Was gibt\'s Neues?“), 86-Liste und Team-Feedback.'
      },
      {
        selector: () => {
          const isMobile = window.innerWidth <= 900;
          return document.querySelector(isMobile ? '#osMobileNav' : '#osNavList');
        },
        title: 'Menü & Oberthemen',
        text: 'Hier findest du alle für dich freigegebenen Ebenen – von Operations über Warenwirtschaft bis Controlling – übersichtlich gegliedert.'
      },
      {
        selector: '#btnUserSettings',
        title: 'Einstellungen',
        text: 'Über das Zahnrad unten links kannst du jederzeit dein Passwort ändern, Support & Hilfe öffnen oder dich sicher abmelden.'
      },
      {
        selector: '#btnTopSupportHelp',
        title: 'Hilfe & Support',
        text: 'Fragen zur Bedienung oder ein Problem entdeckt? Hier findest du Anleitungen, Bedienungs-Videos, FAQs und den direkten Support mit Foto-Upload.'
      }
    ];

    let stepIdx = -1; // -1 = Extravagante Willkommenskarte

    const onKey = ev => {
      if (ev.key === 'Escape') {
        finishTour();
      } else if (ev.key === 'ArrowRight' && stepIdx >= 0) {
        if (stepIdx < steps.length - 1) showStep(stepIdx + 1);
        else finishTour();
      } else if (ev.key === 'ArrowLeft' && stepIdx > 0) {
        showStep(stepIdx - 1);
      }
    };
    document.addEventListener('keydown', onKey);

    const showWelcome = () => {
      cleanup();
      document.addEventListener('keydown', onKey);
      const wrap = document.createElement('div');
      wrap.id = 'sonaOnboardingOverlay';
      wrap.className = 'tour-backdrop';
      wrap.innerHTML =
        '<div class="tour-welcome-card" role="dialog" aria-modal="true" aria-label="Willkommen bei SONA OS">' +
          '<img class="tour-welcome-logo" src="./assets/sona-logo-transparent.png" alt="SONA">' +
          '<div class="tour-welcome-kicker">SONA OS · Operative System</div>' +
          '<h2 class="tour-welcome-title">Herzlich willkommen, ' + esc(s.user.name) + '!</h2>' +
          '<p class="tour-welcome-text">' +
            'Bereit für den nächsten Schritt? Alle operativen Listen, Tages-Briefings, 86-Status und Werkzeuge sind ab sofort an einem Ort – übersichtlich auf einen Blick.<br><br>' +
            '<b>Wir freuen uns auf deine Mitarbeit!</b>' +
          '</p>' +
          '<div class="tour-welcome-actions">' +
            '<button type="button" id="btnTourBegin" class="btn btn-primary" style="min-width:220px;height:44px;">Kurze Tour starten →</button>' +
            '<button type="button" id="btnTourSkip" class="btn-link" style="font-size:12px;">Direkt loslegen (überspringen)</button>' +
          '</div>' +
        '</div>';
      document.body.appendChild(wrap);
      $('btnTourBegin').addEventListener('click', () => showStep(0));
      $('btnTourSkip').addEventListener('click', finishTour);
    };

    const showStep = idx => {
      stepIdx = idx;
      cleanup();
      document.addEventListener('keydown', onKey);
      const st = steps[idx];
      const targetEl = typeof st.selector === 'function' ? st.selector() : document.querySelector(st.selector);
      let rect = null;
      if (targetEl) {
        try { targetEl.scrollIntoView({ behavior: 'smooth', block: 'center' }); } catch (e) {}
        const r = targetEl.getBoundingClientRect();
        if (r.width > 0 && r.height > 0) rect = r;
      }

      if (rect) {
        const ring = document.createElement('div');
        ring.id = 'sonaTourSpotlight';
        ring.className = 'tour-spotlight-ring';
        const pad = 6;
        ring.style.top = Math.max(4, rect.top - pad) + 'px';
        ring.style.left = Math.max(4, rect.left - pad) + 'px';
        ring.style.width = Math.min(window.innerWidth - 8, rect.width + pad * 2) + 'px';
        ring.style.height = Math.min(window.innerHeight - 8, rect.height + pad * 2) + 'px';
        document.body.appendChild(ring);
      } else {
        const bg = document.createElement('div');
        bg.id = 'sonaOnboardingOverlay';
        bg.className = 'tour-backdrop';
        document.body.appendChild(bg);
      }

      const pop = document.createElement('div');
      pop.id = 'sonaTourPopover';
      pop.className = 'tour-popover-card';
      const dotsHtml = steps.map((_, i) => '<span class="tour-step-dot' + (i <= idx ? ' active' : '') + '"></span>').join('');
      const isLast = idx === steps.length - 1;
      pop.innerHTML =
        '<div class="tour-step-dots">' + dotsHtml + '</div>' +
        '<div class="kicker" style="margin-bottom:4px;">Schritt ' + (idx + 1) + ' von ' + steps.length + '</div>' +
        '<h3 class="tour-popover-title">' + esc(st.title) + '</h3>' +
        '<p class="tour-popover-text">' + esc(st.text) + '</p>' +
        '<div class="tour-popover-footer">' +
          '<button type="button" id="btnTourClose" class="btn-link" style="font-size:12px;">Beenden</button>' +
          '<div style="display:flex;gap:8px;">' +
            (idx > 0 ? '<button type="button" id="btnTourPrev" class="btn btn-sm">Zurück</button>' : '') +
            '<button type="button" id="btnTourNext" class="btn btn-primary btn-sm">' + (isLast ? 'Los geht\'s!' : 'Weiter →') + '</button>' +
          '</div>' +
        '</div>';
      document.body.appendChild(pop);

      // Intelligente Positionierung (über/unter dem Highlight oder zentriert)
      const popRect = pop.getBoundingClientRect();
      let topPos = Math.round((window.innerHeight - popRect.height) / 2);
      let leftPos = Math.round((window.innerWidth - popRect.width) / 2);
      if (rect) {
        const spaceBelow = window.innerHeight - rect.bottom;
        const spaceAbove = rect.top;
        if (spaceBelow >= popRect.height + 24) {
          topPos = Math.round(rect.bottom + 14);
          leftPos = Math.round(Math.min(Math.max(14, rect.left), window.innerWidth - popRect.width - 14));
        } else if (spaceAbove >= popRect.height + 24) {
          topPos = Math.round(rect.top - popRect.height - 14);
          leftPos = Math.round(Math.min(Math.max(14, rect.left), window.innerWidth - popRect.width - 14));
        }
      }
      pop.style.top = Math.max(14, Math.min(window.innerHeight - popRect.height - 14, topPos)) + 'px';
      pop.style.left = Math.max(14, Math.min(window.innerWidth - popRect.width - 14, leftPos)) + 'px';

      $('btnTourClose').addEventListener('click', finishTour);
      if ($('btnTourPrev')) $('btnTourPrev').addEventListener('click', () => showStep(idx - 1));
      $('btnTourNext').addEventListener('click', () => {
        if (isLast) finishTour();
        else showStep(idx + 1);
      });
    };

    showWelcome();
  }

  async function preloadEmbeddedModule(mod) {
    const s = STATE.session;
    const hostEl = $('osModuleFrameHost');
    if (!s || !mod || !hostEl || mod.key === 'operations') return;
    // Module mit Einmal-SSO-Nonce (rezeptur, events) niemals im Hintergrund vorladen/cachen
    const launchUrl = buildDirectEmbeddedUrl(mod, s);
    if (!launchUrl) return;
    const frameKey = String(s.standortId || '001') + ':' + String(mod.key);
    if (STATE.moduleFrames[frameKey] || PRELOAD_STATE.inFlight[frameKey]) return;

    PRELOAD_STATE.inFlight[frameKey] = true;
    try {
      if (!STATE.session || STATE.session.standortId !== s.standortId) return;
      if (STATE.moduleFrames[frameKey]) return;

      const iframe = document.createElement('iframe');
      iframe.className = 'os-module-frame hidden';
      iframe.title = mod.title;
      iframe.setAttribute('allow', 'clipboard-read; clipboard-write; fullscreen');
      iframe.src = launchUrl;
      STATE.moduleFrames[frameKey] = iframe;
      hostEl.appendChild(iframe);
    } catch (e) {
      // Stilles Preloading darf die UI nie stören
    } finally {
      delete PRELOAD_STATE.inFlight[frameKey];
    }
  }

  function prefetchView(viewKey) {
    const s = STATE.session;
    if (!s || !viewKey || viewKey === STATE.activeView) return;
    if (viewKey.indexOf('ops_') === 0) {
      if (window.SonaOperationsModule && window.SonaOperationsModule.prefetch) {
        window.SonaOperationsModule.prefetch(s, viewKey);
      }
      return;
    }
    if (viewKey.indexOf('mod_') === 0) {
      const modKey = viewKey.slice(4);
      const mod = (s.ecosystemModules || []).find(m => m.key === modKey);
      if (mod && mod.key !== 'operations') {
        preloadEmbeddedModule(mod);
      }
      return;
    }
    if (viewKey === 'rbac' && s.permissions && s.permissions.adminMatrix) {
      const cached = ADMIN_CACHE.rbac;
      if (!cached || (Date.now() - cached.ts) > ADMIN_CACHE_FRESH_MS) {
        window.SonaApi.getRbacMatrix().then(res => {
          if (res && res.success) ADMIN_CACHE.rbac = { ts: Date.now(), data: res };
        }).catch(() => {});
      }
    }
  }

  function scheduleBackgroundWarmup(session) {
    if (!session || !session.user) return;
    const warmKey = String(session.user.id || '') + ':' + String(session.standortId || '');
    if (PRELOAD_STATE.warmedKey === warmKey) return;
    clearWarmupTimers();
    PRELOAD_STATE.warmedKey = warmKey;

    const mods = session.ecosystemModules || [];
    if (window.SonaOperationsModule && window.SonaOperationsModule.prefetch) {
      PRELOAD_STATE.timers.push(setTimeout(() => {
        if (!STATE.session || STATE.session.standortId !== session.standortId) return;
        window.SonaOperationsModule.prefetch(STATE.session, 'ops_tagesuebersicht');
        window.SonaOperationsModule.prefetch(STATE.session, 'ops_86');
        window.SonaOperationsModule.prefetch(STATE.session, 'ops_feedback');
        if (mods.some(m => m.key === 'operations')) {
          window.SonaOperationsModule.prefetch(STATE.session, 'ops_todo');
          window.SonaOperationsModule.prefetch(STATE.session, 'ops_putzplan');
          window.SonaOperationsModule.prefetch(STATE.session, 'ops_auswertung');
        }
      }, 200));
    }

    const iframeMods = mods.filter(m => m.key !== 'operations' && !!buildDirectEmbeddedUrl(m, session));
    iframeMods.forEach((mod, idx) => {
      PRELOAD_STATE.timers.push(setTimeout(() => {
        if (!STATE.session || STATE.session.standortId !== session.standortId) return;
        preloadEmbeddedModule(mod);
      }, 450 + idx * 550));
    });
  }

  function showMainContentPane() {
    const mainEl = $('osMainContent');
    const hostEl = $('osModuleFrameHost');
    if (hostEl) {
      hostEl.classList.add('hidden');
      Object.keys(STATE.moduleFrames).forEach(k => {
        if (STATE.moduleFrames[k]) STATE.moduleFrames[k].classList.add('hidden');
      });
    }
    if (mainEl) {
      mainEl.classList.remove('hidden');
      mainEl.classList.remove('os-content-fullbleed');
    }
    window.SonaLoader.hide();
  }

  function buildDirectEmbeddedUrl(mod, s) {
    if (!mod || !mod.legacyUrl || mod.key === 'rezeptur' || mod.key === 'events') return '';
    const loc = encodeURIComponent(s.standortId || '001');
    const sep = mod.legacyUrl.indexOf('?') === -1 ? '?' : '&';
    let url = mod.legacyUrl + sep + 'standortId=' + loc + '&loc=' + loc + '&embedded=1';
    const tabPerms = s.permissions && s.permissions.tabPermissions;
    if (mod.key === 'einkauf' && tabPerms && Array.isArray(tabPerms.einkauf)) {
      url += '&tabs=' + encodeURIComponent(tabPerms.einkauf.join(','));
    }
    return url;
  }

  function renderActiveView() {
    const s = STATE.session;
    if (!s) return;

    document.querySelectorAll('#osNavList .os-nav-btn, #osMobileNav button').forEach(btn => {
      btn.classList.toggle('active', btn.dataset.view === STATE.activeView);
    });

    if (STATE.activeView === 'overview') {
      showMainContentPane();
      renderOverview();
      return;
    }
    if (STATE.activeView === 'support_help') {
      showMainContentPane();
      renderSupportHelpView();
      return;
    }
    if (STATE.activeView === 'ww_auswertung') {
      const wwGrp = document.querySelector('#osNavList .os-nav-group[data-pillar="WARENWIRTSCHAFT"]');
      if (wwGrp) {
        wwGrp.classList.add('open');
        STATE.openPillars.WARENWIRTSCHAFT = true;
      }
      showMainContentPane();
      const container = $('osMainContent');
      if (container && window.SonaOperationsModule && window.SonaOperationsModule.renderAuswertungInto) {
        container.innerHTML = '<div id="wwAuswertungSlot"></div>';
        window.SonaOperationsModule.renderAuswertungInto($('wwAuswertungSlot'), s);
      }
      return;
    }
    if ((STATE.activeView === 'rbac' && hasAdminTab(s, 'rbac')) ||
        (STATE.activeView === 'audit_log' && hasAdminTab(s, 'audit_log')) ||
        (STATE.activeView === 'rundmail' && hasAdminTab(s, 'rundmail')) ||
        (STATE.activeView === 'quellen' && hasAdminTab(s, 'quellen')) ||
        (STATE.activeView === 'direktnachricht' && hasAdminTab(s, 'direktnachricht'))) {
      const adminGrp = document.querySelector('#osNavList .os-nav-group[data-pillar="ADMIN"]');
      if (adminGrp) {
        adminGrp.classList.add('open');
        STATE.openPillars.ADMIN = true;
      }
      showMainContentPane();
      if (STATE.activeView === 'audit_log') {
        renderAuditLogView();
      } else if (STATE.activeView === 'rundmail') {
        renderRundmailView();
      } else if (STATE.activeView === 'quellen') {
        renderAdminSourcesView();
      } else if (STATE.activeView === 'direktnachricht') {
        renderDirectMessagesAdminView();
      } else {
        renderRbacMatrixView();
      }
      return;
    }
    if (STATE.activeView.indexOf('ops_') === 0) {
      const opsMod = (s.ecosystemModules || []).find(m => m.key === 'operations');
      if (opsMod && window.SonaOperationsModule) {
        const grp = document.querySelector('#osNavList .os-nav-group[data-pillar="OPERATIONS"]');
        if (grp) {
          grp.classList.add('open');
          STATE.openPillars.OPERATIONS = true;
        }
        showMainContentPane();
        window.SonaOperationsModule.mount(s, opsMod, STATE.activeView.slice(4));
        return;
      }
    }
    if (STATE.activeView.indexOf('mod_') === 0) {
      const modKey = STATE.activeView.slice(4);
      const mod = (s.ecosystemModules || []).find(m => m.key === modKey);
      if (mod) {
        const grp = document.querySelector('#osNavList .os-nav-group[data-pillar="' + (mod.pillar || 'WARENWIRTSCHAFT') + '"]');
        if (grp) {
          grp.classList.add('open');
          STATE.openPillars[mod.pillar || 'WARENWIRTSCHAFT'] = true;
        }
        if (mod.key === 'operations' && window.SonaOperationsModule) {
          showMainContentPane();
          window.SonaOperationsModule.mount(s, mod, 'home');
        } else {
          renderEmbeddedModuleView(mod);
        }
        return;
      }
    }

    STATE.activeView = 'overview';
    showMainContentPane();
    renderOverview();
  }

  async function renderEmbeddedModuleView(mod) {
    const s = STATE.session;
    const container = $('osMainContent');
    const hostEl = $('osModuleFrameHost');
    if (!container || !hostEl || !s) return;

    const frameKey = String(s.standortId || '001') + ':' + String(mod.key);
    const existingFrame = STATE.moduleFrames[frameKey];

    // Keep-Alive Iframe Pool: Bereits geladene Module sofort (0 ms) einblenden
    if (existingFrame && existingFrame.parentNode === hostEl) {
      container.classList.add('hidden');
      hostEl.classList.remove('hidden');
      Object.keys(STATE.moduleFrames).forEach(k => {
        if (STATE.moduleFrames[k]) {
          STATE.moduleFrames[k].classList.toggle('hidden', k !== frameKey);
        }
      });
      return;
    }

    window.SonaLoader.show(250);

    try {
      let launchUrl = buildDirectEmbeddedUrl(mod, s);
      if (!launchUrl) {
        const res = await window.SonaApi.getModuleLaunchUrl(mod.key, s.standortId);
        if (STATE.activeView !== 'mod_' + mod.key) {
          window.SonaLoader.hide();
          return;
        }
        if (!res || !res.success || !res.launchUrl) {
          showMainContentPane();
          container.innerHTML =
            '<div class="card">' +
              '<h3>' + esc(mod.title) + ' konnte nicht gestartet werden</h3>' +
              '<p class="module-desc">' + esc((res && res.error) || 'Zugriff verweigert oder Verbindungsfehler.') + '</p>' +
            '</div>';
          window.SonaLoader.hide();
          return;
        }
        launchUrl = res.launchUrl;
      }

      if (STATE.activeView !== 'mod_' + mod.key) {
        window.SonaLoader.hide();
        return;
      }

      const iframe = document.createElement('iframe');
      iframe.className = 'os-module-frame';
      iframe.title = mod.title;
      iframe.setAttribute('allow', 'clipboard-read; clipboard-write; fullscreen');
      iframe.addEventListener('load', () => window.SonaLoader.hide());
      iframe.src = launchUrl;

      STATE.moduleFrames[frameKey] = iframe;
      Object.keys(STATE.moduleFrames).forEach(k => {
        if (STATE.moduleFrames[k]) {
          STATE.moduleFrames[k].classList.toggle('hidden', k !== frameKey);
        }
      });
      hostEl.appendChild(iframe);
      container.classList.add('hidden');
      hostEl.classList.remove('hidden');
      setTimeout(() => window.SonaLoader.hide(), 2500);
    } catch (err) {
      if (STATE.activeView !== 'mod_' + mod.key) {
        window.SonaLoader.hide();
        return;
      }
      showMainContentPane();
      container.innerHTML =
        '<div class="card">' +
          '<h3>Verbindungsfehler</h3>' +
          '<p class="module-desc">' + esc(err && err.message ? err.message : String(err)) + '</p>' +
        '</div>';
      window.SonaLoader.hide();
    }
  }

  function buildQuickOpsUrl(rawUrl, session) {
    if (!rawUrl) return '';
    const params = [];
    const userName = (session && session.user && session.user.name) ? String(session.user.name).trim() : '';
    const standortId = (session && session.standortId) ? String(session.standortId).trim() : '';
    if (userName) params.push('user=' + encodeURIComponent(userName));
    if (standortId) params.push('standort=' + encodeURIComponent(standortId));
    if (!params.length) return rawUrl;
    return rawUrl + (rawUrl.indexOf('?') === -1 ? '?' : '&') + params.join('&');
  }

  async function hydrateHomeResmioToday(session) {
    const box = $('homeResmioBox');
    const valEl = $('homeResmioValue');
    if (!box || !valEl || !session || !session.standortId || !window.SonaApi || !window.SonaApi.getOpsResmioToday) {
      return;
    }
    const locId = String(session.standortId);
    const todayKey = new Date().toISOString().slice(0, 10);
    const cacheKey = 'sona_os_resmio_' + locId + '_' + todayKey;

    const applySummary = function(data) {
      if (!data || !data.success || !data.configured) {
        box.classList.add('hidden');
        return;
      }
      const resCount = Number(data.reservations || 0);
      const guestCount = Number(data.guests || 0);
      valEl.textContent = resCount + ' Res. · ' + guestCount + ' Pers.';
      box.title = 'Heute: ' + resCount + ' Reservierungen, ' + guestCount + ' Personen';
      box.classList.remove('hidden');
    };

    try {
      const cachedRaw = sessionStorage.getItem(cacheKey);
      if (cachedRaw) {
        const parsed = JSON.parse(cachedRaw);
        if (parsed && parsed.ts && (Date.now() - parsed.ts < 120000) && parsed.data) {
          applySummary(parsed.data);
          return;
        }
      }
    } catch (e) {}

    try {
      const res = await window.SonaApi.getOpsResmioToday(locId);
      if (STATE.session && String(STATE.session.standortId) !== locId) return;
      applySummary(res);
      if (res && res.success) {
        try {
          sessionStorage.setItem(cacheKey, JSON.stringify({ ts: Date.now(), data: res }));
        } catch (eStore) {}
      }
    } catch (e) {}
  }

  function renderOverview() {
    const s = STATE.session;
    const mods = s.ecosystemModules || [];
    const container = $('osMainContent');
    const perms = (s && s.permissions) || {};
    const opTabs = (perms.tabPermissions && perms.tabPermissions.operations !== undefined)
      ? perms.tabPermissions.operations
      : 'ALL';
    const opsMod = mods.find(m => m.key === 'operations');
    const hasOpTab = id => opTabs === 'ALL' || (Array.isArray(opTabs) && opTabs.indexOf(id) !== -1);
    const schwundUrl = (opsMod && opsMod.schwundUrl) ? buildQuickOpsUrl(opsMod.schwundUrl, s) : '';
    const bruchUrl = (opsMod && opsMod.bruchUrl) ? buildQuickOpsUrl(opsMod.bruchUrl, s) : '';
    const canSchwund = !!(schwundUrl && hasOpTab('schwund_eingabe'));
    const canBruch = !!(bruchUrl && hasOpTab('bruch_eingabe'));
    const canReklamation = !!(opsMod && hasOpTab('reklamation'));
    const canPutzplan = !!(opsMod && hasOpTab('putzplan'));
    const canTodo = !!(opsMod && hasOpTab('todo'));
    const canNews = !!(opsMod && hasOpTab('tagesuebersicht'));
    const can86 = !!(opsMod && hasOpTab('liste86'));
    const canFeedback = !!(opsMod && hasOpTab('feedback'));
    const canRanking = !!(opsMod && hasOpTab('mitarbeiterbewertung'));
    const lvl = String(perms.accessLevel || '').toUpperCase();
    const role = String((s.user && s.user.role) || '').toUpperCase();
    const canManageNews = !!(canNews && (opTabs === 'ALL' ? (lvl === 'ADMIN' || lvl === 'WRITE' || perms.adminMatrix || ['ADMIN', 'FB_MANAGER', 'SERVICELEITUNG', 'SERVICECHEF', 'KUECHENCHEF', 'BARCHEF'].indexOf(role) !== -1) : hasOpTab('news_erstellen')));

    const quickOpsHtml =
      (canSchwund
        ? '<button type="button" class="btn btn-sm home-quick-ops-btn home-quick-kpi-btn" data-quick-url="' + esc(schwundUrl) + '" title="Schwund im neuen Tab erfassen">' +
            '<span class="home-quick-kpi-label">+ Schwund</span>' +
            '<span id="homeQuickSchwundVal" class="home-quick-kpi-val tabular"></span>' +
          '</button>'
        : '') +
      (canBruch
        ? '<button type="button" class="btn btn-sm home-quick-ops-btn home-quick-kpi-btn" data-quick-url="' + esc(bruchUrl) + '" title="Bruch im neuen Tab erfassen">' +
            '<span class="home-quick-kpi-label">+ Bruch</span>' +
            '<span id="homeQuickBruchVal" class="home-quick-kpi-val tabular"></span>' +
          '</button>'
        : '') +
      (canReklamation
        ? '<button type="button" class="btn btn-sm home-quick-view-btn home-quick-kpi-btn" data-quick-view="ops_reklamation" title="Reklamation oder Beschwerde erfassen">' +
            '<span class="home-quick-kpi-label">+ Beschwerde</span>' +
          '</button>'
        : '');

    const hr = new Date().getHours();
    const greetingPrefix = hr < 11 ? 'Guten Morgen' : (hr < 18 ? 'Guten Tag' : 'Guten Abend');

    const routineLinksHtml =
      (canPutzplan
        ? '<button type="button" id="homeRoutinePutzCard" class="home-routine-link home-quick-view-btn" data-quick-view="ops_putzplan">' +
            '<div>' +
              '<div class="home-routine-link-title">Putzplan</div>' +
              '<div class="home-routine-link-sub">Tägliche &amp; wöchentliche Reinigung</div>' +
              '<span id="homeRoutinePutzProgress" class="routine-mini-status"></span>' +
            '</div>' +
            '<span>→</span>' +
            '<div class="routine-progress-track"><div class="routine-progress-fill"></div></div>' +
          '</button>'
        : '') +
      (canTodo
        ? '<button type="button" id="homeRoutineTodoCard" class="home-routine-link home-quick-view-btn" data-quick-view="ops_todo">' +
            '<div>' +
              '<div class="home-routine-link-title">To-Do-Liste</div>' +
              '<div class="home-routine-link-sub">Checkliste für Früh- &amp; Spätschicht</div>' +
              '<span id="homeRoutineTodoProgress" class="routine-mini-status"></span>' +
            '</div>' +
            '<span>→</span>' +
            '<div class="routine-progress-track"><div class="routine-progress-fill"></div></div>' +
          '</button>'
        : '');

    const routineSectionHtml = routineLinksHtml
      ? '<section class="home-section-card">' +
          '<div class="card-head home-routine-head" style="margin-bottom:2px;">' +
            '<div>' +
              '<div class="kicker">Tägliche Routine</div>' +
              '<h3>Routineaufgaben</h3>' +
            '</div>' +
            '<div id="homeResmioBox" class="home-resmio-box hidden" aria-live="polite" title="Tagesaktuelle Reservierungen">' +
              '<span class="home-resmio-icon" aria-hidden="true">📅</span>' +
              '<div class="home-resmio-meta">' +
                '<div class="home-resmio-label">Heute · Reservierungen</div>' +
                '<div id="homeResmioValue" class="home-resmio-value tabular">—</div>' +
              '</div>' +
            '</div>' +
          '</div>' +
          '<div class="home-routine-links">' + routineLinksHtml + '</div>' +
        '</section>'
      : '';

    const newsSectionHtml = canNews
      ? '<section class="home-section-card">' +
          '<div class="card-head" style="margin-bottom:4px;">' +
            '<div><div class="kicker">Team-Briefing &amp; Dokumente</div><h3>Was gibt\'s Neues?</h3></div>' +
            (canManageNews
              ? '<button type="button" class="btn btn-sm home-quick-view-btn" data-quick-view="ops_tagesuebersicht">+ Info</button>'
              : '') +
          '</div>' +
          '<div id="homeNewsBoardSlot"></div>' +
        '</section>'
      : '';

    const list86SectionHtml = can86
      ? '<section class="home-section-card home-section-86">' +
          '<div class="card-head" style="margin-bottom:4px;">' +
            '<div>' +
              '<div class="kicker">Aktuell nicht verfügbar</div>' +
              '<h3>86-Liste</h3>' +
            '</div>' +
            '<button type="button" class="btn btn-sm home-quick-view-btn" data-quick-view="ops_86">+ 86</button>' +
          '</div>' +
          '<div id="home86BoardSlot"></div>' +
        '</section>'
      : '';

    const bentoGridHtml = (newsSectionHtml || list86SectionHtml)
      ? '<div class="home-bento-grid">' + newsSectionHtml + list86SectionHtml + '</div>'
      : '';

    const feedbackSectionHtml = canFeedback
      ? '<section class="home-section-card">' +
          '<div class="card-head" style="margin-bottom:4px;">' +
            '<div>' +
              '<div class="kicker">Team-Austausch &amp; Ideen (7 Tage sichtbar)</div>' +
              '<h3>Feedback</h3>' +
            '</div>' +
            '<button type="button" class="btn btn-sm home-quick-view-btn" data-quick-view="ops_feedback">+ Feedback geben</button>' +
          '</div>' +
          '<div id="homeFeedbackBoardSlot"></div>' +
        '</section>'
      : '';

    const hasAnyHomeSection = !!(routineSectionHtml || bentoGridHtml || feedbackSectionHtml);
    const fallbackHomeHtml = !hasAnyHomeSection
      ? '<section class="home-section-card">' +
          '<div class="kicker">Freigegebene Bereiche</div>' +
          '<h3 style="margin-top:4px;">Deine Übersicht</h3>' +
          '<p class="module-desc" style="margin-top:6px;">Wähle links im Menü (bzw. unten über „Menü“) einen deiner freigegebenen Bereiche aus.</p>' +
        '</section>'
      : '';

    container.innerHTML =
      '<div class="os-home-greeting">' +
        '<h2>' + esc(greetingPrefix) + ', ' + esc(s.user.name) + '</h2>' +
        '<div class="home-quick-toolbar">' +
          '<div class="home-search-wrap">' +
            '<input type="search" id="homeQuickSearch" class="input-control home-search-input" placeholder="Schnellsuche …" autocomplete="off">' +
            '<div id="homeSearchResults" class="home-search-results hidden"></div>' +
          '</div>' +
          quickOpsHtml +
        '</div>' +
      '</div>' +
      '<div class="home-info-stack">' +
        routineSectionHtml +
        bentoGridHtml +
        feedbackSectionHtml +
        fallbackHomeHtml +
      '</div>';

    if (window.SonaOperationsModule) {
      if ((canPutzplan || canTodo) && window.SonaOperationsModule.hydrateRoutineProgress) {
        window.SonaOperationsModule.hydrateRoutineProgress(s);
      }
      if (routineSectionHtml) {
        hydrateHomeResmioToday(s);
      }
      if (canNews && window.SonaOperationsModule.renderNewsBoardInto) {
        window.SonaOperationsModule.renderNewsBoardInto($('homeNewsBoardSlot'), s, false);
      }
      if (can86 && window.SonaOperationsModule.render86BoardInto) {
        window.SonaOperationsModule.render86BoardInto($('home86BoardSlot'), s, false);
      }
      if (canFeedback && window.SonaOperationsModule.renderFeedbackBoardInto) {
        window.SonaOperationsModule.renderFeedbackBoardInto($('homeFeedbackBoardSlot'), s, false);
      }
    }

    container.querySelectorAll('.home-quick-ops-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        if (btn.dataset.quickUrl) {
          window.open(btn.dataset.quickUrl, '_blank', 'noopener,noreferrer');
        }
      });
    });
    container.querySelectorAll('.home-quick-view-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        if (btn.dataset.quickView) {
          window.SonaApp.openView(btn.dataset.quickView);
        }
      });
    });

    // Schnellsuche über alle freigegebenen Module, Bereiche & Aktionen
    const searchItems = [];
    mods.filter(m => m.key !== 'operations').forEach(m => {
      searchItems.push({
        label: m.title,
        meta: m.pillarTitle || 'Modul',
        keywords: (m.title + ' ' + (m.subtitle || '') + ' ' + m.key).toLowerCase(),
        run: () => window.SonaApp.openView('mod_' + m.key)
      });
    });
    if (canNews) searchItems.push({ label: 'Tagesübersicht & Infos', meta: 'Operations', keywords: 'tagesuebersicht news info briefing dokumente', run: () => window.SonaApp.openView('ops_tagesuebersicht') });
    if (canReklamation) searchItems.push({ label: 'Reklamation und Beschwerden', meta: 'Operations', keywords: 'reklamation beschwerde gaeste', run: () => window.SonaApp.openView('ops_reklamation') });
    if (canTodo) searchItems.push({ label: 'To-Do-Liste', meta: 'Operations', keywords: 'todo aufgaben checkliste schicht', run: () => window.SonaApp.openView('ops_todo') });
    if (canPutzplan) searchItems.push({ label: 'Putzplan', meta: 'Operations', keywords: 'putzplan reinigung sauberkeit', run: () => window.SonaApp.openView('ops_putzplan') });
    if (canRanking) searchItems.push({ label: 'Mitarbeiter Ranking', meta: 'Operations', keywords: 'mitarbeiter ranking scorecard azubi bewertung', run: () => window.SonaApp.openView('ops_ranking') });
    if (can86) searchItems.push({ label: '86-Liste', meta: 'Operations', keywords: '86 liste ausverkauft nicht verfuegbar', run: () => window.SonaApp.openView('ops_86') });
    if (canFeedback) searchItems.push({ label: 'Feedback & Ideen', meta: 'Operations', keywords: 'feedback ideen team', run: () => window.SonaApp.openView('ops_feedback') });
    if (canSchwund) {
      searchItems.push({
        label: '+ Schwund erfassen (Neuer Tab)',
        meta: 'Operations',
        keywords: 'schwund verderb eingabe operations verlust',
        run: () => window.open(schwundUrl, '_blank', 'noopener,noreferrer')
      });
    }
    if (canBruch) {
      searchItems.push({
        label: '+ Bruch erfassen (Neuer Tab)',
        meta: 'Operations',
        keywords: 'bruch glas geschirr eingabe operations',
        run: () => window.open(bruchUrl, '_blank', 'noopener,noreferrer')
      });
    }
    if (hasAdminTab(s, 'rbac')) {
      searchItems.push({
        label: 'Rechte-Matrix & Mitarbeiter',
        meta: 'Admin',
        keywords: 'rechte matrix mitarbeiter benutzer admin anfragen gmail passwort',
        run: () => window.SonaApp.openView('rbac')
      });
    }
    if (hasAdminTab(s, 'audit_log')) {
      searchItems.push({
        label: 'Aktivitätsprotokoll (Audit-Log)',
        meta: 'Admin',
        keywords: 'protokoll audit log historie wer eingetragen aktivitaet verlauf email',
        run: () => window.SonaApp.openView('audit_log')
      });
    }
    if (hasAdminTab(s, 'rundmail')) {
      searchItems.push({
        label: 'Rundmail an Mitarbeiter',
        meta: 'Admin',
        keywords: 'rundmail email nachricht mitarbeiter',
        run: () => window.SonaApp.openView('rundmail')
      });
    }
    if (hasAdminTab(s, 'quellen')) {
      searchItems.push({
        label: 'Quellen (Verknüpfte Google Sheets)',
        meta: 'Admin',
        keywords: 'quellen sheets google sheet id tabellen links datenbank ordner drive',
        run: () => window.SonaApp.openView('quellen')
      });
    }
    if (hasAdminTab(s, 'direktnachricht')) {
      searchItems.push({
        label: 'Direktnachrichten (Pflicht-Popup)',
        meta: 'Admin',
        keywords: 'direktnachricht taggen mitteilung pflicht popup user nachricht bild datei',
        run: () => window.SonaApp.openView('direktnachricht')
      });
    }

    const searchInput = $('homeQuickSearch');
    const resultsBox = $('homeSearchResults');
    if (searchInput && resultsBox) {
      let currentMatches = [];
      const renderMatches = q => {
        const clean = String(q || '').trim().toLowerCase();
        if (!clean) {
          currentMatches = [];
          resultsBox.classList.add('hidden');
          resultsBox.innerHTML = '';
          return;
        }
        currentMatches = searchItems.filter(it => it.keywords.indexOf(clean) !== -1 || it.label.toLowerCase().indexOf(clean) !== -1);
        if (!currentMatches.length) {
          resultsBox.innerHTML = '<div style="padding:8px 10px;font-size:12px;color:var(--os-silk);">Keine Treffer für „' + esc(q) + '“</div>';
          resultsBox.classList.remove('hidden');
          return;
        }
        resultsBox.innerHTML = currentMatches.map((it, i) =>
          '<button type="button" class="home-search-item" data-sidx="' + i + '">' +
            '<span>' + esc(it.label) + '</span>' +
            '<small>' + esc(it.meta) + '</small>' +
          '</button>'
        ).join('');
        resultsBox.classList.remove('hidden');
        resultsBox.querySelectorAll('.home-search-item').forEach(btn => {
          btn.addEventListener('click', () => {
            const picked = currentMatches[parseInt(btn.dataset.sidx, 10)];
            resultsBox.classList.add('hidden');
            searchInput.value = '';
            if (picked && picked.run) picked.run();
          });
        });
      };

      searchInput.addEventListener('input', () => renderMatches(searchInput.value));
      searchInput.addEventListener('keydown', ev => {
        if (ev.key === 'Enter' && currentMatches.length) {
          ev.preventDefault();
          const first = currentMatches[0];
          resultsBox.classList.add('hidden');
          searchInput.value = '';
          if (first && first.run) first.run();
        } else if (ev.key === 'Escape') {
          resultsBox.classList.add('hidden');
        }
      });
    }
  }

  function renderModuleBridgeView(mod) {
    const s = STATE.session;
    $('osMainContent').innerHTML =
      '<div class="card">' +
        '<div class="card-head">' +
          '<div>' +
            '<div class="kicker">' + esc(mod.ebene) + ' · Autorisiert für ' + esc(s.standortName) + ' (' + esc(s.standortId) + ')</div>' +
            '<h3>' + esc(mod.title) + '</h3>' +
          '</div>' +
          '<span class="badge badge-info">' + esc(mod.phase) + '</span>' +
        '</div>' +
        '<p class="module-desc" style="margin-bottom:16px;">' + esc(mod.subtitle) + '</p>' +
        '<p class="module-desc" style="margin-bottom:18px;">Die Zugriffs- und Standortprüfung in SONA OS ist für dieses Modul bereits aktiv. Während die nativen JSON-Oberflächen in den nächsten Phasen hier direkt eingezogen werden, öffnet der Button unten weiterhin direkt das produktive Modul.</p>' +
        '<div style="display:flex;gap:10px;flex-wrap:wrap;">' +
          '<a class="btn btn-primary" href="' + esc(mod.legacyUrl) + '" target="_blank" rel="noopener">Produktive Ebene öffnen ↗</a>' +
          '<button type="button" class="btn" onclick="window.SonaApp.openView(\'overview\')">Zurück zur Übersicht</button>' +
        '</div>' +
      '</div>';
  }

  function renderTabPermissionBox(prefix, modKey, title, catalog, currentVal) {
    const isAll = !Array.isArray(currentVal);
    const list = Array.isArray(currentVal) ? currentVal : catalog.map(t => t.id);
    return '<div class="rbac-tabs-box" data-tabmod="' + esc(modKey) + '">' +
      '<div class="rbac-tabs-box-head">' +
        '<b>' + esc(title) + '</b>' +
        '<label style="font-size:11.5px;color:var(--os-cream);display:inline-flex;align-items:center;gap:6px;cursor:pointer;">' +
          '<input type="checkbox" class="rbac-tab-all" data-idx="' + esc(prefix) + '" data-tabmod="' + esc(modKey) + '"' + (isAll ? ' checked' : '') + '> Gesamtfreigabe (Alle Tabs)' +
        '</label>' +
      '</div>' +
      '<div class="rbac-tab-chips' + (isAll ? ' disabled' : '') + '">' +
        catalog.map(t =>
          '<label class="rbac-tab-chip">' +
            '<input type="checkbox" class="rbac-tab-item" data-tabmod="' + esc(modKey) + '" value="' + esc(t.id) + '"' + (list.indexOf(t.id) !== -1 ? ' checked' : '') + '>' +
            '<span>' + esc(t.label) + '</span>' +
          '</label>'
        ).join('') +
      '</div>' +
    '</div>';
  }

  function syncModuleTabBox(tabsRoot, modKey, enabled, defaultAllOnEnable) {
    if (!tabsRoot) return;
    const box = tabsRoot.querySelector('.rbac-tabs-box[data-tabmod="' + modKey + '"]');
    if (!box) return;
    const allChk = box.querySelector('.rbac-tab-all');
    const chips = box.querySelector('.rbac-tab-chips');
    const items = box.querySelectorAll('.rbac-tab-item');
    box.classList.remove('hidden');
    if (!enabled) {
      box.classList.add('rbac-tabs-box-inactive');
      if (allChk) allChk.checked = false;
      if (chips) chips.classList.remove('disabled');
      items.forEach(c => { c.checked = false; });
      return;
    }
    box.classList.remove('rbac-tabs-box-inactive');
    if (defaultAllOnEnable) {
      const hasAny = (allChk && allChk.checked) || Array.from(items).some(c => c.checked);
      if (!hasAny) {
        if (allChk) allChk.checked = true;
        if (chips) chips.classList.add('disabled');
        items.forEach(c => { c.checked = true; });
      }
    }
  }

  function wireTabBoxToggleEvents(rootEl, resolveModCheckbox) {
    if (!rootEl) return;
    rootEl.querySelectorAll('.rbac-tab-all').forEach(chk => {
      chk.addEventListener('change', () => {
        const box = chk.closest('.rbac-tabs-box');
        const modKey = chk.dataset.tabmod || (box && box.dataset.tabmod) || '';
        const chips = box && box.querySelector('.rbac-tab-chips');
        if (chips) chips.classList.toggle('disabled', chk.checked);
        if (chk.checked && box) {
          box.classList.remove('rbac-tabs-box-inactive');
          box.querySelectorAll('.rbac-tab-item').forEach(c => { c.checked = true; });
          const modChk = typeof resolveModCheckbox === 'function' ? resolveModCheckbox(box, modKey) : null;
          if (modChk && !modChk.checked) modChk.checked = true;
        }
      });
    });
    rootEl.querySelectorAll('.rbac-tab-item').forEach(itemChk => {
      itemChk.addEventListener('change', () => {
        const box = itemChk.closest('.rbac-tabs-box');
        if (!box) return;
        const modKey = itemChk.dataset.tabmod || box.dataset.tabmod || '';
        const allChk = box.querySelector('.rbac-tab-all');
        const anyChecked = (allChk && allChk.checked) || box.querySelectorAll('.rbac-tab-item:checked').length > 0;
        const modChk = typeof resolveModCheckbox === 'function' ? resolveModCheckbox(box, modKey) : null;
        if (anyChecked) {
          box.classList.remove('rbac-tabs-box-inactive');
          if (modChk && !modChk.checked) modChk.checked = true;
        } else {
          box.classList.add('rbac-tabs-box-inactive');
          if (modChk && modChk.checked) modChk.checked = false;
        }
      });
    });
  }

  function readTabPermissionsFromContainer(containerEl) {
    const tabPermissions = { rezeptur: 'ALL', einkauf: 'ALL', operations: 'ALL', performance: 'ALL', admin: 'ALL' };
    if (!containerEl) return tabPermissions;
    ['rezeptur', 'einkauf', 'operations', 'performance', 'admin'].forEach(modKey => {
      const box = containerEl.querySelector('.rbac-tabs-box[data-tabmod="' + modKey + '"]');
      if (!box) return;
      const allChk = box.querySelector('.rbac-tab-all');
      if (allChk && allChk.checked) {
        tabPermissions[modKey] = 'ALL';
      } else {
        const picked = [];
        box.querySelectorAll('.rbac-tab-item:checked').forEach(c => picked.push(c.value));
        tabPermissions[modKey] = picked;
      }
    });
    return tabPermissions;
  }

  function renderOtpResultBanner() {
    const slot = $('otpResultBanner');
    if (!slot) return;
    const otp = STATE.lastOtpResult;
    if (!otp || !otp.password) {
      slot.innerHTML = '';
      slot.classList.add('hidden');
      return;
    }
    const mailNote = otp.emailSent
      ? 'E-Mail mit Einmal-Passwort wurde erfolgreich an ' + otp.email + ' gesendet.'
      : 'Hinweis: Automatischer E-Mail-Versand nicht möglich' + (otp.emailError ? ' (' + otp.emailError + ')' : '') + ' – bitte Einmal-Passwort manuell weitergeben.';

    slot.classList.remove('hidden');
    slot.innerHTML =
      '<div class="otp-banner">' +
        '<div>' +
          '<div class="kicker" style="color:var(--os-green);">Einmal-Passwort aktiv · ' + esc(otp.displayName) + '</div>' +
          '<div style="margin:6px 0;">Einmal-Passwort: <span class="otp-code-pill">' + esc(otp.password) + '</span></div>' +
          '<div style="font-size:11.5px;color:var(--os-silk);">' + esc(mailNote) + '</div>' +
        '</div>' +
        '<div style="display:flex;gap:8px;align-items:center;">' +
          '<button type="button" class="btn btn-sm" id="btnCopyOtpBanner">Kopieren</button>' +
          '<button type="button" class="btn btn-sm" id="btnCloseOtpBanner">Schließen</button>' +
        '</div>' +
      '</div>';

    const copyBtn = $('btnCopyOtpBanner');
    if (copyBtn) {
      copyBtn.addEventListener('click', () => {
        if (navigator.clipboard && navigator.clipboard.writeText) {
          navigator.clipboard.writeText(otp.password).then(() => showToast('Einmal-Passwort kopiert.')).catch(() => {});
        } else {
          showToast('Einmal-Passwort: ' + otp.password);
        }
      });
    }
    const closeBtn = $('btnCloseOtpBanner');
    if (closeBtn) {
      closeBtn.addEventListener('click', () => {
        STATE.lastOtpResult = null;
        renderOtpResultBanner();
      });
    }
  }

  function renderPendingRequestsSection() {
    const slot = $('pendingRequestsSection');
    if (!slot) return;
    const reqs = STATE.pendingRequests || [];
    if (!reqs.length) {
      slot.innerHTML = '';
      slot.classList.add('hidden');
      return;
    }

    slot.classList.remove('hidden');
    slot.innerHTML =
      '<div class="card" style="margin-bottom:16px;">' +
        '<div class="card-head">' +
          '<div>' +
            '<div class="kicker">Onboarding · Neue Anfragen</div>' +
            '<h3>Offene Zugangs-Anfragen (' + esc(reqs.length) + ')</h3>' +
          '</div>' +
          '<span class="badge badge-warn">Freigabe ausstehend</span>' +
        '</div>' +
        '<div class="pending-list">' +
          reqs.map((r, idx) =>
            '<div class="pending-item">' +
              '<div>' +
                '<div><b>' + esc(r.displayName) + '</b> <span class="rbac-user-email">(' + esc(r.email) + ')</span></div>' +
                '<div style="font-size:11.5px;color:var(--os-silk);margin-top:3px;">' +
                  'Standort-Wunsch: <b>' + esc(r.requestedLocation || '001') + '</b> · Bereich: <b>' + esc(r.bereich || 'ALLE') + '</b>' +
                  (r.note ? ' · Notiz: ' + esc(r.note) : '') +
                '</div>' +
              '</div>' +
              '<div class="rbac-action-btns">' +
                '<button type="button" class="btn btn-primary btn-sm pending-approve-btn" data-idx="' + idx + '">Konfigurieren &amp; Freigeben</button>' +
                '<button type="button" class="btn btn-sm pending-reject-btn" data-idx="' + idx + '">Ablehnen</button>' +
              '</div>' +
            '</div>'
          ).join('') +
        '</div>' +
      '</div>';

    slot.querySelectorAll('.pending-approve-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        const entry = STATE.pendingRequests[parseInt(btn.dataset.idx, 10)];
        if (entry) openUserProfileModal('approve', entry);
      });
    });

    slot.querySelectorAll('.pending-reject-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        const entry = STATE.pendingRequests[parseInt(btn.dataset.idx, 10)];
        if (entry) rejectPendingUser(entry);
      });
    });
  }

  async function rejectPendingUser(entry) {
    window.SonaLoader.show(600);
    try {
      const res = await window.SonaApi.saveUser({
        userId: entry.userId,
        name: entry.displayName,
        email: entry.email,
        role: entry.role || 'VIEWER',
        bereich: entry.bereich || 'ALLE',
        status: 'REJECTED',
        note: entry.note || '',
        sendInviteEmail: false
      });
      if (!res || !res.success) {
        showToast('Fehler: ' + ((res && res.error) || 'Ablehnung fehlgeschlagen'));
        return;
      }
      showToast('Anfrage von ' + entry.displayName + ' abgelehnt.');
      await loadRbacTable();
    } catch (err) {
      showToast('Fehler: ' + err.message);
    } finally {
      window.SonaLoader.hide();
    }
  }

  async function renderRbacMatrixView() {
    const container = $('osMainContent');
    container.innerHTML =
      '<div id="otpResultBanner" class="hidden"></div>' +
      '<div id="pendingRequestsSection" class="hidden"></div>' +
      '<div class="card">' +
        '<div class="card-head">' +
          '<div>' +
            '<div class="kicker">Administration</div>' +
            '<h3>Mitarbeiter- &amp; Tab-Rechte-Matrix</h3>' +
          '</div>' +
          '<div style="display:flex;gap:8px;flex-wrap:wrap;align-items:center;">' +
            '<span class="badge" title="Benachrichtigungs-Adresse für neue Anfragen">Anfragen → <span id="rbacNotifyEmailLabel">' + esc(STATE.adminNotificationEmail) + '</span></span>' +
            '<button type="button" class="btn btn-primary btn-sm" id="btnNewRbacUser">+ Neuer Mitarbeiter</button>' +
            '<button type="button" class="btn btn-sm" id="btnReloadRbac">Aktualisieren</button>' +
          '</div>' +
        '</div>' +
        '<p class="module-desc" style="margin-bottom:14px;">Steuere pro Mitarbeiter und Gmail-Konto die Hauptmodule (inkl. Operations &amp; Events), Standorte, Zugriffsstufe und über <b>Tabs ▾</b> die feingranularen Tab-Freigaben.</p>' +
        '<div class="table-wrap"><table id="rbacTable"><thead><tr>' +
          '<th>Benutzer</th><th>Rolle</th><th>Einkauf</th><th>Rezepturen</th><th>Controlling</th><th>Bestand</th><th>Operations</th><th>Events</th><th>Performance</th><th>Admin</th><th>Standorte</th><th>Stufe</th><th>Tab-Details</th><th>Aktion</th>' +
        '</tr></thead><tbody id="rbacBody"><tr><td colspan="14">Lade Rechte-Matrix …</td></tr></tbody></table></div>' +
      '</div>';

    $('btnNewRbacUser').addEventListener('click', () => openUserProfileModal('create', null));
    $('btnReloadRbac').addEventListener('click', loadRbacTable);
    renderOtpResultBanner();
    await loadRbacTable();
  }

  let dmCheckInFlight = false;
  async function checkAndShowPendingDirectMessages(session) {
    if (!session || !session.user || dmCheckInFlight) return;
    if (document.getElementById('sonaDmBlockingModal')) return;
    dmCheckInFlight = true;
    try {
      const res = await window.SonaApi.getPendingDirectMessages();
      if (!res || !res.success || !Array.isArray(res.messages) || !res.messages.length) return;
      showNextDirectMessageBlockingPopup(res.messages, 0);
    } catch (e) {
    } finally {
      dmCheckInFlight = false;
    }
  }

  function showNextDirectMessageBlockingPopup(messages, idx) {
    const existing = document.getElementById('sonaDmBlockingModal');
    if (existing) existing.remove();
    if (!Array.isArray(messages) || idx >= messages.length) return;
    const msg = messages[idx];
    const isImage = String(msg.fileMime || '').indexOf('image/') === 0 && !!msg.fileUrl;
    const hasFile = !!msg.fileUrl && !isImage;
    const dateStr = msg.erstelltAm ? new Date(msg.erstelltAm).toLocaleString('de-DE', { dateStyle: 'short', timeStyle: 'short' }) : '';
    const senderName = String(msg.autorName || 'Admin').trim() || 'Admin';
    const initials = senderName.split(/\s+/).slice(0, 2).map(p => p.charAt(0).toUpperCase()).join('') || 'A';

    const backdrop = document.createElement('div');
    backdrop.id = 'sonaDmBlockingModal';
    backdrop.className = 'modal-backdrop dm-backdrop';
    backdrop.style.zIndex = '2600';
    backdrop.setAttribute('role', 'alertdialog');
    backdrop.setAttribute('aria-modal', 'true');
    backdrop.innerHTML =
      '<div class="modal-card dm-card">' +
        '<div class="dm-top-pill-row">' +
          '<span class="dm-live-pill"><span class="dm-live-dot"></span>Direktnachricht</span>' +
          (messages.length > 1 ? '<span class="dm-counter-pill">Nachricht ' + (idx + 1) + ' von ' + messages.length + '</span>' : '<span class="dm-counter-pill">Pflicht-Bestätigung</span>') +
        '</div>' +
        '<div class="dm-sender-row">' +
          '<div class="dm-avatar">' + esc(initials) + '</div>' +
          '<div class="dm-sender-meta">' +
            '<span class="dm-sender-name">' + esc(senderName) + '</span>' +
            '<span class="dm-sender-time">' + esc(dateStr || 'Gerade eben') + '</span>' +
          '</div>' +
        '</div>' +
        '<h2 class="dm-subject">' + esc(msg.thema) + '</h2>' +
        (msg.text
          ? '<div class="dm-bubble">' + esc(msg.text) + '</div>'
          : '') +
        (isImage
          ? '<div class="dm-media-wrap">' +
              '<a href="' + esc(msg.fileUrl) + '" target="_blank" rel="noopener noreferrer" title="Bild in voller Größe öffnen">' +
                '<img src="' + esc(msg.fileUrl) + '" alt="' + esc(msg.fileName || 'Bild') + '">' +
              '</a>' +
            '</div>'
          : '') +
        ((msg.linkUrl || hasFile)
          ? '<div class="dm-attachments-row">' +
              (msg.linkUrl ? '<a class="btn btn-sm" href="' + esc(msg.linkUrl) + '" target="_blank" rel="noopener noreferrer">🔗 Link öffnen ↗</a>' : '') +
              (hasFile ? '<a class="btn btn-sm" href="' + esc(msg.fileUrl) + '" target="_blank" rel="noopener noreferrer">📄 ' + esc(msg.fileName || 'Datei öffnen') + ' ↗</a>' : '') +
            '</div>'
          : '') +
        '<div class="dm-footer">' +
          '<button type="button" id="btnConfirmBlockingDm" class="btn btn-primary dm-confirm-btn">Gelesen &amp; Bestätigt ✓</button>' +
          '<div class="dm-confirm-hint">Bitte bestätige diese Nachricht, um SONA OS weiter zu nutzen.</div>' +
        '</div>' +
      '</div>';

    document.body.appendChild(backdrop);
    const btn = document.getElementById('btnConfirmBlockingDm');
    if (btn) {
      btn.addEventListener('click', async () => {
        btn.disabled = true;
        btn.textContent = 'Wird bestätigt…';
        try {
          await window.SonaApi.confirmDirectMessage(msg.dmId);
        } catch (e) {}
        showNextDirectMessageBlockingPopup(messages, idx + 1);
      });
    }
  }

  async function renderDirectMessagesAdminView() {
    const c = $('osMainContent');
    if (!c) return;
    c.innerHTML =
      '<div class="card" style="margin-bottom:16px;">' +
        '<div class="card-head">' +
          '<div>' +
            '<div class="kicker">Administration · Pflicht-Mitteilung</div>' +
            '<h3>Direktnachricht an Mitarbeiter (Pflicht-Popup)</h3>' +
            '<p class="module-desc" style="margin:4px 0 0;">Tagge einzelne oder mehrere Mitarbeiter. Beim nächsten App-Zugriff erscheint die Info als Pflicht-Popup, das erst bestätigt werden muss.</p>' +
          '</div>' +
        '</div>' +
        '<div id="dmAdminMsg" style="font-size:12.5px;margin-bottom:10px;"></div>' +
        '<div style="display:flex;justify-content:space-between;align-items:center;gap:8px;flex-wrap:wrap;margin-bottom:6px;">' +
          '<label class="kicker" style="margin:0;">Mitarbeiter taggen (<span id="dmSelCount">0</span> ausgewählt)</label>' +
          '<div style="display:flex;gap:6px;flex-wrap:wrap;" id="dmQuickFilters">' +
            '<button type="button" class="btn btn-sm" data-dm-filter="ALL">Alle</button>' +
            '<button type="button" class="btn btn-sm" data-dm-filter="001">Karli (001)</button>' +
            '<button type="button" class="btn btn-sm" data-dm-filter="002">Prager (002)</button>' +
            '<button type="button" class="btn btn-sm" data-dm-filter="NONE">Auswahl leeren</button>' +
          '</div>' +
        '</div>' +
        '<input type="search" id="dmRecSearch" class="input-control" placeholder="Mitarbeiter suchen …" style="margin-bottom:8px;">' +
        '<div id="dmRecipientsBox" class="rundmail-recipients-grid"><p class="module-desc" style="margin:0;">Lade Mitarbeiterliste …</p></div>' +
        '<div class="form-field" style="margin-top:12px;">' +
          '<label class="kicker" for="dmThema">Thema / Überschrift *</label>' +
          '<input type="text" id="dmThema" class="input-control" maxlength="160" placeholder="z. B. Neue Kühlhaus-Regel / Wichtige Info">' +
        '</div>' +
        '<div class="form-field">' +
          '<label class="kicker" for="dmText">Nachrichtentext</label>' +
          '<textarea id="dmText" class="input-control" rows="4" maxlength="6000" style="height:auto;padding:10px;" placeholder="Info-Text für die getaggten Mitarbeiter…"></textarea>' +
        '</div>' +
        '<div class="grid-2">' +
          '<div class="form-field">' +
            '<label class="kicker" for="dmLinkUrl">Optionaler Link (URL)</label>' +
            '<input type="url" id="dmLinkUrl" class="input-control" maxlength="500" placeholder="https://…">' +
          '</div>' +
          '<div class="form-field">' +
            '<label class="kicker" for="dmFileInput">Optionales Bild oder Datei (max. 10 MB)</label>' +
            '<input type="file" id="dmFileInput" class="input-control" style="padding:7px;" accept="image/*,.pdf,.doc,.docx,.xls,.xlsx,.txt">' +
          '</div>' +
        '</div>' +
        '<div style="display:flex;justify-content:flex-end;margin-top:8px;">' +
          '<button type="button" id="btnSendDm" class="btn btn-primary">Pflicht-Popup senden</button>' +
        '</div>' +
      '</div>' +
      '<div class="card">' +
        '<div class="card-head">' +
          '<div><div class="kicker">Nachverfolgung</div><h3>Gesendete Direktnachrichten &amp; Bestätigungen</h3></div>' +
          '<button type="button" id="btnReloadDmList" class="btn btn-sm">Aktualisieren</button>' +
        '</div>' +
        '<div id="dmHistoryBox"><p class="module-desc">Lade Verlauf …</p></div>' +
      '</div>';

    const recBox = $('dmRecipientsBox');
    const selCountEl = $('dmSelCount');
    const recSearch = $('dmRecSearch');
    const msgEl = $('dmAdminMsg');
    let allRecipients = [];
    const selectedIds = new Set();

    const updateCount = () => {
      if (selCountEl) selCountEl.textContent = String(selectedIds.size);
    };

    const drawRecipients = () => {
      if (!recBox) return;
      const q = String((recSearch && recSearch.value) || '').trim().toLowerCase();
      const filtered = allRecipients.filter(r => {
        if (!q) return true;
        return (String(r.name || '') + ' ' + String(r.role || '') + ' ' + String(r.email || '')).toLowerCase().indexOf(q) !== -1;
      });
      if (!filtered.length) {
        recBox.innerHTML = '<p class="module-desc" style="margin:0;">Keine Mitarbeiter gefunden.</p>';
        return;
      }
      recBox.innerHTML = filtered.map(r => {
        const chk = selectedIds.has(r.userId) ? ' checked' : '';
        return '<label class="rundmail-rec-chip">' +
          '<input type="checkbox" class="dm-rec-chk" value="' + esc(r.userId) + '"' + chk + '>' +
          '<span><strong>' + esc(r.name) + '</strong><br><small style="color:var(--os-silk);">' + esc(r.role || '') + ' · ' + esc((r.allowedLocations || []).join(',')) + '</small></span>' +
        '</label>';
      }).join('');
      recBox.querySelectorAll('.dm-rec-chk').forEach(chk => {
        chk.addEventListener('change', () => {
          if (chk.checked) selectedIds.add(chk.value);
          else selectedIds.delete(chk.value);
          updateCount();
        });
      });
    };

    if (recSearch) recSearch.addEventListener('input', drawRecipients);
    const qf = $('dmQuickFilters');
    if (qf) {
      qf.addEventListener('click', ev => {
        const btn = ev.target.closest('button[data-dm-filter]');
        if (!btn) return;
        const f = btn.dataset.dmFilter;
        if (f === 'NONE') selectedIds.clear();
        else if (f === 'ALL') allRecipients.forEach(r => selectedIds.add(r.userId));
        else {
          selectedIds.clear();
          allRecipients.filter(r => (r.allowedLocations || []).indexOf(f) !== -1).forEach(r => selectedIds.add(r.userId));
        }
        drawRecipients();
        updateCount();
      });
    }

    const loadHistory = async () => {
      const hBox = $('dmHistoryBox');
      if (!hBox) return;
      try {
        const res = await window.SonaApi.getDmAdminList();
        if (!res || !res.success) {
          hBox.innerHTML = '<p class="module-desc">Konnte Verlauf nicht laden.</p>';
          return;
        }
        const entries = Array.isArray(res.entries) ? res.entries : [];
        if (!entries.length) {
          hBox.innerHTML = '<p class="module-desc">Noch keine Direktnachrichten gesendet.</p>';
          return;
        }
        hBox.innerHTML = entries.map(e => {
          const dt = e.erstelltAm ? new Date(e.erstelltAm).toLocaleString('de-DE', { dateStyle: 'short', timeStyle: 'short' }) : '';
          const recBadges = (e.recipients || []).map(r =>
            '<span class="badge" style="font-size:11px;' + (r.confirmed ? 'border-color:rgba(126,200,137,0.5);color:var(--os-green);' : 'border-color:rgba(230,180,85,0.45);color:var(--os-amber);') + '">' +
              esc(r.name) + (r.confirmed ? ' ✓' : ' (ausstehend)') +
            '</span>'
          ).join(' ');
          return '<div style="padding:12px;border:1px solid var(--os-line);border-radius:8px;margin-bottom:10px;background:rgba(255,255,255,0.02);">' +
            '<div style="display:flex;justify-content:space-between;gap:8px;flex-wrap:wrap;align-items:flex-start;">' +
              '<div>' +
                '<strong style="color:var(--os-cream);">' + esc(e.thema) + '</strong>' +
                '<div style="font-size:11.5px;color:var(--os-silk);margin-top:2px;">Von ' + esc(e.autorName) + (dt ? ' · ' + esc(dt) : '') + ' · Bestätigt: <b>' + esc(e.confirmedCount) + ' / ' + esc(e.totalCount) + '</b></div>' +
              '</div>' +
              '<button type="button" class="btn btn-sm dm-del-btn" data-dm-id="' + esc(e.dmId) + '" style="color:#f87171;border-color:rgba(248,113,113,0.35);">Löschen</button>' +
            '</div>' +
            (e.text ? '<p style="margin:8px 0 0;font-size:12.5px;color:var(--os-silk);white-space:pre-wrap;">' + esc(e.text) + '</p>' : '') +
            '<div style="display:flex;gap:6px;flex-wrap:wrap;margin-top:8px;">' + recBadges + '</div>' +
          '</div>';
        }).join('');
        hBox.querySelectorAll('.dm-del-btn').forEach(btn => {
          btn.addEventListener('click', async () => {
            btn.disabled = true;
            try {
              const dRes = await window.SonaApi.deleteDirectMessage(btn.dataset.dmId);
              if (dRes && dRes.success) {
                showToast('Direktnachricht entfernt.');
                loadHistory();
              }
            } finally {
              btn.disabled = false;
            }
          });
        });
      } catch (err) {
        hBox.innerHTML = '<p class="module-desc">Fehler beim Laden.</p>';
      }
    };

    const reloadBtn = $('btnReloadDmList');
    if (reloadBtn) reloadBtn.addEventListener('click', loadHistory);

    const btnSend = $('btnSendDm');
    if (btnSend) {
      btnSend.addEventListener('click', async () => {
        const thema = ($('dmThema') && $('dmThema').value || '').trim();
        const text = ($('dmText') && $('dmText').value || '').trim();
        const linkUrl = ($('dmLinkUrl') && $('dmLinkUrl').value || '').trim();
        const fileInp = $('dmFileInput');
        const file = fileInp && fileInp.files && fileInp.files[0];

        if (!selectedIds.size) {
          if (msgEl) { msgEl.style.color = '#f87171'; msgEl.textContent = 'Bitte mindestens einen Mitarbeiter auswählen.'; }
          return;
        }
        if (thema.length < 2) {
          if (msgEl) { msgEl.style.color = '#f87171'; msgEl.textContent = 'Bitte ein Thema eingeben.'; }
          return;
        }
        if (!text && !linkUrl && !file) {
          if (msgEl) { msgEl.style.color = '#f87171'; msgEl.textContent = 'Bitte Text, Link oder eine Datei angeben.'; }
          return;
        }
        if (file && file.size > 10 * 1024 * 1024) {
          if (msgEl) { msgEl.style.color = '#f87171'; msgEl.textContent = 'Datei ist größer als 10 MB.'; }
          return;
        }

        btnSend.disabled = true;
        btnSend.textContent = 'Sendet…';
        if (msgEl) msgEl.textContent = '';

        try {
          let fileBase64 = '';
          let fileName = '';
          let fileMimeType = '';
          if (file) {
            fileName = file.name || 'Anhang';
            fileMimeType = file.type || 'application/octet-stream';
            fileBase64 = await new Promise((resolve, reject) => {
              const r = new FileReader();
              r.onload = () => resolve(String(r.result || ''));
              r.onerror = () => reject(new Error('Datei konnte nicht gelesen werden.'));
              r.readAsDataURL(file);
            });
          }

          const res = await window.SonaApi.sendDirectMessage({
            thema: thema,
            text: text,
            linkUrl: linkUrl,
            recipientIds: Array.from(selectedIds),
            fileName: fileName,
            fileMimeType: fileMimeType,
            fileBase64: fileBase64
          });
          if (!res || !res.success) {
            if (msgEl) { msgEl.style.color = '#f87171'; msgEl.textContent = (res && res.error) || 'Senden fehlgeschlagen.'; }
            return;
          }
          if ($('dmThema')) $('dmThema').value = '';
          if ($('dmText')) $('dmText').value = '';
          if ($('dmLinkUrl')) $('dmLinkUrl').value = '';
          if ($('dmFileInput')) $('dmFileInput').value = '';
          if (msgEl) { msgEl.style.color = 'var(--os-green)'; msgEl.textContent = 'Pflicht-Popup an ' + res.recipientCount + ' Mitarbeiter gesendet.'; }
          showToast('Pflicht-Popup gesendet.');
          loadHistory();
        } catch (err) {
          if (msgEl) { msgEl.style.color = '#f87171'; msgEl.textContent = 'Fehler: ' + (err && err.message ? err.message : String(err)); }
        } finally {
          btnSend.disabled = false;
          btnSend.textContent = 'Pflicht-Popup senden';
        }
      });
    }

    try {
      const rRes = await window.SonaApi.getDmRecipients();
      allRecipients = (rRes && rRes.success && Array.isArray(rRes.recipients)) ? rRes.recipients : [];
      drawRecipients();
      updateCount();
    } catch (e) {
      if (recBox) recBox.innerHTML = '<p class="module-desc">Mitarbeiterliste konnte nicht geladen werden.</p>';
    }
    loadHistory();
  }

  async function renderAdminSourcesView() {
    const c = $('osMainContent');
    if (!c) return;
    c.innerHTML =
      '<div class="card">' +
        '<div class="card-head">' +
          '<div>' +
            '<div class="kicker">Administration · Datenquellen</div>' +
            '<h3>Quellen &amp; Verknüpfte Google Sheets</h3>' +
            '<p class="module-desc" style="margin:4px 0 0;">Direktzugriff auf alle hinterlegten Quell-Tabellen und Drive-Ordner je Ebene und Standort.</p>' +
          '</div>' +
          '<div style="display:flex;gap:8px;align-items:center;flex-wrap:wrap;">' +
            '<select id="adminSourcesLocFilter" class="input-control" style="height:32px;width:auto;min-width:160px;">' +
              '<option value="ALL">Alle Standorte</option>' +
              '<option value="001">Sona Karli (001)</option>' +
              '<option value="002">Sona Prager (002)</option>' +
              '<option value="CENTRAL">Nur Zentral</option>' +
            '</select>' +
            '<button type="button" class="btn btn-sm" id="btnReloadAdminSources">Aktualisieren</button>' +
          '</div>' +
        '</div>' +
        '<div id="adminSourcesBody"><p class="module-desc">Lade verknüpfte Quellen …</p></div>' +
      '</div>';

    const body = $('adminSourcesBody');
    const locSel = $('adminSourcesLocFilter');
    let cachedGroups = [];

    const draw = () => {
      if (!body) return;
      const fLoc = locSel ? locSel.value : 'ALL';
      const blocks = cachedGroups.map(grp => {
        const items = (grp.items || []).filter(it => {
          if (fLoc === 'ALL') return true;
          if (fLoc === 'CENTRAL') return it.standortId === 'ALL';
          return it.standortId === fLoc || it.standortId === 'ALL';
        });
        if (!items.length) return '';
        const rowsHtml = items.map(it => {
          const shortId = it.id ? (it.id.length > 22 ? it.id.slice(0, 12) + '…' + it.id.slice(-8) : it.id) : 'Noch nicht hinterlegt';
          const badge = it.standortId === 'ALL'
            ? '<span class="badge">Zentral</span>'
            : '<span class="badge">' + esc(it.standortName) + ' (' + esc(it.standortId) + ')</span>';
          const actionHtml = it.configured && it.url
            ? '<a class="btn btn-primary btn-sm" href="' + esc(it.url) + '" target="_blank" rel="noopener noreferrer" style="text-decoration:none;white-space:nowrap;">' +
                (it.kind === 'folder' ? 'Ordner öffnen ↗' : 'Sheet öffnen ↗') +
              '</a>' +
              '<button type="button" class="btn btn-sm btn-copy-source-id" data-id="' + esc(it.id) + '" title="ID kopieren">ID</button>'
            : '<span class="badge" style="opacity:.6;">Nicht verknüpft</span>';
          return '<tr>' +
            '<td><strong style="color:var(--os-champagne);">' + esc(it.title) + '</strong>' +
              (it.subtitle ? '<div style="font-size:11.5px;color:var(--os-silk);margin-top:2px;">' + esc(it.subtitle) + '</div>' : '') +
            '</td>' +
            '<td>' + badge + '</td>' +
            '<td><code style="font-size:11.5px;color:var(--os-silk);opacity:.9;">' + esc(shortId) + '</code></td>' +
            '<td style="text-align:right;white-space:nowrap;"><div style="display:inline-flex;gap:6px;align-items:center;">' + actionHtml + '</div></td>' +
          '</tr>';
        }).join('');
        return '<div style="margin-top:18px;">' +
          '<div class="kicker" style="margin-bottom:8px;">' + esc(grp.label) + '</div>' +
          '<div class="table-wrap"><table>' +
            '<thead><tr><th>Quelle / Bereich</th><th>Standort</th><th>Sheet- / Ordner-ID</th><th style="text-align:right;">Zugriff</th></tr></thead>' +
            '<tbody>' + rowsHtml + '</tbody>' +
          '</table></div>' +
        '</div>';
      }).filter(Boolean).join('');

      body.innerHTML = blocks || '<p class="module-desc">Keine Quellen für diesen Filter vorhanden.</p>';
      body.querySelectorAll('.btn-copy-source-id').forEach(btn => {
        btn.addEventListener('click', () => {
          const val = btn.getAttribute('data-id') || '';
          if (!val) return;
          if (navigator.clipboard && navigator.clipboard.writeText) {
            navigator.clipboard.writeText(val).then(() => {
              const orig = btn.textContent;
              btn.textContent = '✓';
              setTimeout(() => { btn.textContent = orig; }, 1200);
            }).catch(() => {});
          }
        });
      });
    };

    const load = async () => {
      if (body) body.innerHTML = '<p class="module-desc">Lade verknüpfte Quellen …</p>';
      try {
        const res = await window.SonaApi.getAdminSources();
        if (!res || res.success === false) {
          if (body) body.innerHTML = '<p class="module-desc">' + esc((res && res.error) || 'Quellen konnten nicht geladen werden.') + '</p>';
          return;
        }
        cachedGroups = Array.isArray(res.groups) ? res.groups : [];
        draw();
      } catch (err) {
        if (body) body.innerHTML = '<p class="module-desc">Fehler beim Laden: ' + esc(err && err.message ? err.message : String(err)) + '</p>';
      }
    };

    if (locSel) locSel.addEventListener('change', draw);
    const reloadBtn = $('btnReloadAdminSources');
    if (reloadBtn) reloadBtn.addEventListener('click', load);
    await load();
  }

  async function renderRundmailView() {
    const container = $('osMainContent');
    if (!container) return;
    container.innerHTML =
      '<div class="card">' +
        '<div class="card-head">' +
          '<div>' +
            '<div class="kicker">Administration · Kommunikation</div>' +
            '<h3>Rundmail an Mitarbeiter</h3>' +
          '</div>' +
          '<button type="button" class="btn btn-sm" id="btnReloadRundmail">Empfänger neu laden</button>' +
        '</div>' +
        '<p class="module-desc" style="margin-bottom:14px;">Sende Nachrichten und Dateianhänge (PDF, Bilder, Dokumente bis 8 MB gesamt) gezielt an die hinterlegten Mitarbeiter-E-Mails (BCC-geschützt).</p>' +
        '<div id="rundmailMsg" style="font-size:12.5px;margin-bottom:10px;"></div>' +
        '<div class="form-field">' +
          '<div style="display:flex;justify-content:space-between;align-items:center;gap:8px;flex-wrap:wrap;margin-bottom:6px;">' +
            '<label class="kicker" style="margin:0;">Empfänger auswählen (<span id="rundmailSelCount">0</span> ausgewählt)</label>' +
            '<div style="display:flex;gap:6px;flex-wrap:wrap;" id="rundmailQuickFilters">' +
              '<button type="button" class="btn btn-sm" data-rm-filter="ALL">Alle</button>' +
              '<button type="button" class="btn btn-sm" data-rm-filter="LOC_001">Karli</button>' +
              '<button type="button" class="btn btn-sm" data-rm-filter="LOC_002">Prager</button>' +
              '<button type="button" class="btn btn-sm" data-rm-filter="BER_KUECHE">Küche</button>' +
              '<button type="button" class="btn btn-sm" data-rm-filter="BER_BAR">Bar</button>' +
              '<button type="button" class="btn btn-sm" data-rm-filter="BER_SERVICE">Service</button>' +
              '<button type="button" class="btn btn-sm" data-rm-filter="NONE">Keine</button>' +
            '</div>' +
          '</div>' +
          '<div id="rundmailRecipientsBox" class="rundmail-recipients-grid"><p class="module-desc" style="margin:0;">Lade Mitarbeiterliste …</p></div>' +
        '</div>' +
        '<div class="form-field">' +
          '<label class="kicker" for="rundmailSubject">Betreff</label>' +
          '<input type="text" id="rundmailSubject" class="input-control" maxlength="160" placeholder="z. B. Neuer Dienstplan / Einladung Team-Meeting">' +
        '</div>' +
        '<div class="form-field">' +
          '<label class="kicker" for="rundmailBody">Nachricht</label>' +
          '<textarea id="rundmailBody" class="input-control" rows="6" maxlength="10000" placeholder="Nachricht an das Team …"></textarea>' +
        '</div>' +
        '<div class="form-field">' +
          '<label class="kicker" for="rundmailFiles">Dateianhänge (optional, bis zu 5 Dateien, max. 8 MB gesamt)</label>' +
          '<input type="file" id="rundmailFiles" class="input-control" multiple accept=".pdf,image/*,.doc,.docx,.xls,.xlsx,.csv,.txt">' +
        '</div>' +
        '<div style="display:flex;justify-content:flex-end;gap:10px;margin-top:10px;">' +
          '<button type="button" id="btnSendRundmail" class="btn btn-primary">Rundmail senden</button>' +
        '</div>' +
      '</div>';

    let recipients = [];
    const updateCount = () => {
      const n = container.querySelectorAll('.rm-rec-chk:checked').length;
      const el = $('rundmailSelCount');
      if (el) el.textContent = String(n);
    };

    const loadRecs = async () => {
      const box = $('rundmailRecipientsBox');
      if (!box) return;
      box.innerHTML = '<p class="module-desc" style="margin:0;">Lade Mitarbeiterliste …</p>';
      try {
        const res = await window.SonaApi.getRundmailRecipients();
        if (!res || !res.success) {
          const msg = (res && res.error) || 'Empfänger konnten nicht geladen werden.';
          box.innerHTML = '<p class="module-desc" style="margin:0;">' + esc(msg.indexOf('Unbekannte Aktion') !== -1 ? 'Rundmail-Backend wartet noch auf @sync.' : msg) + '</p>';
          return;
        }
        recipients = Array.isArray(res.recipients) ? res.recipients : [];
        if (!recipients.length) {
          box.innerHTML = '<p class="module-desc" style="margin:0;">Keine aktiven Mitarbeiter mit E-Mail-Adresse gefunden.</p>';
          return;
        }
        box.innerHTML = recipients.map(r =>
          '<label class="rundmail-rec-chip">' +
            '<input type="checkbox" class="rm-rec-chk" value="' + esc(r.userId) + '" data-locs="' + esc((r.allowedLocations || []).join(',')) + '" data-bereich="' + esc(r.bereich || 'ALLE') + '">' +
            '<div>' +
              '<div style="font-weight:600;color:var(--os-cream);">' + esc(r.name) + '</div>' +
              '<div style="font-size:11px;color:var(--os-silk);">' + esc(r.email) + '</div>' +
              '<div style="font-size:10.5px;color:var(--os-silk);opacity:0.8;">' + esc(r.bereich || 'ALLE') + ' · ' + esc((r.allowedLocations || []).join('/')) + '</div>' +
            '</div>' +
          '</label>'
        ).join('');
        box.querySelectorAll('.rm-rec-chk').forEach(c => c.addEventListener('change', updateCount));
        updateCount();
      } catch (err) {
        box.innerHTML = '<p class="module-desc" style="margin:0;">Verbindungsfehler beim Laden der Empfänger.</p>';
      }
    };

    const filtersWrap = $('rundmailQuickFilters');
    if (filtersWrap) {
      filtersWrap.querySelectorAll('[data-rm-filter]').forEach(btn => {
        btn.addEventListener('click', () => {
          const mode = btn.dataset.rmFilter;
          container.querySelectorAll('.rm-rec-chk').forEach(chk => {
            const locs = String(chk.dataset.locs || '').split(',');
            const ber = String(chk.dataset.bereich || '').toUpperCase();
            if (mode === 'ALL') chk.checked = true;
            else if (mode === 'NONE') chk.checked = false;
            else if (mode === 'LOC_001') chk.checked = locs.indexOf('001') !== -1;
            else if (mode === 'LOC_002') chk.checked = locs.indexOf('002') !== -1;
            else if (mode === 'BER_KUECHE') chk.checked = ber === 'KUECHE' || ber === 'FOOD_SUSHI';
            else if (mode === 'BER_BAR') chk.checked = ber === 'BAR' || ber === 'BEVERAGE_DESSERT';
            else if (mode === 'BER_SERVICE') chk.checked = ber === 'SERVICE';
          });
          updateCount();
        });
      });
    }

    $('btnReloadRundmail').addEventListener('click', loadRecs);
    $('btnSendRundmail').addEventListener('click', async () => {
      const msgEl = $('rundmailMsg');
      const subject = ($('rundmailSubject') && $('rundmailSubject').value || '').trim();
      const body = ($('rundmailBody') && $('rundmailBody').value || '').trim();
      const recipientIds = [];
      container.querySelectorAll('.rm-rec-chk:checked').forEach(c => recipientIds.push(c.value));

      if (!recipientIds.length) {
        if (msgEl) { msgEl.style.color = '#f87171'; msgEl.textContent = 'Bitte mindestens einen Empfänger auswählen.'; }
        return;
      }
      if (subject.length < 2 || body.length < 2) {
        if (msgEl) { msgEl.style.color = '#f87171'; msgEl.textContent = 'Bitte Betreff und Nachricht ausfüllen.'; }
        return;
      }

      const filesInput = $('rundmailFiles');
      const fileList = (filesInput && filesInput.files) ? Array.from(filesInput.files).slice(0, 5) : [];
      let totalSize = 0;
      for (let i = 0; i < fileList.length; i++) totalSize += fileList[i].size;
      if (totalSize > 8 * 1024 * 1024) {
        if (msgEl) { msgEl.style.color = '#f87171'; msgEl.textContent = 'Anhänge überschreiten das Gesamtlimit von 8 MB.'; }
        return;
      }

      const btn = $('btnSendRundmail');
      btn.disabled = true;
      btn.textContent = 'Sendet…';
      if (msgEl) msgEl.textContent = '';

      try {
        const attachments = [];
        for (let i = 0; i < fileList.length; i++) {
          const f = fileList[i];
          const b64 = await new Promise((resolve, reject) => {
            const reader = new FileReader();
            reader.onload = () => resolve(String(reader.result || ''));
            reader.onerror = () => reject(new Error('Datei konnte nicht gelesen werden.'));
            reader.readAsDataURL(f);
          });
          attachments.push({ fileName: f.name, mimeType: f.type || 'application/octet-stream', base64: b64 });
        }

        const res = await window.SonaApi.sendRundmail({
          recipientIds: recipientIds,
          subject: subject,
          body: body,
          attachments: attachments
        });
        if (!res || !res.success) {
          if (msgEl) { msgEl.style.color = '#f87171'; msgEl.textContent = (res && res.error) || 'Versand fehlgeschlagen.'; }
          return;
        }
        if (msgEl) {
          msgEl.style.color = '#6ee7b7';
          msgEl.textContent = '✓ Rundmail an ' + res.sentCount + ' Mitarbeiter gesendet' + (res.attachmentCount ? (' (' + res.attachmentCount + ' Anhang/Anhänge)') : '') + '.';
        }
        if ($('rundmailSubject')) $('rundmailSubject').value = '';
        if ($('rundmailBody')) $('rundmailBody').value = '';
        if (filesInput) filesInput.value = '';
        showToast('Rundmail an ' + res.sentCount + ' Mitarbeiter gesendet.');
      } catch (err) {
        if (msgEl) { msgEl.style.color = '#f87171'; msgEl.textContent = 'Verbindungsfehler: ' + (err && err.message ? err.message : String(err)); }
      } finally {
        btn.disabled = false;
        btn.textContent = 'Rundmail senden';
      }
    });

    await loadRecs();
  }

  async function renderSupportHelpView(initialTab) {
    const container = $('osMainContent');
    if (!container) return;
    let activeTab = initialTab === 'support' ? 'support' : 'hilfe';
    let selectedEbene = 'Alle';
    let helpEntries = [];
    let isAdmin = hasAdminTab(STATE.session, 'hilfe_editor');
    let backendPending = false;

    const renderShell = () => {
      container.innerHTML =
        '<div class="card" style="margin-bottom:16px;">' +
          '<div class="card-head">' +
            '<div>' +
              '<div class="kicker">SONA OS · Service</div>' +
              '<h3>Hilfe &amp; Support</h3>' +
            '</div>' +
            '<button type="button" id="btnReplayAppTour" class="btn btn-sm">App-Tour starten</button>' +
          '</div>' +
          '<div class="help-tabs">' +
            '<button type="button" class="btn btn-sm ' + (activeTab === 'hilfe' ? 'btn-primary' : '') + '" data-sh-tab="hilfe">Hilfe, Videos &amp; FAQs</button>' +
            '<button type="button" class="btn btn-sm ' + (activeTab === 'support' ? 'btn-primary' : '') + '" data-sh-tab="support">Support kontaktieren</button>' +
          '</div>' +
          '<div id="supportHelpBody"></div>' +
        '</div>';

      container.querySelectorAll('[data-sh-tab]').forEach(btn => {
        btn.addEventListener('click', () => {
          activeTab = btn.dataset.shTab;
          renderShell();
        });
      });
      if ($('btnReplayAppTour')) {
        $('btnReplayAppTour').addEventListener('click', () => startOnboardingTour(true));
      }

      if (activeTab === 'support') {
        renderSupportPane();
      } else {
        renderHelpPane();
      }
    };

    const renderSupportPane = () => {
      const body = $('supportHelpBody');
      if (!body) return;
      body.innerHTML =
        '<p class="module-desc" style="margin-bottom:14px;">Du hast eine Frage, einen Fehler entdeckt oder brauchst Hilfe zu einem Bereich? Schreib direkt an die Administration – optional mit Screenshot oder Foto.</p>' +
        '<div id="supportSendMsg" style="font-size:12.5px;margin-bottom:10px;"></div>' +
        '<div class="user-modal-grid">' +
          '<div class="form-field">' +
            '<label class="kicker" for="supTopic">Thema / Bereich</label>' +
            '<select id="supTopic" class="input-control">' +
              '<option value="Allgemein">Allgemein</option>' +
              '<option value="Startseite / Operations">Startseite / Operations</option>' +
              '<option value="Warenwirtschaft">Warenwirtschaft (Einkauf / Bestand / Rezepturen)</option>' +
              '<option value="Controlling / Performance">Controlling / Performance</option>' +
              '<option value="Events">Events / Eventkalkulation</option>' +
              '<option value="Login & Rechte">Login, Passwort &amp; Rechte</option>' +
              '<option value="Technischer Fehler">Technischer Fehler / Bug</option>' +
            '</select>' +
          '</div>' +
          '<div class="form-field">' +
            '<label class="kicker" for="supSubject">Betreff</label>' +
            '<input type="text" id="supSubject" class="input-control" maxlength="160" placeholder="Kurze Zusammenfassung deines Anliegens">' +
          '</div>' +
        '</div>' +
        '<div class="form-field">' +
          '<label class="kicker" for="supMessage">Nachricht</label>' +
          '<textarea id="supMessage" class="input-control" rows="5" maxlength="8000" placeholder="Beschreibe kurz, wobei wir helfen können …"></textarea>' +
        '</div>' +
        '<div class="form-field">' +
          '<label class="kicker" for="supPhoto">Foto / Screenshot anhängen (optional, max. 8 MB)</label>' +
          '<input type="file" id="supPhoto" class="input-control" accept="image/*,.pdf">' +
        '</div>' +
        '<div style="display:flex;justify-content:flex-end;">' +
          '<button type="button" id="btnSendSupport" class="btn btn-primary">Support-Nachricht senden</button>' +
        '</div>';

      $('btnSendSupport').addEventListener('click', async () => {
        const msgEl = $('supportSendMsg');
        const topic = ($('supTopic') && $('supTopic').value) || 'Allgemein';
        const subject = ($('supSubject') && $('supSubject').value || '').trim();
        const message = ($('supMessage') && $('supMessage').value || '').trim();
        if (subject.length < 2 || message.length < 3) {
          if (msgEl) { msgEl.style.color = '#f87171'; msgEl.textContent = 'Bitte Betreff und Nachricht ausfüllen.'; }
          return;
        }
        const photoEl = $('supPhoto');
        const fileObj = photoEl && photoEl.files && photoEl.files[0];
        let photoBase64 = '';
        let photoName = '';
        let photoMimeType = '';
        if (fileObj) {
          if (fileObj.size > 8 * 1024 * 1024) {
            if (msgEl) { msgEl.style.color = '#f87171'; msgEl.textContent = 'Datei ist zu groß (max. 8 MB).'; }
            return;
          }
          photoName = fileObj.name;
          photoMimeType = fileObj.type || 'image/jpeg';
          photoBase64 = await new Promise((resolve, reject) => {
            const reader = new FileReader();
            reader.onload = () => resolve(String(reader.result || ''));
            reader.onerror = () => reject(new Error('Datei konnte nicht gelesen werden.'));
            reader.readAsDataURL(fileObj);
          });
        }

        const btn = $('btnSendSupport');
        btn.disabled = true;
        btn.textContent = 'Sendet…';
        if (msgEl) msgEl.textContent = '';
        try {
          const res = await window.SonaApi.sendSupportRequest({
            topic: topic,
            subject: subject,
            message: message,
            photoBase64: photoBase64,
            photoName: photoName,
            photoMimeType: photoMimeType
          });
          if (!res || !res.success) {
            if (msgEl) { msgEl.style.color = '#f87171'; msgEl.textContent = (res && res.error) || 'Senden fehlgeschlagen.'; }
            return;
          }
          if (msgEl) { msgEl.style.color = '#6ee7b7'; msgEl.textContent = '✓ Deine Support-Anfrage wurde erfolgreich gesendet.'; }
          if ($('supSubject')) $('supSubject').value = '';
          if ($('supMessage')) $('supMessage').value = '';
          if (photoEl) photoEl.value = '';
          showToast('Support-Nachricht gesendet.');
        } catch (err) {
          if (msgEl) { msgEl.style.color = '#f87171'; msgEl.textContent = 'Verbindungsfehler.'; }
        } finally {
          btn.disabled = false;
          btn.textContent = 'Support-Nachricht senden';
        }
      });
    };

    const renderHelpPane = () => {
      const body = $('supportHelpBody');
      if (!body) return;
      const ebenen = ['Alle', 'Startseite', 'Operations', 'Events', 'Warenwirtschaft', 'Controlling', 'Performance', 'Admin', 'Allgemein'];
      const filtered = selectedEbene === 'Alle'
        ? helpEntries
        : helpEntries.filter(it => String(it.ebene || '').toLowerCase() === selectedEbene.toLowerCase());

      const editorHtml = (isAdmin && !backendPending) ? (
        '<details class="ops-activity-details" style="margin:0 0 16px;">' +
          '<summary>+ Neues Video, FAQ oder Anleitung anlegen (Admin)</summary>' +
          '<div class="ops-activity-body">' +
            '<div id="helpSaveMsg" style="font-size:12.5px;margin-bottom:8px;"></div>' +
            '<div class="user-modal-grid">' +
              '<div class="form-field">' +
                '<label class="kicker" for="hlpTyp">Eintrag-Typ</label>' +
                '<select id="hlpTyp" class="input-control">' +
                  '<option value="ANLEITUNG">Anleitung / Ebene beschreiben</option>' +
                  '<option value="VIDEO">Bedienungs-Video</option>' +
                  '<option value="FAQ">Frage &amp; Antwort (FAQ)</option>' +
                '</select>' +
              '</div>' +
              '<div class="form-field">' +
                '<label class="kicker" for="hlpEbene">Ebene</label>' +
                '<select id="hlpEbene" class="input-control">' +
                  ebenen.filter(e => e !== 'Alle').map(e => '<option value="' + esc(e) + '">' + esc(e) + '</option>').join('') +
                '</select>' +
              '</div>' +
              '<div class="form-field">' +
                '<label class="kicker" for="hlpUnterthema">Unterthema (optional)</label>' +
                '<input type="text" id="hlpUnterthema" class="input-control" maxlength="80" placeholder="z. B. Putzplan, 86-Liste, Rechnungsscan">' +
              '</div>' +
              '<div class="form-field">' +
                '<label class="kicker" for="hlpTitel">Titel / Frage</label>' +
                '<input type="text" id="hlpTitel" class="input-control" maxlength="160" placeholder="z. B. Wie trage ich einen Artikel auf die 86-Liste ein?">' +
              '</div>' +
            '</div>' +
            '<div class="form-field">' +
              '<label class="kicker" for="hlpInhalt">Beschreibung / Antwort / Schritte</label>' +
              '<textarea id="hlpInhalt" class="input-control" rows="4" maxlength="8000" placeholder="Kurze Schritt-für-Schritt-Erklärung …"></textarea>' +
            '</div>' +
            '<div class="user-modal-grid">' +
              '<div class="form-field">' +
                '<label class="kicker" for="hlpVideoFile">Video direkt hochladen (optional, MP4/MOV max. 20 MB)</label>' +
                '<input type="file" id="hlpVideoFile" class="input-control" accept="video/*">' +
              '</div>' +
              '<div class="form-field">' +
                '<label class="kicker" for="hlpVideoUrl">oder Video-Link (Google Drive / YouTube)</label>' +
                '<input type="url" id="hlpVideoUrl" class="input-control" maxlength="500" placeholder="https://drive.google.com/file/d/…">' +
              '</div>' +
            '</div>' +
            '<div style="display:flex;justify-content:flex-end;">' +
              '<button type="button" id="btnSaveHelpEntry" class="btn btn-primary btn-sm">Hilfe-Eintrag speichern</button>' +
            '</div>' +
          '</div>' +
        '</details>'
      ) : '';

      const cardsHtml = backendPending
        ? '<p class="home-empty-hint">Hilfe-Center wird nach dem nächsten <code>@sync</code> automatisch aktiviert.</p>'
        : (filtered.length
            ? '<div class="help-cards-grid">' +
                filtered.map(it => {
                  const typLabel = it.typ === 'VIDEO' ? 'Video' : (it.typ === 'FAQ' ? 'FAQ' : 'Anleitung');
                  const videoHtml = it.videoUrl
                    ? '<div class="help-video-wrap"><iframe src="' + esc(it.videoUrl) + '" allow="autoplay; fullscreen" allowfullscreen></iframe></div>'
                    : '';
                  const delBtn = isAdmin
                    ? '<button type="button" class="btn btn-danger btn-sm hlp-del-btn" data-id="' + esc(it.id) + '" style="margin-left:auto;">Entfernen</button>'
                    : '';
                  if (it.typ === 'FAQ' && !it.videoUrl) {
                    return '<details class="help-faq-item">' +
                      '<summary>' +
                        '<span class="badge" style="margin-right:8px;">' + esc(it.ebene) + (it.unterthema ? ' · ' + esc(it.unterthema) : '') + '</span>' +
                        esc(it.titel) +
                      '</summary>' +
                      '<div class="help-faq-body">' + esc(it.inhalt) + '</div>' +
                      (delBtn ? '<div style="margin-top:8px;display:flex;">' + delBtn + '</div>' : '') +
                    '</details>';
                  }
                  return '<article class="help-card">' +
                    '<div style="display:flex;align-items:center;gap:6px;flex-wrap:wrap;">' +
                      '<span class="badge">' + esc(typLabel) + '</span>' +
                      '<span class="badge">' + esc(it.ebene) + (it.unterthema ? ' · ' + esc(it.unterthema) : '') + '</span>' +
                      delBtn +
                    '</div>' +
                    '<h4 class="home-news-title" style="margin:0;">' + esc(it.titel) + '</h4>' +
                    videoHtml +
                    (it.inhalt ? '<div class="home-news-body">' + esc(it.inhalt) + '</div>' : '') +
                  '</article>';
                }).join('') +
              '</div>'
            : '<p class="home-empty-hint">Für diesen Bereich sind noch keine Hilfe-Einträge hinterlegt.</p>');

      body.innerHTML =
        editorHtml +
        '<div class="help-filter-pills">' +
          ebenen.map(e =>
            '<button type="button" class="btn btn-sm ' + (selectedEbene === e ? 'btn-primary' : '') + '" data-hlp-filter="' + esc(e) + '">' + esc(e) + '</button>'
          ).join('') +
        '</div>' +
        cardsHtml;

      body.querySelectorAll('[data-hlp-filter]').forEach(b => {
        b.addEventListener('click', () => {
          selectedEbene = b.dataset.hlpFilter;
          renderHelpPane();
        });
      });

      const saveBtn = $('btnSaveHelpEntry');
      if (saveBtn) {
        saveBtn.addEventListener('click', async () => {
          const msgEl = $('helpSaveMsg');
          const titel = ($('hlpTitel') && $('hlpTitel').value || '').trim();
          const inhalt = ($('hlpInhalt') && $('hlpInhalt').value || '').trim();
          const typ = ($('hlpTyp') && $('hlpTyp').value) || 'ANLEITUNG';
          const ebene = ($('hlpEbene') && $('hlpEbene').value) || 'Allgemein';
          const unterthema = ($('hlpUnterthema') && $('hlpUnterthema').value || '').trim();
          const videoUrl = ($('hlpVideoUrl') && $('hlpVideoUrl').value || '').trim();
          if (titel.length < 2) {
            if (msgEl) { msgEl.style.color = '#f87171'; msgEl.textContent = 'Bitte einen Titel eingeben.'; }
            return;
          }

          let videoBase64 = '';
          let videoFileName = '';
          let videoMimeType = '';
          const vf = $('hlpVideoFile') && $('hlpVideoFile').files && $('hlpVideoFile').files[0];
          if (vf) {
            if (vf.size > 20 * 1024 * 1024) {
              if (msgEl) { msgEl.style.color = '#f87171'; msgEl.textContent = 'Video ist größer als 20 MB – bitte in Google Drive hochladen und den Link einfügen.'; }
              return;
            }
            videoFileName = vf.name;
            videoMimeType = vf.type || 'video/mp4';
            videoBase64 = await new Promise((resolve, reject) => {
              const reader = new FileReader();
              reader.onload = () => resolve(String(reader.result || ''));
              reader.onerror = () => reject(new Error('Video konnte nicht gelesen werden.'));
              reader.readAsDataURL(vf);
            });
          }

          saveBtn.disabled = true;
          saveBtn.textContent = 'Speichert…';
          if (msgEl) msgEl.textContent = '';
          try {
            const sRes = await window.SonaApi.saveHelpEntry({
              typ: typ,
              ebene: ebene,
              unterthema: unterthema,
              titel: titel,
              inhalt: inhalt,
              videoUrl: videoUrl,
              videoFileName: videoFileName,
              videoMimeType: videoMimeType,
              videoBase64: videoBase64
            });
            if (!sRes || !sRes.success) {
              if (msgEl) { msgEl.style.color = '#f87171'; msgEl.textContent = (sRes && sRes.error) || 'Speichern fehlgeschlagen.'; }
              return;
            }
            showToast('Hilfe-Eintrag gespeichert.');
            await loadHelpData();
            renderHelpPane();
          } catch (eSave) {
            if (msgEl) { msgEl.style.color = '#f87171'; msgEl.textContent = 'Verbindungsfehler.'; }
          } finally {
            saveBtn.disabled = false;
            saveBtn.textContent = 'Hilfe-Eintrag speichern';
          }
        });
      }

      body.querySelectorAll('.hlp-del-btn').forEach(b => {
        b.addEventListener('click', async () => {
          b.disabled = true;
          try {
            const dRes = await window.SonaApi.deleteHelpEntry(b.dataset.id);
            if (dRes && dRes.success) {
              showToast('Hilfe-Eintrag entfernt.');
              await loadHelpData();
              renderHelpPane();
            }
          } finally {
            b.disabled = false;
          }
        });
      });
    };

    const loadHelpData = async () => {
      try {
        const res = await window.SonaApi.getHelpEntries();
        if (res && res.success) {
          helpEntries = Array.isArray(res.entries) ? res.entries : [];
          isAdmin = !!res.isAdmin;
          backendPending = false;
        } else if (res && String(res.error || '').indexOf('Unbekannte Aktion') !== -1) {
          backendPending = true;
        }
      } catch (e) {}
    };

    renderShell();
    await loadHelpData();
    if (activeTab === 'hilfe') renderHelpPane();
  }

  function formatAuditTimestamp(isoStr) {
    if (!isoStr) return '—';
    try {
      const d = new Date(isoStr);
      if (isNaN(d.getTime())) return String(isoStr);
      return d.toLocaleString('de-DE', {
        day: '2-digit',
        month: '2-digit',
        year: 'numeric',
        hour: '2-digit',
        minute: '2-digit',
        second: '2-digit'
      });
    } catch (e) {
      return String(isoStr);
    }
  }

  function getAuditModuleBadgeClass(modul) {
    const m = String(modul || '').toUpperCase();
    if (m === 'OPERATIONS') return 'badge-ok';
    if (m === 'EVENTS') return 'badge-info';
    if (m === 'ADMIN') return 'badge-warn';
    if (m === 'AUTH') return 'badge-info';
    return '';
  }

  function exportAuditLogCsv() {
    const rows = STATE.auditEntries || [];
    if (!rows.length) {
      showToast('Keine Protokoll-Einträge für Export vorhanden.');
      return;
    }
    const header = ['Log_ID', 'Zeitpunkt', 'Benutzer_ID', 'Name', 'Email', 'Standort', 'Modul', 'Aktion', 'Detail'];
    const csvEscape = v => '"' + String(v == null ? '' : v).replace(/"/g, '""') + '"';
    const lines = [header.join(';')].concat(rows.map(r => [
      r.logId,
      r.timestamp,
      r.userId,
      r.name,
      r.email,
      (r.standortName || r.standortId || ''),
      r.modul,
      r.aktion,
      r.detail
    ].map(csvEscape).join(';')));
    const blob = new Blob(['\uFEFF' + lines.join('\r\n')], { type: 'text/csv;charset=utf-8;' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = 'SONA_OS_Aktivitaetsprotokoll_' + new Date().toISOString().slice(0, 10) + '.csv';
    document.body.appendChild(a);
    a.click();
    setTimeout(() => {
      document.body.removeChild(a);
      URL.revokeObjectURL(url);
    }, 100);
    showToast('Aktivitätsprotokoll als CSV exportiert (' + rows.length + ' Einträge).');
  }

  async function renderAuditLogView() {
    const container = $('osMainContent');
    if (!container) return;

    container.innerHTML =
      '<div class="card">' +
        '<div class="card-head">' +
          '<div>' +
            '<div class="kicker">Administration · Nachvollziehbarkeit</div>' +
            '<h3>Aktivitätsprotokoll</h3>' +
          '</div>' +
          '<div style="display:flex;gap:8px;flex-wrap:wrap;align-items:center;">' +
            '<button type="button" class="btn btn-sm" id="btnExportAuditCsv">CSV Export</button>' +
            '<button type="button" class="btn btn-primary btn-sm" id="btnReloadAuditLog">Aktualisieren</button>' +
          '</div>' +
        '</div>' +
        '<p class="module-desc" style="margin-bottom:14px;">Zentrales Änderungs- &amp; Zugriffsprotokoll über alle Ebenen mit Name, E-Mail-Adresse, Standort und Zeitstempel.</p>' +
        '<div class="audit-kpi-row" id="auditKpiRow">' +
          '<div class="audit-kpi"><span class="kicker">Protokoll gesamt</span><strong id="auditKpiTotal">—</strong></div>' +
          '<div class="audit-kpi"><span class="kicker">Heute erfasst</span><strong id="auditKpiToday">—</strong></div>' +
          '<div class="audit-kpi"><span class="kicker">Aktive Nutzer</span><strong id="auditKpiUsers">—</strong></div>' +
        '</div>' +
        '<div class="audit-filter-bar">' +
          '<select id="auditLocFilter" class="input-control" style="max-width:170px;">' +
            '<option value="ALL">Alle Standorte</option>' +
            '<option value="001">001 · Sona Karli</option>' +
            '<option value="002">002 · Sona Prager</option>' +
          '</select>' +
          '<select id="auditModFilter" class="input-control" style="max-width:190px;">' +
            '<option value="ALL">Alle Module</option>' +
            '<option value="OPERATIONS">Operations</option>' +
            '<option value="EVENTS">Events</option>' +
            '<option value="WARENWIRTSCHAFT">Warenwirtschaft</option>' +
            '<option value="CONTROLLING">Controlling</option>' +
            '<option value="PERFORMANCE">Performance</option>' +
            '<option value="ADMIN">Admin</option>' +
            '<option value="AUTH">Anmeldung</option>' +
          '</select>' +
          '<input type="search" id="auditQueryInput" class="input-control" placeholder="Nach Name, E-Mail, Aktion oder Detail filtern …" style="flex:1;min-width:220px;">' +
        '</div>' +
        '<div class="table-wrap"><table id="auditTable"><thead><tr>' +
          '<th>Zeitpunkt</th><th>Mitarbeiter &amp; E-Mail</th><th>Standort</th><th>Modul</th><th>Aktion</th><th>Detail</th>' +
        '</tr></thead><tbody id="auditBody"><tr><td colspan="6">Lade Aktivitätsprotokoll …</td></tr></tbody></table></div>' +
      '</div>';

    $('btnReloadAuditLog').addEventListener('click', loadAuditLogTable);
    $('btnExportAuditCsv').addEventListener('click', exportAuditLogCsv);
    $('auditLocFilter').addEventListener('change', loadAuditLogTable);
    $('auditModFilter').addEventListener('change', loadAuditLogTable);
    let queryTimer = null;
    $('auditQueryInput').addEventListener('input', () => {
      if (queryTimer) clearTimeout(queryTimer);
      queryTimer = setTimeout(loadAuditLogTable, 260);
    });

    await loadAuditLogTable();
  }

  async function loadAuditLogTable(forceRefresh) {
    const tbody = $('auditBody');
    if (!tbody) return;
    const filter = {
      standortId: ($('auditLocFilter') && $('auditLocFilter').value) || 'ALL',
      modul: ($('auditModFilter') && $('auditModFilter').value) || 'ALL',
      query: ($('auditQueryInput') && $('auditQueryInput').value) || '',
      limit: 250
    };
    const cacheKey = JSON.stringify(filter);
    const cached = !forceRefresh ? ADMIN_CACHE.audit[cacheKey] : null;
    const hasFreshCache = !!(cached && (Date.now() - cached.ts) < ADMIN_CACHE_STALE_MS);
    if (!hasFreshCache) window.SonaLoader.show(600);
    try {
      let res;
      if (hasFreshCache) {
        res = cached.data;
        if ((Date.now() - cached.ts) > ADMIN_CACHE_FRESH_MS) {
          window.SonaApi.getAuditLog(filter).then(fresh => {
            if (fresh && fresh.success) {
              ADMIN_CACHE.audit[cacheKey] = { ts: Date.now(), data: fresh };
              if (STATE.activeView === 'audit_log') loadAuditLogTable(false);
            }
          }).catch(() => {});
        }
      } else {
        res = await window.SonaApi.getAuditLog(filter);
        if (res && res.success) {
          ADMIN_CACHE.audit[cacheKey] = { ts: Date.now(), data: res };
        }
      }
      if (!res || !res.success) {
        tbody.innerHTML = '<tr><td colspan="6">' + esc((res && res.error) || 'Fehler beim Laden des Protokolls.') + '</td></tr>';
        return;
      }
      STATE.auditEntries = res.entries || [];
      if ($('auditKpiTotal')) $('auditKpiTotal').textContent = String(res.totalCount || 0);
      if ($('auditKpiToday')) $('auditKpiToday').textContent = String(res.todayCount || 0);
      if ($('auditKpiUsers')) $('auditKpiUsers').textContent = String(res.uniqueUsersCount || 0);

      if (!STATE.auditEntries.length) {
        tbody.innerHTML = '<tr><td colspan="6" style="color:var(--os-silk);padding:18px;">Keine Protokoll-Einträge für die gewählten Filter gefunden.</td></tr>';
        return;
      }

      tbody.innerHTML = STATE.auditEntries.map(item =>
        '<tr>' +
          '<td style="white-space:nowrap;font-size:12px;color:var(--os-silk);">' + esc(formatAuditTimestamp(item.timestamp)) + '</td>' +
          '<td>' +
            '<b>' + esc(item.name || 'System') + '</b>' +
            (item.email ? '<div class="rbac-user-email">' + esc(item.email) + '</div>' : '') +
          '</td>' +
          '<td style="white-space:nowrap;">' + esc(shortLocName(item.standortName || item.standortId)) + '</td>' +
          '<td><span class="badge ' + getAuditModuleBadgeClass(item.modul) + '">' + esc(item.modul) + '</span></td>' +
          '<td style="white-space:nowrap;font-family:var(--font-sans);font-size:11.5px;font-weight:600;color:var(--os-cream);">' + esc(item.aktion) + '</td>' +
          '<td style="font-size:12px;color:var(--os-silk);max-width:420px;word-break:break-word;">' + esc(item.detail || '—') + '</td>' +
        '</tr>'
      ).join('');
    } catch (err) {
      tbody.innerHTML = '<tr><td colspan="6">Fehler: ' + esc(err && err.message ? err.message : String(err)) + '</td></tr>';
    } finally {
      window.SonaLoader.hide();
    }
  }

  async function loadRbacTable(forceRefresh) {
    const tbody = $('rbacBody');
    if (!tbody) return;
    const cached = !forceRefresh ? ADMIN_CACHE.rbac : null;
    const hasFreshCache = !!(cached && (Date.now() - cached.ts) < ADMIN_CACHE_STALE_MS);
    if (!hasFreshCache) window.SonaLoader.show(900);
    try {
      let res;
      if (hasFreshCache) {
        res = cached.data;
        if ((Date.now() - cached.ts) > ADMIN_CACHE_FRESH_MS) {
          window.SonaApi.getRbacMatrix().then(fresh => {
            if (fresh && fresh.success) {
              ADMIN_CACHE.rbac = { ts: Date.now(), data: fresh };
              if (STATE.activeView === 'rbac') loadRbacTable(false);
            }
          }).catch(() => {});
        }
      } else {
        res = await window.SonaApi.getRbacMatrix();
        if (res && res.success) {
          ADMIN_CACHE.rbac = { ts: Date.now(), data: res };
        }
      }
      if (!res || !res.success) {
        tbody.innerHTML = '<tr><td colspan="12">' + esc((res && res.error) || 'Fehler beim Laden.') + '</td></tr>';
        return;
      }
      STATE.pendingRequests = res.pendingRequests || [];
      STATE.rbacEntries = res.entries || [];
      STATE.tabCatalog = res.tabCatalog || { rezeptur: [], einkauf: [], operations: [], performance: [], admin: [] };
      STATE.rbacLocations = (Array.isArray(res.locations) && res.locations.length)
        ? res.locations
        : window.SONA_OS_DEFAULTS.LOCATIONS;
      if (Array.isArray(res.allowedRoles) && res.allowedRoles.length) STATE.allowedRoles = res.allowedRoles;
      if (Array.isArray(res.allowedBereiche) && res.allowedBereiche.length) STATE.allowedBereiche = res.allowedBereiche;
      if (res.adminNotificationEmail) {
        STATE.adminNotificationEmail = res.adminNotificationEmail;
        const lbl = $('rbacNotifyEmailLabel');
        if (lbl) lbl.textContent = res.adminNotificationEmail;
      }

      renderOtpResultBanner();
      renderPendingRequestsSection();

      const allLocations = STATE.rbacLocations;
      tbody.innerHTML = STATE.rbacEntries.map((u, idx) => {
        const locs = u.allowedLocations || [];
        const tp = u.tabPermissions || { rezeptur: 'ALL', einkauf: 'ALL', operations: 'ALL', performance: 'ALL', admin: 'ALL' };
        const isPartial = Array.isArray(tp.rezeptur) || Array.isArray(tp.einkauf) || Array.isArray(tp.operations) || Array.isArray(tp.performance) || Array.isArray(tp.admin);
        const statusFlag = u.status && u.status !== 'ACTIVE'
          ? ' · ' + esc(u.status)
          : (u.mustChangePassword ? ' · EINMAL-PW AKTIV' : '');

        return '<tr class="rbac-main-row" data-idx="' + idx + '" data-uid="' + esc(u.userId) + '">' +
          '<td>' +
            '<b>' + esc(u.displayName) + '</b>' +
            (u.email ? '<div class="rbac-user-email">' + esc(u.email) + '</div>' : '') +
            '<div style="font-size:10.5px;color:var(--os-silk);">' + esc(u.userId) + statusFlag + '</div>' +
          '</td>' +
          '<td>' + esc(u.role) + '<div style="font-size:10px;color:var(--os-silk);">' + esc(u.bereich || '') + '</div></td>' +
          '<td class="chk-cell"><input type="checkbox" class="rbac-mod" data-mod="einkauf"' + (u.modules.einkauf ? ' checked' : '') + '></td>' +
          '<td class="chk-cell"><input type="checkbox" class="rbac-mod" data-mod="rezeptur"' + (u.modules.rezeptur ? ' checked' : '') + '></td>' +
          '<td class="chk-cell"><input type="checkbox" class="rbac-mod" data-mod="controlling"' + (u.modules.controlling ? ' checked' : '') + '></td>' +
          '<td class="chk-cell"><input type="checkbox" class="rbac-mod" data-mod="bestand"' + (u.modules.bestand ? ' checked' : '') + '></td>' +
          '<td class="chk-cell"><input type="checkbox" class="rbac-mod" data-mod="operations"' + (u.modules.operations !== false ? ' checked' : '') + '></td>' +
          '<td class="chk-cell"><input type="checkbox" class="rbac-mod" data-mod="events"' + (u.modules.events ? ' checked' : '') + '></td>' +
          '<td class="chk-cell"><input type="checkbox" class="rbac-mod" data-mod="performance"' + (u.modules.performance ? ' checked' : '') + '></td>' +
          '<td class="chk-cell"><input type="checkbox" class="rbac-admin"' + (u.adminMatrix ? ' checked' : '') + '></td>' +
          '<td><div class="loc-chks">' +
            allLocations.map(l =>
              '<label title="' + esc(l.name) + '"><input type="checkbox" class="rbac-loc" value="' + esc(l.id) + '"' + (locs.indexOf(l.id) !== -1 ? ' checked' : '') + '> ' + esc(l.id) + '</label>'
            ).join('') +
          '</div></td>' +
          '<td><select class="input-control rbac-level" style="height:30px;min-width:86px;">' +
            ['READ', 'WRITE', 'ADMIN'].map(lvl => '<option value="' + lvl + '"' + (u.accessLevel === lvl ? ' selected' : '') + '>' + lvl + '</option>').join('') +
          '</select></td>' +
          '<td><button type="button" class="btn btn-sm rbac-tabs-toggle" data-idx="' + idx + '">' + (isPartial ? 'Teilzugriff ▾' : 'Alle Tabs ▾') + '</button></td>' +
          '<td><div class="rbac-action-btns">' +
            '<button type="button" class="btn btn-sm rbac-edit-user-btn" data-idx="' + idx + '">Profil</button>' +
            '<button type="button" class="btn btn-primary btn-sm rbac-save-btn">Speichern</button>' +
            ((STATE.session && STATE.session.user && u.userId !== STATE.session.user.id)
              ? '<button type="button" class="btn btn-sm rbac-delete-user-btn" data-idx="' + idx + '" style="color:#f87171;border-color:rgba(248,113,113,0.35);">Löschen</button>'
              : '') +
          '</div></td>' +
        '</tr>' +
        '<tr class="rbac-tabs-row hidden" data-tabs-for="' + idx + '">' +
          '<td colspan="14">' +
            '<div class="rbac-tabs-grid">' +
              renderTabPermissionBox(idx, 'rezeptur', 'Rezepturen – Tab-Freigaben', STATE.tabCatalog.rezeptur || [], tp.rezeptur) +
              renderTabPermissionBox(idx, 'einkauf', 'Einkauf – Tab-Freigaben', STATE.tabCatalog.einkauf || [], tp.einkauf) +
              renderTabPermissionBox(idx, 'operations', 'Operations – Tab-Freigaben', STATE.tabCatalog.operations || [], tp.operations) +
              renderTabPermissionBox(idx, 'performance', 'Performance – Tab-Freigaben', STATE.tabCatalog.performance || [], tp.performance) +
              renderTabPermissionBox(idx, 'admin', 'Admin – Unterebenen', STATE.tabCatalog.admin || [], tp.admin) +
            '</div>' +
          '</td>' +
        '</tr>';
      }).join('');

      tbody.querySelectorAll('.rbac-tabs-toggle').forEach(btn => {
        btn.addEventListener('click', () => {
          const detailRow = tbody.querySelector('tr.rbac-tabs-row[data-tabs-for="' + btn.dataset.idx + '"]');
          if (detailRow) detailRow.classList.toggle('hidden');
        });
      });

      wireTabBoxToggleEvents(tbody, (box, modKey) => {
        const detailRow = box.closest('tr.rbac-tabs-row');
        if (!detailRow) return null;
        const mainRow = tbody.querySelector('tr.rbac-main-row[data-idx="' + detailRow.dataset.tabsFor + '"]');
        if (!mainRow) return null;
        return modKey === 'admin'
          ? mainRow.querySelector('.rbac-admin')
          : mainRow.querySelector('.rbac-mod[data-mod="' + modKey + '"]');
      });

      tbody.querySelectorAll('tr.rbac-main-row').forEach(tr => {
        const idx = tr.dataset.idx;
        const detailRow = tbody.querySelector('tr.rbac-tabs-row[data-tabs-for="' + idx + '"]');
        if (!detailRow) return;
        ['rezeptur', 'einkauf', 'operations', 'performance'].forEach(modKey => {
          const chk = tr.querySelector('.rbac-mod[data-mod="' + modKey + '"]');
          if (!chk) return;
          syncModuleTabBox(detailRow, modKey, chk.checked, false);
          chk.addEventListener('change', () => {
            syncModuleTabBox(detailRow, modKey, chk.checked, true);
          });
        });
        const admChk = tr.querySelector('.rbac-admin');
        if (admChk) {
          syncModuleTabBox(detailRow, 'admin', admChk.checked, false);
          admChk.addEventListener('change', () => {
            syncModuleTabBox(detailRow, 'admin', admChk.checked, true);
          });
        }
      });

      tbody.querySelectorAll('.rbac-edit-user-btn').forEach(btn => {
        btn.addEventListener('click', () => {
          const entry = STATE.rbacEntries[parseInt(btn.dataset.idx, 10)];
          if (entry) openUserProfileModal('edit', entry);
        });
      });

      tbody.querySelectorAll('.rbac-save-btn').forEach(btn => {
        btn.addEventListener('click', () => saveRbacRow(btn.closest('tr')));
      });

      tbody.querySelectorAll('.rbac-delete-user-btn').forEach(btn => {
        btn.addEventListener('click', async () => {
          const entry = STATE.rbacEntries[parseInt(btn.dataset.idx, 10)];
          if (!entry) return;
          if (!window.confirm('Profil „' + (entry.displayName || entry.email || entry.userId) + '“ wirklich dauerhaft löschen?')) {
            return;
          }
          btn.disabled = true;
          btn.textContent = 'Löscht…';
          try {
            const delRes = await window.SonaApi.deleteUser(entry.userId);
            if (!delRes || !delRes.success) {
              showToast((delRes && delRes.error) || 'Löschen fehlgeschlagen.');
              return;
            }
            ADMIN_CACHE.rbac = null;
            showToast('Profil ' + (entry.displayName || entry.userId) + ' gelöscht.');
            await loadRbacTable(true);
          } catch (eDel) {
            showToast('Verbindungsfehler: ' + (eDel && eDel.message ? eDel.message : String(eDel)));
          } finally {
            btn.disabled = false;
            btn.textContent = 'Löschen';
          }
        });
      });
    } catch (err) {
      tbody.innerHTML = '<tr><td colspan="12">Fehler: ' + esc(err.message) + '</td></tr>';
    } finally {
      window.SonaLoader.hide();
    }
  }

  async function saveRbacRow(tr) {
    if (!tr) return;
    const idx = parseInt(tr.dataset.idx, 10);
    const orig = STATE.rbacEntries[idx];
    if (!orig) return;

    const modules = {};
    tr.querySelectorAll('.rbac-mod').forEach(chk => {
      modules[chk.dataset.mod] = chk.checked;
    });
    const allowedLocations = [];
    tr.querySelectorAll('.rbac-loc').forEach(chk => {
      if (chk.checked) allowedLocations.push(chk.value);
    });
    const adminMatrix = tr.querySelector('.rbac-admin').checked;
    const accessLevel = tr.querySelector('.rbac-level').value;
    const detailRow = document.querySelector('#rbacBody tr.rbac-tabs-row[data-tabs-for="' + idx + '"]');
    const tabPermissions = readTabPermissionsFromContainer(detailRow);

    if (!allowedLocations.length) {
      showToast('Mindestens ein Standort muss aktiviert sein.');
      return;
    }

    const saveBtn = tr.querySelector('.rbac-save-btn');
    saveBtn.disabled = true;
    saveBtn.textContent = 'Speichert…';

    try {
      const res = await window.SonaApi.saveRbacRule({
        userId: orig.userId,
        displayName: orig.displayName,
        role: orig.role,
        email: orig.email || '',
        modules: modules,
        adminMatrix: adminMatrix,
        allowedLocations: allowedLocations,
        accessLevel: accessLevel,
        tabPermissions: tabPermissions
      });
      if (!res || !res.success) {
        showToast('Fehler: ' + ((res && res.error) || 'Speichern fehlgeschlagen'));
        return;
      }
      ADMIN_CACHE.rbac = null;
      showToast('Rechte für ' + orig.displayName + ' gespeichert.');
      if (orig.userId === STATE.session.user.id) {
        const refreshed = await window.SonaApi.checkSession();
        if (refreshed && refreshed.success) {
          STATE.session = Object.assign({}, STATE.session, refreshed);
          saveSessionCache(STATE.session);
          if (refreshed.mustChangePassword) {
            showForcePasswordScreen();
            return;
          }
          renderAuthenticatedShell();
          return;
        }
      }
      await loadRbacTable(true);
    } catch (err) {
      showToast('Fehler: ' + err.message);
    } finally {
      saveBtn.disabled = false;
      saveBtn.textContent = 'Speichern';
    }
  }

  function openUserProfileModal(mode, entry) {
    const modal = $('userProfileModal');
    if (!modal) return;

    const errEl = $('userModalError');
    if (errEl) {
      errEl.textContent = '';
      errEl.classList.add('hidden');
    }

    $('userModalMode').value = mode || 'create';
    $('userModalId').value = (entry && entry.userId) || '';

    const roleInput = $('userModalRole');
    const roleListEl = $('userModalRoleList');
    const bereichSel = $('userModalBereich');
    if (roleListEl) {
      const mergedRoles = STATE.allowedRoles.slice();
      (STATE.rbacRows || []).forEach(r => {
        const rr = String((r && r.role) || '').trim().toUpperCase();
        if (rr && mergedRoles.indexOf(rr) === -1) mergedRoles.push(rr);
      });
      roleListEl.innerHTML = mergedRoles.map(r => '<option value="' + esc(r) + '"></option>').join('');
    }
    bereichSel.innerHTML = STATE.allowedBereiche.map(b => '<option value="' + esc(b) + '">' + esc(b) + '</option>').join('');

    const statusSel = $('userModalStatus');
    const genOtpChk = $('userModalGenOtp');
    const genOtpLbl = $('userModalGenOtpLabel');
    const customOtpInput = $('userModalCustomOtp');
    const sendMailChk = $('userModalSendMail');
    const permsWrap = $('userModalPermsWrap');

    customOtpInput.value = '';
    sendMailChk.checked = true;

    if (mode === 'approve' && entry) {
      $('userModalTitle').textContent = 'Zugang konfigurieren & freigeben';
      $('userModalName').value = entry.displayName || '';
      $('userModalEmail').value = entry.email || '';
      roleInput.value = entry.role || 'VIEWER';
      bereichSel.value = entry.bereich || 'ALLE';
      statusSel.value = 'ACTIVE';
      $('userModalDesc').value = entry.note || '';
      genOtpChk.checked = true;
      genOtpChk.disabled = true;
      genOtpLbl.textContent = 'Einmal-Passwort automatisch generieren (bei Freigabe aktiv)';
      permsWrap.classList.remove('hidden');
      const reqLocNorm = String(entry.requestedLocation || '001').trim().padStart(3, '0');
      populateModalPermissions(
        { einkauf: false, rezeptur: true, controlling: false, bestand: false, operations: true, events: false, performance: false, adminMatrix: false },
        [reqLocNorm === '000' ? '001' : reqLocNorm],
        'READ'
      );
    } else if (mode === 'edit' && entry) {
      $('userModalTitle').textContent = 'Profil bearbeiten: ' + (entry.displayName || entry.userId);
      $('userModalName').value = entry.displayName || '';
      $('userModalEmail').value = entry.email || '';
      roleInput.value = entry.role || 'VIEWER';
      bereichSel.value = entry.bereich || 'ALLE';
      statusSel.value = entry.status === 'ACTIVE' ? 'ACTIVE' : 'DISABLED';
      $('userModalDesc').value = entry.note || '';
      genOtpChk.checked = false;
      genOtpChk.disabled = false;
      genOtpLbl.textContent = 'Neues Einmal-Passwort generieren (erzwingt Passwort-Änderung)';
      permsWrap.classList.add('hidden');
    } else {
      $('userModalTitle').textContent = 'Neuer Mitarbeiter';
      $('userModalName').value = '';
      $('userModalEmail').value = '';
      roleInput.value = 'VIEWER';
      bereichSel.value = 'ALLE';
      statusSel.value = 'ACTIVE';
      $('userModalDesc').value = '';
      genOtpChk.checked = true;
      genOtpChk.disabled = true;
      genOtpLbl.textContent = 'Einmal-Passwort automatisch generieren (bei Neuanlage aktiv)';
      permsWrap.classList.remove('hidden');
      populateModalPermissions(
        { einkauf: false, rezeptur: true, controlling: false, bestand: false, operations: true, events: false, performance: false, adminMatrix: false },
        ['001'],
        'READ'
      );
    }

    modal.classList.remove('hidden');
  }

  function populateModalPermissions(mods, defaultLocs, defaultLevel) {
    const wrap = $('userModalPermsWrap');
    if (!wrap) return;
    wrap.querySelectorAll('.user-init-mod').forEach(chk => {
      chk.checked = !!mods[chk.dataset.mod];
    });
    const locsBox = $('userModalInitLocs');
    const allLocations = STATE.rbacLocations.length ? STATE.rbacLocations : window.SONA_OS_DEFAULTS.LOCATIONS;
    const normLocs = (Array.isArray(defaultLocs) ? defaultLocs : ['001'])
      .map(v => String(v || '').trim().padStart(3, '0'))
      .filter(v => v && v !== '000');
    const effectiveLocs = normLocs.length ? normLocs : ['001'];
    locsBox.innerHTML = allLocations.map(l =>
      '<label class="rbac-tab-chip"><input type="checkbox" class="user-init-loc" value="' + esc(l.id) + '"' + (effectiveLocs.indexOf(String(l.id)) !== -1 ? ' checked' : '') + '><span>' + esc(l.name) + ' (' + esc(l.id) + ')</span></label>'
    ).join('');
    $('userModalInitLevel').value = defaultLevel || 'READ';

    const tabsBox = $('userModalInitTabs');
    tabsBox.innerHTML =
      renderTabPermissionBox('init', 'rezeptur', 'Rezepturen – Tab-Freigaben', STATE.tabCatalog.rezeptur || [], mods.rezeptur ? 'ALL' : []) +
      renderTabPermissionBox('init', 'einkauf', 'Einkauf – Tab-Freigaben', STATE.tabCatalog.einkauf || [], mods.einkauf ? 'ALL' : []) +
      renderTabPermissionBox('init', 'operations', 'Operations – Tab-Freigaben', STATE.tabCatalog.operations || [], mods.operations ? 'ALL' : []) +
      renderTabPermissionBox('init', 'performance', 'Performance – Tab-Freigaben', STATE.tabCatalog.performance || [], mods.performance ? 'ALL' : []) +
      renderTabPermissionBox('init', 'admin', 'Admin – Unterebenen', STATE.tabCatalog.admin || [], mods.adminMatrix ? 'ALL' : []);
    wireTabBoxToggleEvents(tabsBox, (box, modKey) => {
      const attr = modKey === 'admin' ? 'adminMatrix' : modKey;
      return wrap.querySelector('.user-init-mod[data-mod="' + attr + '"]');
    });

    ['rezeptur', 'einkauf', 'operations', 'performance', 'adminMatrix'].forEach(modAttr => {
      const tabModKey = modAttr === 'adminMatrix' ? 'admin' : modAttr;
      const chk = wrap.querySelector('.user-init-mod[data-mod="' + modAttr + '"]');
      if (!chk) return;
      syncModuleTabBox(tabsBox, tabModKey, chk.checked, false);
      chk.onchange = () => {
        syncModuleTabBox(tabsBox, tabModKey, chk.checked, true);
      };
    });
  }

  async function submitUserProfileModal() {
    const errEl = $('userModalError');
    const showModalErr = msg => {
      if (!errEl) return;
      if (msg) {
        errEl.textContent = msg;
        errEl.classList.remove('hidden');
        try { errEl.scrollIntoView({ behavior: 'smooth', block: 'center' }); } catch (eScroll) {}
        showToast(msg);
      } else {
        errEl.textContent = '';
        errEl.classList.add('hidden');
      }
    };

    const mode = $('userModalMode').value;
    const userId = $('userModalId').value.trim();
    const name = $('userModalName').value.trim();
    const email = $('userModalEmail').value.trim().toLowerCase();
    const role = String($('userModalRole').value || '').trim().toUpperCase();
    const bereich = $('userModalBereich').value;
    const status = $('userModalStatus').value;
    const note = $('userModalDesc').value.trim();
    const customOtp = $('userModalCustomOtp').value.trim();
    const genOtp = $('userModalGenOtp').checked;
    const sendMail = $('userModalSendMail').checked;

    if (name.length < 2) {
      showModalErr('Bitte gültigen Namen eingeben (mind. 2 Zeichen).');
      return;
    }
    if (role.length < 2 || role.length > 40) {
      showModalErr('Bitte eine gültige Rolle eingeben (2–40 Zeichen).');
      return;
    }
    if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      showModalErr('Bitte gültige Gmail / E-Mail-Adresse eingeben.');
      return;
    }
    if (customOtp && (customOtp.length < 6 || customOtp.length > 64)) {
      showModalErr('Ein vorgegebenes Einmal-Passwort muss zwischen 6 und 64 Zeichen lang sein.');
      return;
    }

    const payload = {
      userId: userId,
      name: name,
      email: email,
      role: role,
      bereich: bereich,
      status: status,
      note: note,
      generateOneTimePassword: genOtp,
      oneTimePassword: customOtp,
      sendInviteEmail: sendMail
    };

    if (mode === 'create' || mode === 'approve') {
      const modules = {};
      let adminMatrix = false;
      $('userModalPermsWrap').querySelectorAll('.user-init-mod').forEach(chk => {
        if (chk.dataset.mod === 'adminMatrix') adminMatrix = chk.checked;
        else modules[chk.dataset.mod] = chk.checked;
      });
      const allowedLocations = [];
      $('userModalInitLocs').querySelectorAll('.user-init-loc:checked').forEach(chk => allowedLocations.push(chk.value));
      if (!allowedLocations.length) {
        showModalErr('Mindestens ein Standort muss freigegeben sein.');
        return;
      }
      payload.rule = {
        modules: modules,
        adminMatrix: adminMatrix,
        allowedLocations: allowedLocations,
        accessLevel: $('userModalInitLevel').value,
        tabPermissions: readTabPermissionsFromContainer($('userModalInitTabs'))
      };
    }

    showModalErr('');
    const saveBtn = $('btnSaveUserModal');
    saveBtn.disabled = true;
    saveBtn.textContent = 'Speichert…';
    try {
      const res = await window.SonaApi.saveUser(payload);
      if (!res || !res.success) {
        showModalErr((res && res.error) || 'Speichern fehlgeschlagen.');
        return;
      }
      ADMIN_CACHE.rbac = null;
      $('userProfileModal').classList.add('hidden');
      if (res.oneTimePassword) {
        STATE.lastOtpResult = {
          displayName: res.user.displayName,
          email: res.user.email,
          password: res.oneTimePassword,
          emailSent: res.emailSent,
          emailError: res.emailError
        };
      }
      if (res.oneTimePassword && !res.emailSent) {
        showToast('Mitarbeiter gespeichert – E-Mail-Versand fehlgeschlagen (' + (res.emailError || 'siehe Banner') + ').');
      } else {
        showToast('Mitarbeiter ' + res.user.displayName + ' gespeichert.');
      }
      if (STATE.session && STATE.session.user && res.userId === STATE.session.user.id) {
        const refreshed = await window.SonaApi.checkSession();
        if (refreshed && refreshed.success) {
          STATE.session = Object.assign({}, STATE.session, refreshed);
          saveSessionCache(STATE.session);
          if (refreshed.mustChangePassword) {
            showForcePasswordScreen();
            return;
          }
          renderAuthenticatedShell();
          return;
        }
      }
      await loadRbacTable(true);
    } catch (err) {
      showModalErr('Verbindungsfehler: ' + err.message);
    } finally {
      saveBtn.disabled = false;
      saveBtn.textContent = 'Speichern';
    }
  }

  function openChangePwModal() {
    const modal = $('changePasswordModal');
    if (!modal) return;
    if ($('changePwError')) {
      $('changePwError').textContent = '';
      $('changePwError').classList.add('hidden');
    }
    if ($('changePwCurrent')) $('changePwCurrent').value = '';
    if ($('changePwNew')) $('changePwNew').value = '';
    if ($('changePwConfirm')) $('changePwConfirm').value = '';
    modal.classList.remove('hidden');
  }

  async function submitChangePwModal() {
    const curPw = ($('changePwCurrent') && $('changePwCurrent').value || '').trim();
    const newPw = ($('changePwNew') && $('changePwNew').value || '').trim();
    const confirmPw = ($('changePwConfirm') && $('changePwConfirm').value || '').trim();
    const errEl = $('changePwError');
    const showErr = msg => {
      if (!errEl) return;
      if (msg) {
        errEl.textContent = msg;
        errEl.classList.remove('hidden');
      } else {
        errEl.textContent = '';
        errEl.classList.add('hidden');
      }
    };

    if (!curPw) {
      showErr('Bitte aktuelles Passwort eingeben.');
      return;
    }
    if (newPw.length < 6 || newPw.length > 64) {
      showErr('Das neue Passwort muss zwischen 6 und 64 Zeichen lang sein.');
      return;
    }
    if (newPw !== confirmPw) {
      showErr('Die beiden neuen Passwörter stimmen nicht überein.');
      return;
    }

    showErr('');
    const saveBtn = $('btnSaveChangePwModal');
    saveBtn.disabled = true;
    try {
      const res = await window.SonaApi.changePassword(curPw, newPw);
      if (!res || !res.success || !res.token) {
        showErr((res && res.error) || 'Passwort konnte nicht geändert werden.');
        return;
      }
      window.SonaApi.setToken(res.token, window.SonaApi.isRemembered());
      STATE.session = res;
      $('changePasswordModal').classList.add('hidden');
      showToast('Passwort erfolgreich geändert.');
    } catch (err) {
      showErr('Verbindungsfehler: ' + err.message);
    } finally {
      saveBtn.disabled = false;
    }
  }

  function setForgotMessages(errMsg, okMsg) {
    const errEl = $('forgotPwError');
    const okEl = $('forgotPwSuccess');
    if (errEl) {
      if (errMsg) {
        errEl.textContent = errMsg;
        errEl.classList.remove('hidden');
      } else {
        errEl.textContent = '';
        errEl.classList.add('hidden');
      }
    }
    if (okEl) {
      if (okMsg) {
        okEl.textContent = okMsg;
        okEl.classList.remove('hidden');
      } else {
        okEl.textContent = '';
        okEl.classList.add('hidden');
      }
    }
  }

  function openForgotPwModal() {
    const modal = $('forgotPasswordModal');
    if (!modal) return;
    setForgotMessages('', '');
    const loginEmail = ($('loginEmail') && $('loginEmail').value || '').trim();
    if ($('forgotEmail')) $('forgotEmail').value = loginEmail;
    if ($('forgotCode')) $('forgotCode').value = '';
    if ($('forgotNewPw')) $('forgotNewPw').value = '';
    if ($('forgotConfirmPw')) $('forgotConfirmPw').value = '';
    $('forgotStep1Pane').classList.remove('hidden');
    $('forgotStep2Pane').classList.add('hidden');
    modal.classList.remove('hidden');
  }

  async function submitForgotStep1() {
    const email = ($('forgotEmail') && $('forgotEmail').value || '').trim().toLowerCase();
    if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      setForgotMessages('Bitte gültige Gmail / E-Mail-Adresse eingeben.', '');
      return;
    }
    setForgotMessages('', '');
    const btn = $('btnRequestResetCode');
    btn.disabled = true;
    try {
      const res = await window.SonaApi.requestPasswordReset(email);
      if (!res || !res.success) {
        setForgotMessages((res && res.error) || 'Code konnte nicht angefordert werden.', '');
        return;
      }
      setForgotMessages('', res.message || 'Bestätigungscode wurde per E-Mail gesendet.');
      $('forgotStep1Pane').classList.add('hidden');
      $('forgotStep2Pane').classList.remove('hidden');
    } catch (err) {
      setForgotMessages('Verbindungsfehler: ' + err.message, '');
    } finally {
      btn.disabled = false;
    }
  }

  async function submitForgotStep2() {
    const email = ($('forgotEmail') && $('forgotEmail').value || '').trim().toLowerCase();
    const code = ($('forgotCode') && $('forgotCode').value || '').trim();
    const newPw = ($('forgotNewPw') && $('forgotNewPw').value || '').trim();
    const confirmPw = ($('forgotConfirmPw') && $('forgotConfirmPw').value || '').trim();

    if (!/^\d{6}$/.test(code)) {
      setForgotMessages('Bitte den 6-stelligen Code aus deiner E-Mail eingeben.', '');
      return;
    }
    if (newPw.length < 6 || newPw.length > 64) {
      setForgotMessages('Das neue Passwort muss zwischen 6 und 64 Zeichen lang sein.', '');
      return;
    }
    if (newPw !== confirmPw) {
      setForgotMessages('Die beiden neuen Passwörter stimmen nicht überein.', '');
      return;
    }

    setForgotMessages('', '');
    const btn = $('btnConfirmResetPw');
    btn.disabled = true;
    try {
      const res = await window.SonaApi.confirmPasswordReset(email, code, newPw);
      if (!res || !res.success) {
        setForgotMessages((res && res.error) || 'Zurücksetzen fehlgeschlagen.', '');
        return;
      }
      $('forgotPasswordModal').classList.add('hidden');
      if ($('loginEmail')) $('loginEmail').value = email;
      if ($('loginPassword')) $('loginPassword').value = '';
      switchAuthTab('login');
      setAuthMessages('', res.message || 'Passwort gespeichert. Bitte jetzt anmelden.');
    } catch (err) {
      setForgotMessages('Verbindungsfehler: ' + err.message, '');
    } finally {
      btn.disabled = false;
    }
  }

  function bindGlobalUiEvents() {
    $('tabBtnLogin').addEventListener('click', () => switchAuthTab('login'));
    $('tabBtnRegister').addEventListener('click', () => switchAuthTab('register'));
    $('btnLoginSubmit').addEventListener('click', submitLogin);
    $('btnRegisterSubmit').addEventListener('click', submitRegisterRequest);
    $('btnForcePwSubmit').addEventListener('click', submitForcePasswordChange);
    $('btnForcePwCancel').addEventListener('click', () => lockApp('Abgemeldet.'));

    ['loginEmail', 'loginPassword'].forEach(id => {
      const el = $(id);
      if (el) {
        el.addEventListener('keydown', ev => {
          if (ev.key === 'Enter') {
            ev.preventDefault();
            submitLogin();
          }
        });
      }
    });

    ['regName', 'regEmail', 'regNote'].forEach(id => {
      const el = $(id);
      if (el) {
        el.addEventListener('keydown', ev => {
          if (ev.key === 'Enter') {
            ev.preventDefault();
            submitRegisterRequest();
          }
        });
      }
    });

    ['forcePwCurrent', 'forcePwNew', 'forcePwConfirm'].forEach(id => {
      const el = $(id);
      if (el) {
        el.addEventListener('keydown', ev => {
          if (ev.key === 'Enter') {
            ev.preventDefault();
            submitForcePasswordChange();
          }
        });
      }
    });

    const handleNavClick = ev => {
      const groupBtn = ev.target.closest('button[data-toggle-pillar]');
      if (groupBtn) {
        const pillarId = groupBtn.dataset.togglePillar;
        const grpEl = groupBtn.closest('.os-nav-group');
        const nextOpen = !(grpEl && grpEl.classList.contains('open'));
        // Akkordeon-Verhalten: alle anderen Ebenen schließen, wenn eine Ebene geöffnet wird
        Object.keys(STATE.openPillars).forEach(k => { STATE.openPillars[k] = false; });
        document.querySelectorAll('#osNavList .os-nav-group').forEach(el => {
          el.classList.remove('open');
        });
        STATE.openPillars[pillarId] = nextOpen;
        if (grpEl) grpEl.classList.toggle('open', nextOpen);
        return;
      }
      const btn = ev.target.closest('button[data-view]');
      if (!btn) return;
      if (btn.dataset.view !== 'rbac') STATE.lastOtpResult = null;
      STATE.activeView = btn.dataset.view;
      renderActiveView();
    };
    $('osNavList').addEventListener('click', handleNavClick);
    $('osMobileNav').addEventListener('click', handleNavClick);

    const handleNavPrefetch = ev => {
      const btn = ev.target && ev.target.closest
        ? ev.target.closest('button[data-view], button[data-quick-view], button.home-tile')
        : null;
      if (!btn) return;
      let targetView = btn.dataset.view || btn.dataset.quickView || '';
      if (!targetView) {
        const oc = btn.getAttribute('onclick') || '';
        const m = oc.match(/openView\(['"]([^'"]+)['"]\)/);
        if (m) targetView = m[1];
      }
      if (targetView) prefetchView(targetView);
    };
    ['osNavList', 'osMobileNav', 'osMainContent'].forEach(id => {
      const el = $(id);
      if (!el) return;
      el.addEventListener('pointerenter', handleNavPrefetch, { capture: true, passive: true });
      el.addEventListener('touchstart', handleNavPrefetch, { passive: true });
    });

    const applySidebarCollapsed = collapsed => {
      STATE.sidebarCollapsed = !!collapsed;
      const shell = $('osAppShell');
      const toggleBtn = $('btnToggleSidebar');
      if (shell) shell.classList.toggle('sidebar-collapsed', STATE.sidebarCollapsed);
      if (toggleBtn) toggleBtn.textContent = STATE.sidebarCollapsed ? '›' : '‹';
      try { localStorage.setItem('sona_os_sidebar_collapsed', STATE.sidebarCollapsed ? '1' : '0'); } catch (e) {}
    };

    try {
      if (localStorage.getItem('sona_os_sidebar_collapsed') === '1') {
        applySidebarCollapsed(true);
      }
    } catch (e) {}

    const btnToggle = $('btnToggleSidebar');
    if (btnToggle) {
      btnToggle.addEventListener('click', () => applySidebarCollapsed(!STATE.sidebarCollapsed));
    }

    const btnUserSettings = $('btnUserSettings');
    const userSettingsMenu = $('userSettingsMenu');
    const closeUserSettings = () => {
      if (userSettingsMenu) userSettingsMenu.classList.add('hidden');
      if (btnUserSettings) btnUserSettings.setAttribute('aria-expanded', 'false');
    };
    if (btnUserSettings && userSettingsMenu) {
      btnUserSettings.addEventListener('click', ev => {
        ev.stopPropagation();
        const isOpen = !userSettingsMenu.classList.contains('hidden');
        userSettingsMenu.classList.toggle('hidden', isOpen);
        btnUserSettings.setAttribute('aria-expanded', isOpen ? 'false' : 'true');
      });
      userSettingsMenu.addEventListener('click', () => closeUserSettings());
      document.addEventListener('click', ev => {
        if (!userSettingsMenu.classList.contains('hidden') && !ev.target.closest('.sidebar-user-wrap')) {
          closeUserSettings();
        }
      });
    }
    const openSupportHelp = () => {
      closeUserSettings();
      window.SonaApp.openView('support_help');
    };
    if ($('btnMenuInstallPwa')) {
      $('btnMenuInstallPwa').addEventListener('click', () => {
        closeUserSettings();
        triggerPwaInstallFlow();
      });
    }
    syncPwaInstallButtons();
    if ($('btnOpenSupportHelp')) $('btnOpenSupportHelp').addEventListener('click', openSupportHelp);
    if ($('btnTopSupportHelp')) $('btnTopSupportHelp').addEventListener('click', openSupportHelp);
    async function switchToLocation(targetLoc) {
      if (!targetLoc || (STATE.session && targetLoc === STATE.session.standortId)) {
        if ($('locationSwitcherMenu')) $('locationSwitcherMenu').classList.add('hidden');
        return;
      }
      window.SonaLoader.show(350);
      try {
        const res = await window.SonaApi.switchLocation(targetLoc);
        if (!res || !res.success || !res.token) {
          showToast('Standortwechsel blockiert: ' + ((res && res.error) || ''));
          renderAuthenticatedShell();
          return;
        }
        window.SonaApi.setToken(res.token, window.SonaApi.isRemembered());
        STATE.session = res;
        saveSessionCache(res);
        clearAllModuleCaches();
        renderAuthenticatedShell();
        showToast('Standort aktiv: ' + res.standortName);
      } catch (err) {
        showToast('Fehler beim Standortwechsel: ' + err.message);
      } finally {
        window.SonaLoader.hide();
      }
    }

    const btnBrandLoc = $('btnBrandLocation');
    const locMenu = $('locationSwitcherMenu');
    if (btnBrandLoc) {
      btnBrandLoc.addEventListener('click', ev => {
        ev.stopPropagation();
        const locs = (STATE.session && STATE.session.locations) || [];
        if (locs.length > 1 && locMenu) {
          locMenu.classList.toggle('hidden');
        } else {
          STATE.lastOtpResult = null;
          STATE.activeView = 'overview';
          renderActiveView();
        }
      });
    }
    if (locMenu) {
      locMenu.addEventListener('click', ev => {
        const item = ev.target.closest('button[data-loc-id]');
        if (!item) return;
        locMenu.classList.add('hidden');
        switchToLocation(item.dataset.locId);
      });
    }
    document.addEventListener('click', ev => {
      if (locMenu && !locMenu.classList.contains('hidden')) {
        if (!ev.target.closest('.sidebar-brand-switcher')) {
          locMenu.classList.add('hidden');
        }
      }
      const srBox = $('homeSearchResults');
      if (srBox && !srBox.classList.contains('hidden')) {
        if (!ev.target.closest('.home-search-wrap')) {
          srBox.classList.add('hidden');
        }
      }
    });

    if ($('globalLocationSelect')) {
      $('globalLocationSelect').addEventListener('change', ev => switchToLocation(ev.target.value));
    }

    if ($('btnOpenForgotPw')) $('btnOpenForgotPw').addEventListener('click', openForgotPwModal);
    if ($('btnCloseForgotModal')) $('btnCloseForgotModal').addEventListener('click', () => $('forgotPasswordModal').classList.add('hidden'));
    if ($('btnRequestResetCode')) $('btnRequestResetCode').addEventListener('click', submitForgotStep1);
    if ($('btnConfirmResetPw')) $('btnConfirmResetPw').addEventListener('click', submitForgotStep2);
    if ($('btnBackForgotStep1')) {
      $('btnBackForgotStep1').addEventListener('click', () => {
        setForgotMessages('', '');
        $('forgotStep2Pane').classList.add('hidden');
        $('forgotStep1Pane').classList.remove('hidden');
      });
    }

    $('btnOpenChangePw').addEventListener('click', openChangePwModal);
    $('btnCloseChangePwModal').addEventListener('click', () => $('changePasswordModal').classList.add('hidden'));
    $('btnCancelChangePwModal').addEventListener('click', () => $('changePasswordModal').classList.add('hidden'));
    $('btnSaveChangePwModal').addEventListener('click', submitChangePwModal);

    $('btnCloseUserModal').addEventListener('click', () => $('userProfileModal').classList.add('hidden'));
    $('btnCancelUserModal').addEventListener('click', () => $('userProfileModal').classList.add('hidden'));
    $('btnSaveUserModal').addEventListener('click', submitUserProfileModal);

    $('btnLockLogout').addEventListener('click', () => lockApp('Sitzung gesperrt.'));

    $('btnOpenGatewaySettings').addEventListener('click', () => {
      $('gatewayUrlInput').value = window.SonaApi.getGatewayUrl();
      $('gatewayModal').classList.remove('hidden');
    });
    $('btnCloseGatewayModal').addEventListener('click', () => $('gatewayModal').classList.add('hidden'));
    $('btnResetGatewayUrl').addEventListener('click', () => {
      const def = window.SonaApi.setGatewayUrl('');
      $('gatewayUrlInput').value = def;
      showToast('Standard-Gateway-URL wiederhergestellt.');
    });
    $('btnSaveGatewayUrl').addEventListener('click', () => {
      try {
        window.SonaApi.setGatewayUrl($('gatewayUrlInput').value);
        $('gatewayModal').classList.add('hidden');
        loadPublicMeta();
        showToast('Gateway-URL gespeichert.');
      } catch (err) {
        showToast(err.message);
      }
    });

    syncPwaInstallButtons();
    window.addEventListener('beforeinstallprompt', ev => {
      ev.preventDefault();
      STATE.deferredInstallPrompt = ev;
      syncPwaInstallButtons();
    });
    window.addEventListener('appinstalled', () => {
      STATE.deferredInstallPrompt = null;
      syncPwaInstallButtons();
      showToast('SONA OS wurde erfolgreich als App installiert.');
    });

    if ($('btnInstallPwa')) {
      $('btnInstallPwa').addEventListener('click', triggerPwaInstallFlow);
    }
  }

  function isPwaStandalone() {
    try {
      return (window.matchMedia && window.matchMedia('(display-mode: standalone)').matches) ||
        window.navigator.standalone === true ||
        document.referrer.indexOf('android-app://') === 0;
    } catch (e) {
      return false;
    }
  }

  function isIosDevice() {
    try {
      const ua = navigator.userAgent || '';
      return /iPad|iPhone|iPod/.test(ua) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
    } catch (e) {
      return false;
    }
  }

  function syncPwaInstallButtons() {
    const installed = isPwaStandalone();
    const menuBtn = $('btnMenuInstallPwa');
    if (menuBtn) {
      if (installed) {
        menuBtn.textContent = '✓ Bereits als App installiert';
        menuBtn.disabled = true;
        menuBtn.style.opacity = '0.6';
      } else {
        menuBtn.textContent = 'App auf Gerät installieren';
        menuBtn.disabled = false;
        menuBtn.style.opacity = '';
      }
    }
    const sideBtn = $('btnInstallPwa');
    if (sideBtn) {
      sideBtn.classList.toggle('hidden', installed || !STATE.deferredInstallPrompt);
    }
  }

  function showPwaInstallGuideModal(mode) {
    const existing = document.getElementById('pwaInstallGuideModal');
    if (existing) existing.remove();
    const isIos = mode === 'ios';
    const modal = document.createElement('div');
    modal.id = 'pwaInstallGuideModal';
    modal.className = 'modal-backdrop';
    modal.style.zIndex = '2400';
    modal.innerHTML =
      '<div class="modal-card" style="max-width:440px;">' +
        '<div class="card-head" style="margin-bottom:10px;">' +
          '<div>' +
            '<div class="kicker">App auf Gerät installieren</div>' +
            '<h3>' + (isIos ? 'iPhone / iPad (Safari)' : 'Android / Tablet') + '</h3>' +
          '</div>' +
          '<button type="button" id="btnClosePwaGuide" class="btn btn-sm">Schließen</button>' +
        '</div>' +
        (isIos
          ? '<p class="module-desc" style="margin-bottom:12px;">Apple erlaubt die Homescreen-Installation nur direkt über das Safari-Menü in 2 kurzen Schritten:</p>' +
            '<div style="display:flex;flex-direction:column;gap:8px;margin-bottom:14px;">' +
              '<div style="padding:10px 12px;border:1px solid var(--os-line);border-radius:8px;background:rgba(255,255,255,0.03);font-size:13px;"><strong>1.</strong> Unten (bzw. oben rechts auf dem iPad) auf das <strong>Teilen-Symbol (□↑)</strong> tippen</div>' +
              '<div style="padding:10px 12px;border:1px solid var(--os-line);border-radius:8px;background:rgba(255,255,255,0.03);font-size:13px;"><strong>2.</strong> <strong>„Zum Home-Bildschirm“</strong> wählen und mit <strong>„Hinzufügen“</strong> bestätigen</div>' +
            '</div>'
          : '<p class="module-desc" style="margin-bottom:12px;">Falls der automatische Dialog gerade nicht erscheint (z. B. im Inkognito-Modus), kannst du die App direkt über das Browser-Menü hinzufügen:</p>' +
            '<div style="display:flex;flex-direction:column;gap:8px;margin-bottom:14px;">' +
              '<div style="padding:10px 12px;border:1px solid var(--os-line);border-radius:8px;background:rgba(255,255,255,0.03);font-size:13px;"><strong>1.</strong> Oben rechts auf das Browser-Menü <strong>(⋮)</strong> tippen</div>' +
              '<div style="padding:10px 12px;border:1px solid var(--os-line);border-radius:8px;background:rgba(255,255,255,0.03);font-size:13px;"><strong>2.</strong> <strong>„App installieren“</strong> bzw. <strong>„Zum Startbildschirm hinzufügen“</strong> wählen</div>' +
            '</div>') +
        '<button type="button" id="btnOkPwaGuide" class="btn btn-primary" style="width:100%;">Verstanden</button>' +
      '</div>';
    document.body.appendChild(modal);
    const closeFn = () => modal.remove();
    modal.addEventListener('click', ev => { if (ev.target === modal) closeFn(); });
    const cBtn = document.getElementById('btnClosePwaGuide');
    const oBtn = document.getElementById('btnOkPwaGuide');
    if (cBtn) cBtn.addEventListener('click', closeFn);
    if (oBtn) oBtn.addEventListener('click', closeFn);
  }

  async function triggerPwaInstallFlow() {
    if (isPwaStandalone()) {
      showToast('SONA OS ist bereits als App installiert.');
      syncPwaInstallButtons();
      return;
    }
    if (STATE.deferredInstallPrompt) {
      try {
        STATE.deferredInstallPrompt.prompt();
        const choice = await STATE.deferredInstallPrompt.userChoice;
        STATE.deferredInstallPrompt = null;
        syncPwaInstallButtons();
        if (choice && choice.outcome === 'accepted') {
          showToast('SONA OS wird auf deinem Homescreen installiert!');
        }
      } catch (e) {
        showPwaInstallGuideModal(isIosDevice() ? 'ios' : 'android');
      }
      return;
    }
    showPwaInstallGuideModal(isIosDevice() ? 'ios' : 'android');
  }

  async function init() {
    window.SonaLoader.init();
    bindGlobalUiEvents();

    window.SonaApi.setUnauthorizedHandler(msg => {
      lockApp(msg || 'Sitzung abgelaufen – bitte erneut anmelden.');
    });
    window.addEventListener('offline', () => showToast('Offline – Verbindung zum SONA Gateway unterbrochen.'));
    window.addEventListener('online', () => showToast('Verbindung wiederhergestellt.'));

    let updatePopupShown = false;
    const showUpdateAvailablePopup = newLabel => {
      if (updatePopupShown || document.getElementById('sonaUpdatePopup')) return;
      updatePopupShown = true;
      const card = document.createElement('div');
      card.id = 'sonaUpdatePopup';
      card.className = 'update-popup-card';
      card.setAttribute('role', 'alertdialog');
      card.setAttribute('aria-live', 'polite');
      card.innerHTML =
        '<div class="kicker" style="margin-bottom:4px;">SONA OS · System-Update' + (newLabel ? ' (' + esc(newLabel) + ')' : '') + '</div>' +
        '<h4 class="update-popup-title">Neues Update verfügbar</h4>' +
        '<p class="update-popup-text">Eine neue Version ist bereit. Bitte lade die Seite kurz neu, damit alle aktuellen Funktionen &amp; Verbesserungen aktiv sind.</p>' +
        '<div class="update-popup-actions">' +
          '<button type="button" id="btnDismissUpdatePopup" class="btn btn-sm">Später</button>' +
          '<button type="button" id="btnReloadForUpdate" class="btn btn-primary btn-sm">Seite neu laden ↻</button>' +
        '</div>';
      document.body.appendChild(card);

      $('btnDismissUpdatePopup').addEventListener('click', () => {
        card.remove();
      });
      $('btnReloadForUpdate').addEventListener('click', async () => {
        const btn = $('btnReloadForUpdate');
        if (btn) { btn.disabled = true; btn.textContent = 'Lädt neu…'; }
        try {
          if ('caches' in window) {
            const keys = await caches.keys();
            await Promise.all(keys.map(k => caches.delete(k)));
          }
        } catch (e) {}
        window.location.reload();
      });
    };

    let lastVersionCheckMs = 0;
    const checkForAppUpdate = async () => {
      const now = Date.now();
      if (now - lastVersionCheckMs < 45000) return;
      lastVersionCheckMs = now;
      try {
        const res = await fetch('./version.json?t=' + now, { cache: 'no-store' });
        if (!res || !res.ok) return;
        const data = await res.json();
        const remoteVer = Number(data && data.version) || 0;
        const localVer = Number(window.SONA_OS_DEFAULTS && window.SONA_OS_DEFAULTS.APP_BUILD_VERSION) || 0;
        if (remoteVer > localVer) {
          showUpdateAvailablePopup(data && data.label ? String(data.label) : ('v' + remoteVer));
        }
      } catch (e) {}
    };

    if ('serviceWorker' in navigator) {
      navigator.serviceWorker.register('./sw.js').then(reg => {
        try { reg.update(); } catch (e) {}
      }).catch(() => {});
    }

    setTimeout(checkForAppUpdate, 5000);
    setInterval(checkForAppUpdate, 180000);
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'visible') {
        checkForAppUpdate();
        if (STATE.session) checkAndShowPendingDirectMessages(STATE.session);
      }
    });
    window.addEventListener('online', checkForAppUpdate);

    const existingToken = window.SonaApi.getToken();
    if (!existingToken) {
      window.SonaLoader.hide();
      loadPublicMeta();
      return;
    }

    const cachedSess = loadSessionCache();
    if (cachedSess && cachedSess.user && !cachedSess.mustChangePassword) {
      STATE.session = cachedSess;
      window.SonaLoader.hide();
      renderAuthenticatedShell();
      window.SonaApi.checkSession().then(sess => {
        if (!sess || !sess.success) {
          lockApp((sess && sess.error) || 'Sitzung abgelaufen – bitte erneut anmelden.');
          return;
        }
        const changed = !STATE.session ||
          STATE.session.standortId !== sess.standortId ||
          (STATE.session.user && sess.user && STATE.session.user.role !== sess.user.role) ||
          JSON.stringify(STATE.session.ecosystemModules || []) !== JSON.stringify(sess.ecosystemModules || []);
        STATE.session = sess;
        saveSessionCache(sess);
        if (sess.mustChangePassword) {
          showForcePasswordScreen();
          return;
        }
        if (changed) renderAuthenticatedShell();
      }).catch(() => {});
      return;
    }

    window.SonaLoader.show(200);
    try {
      const sess = await window.SonaApi.checkSession();
      if (sess && sess.success) {
        STATE.session = sess;
        saveSessionCache(sess);
        if (sess.mustChangePassword) {
          showForcePasswordScreen();
          return;
        }
        renderAuthenticatedShell();
        return;
      }
      loadPublicMeta();
    } finally {
      window.SonaLoader.hide();
    }
  }

  window.SonaApp = {
    openView: function(viewKey) {
      STATE.activeView = viewKey;
      renderActiveView();
    },
    toast: showToast
  };

  document.addEventListener('DOMContentLoaded', init);
})();
