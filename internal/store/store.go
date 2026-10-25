// Package store хранит настройки, историю замен и статистику в %LOCALAPPDATA%\FkCensor.
package store

import (
	"encoding/json"
	"os"
	"path/filepath"
	"sync"
	"time"
)

const historyLimit = 500

// Fallback — что делать, если файл замены не загрузился.
const (
	FallbackSilent = "silent" // молча играть оригинал
	FallbackNotify = "notify" // играть оригинал и показать уведомление
)

type Settings struct {
	Enabled    bool   `json:"enabled"`
	Autostart  bool   `json:"autostart"`
	Notify     bool   `json:"notify"`
	RestartYM  bool   `json:"restartYM"`
	AutoUpdate bool   `json:"autoUpdate"`
	HideToTray bool   `json:"hideToTray"`
	Fallback   string `json:"fallback"`
	YMDir      string `json:"ymDir"`
}

// Entry — один трек в истории.
type Entry struct {
	TrackID string    `json:"trackId"`
	Title   string    `json:"title"`
	Artist  string    `json:"artist"`
	Cover   string    `json:"cover"`
	Time    time.Time `json:"time"`
	Failed  bool      `json:"failed"`
}

type Stats struct {
	Total     int    `json:"total"`
	Failed    int    `json:"failed"`
	Today     int    `json:"today"`
	TodayDate string `json:"todayDate"`
}

type data struct {
	Settings    Settings  `json:"settings"`
	Stats       Stats     `json:"stats"`
	History     []Entry   `json:"history"`
	LastUpdated time.Time `json:"lastUpdateCheck"`
}

type Store struct {
	mu   sync.Mutex
	path string
	d    data
}

// Dir — папка данных программы.
func Dir() string { return filepath.Join(os.Getenv("LOCALAPPDATA"), "FkCensor") }

func Open() *Store {
	s := &Store{path: filepath.Join(Dir(), "state.json")}
	s.d.Settings = Settings{
		Enabled:    true,
		Notify:     false,
		RestartYM:  true,
		AutoUpdate: true,
		HideToTray: true,
		Fallback:   FallbackNotify,
	}
	if raw, err := os.ReadFile(s.path); err == nil {
		_ = json.Unmarshal(raw, &s.d)
	}
	return s
}

// save пишет файл через временный, чтобы сбой посреди записи не стёр данные.
func (s *Store) save() {
	raw, err := json.MarshalIndent(s.d, "", "  ")
	if err != nil {
		return
	}
	_ = os.MkdirAll(filepath.Dir(s.path), 0755)
	tmp := s.path + ".tmp"
	if os.WriteFile(tmp, raw, 0644) == nil {
		_ = os.Rename(tmp, s.path)
	}
}

func (s *Store) Settings() Settings {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.d.Settings
}

func (s *Store) UpdateSettings(f func(*Settings)) Settings {
	s.mu.Lock()
	defer s.mu.Unlock()
	f(&s.d.Settings)
	s.save()
	return s.d.Settings
}

func (s *Store) rollDay(now time.Time) {
	if day := now.Format("2006-01-02"); s.d.Stats.TodayDate != day {
		s.d.Stats.TodayDate = day
		s.d.Stats.Today = 0
	}
}

func (s *Store) Stats() Stats {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.rollDay(time.Now())
	return s.d.Stats
}

func (s *Store) History() []Entry {
	s.mu.Lock()
	defer s.mu.Unlock()
	return append([]Entry(nil), s.d.History...)
}

// RecentlyRecorded — был ли трек уже записан за последние window.
// Клиент может запросить файл повторно (предзагрузка, перемотка), это не новая замена.
func (s *Store) RecentlyRecorded(trackID string, window time.Duration) bool {
	s.mu.Lock()
	defer s.mu.Unlock()
	for _, e := range s.d.History {
		if time.Since(e.Time) > window {
			break
		}
		if e.TrackID == trackID {
			return true
		}
	}
	return false
}

// Record добавляет запись в начало истории и обновляет статистику.
func (s *Store) Record(e Entry) {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.rollDay(e.Time)
	if e.Failed {
		s.d.Stats.Failed++
	} else {
		s.d.Stats.Total++
		s.d.Stats.Today++
	}
	s.d.History = append([]Entry{e}, s.d.History...)
	if len(s.d.History) > historyLimit {
		s.d.History = s.d.History[:historyLimit]
	}
	s.save()
}

// UpdateEntry дополняет запись данными (например, метаданными трека после загрузки).
func (s *Store) UpdateEntry(trackID string, at time.Time, f func(*Entry)) {
	s.mu.Lock()
	defer s.mu.Unlock()
	for i := range s.d.History {
		if s.d.History[i].TrackID == trackID && s.d.History[i].Time.Equal(at) {
			f(&s.d.History[i])
			s.save()
			return
		}
	}
}

func (s *Store) ClearHistory() {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.d.History = nil
	s.save()
}

func (s *Store) LastUpdateCheck() time.Time {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.d.LastUpdated
}

func (s *Store) SetLastUpdateCheck(t time.Time) {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.d.LastUpdated = t
	s.save()
}
