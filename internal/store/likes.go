package store

import (
	"encoding/json"
	"os"
	"path/filepath"
	"sort"
	"sync"
	"time"
)

// Лайки треков, которых нет в Яндекс Музыке: своих треков из базы и удалённых.
// Яндекс такие лайки не хранит (свои отклоняет, удалённые молча выбрасывает),
// поэтому их хранит программа и подмешивает в «Мне нравится». Отдельно для каждого
// аккаунта Яндекса — по uid. Лежат в likes.json рядом с настройками.

// Like — лайк трека: как запись в списке «Мне нравится» у Яндекса.
type Like struct {
	ID      string `json:"id"`
	AlbumID string `json:"albumId,omitempty"`
	// Timestamp — время лайка в формате Яндекса (2026-11-08T00:24:21+00:00): по нему
	// трек встаёт в «Мне нравится» среди остальных
	Timestamp string `json:"timestamp"`
}

// LikeOp — лайк или снятие лайка из клиента.
type LikeOp struct {
	Op        string `json:"op"` // add | remove
	UID       string `json:"uid"`
	ID        string `json:"id"`
	AlbumID   string `json:"albumId"`
	Timestamp string `json:"timestamp"`
}

type Likes struct {
	mu   sync.Mutex
	path string
	data map[string][]Like // uid → лайки, новые сверху
	// rev меняется при каждом изменении: клиент получает список, только когда он новый
	rev int64
}

func OpenLikes() *Likes {
	l := &Likes{path: filepath.Join(Dir(), "likes.json"), data: map[string][]Like{}, rev: time.Now().UnixMilli()}
	if raw, err := os.ReadFile(l.path); err == nil {
		_ = json.Unmarshal(raw, &l.data)
	}
	if l.data == nil {
		l.data = map[string][]Like{}
	}
	return l
}

// Apply применяет лайки и снятия. Вернёт, изменилось ли что-нибудь.
func (l *Likes) Apply(ops []LikeOp) bool {
	if len(ops) == 0 {
		return false
	}
	l.mu.Lock()
	defer l.mu.Unlock()
	changed := false
	for _, op := range ops {
		if op.UID == "" || op.ID == "" {
			continue
		}
		list := l.data[op.UID]
		kept := list[:0:0]
		for _, x := range list {
			if x.ID != op.ID {
				kept = append(kept, x)
			}
		}
		removed := len(kept) != len(list)
		switch op.Op {
		case "add":
			ts := op.Timestamp
			if ts == "" {
				ts = time.Now().UTC().Format("2006-01-02T15:04:05+00:00")
			}
			kept = append(kept, Like{ID: op.ID, AlbumID: op.AlbumID, Timestamp: ts})
			sort.SliceStable(kept, func(i, j int) bool { return kept[i].Timestamp > kept[j].Timestamp })
			changed = true
		case "remove":
			changed = changed || removed
		default:
			continue
		}
		if len(kept) == 0 {
			delete(l.data, op.UID)
		} else {
			l.data[op.UID] = kept
		}
	}
	if changed {
		l.rev++
		l.save()
	}
	return changed
}

// All — все лайки и номер их версии.
func (l *Likes) All() (map[string][]Like, int64) {
	l.mu.Lock()
	defer l.mu.Unlock()
	out := make(map[string][]Like, len(l.data))
	for uid, list := range l.data {
		out[uid] = append([]Like(nil), list...)
	}
	return out, l.rev
}

func (l *Likes) save() {
	raw, err := json.MarshalIndent(l.data, "", "  ")
	if err != nil {
		return
	}
	_ = os.MkdirAll(filepath.Dir(l.path), 0755)
	tmp := l.path + ".tmp"
	if os.WriteFile(tmp, raw, 0644) == nil {
		_ = os.Rename(tmp, l.path)
	}
}
