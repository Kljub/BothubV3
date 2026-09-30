package web

import (
	"encoding/json"
	"log/slog"
	"os"
	"path/filepath"
	"sync"
)

// variableCatalog is shared/variables.json (placeholders of the variable
// picker), read once. Missing or broken: an empty catalog, the picker then
// shows only Data Storage and the command's own variables.
var variableCatalog = sync.OnceValue(func() json.RawMessage {
	dir := os.Getenv("SHARED_DIR")
	if dir == "" {
		dir = "/shared"
	}
	raw, err := os.ReadFile(filepath.Join(dir, "variables.json"))
	if err != nil || !json.Valid(raw) {
		slog.Warn("variable catalog not loaded", "err", err)
		return json.RawMessage(`{"categories":[]}`)
	}
	return raw
})
