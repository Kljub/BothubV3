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

// allTasksView: the tab, one block per bot (bots without plugins left out),
// or only the bot picked in the drop-down (Selected; 0 = all bots).
type allTasksView struct {
	Bots     []pluginTasksView
	Error    string
	Selected int64
	// Choices: every bot of the user for the drop-down (panel only).
	Choices []api.Bot
}

func (s *Server) handleAllTasks(w http.ResponseWriter, r *http.Request, p Page) {
	s.renderAllTasks(w, r, p, "")
}

// handleTasksPanel: the tab's head (title, bot drop-down) and the list,
// loaded once when the tab opens; the list then refreshes on its own.
func (s *Server) handleTasksPanel(w http.ResponseWriter, r *http.Request, p Page) {
	v, err := s.allTasks(r, "")
	if err != nil {
		s.failTo(w, r, p, err, "#account-flash")
		return
	}
	s.render(w, http.StatusOK, "error", "tasks_panel_fragment", withData(p, v))
}

func (s *Server) renderAllTasks(w http.ResponseWriter, r *http.Request, p Page, errKey string) {
	v, err := s.allTasks(r, errKey)
	if err != nil {
		s.failTo(w, r, p, err, "#account-flash")
		return
	}
	s.render(w, http.StatusOK, "error", "all_tasks_fragment", withData(p, v))
}

func (s *Server) allTasks(r *http.Request, errKey string) (allTasksView, error) {
	bots, err := s.api.ListBots(r.Context(), session(r))
	if err != nil {
		return allTasksView{}, err
	}
	v := allTasksView{Error: errKey, Choices: bots}
	if id, _ := strconv.ParseInt(r.FormValue("bot"), 10, 64); id > 0 {
		for _, b := range bots {
			if b.ID == id {
				v.Selected = id
			}
		}
	}
	for _, b := range bots {
		if v.Selected != 0 && b.ID != v.Selected {
			continue
		}
		tasks, err := s.api.PluginTasks(r.Context(), session(r), b.ID)
		// All bots: only those with plugins; one picked bot is always shown.
		if err != nil || (v.Selected == 0 && len(tasks.Tasks) == 0 && !tasks.Running) {
			continue
		}
		v.Bots = append(v.Bots, pluginTasksView{Bot: b, PluginTasks: tasks})
	}
	return v, nil
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
