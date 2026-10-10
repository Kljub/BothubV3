package web

import (
	"net/http"
	"regexp"
	"time"

	"github.com/Kljub/BothubV3/dashboard/internal/api"
)

var pluginIDRe = regexp.MustCompile(`^[a-z0-9_-]{2,64}$`)

// pluginTasksView: the task manager box on the bot's plugin page.
type pluginTasksView struct {
	BotID int64
	api.PluginTasks
}

// handlePluginTasks renders the task manager (polled every 5 s, and at once
// after a live update of a task's state).
func (s *Server) handlePluginTasks(w http.ResponseWriter, r *http.Request, p Page) {
	id, ok := s.botID(w, r, p)
	if !ok {
		return
	}
	s.renderPluginTasks(w, r, p, id)
}

func (s *Server) renderPluginTasks(w http.ResponseWriter, r *http.Request, p Page, id int64) {
	tasks, err := s.api.PluginTasks(r.Context(), session(r), id)
	if err != nil {
		s.fail(w, r, p, err)
		return
	}
	s.render(w, http.StatusOK, "bot", "plugin_tasks_fragment", withData(p, pluginTasksView{BotID: id, PluginTasks: tasks}))
}

// handlePluginTaskAction: "End task" or "Restart" of one plugin. The bot
// does it within a moment; the box is drawn again after the job is done.
func (s *Server) handlePluginTaskAction(w http.ResponseWriter, r *http.Request, p Page) {
	id, ok := s.botID(w, r, p)
	if !ok {
		return
	}
	plugin, action := r.PathValue("plugin"), r.PathValue("action")
	if !pluginIDRe.MatchString(plugin) || (action != "kill" && action != "restart") {
		s.fail(w, r, p, &api.Error{Status: http.StatusNotFound, Key: "error.not_found"})
		return
	}
	job, err := s.api.PluginTaskAction(r.Context(), session(r), id, plugin, action)
	if err != nil {
		s.fail(w, r, p, err)
		return
	}
	if job = s.waitJob(r, job, 5*time.Second); job.Status == "failed" && job.ErrorKey != nil {
		s.fail(w, r, p, &api.Error{Status: http.StatusConflict, Key: *job.ErrorKey})
		return
	}
	s.renderPluginTasks(w, r, p, id)
}

// waitJob waits up to max for a job of the bot and returns its last state.
func (s *Server) waitJob(r *http.Request, job api.Job, max time.Duration) api.Job {
	deadline := time.Now().Add(max)
	for job.ID != "" && job.Status == "queued" && time.Now().Before(deadline) {
		select {
		case <-r.Context().Done():
			return job
		case <-time.After(150 * time.Millisecond):
		}
		next, err := s.api.Job(r.Context(), session(r), job.ID)
		if err != nil {
			return job
		}
		job = next
	}
	return job
}
