.PHONY: build test vet run

build:
	go build -o bin/honk ./cmd/honk

test:
	go test -race ./...

vet:
	go vet ./...

# Local run without push credentials: pushes are logged and skipped.
run:
	HONK_DB=./data/honk.db go run ./cmd/honk
