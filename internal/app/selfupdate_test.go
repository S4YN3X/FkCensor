package app

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"testing"
	"time"

	"github.com/S4YN3X/F_ckCensor/internal/store"
)

// fakeGitHub — свой «GitHub»: релиз tag с FkCensor.exe = body; stall — отдавать файл бесконечно долго.
func fakeGitHub(t *testing.T, tag string, body []byte, digest string, stall bool) *httptest.Server {
	t.Helper()
	var srv *httptest.Server
	srv = httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch r.URL.Path {
		case "/release":
			_ = json.NewEncoder(w).Encode(map[string]any{
				"tag_name": tag, "html_url": "https://example.invalid",
				"assets": []map[string]any{{"name": "FkCensor.exe", "size": len(body), "digest": digest, "browser_download_url": srv.URL + "/exe"}},
			})
		case "/exe":
			if stall {
				w.Header().Set("Content-Length", "1000000")
				w.Write([]byte("x"))
				w.(http.Flusher).Flush()
				<-r.Context().Done()
				return
			}
			w.Write(body)
		}
	}))
	t.Cleanup(srv.Close)
	return srv
}

func sha(b []byte) string { h := sha256.Sum256(b); return "sha256:" + hex.EncodeToString(h[:]) }

// testApp — программа версии v2.0.0 с «exe» во временной папке и обновлением при запуске.
func testApp(t *testing.T, url string) (*App, string, chan string) {
	t.Helper()
	t.Setenv("LOCALAPPDATA", t.TempDir())
	exe := filepath.Join(t.TempDir(), "FkCensor.exe")
	if err := os.WriteFile(exe, []byte("old"), 0644); err != nil {
		t.Fatal(err)
	}
	oldURL, oldExe := releaseURL, executable
	releaseURL, executable = url, func() (string, error) { return exe, nil }
	t.Cleanup(func() { releaseURL, executable = oldURL, oldExe })

	a := &App{Version: "v2.0.0", store: store.Open(), listeners: map[int]func(){}, reachable: true}
	a.startup.Phase = "pending"
	restarted := make(chan string, 1)
	a.OnRestart = func(path string) error { restarted <- path; return nil }
	return a, exe, restarted
}

func waitPhase(t *testing.T, a *App, want string, timeout time.Duration) StartupUpdate {
	t.Helper()
	deadline := time.Now().Add(timeout)
	for time.Now().Before(deadline) {
		if s := a.Snapshot().Startup; s.Phase == want {
			return s
		}
		time.Sleep(20 * time.Millisecond)
	}
	t.Fatalf("ждали фазу %q, сейчас %+v", want, a.Snapshot().Startup)
	return StartupUpdate{}
}

func TestStartupUpdateInstallsAndRestarts(t *testing.T) {
	body := []byte("new version")
	srv := fakeGitHub(t, "v2.1.5", body, sha(body), false)
	a, exe, restarted := testApp(t, srv.URL+"/release")

	if !a.TakeStartupUpdate() || a.TakeStartupUpdate() {
		t.Fatal("обновление при запуске должно достаться только первому окну")
	}
	a.RunStartupUpdate()
	select {
	case p := <-restarted:
		if p != exe {
			t.Fatalf("перезапуск не того файла: %s", p)
		}
	case <-time.After(5 * time.Second):
		t.Fatalf("не дождались перезапуска: %+v", a.Snapshot().Startup)
	}
	if got, _ := os.ReadFile(exe); string(got) != "new version" {
		t.Fatalf("на месте exe: %q", got)
	}
	if got, _ := os.ReadFile(exe + "~"); string(got) != "old" {
		t.Fatalf("старая версия не сохранилась рядом: %q", got)
	}
	if s := a.Snapshot().Startup; s.Phase != "restarting" || s.Version != "v2.1.5" {
		t.Fatalf("состояние: %+v", s)
	}
}

func TestStartupUpdateRejectsBadChecksum(t *testing.T) {
	body := []byte("new version")
	srv := fakeGitHub(t, "v2.1.5", body, sha([]byte("другой файл")), false)
	a, exe, restarted := testApp(t, srv.URL+"/release")
	a.RunStartupUpdate()
	waitPhase(t, a, "done", 5*time.Second)
	if got, _ := os.ReadFile(exe); string(got) != "old" {
		t.Fatalf("испорченный файл не должен ставиться: %q", got)
	}
	if _, err := os.Stat(exe + ".new"); !os.IsNotExist(err) {
		t.Fatal("недокачанный файл остался")
	}
	select {
	case <-restarted:
		t.Fatal("перезапуск после неудачного скачивания")
	default:
	}
}

