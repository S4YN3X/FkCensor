package winutil

import (
	"sync"
	"unsafe"

	"golang.org/x/sys/windows"
)

// Своя шапка окна. Системную строку заголовка убирает обработка WM_NCCALCSIZE:
// клиентская часть занимает и место заголовка, а рамки по бокам и снизу остаются —
// за них окно по-прежнему тянется, у него есть тень, скругление и прилипание к краям.
// Перетаскивание, кнопки и растягивание за верхний край делает страница через WindowCommand.
//
// Ещё оконная процедура:
//   - держит окно «спрятанным» средствами DWM (cloak), пока страница не нарисована (Reveal):
//     для Windows и WebView окно показано и рисуется, но на экран не выводится. Просто скрыть
//     окно нельзя — WebView, созданный в скрытом окне, не выводит кадры, пока окно не перестроят;
//   - заливает фон цветом темы, чтобы до первой отрисовки страницы окно не просвечивало;
//   - при переезде на монитор с другим масштабом меняет размер окна, как просит Windows.

var (
	procCallWindowProcW = user32.NewProc("CallWindowProcW")
	procGetWindowLongW  = user32.NewProc("GetWindowLongW")
	procIsZoomed        = user32.NewProc("IsZoomed")
	procPostMessageW    = user32.NewProc("PostMessageW")
	procReleaseCapture  = user32.NewProc("ReleaseCapture")
	procGetCursorPos    = user32.NewProc("GetCursorPos")
	procGetSysMetrics   = user32.NewProc("GetSystemMetrics")
	procGetClientRect   = user32.NewProc("GetClientRect")
	procGetWindowRect   = user32.NewProc("GetWindowRect")
	procFillRect        = user32.NewProc("FillRect")
	procFlashWindowEx   = user32.NewProc("FlashWindowEx")

	gdi32                = windows.NewLazySystemDLL("gdi32.dll")
	procCreateSolidBrush = gdi32.NewProc("CreateSolidBrush")
	procDeleteObject     = gdi32.NewProc("DeleteObject")
)

const (
	wmCreate     = 0x0001
	wmEraseBkgnd = 0x0014
	wmNCDestroy  = 0x0082
	wmNCCalcSize = 0x0083
	wmClose      = 0x0010
	wmNCLButton  = 0x00A1
	wmDPIChanged = 0x02E0
	wsCaption    = 0x00C00000
	dwmwaCloak   = 13
)

type frameState struct {
	old    uintptr // прежняя оконная процедура
	hidden bool    // окно спрятано DWM и ждёт Reveal
	brush  uintptr // кисть фона
}

var (
	frameOnce sync.Once
	frameProc uintptr
	frameMu   sync.Mutex
	frames    = map[uintptr]*frameState{}
)

// customFrame подменяет оконную процедуру: дальше окно рисуется без системной шапки,
// остаётся спрятанным до Reveal и заливается цветом bg (0xRRGGBB).
func customFrame(hwnd uintptr, bg uint32) {
	frameOnce.Do(func() { frameProc = windows.NewCallback(frameWndProc) })
	gwlpWndProc := int32(-4)
	old, _, _ := procSetWindowLongPtrW.Call(hwnd, uintptr(gwlpWndProc), frameProc)
	frameMu.Lock()
	frames[hwnd] = &frameState{old: old, hidden: true}
	frameMu.Unlock()
	SetBackground(hwnd, bg)
	// спрятать DWM можно только уже созданное окно — это делает WM_CREATE ниже
}

func setCloak(hwnd uintptr, on bool) {
	if procDwmSetWindowAttribute.Find() != nil {
		return
	}
	var v uint32
	if on {
		v = 1
	}
	procDwmSetWindowAttribute.Call(hwnd, dwmwaCloak, uintptr(unsafe.Pointer(&v)), 4)
}

