// Package app — ядро программы: состояние патча, настройки, события от
// Яндекс Музыки и действия, которые вызывают окно и трей.
package app

import (
	"fmt"
	"runtime"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/S4YN3X/F_ckCensor/internal/asarpatch"
	"github.com/S4YN3X/F_ckCensor/internal/ipc"
	"github.com/S4YN3X/F_ckCensor/internal/store"
	"github.com/S4YN3X/F_ckCensor/internal/winutil"
	"github.com/S4YN3X/F_ckCensor/internal/ym"
)

const (
	RepoURL = "https://github.com/S4YN3X/F_ckCensor"

	connectedTimeout = 6 * time.Second
	dedupeWindow     = 10 * time.Minute
)

// Patch — состояние патча, как его видит интерфейс.
type Patch string

const (
	PatchNoYM     Patch = "noym"     // клиент не найден
	PatchNone     Patch = "none"     // не установлен
	PatchOutdated Patch = "outdated" // установлен старый скрипт
	PatchBroken   Patch = "broken"   // сумма asar не совпадает с exe, клиент не запустится
	PatchOK       Patch = "ok"
)

type App struct {
	Version string

	store  *store.Store
	likes  *store.Likes
	script string

	mu         sync.Mutex
	listeners  map[int]func()
	nextID     int
	busy       string
	lastErr    string
	ymDir      string
	ymVersion  string
	patch      Patch
	lastSync   time.Time
	listCount  int
	reachable  bool
	nowPlaying *ipc.NowPlaying
	// lastPlayed — последний трек, записанный в историю по «сейчас играет»
	lastPlayed string
	// listReload — когда попросили обновить списки замен (ноль — не просили или уже обновлены)
	listReload time.Time
	// listReloadErr — чем закончилось последнее обновление по просьбе: пусто — получилось
	listReloadErr string
	update        UpdateInfo
	// обновление при запуске: состояние для заставки и отмена скачивания
	startup       StartupUpdate
	startupTaken  bool
	startupCancel func()

	// OnRestart вызывается, когда новая версия поставлена на место exe: перезапустить программу.
	OnRestart func(exe string) error

	// OnPatchProblem вызывается, когда патч в Яндекс Музыке перестал работать: слетел
	// (клиент обновился), устарел или повреждён. Только при переходе из рабочего состояния.
	OnPatchProblem func()

	// ShowWindow вызывается, когда вторая копия программы просит показать окно.
	OnShowWindow func()
}

// New создаёт программу. launch — как она запущена: от этого зависит, где проверять
// обновление — на заставке окна, в фоне (автозапуск в трей) или не проверять (сразу после обновления).
func New(version, script string, st *store.Store, launch Launch) *App {
	a := &App{Version: version, script: script, store: st, likes: store.OpenLikes(), listeners: map[int]func(){}, reachable: true}
	if t := st.LastUpdateCheck(); !t.IsZero() {
		a.update.Checked = t.UnixMilli()
	}
	a.RefreshPatch()
	if st.Settings().Autostart {
		// путь к exe мог измениться — перезаписываем запись в реестре
		_ = winutil.SetAutostart(true)
	}
	go a.watchPatch()
	if st.Settings().AutoUpdate {
		switch launch {
		case LaunchWindow:
			a.startup.Phase = "pending" // проверит заставка
		case LaunchTray:
			go a.backgroundUpdate()
		}
	}
	return a
}

// Subscribe подписывает на любые изменения состояния. Возвращает отписку.
func (a *App) Subscribe(f func()) func() {
	a.mu.Lock()
	defer a.mu.Unlock()
	id := a.nextID
	a.nextID++
	a.listeners[id] = f
	return func() {
		a.mu.Lock()
		defer a.mu.Unlock()
		delete(a.listeners, id)
	}
}

func (a *App) changed() {
	a.mu.Lock()
	ls := make([]func(), 0, len(a.listeners))
	for _, f := range a.listeners {
		ls = append(ls, f)
	}
	a.mu.Unlock()
	for _, f := range ls {
		f()
	}
}

