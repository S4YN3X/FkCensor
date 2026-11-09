package app

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"os"
	"strings"
	"time"

	"github.com/S4YN3X/F_ckCensor/internal/winutil"
)

// Обновление при запуске. Пока открыта заставка, программа проверяет релиз на GitHub;
// если есть новая версия — скачивает FkCensor.exe, сверяет контрольную сумму, ставит
// его на место текущего и перезапускается. Нет связи — запускается текущая версия,
// а если скачивание затянулось, заставка предлагает запустить без обновления.
//
// При автозапуске (в трей, без окна) то же самое идёт в фоне: программа обновляется
// молча и перезапускается обратно в трей. Нет связи — пробует ещё раз позже.

// Файл программы в релизе. Под старым названием (FkCensor.exe) его ищут прежние версии,
// поэтому какое-то время в релиз кладутся оба файла; новая версия берёт любой
var releaseAssets = []string{"F_ckCensor.exe", "FkCensor.exe"}

// Переменные, а не константы, — чтобы тест мог подставить свой сервер и файл
var (
	releaseURL          = "https://api.github.com/repos/S4YN3X/F_ckCensor/releases/latest"
	executable          = os.Executable
	startupCheckTimeout = 5 * time.Second // сколько ждать ответа GitHub при запуске
	startupSlowAfter    = 6 * time.Second // когда показать кнопку «запустить без обновления»
	// фоновое обновление при автозапуске: первая попытка — когда после входа в Windows
	// поднимется сеть, следующие — если связи не было
	backgroundDelays       = []time.Duration{30 * time.Second, 10 * time.Minute, time.Hour}
	backgroundCheckTimeout = 20 * time.Second
)

// Launch — как запущена программа: от этого зависит, когда проверять обновление.
type Launch int

const (
	LaunchWindow  Launch = iota // обычный запуск: обновление на заставке окна
	LaunchTray                  // автозапуск в трей: обновление в фоне
	LaunchUpdated               // сразу после обновления: не проверять снова
)

// StartupUpdate — состояние обновления при запуске для заставки.
type StartupUpdate struct {
	// Phase: pending — ждёт заставку, checking, downloading, installing, restarting;
	// done или пусто — обновления нет или оно пропущено, можно открывать окно
	Phase    string  `json:"phase"`
	Version  string  `json:"version"`
	Progress float64 `json:"progress"`
	// Slow — пора показать кнопку «запустить без обновления»
	Slow bool `json:"slow"`
}

type release struct {
	TagName string `json:"tag_name"`
	HTMLURL string `json:"html_url"`
	Assets  []struct {
		Name   string `json:"name"`
		Size   int64  `json:"size"`
		Digest string `json:"digest"` // «sha256:…»
		URL    string `json:"browser_download_url"`
	} `json:"assets"`
}

// TakeStartupUpdate отдаёт обновление при запуске первому окну — один раз за жизнь программы.
func (a *App) TakeStartupUpdate() bool {
	a.mu.Lock()
	defer a.mu.Unlock()
	if a.startup.Phase != "pending" || a.startupTaken {
		return false
	}
	a.startupTaken = true
	return true
}

// RunStartupUpdate начинает проверку; заставка вызывает его, когда уже показана.
func (a *App) RunStartupUpdate() {
	a.mu.Lock()
	if a.startup.Phase != "pending" {
		a.mu.Unlock()
		return
	}
	ctx, cancel := context.WithCancel(context.Background())
	a.startupCancel = cancel
	a.startup = StartupUpdate{Phase: "checking"}
	a.mu.Unlock()
	a.changed()
	go a.runStartupUpdate(ctx)
}

// SkipStartupUpdate — кнопка «запустить без обновления».
func (a *App) SkipStartupUpdate() {
	a.mu.Lock()
	cancel := a.startupCancel
	busy := a.startup.Phase == "checking" || a.startup.Phase == "downloading" || a.startup.Phase == "pending"
	if busy {
		a.startup = StartupUpdate{Phase: "done"}
	}
	a.mu.Unlock()
	if cancel != nil {
		cancel()
	}
	if busy {
		a.changed()
	}
}

func (a *App) setStartup(f func(s *StartupUpdate)) {
	a.mu.Lock()
	if a.startup.Phase == "done" { // уже пропущено кнопкой
		a.mu.Unlock()
		return
	}
	f(&a.startup)
	a.mu.Unlock()
	a.changed()
}

func (a *App) runStartupUpdate(ctx context.Context) {
	slow := time.AfterFunc(startupSlowAfter, func() { a.setStartup(func(s *StartupUpdate) { s.Slow = true }) })
	defer slow.Stop()
	a.runUpdate(ctx, startupCheckTimeout, false)
}

// backgroundUpdate — обновление при автозапуске, без окна.
func (a *App) backgroundUpdate() {
	for _, delay := range backgroundDelays {
		time.Sleep(delay)
		a.mu.Lock()
		if a.startup.Phase != "" && a.startup.Phase != "done" {
			a.mu.Unlock()
			return // обновление уже идёт
		}
		ctx, cancel := context.WithCancel(context.Background())
		a.startupCancel = cancel
		a.startup = StartupUpdate{Phase: "checking"}
		a.mu.Unlock()
		retry := a.runUpdate(ctx, backgroundCheckTimeout, true)
		cancel()
		if !retry {
			return
		}
	}
}