// makeOpaque выводит окно на экран, если оно ещё ждёт Reveal. Вернёт, было ли оно спрятано.
func makeOpaque(hwnd uintptr) bool {
	frameMu.Lock()
	f := frames[hwnd]
	was := f != nil && f.hidden
	if f != nil {
		f.hidden = false
	}
	frameMu.Unlock()
	if was {
		setCloak(hwnd, false)
	}
	return was
}

// SetBackground меняет цвет фона окна (0xRRGGBB) — при смене темы.
func SetBackground(hwnd uintptr, rgb uint32) {
	// COLORREF — 0x00BBGGRR
	ref := (rgb&0xFF)<<16 | rgb&0xFF00 | rgb>>16&0xFF
	brush, _, _ := procCreateSolidBrush.Call(uintptr(ref))
	frameMu.Lock()
	f := frames[hwnd]
	var prev uintptr
	if f != nil {
		prev, f.brush = f.brush, brush
	}
	frameMu.Unlock()
	if f == nil {
		procDeleteObject.Call(brush)
		return
	}
	if prev != 0 {
		procDeleteObject.Call(prev)
	}
}

// RevealMinimized показывает спрятанное окно свёрнутым — только кнопкой на панели задач,
// не отнимая фокус, — и подсвечивает кнопку, чтобы её заметили.
func RevealMinimized(hwnd uintptr) {
	// сначала свернуть, потом снять «спрятанность»: окно ни на миг не появится на экране
	const swShowMinNoActive = 7
	procShowWindow.Call(hwnd, swShowMinNoActive)
	makeOpaque(hwnd)
	Flash(hwnd)
}

// Flash несколько раз мигает кнопкой окна на панели задач; после этого она остаётся подсвеченной,
// пока окно не откроют.
func Flash(hwnd uintptr) {
	fi := struct {
		Size      uint32
		Hwnd      uintptr
		Flags     uint32
		Count     uint32
		TimeoutMs uint32
	}{Hwnd: hwnd, Flags: 2 /* FLASHW_TRAY */, Count: 5}
	fi.Size = uint32(unsafe.Sizeof(fi))
	procFlashWindowEx.Call(uintptr(unsafe.Pointer(&fi)))
}

// Reveal выводит спрятанное окно на экран — страница в нём уже нарисована — и ставит его вперёд.
func Reveal(hwnd uintptr) {
	if makeOpaque(hwnd) {
		procSetForegroundWindow.Call(hwnd)
	}
}

func frameWndProc(hwnd, msg, wp, lp uintptr) uintptr {
	frameMu.Lock()
	f := frames[hwnd]
	var old, brush uintptr
	if f != nil {
		old, brush = f.old, f.brush
	}
	frameMu.Unlock()
	call := func() uintptr {
		r, _, _ := procCallWindowProcW.Call(old, hwnd, msg, wp, lp)
		return r
	}
	switch msg {
	case wmCreate:
		// окно создано, но ещё не показано: прячем его от экрана до Reveal
		res := call()
		frameMu.Lock()
		hide := f != nil && f.hidden
		frameMu.Unlock()
		if hide {
			setCloak(hwnd, true)
		}
		return res
	case wmEraseBkgnd:
		if brush != 0 {
			var r rect
			procGetClientRect.Call(hwnd, uintptr(unsafe.Pointer(&r)))
			procFillRect.Call(wp, uintptr(unsafe.Pointer(&r)), brush)
			return 1
		}
	case wmDPIChanged:
		// окно переехало на монитор с другим масштабом: Windows присылает новый размер
		r := *(**rect)(unsafe.Pointer(&lp))
		const swpNoZOrder, swpNoActivate = 0x4, 0x10
		procSetWindowPos.Call(hwnd, 0, uintptr(r.Left), uintptr(r.Top), uintptr(r.Right-r.Left), uintptr(r.Bottom-r.Top), swpNoZOrder|swpNoActivate)
		return 0
	case wmNCCalcSize:
		gwlStyle := int32(-16)
		style, _, _ := procGetWindowLongW.Call(hwnd, uintptr(gwlStyle))
		if wp == 0 || style&wsCaption == 0 {
			break // заставка без рамки — как есть
		}
		// первый прямоугольник NCCALCSIZE_PARAMS: система сдвигает его на рамки и заголовок,
		// а верх возвращаем обратно — заголовка нет, боковые и нижняя рамки остаются
		r := *(**rect)(unsafe.Pointer(&lp))
		top := r.Top
		call()
		r.Top = top
		if zoomed, _, _ := procIsZoomed.Call(hwnd); zoomed != 0 {
			// развёрнутое окно выходит за экран на толщину рамки — иначе верх страницы обрежется
			const smCySizeFrame, smCxPaddedBorder = 33, 92
			fr, _, _ := procGetSysMetrics.Call(smCySizeFrame)
			pb, _, _ := procGetSysMetrics.Call(smCxPaddedBorder)
			r.Top += int32(fr + pb)
		}
		return 0
	case wmNCDestroy:
		res := call()
		frameMu.Lock()
		delete(frames, hwnd)
		frameMu.Unlock()
		if brush != 0 {
			procDeleteObject.Call(brush)
		}
		return res
	}
	return call()
}

