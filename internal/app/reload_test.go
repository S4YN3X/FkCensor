package app

import (
	"encoding/json"
	"strings"
	"testing"
	"time"

	"github.com/S4YN3X/F_ckCensor/internal/ipc"
	"github.com/S4YN3X/F_ckCensor/internal/store"
)

func TestReloadList(t *testing.T) {
	t.Setenv("LOCALAPPDATA", t.TempDir())
	a := &App{store: store.Open(), listeners: map[int]func(){}, reachable: true}

	if a.ReloadList() == nil {
		t.Fatal("без запущенной яндекс музыки обновлять некому — нужна ошибка")
	}
	a.YMSync(ipc.SyncRequest{ListLoadedAt: 1})
	if err := a.ReloadList(); err != nil {
		t.Fatal(err)
	}
	if !a.Snapshot().ListReloading {
		t.Fatal("после просьбы список должен обновляться")
	}
	// клиент ещё со старым списком — получает просьбу
	res := a.YMSync(ipc.SyncRequest{ListLoadedAt: 1})
	if res.ReloadList == 0 {
		t.Fatal("клиенту не передали просьбу обновить список")
	}
	// клиент загрузил список после просьбы — просьба снята, ошибки нет
	res = a.YMSync(ipc.SyncRequest{ListLoadedAt: time.Now().UnixMilli(), ListLoadOk: true})
	if st := a.Snapshot(); res.ReloadList != 0 || st.ListReloading || st.ListReloadError != "" {
		t.Fatalf("после загрузки просьба должна сниматься без ошибки: %+v", st.ListReloadError)
	}

	// скачать не вышло (github недоступен) — не «обновлено», а ошибка
	time.Sleep(2 * time.Millisecond)
	_ = a.ReloadList()
	a.YMSync(ipc.SyncRequest{ListLoadedAt: time.Now().UnixMilli(), ListLoadOk: false})
	if st := a.Snapshot(); st.ListReloading || st.ListReloadError == "" {
		t.Fatal("неудачная загрузка списка должна дать ошибку")
	}

	// клиент так и не ответил — по истечении срока тоже ошибка, а не «обновлено»
	_ = a.ReloadList()
	a.mu.Lock()
	a.listReload = time.Now().Add(-listReloadTimeout - time.Second)
	a.mu.Unlock()
	if st := a.Snapshot(); st.ListReloading || st.ListReloadError == "" {
		t.Fatal("без ответа клиента — ошибка")
	}
}

func TestLikesSyncEmpty(t *testing.T) {
	t.Setenv("LOCALAPPDATA", t.TempDir())
	a := &App{store: store.Open(), likes: store.OpenLikes(), listeners: map[int]func(){}, reachable: true}
	res := a.YMSync(ipc.SyncRequest{LikeOps: []store.LikeOp{{Op: "add", UID: "1", ID: "600000001000002"}}})
	if len(res.Likes["1"]) != 1 {
		t.Fatalf("лайк должен прийти клиенту: %+v", res.Likes)
	}
	// сняли последний лайк — клиент получает пустой список, а не ничего
	res = a.YMSync(ipc.SyncRequest{LikesRev: res.LikesRev, LikeOps: []store.LikeOp{{Op: "remove", UID: "1", ID: "600000001000002"}}})
	if res.Likes == nil || len(res.Likes["1"]) != 0 {
		t.Fatalf("после снятия последнего лайка — пустой список: %+v", res.Likes)
	}
	raw, _ := json.Marshal(res)
	if !strings.Contains(string(raw), `"likes":{}`) {
		t.Errorf("пустой список должен уйти в ответе: %s", raw)
	}
	// версия та же — список не шлём
	if again := a.YMSync(ipc.SyncRequest{LikesRev: res.LikesRev}); again.Likes != nil {
		t.Errorf("без изменений список не нужен: %+v", again.Likes)
	}
}
