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

	"github.com/jchv/go-webview2"

	"github.com/S4YN3X/FkCensor/assets"
	"github.com/S4YN3X/FkCensor/internal/app"
	"github.com/S4YN3X/FkCensor/internal/store"
	"github.com/S4YN3X/FkCensor/internal/winutil"
)

const (
	width, height       = 980, 640
	minWidth, minHeight = 760, 560
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
	pending  bool
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
		w.starting = true
		go w.run()
	}
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

	wv := webview2.NewWithOptions(webview2.WebViewOptions{
		DataPath:  filepath.Join(store.Dir(), "webview"),
		AutoFocus: true,
		WindowOptions: webview2.WindowOptions{
			Title:  "FkCensor",
			Width:  uint(winutil.Scale(width)),
			Height: uint(winutil.Scale(height)),
			Center: true,
		},
	})
	if wv == nil {
		fmt.Fprintln(os.Stderr, "[ui] WebView2 недоступен")
		w.mu.Lock()
		w.starting = false
		w.mu.Unlock()
		return
	}
	hwnd := uintptr(wv.Window())
	winutil.SetWindowIcon(hwnd, assets.IconActive)
	wv.SetSize(winutil.Scale(width), winutil.Scale(height), webview2.HintNone)
	wv.SetSize(winutil.Scale(minWidth), winutil.Scale(minHeight), webview2.HintMin)

	_ = wv.Bind("fkcState", func() app.State { return w.app.Snapshot() })
	_ = wv.Bind("fkcAction", func(name string, arg json.RawMessage) error { return w.action(name, arg) })
	wv.SetHtml(string(assets.UIHTML))

	w.mu.Lock()
	w.wv, w.hwnd, w.starting = wv, hwnd, false
	w.mu.Unlock()
	unsubscribe := w.app.Subscribe(w.schedulePush)

	wv.Run()

	unsubscribe()
	w.mu.Lock()
	w.wv, w.hwnd, w.pending = nil, 0, false
	w.mu.Unlock()
	if w.OnClosed != nil {
		w.OnClosed()
	}
}

// schedulePush отправляет состояние в окно, склеивая частые изменения в одно обновление.
func (w *Window) schedulePush() {
	w.mu.Lock()
	defer w.mu.Unlock()
	if w.wv == nil || w.pending {
		return
	}
	w.pending = true
	wv := w.wv
	wv.Dispatch(func() {
		w.mu.Lock()
		w.pending = false
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
		return w.app.SetSetting(key, m["value"])
	case "clearHistory":
		w.app.ClearHistory()
	case "checkUpdate":
		w.app.CheckUpdate()
	case "dismissError":
		w.app.DismissError()
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
