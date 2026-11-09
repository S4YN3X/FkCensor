package app

import (
	"testing"

	"github.com/S4YN3X/F_ckCensor/internal/ipc"
	"github.com/S4YN3X/F_ckCensor/internal/store"
)

func TestHistoryRecordsEveryTrack(t *testing.T) {
	t.Setenv("LOCALAPPDATA", t.TempDir())
	a := &App{store: store.Open(), listeners: map[int]func(){}, reachable: true}
	np := func(id string, replaced bool) *ipc.NowPlaying {
		return &ipc.NowPlaying{Title: "трек " + id, Artist: "исполнитель", Playing: true, TrackID: id, Replaced: replaced}
	}

	// 1. подменённый трек: событие замены и «сейчас играет» в одном обмене — одна запись
	a.YMSync(ipc.SyncRequest{Events: []ipc.Event{{Type: "replaced", TrackID: "1"}}, NowPlaying: np("1", true)})
	// 2. обычный трек
	a.YMSync(ipc.SyncRequest{NowPlaying: np("2", false)})
	// 3. тот же трек играет дальше — без дубля
	a.YMSync(ipc.SyncRequest{NowPlaying: np("2", false)})
	// 4. снова подменённый трек без нового запроса файла (из кэша клиента) — недавно уже был, без дубля
	a.YMSync(ipc.SyncRequest{NowPlaying: np("1", true)})
	// 5. замена не загрузилась: играет оригинал — одна запись «не загрузилось», не две
	a.YMSync(ipc.SyncRequest{Events: []ipc.Event{{Type: "failed", TrackID: "3"}}, NowPlaying: np("3", false)})
	// 6. пауза — не новое воспроизведение
	paused := np("4", false)
	paused.Playing = false
	a.YMSync(ipc.SyncRequest{NowPlaying: paused})

	hist := a.store.History()
	got := []string{}
	for _, e := range hist {
		kind := "заменён"
		if e.Failed {
			kind = "не загрузилось"
		} else if e.Original {
			kind = "без замены"
		}
		got = append(got, e.TrackID+":"+kind)
	}
	want := []string{"3:не загрузилось", "2:без замены", "1:заменён"}
	if len(got) != len(want) {
		t.Fatalf("история %v, ждали %v", got, want)
	}
	for i := range want {
		if got[i] != want[i] {
			t.Fatalf("история %v, ждали %v", got, want)
		}
	}
	if st := a.store.Stats(); st.Total != 1 || st.Today != 1 || st.Failed != 1 {
		t.Fatalf("статистика: %+v (обычные треки в неё не идут)", st)
	}
}
