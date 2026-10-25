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
	"strings"
	"time"
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
	return splitASAR(data)
}

func splitASAR(data []byte) (headerJSON []byte, fileData []byte, err error) {
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

// State описывает, что сейчас лежит в app.asar.
type State int

const (
	NotPatched State = iota
	Outdated         // стоит наш патч, но старой версии скрипта
	Patched
	Broken // контрольная сумма asar не совпадает с записанной в exe — клиент не запустится
)

// Inspect проверяет asar: есть ли патч, совпадает ли он с текущим скриптом
// и сходится ли контрольная сумма с той, что записана в exe.
func Inspect(asarPath, exePath, injectScript string) (State, error) {
	headerJSON, fileData, err := readASAR(asarPath)
	if err != nil {
		return NotPatched, err
	}
	st := NotPatched
	switch {
	case bytes.Contains(fileData, []byte(injectScript)):
		st = Patched
	case bytes.Contains(fileData, []byte(patchMarker)):
		st = Outdated
	}
	if exe, err := os.ReadFile(exePath); err == nil && !bytes.Contains(exe, []byte(hashHeader(headerJSON))) {
		// Считаем установку повреждённой, только если в exe лежит одна из известных нам сумм:
		// у клиента без проверки целостности суммы в exe нет вовсе.
		for _, h := range knownHashes(asarPath) {
			if bytes.Contains(exe, []byte(h)) {
				return Broken, nil
			}
		}
	}
	return st, nil
}

// knownHashes — суммы исходного asar (из кэша и бэкапа), которые могли остаться в exe.
func knownHashes(asarPath string) []string {
	var hs []string
	if c, err := os.ReadFile(hashCachePath); err == nil && len(c) > 0 {
		hs = append(hs, string(c))
	}
	if h, _, err := readASAR(asarPath + ".bak"); err == nil {
		hs = append(hs, hashHeader(h))
	}
	return hs
}

// AppVersion читает версию клиента из package.json внутри asar.
func AppVersion(asarPath string) string {
	headerJSON, fileData, err := readASAR(asarPath)
	if err != nil {
		return ""
	}
	pkgContent, err := findFileContent(headerJSON, fileData, "package.json")
	if err != nil {
		return ""
	}
	var pkg struct {
		Version string `json:"version"`
	}
	_ = json.Unmarshal(pkgContent, &pkg)
	return pkg.Version
}

// Patch ставит патч из любого состояния: на чистый asar, поверх старой версии скрипта
// или поверх повреждённой установки. Патч собирается из исходного asar (сам файл
// или бэкап), а контрольная сумма в exe меняется одной записью. Если exe записать
// не удалось, asar возвращается к прежнему содержимому — клиент продолжит запускаться.
func Patch(asarPath, exePath, injectScript string) error {
	current, err := os.ReadFile(asarPath)
	if err != nil {
		return fmt.Errorf("read asar: %w", err)
	}
	curHeader, curData, err := splitASAR(current)
	if err != nil {
		return fmt.Errorf("read asar: %w", err)
	}

	original := current
	if bytes.Contains(curData, []byte(patchMarker)) {
		if original, err = os.ReadFile(asarPath + ".bak"); err != nil {
			return fmt.Errorf("бэкап исходного asar не найден: %w", err)
		}
	} else if err := writeFileRetry(asarPath+".bak", current); err != nil {
		// Бэкап обновляем при каждой установке на чистый asar: после обновления клиента
		// старый бэкап относится к другой версии и восстанавливать его нельзя.
		return fmt.Errorf("backup: %w", err)
	}
	headerJSON, fileData, err := splitASAR(original)
	if err != nil {
		return fmt.Errorf("read backup: %w", err)
	}
	if bytes.Contains(fileData, []byte(patchMarker)) {
		return fmt.Errorf("в бэкапе тоже стоит патч — переустановите яндекс музыку")
	}

	// Находим главный файл через package.json
	mainFile := findMainFile(headerJSON, fileData)
	fmt.Printf("[asarpatch] Patching: %s\n", mainFile)

	origContent, err := findFileContent(headerJSON, fileData, mainFile)
	if err != nil {
		return fmt.Errorf("find %s: %w", mainFile, err)
	}

	// Inject ПОСЛЕ оригинала (import'ы должны быть в начале)
	newContent := append(
		append([]byte(nil), origContent...),
		[]byte("\n"+injectScript+"\n")...,
	)

	newHeaderJSON, newFileData, err := patchFile(headerJSON, fileData, mainFile, newContent)
	if err != nil {
		return fmt.Errorf("patch file: %w", err)
	}
	newHash := hashHeader(newHeaderJSON)
	origHash := hashHeader(headerJSON)

	if err := writeFileRetry(asarPath, writeASAR(newHeaderJSON, newFileData)); err != nil {
		return fmt.Errorf("write asar: %w", err)
	}
	candidates := append([]string{hashHeader(curHeader), origHash}, knownHashes(asarPath)...)
	if err := replaceHashInExe(exePath, candidates, newHash); err != nil {
		_ = writeFileRetry(asarPath, current)
		return fmt.Errorf("запись контрольной суммы в exe: %w", err)
	}

	os.MkdirAll(filepath.Dir(hashCachePath), 0755)
	os.WriteFile(hashCachePath, []byte(origHash), 0644)
	fmt.Printf("[asarpatch] ASAR patch installed ✓ (main: %s)\n", mainFile)
	return nil
}

// Unpatch восстанавливает asar из бэкапа и возвращает исходную сумму в exe.
func Unpatch(asarPath, exePath string) error {
	current, err := os.ReadFile(asarPath)
	if err != nil {
		return fmt.Errorf("read asar: %w", err)
	}
	curHeader, _, err := splitASAR(current)
	if err != nil {
		return fmt.Errorf("read asar: %w", err)
	}
	backup, err := os.ReadFile(asarPath + ".bak")
	if err != nil {
		return fmt.Errorf("backup not found: %w", err)
	}
	bakHeader, bakData, err := splitASAR(backup)
	if err != nil {
		return fmt.Errorf("read backup: %w", err)
	}
	if bytes.Contains(bakData, []byte(patchMarker)) {
		return fmt.Errorf("в бэкапе тоже стоит патч — переустановите яндекс музыку")
	}

	if err := writeFileRetry(asarPath, backup); err != nil {
		return fmt.Errorf("restore asar: %w", err)
	}
	if err := replaceHashInExe(exePath, []string{hashHeader(curHeader)}, hashHeader(bakHeader)); err != nil {
		_ = writeFileRetry(asarPath, current)
		return fmt.Errorf("запись контрольной суммы в exe: %w", err)
	}

	os.Remove(hashCachePath)
	fmt.Println("[asarpatch] ASAR patch removed ✓")
	return nil
}

// replaceHashInExe заменяет в exe первую найденную из candidates сумму на newHash.
// Если в exe уже стоит newHash, ничего не делает.
func replaceHashInExe(exePath string, candidates []string, newHash string) error {
	data, err := os.ReadFile(exePath)
	if err != nil {
		return fmt.Errorf("read exe: %w", err)
	}
	newBuf := []byte(newHash)
	for _, old := range candidates {
		if old == "" || old == newHash || !bytes.Contains(data, []byte(old)) {
			continue
		}
		count := bytes.Count(data, []byte(old))
		data = bytes.ReplaceAll(data, []byte(old), newBuf)
		if err := writeFileRetry(exePath, data); err != nil {
			return fmt.Errorf("write exe: %w", err)
		}
		fmt.Printf("[asarpatch] Replaced %d hash occurrences in exe ✓\n", count)
		return nil
	}
	if bytes.Contains(data, newBuf) {
		return nil
	}
	return fmt.Errorf("контрольная сумма asar не найдена в exe")
}

// writeFileRetry пишет файл, повторяя попытки несколько секунд: только что изменённый
// exe или asar может ненадолго держать антивирус или сама система.
func writeFileRetry(path string, data []byte) error {
	var err error
	for i := 0; i < 20; i++ {
		if err = os.WriteFile(path, data, 0644); err == nil {
			return nil
		}
		time.Sleep(250 * time.Millisecond)
	}
	return err
}

func min(a, b int) int {
	if a < b {
		return a
	}
	return b
}
