package main

import (
	"fmt"
	"net/http"
	"os"
	"os/exec"
	"runtime"
	"strings"
	"sync"
	"sync/atomic"
	"time"

	"github.com/S4YN3X/FkCensor/assets"
	"github.com/S4YN3X/FkCensor/internal/autostart"
	"github.com/S4YN3X/FkCensor/internal/cdp"
	"github.com/S4YN3X/FkCensor/internal/launcher"
	"github.com/S4YN3X/FkCensor/internal/replacer"
	"github.com/S4YN3X/FkCensor/internal/singleinstance"
	"github.com/getlantern/systray"
)

const (
	cdpPort        = 9222
	scriptFile     = "scripts/inject.js"
	defaultListURL = "https://raw.githubusercontent.com/Hazzz895/FckCensorData/refs/heads/main/list.json"
	syncInterval   = 10 * time.Minute
	version        = "v1.0.0"
)

var (
	srv          *replacer.Server
	enabled      atomic.Bool
	cdpClient    *cdp.Client
	cdpMu        sync.Mutex
	scriptBody   string
	replaceCount atomic.Int64
)

func updateStatus(mStatus *systray.MenuItem) {
	n := replaceCount.Load()
	if enabled.Load() {
		mStatus.SetTitle(fmt.Sprintf("Активен (заменено: %d)", n))
	} else {
		mStatus.SetTitle(fmt.Sprintf("Выключен (заменено: %d)", n))
	}
}

func main() {

	if autostart.IsEnabled() {
		autostart.Enable()
	}

	if !singleinstance.Acquire() {
		return
	}
	defer singleinstance.Release()

	var err error

	srv, err = replacer.New()
	if err != nil {
		logf("Failed to start server: %v", err)
		os.Exit(1)
	}
	srv.Start()

	scriptBody = strings.ReplaceAll(
		string(assets.InjectJS),
		"__GO_SERVER_PORT__",
		fmt.Sprintf("%d", srv.Port()),
	)
	if err != nil {
		logf("Failed to load script: %v", err)
		os.Exit(1)
	}

	n, err := srv.SyncRemote(defaultListURL)
	if err != nil {
		logf("Remote sync warning: %v", err)
	} else {
		logf("Loaded %d remote tracks", n)
	}
	srv.AutoSync(defaultListURL, syncInterval)

	enabled.Store(true)
	systray.Run(onReady, onExit)
}

func onReady() {
	systray.SetIcon(assets.IconActive)
	systray.SetTooltip("Fu*kCensor — активен")

	mStatus := systray.AddMenuItem("Активен", "Текущий статус")
	mStatus.Disable()

	srv.OnReplace(func() {
		replaceCount.Add(1)
		updateStatus(mStatus)
	})

	mVersion := systray.AddMenuItem("Fu*kCensor "+version, "")
	mVersion.Disable()

	mAuthor := systray.AddMenuItem("github.com/S4YN3X/FkCensor ", "")
	mAuthor.Disable()

	systray.AddSeparator()

	mToggle := systray.AddMenuItem("Выключить", "Включить / выключить замену треков")
	mOpenYM := systray.AddMenuItem("Открыть Яндекс Музыку", "")

	systray.AddSeparator()

	mReinject := systray.AddMenuItem("Реинжектировать скрипт", "Повторно вставить скрипт в ЯМ")

	systray.AddSeparator()

	mAutostart := systray.AddMenuItemCheckbox(
		"Автозапуск с Windows",
		"Запускать Fu*kCensor при входе в систему",
		autostart.IsEnabled(),
	)

	systray.AddSeparator()

	mQuit := systray.AddMenuItem("Выход", "Закрыть Fu*kCensor")

	go initialConnect()
	go watchAndRestartYM()

	go func() {
		for {
			select {

			case <-mToggle.ClickedCh:
				if enabled.Load() {
					enabled.Store(false)
					mToggle.SetTitle("Включить")
					mStatus.SetTitle("Выключен")
					systray.SetIcon(assets.IconInactive)
					systray.SetTooltip("Fu*kCensor — выключен")
				} else {
					enabled.Store(true)
					mToggle.SetTitle("Выключить")
					mStatus.SetTitle("Активен")
					systray.SetIcon(assets.IconActive)
					systray.SetTooltip("Fu*kCensor — активен")
					go injectScript()
				}
				updateStatus(mStatus)

			case <-mOpenYM.ClickedCh:
				go launcher.LaunchWithDebugPort(cdpPort)

			case <-mReinject.ClickedCh:
				go func() {
					mReinject.SetTitle("Инжектирование...")
					mReinject.Disable()

					cdpMu.Lock()
					hasClient := cdpClient != nil
					cdpMu.Unlock()

					if !hasClient {
						logf("No CDP client, reconnecting first...")
						reconnect()
					} else {
						injectScript()
					}

					mReinject.SetTitle("Реинжектировать скрипт")
					mReinject.Enable()
				}()

			case <-mAutostart.ClickedCh:
				if mAutostart.Checked() {
					mAutostart.Uncheck()
					autostart.Disable()
				} else {
					mAutostart.Check()
					autostart.Enable()
				}

			case <-mQuit.ClickedCh:
				systray.Quit()
			}
		}
	}()
}

