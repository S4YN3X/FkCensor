package asarpatch

import (
	"bytes"
	"crypto/sha256"
	"encoding/binary"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"runtime"
	"strings"
)

const patchMarker = "/* FkCensor patched */"

func hashHeader(headerJSON []byte) string {
	h := sha256.Sum256(headerJSON)
	return hex.EncodeToString(h[:])
}

func readASAR(path string) (headerJSON []byte, fileData []byte, err error) {
	data, err := os.ReadFile(path)
	if err != nil {
		return nil, nil, err
	}
	if len(data) < 16 {
		return nil, nil, fmt.Errorf("file too small")
	}
	jsonSize := binary.LittleEndian.Uint32(data[12:16])
	paddedSize := (jsonSize + 3) &^ 3
	if int(16+paddedSize) > len(data) {
		return nil, nil, fmt.Errorf("invalid header size")
	}
	return data[16 : 16+jsonSize], data[16+paddedSize:], nil
}

func writeASAR(headerJSON, fileData []byte) []byte {
	jsonSize := uint32(len(headerJSON))
	paddedSize := (jsonSize + 3) &^ 3
	innerPickle := paddedSize + 4
	outerPickle := innerPickle + 4

	var buf bytes.Buffer
	binary.Write(&buf, binary.LittleEndian, uint32(4))
	binary.Write(&buf, binary.LittleEndian, outerPickle)
	binary.Write(&buf, binary.LittleEndian, innerPickle)
	binary.Write(&buf, binary.LittleEndian, jsonSize)
	buf.Write(headerJSON)
	for i := uint32(0); i < paddedSize-jsonSize; i++ {
		buf.WriteByte(0)
	}
	buf.Write(fileData)
	return buf.Bytes()
}

func DebugListRootFiles(asarPath string) {
	headerJSON, fileData, err := readASAR(asarPath)
	if err != nil {
		fmt.Println("read error:", err)
		return
	}
	_ = fileData

	type entry struct {
		Size  *int                       `json:"size"`
		Files map[string]json.RawMessage `json:"files"`
	}
	var root entry
	json.Unmarshal(headerJSON, &root)

	fmt.Println("[asarpatch] Root files:")
	for name := range root.Files {
		fmt.Println(" -", name)
	}
}

func updateJSONOffsets(headerJSON []byte, targetOffset string, delta int, newSize int, newContent []byte) ([]byte, error) {
	var targetOff int
	fmt.Sscanf(targetOffset, "%d", &targetOff)

	var tree interface{}
	if err := json.Unmarshal(headerJSON, &tree); err != nil {
		return nil, err
	}

	var walk func(v interface{})
	walk = func(v interface{}) {
		m, ok := v.(map[string]interface{})
		if !ok {
			return
		}
		if offsetStr, ok := m["offset"].(string); ok {
			var off int
			fmt.Sscanf(offsetStr, "%d", &off)
			if off == targetOff {
				m["size"] = newSize
				// Обновляем integrity вместо удаления
				m["integrity"] = computeFileIntegrity(newContent)
			} else if off > targetOff {
				m["offset"] = fmt.Sprintf("%d", off+delta)
			}
		}
		for _, val := range m {
			walk(val)
		}
	}
	walk(tree)

	return json.Marshal(tree)
}
func computeFileIntegrity(content []byte) map[string]interface{} {
	const blockSize = 4 * 1024 * 1024 // 4MB — стандартный размер блока ASAR

	h := sha256.Sum256(content)
	overallHash := hex.EncodeToString(h[:])

	var blocks []string
	for i := 0; i < len(content); i += blockSize {
		end := i + blockSize
		if end > len(content) {
			end = len(content)
		}
		bh := sha256.Sum256(content[i:end])
		blocks = append(blocks, hex.EncodeToString(bh[:]))
	}

	return map[string]interface{}{
		"algorithm": "SHA256",
		"hash":      overallHash,
		"blockSize": blockSize,
		"blocks":    blocks,
	}
}