func TestStartupUpdateNoConnection(t *testing.T) {
	srv := httptest.NewServer(http.NotFoundHandler())
	url := srv.URL + "/release"
	srv.Close() // порт закрыт — как будто GitHub недоступен
	a, exe, _ := testApp(t, url)
	start := time.Now()
	a.RunStartupUpdate()
	waitPhase(t, a, "done", 6*time.Second)
	if time.Since(start) > 2*time.Second {
		t.Fatalf("без связи запуск должен идти сразу, а ждали %v", time.Since(start))
	}
	if got, _ := os.ReadFile(exe); string(got) != "old" {
		t.Fatalf("exe изменился: %q", got)
	}
}

func TestStartupUpdateSameVersion(t *testing.T) {
	srv := fakeGitHub(t, "v2.0.0", []byte("x"), "", false)
	a, _, _ := testApp(t, srv.URL+"/release")
	a.RunStartupUpdate()
	waitPhase(t, a, "done", 5*time.Second)
}

func TestStartupUpdateSlowCanBeSkipped(t *testing.T) {
	old := startupSlowAfter
	startupSlowAfter = 200 * time.Millisecond
	t.Cleanup(func() { startupSlowAfter = old })

	srv := fakeGitHub(t, "v2.1.5", []byte("never"), "", true)
	a, exe, restarted := testApp(t, srv.URL+"/release")
	a.RunStartupUpdate()
	waitPhase(t, a, "downloading", 5*time.Second)
	deadline := time.Now().Add(3 * time.Second)
	for !a.Snapshot().Startup.Slow {
		if time.Now().After(deadline) {
			t.Fatal("кнопка пропуска так и не появилась")
		}
		time.Sleep(20 * time.Millisecond)
	}
	a.SkipStartupUpdate()
	waitPhase(t, a, "done", time.Second)
	time.Sleep(300 * time.Millisecond) // отменённое скачивание успевает прибрать за собой
	if got, _ := os.ReadFile(exe); string(got) != "old" {
		t.Fatalf("exe изменился: %q", got)
	}
	if _, err := os.Stat(exe + ".new"); !os.IsNotExist(err) {
		t.Fatal("недокачанный файл остался")
	}
	select {
	case <-restarted:
		t.Fatal("перезапуск после пропуска")
	default:
	}
}

func TestBackgroundUpdateInstalls(t *testing.T) {
	old := backgroundDelays
	backgroundDelays = []time.Duration{0}
	t.Cleanup(func() { backgroundDelays = old })

	body := []byte("new version")
	srv := fakeGitHub(t, "v2.1.5", body, sha(body), false)
	a, exe, restarted := testApp(t, srv.URL+"/release")
	a.startup.Phase = "" // автозапуск: заставки нет
	a.backgroundUpdate()
	select {
	case <-restarted:
	default:
		t.Fatalf("фоновое обновление не перезапустило программу: %+v", a.Snapshot().Startup)
	}
	if got, _ := os.ReadFile(exe); string(got) != "new version" {
		t.Fatalf("на месте exe: %q", got)
	}
}

func TestBackgroundUpdateRetriesWithoutNetwork(t *testing.T) {
	old := backgroundDelays
	backgroundDelays = []time.Duration{0, 0, 0}
	t.Cleanup(func() { backgroundDelays = old })

	hits := 0
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		hits++
		// первые две попытки — «нет связи»: обрываем соединение
		if hits < 3 {
			hj, _ := w.(http.Hijacker)
			conn, _, _ := hj.Hijack()
			conn.Close()
			return
		}
		_ = json.NewEncoder(w).Encode(map[string]any{"tag_name": "v2.0.0"})
	}))
	t.Cleanup(srv.Close)
	a, exe, restarted := testApp(t, srv.URL+"/release")
	a.startup.Phase = ""
	a.backgroundUpdate()
	if hits != 3 {
		t.Fatalf("ждали 3 попытки (2 без связи и 1 удачную), было %d", hits)
	}
	select {
	case <-restarted:
		t.Fatal("версия та же — перезапуска быть не должно")
	default:
	}
	if got, _ := os.ReadFile(exe); string(got) != "old" {
		t.Fatalf("exe изменился: %q", got)
	}
}
