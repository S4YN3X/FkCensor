BINARY = FkCensor.exe
GO = go

.PHONY: build run clean tidy

# Только Windows: окно на WebView2, патч рассчитан на Windows-версию клиента.
# -H=windowsgui убирает консольное окно при запуске.
build:
	GOOS=windows GOARCH=amd64 $(GO) build -ldflags "-H=windowsgui -s -w" -o $(BINARY) ./cmd/FkCensor

run:
	$(GO) run ./cmd/FkCensor

tidy:
	$(GO) mod tidy

clean:
	rm -f $(BINARY)
