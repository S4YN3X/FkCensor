// Package ym находит, запускает и закрывает десктопную Яндекс Музыку (Windows).
package ym

import (
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"syscall"
	"time"
	"unsafe"

	"golang.org/x/sys/windows"
)

const exeName = "Яндекс Музыка.exe"

// ExePath — исполняемый файл клиента в папке установки.
func ExePath(dir string) string { return filepath.Join(dir, exeName) }

// ASARPath — архив интерфейса клиента в папке установки.
func ASARPath(dir string) string { return filepath.Join(dir, "resources", "app.asar") }

// Valid проверяет, что в папке лежит клиент.
func Valid(dir string) bool {
	if dir == "" {
		return false
	}
	if _, err := os.Stat(ExePath(dir)); err != nil {
		return false
	}
	_, err := os.Stat(ASARPath(dir))
	return err == nil
}

// FindDir ищет папку установки в стандартных местах.
func FindDir() (string, error) {
	programs := filepath.Join(os.Getenv("LOCALAPPDATA"), "Programs")
	for _, name := range []string{"YandexMusic", "Яндекс Музыка", "Yandex Music"} {
		if dir := filepath.Join(programs, name); Valid(dir) {
			return dir, nil
		}
	}
	entries, _ := os.ReadDir(programs)
	for _, e := range entries {
		n := strings.ToLower(e.Name())
		if e.IsDir() && (strings.Contains(n, "yandex") || strings.Contains(n, "яндекс")) {
			if dir := filepath.Join(programs, e.Name()); Valid(dir) {
				return dir, nil
			}
		}
	}
	return "", fmt.Errorf("яндекс музыка не найдена в %s", programs)
}

// IsRunning проверяет, запущен ли клиент.
func IsRunning() bool {
	snap, err := windows.CreateToolhelp32Snapshot(windows.TH32CS_SNAPPROCESS, 0)
	if err != nil {
		return false
	}
	defer windows.CloseHandle(snap)

	var pe windows.ProcessEntry32
	pe.Size = uint32(unsafe.Sizeof(pe))
	for err = windows.Process32First(snap, &pe); err == nil; err = windows.Process32Next(snap, &pe) {
		if strings.EqualFold(windows.UTF16ToString(pe.ExeFile[:]), exeName) {
			return true
		}
	}
	return false
}

// Kill закрывает все процессы клиента и ждёт, пока они завершатся.
func Kill() {
	cmd := exec.Command("taskkill", "/F", "/IM", exeName)
	cmd.SysProcAttr = &syscall.SysProcAttr{HideWindow: true, CreationFlags: windows.CREATE_NO_WINDOW}
	_ = cmd.Run()
	for i := 0; i < 20 && IsRunning(); i++ {
		time.Sleep(250 * time.Millisecond)
	}
	// Electron отпускает файлы чуть позже завершения процессов
	time.Sleep(500 * time.Millisecond)
}

// Launch запускает клиент отдельным процессом.
func Launch(dir string) error {
	cmd := exec.Command(ExePath(dir))
	cmd.Dir = dir
	// Если программу запустили из терминала VS Code или другого Electron-приложения,
	// эта переменная превращает клиент в голый Node.js, и он молча завершается.
	for _, kv := range os.Environ() {
		if !strings.HasPrefix(strings.ToUpper(kv), "ELECTRON_RUN_AS_NODE=") {
			cmd.Env = append(cmd.Env, kv)
		}
	}
	if err := cmd.Start(); err != nil {
		return fmt.Errorf("запуск яндекс музыки: %w", err)
	}
	return cmd.Process.Release()
}
