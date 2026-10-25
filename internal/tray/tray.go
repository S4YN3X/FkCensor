// Package tray — меню в системном трее.
package tray

import (
	"github.com/getlantern/systray"

	"github.com/S4YN3X/FkCensor/assets"
	"github.com/S4YN3X/FkCensor/internal/app"
)

// StatusTitle — короткая строка состояния, та же, что в окне.
func StatusTitle(s app.State) string {
	switch {
	case s.Busy != "":
		return s.Busy
	case s.Patch == app.PatchNoYM:
		return "яндекс музыка не найдена"
	case s.Patch == app.PatchNone:
		return "патч не установлен"
	case s.Patch == app.PatchOutdated:
		return "патч устарел"
	case s.Patch == app.PatchBroken:
		return "патч повреждён"
	case !s.Enabled:
		return "fkcensor на паузе"
	default:
		return "цензура отключена"
	}
}

func toggleTitle(s app.State) string {
	switch s.Patch {
	case app.PatchNone, app.PatchNoYM:
		return "установить патч"
	case app.PatchOutdated:
		return "обновить патч"
	case app.PatchBroken:
		return "восстановить патч"
	}
	if s.Enabled {
		return "поставить на паузу"
	}
	return "включить"
}

// Run строит меню и обрабатывает клики. Вызывается из systray.Run(onReady).
func Run(a *app.App, openWindow func()) {
	mStatus := systray.AddMenuItem("", "")
	mStatus.Disable()
	systray.AddSeparator()
	mToggle := systray.AddMenuItem("", "")
	mOpen := systray.AddMenuItem("открыть окно", "")
	mRestart := systray.AddMenuItem("перезапустить яндекс музыку", "")
	systray.AddSeparator()
	mQuit := systray.AddMenuItem("выход", "закрыть fkcensor")

	update := func() {
		s := a.Snapshot()
		status := StatusTitle(s)
		dot := "○ "
		if s.Patch == app.PatchOK && s.Enabled && s.Busy == "" {
			dot = "● "
			systray.SetIcon(assets.IconActive)
		} else {
			systray.SetIcon(assets.IconInactive)
		}
		mStatus.SetTitle(dot + status)
		systray.SetTooltip("FkCensor — " + status)

		mToggle.SetTitle(toggleTitle(s))
		if s.Busy != "" || s.Patch == app.PatchNoYM {
			mToggle.Disable()
		} else {
			mToggle.Enable()
		}
		if s.Busy != "" || s.Patch == app.PatchNoYM {
			mRestart.Disable()
		} else {
			mRestart.Enable()
		}
	}
	update()
	a.Subscribe(update)

	go func() {
		for {
			select {
			case <-mToggle.ClickedCh:
				a.Toggle()
			case <-mOpen.ClickedCh:
				openWindow()
			case <-mRestart.ClickedCh:
				a.RestartYM()
			case <-mQuit.ClickedCh:
				systray.Quit()
				return
			}
		}
	}()
}
