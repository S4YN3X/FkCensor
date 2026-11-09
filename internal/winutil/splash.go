package winutil

import (
	"sync"
	"unsafe"

	"golang.org/x/sys/windows"
)

// Окно-заставка. Библиотека WebView2 создаёт и сразу показывает обычное окно с рамкой,
// поэтому маленькое окно без рамки задаётся в момент создания: перехват WH_CBT на своём
// потоке меняет стиль, размер и положение окна ещё до того, как оно появится на экране.

var (
	procSetWindowsHookExW   = user32.NewProc("SetWindowsHookExW")
	procUnhookWindowsHookEx = user32.NewProc("UnhookWindowsHookEx")
	procCallNextHookEx      = user32.NewProc("CallNextHookEx")
	procSetWindowLongPtrW   = user32.NewProc("SetWindowLongPtrW")
	procAdjustWindowRectEx  = user32.NewProc("AdjustWindowRectEx")
	procMonitorFromWindow   = user32.NewProc("MonitorFromWindow")
	procGetMonitorInfoW     = user32.NewProc("GetMonitorInfoW")
	procSystemParamsInfoW   = user32.NewProc("SystemParametersInfoW")
)

const (
	wsPopup            = 0x80000000
	wsOverlappedWindow = 0x00CF0000
)

type rect struct{ Left, Top, Right, Bottom int32 }

type createStruct struct {
	CreateParams, Instance, Menu, Parent uintptr
	Cy, Cx, Y, X                         int32
	Style                                uint32
	Name, Class                          uintptr
	ExStyle                              uint32
}

type cbtCreateWnd struct {
	CS          *createStruct
	InsertAfter uintptr
}

type monitorInfo struct {
	Size          uint32
	Monitor, Work rect
	Flags         uint32
}

var (
	hookOnce sync.Once
	hookProc uintptr
	hookMu   sync.Mutex
	// hookArmed — следующее окно ещё не перехвачено; hookW, hookH2 — размер заставки (ноль — без неё)
	hookArmed     bool
	hookW, hookH2 int32
	hookBg        uint32
)

// PrepareNextWindow настраивает следующее окно верхнего уровня, созданное в этом потоке:
// у него будет своя шапка вместо системной, фон цвета bg (0xRRGGBB), и оно останется
// скрытым до Reveal. При splash окно откроется заставкой w×h без рамки по центру рабочей
// области основного монитора. Вернёт функцию, которую нужно вызвать сразу после создания окна.
func PrepareNextWindow(splash bool, w, h int, bg uint32) (done func()) {
	hookOnce.Do(func() {
		// колбэк создаётся один раз: число колбэков в процессе ограничено, а окно открывается многократно
		hookProc = windows.NewCallback(func(code, wp, lp uintptr) uintptr {
			const hcbtCreateWnd = 3
			if int32(code) == hcbtCreateWnd {
				hookMu.Lock()
				cbt := *(**cbtCreateWnd)(unsafe.Pointer(&lp)) // lp — адрес CBT_CREATEWND от системы
				if hookArmed && cbt.CS.Parent == 0 {
					hookArmed = false
					customFrame(wp, hookBg)
				}
				if hookW > 0 && cbt.CS.Parent == 0 {
					work := primaryWorkArea()
					// стиль из CREATESTRUCT система учитывает не полностью, поэтому ставим его и самому окну (wp)
					cbt.CS.Style = wsPopup
					gwlStyle := int32(-16)
					procSetWindowLongPtrW.Call(wp, uintptr(gwlStyle), wsPopup)
					cbt.CS.Cx, cbt.CS.Cy = hookW, hookH2
					cbt.CS.X = work.Left + (work.Right-work.Left-hookW)/2
					cbt.CS.Y = work.Top + (work.Bottom-work.Top-hookH2)/2
					hookW, hookH2 = 0, 0
				}
				hookMu.Unlock()
			}
			r, _, _ := procCallNextHookEx.Call(0, code, wp, lp)
			return r
		})
	})
	hookMu.Lock()
	hookArmed, hookBg = true, bg
	if splash {
		hookW, hookH2 = int32(w), int32(h)
	}
	hookMu.Unlock()
	const whCBT = 5
	hk, _, _ := procSetWindowsHookExW.Call(whCBT, hookProc, 0, uintptr(windows.GetCurrentThreadId()))
	return func() {
		if hk != 0 {
			procUnhookWindowsHookEx.Call(hk)
		}
		hookMu.Lock()
		hookArmed, hookW, hookH2 = false, 0, 0
		hookMu.Unlock()
	}
}

func primaryWorkArea() rect {
	var r rect
	const spiGetWorkArea = 0x30
	procSystemParamsInfoW.Call(spiGetWorkArea, 0, uintptr(unsafe.Pointer(&r)), 0)
	return r
}

// RoundCorners скругляет углы окна без рамки (Windows 11; в Windows 10 ничего не делает).
func RoundCorners(hwnd uintptr, on bool) {
	if procDwmSetWindowAttribute.Find() != nil {
		return
	}
	v := uint32(0) // DWMWCP_DEFAULT
	if on {
		v = 2 // DWMWCP_ROUND
	}
	const dwmwaWindowCornerPreference = 33
	procDwmSetWindowAttribute.Call(hwnd, dwmwaWindowCornerPreference, uintptr(unsafe.Pointer(&v)), 4)
}

// ExpandSplash превращает заставку в обычное окно с рамкой: клиентская часть w×h,
// по центру монитора, на котором была заставка. Окно на время перестройки прячется,
// чтобы не было видно промежуточных состояний.
func ExpandSplash(hwnd uintptr, w, h int) {
	const swHide, swShow = 0, 5
	makeOpaque(hwnd) // если страница так и не позвала Reveal
	procShowWindow.Call(hwnd, swHide)
	RoundCorners(hwnd, false)
	gwlStyle := int32(-16)
	procSetWindowLongPtrW.Call(hwnd, uintptr(gwlStyle), wsOverlappedWindow)

	r := rect{Right: int32(w), Bottom: int32(h)}
	procAdjustWindowRectEx.Call(uintptr(unsafe.Pointer(&r)), wsOverlappedWindow, 0, 0)
	ow, oh := r.Right-r.Left, r.Bottom-r.Top

	const monitorDefaultToNearest = 2
	mon, _, _ := procMonitorFromWindow.Call(hwnd, monitorDefaultToNearest)
	mi := monitorInfo{Size: uint32(unsafe.Sizeof(monitorInfo{}))}
	procGetMonitorInfoW.Call(mon, uintptr(unsafe.Pointer(&mi)))
	work := mi.Work
	x := work.Left + (work.Right-work.Left-ow)/2
	y := work.Top + (work.Bottom-work.Top-oh)/2

	const swpNoZOrder, swpFrameChanged = 0x4, 0x20
	procSetWindowPos.Call(hwnd, 0, uintptr(x), uintptr(y), uintptr(ow), uintptr(oh), swpNoZOrder|swpFrameChanged)
	procShowWindow.Call(hwnd, swShow)
	procSetForegroundWindow.Call(hwnd)
}
