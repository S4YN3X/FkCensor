package store

import "testing"

func TestLikes(t *testing.T) {
	t.Setenv("LOCALAPPDATA", t.TempDir())
	l := OpenLikes()
	_, rev0 := l.All()
	if !l.Apply([]LikeOp{
		{Op: "add", UID: "1", ID: "600000001000002", AlbumID: "2000000001", Timestamp: "2026-11-11T10:00:00+00:00"},
		{Op: "add", UID: "1", ID: "110945089", AlbumID: "24720439", Timestamp: "2026-11-11T12:00:00+00:00"},
		{Op: "add", UID: "2", ID: "5", Timestamp: "2026-11-11T09:00:00+00:00"},
	}) {
		t.Fatal("лайки должны сохраниться")
	}
	all, rev := l.All()
	if rev == rev0 {
		t.Error("после изменения версия другая — клиент получит новый список")
	}
	if got := all["1"]; len(got) != 2 || got[0].ID != "110945089" {
		t.Fatalf("новые сверху, как в «Мне нравится»: %+v", got)
	}
	// повторный лайк — не дубль, а перенос наверх
	l.Apply([]LikeOp{{Op: "add", UID: "1", ID: "600000001000002", Timestamp: "2026-11-11T13:00:00+00:00"}})
	all, _ = l.All()
	if got := all["1"]; len(got) != 2 || got[0].ID != "600000001000002" {
		t.Fatalf("повторный лайк: %+v", got)
	}
	// снятие несуществующего — ничего не меняет
	if l.Apply([]LikeOp{{Op: "remove", UID: "1", ID: "777"}}) {
		t.Error("снятие лайка, которого нет, — не изменение")
	}
	l.Apply([]LikeOp{{Op: "remove", UID: "2", ID: "5"}})

	// после перезапуска программы всё на месте
	again, _ := OpenLikes().All()
	if len(again["1"]) != 2 || len(again["2"]) != 0 {
		t.Fatalf("лайки должны пережить перезапуск: %+v", again)
	}
}
