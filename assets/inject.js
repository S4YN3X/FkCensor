/* FkCensor patched */
;(function() {
    'use strict';

    const LIST_URL = 'https://raw.githubusercontent.com/Hazzz895/FckCensorData/refs/heads/main/list.json';
    const SYNC_MS  = 10 * 60 * 1000;

    let replacements = {};

    function loadList() {
        return new Promise((resolve) => {
            try {
                const req = require('electron').net.request(LIST_URL);
                let raw = '';
                req.on('response', (res) => {
                    res.on('data', (chunk) => { raw += chunk; });
                    res.on('end', () => {
                        try {
                            replacements = JSON.parse(raw).tracks || {};
                            console.log('[FkCensor] Загружено треков:', Object.keys(replacements).length);
                        } catch(e) { console.error('[FkCensor] parse error:', e.message); }
                        resolve();
                    });
                });
                req.on('error', (e) => { console.error('[FkCensor] net error:', e.message); resolve(); });
                req.end();
            } catch(e) { console.error('[FkCensor] loadList crash:', e.message); resolve(); }
        });
    }

    function buildRendererScript(replacementsJSON) {
        return `
(function() {
    if (window.__fkCensorInjected) return;
    window.__fkCensorInjected = true;

    const replacements = ${replacementsJSON};

    function getReplacementUrl(trackId) {
        if (!trackId) return null;
        return replacements[String(trackId)] || null;
    }

    function hookFileInfo(gfir) {
        const _orig = gfir.getLocalFileDownloadInfo;
        gfir.getLocalFileDownloadInfo = async function(trackId) {
            const url = getReplacementUrl(trackId);
            if (url) {
                console.log('[FkCensor] Заменяю трек', trackId, '->', url);
                return { trackId, urls: [url] };
            }
            return _orig.apply(this, arguments);
        };

        const _origCheck = gfir.isTrackDownloaded;
        gfir.isTrackDownloaded = async function(trackId) {
            if (getReplacementUrl(trackId)) return true;
            return _origCheck.apply(this, arguments);
        };
    }

    const webpackGlobal = window.webpackChunk_N_E;
    if (!webpackGlobal) { console.error('[FkCensor] webpackChunk_N_E not found'); return; }

    let appRequire = null;
    webpackGlobal.push([[Symbol('fkCensor')], {}, (r) => { appRequire = r; }]);
    webpackGlobal.pop();
    if (!appRequire) { console.error('[FkCensor] appRequire not found'); return; }

    function findModule(...keys) {
        for (const id in appRequire.m) {
            try {
                const mod = appRequire(id);
                if (keys.every(k => k in mod)) return mod;
            } catch(_) {}
        }
        return null;
    }

    const diModule = findModule('Dt', 'P9', 'Gr', 'do');
    if (!diModule?.Dt) { console.error('[FkCensor] DI module not found'); return; }

    const di = diModule.Dt;
    const _origGet = di.prototype.get;
    let hooked = false;
    di.prototype.get = function() {
        const result = _origGet.apply(this, arguments);
        if (!hooked) {
            const gfir = this.shared?.get('GetFileInfoResource');
            if (gfir) {
                hooked = true;
                di.prototype.get = _origGet;
                hookFileInfo(gfir);
                console.log('[FkCensor] GetFileInfoResource hooked ✓');
            }
        }
        return result;
    };

    console.log('[FkCensor] Renderer inject OK, треков:', Object.keys(replacements).length);
})();
`;
    }

    function setupWebContentsHook() {
        const { app, webContents } = require('electron');

        function injectInto(wc) {
            if (wc.isDestroyed()) return;
            const script = buildRendererScript(JSON.stringify(replacements));
            wc.executeJavaScript(script).catch((e) => {
                console.error('[FkCensor] executeJavaScript error:', e.message);
            });
        }

        app.on('web-contents-created', (_, wc) => {
            wc.on('did-finish-load', () => injectInto(wc));
            wc.on('did-navigate-in-page', () => injectInto(wc));
        });

        webContents.getAllWebContents().forEach((wc) => {
            if (!wc.isDestroyed() && !wc.isLoading()) {
                injectInto(wc);
            } else {
                wc.on('did-finish-load', () => injectInto(wc));
            }
        });

        console.log('[FkCensor] webContents hook установлен');
    }

    function startSyncLoop() {
        setInterval(() => {
            loadList().then(() => {
                const { webContents } = require('electron');
                webContents.getAllWebContents().forEach((wc) => {
                    if (!wc.isDestroyed()) {
                        wc.executeJavaScript('window.__fkCensorInjected = false;').catch(() => {});
                        const script = buildRendererScript(JSON.stringify(replacements));
                        wc.executeJavaScript(script).catch(() => {});
                    }
                });
            });
        }, SYNC_MS);
    }

    function init() {
        loadList().then(() => {
            setupWebContentsHook();
            startSyncLoop();
        });
    }

    const { app } = require('electron');
    app.isReady() ? init() : app.whenReady().then(init);
})();