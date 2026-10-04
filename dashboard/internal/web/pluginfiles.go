package web

import (
	"encoding/json"
	"errors"
	"io"
	"mime"
	"net/http"
	"regexp"
	"strconv"

	"github.com/Kljub/BothubV3/dashboard/internal/api"
)

// Files of a plugin (plugin_files): uploaded for "image" settings fields and
// "file" fields with accept "audio" (modsettings.js posts the file, the
// hidden field gets its name), shown as previews or players. The API checks
// type and size; the name is the content hash.

const (
	pluginFileMax  = 2 << 20
	pluginAudioMax = 8 << 20
)

var pluginFileName = regexp.MustCompile(`^[0-9a-f]{16}\.(png|gif|webp|jpg|mp3|ogg|wav|webm)$`)

var pluginFileTypes = map[string]bool{"image/png": true, "image/gif": true, "image/webp": true, "image/jpeg": true,
	"audio/mpeg": true, "audio/ogg": true, "audio/wav": true, "audio/webm": true}

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
	accept, limit := "image", int64(pluginFileMax)
	if r.URL.Query().Get("accept") == "audio" {
		accept, limit = "audio", pluginAudioMax
	}
	r.Body = http.MaxBytesReader(w, r.Body, limit+64<<10)
	file, header, err := r.FormFile("file")
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
	data, err := io.ReadAll(io.LimitReader(file, limit+1))
	if err != nil || int64(len(data)) > limit {
		reply(http.StatusRequestEntityTooLarge, map[string]string{"error": s.i18n.T(p.Locale, "error.files.too_big")})
		return
	}
	// The CSRF token comes as header (fetch); session() reads it.
	f, err := s.api.UploadPluginFile(r.Context(), session(r), id, plugin, data, accept, header.Filename)
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
	h.Set("Content-Security-Policy", "default-src 'none'; media-src 'self'")
	// The name is the content hash: the same name is always the same picture.
	h.Set("Cache-Control", "private, max-age=86400, immutable")
	_, _ = w.Write(data)
}

var pluginDownloadName = regexp.MustCompile(`^[0-9a-f]{16}\.[a-z0-9]{1,8}$`)

// handlePluginDownload sends one file of a plugin as a download (backups,
// documents), never shown inline, under its original name.
func (s *Server) handlePluginDownload(w http.ResponseWriter, r *http.Request, p Page) {
	id, err := strconv.ParseInt(r.PathValue("id"), 10, 64)
	name := r.PathValue("name")
	if err != nil || id < 1 || !pluginDownloadName.MatchString(name) {
		http.NotFound(w, r)
		return
	}
	f, err := s.api.PluginFileDownload(r.Context(), session(r), id, r.PathValue("plugin"), name)
	if err != nil {
		http.NotFound(w, r)
		return
	}
	filename := f.Filename
	if filename == "" {
		filename = name
	}
	h := w.Header()
	h.Set("Content-Type", "application/octet-stream")
	h.Set("X-Content-Type-Options", "nosniff")
	h.Set("Content-Security-Policy", "default-src 'none'")
	h.Set("Cache-Control", "private, no-store")
	h.Set("Content-Disposition", mime.FormatMediaType("attachment", map[string]string{"filename": filename}))
	_, _ = w.Write(f.Data)
}
