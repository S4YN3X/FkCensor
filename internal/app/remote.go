package app

import (
	"encoding/json"
	"fmt"
	"net/http"
	"strconv"
	"strings"
	"time"

	"github.com/S4YN3X/FkCensor/internal/winutil"
)

var httpClient = &http.Client{Timeout: 10 * time.Second}

func getJSON(url string, v any) (int, error) {
	req, _ := http.NewRequest("GET", url, nil)
	req.Header.Set("User-Agent", "FkCensor")
	resp, err := httpClient.Do(req)
	if err != nil {
		return 0, err
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		return resp.StatusCode, fmt.Errorf("HTTP %d", resp.StatusCode)
	}
	return resp.StatusCode, json.NewDecoder(resp.Body).Decode(v)
}

type trackMeta struct {
	Title, Artist, Cover string
}

// fetchTrack берёт название, исполнителей и обложку из публичного API Яндекс Музыки.
func fetchTrack(id string) (trackMeta, error) {
	var resp struct {
		Result []struct {
			Title    string  `json:"title"`
			Version  *string `json:"version"`
			CoverURI string  `json:"coverUri"`
			Artists  []struct {
				Name string `json:"name"`
			} `json:"artists"`
		} `json:"result"`
	}
	if _, err := getJSON("https://api.music.yandex.net/tracks/"+id, &resp); err != nil {
		return trackMeta{}, err
	}
	if len(resp.Result) == 0 {
		return trackMeta{}, fmt.Errorf("трек %s не найден", id)
	}
	t := resp.Result[0]
	m := trackMeta{Title: t.Title}
	if t.Version != nil && *t.Version != "" {
		m.Title += " (" + *t.Version + ")"
	}
	names := make([]string, len(t.Artists))
	for i, a := range t.Artists {
		names[i] = a.Name
	}
	m.Artist = strings.Join(names, ", ")
	m.Cover = coverURL(t.CoverURI)
	return m, nil
}

// coverURL превращает coverUri Яндекс Музыки («host/path/%%») в ссылку на картинку 200×200.
func coverURL(uri string) string {
	if uri == "" {
		return ""
	}
	if !strings.Contains(uri, "://") {
		uri = "https://" + uri
	}
	return strings.Replace(uri, "%%", "200x200", 1)
}

// UpdateInfo — результат проверки новой версии программы.
type UpdateInfo struct {
	Checking bool   `json:"checking"`
	Checked  int64  `json:"checked"` // unix ms последней проверки
	Latest   string `json:"latest"`
	Newer    bool   `json:"newer"`
	URL      string `json:"url"`
	Message  string `json:"message"`
}

func (a *App) CheckUpdate() { go a.checkUpdate(false) }

func (a *App) checkUpdate(silent bool) {
	a.mu.Lock()
	if a.update.Checking {
		a.mu.Unlock()
		return
	}
	a.update.Checking = true
	a.mu.Unlock()
	a.changed()

	var rel struct {
		TagName string `json:"tag_name"`
		HTMLURL string `json:"html_url"`
	}
	code, err := getJSON("https://api.github.com/repos/S4YN3X/FkCensor/releases/latest", &rel)

	u := UpdateInfo{Checked: time.Now().UnixMilli()}
	switch {
	case code == http.StatusNotFound:
		u.Message = "релизов пока нет"
	case err != nil:
		u.Message = "не удалось проверить: " + err.Error()
	case newerVersion(rel.TagName, a.Version):
		u.Latest, u.Newer, u.URL = rel.TagName, true, rel.HTMLURL
		u.Message = "доступна " + rel.TagName
	default:
		u.Latest = rel.TagName
		u.Message = "установлена последняя версия"
	}
	a.store.SetLastUpdateCheck(time.Now())

	a.mu.Lock()
	a.update = u
	a.mu.Unlock()
	a.changed()

	if silent && u.Newer {
		winutil.Notify("доступна новая версия fkcensor", rel.TagName+" — откройте окно программы, вкладка «инфо»")
	}
}

// newerVersion сравнивает версии вида v1.2.3.
func newerVersion(latest, current string) bool {
	pa := strings.Split(strings.TrimPrefix(latest, "v"), ".")
	pb := strings.Split(strings.TrimPrefix(current, "v"), ".")
	for i := 0; i < max(len(pa), len(pb)); i++ {
		var x, y int
		if i < len(pa) {
			x, _ = strconv.Atoi(pa[i])
		}
		if i < len(pb) {
			y, _ = strconv.Atoi(pb[i])
		}
		if x != y {
			return x > y
		}
	}
	return false
}
