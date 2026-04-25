(function () {
    "use strict";

    const ADDON_NAME = "FkCensor";

    function log(...args) {
        console.debug("[" + ADDON_NAME + "]", ...args);
    }

    // ─── Получение внутреннего require из webpack (Next.js / YM) ───────────────
    const webpackGlobal = window.webpackChunk_N_E;
    if (!webpackGlobal) {
        console.error("[" + ADDON_NAME + "] webpackChunk_N_E not found — wait for YM to load");
        return;
    }

    let appRequire = null;
    webpackGlobal.push([[Symbol("requireGetter__" + ADDON_NAME)], {}, (r) => { appRequire = r; }]);
    webpackGlobal.pop();

    if (!appRequire) {
        console.error("[" + ADDON_NAME + "] Failed to get appRequire");
        return;
    }

    // ─── Поиск DI-модуля по ключам экспортов ────────────────────────────────────
    function findModule(...keys) {
        for (const id in appRequire.m) {
            try {
                const mod = appRequire(id);
                const exports = Object.keys(mod);
                if (keys.every(k => exports.includes(k))) return mod;
            } catch (_) {}
        }
        return null;
    }

    const diModule = findModule("Dt", "P9", "Gr", "do");
    if (!diModule?.Dt) {
        console.error("[" + ADDON_NAME + "] DI module not found — YM may have updated, script needs refresh");
        return;
    }

    const di = diModule.Dt;
    const _originalGet = di.prototype.get;

    // ─── Хук DI.get для перехвата GetFileInfoResource ────────────────────────────
    let hooked = false;
    di.prototype.get = function () {
        const result = _originalGet.apply(this, arguments);
        if (!hooked) {
            const gfir = this.shared?.get("GetFileInfoResource");
            if (gfir) {
                hooked = true;
                di.prototype.get = _originalGet;
                hookFileInfo(gfir);
                log("Hooked GetFileInfoResource ✓");
            }
        }
        return result;
    };

    // ─── Перехват метода getLocalFileDownloadInfo ────────────────────────────────
    function hookFileInfo(gfir) {
        const _orig = gfir.getLocalFileDownloadInfo;
        gfir.getLocalFileDownloadInfo = async function (trackId) {
            const replacement = getReplacementUrl(trackId);
            if (replacement) {
                log("Track " + trackId + " → " + replacement);
                return { trackId, urls: [replacement] };
            }
            return _orig.apply(this, arguments);
        };

        const _origIsDownloaded = gfir.isTrackDownloaded;
        gfir.isTrackDownloaded = async function (trackId) {
            if (getReplacementUrl(trackId)) return true;
            return _origIsDownloaded.apply(this, arguments);
        };
    }

    // ─── Хранилище подмен ────────────────────────────────────────────────────────
    // Формат: { "trackId": "http://localhost:PORT/track/trackId" }
    // Go-сервер отдаёт файл по этому URL
    let replacements = {};

    function getReplacementUrl(trackId) {
        if (!trackId) return null;
        return replacements[String(trackId)] || null;
    }

    // ─── Синхронизация с Go-сервером ─────────────────────────────────────────────
    // Go-сервер слушает на localhost:PORT и отдаёт JSON-список { "trackId": "url" }
    const SERVER_PORT = __GO_SERVER_PORT__;  // Заменяется Go-программой перед инъекцией

    async function syncReplacements() {
        try {
            const res = await fetch(`http://localhost:${SERVER_PORT}/replacements`);
            if (res.ok) {
                replacements = await res.json();
                log("Synced replacements:", Object.keys(replacements).length, "tracks");
            }
        } catch (e) {
            log("Sync failed (server not ready?):", e.message);
        }
    }

    // Первичная синхронизация + периодическое обновление раз в 3 сек
    syncReplacements();
    setInterval(syncReplacements, 3000);

    // ─── Reload плеера при смене трека (если трек уже играет) ───────────────────
    function reloadCurrentIfReplaced() {
        try {
            const e = window.sonataState?.queueState?.currentEntity?.value?.entity;
            const mp = window.sonataState?.currentMediaPlayer?.value?.currentMediaPlayer;
            if (e && mp && getReplacementUrl(e.entityData?.meta?.id)) {
                mp.reload(e);
            }
        } catch (_) {}
    }

    log("FkCensor injected ✓ server port:", SERVER_PORT);
})();
