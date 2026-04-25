package launcher

import (
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"time"
)

// YMExePath возвращает путь к исполняемому файлу Яндекс Музыки в зависимости от ОС.
// Пути взяты из PulseSync-client/src/main/utils/appUtils/index.ts
func YMExePath() (string, error) {
	switch runtime.GOOS {
	case "windows":
		localAppData := os.Getenv("LOCALAPPDATA")
		if localAppData == "" {
			return "", fmt.Errorf("LOCALAPPDATA environment variable not set")
		}
		return filepath.Join(localAppData, "Programs", "YandexMusic", "Яндекс Музыка.exe"), nil
	case "darwin":
		return "/Applications/Яндекс Музыка.app/Contents/MacOS/Яндекс Музыка", nil
	case "linux":
		// Стандартный путь из PulseSync; может отличаться при нестандартной установке
		return "/opt/Яндекс Музыка/yandex-music", nil
	default:
		return "", fmt.Errorf("unsupported OS: %s", runtime.GOOS)
	}
}

// LaunchWithDebugPort запускает Яндекс Музыку с указанным remote-debugging-port.
// Если YM уже запущена — возвращает ошибку (нужно сначала закрыть).
func LaunchWithDebugPort(port int) error {
	exePath, err := YMExePath()
	if err != nil {
		return fmt.Errorf("getting YM path: %w", err)
	}

	if _, err := os.Stat(exePath); os.IsNotExist(err) {
		return fmt.Errorf("Yandex Music not found at %s", exePath)
	}

	debugFlag := fmt.Sprintf("--remote-debugging-port=%d", port)

	var cmd *exec.Cmd
	switch runtime.GOOS {
	case "windows":
		cmd = exec.Command(exePath, debugFlag)
	case "darwin":
		cmd = exec.Command(exePath, debugFlag)
	case "linux":
		cmd = exec.Command(exePath, debugFlag)
	}

	cmd.Stdout = nil
	cmd.Stderr = nil

	if err := cmd.Start(); err != nil {
		return fmt.Errorf("failed to start Yandex Music: %w", err)
	}

	// Отсоединяем от нашего процесса — YM живёт самостоятельно
	if err := cmd.Process.Release(); err != nil {
		return fmt.Errorf("failed to release process: %w", err)
	}

	fmt.Printf("[launcher] Yandex Music started (PID detached), debug port: %d\n", port)

	// Даём время на запуск перед первым CDP-подключением
	time.Sleep(3 * time.Second)
	return nil
}
