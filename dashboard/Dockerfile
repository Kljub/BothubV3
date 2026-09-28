# Build context: repository root
FROM golang:1.27-alpine AS build
WORKDIR /src
COPY dashboard/go.mod ./
RUN go mod download
COPY dashboard/ ./
RUN CGO_ENABLED=0 go build -trimpath -ldflags="-s -w" -o /out/dashboard ./cmd/dashboard

FROM alpine:3
RUN adduser -D -H bothub
COPY --from=build /out/dashboard /usr/local/bin/dashboard
USER bothub
EXPOSE 8080
HEALTHCHECK --interval=10s --timeout=3s CMD wget -qO- http://127.0.0.1:8080/healthz || exit 1
ENTRYPOINT ["/usr/local/bin/dashboard"]
