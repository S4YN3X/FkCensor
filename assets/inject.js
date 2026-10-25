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

    // Лог главного процесса и сообщений [FkCensor] из окна: %LOCALAPPDATA%\FkCensor\ym.log
    const LOG_PATH = require('path').join(process.env.LOCALAPPDATA || '', 'FkCensor', 'ym.log');
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
            ` window.__fkCensorEnabled = ${enabledByApp}; window.__fkCensorActive = ${isActive()};`;
    }

    function buildRendererScript() {
        return buildDataScript() + `
(function() {
    if (window.__fkCensorInjected) return;
    window.__fkCensorInjected = true;

    // Читаем список при каждом вызове: синхронизация обновляет только window.__fkCensorReplacements
    function getReplacementUrl(trackId) {
        if (!trackId || window.__fkCensorActive !== true) return null;
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
            codec: 'mp3',
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
            const p = require('path').join(process.env.LOCALAPPDATA || '', 'FkCensor', 'ipc.json');
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
                wc.executeJavaScript(`window.__fkCensorEnabled = ${enabledByApp}; window.__fkCensorActive = ${active};`).catch(() => {});
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
            const ok = await checkUrl(e.url);
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
