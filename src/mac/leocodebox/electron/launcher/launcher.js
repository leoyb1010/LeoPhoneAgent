window.__APP_VERSION__ = '1.39.4';
window.__MOCK_STATE__ = {
  localOnly: true,
  account: { connected: false, email: null, authState: 'local_only' },
  activeTarget: { kind: 'launcher', name: '启动台', url: null },
  cloudLoading: false,
  desktopSettings: { keepLocalServerRunning: false, exposeLocalServerOnNetwork: false, themeMode: 'system', globalHotkeyEnabled: false, globalHotkeyAccelerator: 'Alt+Space' },
  localWebUrl: 'http://localhost:38473',
  shareableWebUrl: 'http://localhost:38473',
  localServerRunning: false,
  localStartupLogs: [],
  environments: [],
};

(function leocodeboxLauncher() {
  var MOCK = window.__MOCK_STATE__ || {};
  var VERSION = window.__APP_VERSION__ || '';
  var LOGO_URL = new URL('../../dist/logo-32.png', window.location.href).toString();
  var SEARCH = new URLSearchParams(window.location.search || '');

  function clone(value) {
    return JSON.parse(JSON.stringify(value));
  }

  var mockState = clone(MOCK);
  var mockBridge = {
    getState: function () { return Promise.resolve(clone(mockState)); },
    openLocal: function () {
      mockState.localServerRunning = true;
	      mockState.activeTarget = { kind: 'local', name: '本地 leocodebox', url: mockState.localWebUrl };
      return Promise.resolve(clone(mockState));
    },
    openLocalWebUi: function () {
      mockState.localServerRunning = true;
      return Promise.resolve(clone(mockState));
    },
    copyLocalWebUrl: function () { return Promise.resolve(clone(mockState)); },
    openSwitch: function () { return Promise.resolve(clone(mockState)); },
	    connectCloud: function () {
	      return Promise.resolve(clone(mockState));
	    },
    disconnectCloud: function () {
      mockState.account = { connected: false, email: null };
      mockState.environments = [];
      mockState.tabs = (mockState.tabs || []).filter(function (tab) { return tab.kind !== 'remote'; });
      mockState.activeTabId = 'home';
      mockState.activeTarget = { kind: 'launcher', name: '启动台', url: null };
      return Promise.resolve(clone(mockState));
    },
    refreshEnvironments: function () { return Promise.resolve(clone(mockState)); },
    refreshActiveTab: function () { return Promise.resolve(clone(mockState)); },
    copyDiagnostics: function () { return Promise.resolve(clone(mockState)); },
    showEnvironmentPicker: function () { return Promise.resolve(clone(mockState)); },
    showLauncher: function () { return Promise.resolve(clone(mockState)); },
    showLocalSettings: function () { return Promise.resolve(clone(mockState)); },
    showDesktopSettings: function () { return Promise.resolve(clone(mockState)); },
    closeSettingsWindow: function () { return Promise.resolve(clone(mockState)); },
    showActiveEnvironmentActionsMenu: function () { return Promise.resolve(clone(mockState)); },
    openCloudDashboard: function () { return Promise.resolve(clone(mockState)); },
    runActiveEnvironmentAction: function () { return Promise.resolve(clone(mockState)); },
    switchTab: function (id) { mockState.activeTabId = id; return Promise.resolve(clone(mockState)); },
    closeTab: function (id) {
      mockState.tabs = (mockState.tabs || []).filter(function (tab) { return tab.id === 'home' || tab.id !== id; });
      if (mockState.activeTabId === id) mockState.activeTabId = 'home';
      return Promise.resolve(clone(mockState));
    },
    updateSetting: function (key, value) {
      mockState.desktopSettings = mockState.desktopSettings || {};
      mockState.desktopSettings[key] = key === 'themeMode' ? value : !!value;
      return Promise.resolve(clone(mockState));
    },
    openEnvironment: function (id) {
      var env = (mockState.environments || []).filter(function (item) { return item.id === id; })[0];
      if (env) {
        env.status = 'starting';
        setTimeout(function () {
          env.status = 'running';
          mockState.activeTarget = { kind: 'remote', id: id, name: env.name, url: env.access_url };
        }, 1700);
      }
      return Promise.resolve(clone(mockState));
    },
  };

  var bridge = window.leocodeboxDesktop || mockBridge;

  var ICONS = {
    terminal: '<polyline points="4 17 10 11 4 5"/><line x1="12" y1="19" x2="20" y2="19"/>',
    cloud: '<path d="M17.5 19a4.5 4.5 0 0 0 .5-8.97A6 6 0 0 0 6.34 9 4 4 0 0 0 7 19z"/>',
    refresh: '<polyline points="23 4 23 10 17 10"/><polyline points="1 20 1 14 7 14"/><path d="M3.51 9a9 9 0 0 1 14.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0 0 20.49 15"/>',
    settings: '<line x1="4" y1="21" x2="4" y2="14"/><line x1="4" y1="10" x2="4" y2="3"/><line x1="12" y1="21" x2="12" y2="12"/><line x1="12" y1="8" x2="12" y2="3"/><line x1="20" y1="21" x2="20" y2="16"/><line x1="20" y1="12" x2="20" y2="3"/><line x1="1" y1="14" x2="7" y2="14"/><line x1="9" y1="8" x2="15" y2="8"/><line x1="17" y1="16" x2="23" y2="16"/>',
    gear: '<circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.7 1.7 0 0 0 .34 1.88l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06A1.7 1.7 0 0 0 15 19.4a1.7 1.7 0 0 0-1 .6l-.03.08a2 2 0 1 1-3.94 0L10 20a1.7 1.7 0 0 0-1-.6 1.7 1.7 0 0 0-1.88.34l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06A1.7 1.7 0 0 0 4.6 15a1.7 1.7 0 0 0-.6-1l-.08-.03a2 2 0 1 1 0-3.94L4 10a1.7 1.7 0 0 0 .6-1 1.7 1.7 0 0 0-.34-1.88l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06A1.7 1.7 0 0 0 9 4.6a1.7 1.7 0 0 0 1-.6l.03-.08a2 2 0 1 1 3.94 0L14 4a1.7 1.7 0 0 0 1 .6 1.7 1.7 0 0 0 1.88-.34l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06A1.7 1.7 0 0 0 19.4 9c.2.36.4.7.6 1l.08.03a2 2 0 1 1 0 3.94L20 14a1.7 1.7 0 0 0-.6 1z"/>',
    play: '<polygon points="6 4 20 12 6 20 6 4"/>',
    arrow: '<line x1="7" y1="17" x2="17" y2="7"/><polyline points="8 7 17 7 17 16"/>',
    copy: '<rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/>',
    cloudPlus: '<path d="M17.5 19a4.5 4.5 0 0 0 .5-8.97A6 6 0 0 0 6.34 9 4 4 0 0 0 7 19z"/><line x1="12" y1="9" x2="12" y2="15"/><line x1="9" y1="12" x2="15" y2="12"/>',
    monitor: '<rect x="2" y="3" width="20" height="14" rx="2"/><line x1="8" y1="21" x2="16" y2="21"/><line x1="12" y1="17" x2="12" y2="21"/>',
    phone: '<rect x="7" y="2" width="10" height="20" rx="2"/><line x1="11" y1="18" x2="13" y2="18"/>',
    x: '<line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/>',
    logOut: '<path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4"/><polyline points="16 17 21 12 16 7"/><line x1="21" y1="12" x2="9" y2="12"/>',
  };
  var FILLED = { play: true };

  function icon(name, size) {
    size = size || 16;
    return '<svg width="' + size + '" height="' + size + '" viewBox="0 0 24 24" fill="' + (FILLED[name] ? 'currentColor' : 'none') + '" stroke="' + (FILLED[name] ? 'none' : 'currentColor') + '" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round">' + (ICONS[name] || '') + '</svg>';
  }

  function esc(value) {
    return String(value == null ? '' : value)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  function statusMeta(status) {
    var map = {
      running: { label: 'Running', cls: 'ok', dot: '#10b981', verb: 'Opening', open: 'Open' },
      starting: { label: 'Starting', cls: 'warn', dot: '#f59e0b', verb: 'Starting', open: 'Open', busy: true },
      stopped: { label: 'Stopped', cls: 'idle', dot: '#6b7280', verb: 'Starting', open: 'Start & open' },
      paused: { label: 'Paused', cls: 'warn', dot: '#f59e0b', verb: 'Resuming', open: 'Resume' },
    };
    return map[status] || { label: status || 'Unknown', cls: 'idle', dot: '#6b7280', verb: 'Starting', open: 'Start & open' };
  }

	  function connected(state) {
	    if (localOnly(state)) return false;
	    return !!(state && state.account && state.account.connected);
	  }

	  function localOnly(state) {
	    return !!(state && state.localOnly);
	  }

	  function authState(state) {
	    if (localOnly(state)) return 'local_only';
	    return state && state.account ? (state.account.authState || (state.account.connected ? 'connected' : 'logged_out')) : 'logged_out';
	  }

	  function accountLabel(state) {
	    if (localOnly(state)) return 'Local only';
	    if (authState(state) === 'expired') return 'Reconnect';
    if (state && state.account && state.account.email) return state.account.email;
    if (connected(state)) return 'Connected';
    return 'Local only';
  }

  function localUrl(state) {
    return (state && (state.shareableWebUrl || state.localWebUrl)) || '';
  }

  function envCount(state) {
    var count = state && state.environments ? state.environments.length : 0;
    return count + ' environment' + (count === 1 ? '' : 's');
  }

  function errMsg(error) {
    return error && error.message ? error.message : String(error);
  }

  function resolveTheme(state) {
    var settings = state && state.desktopSettings ? state.desktopSettings : {};
    var mode = settings.themeMode || 'system';
    if (mode === 'light' || mode === 'dark') return mode;
    return window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
  }

  var CC = {
    icon: icon,
    esc: esc,
    statusMeta: statusMeta,
	    connected: connected,
	    localOnly: localOnly,
	    authState: authState,
    accountLabel: accountLabel,
    localUrl: localUrl,
    envCount: envCount,
    version: VERSION,
    logoUrl: LOGO_URL,
    platform: 'win',
    state: clone(MOCK),
    ui: {},
    _busyEnv: null,
    _status: { msg: '', tone: '' },
    _reg: {},
    _wired: false,
    _poll: null,
    modalMode: SEARCH.get('modal') === '1',
  };

  window.CC = CC;

  var app;
  var overlay;

  CC.setState = function (state) {
    var currentSheet = CC.ui.openSheet || (CC.modalMode ? (CC.ui.initialSheet || 'desktop-settings') : null);
    var sheetBody = overlay ? overlay.querySelector('.cc-sheet-body') : null;
    var scrollTop = sheetBody ? sheetBody.scrollTop : 0;
    if (state && typeof state === 'object') CC.state = state;
    if (state && state.appVersion) {
      VERSION = state.appVersion;
      CC.version = VERSION;
    }
    CC.applyTheme(CC.state);
    CC.render(CC.state);
    if (currentSheet) {
      CC.openSheet(currentSheet, { scrollTop: scrollTop });
    }
  };

  CC.applyTheme = function (state) {
    var settings = state && state.desktopSettings ? state.desktopSettings : {};
    var themeMode = settings.themeMode || 'system';
    var resolvedTheme = resolveTheme(state);
    document.documentElement.setAttribute('data-theme', resolvedTheme);
    document.documentElement.setAttribute('data-theme-mode', themeMode);
  };

  CC.refresh = function () {
    return Promise.resolve(bridge.getState()).then(function (state) {
      CC.setState(state);
      return state;
    });
  };

  CC.run = function (label, fn) {
    CC._status = { msg: label, tone: 'progress' };
    CC.render(CC.state);
    return Promise.resolve()
      .then(fn)
      .then(function (state) {
        if (state && state.environments) CC.state = state;
        return CC.refresh();
      })
      .then(function () {
        CC._status = { msg: '', tone: '' };
        CC.render(CC.state);
      })
      .catch(function (error) {
        CC._status = { msg: errMsg(error), tone: 'error' };
        CC.render(CC.state);
      });
  };

  CC.startPolling = function () {
    if (CC._poll) return;
    var ticks = 0;
    CC._poll = setInterval(function () {
      ticks += 1;
      Promise.resolve(bridge.getState()).then(function (state) {
        CC.setState(state);
        var anyStarting = (state.environments || []).some(function (environment) { return environment.status === 'starting'; });
        if (!anyStarting || ticks > 16) {
          clearInterval(CC._poll);
          CC._poll = null;
          if (!anyStarting) {
            CC._status = { msg: '', tone: '' };
            CC.render(CC.state);
          }
        }
      });
    }, 1500);
  };

  CC.openEnv = function (id) {
    var env = (CC.state.environments || []).filter(function (environment) { return environment.id === id; })[0];
    var meta = statusMeta(env ? env.status : '');
    CC._busyEnv = id;
    CC._status = { msg: (meta.verb || 'Opening') + ' ' + ((env && (env.name || env.subdomain)) || 'environment') + '...', tone: 'progress' };
    if (env) {
      var tabId = 'remote:' + env.id;
      var tabs = CC.state.tabs && CC.state.tabs.length ? CC.state.tabs : [{ id: 'home', title: '启动台', kind: 'launcher', closable: false }];
      tabs = tabs.map(function (tab) {
        tab.active = false;
        return tab;
      });
      var existing = tabs.filter(function (tab) { return tab.id === tabId; })[0];
      if (existing) {
        existing.active = true;
        existing.title = env.name || env.subdomain;
      } else {
        tabs.push({ id: tabId, title: env.name || env.subdomain, kind: 'remote', closable: true, active: true });
      }
      CC.state.tabs = tabs;
      CC.state.activeTabId = tabId;
    }
    if (env && env.status !== 'running') env.status = 'starting';
    CC.render(CC.state);
    return Promise.resolve(bridge.openEnvironment(id)).then(function (state) {
      if (state && state.environments) CC.setState(state);
      CC.startPolling();
    }).catch(function (error) {
      CC._busyEnv = null;
      if (env) env.status = 'stopped';
      CC._status = { msg: errMsg(error), tone: 'error' };
      CC.render(CC.state);
    });
  };

  CC.act = function (name, node) {
    switch (name) {
      case 'local':
	        return CC.run('正在打开本地 leocodebox...', function () { return bridge.openLocal(); });
      case 'cc-switch':
        return CC.run('正在打开 Leoapi...', function () { return bridge.openSwitch(); });
	      case 'connect':
	        if (CC.localOnly(CC.state)) return;
	        return CC.run('Opening account connection...', function () { return bridge.connectCloud(); });
	      case 'logout':
	        if (CC.localOnly(CC.state)) return;
	        return CC.run('Logging out...', function () { return bridge.disconnectCloud(); });
      case 'open-web':
        return CC.run('正在浏览器中打开本机工作台...', function () { return bridge.openLocalWebUi(); });
      case 'copy-web':
        return CC.run('正在复制本机网页链接...', function () { return bridge.copyLocalWebUrl(); });
      case 'diagnostics':
        return CC.run('正在复制诊断信息...', function () { return bridge.copyDiagnostics(); });
      case 'set-setting':
        return CC.run('正在保存...', function () { return bridge.updateSetting(node.key, node.value); });
      case 'set-theme-mode':
        return CC.run('正在保存...', function () { return bridge.updateSetting('themeMode', node.value); });
      case 'settings-toggle':
        return CC.run('正在打开设置...', function () { return bridge.showDesktopSettings(); });
      case 'desktop-settings-toggle':
        return CC.run('正在打开设置...', function () { return bridge.showDesktopSettings(); });
      case 'local-settings-toggle':
        return CC.run('正在打开本机设置...', function () { return bridge.showLocalSettings(); });
      case 'settings-close':
        return CC.closeSheet();
	      case 'dashboard':
	        if (CC.localOnly(CC.state)) return;
	        return CC.run('正在打开 leocodebox 仪表盘...', function () { return bridge.openCloudDashboard(); });
	      case 'refresh-environments':
	        if (CC.localOnly(CC.state)) return;
	        return CC.run('Refreshing cloud environments...', function () { return bridge.refreshEnvironments(); });
      case 'refresh-tab':
        return CC.run('正在刷新...', function () { return bridge.refreshActiveTab(); });
      case 'env-action':
        return CC.run('Opening environment...', function () { return bridge.runActiveEnvironmentAction(node.getAttribute('data-cc-env-action')); });
      case 'env-menu':
        return CC.run('Opening environment actions...', function () { return bridge.showActiveEnvironmentActionsMenu(); });
      case 'env-row-menu':
        return CC.run('Opening environment actions...', function () { return bridge.showEnvironmentActionsMenu(node.getAttribute('data-cc-environment-id')); });
      default:
        return;
    }
  };

  function renderTabs(state) {
    var tabs = state.tabs && state.tabs.length ? state.tabs : [{ id: 'home', title: '启动台', closable: false, active: true }];
    return tabs.map(function (tab) {
      var title = tab.title || '';
      var visibleChars = Math.min(title.length, 20);
      var tabWidth = Math.max(112, Math.min(232, (visibleChars * 8) + (tab.closable ? 56 : 38)));
      return '<button class="tb-tab no-drag' + (tab.active ? ' active' : '') + '" data-cc-tab="' + esc(tab.id) + '" title="' + esc(title) + '" style="width:' + tabWidth + 'px;flex-basis:' + tabWidth + 'px">' +
        '<span>' + esc(title) + '</span>' +
        (tab.closable ? '<span class="tb-close" data-cc-close-tab="' + esc(tab.id) + '" title="Close tab">&times;</span>' : '') +
        '</button>';
    }).join('');
  }

	  CC.titlebar = function (state) {
	    var conn = connected(state);
	    var localMode = localOnly(state);
	    var activeTab = (state.tabs || []).filter(function (tab) { return tab.active; })[0] || null;
    var activeEnvironmentId = state.activeTarget && state.activeTarget.kind === 'remote' ? state.activeTarget.id : null;
    if (!activeEnvironmentId && activeTab && /^remote:/.test(activeTab.id || '')) {
      activeEnvironmentId = activeTab.id.replace(/^remote:/, '');
    }
    var activeRefreshable = (state.activeTarget && (state.activeTarget.kind === 'remote' || state.activeTarget.kind === 'local')) ||
      (activeTab && activeTab.id !== 'home');
	    var envActions = (!localMode && activeEnvironmentId) ? '<button class="btn sm tb-action no-drag" data-cc-action="env-row-menu" data-cc-environment-id="' + esc(activeEnvironmentId) + '" title="Open environment actions">Open environment in...</button>' : '';
	    var refreshAction = activeRefreshable ? '<button class="icon-btn tb-action no-drag" data-cc-action="refresh-tab" title="刷新当前页面">' + icon('refresh', 16) + '</button>' : '';
	    var accountAction = localMode ? '' : '<button class="btn sm tb-action no-drag" data-cc-action="connect" title="' + esc(authState(state) === 'expired' ? 'Reconnect your leocodebox account' : accountLabel(state)) + '"><span class="dot" style="background:' + (conn ? 'var(--ok)' : (authState(state) === 'expired' ? 'var(--warn)' : 'var(--tx3)')) + '"></span>' + esc(accountLabel(state)) + '</button>';
	    var logoutAction = (!localMode && (conn || authState(state) === 'expired')) ? '<button class="icon-btn tb-action no-drag" data-cc-action="logout" title="Logout">' + icon('logOut', 16) + '</button>' : '';
	    var navigation = localMode
	      ? '<span class="tb-context">本机 Agent 工作台</span>'
	      : '<div class="tb-tabs no-drag">' + renderTabs(state) + '</div>';
	    return '<div class="titlebar">' +
	      '<div class="brand"><img class="mk" src="' + esc(LOGO_URL) + '" alt=""><span>leocodebox</span></div>' +
      navigation +
      '<span style="flex:1"></span>' +
	      refreshAction +
	      envActions +
	      accountAction +
	      logoutAction +
      '<button class="btn sm tb-action no-drag" data-cc-action="cc-switch" title="打开 Leoapi 接口切换">Leoapi</button>' +
      '<button class="icon-btn tb-action no-drag" data-cc-action="settings-toggle" title="设置">' + icon('settings', 16) + '</button>' +
      '</div>';
  };

	  CC.statusbar = function (state) {
	    var status = CC._status || {};
	    var running = !!state.localServerRunning;
	    var accountStatus = localOnly(state) ? '' : '<span class="sep">·</span><span>' + esc(envCount(state)) + '</span>' +
	      '<span class="sep">·</span><span>' + (authState(state) === 'expired' ? 'session expired' : (connected(state) ? esc(accountLabel(state)) : 'not connected')) + '</span>';
	    return '<div class="statusbar">' +
	      '<span><span class="dot" style="width:7px;height:7px;background:' + (running ? 'var(--ok)' : 'var(--tx3)') + '"></span> 本地服务 ' + (running ? '运行中 · ' + esc(localUrl(state)) : '空闲') + '</span>' +
	      accountStatus +
	      '<span style="flex:1"></span>' +
      (status.msg ? '<span class="status-msg ' + esc(status.tone) + '">' + esc(status.msg) + '</span><span class="sep">·</span>' : '') +
      '<span>v' + esc(VERSION) + '</span>' +
      '</div>';
  };

  CC.renderSheet = function (title, subtitle, sections, footer) {
    overlay.innerHTML =
      '<div class="cc-sheet cc-modal">' +
      '<div class="cc-sheet-header">' +
      '<div class="cc-sheet-copy"><div class="cc-sheet-title">' + esc(title) + '</div><div class="cc-sheet-subtitle">' + esc(subtitle || '') + '</div></div>' +
      '<button class="icon-btn cc-sheet-close" data-cc-action="settings-close" title="关闭">' + icon('x', 16) + '</button>' +
      '</div>' +
      '<div class="cc-sheet-body">' + sections.join('') + '</div>' +
      (footer ? '<div class="cc-sheet-footer">' + footer + '</div>' : '') +
      '</div>';
  };

  CC.renderSection = function (eyebrow, title, body) {
    return '<section class="cc-section">' +
      '<div class="cc-section-head">' +
      '<div class="lbl">' + esc(eyebrow) + '</div>' +
      '<div class="cc-section-title">' + esc(title) + '</div>' +
      '</div>' +
      '<div class="cc-section-body">' + body + '</div>' +
      '</section>';
  };

  CC.renderRadioOption = function (name, value, checked, title, description) {
    return '<label class="cc-choice">' +
      '<input type="radio" name="' + esc(name) + '" value="' + esc(value) + '"' + (checked ? ' checked' : '') + '>' +
      '<span><b>' + esc(title) + '</b><br>' + esc(description) + '</span>' +
      '</label>';
  };

  CC.openSheet = function (sheet, options) {
    options = options || {};
    if (sheet === 'desktop-settings') {
      CC.renderDesktopSettings();
    } else {
      CC.renderLocalSettings();
    }
    CC.ui.openSheet = sheet;
    overlay.classList.add('open');
    if (typeof options.scrollTop === 'number') {
      var body = overlay.querySelector('.cc-sheet-body');
      if (body) body.scrollTop = options.scrollTop;
    }
  };

  CC.closeSheet = function () {
    if (CC.modalMode && bridge.closeSettingsWindow) {
      CC.ui.openSheet = null;
      return bridge.closeSettingsWindow();
    }
    CC.ui.openSheet = null;
    overlay.classList.remove('open');
  };

  CC.buildLocalServerSection = function (state, options) {
    options = options || {};
    var settings = state.desktopSettings || {};
    var keepRunning = settings.keepLocalServerRunning === true;
    var url = localUrl(state) || '按需启动';
    var body = '<div class="cc-surface">' +
      '<div class="cc-meta mono">' + esc(url) + '</div>' +
      '<p class="cc-note">' + (keepRunning
        ? 'leocodebox 打开时自动启动本地 Agent 服务；退出后服务保温运行，下次打开秒回。'
        : 'leocodebox 打开时自动启动本地 Agent 服务，退出时自动停止。') + '</p>' +
      '</div>' +
      '<div class="cc-surface cc-choice-group">' +
      CC.renderRadioOption('keep-server-running', 'off', !keepRunning, '退出即停', '完全退出 leocodebox 时停止本地服务（默认）。') +
      CC.renderRadioOption('keep-server-running', 'on', keepRunning, '退出后保温', '完全退出后保留本地服务，下次启动直接接管，实现秒开。重启服务后生效。') +
      '</div>';
    return CC.renderSection(
      options.eyebrow || '本地服务',
      options.title || '在这台 Mac 上运行 leocodebox',
      body
    );
  };

  CC.buildGlobalHotkeySection = function (state) {
    var settings = state.desktopSettings || {};
    var enabled = settings.globalHotkeyEnabled === true;
    var accelerator = settings.globalHotkeyAccelerator || 'Alt+Space';
    var body = '<div class="cc-surface">' +
      '<div class="cc-meta mono">' + esc(accelerator.replace('Alt', '⌥').replace('+', ' ')) + '</div>' +
      '<p class="cc-note">开启后可在任意应用中按 ⌥Space 快速唤起或隐藏 leocodebox。若该组合键被占用，会提示更换。</p>' +
      '</div>' +
      '<div class="cc-surface cc-choice-group">' +
      CC.renderRadioOption('global-hotkey-enabled', 'off', !enabled, '关闭', '不注册全局快捷键（默认）。') +
      CC.renderRadioOption('global-hotkey-enabled', 'on', enabled, '开启 ⌥Space', '在任意位置按 ⌥Space 显隐主窗口。') +
      '</div>';
    return CC.renderSection('全局唤醒', '⌥Space 快捷唤起', body);
  };

  CC.buildThemeSection = function (state) {
    var settings = state.desktopSettings || {};
    return CC.renderSection('外观', '桌面主题', '' +
      '<div class="cc-surface cc-choice-group">' +
      CC.renderRadioOption('desktop-theme', 'system', settings.themeMode === 'system', '跟随系统', '使用 macOS 当前外观。') +
      CC.renderRadioOption('desktop-theme', 'light', settings.themeMode === 'light', '浅色', '使用浅色界面。') +
      CC.renderRadioOption('desktop-theme', 'dark', settings.themeMode === 'dark', '深色', '使用深色界面。') +
      '</div>'
    );
  };

  CC.renderLocalSettings = function () {
    var state = CC.state || {};
    var sections = [
      CC.buildLocalServerSection(state, { includePreferences: false }),
      CC.buildGlobalHotkeySection(state),
    ];
    CC.renderSheet('本地设置', '管理 leocodebox 在这台 Mac 上的运行方式。', sections);
  };

  CC.renderDesktopSettings = function () {
    var sections = [
      CC.buildThemeSection(CC.state || {}),
    ];
    CC.renderSheet('桌面设置', '管理桌面 App 的外观。', sections);
  };

  CC.render = function (state) {
    state = state || CC.state;
    var titlebar = (CC._reg.titlebar || CC.titlebar)(state);
    var statusbar = (CC._reg.statusbar || CC.statusbar)(state);
    var body = CC._reg.renderBody ? CC._reg.renderBody(state) : '';
    if (CC.modalMode) {
      app.innerHTML = '';
    } else {
      app.innerHTML = titlebar + '<div class="cc-body ' + (CC._reg.bodyClass || '') + '">' + body + '</div>' + statusbar;
    }
    if (CC._reg.afterRender) CC._reg.afterRender(state);
  };

  function wireEvents() {
    if (CC._wired) return;
    CC._wired = true;

    document.addEventListener('click', function (event) {
      if (CC._reg.onClick && CC._reg.onClick(event)) return;
      var closeTab = event.target.closest('[data-cc-close-tab]');
      if (closeTab) {
        event.stopPropagation();
        CC.run('Closing tab...', function () { return bridge.closeTab(closeTab.getAttribute('data-cc-close-tab')); });
        return;
      }
      var tab = event.target.closest('[data-cc-tab]');
      if (tab) {
        CC.run('Switching tab...', function () { return bridge.switchTab(tab.getAttribute('data-cc-tab')); });
        return;
      }
      var action = event.target.closest('[data-cc-action]');
      if (action) {
        CC.act(action.getAttribute('data-cc-action'), action);
        return;
      }
      var env = event.target.closest('[data-cc-env]');
      if (env) {
        CC.openEnv(env.getAttribute('data-cc-env'));
        return;
      }
      if (overlay.classList.contains('open') && !event.target.closest('.cc-sheet')) {
        CC.closeSheet();
      }
    });

    document.addEventListener('change', function (event) {
      var setting = event.target.closest('[data-cc-setting]');
      if (setting) {
        CC.act('set-setting', {
          key: setting.getAttribute('data-cc-setting'),
          value: setting.checked,
        });
        return;
      }
      var theme = event.target.closest('[name="desktop-theme"]');
      if (theme) {
        CC.act('set-theme-mode', { value: theme.value });
        return;
      }
      var keepServer = event.target.closest('[name="keep-server-running"]');
      if (keepServer) {
        CC.act('set-setting', { key: 'keepLocalServerRunning', value: keepServer.value === 'on' });
        return;
      }
      var globalHotkey = event.target.closest('[name="global-hotkey-enabled"]');
      if (globalHotkey) {
        CC.act('set-setting', { key: 'globalHotkeyEnabled', value: globalHotkey.value === 'on' });
        return;
      }
    });

    document.addEventListener('keydown', function (event) {
      if (event.key === 'Escape' && overlay.classList.contains('open')) {
        CC.closeSheet();
        return;
      }
      if ((event.metaKey || event.ctrlKey) && event.key === ',') {
        event.preventDefault();
        CC.act('settings-toggle');
        return;
      }
      if (overlay.classList.contains('open')) return;
      if (CC._reg.onKey) CC._reg.onKey(event, CC.state);
    });
  }

  function boot() {
    app = document.getElementById('app');
    overlay = document.createElement('div');
    overlay.id = 'cc-overlay';
    overlay.className = 'cc-overlay';
    document.body.appendChild(overlay);

    var isMac = /Mac/i.test(navigator.platform) || /Mac OS X/i.test(navigator.userAgent);
    var isWin = /Win/i.test(navigator.platform);
    CC.platform = isMac ? 'mac' : (isWin ? 'win' : 'linux');
    document.body.classList.add(CC.platform);
    CC.ui.initialSheet = SEARCH.get('sheet') || 'desktop-settings';
    if (CC.modalMode) {
      document.documentElement.classList.add('cc-modal-window');
      document.body.classList.add('cc-modal-window');
    }

    wireEvents();
    if (window.matchMedia) {
      window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', function () {
        CC.applyTheme(CC.state);
      });
    }
    if (bridge.onStateUpdated) {
      bridge.onStateUpdated(function (state) { CC.setState(state); });
    }
    if (bridge.onLauncherCommand) {
      bridge.onLauncherCommand(function (command) {
        if (command && command.type === 'open-sheet') {
          CC.ui.initialSheet = command.sheet || CC.ui.initialSheet || 'desktop-settings';
          CC.openSheet(command.sheet);
        }
      });
    }
    CC.refresh().catch(function (error) {
      CC._status = { msg: errMsg(error), tone: 'error' };
      CC.render(CC.state);
    });
  }

  CC.register = function (registry) {
    CC._reg = registry || {};
  };

  CC.start = function () {
    if (document.readyState === 'loading') {
      document.addEventListener('DOMContentLoaded', boot);
    } else {
      boot();
    }
  };
})();

