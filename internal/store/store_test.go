package store

import (
	"os"
	"path/filepath"
	"testing"
)

func TestMigrateLegacy(t *testing.T) {
	t.Setenv("LOCALAPPDATA", t.TempDir())
	old := LegacyDir()
	_ = os.MkdirAll(filepath.Join(old, "webview"), 0755)
	_ = os.WriteFile(filepath.Join(old, "state.json"), []byte(`{"settings":{"theme":"dark"}}`), 0644)

	MigrateLegacy()
	if _, err := os.Stat(old); !os.IsNotExist(err) {
		t.Fatal("старая папка должна переехать целиком")
	}
	if got := Open().Settings().Theme; got != "dark" {
		t.Fatalf("настройки не переехали: тема %q", got)
	}
	if _, err := os.Stat(filepath.Join(Dir(), "webview")); err != nil {
		t.Fatal("кэш окна не переехал")
	}

	// новая папка уже есть — повторный переезд ничего не трогает
	_ = os.MkdirAll(old, 0755)
	_ = os.WriteFile(filepath.Join(old, "state.json"), []byte(`{"settings":{"theme":"light"}}`), 0644)
	MigrateLegacy()
	if got := Open().Settings().Theme; got != "dark" {
		t.Fatal("переезд не должен затирать уже новую папку")
	}
	// в старой папке ещё есть настройки — не удаляем
	RemoveLegacy()
	if _, err := os.Stat(old); err != nil {
		t.Fatal("папку с настройками удалять нельзя")
	}
	_ = os.Remove(filepath.Join(old, "state.json"))
	_ = os.WriteFile(filepath.Join(old, "ipc.json"), []byte("{}"), 0600)
	RemoveLegacy()
	if _, err := os.Stat(old); !os.IsNotExist(err) {
		t.Fatal("папку только с ipc.json и журналом нужно убирать")
	}
}
