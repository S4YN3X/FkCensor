BINARY = FkCensor
GO = go

.PHONY: build run clean tidy

build:
	$(GO) build -o $(BINARY) ./cmd/FkCensor

run:
	$(GO) run ./cmd/FkCensor

tidy:
	$(GO) mod tidy

clean:
	rm -f $(BINARY)

# Кросс-компиляция
build-all: build-windows build-linux build-darwin

build-windows:
	GOOS=windows GOARCH=amd64 $(GO) build -o $(BINARY)-windows.exe ./cmd/FkCensor

build-linux:
	GOOS=linux GOARCH=amd64 $(GO) build -o $(BINARY)-linux ./cmd/FkCensor

build-darwin:
	GOOS=darwin GOARCH=amd64 $(GO) build -o $(BINARY)-macos ./cmd/FkCensor
