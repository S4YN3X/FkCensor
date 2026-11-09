// Package winutil — системные мелочи Windows: автозапуск, уведомления,
// выбор папки, иконки окна, открытие ссылок.
package winutil

import (
	"encoding/base64"
	"encoding/binary"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strings"
	"syscall"
	"unicode/utf16"
	"unsafe"

	"golang.org/x/sys/windows"
	"golang.org/x/sys/windows/registry"
)

var (
	user32  = windows.NewLazySystemDLL("user32.dll")
	shell32 = windows.NewLazySystemDLL("shell32.dll")
	ole32   = windows.NewLazySystemDLL("ole32.dll")

	procSetDpiAwarenessContext   = user32.NewProc("SetProcessDpiAwarenessContext")
	procGetDpiForSystem          = user32.NewProc("GetDpiForSystem")
	procCreateIconFromResourceEx = user32.NewProc("CreateIconFromResourceEx")
	procSendMessageW             = user32.NewProc("SendMessageW")
	procShowWindow               = user32.NewProc("ShowWindow")
	procSetForegroundWindow      = user32.NewProc("SetForegroundWindow")
	procSHBrowseForFolderW       = shell32.NewProc("SHBrowseForFolderW")
	procSHGetPathFromIDListW     = shell32.NewProc("SHGetPathFromIDListW")
	procCoInitializeEx           = ole32.NewProc("CoInitializeEx")
	procCoTaskMemFree            = ole32.NewProc("CoTaskMemFree")
	procSetWindowPos             = user32.NewProc("SetWindowPos")

	dwmapi                    = windows.NewLazySystemDLL("dwmapi.dll")
	procDwmSetWindowAttribute = dwmapi.NewProc("DwmSetWindowAttribute")
)

const (
	appID  = "F_ckCensor"
	// legacyAppID — запись автозапуска под старым названием: убираем при переезде
	legacyAppID = "FkCensor"
	runKey = `Software\Microsoft\Windows\CurrentVersion\Run`
)

// EnableDPIAwareness включает чёткую отрисовку на мониторах с масштабом больше 100%.
func EnableDPIAwareness() {
	if procSetDpiAwarenessContext.Find() == nil {
		const perMonitorV2 = ^uintptr(3) // DPI_AWARENESS_CONTEXT_PER_MONITOR_AWARE_V2 = -4
		procSetDpiAwarenessContext.Call(perMonitorV2)
	}
}

// Scale переводит логические пиксели в физические по системному DPI.
func Scale(px int) int {
	if procGetDpiForSystem.Find() != nil {
		return px
	}
	dpi, _, _ := procGetDpiForSystem.Call()
	if dpi == 0 {
		return px
	}
	return px * int(dpi) / 96
}

// SetAutostart добавляет или убирает программу из автозагрузки текущего пользователя.
func SetAutostart(on bool) error {
	k, err := registry.OpenKey(registry.CURRENT_USER, runKey, registry.SET_VALUE)
	if err != nil {
		return err
	}
	defer k.Close()
	_ = k.DeleteValue(legacyAppID)
	if !on {
		if err := k.DeleteValue(appID); err != nil && err != registry.ErrNotExist {
			return err
		}
		return nil
	}
	exe, err := os.Executable()
	if err != nil {
		return err
	}
	return k.SetStringValue(appID, fmt.Sprintf(`"%s" --tray`, exe))
}