// findFileByPath навигирует по дереву ASAR по полному пути (например "main/index.js")
func findFileByPath(headerJSON []byte, targetPath string) (offset int, size int, foundPath string, err error) {
	parts := strings.Split(strings.TrimPrefix(targetPath, "./"), "/")

	type entry struct {
		Size   *int                       `json:"size"`
		Offset string                     `json:"offset"`
		Files  map[string]json.RawMessage `json:"files"`
	}

	var root entry
	if err := json.Unmarshal(headerJSON, &root); err != nil {
		return 0, 0, "", err
	}

	current := root.Files
	for i, part := range parts {
		raw, ok := current[part]
		if !ok {
			return 0, 0, "", fmt.Errorf("path component %q not found in asar", part)
		}
		var e entry
		if err := json.Unmarshal(raw, &e); err != nil {
			return 0, 0, "", err
		}
		if i == len(parts)-1 {
			if e.Size == nil {
				return 0, 0, "", fmt.Errorf("%q is a directory", targetPath)
			}
			fmt.Sscanf(e.Offset, "%d", &offset)
			return offset, *e.Size, targetPath, nil
		}
		if e.Files == nil {
			return 0, 0, "", fmt.Errorf("%q has no children", part)
		}
		current = e.Files
	}
	return 0, 0, "", fmt.Errorf("empty path")
}

func findMainFile(headerJSON, fileData []byte) string {
	// Читаем package.json и берём main ПОЛНОСТЬЮ без filepath.Base
	pkgContent, err := findFileContent(headerJSON, fileData, "package.json")
	if err == nil {
		var pkg struct {
			Main string `json:"main"`
		}
		if json.Unmarshal(pkgContent, &pkg) == nil && pkg.Main != "" {
			main := strings.TrimPrefix(pkg.Main, "./")
			// Проверяем что файл реально существует в ASAR
			if _, _, _, err := findFileByPath(headerJSON, main); err == nil {
				fmt.Printf("[asarpatch] Found main via package.json: %s\n", main)
				return main
			}
		}
	}

	// Fallback: ищем среди корневых JS файлов
	type entry struct {
		Size  *int                       `json:"size"`
		Files map[string]json.RawMessage `json:"files"`
	}
	var root entry
	json.Unmarshal(headerJSON, &root)
	for name, raw := range root.Files {
		if !strings.HasSuffix(name, ".js") {
			continue
		}
		var e entry
		json.Unmarshal(raw, &e)
		if e.Size != nil {
			fmt.Printf("[asarpatch] Fallback main: %s\n", name)
			return name
		}
	}
	return "index.js"
}

func findFileContent(headerJSON, fileData []byte, targetPath string) ([]byte, error) {
	offset, size, _, err := findFileByPath(headerJSON, targetPath)
	if err != nil {
		// Fallback: поиск по суффиксу (для обратной совместимости)
		return findFileContentBySuffix(headerJSON, fileData, targetPath)
	}
	if offset+size > len(fileData) {
		return nil, fmt.Errorf("invalid offset %d+%d > %d", offset, size, len(fileData))
	}
	return fileData[offset : offset+size], nil
}

// findFileContentBySuffix — старый метод поиска по имени файла
func findFileContentBySuffix(headerJSON, fileData []byte, targetSuffix string) ([]byte, error) {
	type entry struct {
		Size   *int                       `json:"size"`
		Offset string                     `json:"offset"`
		Files  map[string]json.RawMessage `json:"files"`
	}

	var found *entry
	var findEntry func(files map[string]json.RawMessage) bool
	findEntry = func(files map[string]json.RawMessage) bool {
		for name, raw := range files {
			var e entry
			if err := json.Unmarshal(raw, &e); err != nil {
				continue
			}
			if strings.HasSuffix(name, targetSuffix) && e.Size != nil {
				found = &e
				return true
			}
			if e.Files != nil {
				if findEntry(e.Files) {
					return true
				}
			}
		}
		return false
	}

	var root entry
	if err := json.Unmarshal(headerJSON, &root); err != nil {
		return nil, err
	}
	if !findEntry(root.Files) {
		return nil, fmt.Errorf("%q not found", targetSuffix)
	}

	var offset int
	fmt.Sscanf(found.Offset, "%d", &offset)
	size := *found.Size
	if offset+size > len(fileData) {
		return nil, fmt.Errorf("invalid offset")
	}
	return fileData[offset : offset+size], nil
}

