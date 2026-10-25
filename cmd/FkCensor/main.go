package main

import (
	"fmt"
	"os"
	"slices"

	"github.com/getlantern/systray"

	"github.com/S4YN3X/FkCensor/assets"
	"github.com/S4YN3X/FkCensor/internal/app"
	"github.com/S4YN3X/FkCensor/internal/ipc"
	"github.com/S4YN3X/FkCensor/internal/singleinstance"
	"github.com/S4YN3X/FkCensor/internal/store"
	"github.com/S4YN3X/FkCensor/internal/tray"
	"github.com/S4YN3X/FkCensor/internal/ui"
	"github.com/S4YN3X/FkCensor/internal/winutil"
)

const version = "v2.0.0"

func main() {
	// --tray: запуск из автозагрузки, без окна
	startHidden := slices.Contains(os.Args[1:], "--tray")

	if !singleinstance.Acquire() {
		// Программа уже запущена — просим её показать окно
		if !startHidden {
			if err := ipc.AskShow(store.Dir()); err != nil {
				logf("не удалось связаться с запущенной копией: %v", err)
			}
		}
		return
	}
	defer singleinstance.Release()

	winutil.EnableDPIAwareness()
	winutil.RegisterNotifications(assets.IconActive)

	st := store.Open()
	a := app.New(version, string(assets.InjectJS), st)
	win := ui.New(a)
	a.OnShowWindow = win.Show
	win.OnClosed = func() {
		if !a.Settings().HideToTray {
			systray.Quit()
		}
	}

	stopIPC, err := ipc.Serve(store.Dir(), a)
	if err != nil {
		logf("ipc: %v", err)
	}

	systray.Run(func() {
		tray.Run(a, win.Show)
		if !startHidden {
			win.Show()
		}
	}, func() {
		win.Close()
		if stopIPC != nil {
			stopIPC()
		}
	})
}

func logf(format string, args ...interface{}) {
	fmt.Fprintf(os.Stderr, "[FkCensor] "+format+"\n", args...)
}
