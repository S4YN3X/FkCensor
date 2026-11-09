package assets

import _ "embed"

// Логотип: квадрат «fk». Белый квадрат — для тёмной темы, чёрный — для светлой;
// «paused» — приглушённый, когда подмена не работает (пауза, нет патча).

//go:embed icon_white.ico
var iconWhite []byte

//go:embed icon_white_paused.ico
var iconWhitePaused []byte

//go:embed icon_black.ico
var iconBlack []byte

//go:embed icon_black_paused.ico
var iconBlackPaused []byte

// Icon возвращает .ico логотипа под тему (dark — тёмная) и состояние подмены.
func Icon(dark, active bool) []byte {
	switch {
	case dark && active:
		return iconWhite
	case dark:
		return iconWhitePaused
	case active:
		return iconBlack
	default:
		return iconBlackPaused
	}
}
