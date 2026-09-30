# Build context: repository root
# APP selects the binary: dashboard (default) or mockapi (development only).
FROM golang:1.27-alpine AS build
WORKDIR /src
COPY dashboard/go.mod dashboard/go.sum ./
RUN go mod download
COPY dashboard/ ./
# Tests read shared/ (node definitions, presets); /src/../shared = /shared.
COPY shared/ /shared/
ENV SHARED_DIR=/shared
RUN go test ./... \
 && CGO_ENABLED=0 go build -trimpath -ldflags="-s -w" -o /out/dashboard ./cmd/dashboard \
 && CGO_ENABLED=0 go build -trimpath -ldflags="-s -w" -o /out/mockapi ./cmd/mockapi

FROM alpine:3
ARG APP=dashboard
RUN adduser -D -H bothub
COPY --from=build /out/${APP} /usr/local/bin/app
COPY shared/ /shared/
ENV SHARED_DIR=/shared
USER bothub
ENTRYPOINT ["/usr/local/bin/app"]
