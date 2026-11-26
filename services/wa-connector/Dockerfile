FROM golang:1.27-alpine AS build
WORKDIR /src
COPY go.mod go.sum ./
RUN go mod download
COPY *.go ./
RUN CGO_ENABLED=0 go build -trimpath -ldflags="-s -w" -o /wa-connector .

FROM gcr.io/distroless/static-debian12:nonroot
COPY --from=build /wa-connector /wa-connector
EXPOSE 8090
ENTRYPOINT ["/wa-connector"]
