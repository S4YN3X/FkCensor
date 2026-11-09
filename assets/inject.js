/* FkCensor patched */
;(function() {
    'use strict';

    const LIST_URL = 'https://raw.githubusercontent.com/Hazzz895/FckCensorData/refs/heads/main/list_v2.json';
    const SYNC_MS  = 10 * 60 * 1000;
    const APP_SYNC_MS = 2000;        // обмен с программой FkCensor
    const RECHECK_MS  = 60 * 1000;   // повторная проверка хранилища замен после ошибки
    // Версия аддона FckCensor, формат данных которой мы понимаем.
    // Источники из list_v2.json помечены supportedVersions относительно неё.
    const COMPAT_VERSION = '2.0.0';

    // trackId -> { url, durationMs? }
    let replacements = {};
    // Подмены метаданных из list_v2.json: названия, обложки, трек-листы альбомов, вставки в профили
    let meta = { tracks: {}, albums: {}, artists: {}, insertions: {}, trackAlbums: {} };
    // Подмена работает, только пока программа FkCensor запущена и не на паузе
    let enabledByApp = false;
    // Хранилище замен отвечает (GitHub бывает заблокирован)
    let reachable = true;
    let lastRecheck = 0;
    let pushedActive = null;

    // Папка данных FkCensor: %LOCALAPPDATA%\FkCensor в Windows, ~/Library/Application Support/FkCensor в macOS
    const DATA_DIR = process.platform === 'win32'
        ? require('path').join(process.env.LOCALAPPDATA || '', 'FkCensor')
        : require('path').join(require('os').homedir(), 'Library', 'Application Support', 'FkCensor');

    // Лог главного процесса и сообщений [FkCensor] из окна
    const LOG_PATH = require('path').join(DATA_DIR, 'ym.log');
    function log(...args) {
        const text = args.map((a) => (typeof a === 'string' ? a : (a instanceof Error ? a.message : JSON.stringify(a)))).join(' ');
        console.log('[FkCensor] ' + text);
        try { require('fs').appendFileSync(LOG_PATH, `[${new Date().toISOString()}] ${text}\n`); } catch(_) {}
    }
    try {
        require('fs').mkdirSync(require('path').dirname(LOG_PATH), { recursive: true });
        require('fs').writeFileSync(LOG_PATH, '');
    } catch(_) {}
    log('скрипт загружен в главный процесс, electron', process.versions.electron);

    function compareVersions(a, b) {
        const pa = a.split('.').map(Number);
        const pb = b.split('.').map(Number);
        for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
            const na = pa[i] || 0;
            const nb = pb[i] || 0;
            if (na !== nb) return na < nb ? -1 : 1;
        }
        return 0;
    }

    // Та же семантика, что у version-utils.ts в аддоне FckCensor
    function versionSatisfies(actual, constraint) {
        const m = String(constraint).trim().match(/^(>=|<=|!=|[><=^~])?\s*(\d+(?:\.\d+)*)$/);
        const op = m ? (m[1] || '>=') : '>=';
        const version = m ? m[2] : '0.0.0';
        const cmp = compareVersions(actual, version);

        switch (op) {
            case '>':  return cmp > 0;
            case '>=': return cmp >= 0;
            case '<':  return cmp < 0;
            case '<=': return cmp <= 0;
            case '=':  return cmp === 0;
            case '!=': return cmp !== 0;
            case '^':
            case '~': {
                if (cmp < 0) return false;
                const parts = version.split('.').map(Number);
                const [major = 0, minor = 0, patch = 0] = parts;
                let upper;
                if (op === '^') {
                    if (major > 0 || parts.length === 1) upper = `${major + 1}.0.0`;
                    else if (minor > 0 || parts.length === 2) upper = `0.${minor + 1}.0`;
                    else upper = `0.0.${patch + 1}`;
                } else {
                    upper = parts.length === 1 ? `${major + 1}.0.0` : `${major}.${minor + 1}.0`;
                }
                return compareVersions(actual, upper) < 0;
            }
            default: return false;
        }
    }

    function sourceSupported(source) {
        const sv = source.supportedVersions;
        if (!sv) return true;
        const constraints = Array.isArray(sv) ? sv : String(sv).split('&');
        return constraints.every((c) => versionSatisfies(COMPAT_VERSION, c));
    }

    function httpsify(url) {
        return url.includes('://') ? url : 'https://' + url;
    }

    // Разбор list_v2.json в плоскую карту trackId -> { url, durationMs }.
    // Приоритет как в аддоне: хранилища более поздних источников проверяются первыми,
    // внутри хранилища явная запись в tracks важнее trackIds.
    // Как MinifiedRemoteSource в аддоне: при совпадении id побеждает более ранний источник
    function mergeFirst(target, src) {
        for (const [k, v] of Object.entries(src || {})) if (!(k in target)) target[k] = v;
    }

    function parseListV2(json) {
        let storages = [];
        const m = { tracks: {}, albums: {}, artists: {}, insertions: {}, trackAlbums: {} };
        for (const source of json.sources || []) {
            if (!sourceSupported(source)) continue;
            mergeFirst(m.tracks, source.tracks);
            mergeFirst(m.albums, source.albums);
            mergeFirst(m.artists, source.artists);
            mergeFirst(m.insertions, source.artistsInsertions);
            if (Array.isArray(source.tracksStorages)) {
                storages = [...source.tracksStorages, ...storages];
            }
        }
        const setDuration = (trackId, durationMs) => {
            if (typeof durationMs === 'number') m.tracks[trackId] = Object.assign({}, m.tracks[trackId], { durationMs });
        };

        const result = {};
        for (const storage of storages) {
            const template = storage.urlTemplate;
            const fromTemplate = (raw) => {
                if (typeof raw === 'number' || (typeof raw === 'string' && !raw.includes('://'))) {
                    return template ? template.replace('%%', String(raw)) : null;
                }
                return raw;
            };

            for (const [trackId, value] of Object.entries(storage.tracks || {})) {
                if (trackId in result) continue;
                const isObj = typeof value === 'object' && value !== null;
                const url = fromTemplate(isObj ? value.url : value);
                if (typeof url === 'string' && url) {
                    result[trackId] = { url: httpsify(url), durationMs: isObj ? value.durationMs : undefined };
                    setDuration(trackId, isObj ? value.durationMs : undefined);
                }
            }

            if (!template) continue;
            for (const item of storage.trackIds || []) {
                const trackId = String(typeof item === 'number' ? item : item.id);
                if (trackId in result) continue;
                result[trackId] = {
                    url: httpsify(template.replace('%%', trackId)),
                    durationMs: typeof item === 'object' ? item.durationMs : undefined,
                };
                setDuration(trackId, typeof item === 'object' ? item.durationMs : undefined);
            }
        }
        postProcessMeta(m);
        return { replacements: result, meta: m };
    }

    const volumeId = (x) => String(x && typeof x === 'object' ? x.id : x);

    // То же, что postProcess в аддоне: треки и альбомы с подменой исполнителей попадают
    // в профили этих исполнителей, треки восстановленных альбомов наследуют обложку альбома
    function postProcessMeta(m) {
        for (const [type, map] of [['tracks', m.tracks], ['albums', m.albums]]) {
            for (const [id, e] of Object.entries(map)) {
                const fc = e.__fckCensor || {};
                if (!Array.isArray(e.artists) || !e.artists.length || fc.insertionIndex === null) continue;
                for (const a of e.artists) {
                    if (!a || !a.id) continue;
                    const ins = m.insertions[a.id] = Object.assign({ tracks: [], albums: [] }, m.insertions[a.id]);
                    ins[type] = [...(ins[type] || []), { releaseId: id, index: fc.insertionIndex }];
                }
            }
        }
        for (const [albumId, album] of Object.entries(m.albums)) {
            if (!Array.isArray(album.volumes)) continue;
            for (const vol of album.volumes) {
                for (const x of vol) {
                    const id = volumeId(x);
                    if (!(id in m.trackAlbums)) m.trackAlbums[id] = albumId;
                    const t = m.tracks[id];
                    if (album.coverUri && t && Object.keys(t).length && !('coverUri' in t)) t.coverUri = album.coverUri;
                }
            }
        }
    }

    function loadList() {
        return new Promise((resolve) => {
            try {
                const req = require('electron').net.request(LIST_URL);
                const chunks = [];
                req.on('response', (res) => {
                    res.on('data', (chunk) => { chunks.push(chunk); });
                    res.on('end', () => {
                        if (res.statusCode !== 200) {
                            log('list HTTP', res.statusCode);
                            return resolve(false);
                        }
                        try {
                            const parsed = parseListV2(JSON.parse(Buffer.concat(chunks).toString('utf8')));
                            const count = Object.keys(parsed.replacements).length;
                            if (count === 0) {
                                // Пустой результат почти наверняка значит смену формата — старый список не трогаем
                                log('list_v2: не найдено ни одного трека');
                                return resolve(false);
                            }
                            replacements = parsed.replacements;
                            meta = parsed.meta;
                            log('Загружено треков:', count, '· подмен метаданных: треков', Object.keys(meta.tracks).length,
                                'альбомов', Object.keys(meta.albums).length, 'профилей', Object.keys(meta.insertions).length);
                            resolve(true);
                        } catch(e) {
                            log('parse error:', e.message);
                            resolve(false);
                        }
                    });
                });
                req.on('error', (e) => { log('net error:', e.message); resolve(false); });
                req.end();
            } catch(e) { log('loadList crash:', e.message); resolve(false); }
        });
    }

    function isActive() {
        return enabledByApp && reachable;
    }

    function buildDataScript() {
        return `window.__fkCensorReplacements = ${JSON.stringify(replacements)}; window.__fkCensorMeta = ${JSON.stringify(meta)};` +
            ` window.__fkCensorEnabled = ${enabledByApp}; window.__fkCensorActive = ${isActive()};` +
            ' window.__fkcBadgesRefresh && window.__fkcBadgesRefresh();';
    }

    function buildRendererScript() {
        return buildDataScript() + `
(function() {
    if (window.__fkCensorInjected) return;
    window.__fkCensorInjected = true;

    // Читаем список при каждом вызове: синхронизация обновляет только window.__fkCensorReplacements
    function getReplacementUrl(trackId) {
        if (!trackId) return null;
        const local = window.__fkcLocalTracks && window.__fkcLocalTracks[String(trackId)];
        if (local && local.url && window.__fkCensorEnabled === true) return local.url;
        if (window.__fkCensorActive !== true) return null;
        const entry = (window.__fkCensorReplacements || {})[String(trackId)];
        return entry ? entry.url : null;
    }

    // Очередь замен и «сейчас играет» — главный процесс забирает их через __fkcTake()
    window.__fkcEvents = [];
    window.__fkcTake = function() {
        const events = window.__fkcEvents.splice(0);
        let nowPlaying = null;
        const ms = navigator.mediaSession;
        const m = ms && ms.metadata;
        if (m && m.title) {
            const art = (m.artwork || []).slice(-1)[0];
            nowPlaying = {
                title: m.title,
                artist: m.artist || '',
                artwork: art ? art.src : '',
                playing: ms.playbackState !== 'paused',
            };
        }
        return { events, nowPlaying };
    };


    // ---- Подмена метаданных: каждый ответ api.music.yandex.net проходит через Response.json ----
    const API_PREFIX = 'https://api.music.yandex.net/';
    const RKN_DISCLAIMER = '65256e7f0ec8594f3459e3fa';
    const EMPTY_META = { tracks: {}, albums: {}, artists: {}, insertions: {}, trackAlbums: {} };
    const getMeta = () => window.__fkCensorMeta || EMPTY_META;
    window.__fkcCovers = window.__fkcCovers || {};
    const isEmpty = (o) => !o || Object.keys(o).length === 0;
    const idOf = (x) => String(x && typeof x === 'object' ? x.id : x).split(':')[0];
    const isNum = (x) => typeof x === 'string' && /^[0-9]+$/.test(x);
    const withoutMeta = (o) => { const r = Object.assign({}, o); delete r.__fckCensor; return r; };

    function insertAt(list, item, index) {
        let i = typeof index === 'number' ? index : -1;
        i = i < 0 ? list.length + i + 1 : i;
        list.splice(Math.max(0, Math.min(list.length, i)), 0, item);
    }

    const isTrackDto = (o) => 'title' in o && (Array.isArray(o.albums) || 'durationMs' in o || 'trackSource' in o || 'storageDir' in o);
    const isAlbumDto = (o) => 'title' in o && ('trackCount' in o || 'volumes' in o || 'albumType' in o || 'metaType' in o);
    const isArtistDto = (o) => 'name' in o && !('title' in o) && ('various' in o || 'composer' in o || 'cover' in o || 'genres' in o || 'counts' in o);

    function albumSpoof(id) {
        const raw = getMeta().albums[id];
        if (!raw) return null;
        const a = withoutMeta(raw);
        // трек-лист меняем только в ответе альбома (applyAlbumVolumes), здесь — счётчики
        if (Array.isArray(a.volumes)) {
            a.trackCount = a.volumes.reduce((n, v) => n + v.length, 0);
            a.type = a.trackCount > 1 ? 'album' : 'single';
        }
        delete a.volumes;
        if (a.coverUri) {
            if (!a.ogImage) a.ogImage = a.coverUri;
            if (!a.cover) a.cover = { uri: a.coverUri };
        }
        if (a.year === undefined && a.releaseDate) a.year = new Date(a.releaseDate).getFullYear();
        else if (a.releaseDate === undefined && a.year) a.releaseDate = new Date(a.year, 0, 1, 11).toJSON();
        return isEmpty(a) ? null : a;
    }

    function applyArtist(a) {
        const s = getMeta().artists[idOf(a)];
        if (s) Object.assign(a, withoutMeta(s));
    }

    function applyAlbum(a) {
        const s = albumSpoof(idOf(a));
        if (s) Object.assign(a, s);
        // сингл: название, обложка и исполнители берутся из подмены его единственного трека
        if (Array.isArray(a.volumes) && a.volumes.length === 1 && a.volumes[0].length === 1) {
            const ts = getMeta().tracks[idOf(a.volumes[0][0])];
            if (ts) for (const k of ['coverUri', 'title', 'artists']) if (k in ts) a[k] = ts[k];
        }
        return !!s;
    }

    function applyTrack(t) {
        const id = idOf(t);
        const m = getMeta();
        const raw = m.tracks[id];
        const s = raw ? withoutMeta(raw) : {};
        // Своя подмена пользователя поверх подмены из базы
        const local = window.__fkCensorEnabled === true ? localTracks[id] : null;
        if (local && local.title) s.title = local.title;
        if (local && local.durationMs) s.durationMs = local.durationMs;
        const unblock = !!getReplacementUrl(id);
        if (isEmpty(s) && !unblock) {
            (t.artists || []).forEach(applyArtist);
            (t.albums || []).forEach(applyAlbum);
            return;
        }
        if (s.coverUri && !s.ogImage) s.ogImage = s.coverUri;
        Object.assign(t, s);
        if (unblock) {
            // недоступный трек с заменой — делаем доступным, звук подставит хук file-info
            t.available = true;
            delete t.error;
        }
        (t.artists || []).forEach(applyArtist);

        if (Array.isArray(t.albums) && t.albums.length) {
            let spoofedAlbum = Array.isArray(s.albums) && s.albums.length > 0;
            for (const a of t.albums) if (applyAlbum(a)) spoofedAlbum = true;
            if (spoofedAlbum) {
                for (const a of t.albums) {
                    const uri = (a.cover && a.cover.uri) || a.coverUri || a.ogImage;
                    if (!('coverUri' in s) && !('ogImage' in s) && uri) t.coverUri = t.ogImage = uri;
                    const fc = (m.albums[idOf(a)] || {}).__fckCensor || {};
                    if (!('artists' in s) && a.artists && fc.replaceArtistsInAlbumVolumes) t.artists = a.artists;
                }
            }
        } else {
            // у удалённых треков альбомов нет — подставляем альбом из списка, если трек в нём есть
            const albumId = m.trackAlbums[id];
            if (albumId) {
                const as = albumSpoof(albumId) || {};
                t.albums = [Object.assign({ id: Number(albumId), title: as.title || '', available: true }, as)];
                if (!t.coverUri && as.coverUri) t.coverUri = t.ogImage = as.coverUri;
            }
        }
        if (t.available && Array.isArray(t.disclaimers)) {
            t.disclaimers = t.disclaimers.filter((d) => !String(d).includes(RKN_DISCLAIMER));
        }
        // обложку, которую увидит клиент, запоминаем для истории FkCensor:
        // у удалённых треков публичный API обложки не отдаёт
        if (unblock && t.coverUri) window.__fkcCovers[id] = t.coverUri;
    }

    function walk(v, depth) {
        if (!v || typeof v !== 'object' || depth > 14) return;
        if (Array.isArray(v)) { for (const x of v) walk(x, depth + 1); return; }
        if (v.id != null) {
            if (isTrackDto(v)) applyTrack(v);
            else if (isAlbumDto(v)) applyAlbum(v);
            else if (isArtistDto(v)) applyArtist(v);
        }
        for (const k in v) {
            const x = v[k];
            if (x && typeof x === 'object') walk(x, depth + 1);
        }
    }

    function insertionsFor(artistId, type) {
        const seen = new Set();
        return ((getMeta().insertions[artistId] || {})[type] || []).filter((x) => {
            const id = String(x.releaseId);
            if (seen.has(id)) return false;
            seen.add(id);
            return true;
        });
    }

    // Публичный API Яндекс Музыки отдаёт и удалённые треки; ответ тоже пройдёт через подмену
    async function fetchTracks(ids) {
        if (!ids.length) return [];
        const r = await fetch(API_PREFIX + 'tracks?track-ids=' + ids.join(','));
        return ((await r.json()).result) || [];
    }

    async function fetchAlbums(ids) {
        if (!ids.length) return [];
        const r = await fetch(API_PREFIX + 'albums?album-ids=' + ids.join(','), { method: 'POST' });
        return ((await r.json()).result) || [];
    }

    // Трек-лист альбома из списка (возвращает удалённые треки в альбом)
    async function applyAlbumVolumes(albumId, data) {
        const raw = getMeta().albums[albumId];
        if (!raw || !Array.isArray(raw.volumes) || !data || typeof data !== 'object') return;
        const ids = raw.volumes.map((v) => v.map(idOf));
        const all = ids.flat();
        const rich = (data.volumes || []).some((v) => v.some((x) => x && typeof x === 'object' && 'title' in x));
        if (rich) {
            const have = new Map();
            (data.volumes || []).flat().forEach((t) => have.set(idOf(t), t));
            const missing = all.filter((i) => !have.has(i));
            for (const t of await fetchTracks(missing)) have.set(idOf(t), t);
            if (all.some((i) => !have.has(i))) return;
            data.volumes = ids.map((v) => v.map((i) => have.get(i)));
        } else {
            data.volumes = ids.map((v) => v.map((i) => ({ id: isNum(i) ? Number(i) : i })));
        }
        data.trackCount = all.length;
        if (data.pager) data.pager = Object.assign({}, data.pager, { page: 0, perPage: Math.max(data.pager.perPage || 0, all.length), total: all.length });
    }

    async function insertArtistTracks(artistId, data) {
        const list = Array.isArray(data) ? data : data && data.tracks;
        if (!Array.isArray(list) || (data.pager && data.pager.page > 0)) return;
        const ins = insertionsFor(artistId, 'tracks').filter((x) => !list.some((t) => idOf(t) === String(x.releaseId)));
        if (!ins.length) return;
        const fetched = await fetchTracks(ins.map((x) => String(x.releaseId)));
        let added = 0;
        for (const x of ins) {
            const t = fetched.find((f) => idOf(f) === String(x.releaseId));
            if (t) { insertAt(list, t, x.index); added++; }
        }
        if (data.pager && typeof data.pager.total === 'number') data.pager.total += added;
    }

    function insertArtistTrackIds(artistId, data) {
        const list = Array.isArray(data) ? data : data && (data.trackIds || data.ids);
        if (!Array.isArray(list)) return;
        const asNumber = typeof list[0] === 'number';
        for (const x of insertionsFor(artistId, 'tracks')) {
            const id = String(x.releaseId);
            if (list.some((y) => String(y) === id)) continue;
            insertAt(list, asNumber && isNum(id) ? Number(id) : id, x.index);
        }
    }

    async function insertArtistAlbums(artistId, data) {
        const list = Array.isArray(data) ? data : data && data.albums;
        if (!Array.isArray(list) || (data.pager && data.pager.page > 0)) return;
        const ins = insertionsFor(artistId, 'albums').filter((x) => !list.some((a) => idOf(a) === String(x.releaseId)));
        if (!ins.length) return;
        const fetched = await fetchAlbums(ins.map((x) => String(x.releaseId)));
        let added = 0;
        for (const x of ins) {
            const a = fetched.find((f) => idOf(f) === String(x.releaseId));
            if (a) { insertAt(list, a, x.index); added++; }
        }
        if (data.pager && typeof data.pager.total === 'number') data.pager.total += added;
    }

    async function processApi(url, data) {
        const path = url.slice(API_PREFIX.length).split('?')[0].split('/').filter(Boolean);
        const [root, id, sub] = path;
        if (root === 'albums' && isNum(id) && sub === 'with-tracks') await applyAlbumVolumes(id, data);
        else if (root === 'artists' && isNum(id)) {
            if (sub === 'tracks') await insertArtistTracks(id, data);
            else if (sub === 'track-ids') insertArtistTrackIds(id, data);
            else if (sub === 'direct-albums' || sub === 'safe-direct-albums') await insertArtistAlbums(id, data);
        }
        walk(data, 0);
    }

    if (!Response.prototype.__fkcPatched) {
        const origJson = Response.prototype.json;
        Response.prototype.json = async function() {
            const data = await origJson.call(this);
            if (window.__fkCensorEnabled === true && typeof this.url === 'string' && this.url.startsWith(API_PREFIX)) {
                try { await processApi(this.url, data); }
                catch (e) { console.error('[FkCensor] подмена метаданных:', e && e.message); }
            }
            return data;
        };
        Response.prototype.__fkcPatched = true;
        console.log('[FkCensor] перехват ответов API включён');
    }

    // ---- Значок FkCensor рядом с названием подменённого трека, альбома, исполнителя ----
    const SVG_NS = 'http://www.w3.org/2000/svg';
    const XLINK_NS = 'http://www.w3.org/1999/xlink';
    const BADGE_ATTR = 'data-fkc-badge';
    const BADGE_ICON = '/icons/sprite.svg#edit_xxs';

    function isTrackSpoofed(id) {
        if (window.__fkCensorEnabled !== true || !id) return false;
        return !!getReplacementUrl(id) || !!getMeta().tracks[id] || !!localTracks[id];
    }

    function trackIdFromTitle(title) {
        const a = title.querySelector('a[data-test-id="TRACK_TITLE"], a[href*="trackId="]');
        if (!a) return null;
        try { return new URL(a.getAttribute('href'), location.href).searchParams.get('trackId'); }
        catch (_) { return null; }
    }

    // Разметка как у родной метки 18+: минифицированные классы берём у неё же,
    // потому что они меняются от версии к версии клиента
    function makeBadge(label) {
        const native = document.querySelector('svg[data-test-id="EXPLICIT_MARK_ICON"]:not([data-fkc-icon])');
        const wrap = document.createElement('span');
        wrap.setAttribute(BADGE_ATTR, '');
        const svg = document.createElementNS(SVG_NS, 'svg');
        svg.setAttribute('data-fkc-icon', '');
        svg.setAttribute('focusable', 'false');
        svg.setAttribute('aria-label', label);
        svg.style.width = 'var(--ym-icon-size-xxxs)';
        svg.style.height = 'var(--ym-icon-size-xxxs)';
        if (native) {
            wrap.className = (native.parentElement && native.parentElement.className) || '';
            svg.setAttribute('class', native.getAttribute('class') || '');
        } else {
            wrap.style.cssText = 'display:inline-flex;align-items:center;margin-left:6px;flex-shrink:0;opacity:.7';
        }
        const use = document.createElementNS(SVG_NS, 'use');
        use.setAttributeNS(XLINK_NS, 'xlink:href', BADGE_ICON);
        use.setAttribute('href', BADGE_ICON);
        svg.appendChild(use);
        wrap.appendChild(svg);
        return wrap;
    }

    // Подсказка как у родных меток клиента (TooltipWithTitle): те же классы, а значения стилей
    // продублированы на случай, если классы поменяются в новой версии клиента
    let tooltipEl = null;
    let tooltipAnchor = null;

    function hideTooltip() {
        if (tooltipEl) tooltipEl.remove();
        tooltipEl = null;
        tooltipAnchor = null;
    }

    function showTooltip(anchor, text) {
        hideTooltip();
        const portal = document.createElement('div');
        portal.setAttribute('data-floating-ui-portal', '');
        portal.setAttribute(BADGE_ATTR, '');
        const root = document.createElement('div');
        root.className = 'QhR4J536RmNHBB5bZYwF TooltipWithTitle_root__7jLY3';
        root.setAttribute('role', 'tooltip');
        root.style.cssText = 'position:absolute;left:0;top:0;z-index:700;max-width:230px;padding:4px 8px;' +
            'border-radius:6px;background:rgb(41,41,41);pointer-events:none;visibility:hidden';
        const inner = document.createElement('div');
        inner.className = '_MWOVuZRvUQdXKTMcOPx Ai2iRN9elHpk_u5splD6 _3_Mxw7Si7j2g4kWjlpR Fqg1VWCJUfasVVxqICeO';
        const box = document.createElement('div');
        box.className = 'TooltipWithTitle_text__ElBtq';
        const span = document.createElement('span');
        span.className = '_MWOVuZRvUQdXKTMcOPx Ai2iRN9elHpk_u5splD6 ZYV27jeWd30QDXu4GhaH TooltipWithTitle_description__HsGcR';
        span.style.cssText = 'font-size:13px;line-height:18px;font-weight:400;color:rgba(255,255,255,.5)';
        span.textContent = text;
        box.appendChild(span);
        inner.appendChild(box);
        root.appendChild(inner);
        portal.appendChild(root);
        document.body.appendChild(portal);
        tooltipEl = portal;
        tooltipAnchor = anchor;

        // Под иконкой, по её левому краю, не вылезая за окно
        const r = anchor.getBoundingClientRect();
        const w = root.offsetWidth;
        const h = root.offsetHeight;
        let x = r.left - 4;
        let y = r.bottom + 4;
        if (x + w > innerWidth - 8) x = innerWidth - 8 - w;
        if (y + h > innerHeight - 8) y = r.top - 4 - h;
        root.style.transform = 'translate(' + Math.round(Math.max(8, x)) + 'px,' + Math.round(y) + 'px)';
        root.style.visibility = 'visible';
    }

    // Наведение ловим на уровне документа: клиент перерисовывает строку при наведении,
    // и обработчик на самом значке мог бы потеряться вместе со старым элементом
    document.addEventListener('mouseover', (e) => {
        const icon = e.target && e.target.closest ? e.target.closest('[data-fkc-icon]') : null;
        if (icon && icon !== tooltipAnchor) showTooltip(icon, icon.getAttribute('aria-label') || '');
        else if (!icon && tooltipEl) hideTooltip();
    }, true);
    addEventListener('scroll', hideTooltip, true);

    // Значок аддона FckCensor (PulseSync) уже стоит — второй не нужен
    function hasAddonBadge(el) {
        const svg = el.querySelector('[data-fckcensor-badge] svg');
        return !!svg && svg.getClientRects().length > 0;
    }

    function updateTrackTitle(title) {
        let badge = title.querySelector(':scope > [' + BADGE_ATTR + ']');
        if (!isTrackSpoofed(trackIdFromTitle(title)) || hasAddonBadge(title)) {
            if (badge) badge.remove();
            return;
        }
        if (!badge) badge = makeBadge('Трек был подменён FkCensor');
        // После названия и родных меток, но перед кнопкой меню в плеере
        const children = [...title.children].filter((c) => c !== badge);
        const options = children.slice(1).find((c) => c.tagName === 'DIV');
        if (options) { if (badge.nextElementSibling !== options) title.insertBefore(badge, options); }
        else if (title.lastElementChild !== badge) title.appendChild(badge);
    }

    function updateHeaderTitle(title, spoofed, label) {
        let badge = title.querySelector(':scope > [' + BADGE_ATTR + ']');
        if (!spoofed || hasAddonBadge(title)) {
            if (badge) badge.remove();
            return;
        }
        if (badge) return;
        title.style.display = 'flex';
        title.style.alignItems = 'center';
        title.appendChild(makeBadge(label));
    }

    function refreshBadges() {
        document.querySelectorAll('[class*="Meta_titleContainer__"]').forEach(updateTrackTitle);

        const params = new URLSearchParams(location.search);
        const m = getMeta();
        const enabled = window.__fkCensorEnabled === true;
        if (location.pathname.startsWith('/album')) {
            const albumId = params.get('albumId');
            document.querySelectorAll('[class*="CommonAlbumPage_header__"] [class*="PageHeaderTitle_stickyTitle__"]')
                .forEach((t) => updateHeaderTitle(t, enabled && !!m.albums[albumId], 'Альбом был подменён FkCensor'));
        }
        if (location.pathname.startsWith('/artist')) {
            const artistId = params.get('artistId');
            const spoofed = enabled && (!!m.artists[artistId] || insertionsFor(artistId, 'tracks').length + insertionsFor(artistId, 'albums').length > 0);
            document.querySelectorAll('[class*="ArtistPage_header__"] [class*="PageHeaderTitle_stickyTitle__"]')
                .forEach((t) => updateHeaderTitle(t, spoofed, 'Исполнитель был подменён FkCensor'));
        }
    }

    // Обновляем не чаще раза в 300 мс: клиент перерисовывает DOM постоянно (прогресс, анимации)
    let badgeTimer = null;
    function scheduleBadges() {
        if (badgeTimer) return;
        badgeTimer = setTimeout(() => {
            badgeTimer = null;
            try { refreshBadges(); } catch (e) { console.error('[FkCensor] значки:', e && e.message); }
        }, 300);
    }
    window.__fkcBadgesRefresh = scheduleBadges;

    (function startBadges() {
        if (!document.body) return setTimeout(startBadges, 200);
        new MutationObserver((mutations) => {
            // Свои значки не перезапускают обход
            // Пункт «Подменить трек» нужен сразу, пока меню открыто
            if (mutations.some((mu) => mu.addedNodes.length)) {
                try { injectTrackMenus(); } catch (e) { console.error('[FkCensor] меню:', e && e.message); }
            }
            if (mutations.every((mu) => [...mu.addedNodes, ...mu.removedNodes].every((n) => n.nodeType === 1 && n.hasAttribute && n.hasAttribute(BADGE_ATTR)) && mu.type === 'childList')) return;
            scheduleBadges();
        }).observe(document.body, { childList: true, subtree: true, attributes: true, attributeFilter: ['href'] });
        scheduleBadges();
    })();

    // ---- Своя подмена трека: пункт в меню, окно подмены, хранение файлов в IndexedDB клиента ----
    const localTracks = window.__fkcLocalTracks = window.__fkcLocalTracks || {};
    const LOCAL_DB = 'FkCensorLocal';
    const LOCAL_STORE = 'tracks';

    function idb() {
        return new Promise((resolve, reject) => {
            const req = indexedDB.open(LOCAL_DB, 1);
            req.onupgradeneeded = () => req.result.createObjectStore(LOCAL_STORE, { keyPath: 'id' });
            req.onsuccess = () => resolve(req.result);
            req.onerror = () => reject(req.error);
        });
    }

    async function idbRun(mode, fn) {
        const db = await idb();
        return new Promise((resolve, reject) => {
            const tx = db.transaction(LOCAL_STORE, mode);
            const req = fn(tx.objectStore(LOCAL_STORE));
            tx.oncomplete = () => resolve(req && req.result);
            tx.onerror = () => reject(tx.error);
        });
    }

    function rememberLocal(rec) {
        const old = localTracks[rec.id];
        if (old && old.url) URL.revokeObjectURL(old.url);
        localTracks[rec.id] = {
            title: rec.title || '',
            durationMs: rec.durationMs || 0,
            codec: rec.codec || 'mp3',
            fileName: rec.fileName || '',
            url: rec.file ? URL.createObjectURL(rec.file) : null,
        };
    }

    async function loadLocalTracks() {
        try {
            const all = await idbRun('readonly', (st) => st.getAll());
            for (const rec of all || []) rememberLocal(rec);
            if ((all || []).length) console.log('[FkCensor] своих подмен:', all.length);
            scheduleBadges();
        } catch (e) { console.error('[FkCensor] своя подмена (загрузка):', e && e.message); }
    }

    async function saveLocalTrack(rec) {
        await idbRun('readwrite', (st) => st.put(rec));
        rememberLocal(rec);
        scheduleBadges();
    }

    async function removeLocalTrack(id) {
        await idbRun('readwrite', (st) => st.delete(id));
        const old = localTracks[id];
        if (old && old.url) URL.revokeObjectURL(old.url);
        delete localTracks[id];
        scheduleBadges();
    }

    function codecFor(trackId, url) {
        const local = localTracks[String(trackId)];
        return local && local.url === url ? local.codec : 'mp3';
    }

    function codecOfFile(file) {
        const n = (file.name || '').toLowerCase();
        const t = (file.type || '').toLowerCase();
        if (n.endsWith('.flac') || t.includes('flac')) return 'flac';
        if (n.endsWith('.m4a') || n.endsWith('.mp4') || t.includes('mp4')) return 'aac-mp4';
        if (n.endsWith('.aac') || t.includes('aac')) return 'aac';
        return 'mp3';
    }

    function audioDuration(file) {
        return new Promise((resolve) => {
            const url = URL.createObjectURL(file);
            const a = new Audio();
            const done = (ms) => { URL.revokeObjectURL(url); resolve(ms); };
            a.addEventListener('loadedmetadata', () => done(isFinite(a.duration) ? Math.round(a.duration * 1000) : 0));
            a.addEventListener('error', () => done(-1));
            setTimeout(() => done(0), 8000);
            a.src = url;
        });
    }

    const fmtTime = (ms) => {
        const sec = Math.round(ms / 1000);
        return Math.floor(sec / 60) + ':' + String(sec % 60).padStart(2, '0');
    };

    // Трек, к которому относится открытое меню: кнопка «⋯» связана с меню через aria-labelledby
    function trackIdForMenu(menu) {
        const holder = menu.closest('[aria-labelledby]');
        const btn = holder && document.getElementById(holder.getAttribute('aria-labelledby'));
        if (!btn) return null;
        let scope = btn.closest('[class*="CommonTrack_root__"]') || btn.closest('[class*="CommonLayout_playerBar__"]') ||
            btn.closest('[class*="FullscreenPlayer"]');
        if (!scope) scope = btn.parentElement && btn.parentElement.parentElement && btn.parentElement.parentElement.parentElement;
        const link = scope && scope.querySelector('a[href*="trackId="]');
        if (!link) return null;
        try { return new URL(link.getAttribute('href'), location.href).searchParams.get('trackId'); }
        catch (_) { return null; }
    }

    function injectTrackMenus() {
        document.querySelectorAll('[data-test-id="TRACK_CONTEXT_MENU"]').forEach((menu) => {
            if (menu.querySelector('[data-fkc-menuitem]')) return;
            const items = [...menu.querySelectorAll('[role="menuitem"]')];
            // У аддона FckCensor (PulseSync) такой пункт уже есть — второй не нужен
            if (!items.length || items.some((i) => i.textContent.trim() === 'Подменить трек')) return;
            const trackId = trackIdForMenu(menu);
            if (!trackId) return;

            const item = items[0].cloneNode(true);
            item.removeAttribute('data-test-id');
            item.setAttribute('data-fkc-menuitem', '');
            const label = item.querySelector('span') || item;
            const icon = label.querySelector('svg');
            while (label.firstChild) label.removeChild(label.firstChild);
            if (icon) {
                const use = icon.querySelector('use');
                if (use) { use.setAttributeNS(XLINK_NS, 'xlink:href', BADGE_ICON); use.setAttribute('href', BADGE_ICON); }
                label.appendChild(icon);
            }
            label.appendChild(document.createTextNode('Подменить трек'));
            item.addEventListener('click', (e) => {
                e.preventDefault();
                e.stopPropagation();
                document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', code: 'Escape', bubbles: true }));
                openSpoofDialog(trackId);
            }, true);
            const before = items[2] || null;
            if (before) before.parentElement.insertBefore(item, before);
            else items[items.length - 1].parentElement.appendChild(item);
        });
    }

    const DIALOG_CSS = [
        '.fkc-overlay{position:fixed;inset:0;z-index:2147483000;display:flex;align-items:center;justify-content:center;',
        'background:var(--ym-background-color-primary-enabled-overlay,rgba(0,0,0,.5));font-family:inherit}',
        '.fkc-dialog{width:min(620px,calc(100vw - 48px));max-height:calc(100vh - 48px);overflow:auto;box-sizing:border-box;',
        'background:var(--ym-background-color-primary-enabled-popover,#1a1a1a);border-radius:24px;padding:20px 24px 24px;',
        'box-shadow:0 1px 20px rgba(0,0,0,.48);display:flex;flex-direction:column;gap:22px;',
        'color:var(--ym-controls-color-secondary-text-enabled_variant,#fff)}',
        '.fkc-head{display:flex;align-items:center;justify-content:space-between;gap:12px}',
        '.fkc-h{margin:0;font-family:"YS Music","YS Text",sans-serif;font-size:24px;font-weight:800;letter-spacing:-.3px;',
        'color:var(--ym-controls-color-primary-text-enabled_variant,#e6e6e6);opacity:.8}',
        '.fkc-x{width:36px;height:36px;border:0;border-radius:50%;cursor:pointer;display:flex;align-items:center;justify-content:center;',
        'background:var(--ym-controls-color-secondary-default-enabled,rgba(255,255,255,.08));color:var(--ym-controls-color-secondary-on_default-enabled,#e6e6e6)}',
        '.fkc-x:hover{background:var(--ym-controls-color-secondary-default-hovered,rgba(255,255,255,.12))}',
        '.fkc-x svg{width:18px;height:18px}',
        '.fkc-top{display:flex;gap:20px;align-items:center}',
        '.fkc-cover{width:150px;height:150px;border-radius:14px;object-fit:cover;flex-shrink:0;background:rgba(255,255,255,.08)}',
        '.fkc-field{flex:1;min-width:0;display:flex;flex-direction:column;gap:10px}',
        '.fkc-label{font-size:15px;font-weight:600;color:var(--ym-controls-color-secondary-text-enabled,rgba(255,255,255,.5))}',
        '.fkc-input{height:46px;border:0;border-radius:12px;padding:0 14px;font:inherit;font-size:15px;outline:none;box-sizing:border-box;width:100%;',
        'background:var(--ym-surface-color-primary-enabled-list,rgba(255,255,255,.08));color:var(--ym-controls-color-secondary-text-enabled_variant,#fff)}',
        '.fkc-input:focus{box-shadow:0 0 0 2px var(--ym-controls-color-primary-default-focused_stroke,rgba(255,255,0,.5))}',
        '.fkc-artists{display:flex;flex-wrap:wrap;gap:8px;padding:8px;border-radius:12px;min-height:30px;',
        'background:var(--ym-surface-color-primary-enabled-list,rgba(255,255,255,.08))}',
        '.fkc-chip{display:flex;align-items:center;gap:8px;padding:4px 12px 4px 4px;border-radius:10px;font-size:14px;font-weight:500;',
        'background:var(--ym-controls-color-secondary-default-hovered,rgba(255,255,255,.12));color:var(--ym-controls-color-secondary-on_default-enabled,#e6e6e6)}',
        '.fkc-chip img,.fkc-chip i{width:26px;height:26px;border-radius:50%;object-fit:cover;background:rgba(255,255,255,.12)}',
        '.fkc-audio{display:flex;align-items:center;gap:20px}',
        '.fkc-status{flex:1;text-align:center;font-size:14px;color:var(--ym-controls-color-secondary-text-enabled,rgba(255,255,255,.5))}',
        '.fkc-status b{color:var(--ym-controls-color-secondary-text-enabled_variant,#fff);font-weight:500}',
        '.fkc-btn{height:46px;border:0;border-radius:100px;padding:0 22px;font:inherit;font-size:14px;font-weight:600;cursor:pointer;white-space:nowrap}',
        '.fkc-primary{background:var(--ym-controls-color-primary-default-enabled,#ff0);color:var(--ym-controls-color-primary-on_default-enabled,#000)}',
        '.fkc-primary:hover{background:var(--ym-controls-color-primary-default-hovered,#dada0b)}',
        '.fkc-wide{width:280px}',
        '.fkc-secondary{background:var(--ym-controls-color-secondary-default-enabled,rgba(255,255,255,.08));color:var(--ym-controls-color-secondary-on_default-enabled,#e6e6e6)}',
        '.fkc-secondary:hover{background:var(--ym-controls-color-secondary-default-hovered,rgba(255,255,255,.12))}',
        '.fkc-btn:disabled{cursor:default;background:var(--ym-controls-color-primary-default-disabled,#333);color:var(--ym-controls-color-primary-on_default-disabled,#4d4d4d)}',
        '.fkc-foot{display:flex;justify-content:space-between;align-items:center;gap:12px;margin-top:6px}',
        '.fkc-foot-right{display:flex;gap:12px}',
        '.fkc-toast{position:fixed;left:50%;bottom:120px;transform:translateX(-50%);z-index:2147483001;padding:12px 18px;border-radius:14px;',
        'font-size:14px;background:var(--ym-background-color-primary-enabled-popover,#1a1a1a);color:var(--ym-controls-color-secondary-text-enabled_variant,#fff);',
        'box-shadow:0 1px 20px rgba(0,0,0,.48);max-width:480px;text-align:center}',
    ].join('');

    function ensureDialogCss() {
        if (document.getElementById('fkc-dialog-css')) return;
        const st = document.createElement('style');
        st.id = 'fkc-dialog-css';
        st.textContent = DIALOG_CSS;
        document.head.appendChild(st);
    }

    function el(tag, cls, text) {
        const e = document.createElement(tag);
        if (cls) e.className = cls;
        if (text != null) e.textContent = text;
        return e;
    }

    function spriteIcon(name) {
        const svg = document.createElementNS(SVG_NS, 'svg');
        const use = document.createElementNS(SVG_NS, 'use');
        use.setAttributeNS(XLINK_NS, 'xlink:href', '/icons/sprite.svg#' + name);
        use.setAttribute('href', '/icons/sprite.svg#' + name);
        svg.appendChild(use);
        return svg;
    }

    function showToast(text) {
        ensureDialogCss();
        const t = el('div', 'fkc-toast', text);
        document.body.appendChild(t);
        setTimeout(() => t.remove(), 5000);
    }

    const coverUrl = (uri, size) => uri ? (uri.includes('://') ? uri : 'https://' + uri).replace('%%', size) : '';

    async function openSpoofDialog(trackId) {
        ensureDialogCss();
        const existing = document.querySelector('.fkc-overlay');
        if (existing) existing.remove();

        let track = null;
        try { track = (await fetchTracks([trackId]))[0] || null; } catch (_) {}
        const saved = localTracks[trackId] || null;
        const shownTitle = (track && track.title) || '';
        let pickedFile = null;
        let removeAudio = false;

        const overlay = el('div', 'fkc-overlay');
        const dlg = el('div', 'fkc-dialog');
        overlay.appendChild(dlg);

        const head = el('div', 'fkc-head');
        head.appendChild(el('h2', 'fkc-h', 'Подмена трека'));
        const close = el('button', 'fkc-x');
        close.setAttribute('aria-label', 'Закрыть');
        close.appendChild(spriteIcon('close_xs'));
        head.appendChild(close);
        dlg.appendChild(head);

        const top = el('div', 'fkc-top');
        const cover = el('img', 'fkc-cover');
        const coverUri = track && (track.coverUri || (track.albums && track.albums[0] && track.albums[0].coverUri));
        if (coverUri) cover.src = coverUrl(coverUri, '400x400');
        top.appendChild(cover);
        const field = el('div', 'fkc-field');
        field.appendChild(el('div', 'fkc-label', 'Название'));
        const input = el('input', 'fkc-input');
        input.value = shownTitle;
        input.placeholder = 'Название трека';
        field.appendChild(input);
        top.appendChild(field);
        dlg.appendChild(top);

        const artistsField = el('div', 'fkc-field');
        artistsField.appendChild(el('div', 'fkc-label', 'Исполнители'));
        const artists = el('div', 'fkc-artists');
        for (const a of (track && track.artists) || []) {
            const chip = el('div', 'fkc-chip');
            const avatar = a.cover && a.cover.uri ? el('img') : el('i');
            if (a.cover && a.cover.uri) avatar.src = coverUrl(a.cover.uri, '50x50');
            chip.appendChild(avatar);
            chip.appendChild(document.createTextNode(a.name || ''));
            artists.appendChild(chip);
        }
        artistsField.appendChild(artists);
        dlg.appendChild(artistsField);

        const audio = el('div', 'fkc-audio');
        const pick = el('button', 'fkc-btn fkc-primary fkc-wide', 'Подменить аудио');
        const status = el('div', 'fkc-status');
        const fileInput = el('input');
        fileInput.type = 'file';
        fileInput.accept = 'audio/*,.mp3,.flac,.m4a,.aac,.ogg,.wav';
        fileInput.style.display = 'none';
        audio.appendChild(pick);
        audio.appendChild(status);
        audio.appendChild(fileInput);
        dlg.appendChild(audio);

        const foot = el('div', 'fkc-foot');
        const report = el('button', 'fkc-btn fkc-primary', 'Сообщить о цензуре');
        report.disabled = isReported(trackId) || hasAnySpoof(trackId);
        const right = el('div', 'fkc-foot-right');
        const del = el('button', 'fkc-btn fkc-secondary', 'Удалить подмену');
        const apply = el('button', 'fkc-btn fkc-primary', 'Применить');
        right.appendChild(del);
        right.appendChild(apply);
        foot.appendChild(report);
        foot.appendChild(right);
        dlg.appendChild(foot);

        report.addEventListener('click', async () => {
            report.disabled = true;
            const ok = await reportCensor(trackId, false, reportInfo());
            report.disabled = ok || isReported(trackId);
        });

        const hasRemote = !!((window.__fkCensorReplacements || {})[trackId]);
        const reportInfo = () => ({
            title: shownTitle,
            artists: ((track && track.artists) || []).map((a) => a.name).filter(Boolean).join(', '),
        });
        function renderStatus() {
            status.textContent = '';
            if (pickedFile) {
                status.appendChild(document.createTextNode('Будет: '));
                status.appendChild(el('b', null, pickedFile.name));
            } else if (saved && saved.url && !removeAudio) {
                status.appendChild(document.createTextNode('Свой файл: '));
                status.appendChild(el('b', null, saved.fileName || 'аудио'));
                if (saved.durationMs) status.appendChild(document.createTextNode(' · ' + fmtTime(saved.durationMs)));
            } else if (hasRemote) {
                status.textContent = 'Подменяется из базы FckCensorData.';
            } else {
                status.textContent = 'Аудио не подменяется.';
            }
            del.disabled = !saved;
        }
        renderStatus();

        const closeDialog = () => { overlay.remove(); document.removeEventListener('keydown', onKey, true); };
        const onKey = (e) => { if (e.key === 'Escape') { e.stopPropagation(); closeDialog(); } };
        document.addEventListener('keydown', onKey, true);
        close.addEventListener('click', closeDialog);
        overlay.addEventListener('mousedown', (e) => { if (e.target === overlay) closeDialog(); });

        pick.addEventListener('click', () => fileInput.click());
        fileInput.addEventListener('change', () => {
            if (fileInput.files && fileInput.files[0]) { pickedFile = fileInput.files[0]; removeAudio = false; renderStatus(); }
        });

        del.addEventListener('click', async () => {
            try {
                await removeLocalTrack(trackId);
                closeDialog();
                showToast('Подмена удалена. Если трек уже играл, включите его заново.');
            } catch (e) { showToast('Не удалось удалить подмену: ' + (e && e.message)); }
        });

        apply.addEventListener('click', async () => {
            apply.disabled = true;
            try {
                const rec = { id: trackId };
                const title = input.value.trim();
                if (title && title !== shownTitle) rec.title = title;
                else if (saved && saved.title && title === shownTitle) rec.title = saved.title;
                if (pickedFile) {
                    const durationMs = await audioDuration(pickedFile);
                    if (durationMs < 0) throw new Error('файл не похож на аудио');
                    rec.file = pickedFile;
                    rec.fileName = pickedFile.name;
                    rec.codec = codecOfFile(pickedFile);
                    if (durationMs) rec.durationMs = durationMs;
                } else if (saved && saved.url) {
                    const old = await idbRun('readonly', (st) => st.get(trackId));
                    if (old && old.file) Object.assign(rec, { file: old.file, fileName: old.fileName, codec: old.codec, durationMs: old.durationMs });
                }
                if (!rec.title && !rec.file) { closeDialog(); return; }
                await saveLocalTrack(rec);
                if (!saved) reportCensor(trackId, true, reportInfo());
                if (rec.title) {
                    document.querySelectorAll('a[data-test-id="TRACK_TITLE"]').forEach((a) => {
                        let id = null;
                        try { id = new URL(a.getAttribute('href'), location.href).searchParams.get('trackId'); } catch (_) {}
                        const span = a.querySelector('span');
                        if (id === trackId && span) span.textContent = rec.title;
                    });
                }
                closeDialog();
                showToast(rec.file ? 'Подмена сохранена. Если трек уже играл, включите его заново.' : 'Название сохранено.');
            } catch (e) {
                apply.disabled = false;
                showToast('Не удалось сохранить: ' + (e && e.message));
            }
        });

        document.body.appendChild(overlay);
        setTimeout(() => input.focus(), 0);
    }

    // ---- «Сообщить о цензуре»: как в аддоне FckCensor, в их очередь модерации (с разрешения автора) ----
    // Публичный ключ Supabase хранится так же, как в аддоне: base64 с лишними символами по краям
    const REPORT_URL = 'https://pzomqvgckpgkshxhpite.supabase.co/rest/v1/reported_tracks';
    const REPORT_KEY = 'nkrikZXlKaGJHY2lPaUpJVXpJMU5pSXNJblI1Y0NJNklrcFhWQ0o5LmV5SnBjM01pT2lKemRYQmhZbUZ6WlNJc0luSmxaaUk2SW5CNmIyMXhkbWRqYTNCbmEzTm9lR2h3YVhSbElpd2ljbTlzWlNJNkltRnViMjRpTENKcFlYUWlPakUzTnpVd05UZ3pOREVzSW1WNGNDSTZNakE1TURZek5ETTBNWDAuZ2dDeE0tdmVyM2dEV1VCV3loU0JmeTNuN3JwZFc4anRseFJRVkNYa2hOZ3x5b3VyIG1vbSBpcyBmYXR0o6O55';
    const REPORTED_STORAGE = 'fkc-reported';

    // Своя очередь модерации FkCensor (Supabase, схема в supabase/schema.sql).
    // Пока адрес пустой, сообщения уходят только в очередь FckCensor.
    const OWN_REPORT_URL = 'https://mrqlfhiqjinueibsxnof.supabase.co';
    const OWN_REPORT_KEY = 'sb_publishable_6yhyZv93vTD26vz-F4VQSQ_pN12qEMn'; // публичный: только добавление записей
    const CLIENT_ID_STORAGE = 'fkc-client-id';

    // Случайный id установки: нужен своей очереди только против повторов и спама
    function clientId() {
        try {
            let id = localStorage.getItem(CLIENT_ID_STORAGE);
            if (!id) { id = crypto.randomUUID(); localStorage.setItem(CLIENT_ID_STORAGE, id); }
            return id;
        } catch (_) { return crypto.randomUUID(); }
    }

    async function postReport(url, key, body) {
        const r = await fetch(url, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', apikey: key, Authorization: 'Bearer ' + key },
            body: JSON.stringify(body),
        });
        // 409 — с этой установки о треке уже сообщали
        return r.ok || r.status === 409;
    }

    function reportKey() {
        return atob(REPORT_KEY.slice(5, REPORT_KEY.length - 5)).split('|')[0];
    }

    function reportedSet() {
        try { return new Set(JSON.parse(localStorage.getItem(REPORTED_STORAGE) || '[]')); }
        catch (_) { return new Set(); }
    }

    function isReported(id) { return reportedSet().has('track_' + id); }

    function markReported(id) {
        const set = reportedSet();
        set.add('track_' + id);
        try { localStorage.setItem(REPORTED_STORAGE, JSON.stringify([...set])); } catch (_) {}
    }

    // replaced=true — пользователь сам подставил свой файл; тогда сообщение уходит молча, как в аддоне.
    // Сообщение уходит в очередь FckCensor и в свою, если она настроена; успех — если дошло хоть куда-то.
    async function reportCensor(id, replaced, info) {
        if (!isNum(String(id)) || isReported(id)) return false;
        const body = { track_id: Number(id), type: 'track', replaced: !!replaced };
        const jobs = [postReport(REPORT_URL, reportKey(), body)];
        if (OWN_REPORT_URL && OWN_REPORT_KEY) {
            jobs.push(postReport(OWN_REPORT_URL.replace(/[/]+$/, '') + '/rest/v1/reports', OWN_REPORT_KEY, Object.assign({}, body, {
                title: ((info && info.title) || '').slice(0, 300) || null,
                artists: ((info && info.artists) || '').slice(0, 300) || null,
                client_id: clientId(),
            })));
        }
        const results = await Promise.allSettled(jobs);
        results.forEach((r) => { if (r.status === 'rejected') console.error('[FkCensor] сообщение о цензуре:', r.reason && r.reason.message); });
        const ok = results.some((r) => r.status === 'fulfilled' && r.value);
        if (ok) markReported(id);
        if (!replaced) {
            showToast(ok ? 'Спасибо! В скором времени этот трек будет добавлен в список автоматически подменяемых.'
                : 'Не удалось сообщить о цензуре.');
        }
        return ok;
    }

    // Как в аддоне: сообщать не о чем, если трек уже подменяется (из базы или своим файлом)
    function hasAnySpoof(id) {
        return !!(window.__fkCensorReplacements || {})[id] || !!getMeta().tracks[id] || !!localTracks[id];
    }

    window.__fkcLocal = { open: openSpoofDialog, menus: injectTrackMenus, all: () => localTracks, isReported };
    loadLocalTracks();

    // Плеер получает источник звука через getFileInfo / getFileInfoBatch у ресурса file-info.
    // Ответ: { downloadInfo | fileInfo: { trackId, codec, transport, key, urls, url, ... } }
    // (в пакетном запросе — downloadInfos | fileInfos). Для треков из списка подставляем
    // свой mp3 без шифрования: transport "raw", без key.
    function makeDownloadInfo(base, trackId, url, quality) {
        const di = Object.assign({}, base && !('error' in base) ? base : {});
        delete di.key;
        return Object.assign(di, {
            trackId: String(trackId),
            realId: String(trackId),
            quality: di.quality || quality || 'nq',
            codec: codecFor(trackId, url),
            bitrate: 320,
            transport: 'raw',
            gain: false,
            urls: [url],
            url,
        });
    }

    function noteReplaced(trackId, url) {
        const id = String(trackId);
        console.log('[FkCensor] Заменяю трек', id, '->', url);
        const m = getMeta();
        const album = m.albums[m.trackAlbums[id]] || {};
        const cover = window.__fkcCovers[id] || (m.tracks[id] || {}).coverUri || album.coverUri || '';
        window.__fkcEvents.push({ trackId: id, url, cover });
    }

    function patchResource(proto) {
        if (proto.__fkcPatched) return false;
        proto.__fkcPatched = true;

        const origSingle = proto.getFileInfo;
        proto.getFileInfo = async function(params, ...rest) {
            const trackId = params && params.trackId;
            const url = getReplacementUrl(trackId);
            if (!url) return origSingle.call(this, params, ...rest);

            // Сначала настоящий ответ: из него берём остальные поля. Если трек недоступен
            // или запрос упал — собираем ответ сами.
            let res = null;
            try { res = await origSingle.call(this, params, ...rest); } catch(_) {}
            const field = res && 'fileInfo' in res ? 'fileInfo' : 'downloadInfo';
            const base = res && res[field];
            noteReplaced(trackId, url);
            return Object.assign({ responseTime: 0, url: '' }, res, { [field]: makeDownloadInfo(base, trackId, url, params.quality) });
        };

        const origBatch = proto.getFileInfoBatch;
        if (typeof origBatch === 'function') {
            proto.getFileInfoBatch = async function(params, ...rest) {
                const raw = params && params.trackIds;
                const ids = (Array.isArray(raw) ? raw : String(raw || '').split(',')).map(String).filter(Boolean);
                const hits = ids.filter((id) => getReplacementUrl(id));
                if (!hits.length) return origBatch.call(this, params, ...rest);

                let res = null;
                try { res = await origBatch.call(this, params, ...rest); } catch(_) {}
                res = res || {};
                const field = 'fileInfos' in res ? 'fileInfos' : 'downloadInfos';
                const list = Array.isArray(res[field]) ? res[field].slice() : [];
                for (const id of hits) {
                    const url = getReplacementUrl(id);
                    const i = list.findIndex((d) => d && String(d.trackId) === id);
                    const di = makeDownloadInfo(i >= 0 ? list[i] : null, id, url, params.quality);
                    if (i >= 0) list[i] = di; else list.push(di);
                }
                return Object.assign({}, res, { [field]: list });
            };
        }
        return true;
    }

    function hookFileInfo() {
    const webpackGlobal = window.webpackChunk_N_E;
    if (!webpackGlobal) return false;

    let appRequire = null;
    webpackGlobal.push([[Symbol('fkCensor')], {}, (r) => { appRequire = r; }]);
    webpackGlobal.pop();
    if (!appRequire) return false;

    // Классы ресурса ищем по адресу запроса в исходнике модуля, а не по минифицированным именам:
    // так поиск переживает пересборку клиента.
    const patched = [];
    for (const id in appRequire.m) {
        let src;
        try { src = appRequire.m[id].toString(); } catch(_) { continue; }
        if (!src.includes('"get-file-info"') && !src.includes('"resources/v2/file-info"')) continue;
        let mod;
        try { mod = appRequire(id); } catch(_) { continue; }
        for (const key in mod) {
            const C = mod[key];
            if (typeof C === 'function' && C.prototype && typeof C.prototype.getFileInfo === 'function') {
                if (patchResource(C.prototype)) patched.push(id);
            }
        }
    }
    if (!patched.length) return false;
    console.log('[FkCensor] file-info hooked ✓ (модули ' + patched.join(', ') + ')');
    return true;
    }

    let attempts = 0;
    (function tryHook() {
        if (hookFileInfo()) return;
        if (++attempts < 150) setTimeout(tryHook, 200);
        else console.error('[FkCensor] ресурс file-info не найден');
    })();

    console.log('[FkCensor] Renderer inject OK, треков:', Object.keys(window.__fkCensorReplacements || {}).length);
})();
`;
    }

    function setupWebContentsHook() {
        const { app, webContents } = require('electron');

        function injectInto(wc) {
            if (wc.isDestroyed()) return;
            const script = buildRendererScript();
            wc.executeJavaScript(script).catch((e) => {
                log('executeJavaScript error:', e.message);
            });
        }

        // Сообщения [FkCensor] из окна клиента дублируем в лог
        function forwardConsole(wc) {
            wc.on('console-message', (e, level, message) => {
                const msg = (e && typeof e.message === 'string') ? e.message : message;
                if (typeof msg === 'string' && msg.includes('[FkCensor]')) log('окно:', msg.replace('[FkCensor] ', ''));
            });
        }

        app.on('web-contents-created', (_, wc) => {
            forwardConsole(wc);
            wc.on('dom-ready', () => injectInto(wc));
            wc.on('did-finish-load', () => injectInto(wc));
            wc.on('did-navigate-in-page', () => injectInto(wc));
        });

        webContents.getAllWebContents().forEach((wc) => {
            forwardConsole(wc);
            if (!wc.isDestroyed() && !wc.isLoading()) {
                injectInto(wc);
            } else {
                wc.on('did-finish-load', () => injectInto(wc));
            }
        });

        log('webContents hook установлен');
    }

    function readIpcInfo() {
        try {
            const p = require('path').join(DATA_DIR, 'ipc.json');
            return JSON.parse(require('fs').readFileSync(p, 'utf8'));
        } catch(_) { return null; }
    }

    function postToApp(path, body) {
        return new Promise((resolve, reject) => {
            const info = readIpcInfo();
            if (!info) return reject(new Error('FkCensor не запущен'));
            const data = Buffer.from(JSON.stringify(body));
            const req = require('http').request({
                host: '127.0.0.1', port: info.port, path, method: 'POST', timeout: 3000,
                headers: { 'Content-Type': 'application/json', 'Content-Length': data.length, 'X-FkCensor-Token': info.token },
            }, (res) => {
                const chunks = [];
                res.on('data', (c) => chunks.push(c));
                res.on('end', () => {
                    if (res.statusCode !== 200) return reject(new Error('HTTP ' + res.statusCode));
                    try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8'))); } catch(e) { reject(e); }
                });
            });
            req.on('timeout', () => req.destroy(new Error('timeout')));
            req.on('error', reject);
            req.end(data);
        });
    }

    // HEAD-запрос к файлу замены: доступен ли он сейчас
    const checked = new Map(); // url -> { ok, at }
    function checkUrl(url) {
        const cached = checked.get(url);
        if (cached && cached.ok && Date.now() - cached.at < 10 * 60 * 1000) return Promise.resolve(true);
        return new Promise((resolve) => {
            let done = false;
            const finish = (ok) => {
                if (done) return;
                done = true;
                checked.set(url, { ok, at: Date.now() });
                resolve(ok);
            };
            try {
                const req = require('electron').net.request({ method: 'HEAD', url });
                const timer = setTimeout(() => { req.abort(); finish(false); }, 8000);
                req.on('response', (res) => { clearTimeout(timer); finish(res.statusCode < 400); res.on('data', () => {}); });
                req.on('error', () => { clearTimeout(timer); finish(false); });
                req.end();
            } catch(_) { finish(false); }
        });
    }

    function pushActive() {
        const active = isActive();
        const state = enabledByApp + '/' + active;
        if (state === pushedActive) return;
        pushedActive = state;
        const { webContents } = require('electron');
        webContents.getAllWebContents().forEach((wc) => {
            if (!wc.isDestroyed()) {
                wc.executeJavaScript(`window.__fkCensorEnabled = ${enabledByApp}; window.__fkCensorActive = ${active};` +
                    ' window.__fkcBadgesRefresh && window.__fkcBadgesRefresh();').catch(() => {});
            }
        });
    }

    async function takeFromRenderers() {
        const { webContents } = require('electron');
        const events = [];
        let nowPlaying = null;
        for (const wc of webContents.getAllWebContents()) {
            if (wc.isDestroyed()) continue;
            try {
                const r = await wc.executeJavaScript('window.__fkcTake ? window.__fkcTake() : null');
                if (!r) continue;
                events.push(...(r.events || []));
                if (r.nowPlaying && !nowPlaying) nowPlaying = r.nowPlaying;
            } catch(_) {}
        }
        return { events, nowPlaying };
    }

    let syncOk = null;

    async function appSyncOnce() {
        const { app } = require('electron');
        const { events, nowPlaying } = await takeFromRenderers();

        const report = [];
        for (const e of events) {
            // Свой файл пользователя лежит в самом клиенте — проверять нечего
            const local = String(e.url).startsWith('blob:');
            const ok = local || await checkUrl(e.url);
            if (!ok) reachable = false;
            report.push({ type: ok ? 'replaced' : 'failed', trackId: e.trackId, cover: e.cover || '' });
        }

        // После ошибки периодически проверяем, не ожило ли хранилище
        if (!reachable && Date.now() - lastRecheck > RECHECK_MS) {
            lastRecheck = Date.now();
            const sample = Object.values(replacements)[0];
            if (sample && await checkUrl(sample.url)) reachable = true;
        }

        try {
            const res = await postToApp('/ym/sync', {
                ymVersion: app.getVersion(),
                listCount: Object.keys(replacements).length,
                reachable,
                nowPlaying,
                events: report,
            });
            if (!syncOk) log('связь с FkCensor есть, подмена', res.enabled ? 'включена' : 'на паузе');
            syncOk = true;
            enabledByApp = res.enabled === true;
        } catch(e) {
            if (syncOk !== false) log('нет связи с FkCensor:', e.message);
            syncOk = false;
            enabledByApp = false;
        }
        for (const r of report) log('замена', r.trackId, r.type === 'replaced' ? 'загружается' : 'файл недоступен');
        pushActive();
    }

    function startAppSync() {
        const loop = () => appSyncOnce().catch((e) => {
            log('app sync:', e.message);
        }).finally(() => setTimeout(loop, APP_SYNC_MS));
        loop();
    }

    function startSyncLoop() {
        setInterval(() => {
            loadList().then((updated) => {
                if (!updated) return;
                const { webContents } = require('electron');
                const script = buildDataScript();
                webContents.getAllWebContents().forEach((wc) => {
                    if (!wc.isDestroyed()) {
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
            startAppSync();
        });
    }

    const { app } = require('electron');
    app.isReady() ? init() : app.whenReady().then(init);
})();
