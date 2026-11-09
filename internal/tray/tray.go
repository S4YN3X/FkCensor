// Package tray — меню в системном трее.
package tray

import (
	"github.com/getlantern/systray"

	"github.com/S4YN3X/F_ckCensor/assets"
	"github.com/S4YN3X/F_ckCensor/internal/app"
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
		return "на паузе"
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
	mQuit := systray.AddMenuItem("выход", "закрыть f_ckcensor")

	update := func() {
		s := a.Snapshot()
		status := StatusTitle(s)
		dot := "○ "
		active := s.Patch == app.PatchOK && s.Enabled && s.Busy == ""
		if active {
			dot = "● "
		}
		// иконка под тему программы; при смене темы в настройках меняется сразу
		systray.SetIcon(assets.Icon(a.DarkIcons(), active))
		mStatus.SetTitle(dot + status)
		systray.SetTooltip("F_ckCensor — " + status)

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
