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
	fontsCSS string
	fontsMu  sync.Once
	fontURL  = regexp.MustCompile(`url\(([\w.-]+\.woff2)\)`)
)

// UIPage — страница окна со встроенным шрифтом.
func UIPage() string {
	pageOnce.Do(func() { page = WithFonts(string(uiHTML)) })
	return page
}

// WithFonts подставляет шрифт программы (IBM Plex Mono) вместо <!--fonts--> в странице.
// Окна загружаются из строки, без адреса, поэтому файлы шрифта встают прямо в CSS
// как data:-адреса: окно не ходит в сеть за шрифтом и сразу рисует текст нужным шрифтом.
func WithFonts(html string) string {
	fontsMu.Do(func() {
		css, err := uiFonts.ReadFile("ui/fonts/fonts.css")
		if err != nil {
			return
		}
		fontsCSS = fontURL.ReplaceAllStringFunc(string(css), func(m string) string {
			name := fontURL.FindStringSubmatch(m)[1]
			b, err := uiFonts.ReadFile("ui/fonts/" + name)
			if err != nil {
				return m
			}
			return "url(data:font/woff2;base64," + base64.StdEncoding.EncodeToString(b) + ")"
		})
	})
	if fontsCSS == "" {
		return html
	}
	return strings.Replace(html, "<!--fonts-->", "<style>"+fontsCSS+"</style>", 1)
}
