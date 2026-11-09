package assets

import (
	"embed"
	"encoding/base64"
	"regexp"
	"strings"
	"sync"
)

//go:embed inject.js
var InjectJS []byte

//go:embed ui/index.html
var uiHTML []byte

//go:embed ui/fonts
var uiFonts embed.FS

var (
	pageOnce sync.Once
	page     string
	fontURL  = regexp.MustCompile(`url\(([\w.-]+\.woff2)\)`)
)

// UIPage — страница окна со встроенным шрифтом. Окно загружается из строки, без адреса,
// поэтому файлы шрифта подставляются прямо в CSS как data:-адреса. Так окно не ходит
// в сеть за шрифтом и сразу рисует текст нужным шрифтом.
func UIPage() string {
	pageOnce.Do(func() {
		css, err := uiFonts.ReadFile("ui/fonts/fonts.css")
		if err != nil {
			page = string(uiHTML)
			return
		}
		inlined := fontURL.ReplaceAllStringFunc(string(css), func(m string) string {
			name := fontURL.FindStringSubmatch(m)[1]
			b, err := uiFonts.ReadFile("ui/fonts/" + name)
			if err != nil {
				return m
			}
			return "url(data:font/woff2;base64," + base64.StdEncoding.EncodeToString(b) + ")"
		})
		page = strings.Replace(string(uiHTML), "<!--fonts-->", "<style>"+inlined+"</style>", 1)
	})
	return page
}