// RegisterNotifications регистрирует AppUserModelID, чтобы уведомления
// подписывались «F_ckCensor» и показывались с иконкой программы.
func RegisterNotifications(ico []byte) {
	iconPath := filepath.Join(os.Getenv("LOCALAPPDATA"), "F_ckCensor", "icon.ico")
	_ = os.MkdirAll(filepath.Dir(iconPath), 0755)
	_ = os.WriteFile(iconPath, ico, 0644)

	k, _, err := registry.CreateKey(registry.CURRENT_USER, `Software\Classes\AppUserModelId\`+appID, registry.SET_VALUE)
	if err != nil {
		return
	}
	defer k.Close()
	_ = k.SetStringValue("DisplayName", "F_ckCensor")
	_ = k.SetStringValue("IconUri", iconPath)
}

func xmlEscape(s string) string {
	return strings.NewReplacer("&", "&amp;", "<", "&lt;", ">", "&gt;", `"`, "&quot;", "'", "&apos;").Replace(s)
}

// Notify показывает системное уведомление Windows.
func Notify(title, body string) {
	xml := `<toast><visual><binding template="ToastGeneric"><text>` + xmlEscape(title) +
		`</text><text>` + xmlEscape(body) + `</text></binding></visual></toast>`
	script := `[Windows.UI.Notifications.ToastNotificationManager, Windows.UI.Notifications, ContentType = WindowsRuntime] | Out-Null
[Windows.Data.Xml.Dom.XmlDocument, Windows.Data.Xml.Dom.XmlDocument, ContentType = WindowsRuntime] | Out-Null
$x = New-Object Windows.Data.Xml.Dom.XmlDocument
$x.LoadXml('` + strings.ReplaceAll(xml, "'", "''") + `')
[Windows.UI.Notifications.ToastNotificationManager]::CreateToastNotifier('` + appID + `').Show((New-Object Windows.UI.Notifications.ToastNotification $x))`

	u := utf16.Encode([]rune(script))
	b := make([]byte, len(u)*2)
	for i, c := range u {
		binary.LittleEndian.PutUint16(b[i*2:], c)
	}
	cmd := exec.Command("powershell", "-NoProfile", "-NonInteractive", "-EncodedCommand", base64.StdEncoding.EncodeToString(b))
	cmd.SysProcAttr = &syscall.SysProcAttr{HideWindow: true, CreationFlags: windows.CREATE_NO_WINDOW}
	go cmd.Run()
}

// OpenURL открывает ссылку в браузере по умолчанию.
func OpenURL(url string) {
	verb, _ := windows.UTF16PtrFromString("open")
	target, _ := windows.UTF16PtrFromString(url)
	_ = windows.ShellExecute(0, verb, target, nil, nil, windows.SW_SHOWNORMAL)
}

type browseInfo struct {
	Owner       uintptr
	Root        uintptr
	DisplayName *uint16
	Title       *uint16
	Flags       uint32
	Callback    uintptr
	LParam      uintptr
	Image       int32
}

// PickFolder показывает системный диалог выбора папки. Пустая строка — отмена.
func PickFolder(owner uintptr, title string) string {
	runtime.LockOSThread()
	defer runtime.UnlockOSThread()
	const coinitApartmentThreaded = 0x2
	procCoInitializeEx.Call(0, coinitApartmentThreaded)

	name := make([]uint16, windows.MAX_PATH)
	t, _ := windows.UTF16PtrFromString(title)
	bi := browseInfo{
		Owner:       owner,
		DisplayName: &name[0],
		Title:       t,
		Flags:       0x1 | 0x40, // BIF_RETURNONLYFSDIRS | BIF_NEWDIALOGSTYLE
	}
	pidl, _, _ := procSHBrowseForFolderW.Call(uintptr(unsafe.Pointer(&bi)))
	if pidl == 0 {
		return ""
	}
	defer procCoTaskMemFree.Call(pidl)
	path := make([]uint16, windows.MAX_PATH)
	if ok, _, _ := procSHGetPathFromIDListW.Call(pidl, uintptr(unsafe.Pointer(&path[0]))); ok == 0 {
		return ""
	}
	return windows.UTF16ToString(path)
}

// SetWindowIcon ставит окну маленькую и большую иконку из .ico-файла — под размеры,
// которые Windows просит при текущем масштабе экрана (на 150% это 24 и 48 px).
func SetWindowIcon(hwnd uintptr, ico []byte) {
	const wmSetIcon, iconSmall, iconBig = 0x0080, 0, 1
	const smCxIcon, smCxSmIcon = 11, 49
	small, _, _ := procGetSysMetrics.Call(smCxSmIcon)
	big, _, _ := procGetSysMetrics.Call(smCxIcon)
	if h := iconFromICO(ico, int(small)); h != 0 {
		procSendMessageW.Call(hwnd, wmSetIcon, iconSmall, h)
	}
	if h := iconFromICO(ico, int(big)); h != 0 {
		procSendMessageW.Call(hwnd, wmSetIcon, iconBig, h)
	}
}

// AppsDark — тёмная ли тема приложений Windows (её же страница видит как prefers-color-scheme).
func AppsDark() bool {
	k, err := registry.OpenKey(registry.CURRENT_USER, `Software\Microsoft\Windows\CurrentVersion\Themes\Personalize`, registry.QUERY_VALUE)
	if err != nil {
		return false
	}
	defer k.Close()
	v, _, err := k.GetIntegerValue("AppsUseLightTheme")
	return err == nil && v == 0
}

// TaskbarDark — тёмная ли панель задач Windows (по умолчанию в Windows 11 — тёмная).
func TaskbarDark() bool {
	k, err := registry.OpenKey(registry.CURRENT_USER, `Software\Microsoft\Windows\CurrentVersion\Themes\Personalize`, registry.QUERY_VALUE)
	if err != nil {
		return true
	}
	defer k.Close()
	v, _, err := k.GetIntegerValue("SystemUsesLightTheme")
	return err != nil || v == 0
}

// iconFromICO берёт из .ico запись нужного размера: ровно size, иначе ближайшую побольше,
// иначе самую большую — Windows уменьшит её сама.
func iconFromICO(ico []byte, size int) uintptr {
	if len(ico) < 6 || size <= 0 {
		return 0
	}
	count := int(binary.LittleEndian.Uint16(ico[4:6]))
	best, bestW := -1, 0
	for i := 0; i < count; i++ {
		e := 6 + 16*i
		if e+16 > len(ico) {
			break
		}
		w := int(ico[e])
		if w == 0 {
			w = 256
		}
		better := best < 0 ||
			(w >= size && (bestW < size || w < bestW)) ||
			(w < size && bestW < size && w > bestW)
		if better {
			best, bestW = e, w
		}
	}
	if best < 0 {
		return 0
	}
	n := binary.LittleEndian.Uint32(ico[best+8:])
	off := binary.LittleEndian.Uint32(ico[best+12:])
	if n == 0 || int(off+n) > len(ico) {
		return 0
	}
	img := ico[off : off+n]
	h, _, _ := procCreateIconFromResourceEx.Call(uintptr(unsafe.Pointer(&img[0])), uintptr(n), 1, 0x00030000, uintptr(size), uintptr(size), 0)
	return h
}

// SetDarkTitleBar красит системную шапку окна в тёмный или возвращает светлую.
func SetDarkTitleBar(hwnd uintptr, dark bool) {
	if procDwmSetWindowAttribute.Find() != nil {
		return
	}
	var v uint32
	if dark {
		v = 1
	}
	// DWMWA_USE_IMMERSIVE_DARK_MODE: 20 в Windows 10 20H1+ и 11, 19 в более старых сборках
	if r, _, _ := procDwmSetWindowAttribute.Call(hwnd, 20, uintptr(unsafe.Pointer(&v)), 4); r != 0 {
		procDwmSetWindowAttribute.Call(hwnd, 19, uintptr(unsafe.Pointer(&v)), 4)
	}
	// Перерисовать рамку, иначе в Windows 10 шапка сменится только после переключения окон
	const swpNoSize, swpNoMove, swpNoZOrder, swpNoActivate, swpFrameChanged = 0x1, 0x2, 0x4, 0x10, 0x20
	procSetWindowPos.Call(hwnd, 0, 0, 0, 0, 0, swpNoSize|swpNoMove|swpNoZOrder|swpNoActivate|swpFrameChanged)
}

// BringToFront разворачивает окно и выводит его на передний план.
func BringToFront(hwnd uintptr) {
	Reveal(hwnd) // окно могло ещё ждать отрисовки страницы — показываем как есть
	const swRestore = 9
	procShowWindow.Call(hwnd, swRestore)
	procSetForegroundWindow.Call(hwnd)
}
