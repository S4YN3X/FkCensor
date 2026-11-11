// Package ui — окно программы на WebView2. Вёрстка лежит в assets/ui/index.html.
package ui

import (
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"sync"
	"time"

	"github.com/jchv/go-webview2"

	"github.com/S4YN3X/F_ckCensor/assets"
	"github.com/S4YN3X/F_ckCensor/internal/app"
	"github.com/S4YN3X/F_ckCensor/internal/store"
	"github.com/S4YN3X/F_ckCensor/internal/winutil"
)

const (
	width, height       = 980, 640
	minWidth, minHeight = 760, 560
	// заставка при открытии: маленькое окно без рамки, потом оно становится обычным
	splashWidth, splashHeight = 280, 300
)

// Window — единственное окно программы. Создаётся при открытии и
// уничтожается при закрытии; программа при этом остаётся в трее.
type Window struct {
	app *app.App
	// OnClosed вызывается после закрытия окна пользователем.
	OnClosed func()

	mu       sync.Mutex
	wv       webview2.WebView
	hwnd     uintptr
	starting bool
	// splash — окно ещё в виде заставки и ждёт команды expand от страницы
	splash bool
	// minimized — окно открывается свёрнутым, только кнопкой на панели задач
	minimized bool
	// pendingSince — когда ушло ещё не обработанное обновление окна (ноль — ничего не в пути)
	pendingSince time.Time
}

func New(a *app.App) *Window { return &Window{app: a} }

// Show открывает окно или выводит уже открытое на передний план.
func (w *Window) Show() {
	w.mu.Lock()
	defer w.mu.Unlock()
	if w.wv != nil {
		wv, hwnd := w.wv, w.hwnd
		wv.Dispatch(func() { winutil.BringToFront(hwnd) })
		return
	}
	if !w.starting {
		w.starting, w.minimized = true, false
		go w.run()
	}
}

// ShowMinimized открывает окно свёрнутым — кнопкой на панели задач, не отвлекая от работы:
// так программа зовёт пользователя, когда с патчем что-то не так. Открытое окно не трогает.
func (w *Window) ShowMinimized() {
	w.mu.Lock()
	defer w.mu.Unlock()
	if w.wv != nil || w.starting {
		return
	}
	w.starting, w.minimized = true, true
	go w.run()
}

// reveal показывает окно, когда страница нарисована: обычно — на экране, при открытии
// свёрнутым — только кнопкой на панели задач.
func (w *Window) reveal(hwnd uintptr) {
	w.mu.Lock()
	min := w.minimized
	w.minimized = false
	w.mu.Unlock()
	if min {
		winutil.RevealMinimized(hwnd)
	} else {
		winutil.Reveal(hwnd)
	}
}

// IsOpen — открыто ли окно сейчас.
func (w *Window) IsOpen() bool {
	w.mu.Lock()
	defer w.mu.Unlock()
	return w.wv != nil || w.starting
}

// Close закрывает окно, если оно открыто.
func (w *Window) Close() {
	w.mu.Lock()
	wv := w.wv
	w.mu.Unlock()
	if wv != nil {
		wv.Dispatch(wv.Destroy)
	}
}