// RefreshPatch заново ищет клиент и проверяет патч.
func (a *App) RefreshPatch() {
	dir := a.store.Settings().YMDir
	if !ym.Valid(dir) {
		dir, _ = ym.FindDir()
	}
	patch, version := PatchNoYM, ""
	if dir != "" {
		switch st, err := asarpatch.Inspect(ym.ASARPath(dir), ym.ExePath(dir), a.script); {
		case err != nil:
			patch = PatchNone
		case st == asarpatch.Patched:
			patch = PatchOK
		case st == asarpatch.Outdated:
			patch = PatchOutdated
		case st == asarpatch.Broken:
			patch = PatchBroken
		default:
			patch = PatchNone
		}
		version = asarpatch.AppVersion(ym.ASARPath(dir))
	}

	a.mu.Lock()
	diff := a.ymDir != dir || a.patch != patch || a.ymVersion != version
	broke := a.patch == PatchOK && PatchProblem(patch)
	a.ymDir, a.patch, a.ymVersion = dir, patch, version
	cb := a.OnPatchProblem
	a.mu.Unlock()
	if diff {
		a.changed()
	}
	if broke && cb != nil {
		go cb()
	}
}

// PatchProblem — патч есть смысл (пере)установить: его нет, он устарел или повреждён.
// Нет самой Яндекс Музыки — не проблема патча.
func PatchProblem(p Patch) bool {
	return p == PatchNone || p == PatchOutdated || p == PatchBroken
}

// PatchState — текущее состояние патча.
func (a *App) PatchState() Patch {
	a.mu.Lock()
	defer a.mu.Unlock()
	return a.patch
}

// watchPatch замечает, что клиент обновился и патч слетел.
func (a *App) watchPatch() {
	for range time.Tick(time.Minute) {
		a.mu.Lock()
		busy := a.busy != ""
		a.mu.Unlock()
		if !busy {
			a.RefreshPatch()
		}
	}
}

func (a *App) Connected() bool {
	a.mu.Lock()
	defer a.mu.Unlock()
	return time.Since(a.lastSync) < connectedTimeout
}

// --- действия ---

// run выполняет долгое действие в фоне, показывая его в интерфейсе.
func (a *App) run(label string, f func() error) {
	a.mu.Lock()
	if a.busy != "" {
		a.mu.Unlock()
		return
	}
	a.busy, a.lastErr = label, ""
	a.mu.Unlock()
	a.changed()

	go func() {
		err := f()
		a.RefreshPatch()
		a.mu.Lock()
		a.busy = ""
		if err != nil {
			a.lastErr = err.Error()
		}
		a.mu.Unlock()
		a.changed()
	}()
}

// Toggle — главная кнопка: ставит патч, если его нет, иначе включает или ставит на паузу.
func (a *App) Toggle() {
	a.mu.Lock()
	patch := a.patch
	a.mu.Unlock()
	switch patch {
	case PatchNone, PatchOutdated, PatchBroken:
		a.InstallPatch()
	case PatchOK:
		a.store.UpdateSettings(func(s *store.Settings) { s.Enabled = !s.Enabled })
		a.changed()
	}
}

func (a *App) InstallPatch() {
	a.run("установка патча…", func() error {
		a.mu.Lock()
		dir := a.ymDir
		a.mu.Unlock()
		if dir == "" {
			return fmt.Errorf("яндекс музыка не найдена")
		}
		ym.Kill()
		// Patch сам справляется со старой версией скрипта и с повреждённой установкой,
		// а при ошибке возвращает asar как было — поэтому клиент запускаем в любом случае
		err := asarpatch.Patch(ym.ASARPath(dir), ym.ExePath(dir), a.script)
		if err == nil {
			a.store.UpdateSettings(func(s *store.Settings) { s.Enabled = true })
		}
		if a.store.Settings().RestartYM {
			if lerr := ym.Launch(dir); err == nil {
				err = lerr
			}
		}
		if err != nil {
			return fmt.Errorf("установка патча: %w", err)
		}
		return nil
	})
}

func (a *App) RemovePatch() {
	a.run("удаление патча…", func() error {
		a.mu.Lock()
		dir := a.ymDir
		a.mu.Unlock()
		if dir == "" {
			return fmt.Errorf("яндекс музыка не найдена")
		}
		ym.Kill()
		err := asarpatch.Unpatch(ym.ASARPath(dir), ym.ExePath(dir))
		if a.store.Settings().RestartYM {
			if lerr := ym.Launch(dir); err == nil {
				err = lerr
			}
		}
		if err != nil {
			return fmt.Errorf("удаление патча: %w", err)
		}
		return nil
	})
}

func (a *App) RestartYM() {
	a.run("перезапуск яндекс музыки…", func() error {
		a.mu.Lock()
		dir := a.ymDir
		a.mu.Unlock()
		if dir == "" {
			return fmt.Errorf("яндекс музыка не найдена")
		}
		ym.Kill()
		return ym.Launch(dir)
	})
}