func onExit() {
	cdpMu.Lock()
	if cdpClient != nil {
		cdpClient.Close()
	}
	cdpMu.Unlock()
}

func initialConnect() {
	logf("Launching Yandex Music...")
	_ = launcher.LaunchWithDebugPort(cdpPort)

	tabs, err := cdp.WaitForTabs(cdpPort, 20, 2*time.Second)
	if err != nil {
		logf("CDP not available: %v", err)
		return
	}
	tab := cdp.FindYMTab(tabs)
	if tab == nil {
		logf("YM tab not found")
		return
	}
	client, err := cdp.Connect(tab.WebSocketDebuggerURL)
	if err != nil {
		logf("CDP connect error: %v", err)
		return
	}
	cdpMu.Lock()
	cdpClient = client
	cdpMu.Unlock()
	logf("Connected: %s", tab.Title)
	injectScript()
}

func injectScript() {
	if !enabled.Load() {
		return
	}

	cdpMu.Lock()
	client := cdpClient
	cdpMu.Unlock()

	if client == nil {
		logf("Inject skipped: no CDP client")
		return
	}

	err := client.Evaluate(scriptBody)
	if err == nil {
		logf("Script injected")
		return
	}

	logf("Inject error (reconnecting): %v", err)
	client.Close()

	cdpMu.Lock()
	cdpClient = nil
	cdpMu.Unlock()

	go reconnect()
}

func reconnect() {
	if !isCDPAvailable(cdpPort) {
		if isYMRunning() {
			logf("Reconnect: YM running without CDP, restarting...")
		} else {
			logf("Reconnect: YM not running, launching...")
		}
		if err := launcher.LaunchWithDebugPort(cdpPort); err != nil {
			logf("Reconnect: launch error: %v", err)
			return
		}
	}

	tabs, err := cdp.WaitForTabs(cdpPort, 10, 2*time.Second)
	if err != nil {
		logf("Reconnect: CDP not available: %v", err)
		return
	}
	tab := cdp.FindYMTab(tabs)
	if tab == nil {
		logf("Reconnect: YM tab not found")
		return
	}
	client, err := cdp.Connect(tab.WebSocketDebuggerURL)
	if err != nil {
		logf("Reconnect: connect error: %v", err)
		return
	}
	cdpMu.Lock()
	if cdpClient != nil {
		cdpClient.Close()
	}
	cdpClient = client
	cdpMu.Unlock()
	logf("Reconnected ✓")
	injectScript()
}

func watchAndRestartYM() {
	for {
		time.Sleep(3 * time.Second)

		if !isYMRunning() {
			cdpMu.Lock()
			cdpClient = nil
			cdpMu.Unlock()
			continue
		}

		if isCDPAvailable(cdpPort) {
			continue
		}

		logf("[watcher] YM running without CDP, restarting...")
		_ = launcher.LaunchWithDebugPort(cdpPort)

		tabs, err := cdp.WaitForTabs(cdpPort, 15, 2*time.Second)
		if err != nil {
			continue
		}
		tab := cdp.FindYMTab(tabs)
		if tab == nil {
			continue
		}
		client, err := cdp.Connect(tab.WebSocketDebuggerURL)
		if err != nil {
			continue
		}
		cdpMu.Lock()
		if cdpClient != nil {
			cdpClient.Close()
		}
		cdpClient = client
		cdpMu.Unlock()
		injectScript()
		logf("[watcher] reconnected")
	}
}

func isYMRunning() bool {
	if runtime.GOOS == "windows" {
		cmd := exec.Command("tasklist", "/FI", "IMAGENAME eq Яндекс Музыка.exe", "/NH")
		hideWindow(cmd)
		out, _ := cmd.Output()
		return strings.Contains(string(out), "Яндекс Музыка.exe")
	}
	cmd := exec.Command("pgrep", "-f", "Яндекс Музыка")
	hideWindow(cmd)
	out, _ := cmd.Output()
	return len(strings.TrimSpace(string(out))) > 0
}

func killYM() {
	if runtime.GOOS == "windows" {
		cmd := exec.Command("taskkill", "/F", "/IM", "Яндекс Музыка.exe")
		hideWindow(cmd)
		cmd.Run()
	} else {
		cmd := exec.Command("pkill", "-f", "Яндекс Музыка")
		hideWindow(cmd)
		cmd.Run()
	}
}

func isCDPAvailable(port int) bool {
	resp, err := http.Get(fmt.Sprintf("http://localhost:%d/json", port))
	if err != nil {
		return false
	}
	resp.Body.Close()
	return resp.StatusCode == 200
}

func logf(format string, args ...interface{}) {
	fmt.Fprintf(os.Stderr, "[FkCensor] "+format+"\n", args...)
}
