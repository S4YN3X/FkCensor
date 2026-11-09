BINARY = F_ckCensor.exe
GO = go

.PHONY: build run clean tidy icon

# Только Windows: окно на WebView2, патч рассчитан на Windows-версию клиента.
# -H=windowsgui убирает консольное окно при запуске.
build:
	GOOS=windows GOARCH=amd64 $(GO) build -ldflags "-H=windowsgui -s -w" -o $(BINARY) ./cmd/F_ckCensor

# Значок exe: go build сам подхватывает .syso из папки пакета.
# Пересобирать только при смене assets/icon_black.ico (нужен windres из MinGW).
icon:
	cd cmd/F_ckCensor && windres -O coff -F pe-x86-64 -i F_ckCensor.rc -o rsrc_windows_amd64.syso

run:
	$(GO) run ./cmd/F_ckCensor

tidy:
	$(GO) mod tidy

clean:
	rm -f $(BINARY)