func patchFile(headerJSON []byte, fileData []byte, targetPath string, newContent []byte) ([]byte, []byte, error) {
	offset, oldSize, _, err := findFileByPath(headerJSON, targetPath)
	if err != nil {
		return nil, nil, fmt.Errorf("find %q: %w", targetPath, err)
	}

	if offset+oldSize > len(fileData) {
		return nil, nil, fmt.Errorf("invalid offset/size")
	}

	newFileData := make([]byte, 0, len(fileData)-oldSize+len(newContent))
	newFileData = append(newFileData, fileData[:offset]...)
	newFileData = append(newFileData, newContent...)
	newFileData = append(newFileData, fileData[offset+oldSize:]...)

	delta := len(newContent) - oldSize
	newHeaderJSON, err := updateJSONOffsets(headerJSON, fmt.Sprintf("%d", offset), delta, len(newContent), newContent)
	if err != nil {
		return nil, nil, fmt.Errorf("update header: %w", err)
	}

	return newHeaderJSON, newFileData, nil
}

var hashCachePath = filepath.Join(os.Getenv("LOCALAPPDATA"), "FkCensor", "original_hash.txt")

func ASARPath() (string, error) {
	switch runtime.GOOS {
	case "windows":
		base := os.Getenv("LOCALAPPDATA")
		candidates := []string{
			filepath.Join(base, "Programs", "YandexMusic", "resources", "app.asar"),
			filepath.Join(base, "Programs", "Яндекс Музыка", "resources", "app.asar"),
			filepath.Join(base, "Programs", "Yandex Music", "resources", "app.asar"),
		}
		for _, c := range candidates {
			if _, err := os.Stat(c); err == nil {
				return c, nil
			}
		}
		programsDir := filepath.Join(base, "Programs")
		entries, _ := os.ReadDir(programsDir)
		for _, e := range entries {
			if !e.IsDir() {
				continue
			}
			n := strings.ToLower(e.Name())
			if strings.Contains(n, "yandex") || strings.Contains(n, "яндекс") {
				c := filepath.Join(programsDir, e.Name(), "resources", "app.asar")
				if _, err := os.Stat(c); err == nil {
					return c, nil
				}
			}
		}
		return "", fmt.Errorf("app.asar not found in %s", programsDir)
	case "darwin":
		for _, c := range []string{
			"/Applications/Яндекс Музыка.app/Contents/Resources/app.asar",
			"/Applications/Yandex Music.app/Contents/Resources/app.asar",
		} {
			if _, err := os.Stat(c); err == nil {
				return c, nil
			}
		}
		return "", fmt.Errorf("app.asar not found")
	default:
		for _, c := range []string{
			"/opt/YandexMusic/resources/app.asar",
			"/opt/Яндекс Музыка/resources/app.asar",
			"/usr/share/yandex-music/resources/app.asar",
		} {
			if _, err := os.Stat(c); err == nil {
				return c, nil
			}
		}
		return "", fmt.Errorf("app.asar not found")
	}
}

func IsPatched() bool {
	asarPath, err := ASARPath()
	if err != nil {
		return false
	}
	_, fileData, err := readASAR(asarPath)
	if err != nil {
		return false
	}
	return bytes.Contains(fileData, []byte(patchMarker))
}

