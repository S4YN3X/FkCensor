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
	"time"
)

type TrackSource string

const (
	SourceLocal     TrackSource = "local"
	SourceRemote    TrackSource = "remote"
	SourceException TrackSource = "exception"
)

type trackEntry struct {
	Source    TrackSource
	LocalPath string
	RemoteURL string
}

type Server struct {
	mu        sync.RWMutex
	tracks    map[string]*trackEntry
	port      int
	listener  net.Listener
	onReplace func()
}

func (s *Server) OnReplace(fn func()) {
	s.onReplace = fn
}

func New() (*Server, error) {
	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		return nil, fmt.Errorf("replacer listen: %w", err)
	}
	return &Server{
		tracks:   make(map[string]*trackEntry),
		port:     ln.Addr().(*net.TCPAddr).Port,
		listener: ln,
	}, nil
}

func (s *Server) Port() int { return s.port }

func (s *Server) AddLocal(trackID, filePath string) error {
	if _, err := os.Stat(filePath); os.IsNotExist(err) {
		return fmt.Errorf("file not found: %s", filePath)
	}
	s.mu.Lock()
	s.tracks[trackID] = &trackEntry{Source: SourceLocal, LocalPath: filePath}
	s.mu.Unlock()
	fmt.Printf("[replacer] local: %s → %s\n", trackID, filePath)
	return nil
}

func (s *Server) AddRemote(trackID, remoteURL string) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if e, ok := s.tracks[trackID]; ok {
		if e.Source == SourceLocal || e.Source == SourceException {
			return
		}
	}
	s.tracks[trackID] = &trackEntry{Source: SourceRemote, RemoteURL: remoteURL}
}

func (s *Server) AddException(trackID string) {
	s.mu.Lock()
	s.tracks[trackID] = &trackEntry{Source: SourceException}
	s.mu.Unlock()
}

func (s *Server) Remove(trackID string) {
	s.mu.Lock()
	delete(s.tracks, trackID)
	s.mu.Unlock()
}

func (s *Server) List() map[string]*trackEntry {
	s.mu.RLock()
	defer s.mu.RUnlock()
	out := make(map[string]*trackEntry, len(s.tracks))
	for k, v := range s.tracks {
		cp := *v
		out[k] = &cp
	}
	return out
}

type RemoteListJSON struct {
	Tracks map[string]string `json:"tracks"`
}

func (s *Server) SyncRemote(listURL string) (int, error) {
	client := &http.Client{Timeout: 15 * time.Second}
	resp, err := client.Get(listURL)
	if err != nil {
		return 0, fmt.Errorf("fetch list.json: %w", err)
	}
	defer resp.Body.Close()

	if resp.StatusCode != http.StatusOK {
		return 0, fmt.Errorf("list.json HTTP %d", resp.StatusCode)
	}

	var data RemoteListJSON
	if err := json.NewDecoder(resp.Body).Decode(&data); err != nil {
		return 0, fmt.Errorf("parse list.json: %w", err)
	}

	s.mu.Lock()
	for id, e := range s.tracks {
		if e.Source == SourceRemote {
			delete(s.tracks, id)
		}
	}
	s.mu.Unlock()

	count := 0
	for trackID, remoteURL := range data.Tracks {
		s.AddRemote(trackID, remoteURL)
		count++
	}
	return count, nil
}

func (s *Server) AutoSync(listURL string, interval time.Duration) {
	go func() {
		for {
			n, err := s.SyncRemote(listURL)
			if err != nil {
				fmt.Printf("[replacer] remote sync error: %v\n", err)
			} else {
				fmt.Printf("[replacer] remote sync: %d tracks\n", n)
			}
			time.Sleep(interval)
		}
	}()
}

func (s *Server) Start() {
	mux := http.NewServeMux()
	mux.HandleFunc("/replacements", s.handleReplacements)
	mux.HandleFunc("/track/", s.handleTrack)
	mux.HandleFunc("/health", func(w http.ResponseWriter, r *http.Request) { w.WriteHeader(http.StatusOK) })
	go (&http.Server{Handler: mux}).Serve(s.listener)
	fmt.Printf("[replacer] server on port %d\n", s.port)
}

// handleReplacements отдаёт inject.js карту { trackId → audioUrl }.
// Для local и remote — URL прокси Go-сервера (чтобы YM не получил CORS-ошибку).
// Исключения не включаются в список.
func (s *Server) handleReplacements(w http.ResponseWriter, r *http.Request) {
	s.mu.RLock()
	defer s.mu.RUnlock()

	result := make(map[string]string, len(s.tracks))
	for trackID, e := range s.tracks {
		if e.Source == SourceException {
			continue
		}
		result[trackID] = fmt.Sprintf("http://localhost:%d/track/%s", s.port, trackID)
	}

	w.Header().Set("Content-Type", "application/json")
	w.Header().Set("Access-Control-Allow-Origin", "*")
	json.NewEncoder(w).Encode(result)
}

func (s *Server) handleTrack(w http.ResponseWriter, r *http.Request) {
	trackID := strings.TrimPrefix(r.URL.Path, "/track/")
	if trackID == "" {
		http.NotFound(w, r)
		return
	}

	s.mu.RLock()
	entry, ok := s.tracks[trackID]
	s.mu.RUnlock()

	if !ok || entry.Source == SourceException {
		http.NotFound(w, r)
		return
	}

	w.Header().Set("Access-Control-Allow-Origin", "*")

	if s.onReplace != nil {
		s.onReplace()
	}

	switch entry.Source {
	case SourceLocal:
		serveLocalFile(w, r, entry.LocalPath)
	case SourceRemote:
		proxyRemoteURL(w, r, entry.RemoteURL)
	}
}

func serveLocalFile(w http.ResponseWriter, r *http.Request, filePath string) {
	f, err := os.Open(filePath)
	if err != nil {
		http.Error(w, "file open error", http.StatusInternalServerError)
		return
	}
	defer f.Close()

	ext := strings.ToLower(filepath.Ext(filePath))
	mimeType := mime.TypeByExtension(ext)
	if mimeType == "" {
		mimeType = "audio/mpeg"
	}
	w.Header().Set("Content-Type", mimeType)

	info, err := f.Stat()
	if err == nil {
		http.ServeContent(w, r, filepath.Base(filePath), info.ModTime(), f)
		return
	}
	io.Copy(w, f)
}

func proxyRemoteURL(w http.ResponseWriter, r *http.Request, remoteURL string) {
	client := &http.Client{Timeout: 30 * time.Second}
	req, err := http.NewRequest("GET", remoteURL, nil)
	if err != nil {
		http.Error(w, "bad remote URL", http.StatusInternalServerError)
		return
	}

	if rng := r.Header.Get("Range"); rng != "" {
		req.Header.Set("Range", rng)
	}

	resp, err := client.Do(req)
	if err != nil {
		http.Error(w, "remote fetch error", http.StatusBadGateway)
		return
	}
	defer resp.Body.Close()

	for _, h := range []string{"Content-Type", "Content-Length", "Content-Range", "Accept-Ranges"} {
		if v := resp.Header.Get(h); v != "" {
			w.Header().Set(h, v)
		}
	}
	if w.Header().Get("Content-Type") == "" {
		w.Header().Set("Content-Type", "audio/mpeg")
	}

	w.WriteHeader(resp.StatusCode)
	io.Copy(w, resp.Body)
}