// SetYMDir задаёт папку клиента вручную. Пустая строка — искать автоматически.
func (a *App) SetYMDir(dir string) error {
	if dir != "" && !ym.Valid(dir) {
		return fmt.Errorf("в папке нет яндекс музыки (%s)", dir)
	}
	a.store.UpdateSettings(func(s *store.Settings) { s.YMDir = dir })
	a.RefreshPatch()
	a.changed()
	return nil
}

// SetSetting меняет одну настройку по имени поля из JSON.
func (a *App) SetSetting(key string, value any) error {
	b, _ := value.(bool)
	switch key {
	case "autostart":
		if err := winutil.SetAutostart(b); err != nil {
			return fmt.Errorf("автозапуск: %w", err)
		}
		a.store.UpdateSettings(func(s *store.Settings) { s.Autostart = b })
	case "restartYM":
		a.store.UpdateSettings(func(s *store.Settings) { s.RestartYM = b })
	case "autoUpdate":
		a.store.UpdateSettings(func(s *store.Settings) { s.AutoUpdate = b })
	case "hideToTray":
		a.store.UpdateSettings(func(s *store.Settings) { s.HideToTray = b })
	case "animations":
		a.store.UpdateSettings(func(s *store.Settings) { s.Animations = b })
	case "theme":
		v, _ := value.(string)
		if v != "system" && v != "light" && v != "dark" {
			return fmt.Errorf("неизвестная тема %q", v)
		}
		a.store.UpdateSettings(func(s *store.Settings) { s.Theme = v })
	case "uiScale":
		v, _ := value.(float64) // числа из JSON приходят как float64
		pct := int(v)
		if pct != 100 && pct != 125 && pct != 150 && pct != 175 && pct != 200 {
			return fmt.Errorf("неизвестный масштаб %v", value)
		}
		a.store.UpdateSettings(func(s *store.Settings) { s.UIScale = pct })
	default:
		return fmt.Errorf("неизвестная настройка %q", key)
	}
	a.changed()
	return nil
}

func (a *App) ClearHistory() {
	a.store.ClearHistory()
	a.changed()
}

func (a *App) DismissError() {
	a.mu.Lock()
	a.lastErr = ""
	a.mu.Unlock()
	a.changed()
}

func (a *App) Settings() store.Settings { return a.store.Settings() }

// DarkWindow — тёмная ли тема окна: из настроек, «как в системе» — по теме приложений Windows.
func (a *App) DarkWindow() bool {
	switch a.store.Settings().Theme {
	case "dark":
		return true
	case "light":
		return false
	}
	return winutil.AppsDark()
}

// DarkIcons — нужны ли иконки для тёмной темы (белый квадрат) в трее и на панели задач.
// Тема берётся из настроек программы; «как в системе» — по цвету панели задач Windows.
func (a *App) DarkIcons() bool {
	switch a.store.Settings().Theme {
	case "dark":
		return true
	case "light":
		return false
	}
	return winutil.TaskbarDark()
}

// --- ipc.Handler ---

func (a *App) ShowWindow() {
	if a.OnShowWindow != nil {
		a.OnShowWindow()
	}
}

