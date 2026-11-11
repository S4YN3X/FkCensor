/* FkCensor patched */
;(function() {
    'use strict';

    // Списки замен в формате list_v2.json. При совпадении id важнее тот, что выше:
    // свой репозиторий позволяет добавлять треки и поправлять замены из общей базы.
    const LISTS = [
        { name: 'FkCensorData', url: 'https://raw.githubusercontent.com/S4YN3X/FkCensorData/refs/heads/main/list_v2.json' },
        { name: 'FckCensorData', url: 'https://raw.githubusercontent.com/Hazzz895/FckCensorData/refs/heads/main/list_v2.json' },
    ];
    const SYNC_MS  = 10 * 60 * 1000;
    const APP_SYNC_MS = 2000;        // обмен с программой F_ckCensor
    const RECHECK_MS  = 60 * 1000;   // повторная проверка хранилища замен после ошибки
    // Версия аддона FckCensor, формат данных которой мы понимаем.
    // Источники из list_v2.json помечены supportedVersions относительно неё.
    const COMPAT_VERSION = '2.0.0';

    // trackId -> { url, durationMs? }
    let replacements = {};
    // Подмены метаданных из list_v2.json: названия, обложки, трек-листы альбомов, вставки в профили
    let meta = { tracks: {}, albums: {}, artists: {}, insertions: {}, trackAlbums: {} };
    // Подмена работает, только пока программа F_ckCensor запущена и не на паузе
    let enabledByApp = false;
    // Хранилище замен отвечает (GitHub бывает заблокирован)
    let reachable = true;
    let lastRecheck = 0;
    let pushedActive = null;

    // Папка данных F_ckCensor: %LOCALAPPDATA%\F_ckCensor в Windows, ~/Library/Application Support/F_ckCensor в macOS
    const DATA_DIR = process.platform === 'win32'
        ? require('path').join(process.env.LOCALAPPDATA || '', 'F_ckCensor')
        : require('path').join(require('os').homedir(), 'Library', 'Application Support', 'F_ckCensor');

    // Лог главного процесса и сообщений [F_ckCensor] из окна
    const LOG_PATH = require('path').join(DATA_DIR, 'ym.log');
    function log(...args) {
        const text = args.map((a) => (typeof a === 'string' ? a : (a instanceof Error ? a.message : JSON.stringify(a)))).join(' ');
        console.log('[F_ckCensor] ' + text);
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
        // У альбома в записи нет исполнителей: берём самых частых среди подмен его треков.
        // Нужны, когда альбом удалён: показать исполнителя и вставить альбом в профиль
        for (const album of Object.values(m.albums)) {
            if ((Array.isArray(album.artists) && album.artists.length) || !Array.isArray(album.volumes)) continue;
            const count = {};
            const byKey = {};
            for (const vol of album.volumes) {
                for (const x of vol) {
                    const t = m.tracks[volumeId(x)];
                    if (!t || !Array.isArray(t.artists) || !t.artists.length) continue;
                    const key = t.artists.map((a) => a && a.id).join(',');
                    count[key] = (count[key] || 0) + 1;
                    byKey[key] = t.artists;
                }
            }
            const best = Object.keys(count).sort((a, b) => count[b] - count[a])[0];
            if (best) album.__fckCensor = Object.assign({}, album.__fckCensor, { trackArtists: byKey[best] });
        }
        for (const [type, map] of [['tracks', m.tracks], ['albums', m.albums]]) {
            for (const [id, e] of Object.entries(map)) {
                const fc = e.__fckCensor || {};
                const artists = Array.isArray(e.artists) && e.artists.length ? e.artists : fc.trackArtists;
                if (!Array.isArray(artists) || !artists.length || fc.insertionIndex === null) continue;
                for (const a of artists) {
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

    // Последний удачно загруженный вариант каждого списка: сбой одного не стирает его треки
    const loadedLists = {};

    // fresh — в обход кэша GitHub: свежий коммит иначе виден не сразу, а через несколько минут
    function fetchList(list, fresh) {
        return new Promise((resolve) => {
            try {
                const url = fresh ? list.url + (list.url.includes('?') ? '&' : '?') + 't=' + Date.now() : list.url;
                const req = require('electron').net.request(url);
                const chunks = [];
                req.on('response', (res) => {
                    res.on('data', (chunk) => { chunks.push(chunk); });
                    res.on('end', () => {
                        if (res.statusCode !== 200) {
                            log(list.name + ': HTTP', res.statusCode);
                            return resolve(null);
                        }
                        try {
                            resolve(parseListV2(JSON.parse(Buffer.concat(chunks).toString('utf8'))));
                        } catch(e) {
                            log(list.name + ': parse error:', e.message);
                            resolve(null);
                        }
                    });
                });
                req.on('error', (e) => { log(list.name + ': net error:', e.message); resolve(null); });
                req.end();
            } catch(e) { log(list.name + ': crash:', e.message); resolve(null); }
        });
    }

    // Объединение списков: при совпадении id побеждает список, который выше в LISTS;
    // вставки в профили исполнителей складываются
    function mergeLists(parsedLists) {
        const out = { replacements: {}, meta: { tracks: {}, albums: {}, artists: {}, insertions: {}, trackAlbums: {} } };
        for (const p of parsedLists) {
            mergeFirst(out.replacements, p.replacements);
            for (const k of ['tracks', 'albums', 'artists', 'trackAlbums']) mergeFirst(out.meta[k], p.meta[k]);
            for (const [artistId, ins] of Object.entries(p.meta.insertions)) {
                const cur = out.meta.insertions[artistId] = out.meta.insertions[artistId] || { tracks: [], albums: [] };
                cur.tracks = [...cur.tracks, ...(ins.tracks || [])];
                cur.albums = [...cur.albums, ...(ins.albums || [])];
            }
        }
        return out;
    }

    // Когда началась последняя закончившаяся загрузка списков: по ней программа понимает,
    // что просьба «обновить список» выполнена
    let listLoadedAt = 0;
    let listLoading = false;
    // удалось ли скачать хоть один список в последней загрузке: при ошибке программа скажет
    // пользователю, что обновить не вышло, а не «обновлено»
    let listLoadOk = false;

    async function loadList(fresh) {
        const started = Date.now();
        listLoading = true;
        try { return await loadListNow(fresh); }
        finally { listLoadedAt = started; listLoading = false; }
    }

    async function loadListNow(fresh) {
        const results = await Promise.all(LISTS.map((l) => fetchList(l, fresh)));
        listLoadOk = results.some(Boolean);
        let updated = false;
        LISTS.forEach((l, i) => {
            const p = results[i];
            if (!p) return;
            const count = Object.keys(p.replacements).length;
            const prev = loadedLists[l.name];
            // Пустой список вместо непустого почти наверняка значит смену формата — старый не трогаем
            if (count === 0 && prev && Object.keys(prev.replacements).length > 0) {
                log(l.name + ': не найдено ни одного трека, оставляю прошлый список');
                return;
            }
            loadedLists[l.name] = p;
            updated = true;
            log(l.name + ': треков', count, '· подмен метаданных', Object.keys(p.meta.tracks).length);
        });
        if (!updated) return false;

        const merged = mergeLists(LISTS.map((l) => loadedLists[l.name]).filter(Boolean));
        replacements = merged.replacements;
        meta = merged.meta;
        log('Загружено треков:', Object.keys(replacements).length, '· подмен метаданных: треков', Object.keys(meta.tracks).length,
            'альбомов', Object.keys(meta.albums).length, 'профилей', Object.keys(meta.insertions).length);
        return true;
    }

    function isActive() {
        return enabledByApp && reachable;
    }

    function buildDataScript() {
        return `window.__fkCensorReplacements = ${JSON.stringify(replacements)}; window.__fkCensorMeta = ${JSON.stringify(meta)};` +
            ' ' + likesScript() +
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
    // Лайки треков, которых нет в Яндекс Музыке: их хранит программа (likes.json).
    // __fkcLikes — uid аккаунта → [{ id, albumId, timestamp }], новые сверху;
    // __fkcLikeOps — что лайкнули и сняли с прошлого обмена с программой
    window.__fkcLikes = window.__fkcLikes || {};
    window.__fkcLikeOps = window.__fkcLikeOps || [];
    // треки, которые Яндекс отдал недоступными (удалены), а подмена сделала доступными
    window.__fkcGhost = window.__fkcGhost || new Set();
    window.__fkcTake = function() {
        const events = window.__fkcEvents.splice(0);
        const likeOps = window.__fkcLikeOps.splice(0);
        let nowPlaying = null;
        const ms = navigator.mediaSession;
        const m = ms && ms.metadata;
        if (m && m.title) {
            const art = (m.artwork || []).slice(-1)[0];
            // id трека — из ссылки на название в плеере
            let trackId = '';
            const link = document.querySelector('[class*="CommonLayout_playerBar__"] a[data-test-id="TRACK_TITLE"]');
            if (link) {
                try { trackId = new URL(link.getAttribute('href'), location.href).searchParams.get('trackId') || ''; } catch (_) {}
            }
            if (!trackId) trackId = trackIdFromFiber(document.querySelector('[data-test-id="VIBE_PLAYERBAR"]')) || '';
            nowPlaying = {
                title: m.title,
                artist: m.artist || '',
                artwork: art ? art.src : '',
                playing: ms.playbackState !== 'paused',
                trackId,
                replaced: !!(trackId && getReplacementUrl(trackId)),
            };
        }
        return { events, nowPlaying, likeOps };
    };


    // ---- Подмена метаданных: каждый ответ api.music.yandex.net проходит через Response.json ----
    const API_PREFIX = 'https://api.music.yandex.net/';
    // Ответ API бывает в обёртке { invocationInfo, result } (свои запросы) и без неё (запросы клиента)
    const resultOf = (data) => (data && typeof data === 'object' && !Array.isArray(data) && data.result !== undefined ? data.result : data);
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
        const raw = albumMeta(id);
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

    // Удалённого альбома (или альбома с таким id нет вовсе) API отдаёт заглушку { id, error: 'not-found' }.
    // Если альбом есть в списке замен, собираем его из записи: клиент покажет его как обычный
    // альбомы, которых нет в Яндекс Музыке (удалены или созданы в базе): их ищет поиск
    const goneAlbums = new Set();
    const ALBUM_DEFAULTS = {
        title: 'Без названия', type: 'album', metaType: 'music', availableForPremiumUsers: true, availableForMobile: true,
        availablePartially: false, labels: [], genre: '', artists: [], trackCount: 0, likesCount: 0, recent: false,
        veryImportant: false, bests: [], disclaimers: [], sortOrder: 'asc',
    };
    // Чего нет в записи, берём по порядку: название волны альбома (Яндекс отдаёт его и у удалённого),
    // запомненный вид альбома, пока он был доступен, исполнителей по трекам альбома
    function reviveAlbum(a) {
        const id = String(idOf(a));
        goneAlbums.add(id);
        delete a.error;
        if (a.title === undefined && a.customWave && a.customWave.title) {
            a.title = a.customWave.title;
            rememberSeenAlbum(id, Object.assign({}, seenAlbums[id], { title: a.title }));
        }
        const seen = seenAlbums[id] || {};
        // названия нет нигде: оно есть в волне ответа with-tracks — запрашиваем его один раз
        if (a.title === undefined && !seen.title && !albumAsked.has(id + '/wave') && window.__fkcApiHeaders) {
            albumAsked.add(id + '/wave');
            apiFetch('albums/' + id + '/with-tracks').then((r) => r.json()).catch(() => {});
        }
        for (const [k, v] of Object.entries(seen)) if (a[k] === undefined) a[k] = v;
        const fc = (albumMeta(id) || {}).__fckCensor || {};
        if ((!Array.isArray(a.artists) || !a.artists.length) && Array.isArray(fc.trackArtists)) a.artists = fc.trackArtists;
        for (const [k, v] of Object.entries(ALBUM_DEFAULTS)) if (a[k] === undefined) a[k] = Array.isArray(v) ? [] : v;
        a.available = true;
    }

    // Альбомы из ответов API (уже с подменой): по ним строим альбом трека, перенесённого
    // в другой альбом. Названия нет — запрашиваем альбом один раз, ответ попадёт сюда же.
    // Альбомы из базы ещё и запоминаем: если Яндекс удалит альбом, его название, год
    // и исполнители останутся (в записи базы их может не быть)
    const SEEN_ALBUMS = 'fkc-seen-albums';
    const seenAlbums = (() => {
        try { return JSON.parse(localStorage.getItem(SEEN_ALBUMS) || '{}') || {}; } catch (_) { return {}; }
    })();
    let seenSaveTimer = 0;
    function rememberSeenAlbum(id, keep) {
        seenAlbums[id] = keep;
        if (!albumMeta(id)) return;
        clearTimeout(seenSaveTimer);
        seenSaveTimer = setTimeout(() => {
            const out = {};
            for (const [k, v] of Object.entries(seenAlbums)) if (albumMeta(k)) out[k] = v;
            try { localStorage.setItem(SEEN_ALBUMS, JSON.stringify(out)); } catch (_) {}
        }, 1000);
    }
    const albumAsked = new Set();
    function seenAlbum(id) {
        if (!seenAlbums[id] && !albumAsked.has(id) && window.__fkcApiHeaders) {
            albumAsked.add(id);
            apiFetch('albums/' + id).then((r) => r.json()).catch(() => {});
        }
        return seenAlbums[id];
    }

    function applyAlbum(a) {
        const s = albumSpoof(idOf(a));
        const revived = !!(s && a.error);
        if (revived) reviveAlbum(a);
        if (s) Object.assign(a, s);
        if (!revived && a.title && !a.error && 'trackCount' in a) {
            const keep = {};
            for (const k of ['title', 'year', 'releaseDate', 'genre', 'artists', 'labels'])
                if (a[k] !== undefined) keep[k] = a[k];
            rememberSeenAlbum(String(idOf(a)), keep);
        }
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
        // У трека может не быть своей подмены, но его альбом подменён: тогда трек всё равно
        // получает обложку альбома и, если включено, исполнителей альбома
        if (!isEmpty(s) || unblock) {
            if (s.coverUri && !s.ogImage) s.ogImage = s.coverUri;
            Object.assign(t, s);
        }
        if (unblock) {
            if (t.available === false || t.error) window.__fkcGhost.add(String(id));
            // недоступный трек с заменой — делаем доступным, звук подставит хук file-info
            t.available = true;
            delete t.error;
        }
        (t.artists || []).forEach(applyArtist);

        // Трек из чужого альбома, вставленный базой в трек-лист другого альбома: в карточке
        // трека остаётся его настоящий альбом, и ссылка «альбом трека» ведёт туда. Ведём в тот,
        // куда его поставили
        const movedTo = m.trackAlbums[id];
        if (movedTo && Array.isArray(t.albums) && t.albums.length && !(Array.isArray(s.albums) && s.albums.length) &&
            !t.albums.some((a) => String(idOf(a)) === String(movedTo))) {
            const as = albumSpoof(movedTo) || {};
            const pos = trackPositionIn(movedTo, id);
            t.albums = [Object.assign({ title: '', available: true }, seenAlbum(String(movedTo)), as,
                { id: Number(movedTo) }, pos ? { trackPosition: pos } : {})];
        }

        if (Array.isArray(t.albums) && t.albums.length) {
            let spoofedAlbum = Array.isArray(s.albums) && s.albums.length > 0;
            for (const a of t.albums) if (applyAlbum(a)) spoofedAlbum = true;
            if (spoofedAlbum) {
                for (const a of t.albums) {
                    const uri = (a.cover && a.cover.uri) || a.coverUri || a.ogImage;
                    if (!('coverUri' in s) && !('ogImage' in s) && uri) t.coverUri = t.ogImage = uri;
                    const fc = (albumMeta(idOf(a)) || {}).__fckCensor || {};
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
        if ((!isEmpty(s) || unblock) && t.available && Array.isArray(t.disclaimers)) {
            t.disclaimers = t.disclaimers.filter((d) => !String(d).includes(RKN_DISCLAIMER));
        }
        // обложку, которую увидит клиент, запоминаем для истории F_ckCensor:
        // у удалённых треков публичный API обложки не отдаёт
        if (unblock && t.coverUri) window.__fkcCovers[id] = t.coverUri;
    }

    // Место трека в трек-листе альбома из базы: { volume, index }, с единицы, как у API
    function trackPositionIn(albumId, trackId) {
        const vols = (albumMeta(albumId) || {}).volumes;
        if (!Array.isArray(vols)) return null;
        for (let v = 0; v < vols.length; v++) {
            const i = vols[v].findIndex((x) => String(x && typeof x === 'object' ? x.id : x) === String(trackId));
            if (i >= 0) return { volume: v + 1, index: i + 1 };
        }
        return null;
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

    // ---- Свои треки: аудиофайл пользователя, которого нет в Яндекс Музыке ----
    // У них id из своего диапазона (у аддона FckCensor свой, около 5·10^14 — не пересекаемся).
    // Сервер о таких id не знает: в запросах к API их вырезаем, а данные трека добавляем
    // в ответ сами. Звук отдаёт тот же хук file-info, что и у своих подмен.
    // Сразу за ними — свои треки из базы (их создают в админке): такие же, но общие для всех
    const CUSTOM_BASE = 600000000000000;
    const CUSTOM_LIMIT = 1000000;
    const BASE_CUSTOM_BASE = CUSTOM_BASE + CUSTOM_LIMIT;
    const CUSTOM_SEQ = 'fkc-custom-seq';

    function isCustomId(id) {
        const n = Number(String(id).split(':')[0]);
        return n >= CUSTOM_BASE && n < BASE_CUSTOM_BASE + CUSTOM_LIMIT;
    }

    // Свой трек из базы в том же виде, что и свой трек пользователя: название, исполнители
    // и длительность — из записи трека, альбом — тот, в трек-лист которого он вставлен
    function baseCustomTrack(id) {
        if (Number(id) < BASE_CUSTOM_BASE || !getReplacementUrl(id)) return null;
        const m = getMeta();
        const t = m.tracks[id] || {};
        const albumId = m.trackAlbums[id];
        const al = (albumId && albumMeta(albumId)) || {};
        const fc = al.__fckCensor || {};
        // у удалённого альбома в записи может не быть названия — берём запомненное
        const seen = (albumId && seenAlbums[albumId]) || {};
        return {
            custom: true, title: t.title, durationMs: t.durationMs, albumId,
            albumTitle: seen.title, albumArtists: seen.artists || fc.trackArtists,
            artists: t.artists || al.artists || seen.artists || fc.trackArtists || [],
        };
    }

    function allocCustomId() {
        let n = 0;
        try { n = Number(localStorage.getItem(CUSTOM_SEQ) || '0') || 0; } catch (_) {}
        while (window.__fkcLocalTracks && window.__fkcLocalTracks[String(CUSTOM_BASE + n)]) n++;
        try { localStorage.setItem(CUSTOM_SEQ, String(n + 1)); } catch (_) {}
        return String(CUSTOM_BASE + n);
    }

    // Объект трека в том виде, в каком его отдаёт API
    function customTrackDto(id) {
        const local = (window.__fkcLocalTracks || {})[String(id)];
        const rec = local && local.custom ? local : baseCustomTrack(String(id));
        if (!rec) return null;
        const al = (rec.albumId && albumMeta(rec.albumId)) || {};
        const cover = al.coverUri || rec.albumCover || '';
        const album = {
            id: Number(rec.albumId) || 0,
            title: al.title || rec.albumTitle || '',
            type: 'album',
            metaType: 'music',
            coverUri: cover,
            ogImage: cover,
            artists: al.artists || rec.albumArtists || [],
            labels: [],
            available: true,
            availableForPremiumUsers: true,
            trackPosition: { volume: 1, index: 1 },
        };
        return {
            id: Number(id),
            realId: String(id),
            title: rec.title || 'Без названия',
            available: true,
            availableForPremiumUsers: true,
            availableFullWithoutPermission: true,
            availableForOptions: [],
            disclaimers: [],
            storageDir: '',
            durationMs: rec.durationMs || 0,
            fileSize: 0,
            artists: rec.artists || [],
            albums: [album],
            coverUri: cover,
            ogImage: cover,
            lyricsAvailable: false,
            type: 'music',
            rememberPosition: false,
            trackSharingFlag: 'COVER_ONLY',
            trackSource: 'OWN',
        };
    }

    function splitCustomIds(list) {
        const rest = [];
        const custom = [];
        for (const raw of list) {
            const id = String(raw).split(':')[0];
            if (isCustomId(id)) { if (!custom.includes(id)) custom.push(id); }
            else rest.push(raw);
        }
        return { rest, custom };
    }

    // Свои треки, вырезанные из запроса, — в тело ответа. Именно в тело: клиент читает
    // не сам ответ, а его копию (clone), и пометки на объекте ответа до неё не доходят
    async function withCustomTracks(resp, custom, url, order) {
        if (!resp.ok) return resp;
        let text;
        try { text = await resp.text(); } catch (_) { return resp; }
        let data;
        try { data = JSON.parse(text || '[]'); }
        catch (_) { return new Response(text, { status: resp.status, headers: resp.headers }); }
        const unwrapped = resultOf(data);
        const list = Array.isArray(unwrapped) ? unwrapped : null;
        if (list) {
            // id — того же типа, что у остальных треков ответа: в одних ответах Яндекс отдаёт
            // его числом, в других строкой, и клиент ищет трек по точному совпадению
            const asString = list.some((x) => x && typeof x.id === 'string');
            const dto = (id) => { const t = customTrackDto(id); if (t && asString) t.id = String(t.id); return t; };
            if (Array.isArray(order) && order.length) {
                // свой трек — на то место, где он был в запросе: клиент раскладывает ответ по порядку
                const rest = list.slice();
                const out = [];
                for (const id of order) {
                    if (custom.includes(id)) { const t = dto(id); if (t) out.push(t); continue; }
                    const i = rest.findIndex((x) => x && String(x.id) === id);
                    if (i >= 0) out.push(rest.splice(i, 1)[0]);
                }
                out.push(...rest); // что сервер вернул сверх запроса — как было, в конце
                list.splice(0, list.length, ...out);
            } else {
                for (const id of custom) {
                    if (list.some((x) => x && String(x.id) === String(id))) continue;
                    const t = dto(id);
                    if (t) list.push(t);
                }
            }
        }
        return fakeJsonResponse(resp.url || url, data, resp.status);
    }

    // Ответ без сети: у Response нельзя задать url, поэтому ставим его свойством,
    // чтобы ответ прошёл через подмену метаданных как настоящий
    function fakeJsonResponse(url, body, status) {
        const r = new Response(JSON.stringify(body), { status: status || 200, headers: { 'Content-Type': 'application/json' } });
        Object.defineProperty(r, 'url', { value: url });
        return r;
    }

    // свои треки пользователя или из базы; база меняется редко — ответ про неё запоминаем
    let baseCustomFor = null, baseCustomHas = false;
    const hasCustomTracks = () => {
        if (Object.values(window.__fkcLocalTracks || {}).some((t) => t && t.custom)) return true;
        const r = window.__fkCensorReplacements;
        if (r !== baseCustomFor) { baseCustomFor = r; baseCustomHas = Object.keys(r || {}).some((id) => Number(id) >= BASE_CUSTOM_BASE && isCustomId(id)); }
        return baseCustomHas;
    };
    const ID_FIELDS = ['trackIds', 'track-ids'];

    // Переписывает запрос к API, если в нём есть свои треки: id ищем в адресе (?track-ids=),
    // в пути (/tracks/{id}) и в теле — строке, URLSearchParams или FormData (так шлёт клиент).
    // Вернёт { input, init, custom, fake } — fake: готовый ответ без запроса к серверу
    async function rewriteCustomRequest(url, input, init, headers) {
        // order — все id запроса по порядку: клиент сопоставляет треки ответа с запросом по месту
        const out = { input, init, custom: [], fake: null, order: [] };
        let u;
        try { u = new URL(url); } catch (_) { return out; }
        const raw = headers.has('x-yandex-music-without-invocation-info');
        const wrap = (v) => (raw ? v : { invocationInfo: {}, result: v });
        const path = u.pathname.split('/').filter(Boolean);

        // /tracks/{id} и /tracks/{id}/…
        if (path[0] === 'tracks' && path[1] && isCustomId(path[1])) {
            const id = path[1].split(':')[0];
            if (path.length === 2) out.fake = fakeJsonResponse(url, wrap([customTrackDto(id)].filter(Boolean)));
            else out.fake = fakeJsonResponse(url, { error: { name: 'not-found', message: 'F_ckCensor: свой трек' } }, 404);
            return out;
        }

        // ?track-ids=…
        const q = u.searchParams.get('track-ids');
        if (q) {
            const sp = splitCustomIds(q.split(','));
            if (sp.custom.length) {
                out.custom = sp.custom;
                out.order = q.split(',').map((x) => String(x).split(':')[0]);
                if (!sp.rest.length) { out.fake = fakeJsonResponse(url, wrap([])); return out; }
                u.searchParams.set('track-ids', sp.rest.join(','));
                out.input = input instanceof Request ? new Request(u.toString(), input) : u.toString();
            }
        }

        // тело: id полями формы (каждый отдельно) или строкой через запятую
        const isReq = input instanceof Request;
        const method = ((init && init.method) || (isReq ? input.method : 'GET')).toUpperCase();
        if (method === 'GET' || method === 'HEAD') return out;
        let body = init && init.body;
        if (!body && isReq) {
            const ct = (input.headers.get('content-type') || '').toLowerCase();
            if (!ct.includes('form')) return out;
            try { body = await input.clone().formData(); } catch (_) { return out; }
        }
        if (!body) return out;
        let form;
        if (body instanceof FormData) form = body;
        else if (typeof body === 'string' || body instanceof URLSearchParams) form = new URLSearchParams(body);
        else return out;

        let changed = false;
        let left = 0;
        const next = form instanceof FormData ? new FormData() : new URLSearchParams();
        for (const [k, v] of form.entries()) {
            if (!ID_FIELDS.includes(k) || typeof v !== 'string') { next.append(k, v); continue; }
            const sp = splitCustomIds(v.split(','));
            v.split(',').forEach((x) => out.order.push(String(x).split(':')[0]));
            if (sp.custom.length) {
                changed = true;
                for (const id of sp.custom) if (!out.custom.includes(id)) out.custom.push(id);
            }
            if (sp.rest.length) { next.append(k, sp.rest.join(',')); left++; }
        }
        if (!changed) return out;
        if (!left) { out.fake = fakeJsonResponse(url, wrap([])); return out; }
        const newBody = typeof body === 'string' ? next.toString() : next;
        if (isReq) {
            // заголовок с прежней границей формы не подходит к новому телу — браузер поставит свой
            const h = new Headers(input.headers);
            h.delete('content-type');
            out.input = new Request(out.input instanceof Request ? out.input.url : input.url, {
                method, headers: h, body: newBody, credentials: input.credentials, mode: input.mode, signal: input.signal,
            });
        } else {
            out.init = Object.assign({}, init, { body: newBody });
            if (out.init.headers && newBody instanceof FormData) {
                const h = new Headers(out.init.headers);
                h.delete('content-type');
                out.init.headers = h;
            }
        }
        return out;
    }

    // Свои запросы к API идут с теми же заголовками, что и запросы клиента (вход пользователя,
    // версия клиента): без входа API помечает треки недоступными. Заголовки берём из запросов
    // самого клиента; токен уходит только в API Яндекс Музыки, как и у клиента.
    const API_HEADERS = ['authorization', 'x-yandex-music-client', 'x-yandex-music-device', 'accept-language'];
    if (!window.__fkcFetchPatched) {
        window.__fkcFetchPatched = true;
        const origFetch = window.fetch;
        window.fetch = function(input, init) {
            try {
                const url = typeof input === 'string' ? input : input && input.url;
                if (typeof url === 'string' && url.startsWith(API_PREFIX)) {
                    const h = new Headers((input instanceof Request ? input.headers : null) || (init && init.headers) || {});
                    if (h.has('authorization')) {
                        const keep = {};
                        for (const k of API_HEADERS) if (h.has(k)) keep[k] = h.get(k);
                        window.__fkcApiHeaders = keep;
                    }
                    if (window.__fkCensorEnabled === true && url.split('?')[0] === API_PREFIX + 'collection/sync' && Object.values(window.__fkcLikes).some((l) => l && l.length)) {
                        const self = this;
                        return (async () => {
                            let i2 = input, n2 = init;
                            try {
                                const isReq = input instanceof Request;
                                const text = isReq ? await input.clone().text() : String((init && init.body) || '');
                                const body = JSON.parse(text || '{}');
                                if (body.likedTracks && body.likedTracks.revision != null) {
                                    delete body.likedTracks.revision;
                                    if (isReq) i2 = new Request(input, { body: JSON.stringify(body) });
                                    else n2 = Object.assign({}, init, { body: JSON.stringify(body) });
                                }
                            } catch (_) {}
                            return origFetch.call(self, i2, n2);
                        })();
                    }
                    // Лайк трека, которого нет в Яндекс Музыке: Яндекс его не сохранит — запоминает программа
                    if (window.__fkCensorEnabled === true && isLikeRequest(url)) {
                        const self = this;
                        return (async () => {
                            let r = null;
                            try { r = await handleLikeRequest(url, input, init, h); }
                            catch (e) { console.error('[F_ckCensor] лайк:', e && e.message); }
                            if (r && r.fake) return r.fake;
                            return origFetch.call(self, r ? r.input : input, r ? r.init : init);
                        })();
                    }
                    // Блок альбомов исполнителя, у которого своих альбомов нет: сервер отвечает 404.
                    // Если в базе есть его альбомы — отдаём пустой блок, альбомы в него вставит подмена
                    const ap = url.slice(API_PREFIX.length).split('?')[0].split('/');
                    const ab = ap.length === 4 && ap[0] === 'artists' && ap[2] === 'blocks' && ap[3] === 'artist-albums' && isNum(ap[1]);
                    if (window.__fkCensorEnabled === true && ab && insertionsFor(ap[1], 'albums').length) {
                        const self = this;
                        const raw = h.has('x-yandex-music-without-invocation-info');
                        return (async () => {
                            let resp = null;
                            try { resp = await origFetch.call(self, input, init); } catch (_) {}
                            if (resp && resp.ok) return resp;
                            return fakeJsonResponse(url, raw ? { items: [] } : { invocationInfo: {}, result: { items: [] } });
                        })();
                    }
                    // свои треки — только если они вообще есть: разбор тела запроса не бесплатный
                    if (window.__fkCensorEnabled === true && hasCustomTracks()) {
                        const self = this;
                        return (async () => {
                            let r = { input, init, custom: [], fake: null };
                            try { r = await rewriteCustomRequest(url, input, init, h); }
                            catch (e) { console.error('[F_ckCensor] свой трек в запросе:', e && e.message); }
                            if (r.fake) return r.custom.length ? withCustomTracks(r.fake, r.custom, url, r.order) : r.fake;
                            const resp = await origFetch.call(self, r.input, r.init);
                            return r.custom.length ? withCustomTracks(resp, r.custom, url, r.order) : resp;
                        })();
                    }
                }
            } catch (e) { console.error('[F_ckCensor] запрос:', e && e.message); }
            return origFetch.call(this, input, init);
        };
    }
    function apiFetch(path, init) {
        // заголовки авторизации клиента и, поверх, заголовки самого запроса (например, content-type)
        const headers = Object.assign({}, window.__fkcApiHeaders || {}, init && init.headers);
        return fetch(API_PREFIX + path, Object.assign({}, init, { headers }));
    }

    // API Яндекс Музыки отдаёт и удалённые треки; ответ тоже пройдёт через подмену
    async function fetchTracks(ids) {
        if (!ids.length) return [];
        const r = await apiFetch('tracks?track-ids=' + ids.join(','));
        return ((await r.json()).result) || [];
    }

    async function fetchAlbums(ids) {
        if (!ids.length) return [];
        // альбомы из базы без названия ни в записи, ни в запомненном: если Яндекс их удалил,
        // название есть только в волне ответа with-tracks — берём его до запроса списка
        // один раз на альбом: если волны с названием нет, повторный запрос ничего не даст
        const untitled = ids.filter((id) => { const r = albumMeta(id); return r && !r.title && !(seenAlbums[id] && seenAlbums[id].title) && !albumAsked.has(id + '/wave'); });
        untitled.forEach((id) => albumAsked.add(id + '/wave'));
        await Promise.all(untitled.map((id) => apiFetch('albums/' + id + '/with-tracks').then((r) => r.json()).catch(() => {})));
        const r = await apiFetch('albums?album-ids=' + ids.join(','), { method: 'POST' });
        return ((await r.json()).result) || [];
    }

    // Трек-лист альбома из списка (возвращает удалённые треки в альбом)
    // richHint: что просил клиент (?richTracks=true/false); без подсказки — по содержимому ответа
    async function applyAlbumVolumes(albumId, data, richHint) {
        const raw = albumMeta(albumId);
        if (!raw || !Array.isArray(raw.volumes) || !data || typeof data !== 'object') return;
        const ids = raw.volumes.map((v) => v.map(idOf));
        const all = ids.flat();
        const rich = typeof richHint === 'boolean' ? richHint
            : (data.volumes || []).some((v) => v.some((x) => x && typeof x === 'object' && 'title' in x));
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

    // Место альбома в профиле исполнителя: число — позиция (как в FckCensor), без числа — по дате
    // выхода, среди остальных релизов; null — не добавлять (такие в список вставок не попадают)
    const albumDate = (a) => {
        const d = a && (a.releaseDate || (a.year ? String(a.year) + '-01-01' : ''));
        const t = d ? Date.parse(d) : NaN;
        return isNaN(t) ? null : t;
    };
    // список отсортирован от новых к старым: ставим перед первым, который старше
    function insertByDate(list, item, d, dateOf) {
        let i = d == null ? -1 : list.findIndex((x) => { const xd = dateOf(x); return xd != null && xd < d; });
        if (i < 0) i = list.length;
        list.splice(i, 0, item);
    }

    // Все альбомы исполнителя приходят страницами по дате (?page=N&sort-by=year). Альбом «по дате»
    // попадает на страницу, в чей промежуток дат он входит: от конца прошлой страницы до конца этой
    const albumPages = {}; // artistId → { page, last } — дата последнего альбома прошлой страницы
    async function insertArtistAlbums(artistId, data, url) {
        const list = Array.isArray(data) ? data : data && data.albums;
        if (!Array.isArray(list)) return;
        const pager = data && !Array.isArray(data) ? data.pager : null;
        const page = pager ? pager.page || 0 : 0;
        const size = pager ? pager.perPage || list.length : list.length;
        const isLast = !pager || list.length < size || (page + 1) * size >= (pager.total || 0);
        const byYear = !url || url.includes('sort-by=year');
        const seen = albumPages[artistId];
        const prev = page === 0 ? Infinity : seen && seen.page === page - 1 ? seen.last : null;
        const dates = list.map(albumDate).filter((x) => x != null);
        const last = dates.length ? dates[dates.length - 1] : null;
        albumPages[artistId] = { page, last };

        const all = insertionsFor(artistId, 'albums').filter((x) => !list.some((a) => idOf(a) === String(x.releaseId)));
        if (!all.length) return;
        const fixed = page === 0 ? all.filter((x) => typeof x.index === 'number') : [];
        const byDate = all.filter((x) => typeof x.index !== 'number');
        const fetched = await fetchAlbums(fixed.concat(byDate).map((x) => String(x.releaseId)));
        const get = (x) => fetched.find((f) => idOf(f) === String(x.releaseId) && !f.error);
        for (const x of fixed) { const a = get(x); if (a) insertAt(list, a, x.index); }
        for (const x of byDate) {
            const a = get(x);
            if (!a) continue;
            const d = albumDate(a);
            if (!byYear) { if (page === 0) list.push(a); continue; }
            const fits = prev != null && (d == null ? isLast : d < prev && (last == null || d >= last || isLast));
            if (fits) insertByDate(list, a, d, albumDate);
        }
        // в общем числе — все вставки, чтобы клиент правильно считал страницы
        if (pager && typeof pager.total === 'number') pager.total += all.length;
    }

    // Блок «Популярные альбомы» в профиле исполнителя (/artists/{id}/blocks/artist-albums):
    // { items: [{ type: 'album_item', data: { album: { id, title, cover: { uri } }, artists, releaseDate } }] }.
    // Здесь альбомы урезанные, общий обход их не узнаёт — подменяем отдельно и добавляем свои
    function albumItemSpoof(it) {
        const al = it && it.data && it.data.album;
        if (!al || al.id == null) return;
        const sp = albumSpoof(idOf(al));
        if (!sp) return;
        if (sp.title) al.title = sp.title;
        if (sp.coverUri) al.cover = Object.assign({}, al.cover, { uri: sp.coverUri });
        if (Array.isArray(sp.artists) && sp.artists.length) it.data.artists = sp.artists;
        if (sp.releaseDate) it.data.releaseDate = sp.releaseDate;
    }

    function albumItemFrom(a) {
        const date = a.releaseDate || (a.year ? new Date(a.year, 0, 1, 12).toJSON() : undefined);
        return {
            type: 'album_item',
            data: {
                album: {
                    id: a.id,
                    title: a.title || '',
                    cover: { uri: a.coverUri || (a.cover && a.cover.uri) || '' },
                    contentRestrictions: { available: true, disclaimers: [] },
                },
                artists: (a.artists || []).map((ar) => ({ id: ar.id, name: ar.name, cover: ar.cover, various: !!ar.various })),
                releaseDate: date,
            },
        };
    }

    async function artistAlbumBlock(artistId, data) {
        const body = resultOf(data);
        const items = body && Array.isArray(body.items) ? body.items : null;
        if (!items) return;
        items.forEach(albumItemSpoof);
        const has = (rid) => items.some((it) => it && it.data && it.data.album && idOf(it.data.album) === String(rid));
        const ins = insertionsFor(artistId, 'albums').filter((x) => !has(x.releaseId));
        if (!ins.length) return;
        // альбомы целиком — через тот же API: удалённые оживут из записи
        const fetched = await fetchAlbums(ins.map((x) => String(x.releaseId)));
        const itemDate = (it) => albumDate(it && it.data);
        for (const x of ins) {
            const a = fetched.find((f) => idOf(f) === String(x.releaseId));
            if (!a || a.error) continue;
            if (typeof x.index === 'number') insertAt(items, albumItemFrom(a), x.index);
            else insertByDate(items, albumItemFrom(a), albumDate(a), itemDate);
        }
    }

    // Страница исполнителя собирается по скелету (/artists/{id}/skeletons/...): список блоков,
    // которые клиент потом загружает. У исполнителя без своих альбомов блока альбомов в нём нет —
    // и альбомам из базы негде показаться. Ставим блок туда же, где он у остальных исполнителей
    function ensureAlbumsBlock(artistId, data) {
        if (!insertionsFor(artistId, 'albums').length) return;
        const body = resultOf(data);
        if (!body || !Array.isArray(body.blocks)) return;
        let found = false;
        const lists = [];
        const scan = (blocks) => {
            if (!Array.isArray(blocks)) return;
            lists.push(blocks);
            for (const b of blocks) {
                if (!b || typeof b !== 'object') continue;
                if (b.type === 'ARTIST_ALBUMS') found = true;
                const d = b.data || {};
                if (Array.isArray(d.tabs)) d.tabs.forEach((t) => scan(t && t.blocks));
                scan(d.blocks);
            }
        };
        scan(body.blocks);
        if (found) return;
        // список вкладки «Артист»: в нём лежат популярные треки и «Знакомое вам»
        const list = lists.find((l) => l.some((b) => b && (b.type === 'ARTIST_POPULAR_TRACKS_AND_RELEASES' || b.type === 'FAMILIAR_YOU_AND_ARTIST_PICK'))) || lists[0];
        const after = ['FAMILIAR_YOU_AND_ARTIST_PICK', 'ARTIST_POPULAR_TRACKS_AND_RELEASES']
            .map((t) => list.findIndex((b) => b && b.type === t)).find((i) => i >= 0);
        list.splice(after === undefined ? Math.min(1, list.length) : after + 1, 0, {
            id: 'artist_albums',
            type: 'ARTIST_ALBUMS',
            data: {
                title: 'Популярные альбомы',
                showPolicy: 'SHOW_AND_LOAD',
                viewAllAction: { deeplink: 'yandexmusic://artist/' + artistId + '/all/albums', weblink: '/artist/' + artistId + '/albums' },
                source: { uri: '/artists/' + artistId + '/blocks/artist-albums', countWeb: 0, count: 0 },
            },
        });
    }

    // ---- Лайки треков, которых нет в Яндекс Музыке ----
    // Свой трек Яндекс отклоняет (400) — такие лайки хранит программа. Лайк удалённого трека
    // Яндекс хранит (он есть в collection/sync), но в плейлист «Мне нравится» его не кладёт.
    // В «Мне нравится» подмешиваем и те и другие — по времени лайка, как обычные
    const isGhostTrack = (id) => isCustomId(id);
    const likeTime = () => new Date().toISOString().slice(0, 19) + '+00:00';
    let likesRevision = 0; // последняя ревизия лайков от Яндекса — для ответа без сервера

    function likePath(url) {
        if (typeof url !== 'string' || !url.startsWith(API_PREFIX)) return null;
        const p = url.slice(API_PREFIX.length).split('?')[0].split('/');
        if (p[0] !== 'users' || p[2] !== 'likes' || p[3] !== 'tracks') return null;
        // users/{uid}/likes/tracks/{add|add-multiple|remove}
        if (p.length === 5 && ['add', 'add-multiple', 'remove'].includes(p[4])) return { uid: p[1], add: p[4] !== 'remove', id: '' };
        // users/{uid}/likes/tracks/{id}/remove — так снимает лайк клиент
        if (p.length === 6 && p[5] === 'remove') return { uid: p[1], add: false, id: decodeURIComponent(p[4]) };
        return null;
    }
    const isLikeRequest = (url) => !!likePath(url);

    // id «трек:альбом» из адреса и тела запроса лайка
    async function likeEntries(url, input, init) {
        const out = [];
        const take = (v) => String(v || '').split(',').map((x) => x.trim()).filter(Boolean).forEach((x) => out.push(x));
        try { const u = new URL(url); ['track-id', 'track-ids'].forEach((k) => take(u.searchParams.get(k))); } catch (_) {}
        let body = init && init.body;
        if (!body && input instanceof Request && input.method !== 'GET') {
            try { body = await input.clone().text(); } catch (_) {}
        }
        let form = null;
        if (body instanceof FormData || body instanceof URLSearchParams) form = body;
        else if (typeof body === 'string' && body) form = new URLSearchParams(body);
        if (form) ['track-id', 'track-ids', 'trackIds'].forEach((k) => form.getAll(k).forEach(take));
        return out;
    }

    function applyLikeLocal(op) {
        const list = (window.__fkcLikes[op.uid] || []).filter((x) => String(x.id) !== op.id);
        if (op.op === 'add') list.unshift({ id: op.id, albumId: op.albumId, timestamp: op.timestamp });
        window.__fkcLikes[op.uid] = list;
        window.__fkcLikeOps.push(op);
    }

    async function handleLikeRequest(url, input, init, headers) {
        const p = likePath(url);
        const uid = p.uid, add = p.add;
        window.__fkcUid = uid;
        const entries = await likeEntries(url, input, init);
        if (p.id) entries.push(p.id);
        const ghosts = entries.filter((e) => isGhostTrack(e.split(':')[0]));
        if (!ghosts.length) return null;
        for (const e of ghosts) {
            const [id, albumId] = e.split(':');
            applyLikeLocal({ op: add ? 'add' : 'remove', uid, id, albumId: albumId || String(getMeta().trackAlbums[id] || ''), timestamp: likeTime() });
        }
        window.__fkcBadgesRefresh && window.__fkcBadgesRefresh();
        // свои треки Яндексу не отправляем: он ответит ошибкой, и клиент снимет лайк
        const rest = entries.filter((e) => !isCustomId(e.split(':')[0]));
        if (!rest.length) {
            const raw = headers.has('x-yandex-music-without-invocation-info');
            likesRevision++;
            return { fake: fakeJsonResponse(url, raw ? { revision: likesRevision } : { invocationInfo: {}, result: { revision: likesRevision } }) };
        }
        // вперемешку со своими — свои вырезаем (как в остальных запросах)
        if (rest.length !== entries.length) {
            const r = await rewriteCustomRequest(url, input, init, headers);
            return { input: r.input, init: r.init };
        }
        return null;
    }

    // Подмешивает свои лайки в список «Мне нравится»: на место по времени, без повторов.
    // Вернёт добавленные id
    const likeMs = (ts) => { const n = Date.parse(ts); return isNaN(n) ? 0 : n; };
    // uid своего аккаунта: свои лайки — только в свой плейлист «Мне нравится», не в чужой.
    // Берём из account/status один раз; без связи — из адресов лайков, которые делал сам пользователь
    let selfUidPromise = null;
    function selfUid() {
        if (window.__fkcSelfUid) return Promise.resolve(window.__fkcSelfUid);
        if (!selfUidPromise) {
            selfUidPromise = apiFetch('account/status').then((r) => r.json()).then((d) => {
                const acc = (resultOf(d) || {}).account || {};
                if (acc.uid) window.__fkcSelfUid = String(acc.uid);
                return window.__fkcSelfUid || window.__fkcUid || '';
            }).catch(() => window.__fkcUid || '').finally(() => { if (!window.__fkcSelfUid) selfUidPromise = null; });
        }
        return selfUidPromise;
    }
    function mergeLikes(uid, tracks, extra) {
        const local = (window.__fkcLikes[String(uid)] || []).concat(extra || []);
        if (!local.length || !Array.isArray(tracks)) return [];
        const have = new Set(tracks.map((t) => String(t && t.id)));
        const added = [];
        for (const l of local) {
            if (have.has(String(l.id))) continue;
            have.add(String(l.id));
            const entry = { id: Number(l.id), timestamp: l.timestamp };
            if (l.albumId) entry.albumId = Number(l.albumId);
            const ms = likeMs(l.timestamp);
            let i = tracks.findIndex((t) => t && typeof t.timestamp === 'string' && likeMs(t.timestamp) < ms);
            if (i < 0) i = tracks.length;
            tracks.splice(i, 0, entry);
            added.push(String(l.id));
        }
        if (added.length && tracks.some((t) => t && 'originalIndex' in t)) {
            tracks.forEach((t, i) => { if (t) { t.originalIndex = i; t.originalShuffleIndex = i; } });
        }
        return added;
    }

    // Лайки удалённых треков: Яндекс их хранит (collection/sync), но в «Мне нравится» не кладёт.
    // Возвращаем те, что подмена умеет играть. Список лайков запоминаем из ответов клиенту,
    // а если клиент его ещё не запрашивал — запрашиваем сами
    let serverLiked = null;
    async function serverGhostLikes() {
        if (!serverLiked) {
            try {
                const r = await apiFetch('collection/sync', { method: 'POST', body: JSON.stringify({ likedTracks: {} }), headers: { 'content-type': 'application/json' } });
                rememberServerLikes(await r.json());
            } catch (_) {}
        }
        return (serverLiked || []).filter((l) => !isCustomId(l.id) && getReplacementUrl(l.id));
    }
    function rememberServerLikes(data) {
        const body = resultOf(data);
        const lt = body && body.values && body.values.likedTracks;
        const liked = lt && lt.values && lt.values.liked;
        if (Array.isArray(liked)) serverLiked = liked.map((x) => ({ id: String(x.trackId), albumId: x.albumId ? String(x.albumId) : '', timestamp: x.timestamp }));
        return lt;
    }

    // Блок «Мне нравится» на странице «Коллекция» (landing-blocks/collection/playlist-with-likes):
    // первые count треков целиком и общий счётчик, без времени лайка. Время берём из списка
    // лайков Яндекса, свои и удалённые треки ставим на место по нему
    async function mergeLikesBlock(url, data) {
        const body = resultOf(data);
        if (!body || !Array.isArray(body.tracks)) return;
        const uid = await selfUid();
        const own = (uid && window.__fkcLikes[uid]) || [];
        const ghosts = await serverGhostLikes();
        const has = (id) => body.tracks.some((t) => t && String(idOf(t)) === String(id));
        const extras = own.concat(ghosts).filter((l, i, all) => !has(l.id) && all.findIndex((x) => String(x.id) === String(l.id)) === i);
        if (!extras.length) return;
        let count = body.tracks.length;
        try { count = Number(new URL(url).searchParams.get('count')) || count; } catch (_) {}

        const timeOf = new Map((serverLiked || []).concat(own).map((l) => [String(l.id), likeMs(l.timestamp)]));
        const rows = body.tracks.map((t) => ({ t, ms: timeOf.has(String(idOf(t))) ? timeOf.get(String(idOf(t))) : null }));
        // в блок попадут только те, что новее последнего показанного трека (или блок неполный)
        const lastMs = rows.reduce((m, r) => (r.ms != null ? Math.min(m, r.ms) : m), Infinity);
        const fits = extras.filter((l) => rows.length < count || likeMs(l.timestamp) > lastMs);
        const asString = body.tracks.some((t) => t && typeof t.id === 'string');
        let dtos = [];
        const real = fits.filter((l) => !isCustomId(l.id)).map((l) => l.albumId ? l.id + ':' + l.albumId : l.id);
        if (real.length) { try { dtos = await fetchTracks(real); } catch (_) {} }
        for (const l of fits.sort((a, b) => likeMs(b.timestamp) - likeMs(a.timestamp))) {
            const t = isCustomId(l.id) ? customTrackDto(l.id) : dtos.find((d) => String(idOf(d)) === String(l.id));
            if (!t) continue;
            if (asString) t.id = String(t.id);
            const ms = likeMs(l.timestamp);
            let i = rows.findIndex((r) => r.ms != null && r.ms < ms);
            if (i < 0) i = rows.length;
            rows.splice(i, 0, { t, ms });
        }
        body.tracks.splice(0, body.tracks.length, ...rows.slice(0, count).map((r) => r.t));
        // свои треки Яндекс не считает; удалённые в счётчике уже есть (лайк у него хранится)
        const ownExtra = extras.filter((l) => isCustomId(l.id)).length;
        if (body.summary && typeof body.summary.count === 'number') body.summary.count += ownExtra;
    }

    // ---- Поиск: удалённые и свои треки и альбомы из базы ----
    // Яндекс их не находит — у него их нет. Индекс собираем один раз на версию списков:
    // свои треки — из записи, удалённые треки альбомов базы — через API (названия и исполнители
    // уже с подменой), альбомы — удалённые и созданные с нуля
    const normText = (x) => String(x || '').toLowerCase().replace(/ё/g, 'е').replace(/[^0-9a-zа-я]+/g, ' ').trim();
    let searchIndex = null, searchIndexFor = null, searchIndexBuilding = null;

    async function buildSearchIndex() {
        const m = getMeta();
        const tracks = [], albums = [];
        const ids = new Set();
        for (const [albumId, al] of Object.entries(m.albums)) {
            for (const vol of al.volumes || []) for (const x of vol) ids.add(String(idOf(x)));
            ids.add('album:' + albumId);
        }
        const trackIds = [...ids].filter((x) => !x.startsWith('album:'));
        // свои треки — сразу, удалённые — после ответа API (подмена отметит их как недоступные)
        const real = trackIds.filter((id) => !isCustomId(id));
        // пачки по 100 — параллельно, не больше четырёх разом
        const chunks = [];
        for (let i = 0; i < real.length; i += 100) chunks.push(real.slice(i, i + 100));
        const dtoById = new Map();
        for (let i = 0; i < chunks.length; i += 4) {
            const got = await Promise.all(chunks.slice(i, i + 4).map((c) => fetchTracks(c).catch(() => [])));
            for (const list of got) for (const d of list) if (d) dtoById.set(String(idOf(d)), d);
        }
        const artistsOf = (list) => (list || []).map((a) => a && a.name).filter(Boolean).join(', ');
        for (const id of trackIds) {
            const dto = isCustomId(id) ? customTrackDto(id) : dtoById.get(id);
            // живой трек Яндекс найдёт сам — кроме переименованного базой: по новому названию не найдёт
            const renamed = !!(m.tracks[id] && m.tracks[id].title);
            if (!dto || (!isCustomId(id) && !window.__fkcGhost.has(id) && !renamed)) continue;
            const title = dto.title || '';
            tracks.push({ id, dto, key: normText(title + ' ' + artistsOf(dto.artists)), title: normText(title) });
        }
        const albumIds = Object.keys(m.albums);
        let fetched = [];
        try { fetched = await fetchAlbums(albumIds); } catch (_) {}
        for (const a of fetched) {
            const id = String(idOf(a));
            if (!a || a.error || !goneAlbums.has(id)) continue;
            albums.push({ id, dto: a, key: normText((a.title || '') + ' ' + artistsOf(a.artists)), title: normText(a.title) });
        }
        return { tracks, albums };
    }

    async function getSearchIndex() {
        const m = getMeta();
        if (searchIndex && searchIndexFor === m) return searchIndex;
        if (!searchIndexBuilding) {
            searchIndexBuilding = buildSearchIndex().then((ix) => { searchIndex = ix; searchIndexFor = m; return ix; })
                .finally(() => { searchIndexBuilding = null; });
        }
        return searchIndexBuilding;
    }

    async function mergeSearch(url, data) {
        const body = resultOf(data);
        if (!body || !Array.isArray(body.results)) return;
        let text = body.text || '', types = [];
        try { const u = new URL(url); text = u.searchParams.get('text') || text; types = (u.searchParams.get('type') || '').split(','); } catch (_) {}
        const words = normText(text).split(' ').filter(Boolean);
        if (!words.length) return;
        // первая страница; вкладка «Треки» или «Альбомы» — только свой тип
        try { if (Number(new URL(url).searchParams.get('page') || 0) > 0) return; } catch (_) {}
        const want = (t) => !types.length || !types[0] || types.includes(t);
        const ix = await getSearchIndex();
        const match = (e) => words.every((w) => e.key.includes(w));
        // сначала точное совпадение названия, потом — начало названия
        const score = (e) => (e.title === words.join(' ') ? 0 : e.title.startsWith(words.join(' ')) ? 1 : 2);
        const have = (type, id) => body.results.some((r) => r && r.type === type && r[type] && String(idOf(r[type])) === id);
        const add = [];
        if (want('track')) for (const e of ix.tracks.filter(match).sort((a, b) => score(a) - score(b)).slice(0, 10)) {
            if (have('track', e.id)) continue;
            const t = Object.assign({}, e.dto);
            if (body.results.some((r) => r && r.track && typeof r.track.id === 'string')) t.id = String(t.id);
            add.push({ type: 'track', track: t });
        }
        if (want('album')) for (const e of ix.albums.filter(match).sort((a, b) => score(a) - score(b)).slice(0, 5)) {
            if (!have('album', e.id)) add.push({ type: 'album', album: Object.assign({}, e.dto) });
        }
        if (!add.length) return;
        // после лучшего результата Яндекса (на вкладке «Топ» он первый), иначе — в начало
        const at = body.results.length && types.length > 1 ? 1 : 0;
        body.results.splice(at, 0, ...add);
    }

    // плейлист «Мне нравится» (kind 3): трек-лист, счётчик и длительность
    async function mergeLikedPlaylist(pl) {
        if (!pl || pl.kind !== 3 || !Array.isArray(pl.tracks) || !pl.owner) return;
        // чужой плейлист «Мне нравится» (открыли профиль друга) — свои лайки туда не подмешиваем
        if (String(pl.owner.uid) !== await selfUid()) return;
        if (typeof pl.revision === 'number') likesRevision = Math.max(likesRevision, pl.revision);
        const added = mergeLikes(pl.owner.uid, pl.tracks, await serverGhostLikes());
        if (!added.length) return;
        if (typeof pl.trackCount === 'number') pl.trackCount += added.length;
        // в «полном» ответе у записей есть сам трек — добавленным его тоже нужен
        const rich = pl.tracks.some((t) => t && t.track);
        let dtos = [];
        if (rich) {
            try { dtos = await fetchTracks(added); } catch (_) {}
        }
        for (const id of added) {
            const e = pl.tracks.find((t) => t && String(t.id) === id);
            const dto = (isCustomId(id) && customTrackDto(id)) || dtos.find((d) => String(idOf(d)) === id);
            if (rich && e && dto) e.track = dto;
            const dur = (dto && dto.durationMs) || (getMeta().tracks[id] || {}).durationMs || 0;
            if (typeof pl.durationMs === 'number') pl.durationMs += dur;
        }
    }

    // Аватарки исполнителей. В записи альбома из базы исполнители — только имя и id, и у удалённого
    // или созданного с нуля альбома клиенту неоткуда взять аватарку (рядом с именем пусто).
    // Недостающие берём одним запросом по id и запоминаем
    const artistCovers = {};
    const coverAsked = new Set();
    async function fillArtistCovers(data) {
        const need = [];
        const lists = [];
        const body = data && typeof data === 'object' ? data : null;
        if (!body) return;
        // сам альбом и его треки с исполнителями из базы (свои треки, подменённые исполнители)
        const m = getMeta();
        const owners = [body];
        for (const t of (Array.isArray(body.volumes) ? body.volumes : []).flat()) {
            const spoof = t && typeof t === 'object' ? m.tracks[idOf(t)] : null;
            if (spoof && spoof.artists) owners.push(t);
        }
        for (const o of owners) {
            if (!Array.isArray(o.artists) || !o.artists.length) continue;
            lists.push(o.artists);
            for (const a of o.artists) {
                const id = a && a.id != null ? String(a.id) : '';
                if (!id || (a.cover && a.cover.uri)) continue;
                if (!artistCovers[id] && !coverAsked.has(id) && !need.includes(id)) need.push(id);
            }
        }
        if (need.length) {
            need.forEach((id) => coverAsked.add(id));
            try {
                const form = new URLSearchParams({ 'artist-ids': need.slice(0, 50).join(',') });
                const r = await apiFetch('artists', { method: 'POST', body: form });
                const list = ((await r.json()) || {}).result || [];
                for (const a of list) if (a && a.cover && a.cover.uri) artistCovers[String(a.id)] = a.cover;
            } catch (_) {}
        }
        for (const l of lists) {
            for (const a of l) {
                const c = a && artistCovers[String(a.id)];
                if (c && !(a.cover && a.cover.uri)) a.cover = Object.assign({}, c);
            }
        }
    }

    async function processApi(url, data) {
        const path = url.slice(API_PREFIX.length).split('?')[0].split('/').filter(Boolean);
        const [root, id, sub] = path;
        if (root === 'albums') {
            // ответ бывает в обёртке { result } (свои запросы) и без неё (запросы клиента)
            const body = resultOf(data);
            // альбомы-заглушки «not-found» оживляем до остального: у них нет даже названия
            if (isNum(id) && body && typeof body === 'object' && !Array.isArray(body) && body.error && body.id == null) body.id = Number(id);
            for (const a of Array.isArray(body) ? body : [body]) {
                if (a && typeof a === 'object' && a.id != null && a.error && albumMeta(idOf(a))) applyAlbum(a);
            }
            if (isNum(id) && sub === 'with-tracks') {
                let richHint = null;
                try {
                    const q = new URL(url).searchParams.get('richTracks');
                    if (q === 'true' || q === 'false') richHint = q === 'true';
                } catch (_) {}
                await applyAlbumVolumes(id, body, richHint);
            }
            // у альбома из базы исполнители могут быть без аватарок
            if (isNum(id)) {
                walk(data, 0);
                await fillArtistCovers(body);
                return;
            }
        }
        else if (root === 'playlist' || (root === 'users' && sub === 'playlists')) {
            const body = resultOf(data);
            for (const pl of Array.isArray(body) ? body : [body]) await mergeLikedPlaylist(pl);
        }
        else if (root === 'search') {
            await mergeSearch(url, data);
        }
        else if (root === 'landing-blocks' && id === 'collection' && sub === 'playlist-with-likes') {
            await mergeLikesBlock(url, data);
        }
        else if (root === 'collection' && id === 'sync') {
            const lt = rememberServerLikes(data);
            const liked = lt && lt.values && lt.values.liked;
            const uid = await selfUid();
            if (Array.isArray(liked) && uid) {
                const have = new Set(liked.map((x) => String(x.trackId)));
                for (const l of window.__fkcLikes[uid] || []) {
                    if (have.has(String(l.id))) continue;
                    liked.push({ trackId: String(l.id), albumId: l.albumId ? String(l.albumId) : undefined, timestamp: l.timestamp });
                }
                liked.sort((a, b) => likeMs(b.timestamp) - likeMs(a.timestamp));
            }
        }
        else if (root === 'users' && sub === 'likes' && path[3] === 'tracks' && !path[4]) {
            const body = resultOf(data);
            const lib = body && body.library;
            if (lib && Array.isArray(lib.tracks)) {
                if (typeof lib.revision === 'number') likesRevision = Math.max(likesRevision, lib.revision);
                if (String(id) === await selfUid()) mergeLikes(id, lib.tracks);
            }
        }
        else if (root === 'artists' && isNum(id)) {
            if (sub === 'tracks') await insertArtistTracks(id, data);
            else if (sub === 'track-ids') insertArtistTrackIds(id, data);
            else if (sub === 'direct-albums' || sub === 'safe-direct-albums') await insertArtistAlbums(id, data, url);
            else if (sub === 'blocks' && path[3] === 'artist-albums') await artistAlbumBlock(id, data);
            else if (sub === 'skeletons') ensureAlbumsBlock(id, data);
        }
        walk(data, 0);
    }

    if (!Response.prototype.__fkcPatched) {
        const origJson = Response.prototype.json;
        Response.prototype.json = async function() {
            const data = await origJson.call(this);
            if (window.__fkCensorEnabled === true && typeof this.url === 'string' && this.url.startsWith(API_PREFIX)) {
                try {
                    await processApi(this.url, data);
                }
                catch (e) { console.error('[F_ckCensor] подмена метаданных:', e && e.message); }
            }
            return data;
        };
        Response.prototype.__fkcPatched = true;
        console.log('[F_ckCensor] перехват ответов API включён');
    }

    // ---- Значок F_ckCensor рядом с названием подменённого трека, альбома, исполнителя ----
    const SVG_NS = 'http://www.w3.org/2000/svg';
    const XLINK_NS = 'http://www.w3.org/1999/xlink';
    const BADGE_ATTR = 'data-fkc-badge';
    // карандаш клиента — для пунктов меню «Подменить …»: это действие «изменить»
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
        // звёздочка — та самая «*» из f*ck, знак запикивания; цвет — как у родных меток
        svg.setAttribute('viewBox', '0 0 16 16');
        svg.setAttribute('fill', 'none');
        const path = document.createElementNS(SVG_NS, 'path');
        path.setAttribute('d', 'M8 2.5v11M3.2 5.25l9.6 5.5M3.2 10.75l9.6-5.5');
        path.setAttribute('stroke', 'currentColor');
        path.setAttribute('stroke-width', '1.6');
        path.setAttribute('stroke-linecap', 'round');
        path.setAttribute('fill', 'none');
        svg.appendChild(path);
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
        if (!badge) badge = makeBadge('Трек был подменён F_ckCensor');
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

    // Значок альбома — в строке «исполнитель · год» под названием, после года
    function updateHeaderMeta(meta, spoofed, label) {
        let badge = meta.querySelector(':scope > [' + BADGE_ATTR + ']');
        if (!spoofed) {
            if (badge) badge.remove();
            return;
        }
        if (!badge) badge = makeBadge(label);
        badge.style.marginLeft = '6px';
        badge.style.display = 'inline-flex';
        badge.style.alignItems = 'center';
        // строка — обычный текст, значок встаёт по базовой линии и торчит вверх: опускаем
        // его к середине года (замерено в клиенте)
        badge.style.verticalAlign = '-4px';
        if (meta.lastElementChild !== badge) meta.appendChild(badge);
    }

    function refreshBadges() {
        document.querySelectorAll('[class*="Meta_titleContainer__"]').forEach(updateTrackTitle);

        const params = new URLSearchParams(location.search);
        const m = getMeta();
        const enabled = window.__fkCensorEnabled === true;
        if (location.pathname.startsWith('/album')) {
            const albumId = params.get('albumId');
            const spoofed = enabled && !!albumMeta(albumId);
            const header = document.querySelector('[class*="CommonAlbumPage_header__"]');
            const meta = header && header.querySelector('[class*="PageHeaderAlbumMeta_meta__"]');
            // у названия значка нет, когда есть строка с исполнителем — он стоит там
            if (header) header.querySelectorAll('[class*="PageHeaderTitle_stickyTitle__"]')
                .forEach((t) => updateHeaderTitle(t, spoofed && !meta, 'Альбом был подменён F_ckCensor'));
            if (meta && !hasAddonBadge(header)) updateHeaderMeta(meta, spoofed, 'Альбом был подменён F_ckCensor');
        }
        if (location.pathname.startsWith('/artist')) {
            const artistId = params.get('artistId');
            const spoofed = enabled && (!!m.artists[artistId] || insertionsFor(artistId, 'tracks').length + insertionsFor(artistId, 'albums').length > 0);
            document.querySelectorAll('[class*="ArtistPage_header__"] [class*="PageHeaderTitle_stickyTitle__"]')
                .forEach((t) => updateHeaderTitle(t, spoofed, 'Исполнитель был подменён F_ckCensor'));
        }
    }

    // Обновляем не чаще раза в 300 мс: клиент перерисовывает DOM постоянно (прогресс, анимации)
    let badgeTimer = null;
    function scheduleBadges() {
        if (badgeTimer) return;
        badgeTimer = setTimeout(() => {
            badgeTimer = null;
            try { refreshBadges(); } catch (e) { console.error('[F_ckCensor] значки:', e && e.message); }
        }, 300);
    }
    window.__fkcBadgesRefresh = scheduleBadges;

    (function startBadges() {
        if (!document.body) return setTimeout(startBadges, 200);
        new MutationObserver((mutations) => {
            // Свои значки не перезапускают обход
            // Пункт «Подменить трек» нужен сразу, пока меню открыто
            if (mutations.some((mu) => mu.addedNodes.length)) {
                try { injectTrackMenus(); injectAlbumMenus(); } catch (e) { console.error('[F_ckCensor] меню:', e && e.message); }
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
            const req = indexedDB.open(LOCAL_DB, 2);
            req.onupgradeneeded = () => {
                const db = req.result;
                for (const name of [LOCAL_STORE, 'albums']) {
                    if (!db.objectStoreNames.contains(name)) db.createObjectStore(name, { keyPath: 'id' });
                }
            };
            req.onsuccess = () => resolve(req.result);
            req.onerror = () => reject(req.error);
        });
    }

    async function idbRun(mode, fn, store) {
        const name = store || LOCAL_STORE;
        const db = await idb();
        return new Promise((resolve, reject) => {
            const tx = db.transaction(name, mode);
            const req = fn(tx.objectStore(name));
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
        // свой трек, которого нет в Яндекс Музыке: из чего собрать его данные
        if (rec.custom) {
            Object.assign(localTracks[rec.id], {
                custom: true,
                artists: rec.artists || [],
                albumId: rec.albumId || '',
                albumTitle: rec.albumTitle || '',
                albumArtists: rec.albumArtists || [],
                albumCover: rec.albumCover || '',
            });
        }
    }

    async function loadLocalTracks() {
        try {
            const all = await idbRun('readonly', (st) => st.getAll());
            for (const rec of all || []) rememberLocal(rec);
            if ((all || []).length) console.log('[F_ckCensor] своих подмен:', all.length);
            scheduleBadges();
        } catch (e) { console.error('[F_ckCensor] своя подмена (загрузка):', e && e.message); }
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
        if (link) {
            try { return new URL(link.getAttribute('href'), location.href).searchParams.get('trackId'); } catch (_) {}
        }
        // Плеер «Моей волны» ссылок на трек не показывает — берём id из React
        return trackIdFromFiber(btn);
    }

    // id трека из аналитического контекста React (props objectType: 'track', objectId),
    // которым клиент оборачивает плееры. Имена свойств не минифицируются.
    function trackIdFromFiber(el) {
        const key = el && Object.keys(el).find((k) => k.startsWith('__reactFiber$'));
        let f = key ? el[key] : null;
        for (let i = 0; f && i < 60; i++, f = f.return) {
            const p = f.memoizedProps;
            if (p && p.objectType === 'track' && p.objectId != null) return String(p.objectId);
        }
        return null;
    }

    function injectTrackMenus() {
        document.querySelectorAll('[data-test-id="TRACK_CONTEXT_MENU"], [data-test-id="VIBE_CONTEXT_MENU"]').forEach((menu) => {
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
        '.fkc-coverbtn{position:relative;padding:0;border:0;background:none;cursor:pointer;border-radius:14px;flex-shrink:0}',
        '.fkc-coverhint{position:absolute;inset:0;display:flex;align-items:center;justify-content:center;border-radius:14px;',
        'font-size:14px;font-weight:600;color:#fff;background:rgba(0,0,0,.5);opacity:0;transition:opacity .15s}',
        '.fkc-coverbtn:hover .fkc-coverhint{opacity:1}',
        '.fkc-small{font-size:13px}',
        '.fkc-artists{align-items:center;padding:10px 12px;gap:8px}',
        '.fkc-artists-sm{padding:8px}',
        '.fkc-chip-x{border:0;font:inherit;cursor:pointer;height:32px;box-sizing:border-box}',
        '.fkc-chip-x:hover:not(:disabled){text-decoration:line-through}',
        '.fkc-chip-x:disabled{cursor:default;opacity:.6}',
        '.fkc-round{width:32px;height:32px;border:0;border-radius:50%;cursor:pointer;flex-shrink:0;display:flex;align-items:center;',
        'justify-content:center;padding:0;background:var(--ym-controls-color-secondary-default-hovered,rgba(255,255,255,.12));',
        'color:var(--ym-controls-color-secondary-on_default-enabled,#e6e6e6)}',
        '.fkc-round:hover{background:var(--ym-controls-color-secondary-default-pressed,rgba(255,255,255,.2))}',
        '.fkc-round svg{width:16px;height:16px;fill:none;stroke:currentColor;stroke-width:1.8;stroke-linecap:round;stroke-linejoin:round}',
        '.fkc-swrow{display:flex;align-items:center;justify-content:space-between;gap:12px;font-size:16px;font-weight:600;cursor:pointer;',
        'color:var(--ym-controls-color-secondary-text-enabled_variant,#fff);transition:color .15s}',
        '.fkc-swrow input{display:none}',
        '.fkc-swrow i{width:34px;height:20px;border-radius:10px;position:relative;flex-shrink:0;transition:background .15s;',
        'background:var(--ym-controls-color-secondary-default-hovered,rgba(255,255,255,.2))}',
        '.fkc-swrow i::after{content:"";position:absolute;left:3px;top:3px;width:14px;height:14px;border-radius:50%;',
        'background:var(--ym-controls-color-secondary-text-enabled,rgba(255,255,255,.5));transition:transform .15s,background .15s}',
        '.fkc-swrow input:checked+i{background:var(--ym-controls-color-primary-default-enabled,#ff0)}',
        '.fkc-swrow input:checked+i::after{transform:translateX(14px);background:#000}',
        '.fkc-swrow.fkc-off{cursor:default;color:var(--ym-controls-color-primary-text-disabled,rgba(255,255,255,.3))}',
        '.fkc-swrow.fkc-off i{opacity:.5}',
        '.fkc-panel{border-radius:12px;padding:8px;background:var(--ym-surface-color-primary-enabled-list,rgba(255,255,255,.08))}',
        '.fkc-tracks{display:flex;flex-direction:column;max-height:320px;overflow:auto}',
        '.fkc-trow{display:flex;align-items:center;gap:12px;padding:8px;border-radius:10px}',
        '.fkc-trow:hover{background:var(--ym-controls-color-secondary-default-enabled,rgba(255,255,255,.05))}',
        '.fkc-tcover{width:40px;height:40px;border-radius:6px;object-fit:cover;flex-shrink:0;background:rgba(255,255,255,.12)}',
        '.fkc-idx{display:flex;flex-direction:column;flex-shrink:0}',
        '.fkc-idx button{width:22px;height:16px;padding:0;border:0;background:none;cursor:pointer;',
        'color:var(--ym-controls-color-primary-text-enabled,rgba(255,255,255,.5))}',
        '.fkc-idx button:hover:not(:disabled){color:var(--ym-controls-color-secondary-on_default-enabled,#fff)}',
        '.fkc-idx button:disabled{opacity:.3;cursor:default}',
        '.fkc-idx svg{width:100%;height:100%}',
        'svg.fkc-filled{fill:currentColor;stroke:none}',
        '.fkc-disk{display:flex;align-items:center;justify-content:space-between;padding:10px 8px 4px;font-size:15px;font-weight:700;',
        'color:var(--ym-controls-color-secondary-text-enabled_variant,#fff)}',
        '.fkc-disk .fkc-round{width:26px;height:26px}',
        '.fkc-addarea{padding:8px}',
        '.fkc-addrow{display:flex;gap:16px}',
        '.fkc-dashed{flex:1;height:44px;border-radius:8px;font:inherit;font-size:14px;font-weight:500;cursor:pointer;background:none;',
        'border:2px dashed var(--ym-controls-color-primary-text-enabled,rgba(255,255,255,.5));',
        'color:var(--ym-controls-color-primary-text-enabled,rgba(255,255,255,.5))}',
        '.fkc-dashed:hover{color:var(--ym-controls-color-secondary-text-enabled_variant,#fff);border-color:currentColor}',
        '.fkc-searchline{display:flex;align-items:center;gap:10px;margin-top:8px}',
        '.fkc-searchline .fkc-search{flex:1}',
        '.fkc-ownfile{display:flex;align-items:center;gap:8px;padding:0 16px}',
        '.fkc-ownfile svg{width:16px;height:16px;fill:none;stroke:currentColor;stroke-width:1.5;stroke-linejoin:round}',
        '.fkc-cform{display:flex;flex-direction:column;gap:14px;padding:12px;border-radius:10px;',
        'background:var(--ym-controls-color-secondary-default-enabled,rgba(255,255,255,.05))}',
        '.fkc-cfile{font-size:13px;color:var(--ym-controls-color-secondary-text-enabled,rgba(255,255,255,.5))}',
        '.fkc-cbtns{justify-content:flex-end}',
        '.fkc-search{position:relative}',
        '.fkc-results[hidden],.fkc-search[hidden]{display:none}',
        '.fkc-results{position:absolute;left:0;right:0;top:calc(100% + 6px);z-index:2;display:flex;flex-direction:column;padding:6px;',
        'border-radius:12px;max-height:300px;overflow:auto;background:var(--ym-background-color-primary-enabled-popover,#1a1a1a);',
        'box-shadow:0 1px 20px rgba(0,0,0,.48)}',
        '.fkc-res{display:flex;align-items:center;gap:10px;padding:6px 8px;border:0;border-radius:8px;background:none;font:inherit;',
        'text-align:left;cursor:pointer;color:var(--ym-controls-color-secondary-text-enabled_variant,#fff)}',
        '.fkc-res:hover{background:var(--ym-controls-color-secondary-default-hovered,rgba(255,255,255,.12))}',
        '.fkc-res img,.fkc-res i{width:36px;height:36px;border-radius:6px;object-fit:cover;flex-shrink:0;background:rgba(255,255,255,.12)}',
        '.fkc-res-txt{flex:1;min-width:0;display:flex;flex-direction:column;gap:2px}',
        '.fkc-res-txt b,.fkc-res-txt span{white-space:nowrap;overflow:hidden;text-overflow:ellipsis}',
        '.fkc-res-txt b{font-size:15px;font-weight:500;color:var(--ym-controls-color-secondary-text-enabled_variant,#fff)}',
        '.fkc-res-txt span{font-size:13px;color:var(--ym-controls-color-secondary-text-enabled,rgba(255,255,255,.5))}',
        '.fkc-res-empty{padding:12px;font-size:13px;text-align:center;color:var(--ym-controls-color-secondary-text-enabled,rgba(255,255,255,.5))}',
        '.fkc-details summary{display:flex;align-items:center;gap:8px;cursor:pointer;font-size:15px;font-weight:500;list-style:none;',
        'color:var(--ym-controls-color-secondary-text-enabled,rgba(255,255,255,.6))}',
        '.fkc-details summary::-webkit-details-marker{display:none}',
        '.fkc-details summary::before{content:"";width:0;height:0;border-left:7px solid currentColor;border-top:5px solid transparent;',
        'border-bottom:5px solid transparent;transition:transform .15s}',
        '.fkc-details[open] summary::before{transform:rotate(90deg)}',
        '.fkc-info{width:16px;height:16px;border-radius:50%;border:1.5px solid currentColor;display:inline-flex;align-items:center;',
        'justify-content:center;font-size:11px;font-weight:700;font-style:normal;cursor:help;box-sizing:border-box}',
        '.fkc-props{display:flex;flex-direction:column;gap:10px;margin-top:12px}',
        '.fkc-prop{display:flex;gap:10px;align-items:center}',
        '.fkc-prop .fkc-input:first-child{width:38%;flex-shrink:0}',
        '.fkc-prop .fkc-round{align-self:center}',
        '.fkc-dialog,.fkc-tracks,.fkc-results{scrollbar-width:thin;scrollbar-color:rgba(255,255,255,.2) transparent}',
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
        // Неактивная кнопка сама объясняет почему
        function renderReport() {
            if (isReported(trackId)) { report.disabled = true; report.textContent = 'Уже отправлено'; }
            else if (hasAnySpoof(trackId)) { report.disabled = true; report.textContent = 'Уже подменяется'; }
            else { report.disabled = false; report.textContent = 'Сообщить о цензуре'; }
        }
        renderReport();
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
            await reportCensor(trackId, false, reportInfo());
            renderReport();
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
                status.textContent = 'Подменяется из базы замен.';
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

    // ---- Своя подмена альбома: пункт «Подменить альбом», окно подмены, хранение в IndexedDB ----
    // Как в аддоне FckCensor: название, обложка из файла, исполнители, трек-лист
    // (добавить поиском или по ссылке, убрать, переставить) и «Подменить исполнителей для треков».
    const localAlbums = window.__fkcLocalAlbums = window.__fkcLocalAlbums || {};
    const LOCAL_ALBUMS = 'albums';

    // Подмена альбома: своя пользователя поверх подмены из базы
    function albumMeta(id) {
        const base = getMeta().albums[id];
        const local = window.__fkCensorEnabled === true ? localAlbums[id] : null;
        if (!local) return base || null;
        const out = Object.assign({}, base || {}, local);
        if ((base && base.__fckCensor) || local.__fckCensor) out.__fckCensor = Object.assign({}, base && base.__fckCensor, local.__fckCensor);
        return out;
    }

    function rememberLocalAlbum(rec) {
        const old = localAlbums[rec.id];
        if (old && typeof old.coverUri === 'string' && old.coverUri.startsWith('blob:')) URL.revokeObjectURL(old.coverUri);
        // дополнительные поля — первыми: явные поля окна подмены важнее
        const a = Object.assign({}, rec.extra || {});
        if (rec.title) a.title = rec.title;
        // обложка из файла: клиент принимает адрес blob: как есть, без шаблона размера
        if (rec.cover) a.coverUri = URL.createObjectURL(rec.cover);
        if (Array.isArray(rec.artists) && rec.artists.length) a.artists = rec.artists;
        if (Array.isArray(rec.volumes)) a.volumes = rec.volumes.map((v) => v.map((id) => ({ id: isNum(String(id)) ? Number(id) : id })));
        if (rec.replaceArtists) a.__fckCensor = { replaceArtistsInAlbumVolumes: true };
        localAlbums[rec.id] = a;
    }

    async function loadLocalAlbums() {
        try {
            const all = await idbRun('readonly', (st) => st.getAll(), LOCAL_ALBUMS);
            for (const rec of all || []) rememberLocalAlbum(rec);
            if ((all || []).length) console.log('[F_ckCensor] своих подмен альбомов:', all.length);
            scheduleBadges();
        } catch (e) { console.error('[F_ckCensor] своя подмена альбома (загрузка):', e && e.message); }
    }

    async function saveLocalAlbum(rec) {
        await idbRun('readwrite', (st) => st.put(rec), LOCAL_ALBUMS);
        rememberLocalAlbum(rec);
        scheduleBadges();
    }

    async function removeLocalAlbum(id) {
        await idbRun('readwrite', (st) => st.delete(id), LOCAL_ALBUMS);
        const old = localAlbums[id];
        if (old && typeof old.coverUri === 'string' && old.coverUri.startsWith('blob:')) URL.revokeObjectURL(old.coverUri);
        delete localAlbums[id];
        scheduleBadges();
    }

    // id альбома у кнопки меню: на странице альбома и в карточках — из свойств React
    function albumIdFromFiber(el) {
        const key = el && Object.keys(el).find((k) => k.startsWith('__reactFiber$'));
        let f = key ? el[key] : null;
        for (let i = 0; f && i < 60; i++, f = f.return) {
            const p = f.memoizedProps;
            if (!p) continue;
            if (p.album && p.album.id != null) return String(p.album.id);
            if (p.albumId != null) return String(p.albumId);
            if (p.objectType === 'album' && p.objectId != null) return String(p.objectId);
        }
        return null;
    }

    function albumIdForMenu(menu) {
        const holder = menu.closest('[aria-labelledby]');
        const btn = holder && document.getElementById(holder.getAttribute('aria-labelledby'));
        if (!btn) return null;
        const scope = btn.closest('[class*="AlbumCard"]') || btn.parentElement;
        const link = scope && scope.querySelector('a[href*="albumId="]');
        if (link) {
            try { return new URL(link.getAttribute('href'), location.href).searchParams.get('albumId'); } catch (_) {}
        }
        const fromFiber = albumIdFromFiber(btn);
        if (fromFiber) return fromFiber;
        if (location.pathname.startsWith('/album')) return new URLSearchParams(location.search).get('albumId');
        return null;
    }

    // Пункт меню «Подменить …» по образцу первого родного пункта
    function makeMenuItem(items, text, onClick) {
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
        label.appendChild(document.createTextNode(text));
        item.addEventListener('click', (e) => {
            e.preventDefault();
            e.stopPropagation();
            document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', code: 'Escape', bubbles: true }));
            onClick();
        }, true);
        return item;
    }

    function injectAlbumMenus() {
        document.querySelectorAll('[data-test-id="ALBUM_CONTEXT_MENU"]').forEach((menu) => {
            if (menu.querySelector('[data-fkc-menuitem]')) return;
            const items = [...menu.querySelectorAll('[role="menuitem"], [role="menuitemcheckbox"]')];
            // У аддона FckCensor (PulseSync) такой пункт уже есть — второй не нужен
            if (!items.length || items.some((i) => i.textContent.trim() === 'Подменить альбом')) return;
            const albumId = albumIdForMenu(menu);
            if (!albumId || !isNum(albumId)) return;
            const item = makeMenuItem(items, 'Подменить альбом', () => openAlbumDialog(albumId));
            const last = items[items.length - 1];
            last.parentElement.insertBefore(item, last);
        });
    }

    // После изменения открытая страница альбома показывает старые данные: уходим на поиск
    // и возвращаемся — клиент заново запрашивает альбом, и подмена применяется
    function reopenAlbumPage(albumId) {
        if (!location.pathname.startsWith('/album') || new URLSearchParams(location.search).get('albumId') !== String(albumId)) return;
        const away = document.querySelector('a[href^="/search"]');
        if (!away) return;
        away.click();
        setTimeout(() => history.back(), 400);
    }

    async function searchApi(text, type) {
        const r = await apiFetch('search?text=' + encodeURIComponent(text) + '&type=' + type + '&page=0');
        const j = await r.json();
        const block = (j.result || {})[type + 's'];
        return (block && block.results) || [];
    }

    // id трека из ссылки: …?trackId=123, …/track/123 или просто число
    function trackIdFromText(text) {
        const s = text.trim();
        if (isNum(s)) return s;
        try {
            const u = new URL(s, location.href);
            const q = u.searchParams.get('trackId');
            if (q && isNum(q)) return q;
            const parts = u.pathname.split('/').filter(Boolean);
            const i = parts.lastIndexOf('track');
            if (i >= 0 && isNum(parts[i + 1] || '')) return parts[i + 1];
        } catch (_) {}
        return null;
    }

    const artistNames = (list) => (list || []).map((a) => a && a.name).filter(Boolean).join(', ');
    const sameIds = (a, b) => a.length === b.length && a.every((x, i) => String(x) === String(b[i]));

    // Поле поиска с выпадающим списком: search(text) → [{ label, sub, cover, value }], pick(value)
    function searchBox(placeholder, search, pick) {
        const wrap = el('div', 'fkc-search');
        const input = el('input', 'fkc-input');
        input.placeholder = placeholder;
        const list = el('div', 'fkc-results');
        list.hidden = true;
        wrap.appendChild(input);
        wrap.appendChild(list);
        let timer = null;
        let seq = 0;
        input.addEventListener('input', () => {
            clearTimeout(timer);
            const text = input.value.trim();
            if (!text) { list.hidden = true; return; }
            timer = setTimeout(async () => {
                const my = ++seq;
                let rows = [];
                try { rows = await search(text); } catch (_) {}
                if (my !== seq) return;
                list.textContent = '';
                if (!rows.length) list.appendChild(el('div', 'fkc-res-empty', 'Ничего не найдено'));
                for (const row of rows.slice(0, 6)) {
                    const r = el('button', 'fkc-res');
                    r.type = 'button';
                    const img = row.cover ? el('img') : el('i');
                    if (row.cover) img.src = row.cover;
                    r.appendChild(img);
                    const txt = el('div', 'fkc-res-txt');
                    txt.appendChild(el('b', null, row.label));
                    if (row.sub) txt.appendChild(el('span', null, row.sub));
                    r.appendChild(txt);
                    // mousedown, а не click: иначе поле теряет фокус раньше и список закрывается
                    r.addEventListener('mousedown', (e) => { e.preventDefault(); pick(row.value); input.value = ''; list.hidden = true; });
                    list.appendChild(r);
                }
                list.hidden = false;
            }, 300);
        });
        input.addEventListener('keydown', (e) => { if (e.key === 'Escape' && !list.hidden) { e.stopPropagation(); list.hidden = true; } });
        return { wrap, input, list };
    }

    // Маленькие иконки рисуем сами: символы стрелок шрифт клиента показывает цветными эмодзи
    const ICONS = {
        up: 'M8 4.5l4.5 6h-9z',
        down: 'M8 11.5l4.5-6h-9z',
        close: 'M4.5 4.5l7 7M11.5 4.5l-7 7',
        plus: 'M8 3.5v9M3.5 8h9',
        file: 'M9 2.5H4.5v11h7V5zM9 2.5V5h2.5',
    };
    function svgIcon(name, filled) {
        const svg = document.createElementNS(SVG_NS, 'svg');
        svg.setAttribute('viewBox', '0 0 16 16');
        const path = document.createElementNS(SVG_NS, 'path');
        path.setAttribute('d', ICONS[name]);
        svg.appendChild(path);
        if (filled) svg.setAttribute('class', 'fkc-filled');
        return svg;
    }
    function roundBtn(name, title, onClick) {
        const b = el('button', 'fkc-round');
        b.type = 'button';
        b.title = title;
        b.appendChild(svgIcon(name));
        b.addEventListener('click', onClick);
        return b;
    }
    function chip(a, onClick) {
        const c = el('button', 'fkc-chip fkc-chip-x');
        c.type = 'button';
        c.title = 'Убрать';
        const avatar = a.cover && a.cover.uri ? el('img') : el('i');
        if (a.cover && a.cover.uri) avatar.src = coverUrl(a.cover.uri, '50x50');
        c.appendChild(avatar);
        c.appendChild(document.createTextNode(a.name || ''));
        c.addEventListener('click', onClick);
        return c;
    }
    const artistSearchRows = async (text) => (await searchApi(text, 'artist')).map((a) => ({
        label: a.name, cover: a.cover && a.cover.uri ? coverUrl(a.cover.uri, '50x50') : '', value: a,
    }));
    // только нужные клиенту поля исполнителя
    const slimArtist = (a) => ({
        id: a.id, name: a.name, various: !!a.various, composer: !!a.composer,
        available: a.available !== false, cover: a.cover, genres: a.genres || [], disclaimers: a.disclaimers || [],
    });
    function uniqArtists(list) {
        const seen = new Set();
        return list.filter((a) => a && !seen.has(String(a.id)) && seen.add(String(a.id)));
    }

    // Журнал своих треков: какие треки пользователи добавили в альбомы (только в свою очередь F_ckCensor)
    async function logAddedTracks(albumId, albumTitle, albumArtists, tracks) {
        if (!OWN_REPORT_URL || !OWN_REPORT_KEY || !tracks.length) return;
        const cut = (s) => String(s || '').slice(0, 300) || null;
        const rows = tracks.map((t) => ({
            album_id: Number(albumId),
            album_title: cut(albumTitle),
            album_artists: cut(albumArtists),
            track_title: cut(t.title) || 'без названия',
            track_artists: cut(t.artists),
            client_id: clientId(),
        }));
        try {
            const r = await fetch(OWN_REPORT_URL.replace(/[/]+$/, '') + '/rest/v1/added_tracks', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json', apikey: OWN_REPORT_KEY, Authorization: 'Bearer ' + OWN_REPORT_KEY, Prefer: 'return=minimal' },
                body: JSON.stringify(rows),
            });
            if (!r.ok) console.error('[F_ckCensor] журнал своих треков: HTTP', r.status);
        } catch (e) { console.error('[F_ckCensor] журнал своих треков:', e && e.message); }
    }

    async function openAlbumDialog(albumId) {
        ensureDialogCss();
        const existing = document.querySelector('.fkc-overlay');
        if (existing) existing.remove();

        // Альбом таким, каким его видит пользователь: с подменой из базы и своей
        let album = null;
        try {
            const j = await (await apiFetch('albums/' + albumId + '/with-tracks')).json();
            album = j.result || j;
            await applyAlbumVolumes(albumId, album);
        } catch (_) {}
        if (!album || !album.id) { showToast('Не удалось загрузить альбом.'); return; }
        let saved = null;
        try { saved = await idbRun('readonly', (st) => st.get(albumId), LOCAL_ALBUMS); } catch (_) {}

        const shownTitle = album.title || '';
        const shownArtists = (album.artists || []).filter((a) => a && a.id != null);
        const coverSrc = album.coverUri || (album.cover && album.cover.uri) || album.ogImage || '';
        let artists = shownArtists.slice();
        // диски: [[{ id, t, isNew }]]; isNew — свой трек, ещё не сохранённый
        let volumes = (album.volumes || []).map((v) => v.map((t) => ({ id: idOf(t), t })));
        if (!volumes.length) volumes = [[]];
        const shownVol = JSON.stringify(volumes.map((v) => v.map((r) => r.id)));
        const shownCustom = volumes.flat().map((r) => r.id).filter(isCustomId);
        let pickedCover = null;
        const fc = (albumMeta(albumId) || {}).__fckCensor || {};

        const overlay = el('div', 'fkc-overlay');
        const dlg = el('div', 'fkc-dialog');
        overlay.appendChild(dlg);

        const head = el('div', 'fkc-head');
        head.appendChild(el('h2', 'fkc-h', 'Подмена альбома'));
        const close = el('button', 'fkc-x');
        close.setAttribute('aria-label', 'Закрыть');
        close.appendChild(spriteIcon('close_xs'));
        head.appendChild(close);
        dlg.appendChild(head);

        // обложка (нажатие — выбрать картинку) и название
        const top = el('div', 'fkc-top');
        const coverBtn = el('button', 'fkc-coverbtn');
        coverBtn.type = 'button';
        coverBtn.title = 'Выбрать обложку';
        const cover = el('img', 'fkc-cover');
        if (coverSrc) cover.src = coverUrl(coverSrc, '400x400');
        coverBtn.appendChild(cover);
        coverBtn.appendChild(el('span', 'fkc-coverhint', 'Изменить'));
        const coverInput = el('input');
        coverInput.type = 'file';
        coverInput.accept = 'image/png,image/jpeg,image/webp';
        coverInput.style.display = 'none';
        top.appendChild(coverBtn);
        top.appendChild(coverInput);
        const field = el('div', 'fkc-field');
        field.appendChild(el('div', 'fkc-label', 'Название'));
        const input = el('input', 'fkc-input');
        input.value = shownTitle;
        input.placeholder = 'Название альбома';
        field.appendChild(input);
        top.appendChild(field);
        dlg.appendChild(top);
        coverBtn.addEventListener('click', () => coverInput.click());
        coverInput.addEventListener('change', () => {
            const f = coverInput.files && coverInput.files[0];
            if (!f) return;
            pickedCover = f;
            const old = cover.src;
            cover.src = URL.createObjectURL(f);
            if (old && old.startsWith('blob:')) URL.revokeObjectURL(old);
        });

        // исполнители: нажатие убирает, «+» — поиск
        const artistsField = el('div', 'fkc-field');
        artistsField.appendChild(el('div', 'fkc-label', 'Исполнители'));
        const chips = el('div', 'fkc-artists');
        artistsField.appendChild(chips);
        const artistSearch = searchBox('Найти исполнителя', artistSearchRows, (a) => {
            if (!artists.some((x) => String(x.id) === String(a.id))) artists.push(a);
            artistSearch.wrap.hidden = true;
            renderArtists();
        });
        artistSearch.wrap.hidden = true;
        artistSearch.input.addEventListener('blur', () => { setTimeout(() => { artistSearch.wrap.hidden = true; }, 150); });
        artistsField.appendChild(artistSearch.wrap);
        dlg.appendChild(artistsField);

        const sw = el('label', 'fkc-swrow');
        sw.appendChild(el('span', null, 'Подменить исполнителей для треков'));
        const swInput = el('input');
        swInput.type = 'checkbox';
        swInput.checked = !!fc.replaceArtistsInAlbumVolumes;
        sw.appendChild(swInput);
        sw.appendChild(el('i'));
        dlg.appendChild(sw);

        const artistsChanged = () => !sameIds(artists.map((a) => a.id), shownArtists.map((a) => a.id));
        function renderArtists() {
            chips.textContent = '';
            for (const a of artists) chips.appendChild(chip(a, () => { artists = artists.filter((x) => x !== a); renderArtists(); }));
            chips.appendChild(roundBtn('plus', 'Добавить исполнителя', () => { artistSearch.wrap.hidden = false; artistSearch.input.focus(); }));
            // переключатель имеет смысл, только если исполнители альбома подменены
            const can = artistsChanged() || !!fc.replaceArtistsInAlbumVolumes;
            swInput.disabled = !can;
            sw.classList.toggle('fkc-off', !can);
        }
        renderArtists();

        // треки альбома
        const tracksField = el('div', 'fkc-field');
        tracksField.appendChild(el('div', 'fkc-label', 'Треки альбома'));
        const panel = el('div', 'fkc-panel');
        const list = el('div', 'fkc-tracks');
        const addArea = el('div', 'fkc-addarea');
        panel.appendChild(list);
        panel.appendChild(addArea);
        tracksField.appendChild(panel);
        dlg.appendChild(tracksField);

        const lastDisk = () => volumes[volumes.length - 1];
        const coverOf = (t) => (t && (t.coverUri || (t.albums && t.albums[0] && t.albums[0].coverUri))) || coverSrc;

        // перемещение как в FckCensor: на краю диска трек переходит в соседний
        function moveTrack(d, i, delta) {
            const disk = volumes[d];
            const [r] = disk.splice(i, 1);
            const j = i + delta;
            if (j >= 0 && j <= disk.length) disk.splice(j, 0, r);
            else if (j < 0 && volumes[d - 1]) volumes[d - 1].push(r);
            else if (j > disk.length && volumes[d + 1]) volumes[d + 1].unshift(r);
            else disk.splice(i, 0, r);
            renderTracks();
        }

        function trackRow(r, d, i, first, last) {
            const row = el('div', 'fkc-trow');
            const img = el('img', 'fkc-tcover');
            const c = coverOf(r.t);
            if (c) img.src = c.startsWith('blob:') ? c : coverUrl(c, '100x100');
            row.appendChild(img);
            const txt = el('div', 'fkc-res-txt');
            txt.appendChild(el('b', null, (r.t && r.t.title) || ('трек ' + r.id)));
            const sub = artistNames(r.t && r.t.artists);
            txt.appendChild(el('span', null, (r.isNew || isCustomId(r.id) ? 'свой файл · ' : '') + sub));
            row.appendChild(txt);
            const idx = el('div', 'fkc-idx');
            const up = el('button');
            up.type = 'button';
            up.title = 'Выше';
            up.disabled = first;
            up.appendChild(svgIcon('up', true));
            up.addEventListener('click', () => moveTrack(d, i, -1));
            const down = el('button');
            down.type = 'button';
            down.title = 'Ниже';
            down.disabled = last;
            down.appendChild(svgIcon('down', true));
            down.addEventListener('click', () => moveTrack(d, i, 1));
            idx.appendChild(up);
            idx.appendChild(down);
            row.appendChild(idx);
            row.appendChild(roundBtn('close', 'Убрать из альбома', () => { volumes[d].splice(i, 1); renderTracks(); }));
            return row;
        }

        function renderTracks() {
            list.textContent = '';
            const total = volumes.reduce((n, v) => n + v.length, 0);
            let seen = 0;
            volumes.forEach((disk, d) => {
                if (volumes.length > 1) {
                    const h = el('div', 'fkc-disk', 'Диск ' + (d + 1));
                    if (!disk.length) {
                        h.appendChild(roundBtn('close', 'Убрать пустой диск', () => { volumes.splice(d, 1); renderTracks(); }));
                    }
                    list.appendChild(h);
                }
                disk.forEach((r, i) => {
                    list.appendChild(trackRow(r, d, i, seen === 0, seen === total - 1));
                    seen++;
                });
                if (!disk.length) list.appendChild(el('div', 'fkc-res-empty', volumes.length > 1 ? 'Пустой диск' : 'В альбоме нет треков'));
            });
        }
        renderTracks();

        // добавление трека: кнопки → поиск или свой файл → форма своего трека
        let mode = 'buttons';
        let pending = null; // { file, durationMs, codec } — выбранный свой файл
        const audioInput = el('input');
        audioInput.type = 'file';
        audioInput.accept = 'audio/*,.mp3,.flac,.m4a,.aac,.ogg,.wav';
        audioInput.style.display = 'none';
        panel.appendChild(audioInput);

        function dashed(text, onClick) {
            const b = el('button', 'fkc-dashed', text);
            b.type = 'button';
            b.addEventListener('click', onClick);
            return b;
        }

        function renderAdd() {
            addArea.textContent = '';
            if (mode === 'buttons') {
                const row = el('div', 'fkc-addrow');
                row.appendChild(dashed('Добавить трек', () => { mode = 'search'; renderAdd(); }));
                row.appendChild(dashed('Добавить диск', () => { volumes.push([]); renderTracks(); }));
                addArea.appendChild(row);
                return;
            }
            if (mode === 'search') {
                addArea.appendChild(el('div', 'fkc-label fkc-small', 'Поиск по тексту / Ссылка на трек'));
                const line = el('div', 'fkc-searchline');
                const search = searchBox('Поиск...',
                    async (text) => {
                        const id = trackIdFromText(text);
                        const found = id ? await fetchTracks([id]) : await searchApi(text, 'track');
                        return found.map((t) => ({
                            label: t.title + (t.version ? ' (' + t.version + ')' : ''),
                            sub: artistNames(t.artists) + (t.durationMs ? ' · ' + fmtTime(t.durationMs) : '') +
                                (t.available === false ? ' · недоступен' : ''),
                            cover: t.coverUri ? coverUrl(t.coverUri, '50x50') : '',
                            value: t,
                        }));
                    },
                    (t) => {
                        const id = idOf(t);
                        if (volumes.flat().some((r) => r.id === id)) { showToast('Этот трек уже есть в альбоме.'); return; }
                        lastDisk().push({ id, t });
                        mode = 'buttons';
                        renderTracks();
                        renderAdd();
                    });
                line.appendChild(search.wrap);
                const own = el('button', 'fkc-btn fkc-secondary fkc-ownfile');
                own.type = 'button';
                own.appendChild(svgIcon('file'));
                own.appendChild(document.createTextNode('Свой файл'));
                own.addEventListener('mousedown', (e) => e.preventDefault());
                own.addEventListener('click', () => audioInput.click());
                line.appendChild(own);
                line.appendChild(roundBtn('close', 'Отмена', () => { mode = 'buttons'; renderAdd(); }));
                addArea.appendChild(line);
                setTimeout(() => search.input.focus(), 0);
                return;
            }
            // форма своего трека
            const form = el('div', 'fkc-cform');
            form.appendChild(el('div', 'fkc-cfile', 'Файл: ' + pending.file.name + (pending.durationMs ? ' · ' + fmtTime(pending.durationMs) : '')));
            const f1 = el('div', 'fkc-field');
            f1.appendChild(el('div', 'fkc-label fkc-small', 'Название трека'));
            const tIn = el('input', 'fkc-input');
            tIn.value = pending.file.name.split('.').slice(0, -1).join('.') || pending.file.name;
            tIn.placeholder = 'Название трека';
            f1.appendChild(tIn);
            form.appendChild(f1);
            const f2 = el('div', 'fkc-field');
            f2.appendChild(el('div', 'fkc-label fkc-small', 'Дополнительный исполнитель (необязательно)'));
            const extraChips = el('div', 'fkc-artists fkc-artists-sm');
            const extra = [];
            const extraSearch = searchBox('Найти исполнителя', artistSearchRows, (a) => {
                if (!extra.some((x) => String(x.id) === String(a.id)) && !artists.some((x) => String(x.id) === String(a.id))) extra.push(a);
                extraSearch.wrap.hidden = true;
                renderExtra();
            });
            extraSearch.wrap.hidden = true;
            function renderExtra() {
                extraChips.textContent = '';
                for (const a of artists) {
                    const c = chip(a, () => {});
                    c.disabled = true;
                    c.title = 'Исполнитель альбома';
                    extraChips.appendChild(c);
                }
                for (const a of extra) extraChips.appendChild(chip(a, () => { extra.splice(extra.indexOf(a), 1); renderExtra(); }));
                extraChips.appendChild(roundBtn('plus', 'Добавить исполнителя', () => { extraSearch.wrap.hidden = false; extraSearch.input.focus(); }));
            }
            renderExtra();
            f2.appendChild(extraChips);
            f2.appendChild(extraSearch.wrap);
            form.appendChild(f2);
            const btns = el('div', 'fkc-foot-right fkc-cbtns');
            const cancel = el('button', 'fkc-btn fkc-secondary', 'Отмена');
            const add = el('button', 'fkc-btn fkc-primary', 'Добавить в альбом');
            cancel.type = add.type = 'button';
            cancel.addEventListener('click', () => { pending = null; mode = 'buttons'; renderAdd(); });
            add.addEventListener('click', () => {
                const title = tIn.value.trim();
                if (!title) { tIn.focus(); return; }
                const id = allocCustomId();
                lastDisk().push({
                    id,
                    t: { title, artists: artists.concat(extra), coverUri: coverSrc },
                    isNew: { title, extra: extra.slice(), file: pending.file, durationMs: pending.durationMs, codec: pending.codec },
                });
                pending = null;
                mode = 'buttons';
                renderTracks();
                renderAdd();
            });
            btns.appendChild(cancel);
            btns.appendChild(add);
            form.appendChild(btns);
            addArea.appendChild(form);
            setTimeout(() => tIn.select(), 0);
        }
        audioInput.addEventListener('change', async () => {
            const f = audioInput.files && audioInput.files[0];
            audioInput.value = '';
            if (!f) return;
            const durationMs = await audioDuration(f);
            if (durationMs < 0) { showToast('Файл не похож на аудио.'); return; }
            pending = { file: f, durationMs, codec: codecOfFile(f) };
            mode = 'custom';
            renderAdd();
        });
        renderAdd();

        // дополнительные поля: любые свойства альбома в формате API (как в FckCensor)
        const details = el('details', 'fkc-details');
        const summary = el('summary', null, 'Дополнительные поля (продвинуто)');
        const info = el('span', 'fkc-info', 'i');
        info.title = 'Любые свойства альбома в формате API Яндекс Музыки: имя поля и значение. ' +
            'Значение можно писать как JSON (число, true, список) — иначе это строка. Например: year → 2024.';
        summary.appendChild(info);
        details.appendChild(summary);
        const props = el('div', 'fkc-props');
        details.appendChild(props);
        const extraRows = [];
        function addProp(k, v) {
            const row = el('div', 'fkc-prop');
            const kIn = el('input', 'fkc-input');
            kIn.placeholder = 'поле';
            kIn.value = k || '';
            const vIn = el('input', 'fkc-input');
            vIn.placeholder = 'значение';
            vIn.value = v === undefined ? '' : typeof v === 'string' ? v : JSON.stringify(v);
            const entry = { kIn, vIn };
            row.appendChild(kIn);
            row.appendChild(vIn);
            row.appendChild(roundBtn('close', 'Убрать поле', () => { row.remove(); extraRows.splice(extraRows.indexOf(entry), 1); }));
            extraRows.push(entry);
            props.insertBefore(row, addPropBtn);
        }
        const addPropBtn = dashed('Добавить поле', () => addProp());
        props.appendChild(addPropBtn);
        for (const [k, v] of Object.entries((saved && saved.extra) || {})) addProp(k, v);
        if (saved && saved.extra && Object.keys(saved.extra).length) details.open = true;
        dlg.appendChild(details);
        function readExtra() {
            const out = {};
            for (const { kIn, vIn } of extraRows) {
                const k = kIn.value.trim();
                if (!k || k === 'id' || k === 'volumes') continue;
                const raw = vIn.value.trim();
                let v = raw;
                try { v = JSON.parse(raw); } catch (_) {}
                out[k] = v;
            }
            return out;
        }

        const foot = el('div', 'fkc-foot');
        const report = el('button', 'fkc-btn fkc-primary', 'Сообщить о цензуре');
        function renderReport() {
            if (isReported(albumId, 'album')) { report.disabled = true; report.textContent = 'Уже отправлено'; }
            else if (getMeta().albums[albumId]) { report.disabled = true; report.textContent = 'Уже подменяется'; }
            else { report.disabled = false; report.textContent = 'Сообщить о цензуре'; }
        }
        renderReport();
        const right = el('div', 'fkc-foot-right');
        const del = el('button', 'fkc-btn fkc-secondary', 'Удалить подмену');
        del.disabled = !saved;
        const apply = el('button', 'fkc-btn fkc-primary', 'Применить');
        right.appendChild(del);
        right.appendChild(apply);
        foot.appendChild(report);
        foot.appendChild(right);
        dlg.appendChild(foot);

        const reportInfo = () => ({ title: shownTitle, artists: artistNames(shownArtists) });
        report.addEventListener('click', async () => {
            report.disabled = true;
            await reportCensor(albumId, false, reportInfo(), 'album');
            renderReport();
        });

        const closeDialog = () => {
            if (cover.src.startsWith('blob:') && pickedCover) URL.revokeObjectURL(cover.src);
            overlay.remove();
            document.removeEventListener('keydown', onKey, true);
        };
        const onKey = (e) => { if (e.key === 'Escape') { e.stopPropagation(); closeDialog(); } };
        document.addEventListener('keydown', onKey, true);
        close.addEventListener('click', closeDialog);
        overlay.addEventListener('mousedown', (e) => { if (e.target === overlay) closeDialog(); });

        del.addEventListener('click', async () => {
            try {
                // вместе с подменой альбома уходят и свои треки, добавленные в него
                for (const [id, t] of Object.entries(localTracks)) {
                    if (t.custom && String(t.albumId) === String(albumId)) await removeLocalTrack(id);
                }
                await removeLocalAlbum(albumId);
                closeDialog();
                reopenAlbumPage(albumId);
                showToast('Подмена альбома удалена.');
            } catch (e) { showToast('Не удалось удалить подмену: ' + (e && e.message)); }
        });

        apply.addEventListener('click', async () => {
            apply.disabled = true;
            try {
                // берём прежнюю свою подмену и меняем то, что поменял пользователь
                const rec = Object.assign({}, saved || {}, { id: albumId });
                const title = input.value.trim();
                if (title && title !== shownTitle) rec.title = title;
                if (pickedCover) rec.cover = pickedCover;
                if (artistsChanged()) rec.artists = artists.map(slimArtist);
                const finalVolumes = volumes.filter((v) => v.length);
                const ids = finalVolumes.map((v) => v.map((r) => r.id));
                if (JSON.stringify(ids) !== shownVol) rec.volumes = ids;
                rec.replaceArtists = !swInput.disabled && swInput.checked;
                if (!rec.replaceArtists) delete rec.replaceArtists;
                const extra = readExtra();
                if (Object.keys(extra).length) rec.extra = extra; else delete rec.extra;
                const changed = ['title', 'cover', 'artists', 'volumes', 'replaceArtists', 'extra'].some((k) => k in rec);
                if (!changed) { closeDialog(); return; }

                // свои треки — до альбома: альбом ссылается на них
                const albumTitle = rec.title || shownTitle;
                const albumArtists = artists.map(slimArtist);
                const added = [];
                for (const r of finalVolumes.flat()) {
                    if (!r.isNew) continue;
                    const trackArtists = uniqArtists(albumArtists.concat(r.isNew.extra.map(slimArtist)));
                    await saveLocalTrack({
                        id: r.id, custom: true, title: r.isNew.title, artists: trackArtists,
                        file: r.isNew.file, fileName: r.isNew.file.name, codec: r.isNew.codec, durationMs: r.isNew.durationMs || 0,
                        albumId: String(albumId), albumTitle, albumArtists, albumCover: coverSrc,
                    });
                    added.push({ title: r.isNew.title, artists: artistNames(trackArtists) });
                }
                // свои треки, убранные из альбома, больше не нужны
                const kept = new Set(ids.flat());
                for (const id of shownCustom) if (!kept.has(id)) await removeLocalTrack(id);

                await saveLocalAlbum(rec);
                if (!saved) reportCensor(albumId, true, reportInfo(), 'album');
                if (added.length) logAddedTracks(albumId, albumTitle, artistNames(albumArtists), added);
                closeDialog();
                reopenAlbumPage(albumId);
                showToast('Подмена альбома сохранена.');
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

    // Своя очередь модерации F_ckCensor (Supabase, схема в supabase/schema.sql).
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

    function isReported(id, type) { return reportedSet().has((type || 'track') + '_' + id); }

    function markReported(id, type) {
        const set = reportedSet();
        set.add((type || 'track') + '_' + id);
        try { localStorage.setItem(REPORTED_STORAGE, JSON.stringify([...set])); } catch (_) {}
    }

    // replaced=true — пользователь сам подставил свой файл; тогда сообщение уходит молча, как в аддоне.
    // Сообщение уходит в очередь FckCensor и в свою, если она настроена; успех — если дошло хоть куда-то.
    async function reportCensor(id, replaced, info, type) {
        const kind = type || 'track';
        if (!isNum(String(id)) || isReported(id, kind)) return false;
        const body = { track_id: Number(id), type: kind, replaced: !!replaced };
        const jobs = [postReport(REPORT_URL, reportKey(), body)];
        if (OWN_REPORT_URL && OWN_REPORT_KEY) {
            jobs.push(postReport(OWN_REPORT_URL.replace(/[/]+$/, '') + '/rest/v1/reports', OWN_REPORT_KEY, Object.assign({}, body, {
                title: ((info && info.title) || '').slice(0, 300) || null,
                artists: ((info && info.artists) || '').slice(0, 300) || null,
                client_id: clientId(),
            })));
        }
        const results = await Promise.allSettled(jobs);
        results.forEach((r) => { if (r.status === 'rejected') console.error('[F_ckCensor] сообщение о цензуре:', r.reason && r.reason.message); });
        const ok = results.some((r) => r.status === 'fulfilled' && r.value);
        if (ok) markReported(id, kind);
        if (!replaced) {
            showToast(ok ? 'Спасибо! В скором времени этот ' + (kind === 'album' ? 'альбом' : 'трек') + ' будет добавлен в список автоматически подменяемых.'
                : 'Не удалось сообщить о цензуре.');
        }
        return ok;
    }

    // Как в аддоне: сообщать не о чем, если трек уже подменяется (из базы или своим файлом)
    function hasAnySpoof(id) {
        return !!(window.__fkCensorReplacements || {})[id] || !!getMeta().tracks[id] || !!localTracks[id];
    }

    window.__fkcLocal = {
        open: openSpoofDialog, openAlbum: openAlbumDialog, menus: injectTrackMenus,
        all: () => localTracks, albums: () => localAlbums, isReported,
        // для проверки руками из консоли
        saveTrack: saveLocalTrack, saveAlbum: saveLocalAlbum, newCustomId: allocCustomId, customDto: customTrackDto,
    };
    loadLocalTracks();
    loadLocalAlbums();

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
        console.log('[F_ckCensor] Заменяю трек', id, '->', url);
        const m = getMeta();
        const album = m.albums[m.trackAlbums[id]] || {};
        const cover = window.__fkcCovers[id] || (m.tracks[id] || {}).coverUri || album.coverUri || '';
        // название и исполнители — как их видит пользователь, с подменой: у своего трека
        // их больше негде взять, а у подменённого Яндекс отдал бы зацензуренные
        const dto = isCustomId(id) ? customTrackDto(id) : null;
        const spoof = Object.assign({}, m.tracks[id], localTracks[id] && localTracks[id].title ? { title: localTracks[id].title } : null);
        const title = (dto && dto.title) || spoof.title || '';
        const artists = (dto && dto.artists) || spoof.artists || [];
        const artist = artists.map((a) => a && a.name).filter(Boolean).join(', ');
        window.__fkcEvents.push({ trackId: id, url, cover, title, artist });
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
            // или запрос упал — собираем ответ сами. Свой трек сервер не знает — его не спрашиваем.
            let res = null;
            if (!isCustomId(trackId)) {
                try { res = await origSingle.call(this, params, ...rest); } catch(_) {}
            }
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

                // свои треки из пакетного запроса убираем: из-за неизвестного id сервер
                // мог бы не ответить и про остальные
                let res = null;
                const real = ids.filter((id) => !isCustomId(id));
                if (real.length) {
                    const p = Object.assign({}, params, {
                        trackIds: Array.isArray(raw) ? raw.filter((x) => !isCustomId(String(x))) : real.join(','),
                    });
                    try { res = await origBatch.call(this, p, ...rest); } catch(_) {}
                }
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
    console.log('[F_ckCensor] file-info hooked ✓ (модули ' + patched.join(', ') + ')');
    return true;
    }

    let attempts = 0;
    (function tryHook() {
        if (hookFileInfo()) return;
        if (++attempts < 150) setTimeout(tryHook, 200);
        else console.error('[F_ckCensor] ресурс file-info не найден');
    })();

    console.log('[F_ckCensor] Renderer inject OK, треков:', Object.keys(window.__fkCensorReplacements || {}).length);
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

        // Сообщения [F_ckCensor] из окна клиента дублируем в лог
        function forwardConsole(wc) {
            wc.on('console-message', (e, level, message) => {
                const msg = (e && typeof e.message === 'string') ? e.message : message;
                if (typeof msg === 'string' && msg.includes('[F_ckCensor]')) log('окно:', msg.replace('[F_ckCensor] ', ''));
            });
        }

        app.on('web-contents-created', (_, wc) => {
            forwardConsole(wc);
            wc.on('dom-ready', () => injectInto(wc));
            wc.on('did-finish-load', () => injectInto(wc));
            wc.on('did-navigate-in-page', () => injectInto(wc));
        });

        // Окна, открытые до установки перехвата: встраиваемся сейчас и после каждой перезагрузки —
        // иначе перезагрузка окна (Ctrl+R, переход с полной загрузкой) снимает подмену
        webContents.getAllWebContents().forEach((wc) => {
            if (wc.isDestroyed()) return;
            forwardConsole(wc);
            wc.on('dom-ready', () => injectInto(wc));
            wc.on('did-finish-load', () => injectInto(wc));
            if (!wc.isLoading()) injectInto(wc);
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
            if (!info) return reject(new Error('F_ckCensor не запущен'));
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

    // Лайки треков, которых нет в Яндекс Музыке: программа хранит их и присылает весь список,
    // когда он меняется; окнам он нужен для «Мне нравится». Неотправленные лайки ждут связи
    let appLikes = {};
    let appLikesRev = 0;
    const pendingLikeOps = [];

    // Лайки для окна: подтверждённые программой плюс отправленные, но ещё не подтверждённые.
    // Скрипт окна сверху доприменяет и свои, которые главный процесс ещё не забрал
    function effectiveLikes() {
        const out = JSON.parse(JSON.stringify(appLikes || {}));
        for (const op of pendingLikeOps) {
            const list = (out[op.uid] || []).filter((x) => String(x.id) !== String(op.id));
            if (op.op === 'add') list.unshift({ id: op.id, albumId: op.albumId, timestamp: op.timestamp });
            out[op.uid] = list;
        }
        return out;
    }
    function likesScript() {
        return 'window.__fkcLikes = ' + JSON.stringify(effectiveLikes()) + ';' +
            ' (window.__fkcLikeOps || []).forEach(function (op) {' +
            ' var l = (window.__fkcLikes[op.uid] || []).filter(function (x) { return String(x.id) !== String(op.id); });' +
            ' if (op.op === "add") l.unshift({ id: op.id, albumId: op.albumId, timestamp: op.timestamp });' +
            ' window.__fkcLikes[op.uid] = l; });';
    }

    function pushLikes() {
        const { webContents } = require('electron');
        const script = likesScript();
        webContents.getAllWebContents().forEach((wc) => {
            if (!wc.isDestroyed()) wc.executeJavaScript(script).catch(() => {});
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
                pendingLikeOps.push(...(r.likeOps || []));
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
            report.push({ type: ok ? 'replaced' : 'failed', trackId: e.trackId, cover: e.cover || '', title: e.title || '', artist: e.artist || '' });
        }

        // После ошибки периодически проверяем, не ожило ли хранилище
        if (!reachable && Date.now() - lastRecheck > RECHECK_MS) {
            lastRecheck = Date.now();
            const sample = Object.values(replacements)[0];
            if (sample && await checkUrl(sample.url)) reachable = true;
        }

        try {
            const likeOps = pendingLikeOps.slice();
            const res = await postToApp('/ym/sync', {
                likeOps,
                likesRev: appLikesRev,
                listLoadedAt,
                listLoadOk,
                ymVersion: app.getVersion(),
                listCount: Object.keys(replacements).length,
                reachable,
                nowPlaying,
                events: report,
            });
            if (!syncOk) log('связь с F_ckCensor есть, подмена', res.enabled ? 'включена' : 'на паузе');
            syncOk = true;
            enabledByApp = res.enabled === true;
            pendingLikeOps.splice(0, likeOps.length);
            if (res.likes && typeof res.likesRev === 'number') {
                appLikes = res.likes;
                appLikesRev = res.likesRev;
                pushLikes();
            }
            // в программе нажали «обновить список замен» — не ждём 10 минут
            if (res.reloadList && res.reloadList > listLoadedAt && !listLoading) {
                log('обновляю списки по просьбе F_ckCensor');
                reloadLists(true);
            }
        } catch(e) {
            if (syncOk !== false) log('нет связи с F_ckCensor:', e.message);
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

    // загрузить списки и отдать их открытым окнам клиента
    function reloadLists(fresh) {
        return loadList(fresh).then((updated) => {
            if (!updated) return;
            const { webContents } = require('electron');
            const script = buildDataScript();
            webContents.getAllWebContents().forEach((wc) => {
                if (!wc.isDestroyed()) {
                    wc.executeJavaScript(script).catch(() => {});
                }
            });
        });
    }

    function startSyncLoop() {
        setInterval(() => { reloadLists(false); }, SYNC_MS);
    }

    function init() {
        // первый обмен с программой — до встраивания в окно: так окно сразу получит лайки,
        // которые хранит программа, и «Мне нравится» при запуске будет полным
        loadList().then(() => appSyncOnce().catch(() => {})).then(() => {
            setupWebContentsHook();
            startSyncLoop();
            startAppSync();
        });
    }

    const { app } = require('electron');
    app.isReady() ? init() : app.whenReady().then(init);
})();
