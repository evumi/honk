# syntax=docker/dockerfile:1

# Pure Go (modernc SQLite), so cross-compiling needs no cgo.
FROM --platform=$BUILDPLATFORM golang:1.26-alpine AS build
ARG TARGETOS TARGETARCH
ARG VERSION=dev
WORKDIR /src
COPY go.mod go.sum ./
RUN go mod download
COPY . .
RUN CGO_ENABLED=0 GOOS=$TARGETOS GOARCH=$TARGETARCH \
    go build -trimpath -ldflags "-s -w -X main.version=$VERSION" -o /out/honk ./cmd/honk

FROM alpine:3.22
RUN apk add --no-cache ca-certificates tzdata \
 && adduser -D -H -u 10001 honk \
 && mkdir -p /data && chown honk:honk /data
COPY --from=build /out/honk /usr/local/bin/honk
USER honk
# /data holds the SQLite database. Mount the APNs .p8 key and the FCM service
# account JSON read-only and point HONK_APNS_KEY_FILE / HONK_FCM_CREDENTIALS_FILE at them.
ENV HONK_ADDR=:8080 HONK_DB=/data/honk.db
VOLUME /data
EXPOSE 8080
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s \
  CMD wget -q -T 5 -O /dev/null http://127.0.0.1:8080/healthz || exit 1
ENTRYPOINT ["/usr/local/bin/honk"]
