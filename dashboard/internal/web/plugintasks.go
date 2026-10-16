package web

import (
	"net/http"
	"regexp"
	"strconv"
	"time"

	"github.com/Kljub/BothubV3/dashboard/internal/api"
)

var pluginIDRe = regexp.MustCompile(`^[a-z0-9_-]{2,64}$`)

// Task manager (Settings → Task manager): every plugin process of every bot
// the user may see. State, CPU, memory and SDK calls come from each bot
// every 5 s (the tab polls while it is open); a state change arrives live.
// "End task" kills a process, "Restart" starts a new one.

// pluginTasksView: the tasks of one bot.
type pluginTasksView struct {
	Bot api.Bot
	api.PluginTasks
}

// allTasksView: the tab, one block per bot (bots without plugins left out).
type allTasksView struct {
	Bots  []pluginTasksView
	Error string
}

func (s *Server) handleAllTasks(w http.ResponseWriter, r *http.Request, p Page) {
	s.renderAllTasks(w, r, p, "")
}

func (s *Server) renderAllTasks(w http.ResponseWriter, r *http.Request, p Page, errKey string) {
	bots, err := s.api.ListBots(r.Context(), session(r))
	if err != nil {
		s.failTo(w, r, p, err, "#account-flash")
		return
	}
	v := allTasksView{Error: errKey}
	for _, b := range bots {
		tasks, err := s.api.PluginTasks(r.Context(), session(r), b.ID)
		if err != nil || (len(tasks.Tasks) == 0 && !tasks.Running) {
			continue
		}
		v.Bots = append(v.Bots, pluginTasksView{Bot: b, PluginTasks: tasks})
	}
	s.render(w, http.StatusOK, "error", "all_tasks_fragment", withData(p, v))
}

// handleAllTaskAction: "End task" or "Restart" of one plugin of one bot. The
// bot does it within a moment; the tab is drawn again after the job is done.
func (s *Server) handleAllTaskAction(w http.ResponseWriter, r *http.Request, p Page) {
	id, err := strconv.ParseInt(r.PathValue("id"), 10, 64)
	plugin, action := r.PathValue("plugin"), r.PathValue("action")
	if err != nil || id < 1 || !pluginIDRe.MatchString(plugin) || (action != "kill" && action != "restart") {
		s.fail(w, r, p, &api.Error{Status: http.StatusNotFound, Key: "error.not_found"})
		return
	}
	job, err := s.api.PluginTaskAction(r.Context(), session(r), id, plugin, action)
	if err != nil {
		s.failTo(w, r, p, err, "#account-flash")
		return
	}
	errKey := ""
	if job = s.waitJob(r, job, 5*time.Second); job.Status == "failed" && job.ErrorKey != nil {
		errKey = *job.ErrorKey
	}
	s.renderAllTasks(w, r, p, errKey)
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
