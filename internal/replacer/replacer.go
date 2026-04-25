package replacer

import (
	"encoding/json"
	"fmt"
	"io"
	"mime"
	"net"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"sync"
)

// TrackReplacement описывает замену одного трека.
type TrackReplacement struct {
	TrackID  string // ID трека в Яндекс Музыке (строка)
	FilePath string // Путь к локальному аудиофайлу
}

// Server — Go HTTP-сервер, который:
//  1. Отдаёт injected-скрипту JSON-список подмен GET /replacements
//  2. Стримит аудиофайл по запросу  GET /track/{trackId}
type Server struct {
	mu           sync.RWMutex
	replacements map[string]string // trackId → filePath
	port         int
	listener     net.Listener
}

// New создаёт сервер на случайном свободном порту.
func New() (*Server, error) {
	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		return nil, fmt.Errorf("replacer server listen: %w", err)
	}
	s := &Server{
		replacements: make(map[string]string),
		port:         ln.Addr().(*net.TCPAddr).Port,
		listener:     ln,
	}
	return s, nil
}

// Port возвращает порт, на котором слушает сервер.
func (s *Server) Port() int { return s.port }

// Add добавляет замену трека.
func (s *Server) Add(trackID, filePath string) error {
	if _, err := os.Stat(filePath); os.IsNotExist(err) {
		return fmt.Errorf("file not found: %s", filePath)
	}
	s.mu.Lock()
	s.replacements[trackID] = filePath
	s.mu.Unlock()
	fmt.Printf("[replacer] Added: track %s → %s\n", trackID, filePath)
	return nil
}

// Remove убирает замену трека.
func (s *Server) Remove(trackID string) {
	s.mu.Lock()
	delete(s.replacements, trackID)
	s.mu.Unlock()
}

// List возвращает копию карты подмен.
func (s *Server) List() map[string]string {
	s.mu.RLock()
	defer s.mu.RUnlock()
	out := make(map[string]string, len(s.replacements))
	for k, v := range s.replacements {
		out[k] = v
	}
	return out
}

// Start запускает HTTP-сервер в отдельной горутине.
func (s *Server) Start() {
	mux := http.NewServeMux()
	mux.HandleFunc("/replacements", s.handleReplacements)
	mux.HandleFunc("/track/", s.handleTrack)
	mux.HandleFunc("/health", func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusOK)
	})

	srv := &http.Server{Handler: mux}
	go srv.Serve(s.listener)
	fmt.Printf("[replacer] Server started on port %d\n", s.port)
}

// handleReplacements отдаёт JSON вида { "trackId": "http://localhost:PORT/track/trackId" }
// Именно этот формат ожидает inject.js
func (s *Server) handleReplacements(w http.ResponseWriter, r *http.Request) {
	s.mu.RLock()
	defer s.mu.RUnlock()

	result := make(map[string]string, len(s.replacements))
	for trackID := range s.replacements {
		result[trackID] = fmt.Sprintf("http://localhost:%d/track/%s", s.port, trackID)
	}

	w.Header().Set("Content-Type", "application/json")
	w.Header().Set("Access-Control-Allow-Origin", "*")
	json.NewEncoder(w).Encode(result)
}

// handleTrack отдаёт аудиофайл для указанного trackId.
func (s *Server) handleTrack(w http.ResponseWriter, r *http.Request) {
	// URL: /track/{trackId}
	trackID := strings.TrimPrefix(r.URL.Path, "/track/")
	if trackID == "" {
		http.NotFound(w, r)
		return
	}

	s.mu.RLock()
	filePath, ok := s.replacements[trackID]
	s.mu.RUnlock()

	if !ok {
		http.NotFound(w, r)
		return
	}

	f, err := os.Open(filePath)
	if err != nil {
		http.Error(w, "file open error", http.StatusInternalServerError)
		return
	}
	defer f.Close()

	// Определяем MIME-тип по расширению
	ext := strings.ToLower(filepath.Ext(filePath))
	mimeType := mime.TypeByExtension(ext)
	if mimeType == "" {
		mimeType = "audio/mpeg"
	}

	w.Header().Set("Content-Type", mimeType)
	w.Header().Set("Access-Control-Allow-Origin", "*")
	w.Header().Set("Accept-Ranges", "bytes")

	info, err := f.Stat()
	if err == nil {
		http.ServeContent(w, r, filepath.Base(filePath), info.ModTime(), f)
		return
	}
	io.Copy(w, f)
}
