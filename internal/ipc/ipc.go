// Package ipc — локальный HTTP-сервер, через который скрипт в Яндекс Музыке
// и вторая копия программы общаются с работающей программой.
//
// Адрес и токен лежат в %LOCALAPPDATA%\F_ckCensor\ipc.json. Без токена запросы
// отклоняются: так сайты в браузере не смогут дёргать программу через localhost.
package ipc

import (
	"bytes"
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"net"
	"net/http"
	"os"
	"path/filepath"
	"time"

	"github.com/S4YN3X/F_ckCensor/internal/store"
)

const tokenHeader = "X-FkCensor-Token"

type NowPlaying struct {
	Title   string `json:"title"`
	Artist  string `json:"artist"`
	Artwork string `json:"artwork"`
	Playing bool   `json:"playing"`
	TrackID string `json:"trackId"`
	// Replaced — трек сейчас подменяется (своя подмена или замена из базы)
	Replaced bool `json:"replaced"`
}

type Event struct {
	Type    string `json:"type"` // "replaced" | "failed"
	TrackID string `json:"trackId"`
	// Cover — обложка, которую показывает клиент (coverUri с %% вместо размера).
	// Для удалённых треков её знает только подмена, публичный API её не отдаёт.
	Cover string `json:"cover"`
	// Title, Artist — как трек видит пользователь, с подменой. У своего трека (его нет
	// в Яндекс Музыке) их знает только клиент.
	Title  string `json:"title"`
	Artist string `json:"artist"`
}

// SyncRequest — то, что скрипт в Яндекс Музыке присылает раз в пару секунд.
type SyncRequest struct {
	YMVersion  string      `json:"ymVersion"`
	ListCount  int         `json:"listCount"`
	Reachable  bool        `json:"reachable"`
	NowPlaying *NowPlaying `json:"nowPlaying"`
	Events     []Event     `json:"events"`
	// ListLoadedAt — когда началась последняя загрузка списков замен, закончившаяся (unix мс)
	ListLoadedAt int64 `json:"listLoadedAt"`
	// ListLoadOk — удалось ли в ней скачать хоть один список (иначе играет прежний)
	ListLoadOk bool `json:"listLoadOk"`
	// LikeOps — лайки треков, которых нет в Яндекс Музыке (их хранит программа)
	LikeOps []store.LikeOp `json:"likeOps,omitempty"`
	// LikesRev — версия лайков, которая уже есть у клиента
	LikesRev int64 `json:"likesRev"`
}

type SyncResponse struct {
	Enabled bool `json:"enabled"`
	// ReloadList — когда пользователь попросил обновить списки (unix мс): если клиент
	// загружал их раньше, он загружает их заново, не дожидаясь своего расписания
	ReloadList int64 `json:"reloadList,omitempty"`
	// Likes — лайки по uid аккаунта, если у клиента устаревшая версия; иначе null.
	// Без omitempty: пустой список ({}) — тоже новость, «последний лайк сняли»
	Likes    map[string][]store.Like `json:"likes"`
	LikesRev int64                   `json:"likesRev"`
}

type Handler interface {
	YMSync(SyncRequest) SyncResponse
	ShowWindow()
}

type info struct {
	Port  int    `json:"port"`
	Token string `json:"token"`
}

func infoPath(dir string) string { return filepath.Join(dir, "ipc.json") }

// Serve запускает сервер и записывает ipc.json в dir и в каждую из mirrors
// (папки, где его ищут патчи прежних версий). Возвращает функцию остановки.
func Serve(dir string, h Handler, mirrors ...string) (func(), error) {
	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		return nil, err
	}
	buf := make([]byte, 16)
	_, _ = rand.Read(buf)
	inf := info{Port: ln.Addr().(*net.TCPAddr).Port, Token: hex.EncodeToString(buf)}

	mux := http.NewServeMux()
	mux.HandleFunc("POST /ym/sync", func(w http.ResponseWriter, r *http.Request) {
		var req SyncRequest
		if err := json.NewDecoder(http.MaxBytesReader(w, r.Body, 1<<20)).Decode(&req); err != nil {
			http.Error(w, err.Error(), http.StatusBadRequest)
			return
		}
		w.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(w).Encode(h.YMSync(req))
	})
	mux.HandleFunc("POST /app/show", func(w http.ResponseWriter, r *http.Request) {
		h.ShowWindow()
	})

	auth := http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Header.Get(tokenHeader) != inf.Token {
			http.Error(w, "forbidden", http.StatusForbidden)
			return
		}
		mux.ServeHTTP(w, r)
	})
	srv := &http.Server{Handler: auth, ReadHeaderTimeout: 5 * time.Second}
	go srv.Serve(ln)

	raw, _ := json.Marshal(inf)
	_ = os.MkdirAll(dir, 0755)
	if err := os.WriteFile(infoPath(dir), raw, 0600); err != nil {
		srv.Close()
		return nil, err
	}
	// копии для патчей прежних версий: они ищут ipc.json в своей папке
	written := []string{infoPath(dir)}
	for _, m := range mirrors {
		if m == dir {
			continue
		}
		_ = os.MkdirAll(m, 0755)
		if os.WriteFile(infoPath(m), raw, 0600) == nil {
			written = append(written, infoPath(m))
		}
	}
	return func() {
		for _, p := range written {
			_ = os.Remove(p)
		}
		_ = srv.Close()
	}, nil
}

// AskShow просит уже запущенную копию программы показать окно.
func AskShow(dir string) error {
	raw, err := os.ReadFile(infoPath(dir))
	if err != nil {
		return err
	}
	var inf info
	if err := json.Unmarshal(raw, &inf); err != nil {
		return err
	}
	req, _ := http.NewRequest("POST", fmt.Sprintf("http://127.0.0.1:%d/app/show", inf.Port), bytes.NewReader(nil))
	req.Header.Set(tokenHeader, inf.Token)
	resp, err := (&http.Client{Timeout: 3 * time.Second}).Do(req)
	if err != nil {
		return err
	}
	resp.Body.Close()
	return nil
}