func (a *App) YMSync(req ipc.SyncRequest) ipc.SyncResponse {
	a.mu.Lock()
	wasConnected := time.Since(a.lastSync) < connectedTimeout
	a.lastSync = time.Now()
	if req.YMVersion != "" {
		a.ymVersion = req.YMVersion
	}
	a.listCount = req.ListCount
	a.reachable = req.Reachable
	// клиент загрузил списки после просьбы — обновление закончено
	reloaded := false
	if !a.listReload.IsZero() && req.ListLoadedAt >= a.listReload.UnixMilli() {
		a.listReload, reloaded = time.Time{}, true
		a.listReloadErr = ""
		if !req.ListLoadOk {
			a.listReloadErr = errListNotLoaded
		}
	} else if !a.listReload.IsZero() && time.Since(a.listReload) > listReloadTimeout {
		// клиент старый или не ответил — не держим кнопку, но и «обновлено» не говорим
		a.listReload, reloaded, a.listReloadErr = time.Time{}, true, errListNoAnswer
	}
	reloadAt := int64(0)
	if !a.listReload.IsZero() {
		reloadAt = a.listReload.UnixMilli()
	}
	npChanged := !samePlaying(a.nowPlaying, req.NowPlaying)
	a.nowPlaying = req.NowPlaying
	a.mu.Unlock()

	for _, e := range req.Events {
		a.handleEvent(e)
	}
	// События замены пришли выше, поэтому уже записанный трек второй раз не попадёт
	if np := req.NowPlaying; np != nil && np.Playing && np.TrackID != "" {
		a.mu.Lock()
		isNew := np.TrackID != a.lastPlayed
		a.lastPlayed = np.TrackID
		a.mu.Unlock()
		if isNew {
			a.recordPlay(*np)
		}
	}
	if !wasConnected || npChanged || len(req.Events) > 0 || reloaded {
		a.changed()
	}
	res := ipc.SyncResponse{Enabled: a.store.Settings().Enabled, ReloadList: reloadAt}
	// лайки треков, которых нет в Яндекс Музыке: сохраняем и отдаём клиенту, если у него старые
	if a.likes != nil {
		a.likes.Apply(req.LikeOps)
		all, rev := a.likes.All()
		res.LikesRev = rev
		if rev != req.LikesRev {
			if all == nil {
				all = map[string][]store.Like{}
			}
			res.Likes = all // и пустой: клиент должен узнать, что лайков не осталось
		}
	}
	return res
}

// reloadError — итог обновления для окна: если клиент так и не ответил (обмена нет),
// просьба висит дольше срока — это тоже ошибка
func reloadError(started time.Time, err string) string {
	if !started.IsZero() && time.Since(started) >= listReloadTimeout {
		return errListNoAnswer
	}
	return err
}

// listReloadTimeout — сколько ждать, пока клиент обновит списки по просьбе
const listReloadTimeout = 30 * time.Second

const (
	errListNotLoaded = "не удалось скачать список замен — проверьте интернет (если github заблокирован, включите vpn)"
	errListNoAnswer  = "яндекс музыка не ответила — обновите патч или перезапустите её"
)

// ReloadList просит Яндекс Музыку сразу загрузить свежие списки замен (обычно она делает это
// раз в 10 минут). Клиент узнает о просьбе при следующем обмене — через пару секунд.
func (a *App) ReloadList() error {
	a.mu.Lock()
	connected := time.Since(a.lastSync) < connectedTimeout
	if connected {
		a.listReload, a.listReloadErr = time.Now(), ""
	}
	a.mu.Unlock()
	if !connected {
		return fmt.Errorf("яндекс музыка не запущена — свежий список она загрузит сама при запуске")
	}
	a.changed()
	return nil
}

func samePlaying(x, y *ipc.NowPlaying) bool {
	if x == nil || y == nil {
		return x == y
	}
	return *x == *y
}

func (a *App) handleEvent(e ipc.Event) {
	if e.TrackID == "" || a.store.RecentlyRecorded(e.TrackID, dedupeWindow, false) {
		return
	}
	failed := e.Type == "failed"
	title := e.Title
	if title == "" {
		title = "трек " + e.TrackID
	}
	entry := store.Entry{TrackID: e.TrackID, Title: title, Artist: e.Artist, Cover: coverURL(e.Cover), Time: time.Now(), Failed: failed}
	a.store.Record(entry)
	// всё уже известно от клиента, а своего трека в Яндекс Музыке и нет
	if isCustomTrackID(e.TrackID) || (e.Title != "" && e.Artist != "" && entry.Cover != "") {
		return
	}

	go func() {
		meta, err := fetchTrack(e.TrackID)
		if err == nil {
			if meta.Cover == "" {
				meta.Cover = entry.Cover // удалённый трек: обложка есть только у подмены в клиенте
			}
			// название и исполнители из клиента — с подменой, их не перетираем
			if e.Title != "" {
				meta.Title = e.Title
			}
			if e.Artist != "" {
				meta.Artist = e.Artist
			}
			a.store.UpdateEntry(entry.TrackID, entry.Time, func(x *store.Entry) {
				x.Title, x.Artist, x.Cover = meta.Title, meta.Artist, meta.Cover
			})
			a.changed()
		}
	}()
}

// isCustomTrackID — свой трек (его нет в Яндекс Музыке): пользователя или из базы.
// Диапазон — как CUSTOM_BASE в assets/inject.js: 600000000000000 и два миллиона следом.
func isCustomTrackID(id string) bool {
	n, err := strconv.ParseInt(id, 10, 64)
	return err == nil && n >= 600000000000000 && n < 600000002000000
}