(function sidebarApp() {
  var CC = window.CC;

  function navItem(id, iconName, label, meta, selected) {
    return '<button class="sb-item' + (selected === id ? ' active' : '') + '" data-cc-nav="' + id + '">' +
      CC.icon(iconName, 16) + '<span>' + label + '</span><span class="sb-meta">' + CC.esc(meta) + '</span></button>';
  }

  function localPane(state) {
    return '<div class="pane-h"><div><h2 class="pane-title">本地服务</h2><p class="pane-sub">无需账号，直接管理这台 Mac 上的本地智能体。</p></div></div>' +
      '<div class="card"><div class="card-head"><div><div class="card-t">leocodebox 服务</div><div class="card-sub mono">' + CC.esc(CC.localUrl(state) || '打开 App 时自动启动') + '</div></div><div class="card-tools"><span class="dot" style="background:' + (state.localServerRunning ? 'var(--ok)' : 'var(--tx3)') + '"></span><button class="icon-btn" data-cc-action="local-settings-toggle" title="本地设置">' + CC.icon('gear', 16) + '</button></div></div>' +
      '<div class="card-actions"><button class="btn pri" data-cc-action="local">' + CC.icon('play', 15) + '打开 leocodebox</button><button class="btn" data-cc-action="cc-switch">' + CC.icon('settings', 15) + 'Leoapi 接口切换</button></div></div>';
  }

  function envRow(environment) {
    var meta = CC.statusMeta(environment.status);
    var tags = (environment.agent ? '<span class="tag">' + CC.esc(environment.agent) + '</span>' : '') + (environment.region ? '<span class="tag">' + CC.esc(environment.region) + '</span>' : '');
    return '<div class="env" data-cc-env="' + environment.id + '"><span class="dot" style="background:' + meta.dot + '"></span>' +
      '<div class="env-i"><div class="env-n">' + CC.esc(environment.name || environment.subdomain) + '</div><div class="env-u mono">' + CC.esc(environment.access_url || '') + '</div></div>' +
      '<div class="env-tags">' + tags + '</div>' +
      '<span class="badge ' + meta.cls + '">' + meta.label + '</span>' +
      '<button class="btn sm" data-cc-action="env-row-menu" data-cc-environment-id="' + environment.id + '">Open environment in...</button>' +
      '<button class="btn sm ' + (environment.status === 'running' ? 'pri' : '') + '">' + CC.icon(meta.busy ? 'refresh' : (environment.status === 'running' ? 'arrow' : 'play'), 14) + meta.open + '</button></div>';
  }

	  function cloudPane(state) {
	    if (CC.localOnly(state)) return localPane(state);
	    var header = '<div class="pane-h"><div><h2 class="pane-title">Environments</h2><p class="pane-sub">' + CC.esc(CC.envCount(state)) + '</p></div><button class="btn sm" data-cc-action="dashboard">' + CC.icon('arrow', 14) + 'Dashboard</button></div>';
    if (CC.authState(state) === 'expired') {
      return header + '<div class="empty">此版本只管理本机智能体。<div style="margin-top:14px"><button class="btn pri" data-cc-action="local">' + CC.icon('play', 15) + '打开本地 leocodebox</button></div></div>';
    }
    if (!CC.connected(state)) {
      return header + '<div class="empty">此版本只管理本机智能体。<div style="margin-top:14px"><button class="btn pri" data-cc-action="local">' + CC.icon('play', 15) + '打开本地 leocodebox</button></div></div>';
    }
    if (state.cloudLoading && !(state.environments || []).length) {
      return header + '<div class="empty">Loading your leocodebox environments...</div>';
    }

    var list = (state.environments || []).map(envRow).join('');
    if (!list) list = '<div class="empty">No hosted environments yet.</div>';
    return header + list;
  }

	  function renderBody(state) {
	    if (CC.localOnly(state)) {
	      CC.ui.section = 'local';
	      var localNav = '<div class="sb"><div class="sb-grp"><div class="lbl">工具</div>' +
	        navItem('local', 'terminal', '本地服务', state.localServerRunning ? '运行中' : '空闲', 'local') +
          navItem('switch', 'settings', 'Leoapi', '接口', 'local') +
	        '</div></div>';
	      return localNav + '<div class="sb-main">' + localPane(state) + '</div>';
	    }

	    var section = CC.ui.section || ((CC.connected(state) || CC.authState(state) === 'expired') ? 'cloud' : 'local');
    CC.ui.section = section;
    var nav = '<div class="sb"><div class="sb-grp"><div class="lbl">Launcher</div>' +
      navItem('local', 'terminal', 'Local servers', state.localServerRunning ? 'on' : 'idle', section) +
      navItem('switch', 'settings', 'Leoapi', '接口', section) +
      navItem('cloud', 'cloud', 'Cloud environments', (state.environments || []).length, section) +
      '</div></div>';
    return nav + '<div class="sb-main">' + (section === 'local' ? localPane(state) : cloudPane(state)) + '</div>';
  }

  function onClick(event) {
    var nav = event.target.closest('[data-cc-nav]');
    if (!nav) return false;
    if (nav.getAttribute('data-cc-nav') === 'switch') {
      CC.act('cc-switch', nav);
      return true;
    }
    CC.ui.section = nav.getAttribute('data-cc-nav');
    CC.render(CC.state);
    return true;
  }

  CC.register({
    bodyClass: 'v-sidebar',
    renderBody: renderBody,
    onClick: onClick,
  });
  CC.start();
})();
