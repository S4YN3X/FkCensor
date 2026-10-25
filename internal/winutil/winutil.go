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
)

const (
	appID  = "FkCensor"
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
// подписывались «FkCensor» и показывались с иконкой программы.
func RegisterNotifications(ico []byte) {
	iconPath := filepath.Join(os.Getenv("LOCALAPPDATA"), "FkCensor", "icon.ico")
	_ = os.MkdirAll(filepath.Dir(iconPath), 0755)
	_ = os.WriteFile(iconPath, ico, 0644)

	k, _, err := registry.CreateKey(registry.CURRENT_USER, `Software\Classes\AppUserModelId\`+appID, registry.SET_VALUE)
	if err != nil {
		return
	}
	defer k.Close()
	_ = k.SetStringValue("DisplayName", "FkCensor")
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

// SetWindowIcon ставит окну иконки 16 и 32 px из .ico-файла.
func SetWindowIcon(hwnd uintptr, ico []byte) {
	const wmSetIcon, iconSmall, iconBig = 0x0080, 0, 1
	if h := iconFromICO(ico, 16); h != 0 {
		procSendMessageW.Call(hwnd, wmSetIcon, iconSmall, h)
	}
	if h := iconFromICO(ico, 32); h != 0 {
		procSendMessageW.Call(hwnd, wmSetIcon, iconBig, h)
	}
}

func iconFromICO(ico []byte, size int) uintptr {
	if len(ico) < 6 {
		return 0
	}
	count := int(binary.LittleEndian.Uint16(ico[4:6]))
	for i := 0; i < count; i++ {
		e := 6 + 16*i
		if e+16 > len(ico) {
			return 0
		}
		w := int(ico[e])
		if w == 0 {
			w = 256
		}
		if w != size {
			continue
		}
		n := binary.LittleEndian.Uint32(ico[e+8:])
		off := binary.LittleEndian.Uint32(ico[e+12:])
		if int(off+n) > len(ico) {
			return 0
		}
		img := ico[off : off+n]
		h, _, _ := procCreateIconFromResourceEx.Call(uintptr(unsafe.Pointer(&img[0])), uintptr(n), 1, 0x00030000, uintptr(size), uintptr(size), 0)
		return h
	}
	return 0
}

// BringToFront разворачивает окно и выводит его на передний план.
func BringToFront(hwnd uintptr) {
	const swRestore = 9
	procShowWindow.Call(hwnd, swRestore)
	procSetForegroundWindow.Call(hwnd)
}
