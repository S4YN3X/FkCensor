package autostart

import (
	"os"

	"golang.org/x/sys/windows/registry"
)

const (
	regKey  = `SOFTWARE\Microsoft\Windows\CurrentVersion\Run`
	appName = "FkCensor"
)

func IsEnabled() bool {
	k, err := registry.OpenKey(registry.CURRENT_USER, regKey, registry.QUERY_VALUE)
	if err != nil {
		return false
	}
	defer k.Close()
	_, _, err = k.GetStringValue(appName)
	return err == nil
}

// Enable всегда пишет текущий путь exe — безопасно вызывать при каждом запуске
func Enable() error {
	exe, err := os.Executable()
	if err != nil {
		return err
	}
	k, err := registry.OpenKey(registry.CURRENT_USER, regKey, registry.SET_VALUE)
	if err != nil {
		return err
	}
	defer k.Close()
	return k.SetStringValue(appName, exe)
}

func Disable() error {
	k, err := registry.OpenKey(registry.CURRENT_USER, regKey, registry.SET_VALUE)
	if err != nil {
		return err
	}
	defer k.Close()
	return k.DeleteValue(appName)
}