func Patch(injectScript string) error {
	asarPath, err := ASARPath()
	if err != nil {
		return fmt.Errorf("find asar: %w", err)
	}

	backupPath := asarPath + ".bak"
	if _, err := os.Stat(backupPath); os.IsNotExist(err) {
		if err := copyFile(asarPath, backupPath); err != nil {
			return fmt.Errorf("backup: %w", err)
		}
	}

	headerJSON, fileData, err := readASAR(asarPath)
	if err != nil {
		return fmt.Errorf("read asar: %w", err)
	}
	if bytes.Contains(fileData, []byte(patchMarker)) {
		return nil // уже пропатчен
	}

	oldHash := hashHeader(headerJSON)
	os.MkdirAll(filepath.Dir(hashCachePath), 0755)
	os.WriteFile(hashCachePath, []byte(oldHash), 0644)

	// Находим главный файл через package.json
	mainFile := findMainFile(headerJSON, fileData)
	fmt.Printf("[asarpatch] Patching: %s\n", mainFile)

	// Также выведи первые 200 байт оригинала для проверки
	origContent, err := findFileContent(headerJSON, fileData, mainFile)
	if err != nil {
		return fmt.Errorf("find %s: %w", mainFile, err)
	}
	fmt.Printf("[asarpatch] First 200 chars:\n%s\n", string(origContent[:min(200, len(origContent))]))

	// Inject ПОСЛЕ оригинала (import'ы должны быть в начале)
	newContent := append(
		append([]byte(nil), origContent...),
		[]byte("\n"+injectScript+"\n")...,
	)

	newHeaderJSON, newFileData, err := patchFile(headerJSON, fileData, mainFile, newContent)
	if err != nil {
		return fmt.Errorf("patch file: %w", err)
	}

	packed := writeASAR(newHeaderJSON, newFileData)

	if err := os.WriteFile(asarPath, packed, 0644); err != nil {
		return fmt.Errorf("write asar: %w", err)
	}

	newHash := hashHeader(newHeaderJSON)
	if runtime.GOOS == "windows" {
		if err := updateIntegrityInExe(oldHash, newHash); err != nil {
			fmt.Printf("[asarpatch] Warning: integrity update failed: %v\n", err)
		}
	}

	fmt.Printf("[asarpatch] ASAR patch installed ✓ (main: %s)\n", mainFile)
	return nil
}

func Unpatch() error {
	asarPath, err := ASARPath()
	if err != nil {
		return fmt.Errorf("find asar: %w", err)
	}
	backupPath := asarPath + ".bak"
	if _, err := os.Stat(backupPath); os.IsNotExist(err) {
		return fmt.Errorf("backup not found at %s", backupPath)
	}

	currentHeader, _, err := readASAR(asarPath)
	if err != nil {
		return fmt.Errorf("read current asar: %w", err)
	}
	currentHash := hashHeader(currentHeader)

	originalHashBytes, err := os.ReadFile(hashCachePath)
	if err != nil {
		backupHeader, _, berr := readASAR(backupPath)
		if berr != nil {
			return fmt.Errorf("cannot determine original hash: %w", berr)
		}
		originalHashBytes = []byte(hashHeader(backupHeader))
	}
	originalHash := string(originalHashBytes)

	if err := copyFile(backupPath, asarPath); err != nil {
		return err
	}

	if runtime.GOOS == "windows" && currentHash != originalHash {
		if err := updateIntegrityInExe(currentHash, originalHash); err != nil {
			fmt.Printf("[asarpatch] Warning: integrity restore failed: %v\n", err)
		}
	}

	os.Remove(hashCachePath)
	fmt.Println("[asarpatch] ASAR patch removed ✓")
	return nil
}

func updateIntegrityInExe(oldHash, newHash string) error {
	base := os.Getenv("LOCALAPPDATA")
	exePath := filepath.Join(base, "Programs", "YandexMusic", "Яндекс Музыка.exe")

	data, err := os.ReadFile(exePath)
	if err != nil {
		return fmt.Errorf("read exe: %w", err)
	}

	oldBuf := []byte(oldHash)
	newBuf := []byte(newHash)

	if !bytes.Contains(data, oldBuf) {
		return fmt.Errorf("old hash not found in exe")
	}

	count := bytes.Count(data, oldBuf)
	data = bytes.ReplaceAll(data, oldBuf, newBuf)

	if err := os.WriteFile(exePath, data, 0644); err != nil {
		return fmt.Errorf("write exe: %w", err)
	}

	fmt.Printf("[asarpatch] Replaced %d hash occurrences in exe ✓\n", count)
	return nil
}

func copyFile(src, dst string) error {
	data, err := os.ReadFile(src)
	if err != nil {
		return err
	}
	return os.WriteFile(dst, data, 0644)
}

func min(a, b int) int {
	if a < b {
		return a
	}
	return b
}