func (w *Window) run() {
	// Окно и его цикл сообщений должны жить в одном системном потоке
	runtime.LockOSThread()
	defer runtime.UnlockOSThread()

	// С анимациями окно открывается маленькой заставкой; без них — сразу обычным.
	// При запуске программы заставка нужна и без анимаций: на ней проверяется обновление
	w.mu.Lock()
	minimized := w.minimized
	w.mu.Unlock()
	update := false
	if !minimized {
		update = w.app.TakeStartupUpdate()
	}
	settings := w.app.Settings()
	// свёрнутому окну заставка ни к чему: его всё равно не видно
	splash := !minimized && (settings.Animations || update)
	// Пока страница не нарисована, окно скрыто, а потом его фон и фон WebView — цвета темы:
	// так окно не появляется прозрачным или белым на мгновение
	dark := w.app.DarkWindow()
	bg := windowBg(dark)
	_ = os.Setenv("WEBVIEW2_DEFAULT_BACKGROUND_COLOR", fmt.Sprintf("FF%06X", bg))
	unhook := winutil.PrepareNextWindow(splash, w.px(splashWidth), w.px(splashHeight), bg)
	wv := webview2.NewWithOptions(webview2.WebViewOptions{
		DataPath:  filepath.Join(store.Dir(), "webview"),
		AutoFocus: true,
		WindowOptions: webview2.WindowOptions{
			Title:  "F_ckCensor",
			Width:  uint(w.px(width)),
			Height: uint(w.px(height)),
			Center: true,
		},
	})
	unhook()
	if wv == nil {
		fmt.Fprintln(os.Stderr, "[ui] WebView2 недоступен")
		w.mu.Lock()
		w.starting = false
		w.mu.Unlock()
		return
	}
	hwnd := uintptr(wv.Window())
	winutil.SetWindowIcon(hwnd, assets.Icon(w.app.DarkIcons(), true))
	if splash {
		winutil.RoundCorners(hwnd, true)
	} else {
		w.setNormalSize(wv)
	}

	_ = wv.Bind("fkcState", func() app.State { return w.app.Snapshot() })
	// своя шапка окна: кнопки, перетаскивание, растягивание за верхний край
	_ = wv.Bind("fkcWindow", func(cmd string) bool {
		if cmd == "reveal" {
			w.reveal(hwnd)
			return false
		}
		return winutil.WindowCommand(hwnd, cmd)
	})
	_ = wv.Bind("fkcAction", func(name string, arg json.RawMessage) error { return w.action(name, arg) })
	// страница узнаёт масштаб и вид окна ещё до первой отрисовки
	init := fmt.Sprintf("window.fkcZoom = %g;", settings.Zoom())
	if splash {
		init += "window.fkcSplash = true;"
	}
	if update {
		init += "window.fkcUpdate = true;"
	}
	wv.Init(init)
	wv.SetHtml(assets.UIPage())
	// страница сама покажет окно, когда нарисуется; на случай сбоя — показать через 3 секунды
	time.AfterFunc(3*time.Second, func() {
		w.mu.Lock()
		same := w.wv == wv
		w.mu.Unlock()
		if same {
			wv.Dispatch(func() { w.reveal(hwnd) })
		}
	})

	w.mu.Lock()
	w.wv, w.hwnd, w.starting, w.splash = wv, hwnd, false, splash
	w.mu.Unlock()
	unsubscribe := w.app.Subscribe(w.schedulePush)

	wv.Run()

	unsubscribe()
	w.mu.Lock()
	w.wv, w.hwnd, w.pendingSince = nil, 0, time.Time{}
	w.mu.Unlock()
	if w.OnClosed != nil {
		w.OnClosed()
	}
}

// px переводит размер вёрстки в пиксели экрана: масштаб Windows и масштаб интерфейса из настроек.
func (w *Window) px(n int) int {
	return int(float64(winutil.Scale(n)) * w.app.Settings().Zoom())
}

func (w *Window) setNormalSize(wv webview2.WebView) {
	wv.SetSize(w.px(width), w.px(height), webview2.HintNone)
	w.setMinSize(wv)
}

func (w *Window) setMinSize(wv webview2.WebView) {
	wv.SetSize(w.px(minWidth), w.px(minHeight), webview2.HintMin)
}

// фон окна до отрисовки страницы — как фон страницы в теме (--bg)
func windowBg(dark bool) uint32 {
	if dark {
		return 0x121212
	}
	return 0xFFFFFF
}

