package main

import (
	"bufio"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"time"

	"github.com/S4YN3X/FkCensor/internal/cdp"
	"github.com/S4YN3X/FkCensor/internal/launcher"
	"github.com/S4YN3X/FkCensor/internal/replacer"
)

const (
	cdpPort    = 9222 // CDP remote debugging port для Яндекс Музыки
	scriptFile = "scripts/inject.js"
)

func main() {
	fmt.Println("=== FkCensor — трек-замена для Яндекс Музыки ===")
	fmt.Println()

	// ── 1. Запускаем локальный HTTP-сервер для раздачи файлов ────────────────────
	srv, err := replacer.New()
	if err != nil {
		fatalf("Failed to start replacer server: %v", err)
	}
	srv.Start()

	// ── 2. Загружаем inject.js и подставляем PORT ─────────────────────────────────
	script, err := loadScript(scriptFile, srv.Port())
	if err != nil {
		fatalf("Failed to load inject script: %v", err)
	}

	// ── 3. Запускаем ЯМ с --remote-debugging-port ────────────────────────────────
	fmt.Printf("[main] Launching Yandex Music with --remote-debugging-port=%d...\n", cdpPort)
	if err := launcher.LaunchWithDebugPort(cdpPort); err != nil {
		// ЯМ уже запущена? Пробуем подключиться к существующей
		fmt.Printf("[main] Could not launch YM (%v), trying to connect to existing instance...\n", err)
	}

	// ── 4. Подключаемся к CDP (ждём до 20 попыток) ───────────────────────────────
	tabs, err := cdp.WaitForTabs(cdpPort, 20, 2*time.Second)
	if err != nil {
		fatalf("Failed to connect to YM CDP: %v\n"+
			"Make sure Yandex Music is running with --remote-debugging-port=%d\n"+
			"On Windows, try launching manually:\n"+
			"  \"%%LOCALAPPDATA%%\\Programs\\YandexMusic\\Яндекс Музыка.exe\" --remote-debugging-port=%d",
			err, cdpPort, cdpPort)
	}

	tab := cdp.FindYMTab(tabs)
	if tab == nil {
		fatalf("Could not find Yandex Music page in CDP targets. Available: %v", tabs)
	}
	fmt.Printf("[main] Found YM tab: %s\n", tab.Title)

	client, err := cdp.Connect(tab.WebSocketDebuggerURL)
	if err != nil {
		fatalf("Failed to connect to CDP WebSocket: %v", err)
	}
	defer client.Close()

	// ── 5. Инжектируем скрипт ────────────────────────────────────────────────────
	fmt.Println("[main] Injecting script into Yandex Music...")
	if err := client.Evaluate(script); err != nil {
		fatalf("Failed to inject script: %v", err)
	}
	fmt.Println("[main] Script injected ✓")

	// ── 6. Интерактивный REPL для управления подменами ────────────────────────────
	fmt.Println()
	fmt.Println("Commands:")
	fmt.Println("  add <trackId> <path/to/file.mp3>  — добавить замену")
	fmt.Println("  remove <trackId>                   — убрать замену")
	fmt.Println("  list                               — список активных замен")
	fmt.Println("  reinject                           — повторно инжектировать скрипт")
	fmt.Println("  exit                               — выход")
	fmt.Println()

	scanner := bufio.NewScanner(os.Stdin)
	for {
		fmt.Print("> ")
		if !scanner.Scan() {
			break
		}
		line := strings.TrimSpace(scanner.Text())
		if line == "" {
			continue
		}
		parts := strings.Fields(line)
		cmd := parts[0]

		switch cmd {
		case "add":
			if len(parts) < 3 {
				fmt.Println("Usage: add <trackId> <filePath>")
				continue
			}
			trackID := parts[1]
			filePath := strings.Join(parts[2:], " ")
			absPath, err := filepath.Abs(filePath)
			if err != nil {
				fmt.Printf("Error resolving path: %v\n", err)
				continue
			}
			if err := srv.Add(trackID, absPath); err != nil {
				fmt.Printf("Error: %v\n", err)
				continue
			}
			fmt.Printf("✓ Track %s will be replaced with %s\n", trackID, absPath)

		case "remove":
			if len(parts) < 2 {
				fmt.Println("Usage: remove <trackId>")
				continue
			}
			srv.Remove(parts[1])
			fmt.Printf("✓ Removed replacement for track %s\n", parts[1])

		case "list":
			reps := srv.List()
			if len(reps) == 0 {
				fmt.Println("No active replacements")
				continue
			}
			for id, path := range reps {
				fmt.Printf("  %s → %s\n", id, path)
			}

		case "reinject":
			// Перечитываем скрипт и инжектируем заново (полезно после обновления ЯМ)
			newScript, err := loadScript(scriptFile, srv.Port())
			if err != nil {
				fmt.Printf("Error loading script: %v\n", err)
				continue
			}
			if err := client.Evaluate(newScript); err != nil {
				fmt.Printf("Error injecting: %v\n", err)
				continue
			}
			fmt.Println("✓ Script re-injected")

		case "exit", "quit":
			fmt.Println("Bye!")
			return

		default:
			fmt.Printf("Unknown command: %s\n", cmd)
		}
	}
}

// loadScript читает inject.js и заменяет плейсхолдер порта.
func loadScript(path string, port int) (string, error) {
	data, err := os.ReadFile(path)
	if err != nil {
		// Пробуем найти скрипт относительно исполняемого файла
		exe, _ := os.Executable()
		altPath := filepath.Join(filepath.Dir(exe), "scripts", "inject.js")
		data, err = os.ReadFile(altPath)
		if err != nil {
			return "", fmt.Errorf("cannot find inject.js at %s or %s", path, altPath)
		}
	}
	script := strings.ReplaceAll(string(data), "__GO_SERVER_PORT__", fmt.Sprintf("%d", port))
	return script, nil
}

func fatalf(format string, args ...interface{}) {
	fmt.Fprintf(os.Stderr, "[ERROR] "+format+"\n", args...)
	os.Exit(1)
}