// ScaleWindow меняет размер окна в ratio раз вокруг его центра — при смене масштаба
// интерфейса. Развёрнутое окно не трогает.
func ScaleWindow(hwnd uintptr, ratio float64) {
	if z, _, _ := procIsZoomed.Call(hwnd); z != 0 || ratio <= 0 {
		return
	}
	var r rect
	procGetWindowRect.Call(hwnd, uintptr(unsafe.Pointer(&r)))
	w, h := float64(r.Right-r.Left), float64(r.Bottom-r.Top)
	nw, nh := int32(w*ratio), int32(h*ratio)
	x := r.Left + (r.Right-r.Left-nw)/2
	y := r.Top + (r.Bottom-r.Top-nh)/2
	// не уезжать за верх экрана — иначе шапку не ухватить
	if y < 0 {
		y = 0
	}
	const swpNoZOrder, swpNoActivate = 0x4, 0x10
	procSetWindowPos.Call(hwnd, 0, uintptr(x), uintptr(y), uintptr(nw), uintptr(nh), swpNoZOrder|swpNoActivate)
}

// WindowCommand выполняет команду своей шапки и возвращает, развёрнуто ли окно.
//
//	minimize, maximize (развернуть или вернуть), close, drag (перетаскивание),
//	resizeTop, resizeTopLeft, resizeTopRight (растягивание за верхний край),
//	reveal (показать окно, когда страница нарисована), state.
func WindowCommand(hwnd uintptr, cmd string) bool {
	const swMinimize, swMaximize, swRestore = 6, 3, 9
	zoomed := func() bool { z, _, _ := procIsZoomed.Call(hwnd); return z != 0 }
	// Нажатие в шапке передаём окну как нажатие на системный заголовок или край:
	// дальше Windows сама ведёт перетаскивание, прилипание к краям и растягивание
	nc := func(hit uintptr) {
		var pt struct{ X, Y int32 }
		procGetCursorPos.Call(uintptr(unsafe.Pointer(&pt)))
		procReleaseCapture.Call()
		procPostMessageW.Call(hwnd, wmNCLButton, hit, uintptr(uint16(pt.X))|uintptr(uint16(pt.Y))<<16)
	}
	switch cmd {
	case "minimize":
		procShowWindow.Call(hwnd, swMinimize)
	case "maximize":
		if zoomed() {
			procShowWindow.Call(hwnd, swRestore)
		} else {
			procShowWindow.Call(hwnd, swMaximize)
		}
	case "close":
		procPostMessageW.Call(hwnd, wmClose, 0, 0)
	case "drag":
		nc(2) // HTCAPTION
	case "resizeTop":
		nc(12) // HTTOP
	case "resizeTopLeft":
		nc(13) // HTTOPLEFT
	case "resizeTopRight":
		nc(14) // HTTOPRIGHT
	case "reveal":
		Reveal(hwnd)
	}
	return zoomed()
}