// schedulePush отправляет состояние в окно, склеивая частые изменения в одно обновление.
func (w *Window) schedulePush() {
	w.mu.Lock()
	defer w.mu.Unlock()
	// Dispatch идёт через PostThreadMessage, а такие сообщения Windows теряет, пока окно
	// в модальном цикле (перетаскивание, сворачивание). Поэтому «в пути» не дольше 2 секунд.
	if w.wv == nil || (!w.pendingSince.IsZero() && time.Since(w.pendingSince) < 2*time.Second) {
		return
	}
	w.pendingSince = time.Now()
	wv := w.wv
	wv.Dispatch(func() {
		w.mu.Lock()
		w.pendingSince = time.Time{}
		w.mu.Unlock()
		raw, err := json.Marshal(w.app.Snapshot())
		if err == nil {
			wv.Eval("window.fkcPush && window.fkcPush(" + string(raw) + ")")
		}
	})
}

// action выполняет команду из интерфейса. Долгие действия уходят в фон внутри app,
// поэтому вызов не блокирует поток окна.
func (w *Window) action(name string, arg json.RawMessage) error {
	var v any
	if len(arg) > 0 {
		_ = json.Unmarshal(arg, &v)
	}
	switch name {
	case "toggle":
		w.app.Toggle()
	case "install":
		w.app.InstallPatch()
	case "remove":
		w.app.RemovePatch()
	case "restartYM":
		w.app.RestartYM()
	case "findYM":
		return w.app.SetYMDir("")
	case "browseYM":
		w.mu.Lock()
		owner := w.hwnd
		w.mu.Unlock()
		go func() {
			if dir := winutil.PickFolder(owner, "папка яндекс музыки (где лежит «Яндекс Музыка.exe»)"); dir != "" {
				if err := w.app.SetYMDir(dir); err != nil {
					w.toast(err.Error())
				}
			}
		}()
	case "setting":
		m, _ := v.(map[string]any)
		key, _ := m["key"].(string)
		before := w.app.Settings().Zoom()
		if err := w.app.SetSetting(key, m["value"]); err != nil {
			return err
		}
		if after := w.app.Settings().Zoom(); key == "uiScale" && after != before {
			// масштаб интерфейса сменился — окно растёт или уменьшается вместе с ним
			w.mu.Lock()
			wv, hwnd, splash := w.wv, w.hwnd, w.splash
			w.mu.Unlock()
			if wv != nil && !splash {
				w.setMinSize(wv)
				winutil.ScaleWindow(hwnd, after/before)
			}
		}
	case "reloadList":
		return w.app.ReloadList()
	case "clearHistory":
		w.app.ClearHistory()
	case "checkUpdate":
		w.app.CheckUpdate()
	case "dismissError":
		w.app.DismissError()
	case "startupUpdate":
		w.app.RunStartupUpdate()
	case "skipUpdate":
		w.app.SkipStartupUpdate()
	case "expand":
		// заставка отыграла: окно становится обычным
		w.mu.Lock()
		wv, hwnd, was := w.wv, w.hwnd, w.splash
		w.splash = false
		w.mu.Unlock()
		if was && wv != nil {
			winutil.ExpandSplash(hwnd, w.px(width), w.px(height))
			w.setNormalSize(wv)
		}
	case "titlebar":
		dark, _ := v.(bool)
		w.mu.Lock()
		hwnd := w.hwnd
		w.mu.Unlock()
		if hwnd != 0 {
			winutil.SetDarkTitleBar(hwnd, dark)
			winutil.SetBackground(hwnd, windowBg(dark))
			// тема окна сменилась — иконка на панели задач тоже
			winutil.SetWindowIcon(hwnd, assets.Icon(w.app.DarkIcons(), true))
		}
	case "open":
		// открываем только ссылки на репозиторий программы
		if url, ok := v.(string); ok && (url == app.RepoURL || strings.HasPrefix(url, app.RepoURL+"/")) {
			winutil.OpenURL(url)
		}
	default:
		return fmt.Errorf("неизвестное действие %q", name)
	}
	return nil
}

// toast показывает сообщение внутри окна.
func (w *Window) toast(msg string) {
	w.mu.Lock()
	wv := w.wv
	w.mu.Unlock()
	if wv == nil {
		return
	}
	raw, _ := json.Marshal(msg)
	wv.Dispatch(func() { wv.Eval("window.fkcToast && window.fkcToast(" + string(raw) + ")") })
}