// recordPlay записывает в историю начавшийся трек: подменённый — как замену
// (повторное воспроизведение без нового запроса файла), остальные — «без замены».
func (a *App) recordPlay(np ipc.NowPlaying) {
	if np.Replaced {
		a.handleEvent(ipc.Event{Type: "replaced", TrackID: np.TrackID, Title: np.Title, Artist: np.Artist, Cover: np.Artwork})
		return
	}
	if a.store.RecentlyRecorded(np.TrackID, dedupeWindow, true) {
		return
	}
	a.store.Record(store.Entry{
		TrackID: np.TrackID, Title: np.Title, Artist: np.Artist, Cover: np.Artwork,
		Time: time.Now(), Original: true,
	})
}

// --- снимок для интерфейса ---

type HistoryItem struct {
	Title    string `json:"title"`
	Artist   string `json:"artist"`
	Cover    string `json:"cover"`
	Time     int64  `json:"time"`
	Failed   bool   `json:"failed"`
	Original bool   `json:"original"`
}

type NowPlayingView struct {
	ipc.NowPlaying
	Replaced bool `json:"replaced"`
}

type State struct {
	Version   string `json:"version"`
	GoVersion string `json:"goVersion"`
	Arch      string `json:"arch"`
	RepoURL   string `json:"repoUrl"`
	YMDir     string `json:"ymDir"`
	YMVersion string `json:"ymVersion"`
	Patch     Patch  `json:"patch"`
	Connected bool   `json:"connected"`
	Enabled   bool   `json:"enabled"`
	Busy      string `json:"busy"`
	Error     string `json:"error"`
	ListCount int    `json:"listCount"`
	// ListReloading — Яндекс Музыка загружает свежие списки по просьбе пользователя
	ListReloading bool `json:"listReloading"`
	// ListReloadError — почему последнее обновление списка не удалось (пусто — удалось)
	ListReloadError string          `json:"listReloadError"`
	Reachable       bool            `json:"reachable"`
	NowPlaying      *NowPlayingView `json:"nowPlaying"`
	Stats           store.Stats     `json:"stats"`
	History         []HistoryItem   `json:"history"`
	Settings        store.Settings  `json:"settings"`
	Update          UpdateInfo      `json:"update"`
	Startup         StartupUpdate   `json:"startup"`
}

func (a *App) Snapshot() State {
	hist := a.store.History()
	s := a.store.Settings()

	a.mu.Lock()
	st := State{
		Version:         a.Version,
		GoVersion:       strings.TrimPrefix(runtime.Version(), "go"),
		Arch:            runtime.GOARCH,
		RepoURL:         RepoURL,
		YMDir:           a.ymDir,
		YMVersion:       a.ymVersion,
		Patch:           a.patch,
		Connected:       time.Since(a.lastSync) < connectedTimeout,
		Enabled:         s.Enabled,
		Busy:            a.busy,
		Error:           a.lastErr,
		ListCount:       a.listCount,
		Reachable:       a.reachable,
		ListReloading:   !a.listReload.IsZero() && time.Since(a.listReload) < listReloadTimeout,
		ListReloadError: reloadError(a.listReload, a.listReloadErr),
		Stats:           a.store.Stats(),
		Settings:        s,
		Update:          a.update,
		Startup:         a.startup,
	}
	if np := a.nowPlaying; np != nil && st.Connected {
		st.NowPlaying = &NowPlayingView{NowPlaying: *np, Replaced: np.Replaced || playingReplaced(np, hist)}
	}
	a.mu.Unlock()

	st.History = make([]HistoryItem, len(hist))
	for i, e := range hist {
		st.History[i] = HistoryItem{Title: e.Title, Artist: e.Artist, Cover: e.Cover, Time: e.Time.UnixMilli(), Failed: e.Failed, Original: e.Original}
	}
	return st
}

// playingReplaced сопоставляет трек из «сейчас играет» с недавними заменами по названию:
// клиент сообщает о воспроизведении только название, без id трека.
func playingReplaced(np *ipc.NowPlaying, hist []store.Entry) bool {
	title := strings.ToLower(strings.TrimSpace(np.Title))
	if title == "" {
		return false
	}
	for _, e := range hist {
		if time.Since(e.Time) > time.Hour {
			break
		}
		t := strings.ToLower(e.Title)
		if !e.Failed && (t == title || strings.HasPrefix(t, title+" (")) {
			return true
		}
	}
	return false
}
