package main

import (
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"slices"
	"time"

	"github.com/getlantern/systray"

	"github.com/S4YN3X/F_ckCensor/assets"
	"github.com/S4YN3X/F_ckCensor/internal/app"
	"github.com/S4YN3X/F_ckCensor/internal/ipc"
	"github.com/S4YN3X/F_ckCensor/internal/singleinstance"
	"github.com/S4YN3X/F_ckCensor/internal/store"
	"github.com/S4YN3X/F_ckCensor/internal/tray"
	"github.com/S4YN3X/F_ckCensor/internal/ui"
	"github.com/S4YN3X/F_ckCensor/internal/winutil"
)

// version — переменная, чтобы тестовую сборку можно было пометить другой версией через -ldflags -X
var version = "v2.3.1"

func main() {
	// --tray: запуск из автозагрузки, без окна
	startHidden := slices.Contains(os.Args[1:], "--tray")
	// --updated: запуск новой версии сразу после обновления — старая копия ещё закрывается
	updated := slices.Contains(os.Args[1:], "--updated")

	acquired := singleinstance.Acquire()
	for i := 0; !acquired && updated && i < 50; i++ {
		time.Sleep(200 * time.Millisecond)
		acquired = singleinstance.Acquire()
	}
	if !acquired {
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
	// переезд из папки старого названия (FkCensor) — до того, как что-то прочитает настройки
	store.MigrateLegacy()
	st := store.Open()
	// Обновление при запуске — на заставке первого окна. После обновления не проверяем ещё раз:
	// если в релизе окажется exe со старым номером версии, программа не будет обновляться по кругу
	launch := app.LaunchWindow
	switch {
	case updated:
		launch = app.LaunchUpdated
	case startHidden:
		launch = app.LaunchTray
	}
	a := app.New(version, string(assets.InjectJS), st, launch)
	if updated {
		app.CleanupOldExe()
	}
	winutil.RegisterNotifications(assets.Icon(a.DarkIcons(), true))
	win := ui.New(a)
	a.OnShowWindow = win.Show
	a.OnRestart = func(exe string) error {
		// сначала отпускаем «единственную копию», чтобы новая версия могла стартовать сразу
		singleinstance.Release()
		// окно не открыто (автозапуск, фоновое обновление) — новая версия тоже стартует в трей
		args := []string{"--updated"}
		if !win.IsOpen() {
			args = append(args, "--tray")
		}
		cmd := exec.Command(exe, args...)
		cmd.Dir = filepath.Dir(exe)
		if err := cmd.Start(); err != nil {
			logf("не удалось запустить новую версию: %v", err)
			singleinstance.Acquire()
			return err
		}
		systray.Quit()
		return nil
	}
	win.OnClosed = func() {
		if !a.Settings().HideToTray {
			systray.Quit()
		}
	}

	// Патч прежней версии (под старым названием) ищет ipc.json в старой папке — пока патч не
	// обновлён, кладём копию туда. Патч уже новый — старая папка больше не нужна
	var mirrors []string
	if a.PatchState() == app.PatchOK {
		store.RemoveLegacy()
	} else {
		mirrors = append(mirrors, store.LegacyDir())
	}
	stopIPC, err := ipc.Serve(store.Dir(), a, mirrors...)
	if err != nil {
		logf("ipc: %v", err)
	}

	// Патч перестал работать, пока программа в трее (например, Яндекс Музыка обновилась),
	// — окно открывается свёрнутым, кнопкой на панели задач, с кнопкой «обновить»
	a.OnPatchProblem = win.ShowMinimized

	systray.Run(func() {
		tray.Run(a, win.Show)
		switch {
		case !startHidden:
			win.Show()
		case app.PatchProblem(a.PatchState()):
			// автозапуск, но патч слетел или устарел — зовём, не мешая
			win.ShowMinimized()
		}
	}, func() {
		win.Close()
		if stopIPC != nil {
			stopIPC()
		}
	})
}

func logf(format string, args ...interface{}) {
	fmt.Fprintf(os.Stderr, "[F_ckCensor] "+format+"\n", args...)
}
