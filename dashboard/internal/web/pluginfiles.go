package web

import (
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"regexp"
	"strconv"

	"github.com/Kljub/BothubV3/dashboard/internal/api"
)

// Images of a plugin (plugin_files): uploaded for "image" settings fields
// (modsettings.js posts the file, the hidden field gets its name) and shown
// as previews. The API checks type and size; the name is the content hash.

const pluginFileMax = 2 << 20

var pluginFileName = regexp.MustCompile(`^[0-9a-f]{16}\.(png|gif|webp|jpg)$`)

var pluginFileTypes = map[string]bool{"image/png": true, "image/gif": true, "image/webp": true, "image/jpeg": true}

// handlePluginFileUpload takes one image (multipart field "file") and
// answers {name, url} or {error}.
func (s *Server) handlePluginFileUpload(w http.ResponseWriter, r *http.Request, p Page) {
	reply := func(status int, body map[string]string) {
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(status)
		_ = json.NewEncoder(w).Encode(body)
	}
	id, err := strconv.ParseInt(r.PathValue("id"), 10, 64)
	if err != nil || id < 1 {
		reply(http.StatusNotFound, map[string]string{"error": s.i18n.T(p.Locale, "error.bot.not_found")})
		return
	}
	plugin := r.PathValue("plugin")
	r.Body = http.MaxBytesReader(w, r.Body, pluginFileMax+64<<10)
	file, _, err := r.FormFile("file")
	if err != nil {
		var tooBig *http.MaxBytesError
		key := "error.files.bad_type"
		if errors.As(err, &tooBig) {
			key = "error.files.too_big"
		}
		reply(http.StatusBadRequest, map[string]string{"error": s.i18n.T(p.Locale, key)})
		return
	}
	defer file.Close()
	data, err := io.ReadAll(io.LimitReader(file, pluginFileMax+1))
	if err != nil || len(data) > pluginFileMax {
		reply(http.StatusRequestEntityTooLarge, map[string]string{"error": s.i18n.T(p.Locale, "error.files.too_big")})
		return
	}
	// The CSRF token comes as header (fetch); session() reads it.
	f, err := s.api.UploadPluginFile(r.Context(), session(r), id, plugin, data)
	if err != nil {
		status := api.AsError(err).Status
		if status < 400 {
			status = http.StatusBadGateway
		}
		reply(status, map[string]string{"error": s.apiErrorText(p, err)})
		return
	}
	reply(http.StatusCreated, map[string]string{"name": f.Name, "url": r.URL.Path + "/" + f.Name})
}

// handlePluginFile serves one image of a plugin (previews on the settings page).
func (s *Server) handlePluginFile(w http.ResponseWriter, r *http.Request, p Page) {
	id, err := strconv.ParseInt(r.PathValue("id"), 10, 64)
	name := r.PathValue("name")
	if err != nil || id < 1 || !pluginFileName.MatchString(name) {
		http.NotFound(w, r)
		return
	}
	mime, data, err := s.api.PluginFileData(r.Context(), session(r), id, r.PathValue("plugin"), name)
	if err != nil || !pluginFileTypes[mime] {
		http.NotFound(w, r)
		return
	}
	h := w.Header()
	h.Set("Content-Type", mime)
	h.Set("X-Content-Type-Options", "nosniff")
	h.Set("Content-Security-Policy", "default-src 'none'")
	// The name is the content hash: the same name is always the same picture.
	h.Set("Cache-Control", "private, max-age=86400, immutable")
	_, _ = w.Write(data)
}