// runUpdate проверяет релиз и ставит новую версию. background — без окна: о неудаче
// сообщает уведомлением. Вернёт true, если GitHub не ответил и стоит попробовать позже.
func (a *App) runUpdate(ctx context.Context, checkTimeout time.Duration, background bool) (retry bool) {
	done := func() { a.setStartup(func(s *StartupUpdate) { *s = StartupUpdate{Phase: "done"} }) }
	failed := func(tag, msg string) {
		a.updateMessage(msg)
		done()
		if background {
			winutil.Notify("доступна новая версия f_ckcensor", tag+" — обновить само не получилось, откройте окно программы, вкладка «инфо»")
		}
	}

	checkCtx, cancelCheck := context.WithTimeout(ctx, checkTimeout)
	rel, code, err := fetchRelease(checkCtx)
	cancelCheck()
	if ctx.Err() != nil {
		return false // пропущено кнопкой
	}
	a.recordRelease(rel, code, err)
	if err != nil {
		done()
		return code == 0 // нет связи — позже ещё раз
	}
	if !newerVersion(rel.TagName, a.Version) {
		done()
		return false
	}
	var url, digest string
	var size int64
	for _, name := range releaseAssets {
		for _, as := range rel.Assets {
			if url == "" && as.Name == name {
				url, digest, size = as.URL, as.Digest, as.Size
			}
		}
	}
	if url == "" {
		failed(rel.TagName, "в релизе "+rel.TagName+" нет "+releaseAssets[0])
		return false
	}

	exe, err := executable()
	if err != nil {
		failed(rel.TagName, err.Error())
		return false
	}
	a.setStartup(func(s *StartupUpdate) { s.Phase, s.Version = "downloading", rel.TagName })
	newPath := exe + ".new"
	err = download(ctx, url, newPath, size, digest, func(p float64) {
		a.setStartup(func(s *StartupUpdate) { s.Progress = p })
	})
	if err != nil {
		os.Remove(newPath)
		if ctx.Err() == nil {
			failed(rel.TagName, "не удалось скачать "+rel.TagName+": "+err.Error())
		}
		return false
	}

	a.mu.Lock()
	skipped := a.startup.Phase == "done"
	if !skipped {
		a.startup.Phase, a.startup.Slow = "installing", false
	}
	a.mu.Unlock()
	if skipped {
		os.Remove(newPath)
		return false
	}
	a.changed()
	if err := replaceExe(exe, newPath); err != nil {
		os.Remove(newPath)
		failed(rel.TagName, "не удалось установить "+rel.TagName+": "+err.Error())
		return false
	}
	a.setStartup(func(s *StartupUpdate) { s.Phase = "restarting" })
	if a.OnRestart == nil {
		done()
		return false
	}
	if err := a.OnRestart(exe); err != nil {
		// новая версия не запустилась — работает эта; новая подхватится при следующем запуске
		failed(rel.TagName, "не удалось запустить "+rel.TagName+": "+err.Error())
	}
	return false
}

func fetchRelease(ctx context.Context) (release, int, error) {
	var rel release
	req, _ := http.NewRequestWithContext(ctx, "GET", releaseURL, nil)
	req.Header.Set("User-Agent", "F_ckCensor")
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		return rel, 0, err
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		return rel, resp.StatusCode, fmt.Errorf("HTTP %d", resp.StatusCode)
	}
	return rel, resp.StatusCode, json.NewDecoder(resp.Body).Decode(&rel)
}

// download скачивает файл в path, сообщает долю скачанного и сверяет размер и SHA-256.
func download(ctx context.Context, url, path string, size int64, digest string, progress func(float64)) error {
	req, _ := http.NewRequestWithContext(ctx, "GET", url, nil)
	req.Header.Set("User-Agent", "F_ckCensor")
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		return err
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		return fmt.Errorf("HTTP %d", resp.StatusCode)
	}
	if size <= 0 {
		size = resp.ContentLength
	}
	f, err := os.Create(path)
	if err != nil {
		return err
	}
	h := sha256.New()
	var got int64
	var last time.Time
	buf := make([]byte, 64<<10)
	for {
		n, rerr := resp.Body.Read(buf)
		if n > 0 {
			if _, werr := f.Write(buf[:n]); werr != nil {
				f.Close()
				return werr
			}
			h.Write(buf[:n])
			got += int64(n)
			// не чаще ~6 раз в секунду: каждое обновление — перерисовка окна
			if size > 0 && time.Since(last) > 150*time.Millisecond {
				last = time.Now()
				progress(float64(got) / float64(size))
			}
		}
		if rerr == io.EOF {
			break
		}
		if rerr != nil {
			f.Close()
			return rerr
		}
	}
	if err := f.Close(); err != nil {
		return err
	}
	progress(1)
	if size > 0 && got != size {
		return fmt.Errorf("скачано %d байт из %d", got, size)
	}
	if want, ok := strings.CutPrefix(digest, "sha256:"); ok && !strings.EqualFold(hex.EncodeToString(h.Sum(nil)), want) {
		return errors.New("контрольная сумма не совпала")
	}
	return nil
}

// replaceExe ставит новый exe на место запущенного. Запущенный файл Windows не даёт
// удалить, но даёт переименовать — он уходит в «FkCensor.exe~».
func replaceExe(exe, newPath string) error {
	old := exe + "~"
	_ = os.Remove(old)
	if err := os.Rename(exe, old); err != nil {
		return err
	}
	if err := os.Rename(newPath, exe); err != nil {
		_ = os.Rename(old, exe)
		return err
	}
	return nil
}

// CleanupOldExe удаляет «FkCensor.exe~», оставшийся от обновления, когда старая копия
// программы уже закрылась.
func CleanupOldExe() {
	exe, err := os.Executable()
	if err != nil {
		return
	}
	go func() {
		for i := 0; i < 30; i++ {
			if err := os.Remove(exe + "~"); err == nil || os.IsNotExist(err) {
				return
			}
			time.Sleep(time.Second)
		}
	}()
}

func (a *App) updateMessage(msg string) {
	a.mu.Lock()
	a.update.Message = msg
	a.mu.Unlock()
	a.changed()
}
