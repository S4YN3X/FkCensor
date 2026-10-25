// Package app — ядро программы: состояние патча, настройки, события от
// Яндекс Музыки и действия, которые вызывают окно и трей.
package app

import (
	"fmt"
	"runtime"
	"strings"
	"sync"
	"time"

	"github.com/S4YN3X/FkCensor/internal/asarpatch"
	"github.com/S4YN3X/FkCensor/internal/ipc"
	"github.com/S4YN3X/FkCensor/internal/store"
	"github.com/S4YN3X/FkCensor/internal/winutil"
	"github.com/S4YN3X/FkCensor/internal/ym"
)

const (
	RepoURL = "https://github.com/S4YN3X/FkCensor"

	connectedTimeout = 6 * time.Second
	dedupeWindow     = 10 * time.Minute
	failNotifyEvery  = 10 * time.Minute
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
	update     UpdateInfo
	lastFail   time.Time

	// ShowWindow вызывается, когда вторая копия программы просит показать окно.
	OnShowWindow func()
}

func New(version, script string, st *store.Store) *App {
	a := &App{Version: version, script: script, store: st, listeners: map[int]func(){}, reachable: true}
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
		go a.checkUpdate(true)
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
	a.ymDir, a.patch, a.ymVersion = dir, patch, version
	a.mu.Unlock()
	if diff {
		a.changed()
	}
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
	case "notify":
		a.store.UpdateSettings(func(s *store.Settings) { s.Notify = b })
	case "restartYM":
		a.store.UpdateSettings(func(s *store.Settings) { s.RestartYM = b })
	case "autoUpdate":
		a.store.UpdateSettings(func(s *store.Settings) { s.AutoUpdate = b })
	case "hideToTray":
		a.store.UpdateSettings(func(s *store.Settings) { s.HideToTray = b })
	case "fallback":
		v, _ := value.(string)
		if v != store.FallbackSilent && v != store.FallbackNotify {
			return fmt.Errorf("неизвестное значение %q", v)
		}
		a.store.UpdateSettings(func(s *store.Settings) { s.Fallback = v })
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
	npChanged := !samePlaying(a.nowPlaying, req.NowPlaying)
	a.nowPlaying = req.NowPlaying
	a.mu.Unlock()

	for _, e := range req.Events {
		a.handleEvent(e)
	}
	if !wasConnected || npChanged || len(req.Events) > 0 {
		a.changed()
	}
	return ipc.SyncResponse{Enabled: a.store.Settings().Enabled}
}

func samePlaying(x, y *ipc.NowPlaying) bool {
	if x == nil || y == nil {
		return x == y
	}
	return *x == *y
}

func (a *App) handleEvent(e ipc.Event) {
	if e.TrackID == "" || a.store.RecentlyRecorded(e.TrackID, dedupeWindow) {
		return
	}
	failed := e.Type == "failed"
	entry := store.Entry{TrackID: e.TrackID, Title: "трек " + e.TrackID, Cover: coverURL(e.Cover), Time: time.Now(), Failed: failed}
	a.store.Record(entry)

	go func() {
		meta, err := fetchTrack(e.TrackID)
		if err == nil {
			if meta.Cover == "" {
				meta.Cover = entry.Cover // удалённый трек: обложка есть только у подмены в клиенте
			}
			a.store.UpdateEntry(entry.TrackID, entry.Time, func(x *store.Entry) {
				x.Title, x.Artist, x.Cover = meta.Title, meta.Artist, meta.Cover
			})
			entry.Title, entry.Artist = meta.Title, meta.Artist
			a.changed()
		}

		s := a.store.Settings()
		switch {
		case !failed && s.Notify:
			winutil.Notify("трек заменён", strings.TrimSuffix(entry.Title+" — "+entry.Artist, " — "))
		case failed && s.Fallback == store.FallbackNotify:
			a.mu.Lock()
			due := time.Since(a.lastFail) > failNotifyEvery
			if due {
				a.lastFail = time.Now()
			}
			a.mu.Unlock()
			if due {
				winutil.Notify("замена не загрузилась", "«"+entry.Title+"» играет в зацензуренной версии. Возможно, GitHub недоступен — попробуйте VPN.")
			}
		}
	}()
}

// --- снимок для интерфейса ---

type HistoryItem struct {
	Title  string `json:"title"`
	Artist string `json:"artist"`
	Cover  string `json:"cover"`
	Time   int64  `json:"time"`
	Failed bool   `json:"failed"`
}

type NowPlayingView struct {
	ipc.NowPlaying
	Replaced bool `json:"replaced"`
}

type State struct {
	Version    string          `json:"version"`
	GoVersion  string          `json:"goVersion"`
	Arch       string          `json:"arch"`
	RepoURL    string          `json:"repoUrl"`
	YMDir      string          `json:"ymDir"`
	YMVersion  string          `json:"ymVersion"`
	Patch      Patch           `json:"patch"`
	Connected  bool            `json:"connected"`
	Enabled    bool            `json:"enabled"`
	Busy       string          `json:"busy"`
	Error      string          `json:"error"`
	ListCount  int             `json:"listCount"`
	Reachable  bool            `json:"reachable"`
	NowPlaying *NowPlayingView `json:"nowPlaying"`
	Stats      store.Stats     `json:"stats"`
	History    []HistoryItem   `json:"history"`
	Settings   store.Settings  `json:"settings"`
	Update     UpdateInfo      `json:"update"`
}

func (a *App) Snapshot() State {
	hist := a.store.History()
	s := a.store.Settings()

	a.mu.Lock()
	st := State{
		Version:   a.Version,
		GoVersion: strings.TrimPrefix(runtime.Version(), "go"),
		Arch:      runtime.GOARCH,
		RepoURL:   RepoURL,
		YMDir:     a.ymDir,
		YMVersion: a.ymVersion,
		Patch:     a.patch,
		Connected: time.Since(a.lastSync) < connectedTimeout,
		Enabled:   s.Enabled,
		Busy:      a.busy,
		Error:     a.lastErr,
		ListCount: a.listCount,
		Reachable: a.reachable,
		Stats:     a.store.Stats(),
		Settings:  s,
		Update:    a.update,
	}
	if np := a.nowPlaying; np != nil && st.Connected {
		st.NowPlaying = &NowPlayingView{NowPlaying: *np, Replaced: playingReplaced(np, hist)}
	}
	a.mu.Unlock()

	st.History = make([]HistoryItem, len(hist))
	for i, e := range hist {
		st.History[i] = HistoryItem{Title: e.Title, Artist: e.Artist, Cover: e.Cover, Time: e.Time.UnixMilli(), Failed: e.Failed}
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
