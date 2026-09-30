package web

import (
	"net/http"
	"net/url"
	"slices"
	"strconv"
	"strings"

	"github.com/Kljub/BothubV3/dashboard/internal/api"
)

// Data Storage module page: variables the bot remembers between runs, and
// their stored values. Blocks and messages reference a variable as
// {var.<key>}.

var dataTypes = []string{"text", "number", "list", "object", "object_list"}

type dataTypeCount struct {
	Type  string
	Count int
}

type dataGroup struct {
	Name string
	Vars []api.DataVariable
}

// dataStorageView is the data for the "data_storage" templates.
type dataStorageView struct {
	BotID      int64
	Q, Type    string
	Total      int
	Unused     int
	TypeCounts []dataTypeCount
	Groups     []dataGroup
	Shown      int
}

// dataFormView is the data for the variable dialog.
type dataFormView struct {
	BotID  int64
	Var    api.DataVariable
	Edit   bool
	Groups []string
	Types  []string
}

// dataValuesView is the data for the values panel of one variable.
type dataValuesView struct {
	BotID       int64
	Var         api.DataVariable
	Q, Sort     string
	Page        api.DataValuePage
	Pages       int
	Prev, Next  int
	NeedServer  bool
	NeedOwner   bool
	OwnerIsUser bool
}

// dataLookupView is the result of "look up a member or channel".
type dataLookupView struct {
	BotID int64
	ID    string
	Items []api.DataValue
	Names map[int64]string
	Error bool
}

func (s *Server) dataStorageView(r *http.Request, botID int64) (dataStorageView, error) {
	vars, err := s.api.DataVariables(r.Context(), session(r), botID)
	if err != nil {
		return dataStorageView{}, err
	}
	q := strings.ToLower(strings.TrimSpace(r.URL.Query().Get("q")))
	typ := r.URL.Query().Get("type")
	if !slices.Contains(dataTypes, typ) {
		typ = ""
	}
	v := dataStorageView{BotID: botID, Q: q, Type: typ, Total: len(vars)}
	counts := map[string]int{}
	byGroup := map[string]int{}
	for _, x := range vars {
		counts[x.Type]++
		if x.UsedIn == 0 {
			v.Unused++
		}
		if typ != "" && x.Type != typ {
			continue
		}
		if q != "" && !strings.Contains(strings.ToLower(x.Name+" "+x.Key+" "+x.Group), q) {
			continue
		}
		i, ok := byGroup[x.Group]
		if !ok {
			i = len(v.Groups)
			byGroup[x.Group] = i
			v.Groups = append(v.Groups, dataGroup{Name: x.Group})
		}
		v.Groups[i].Vars = append(v.Groups[i].Vars, x)
		v.Shown++
	}
	// Named groups first, variables without a group last.
	slices.SortStableFunc(v.Groups, func(a, b dataGroup) int {
		switch {
		case a.Name == "" && b.Name != "":
			return 1
		case a.Name != "" && b.Name == "":
			return -1
		}
		return strings.Compare(strings.ToLower(a.Name), strings.ToLower(b.Name))
	})
	for _, t := range dataTypes {
		v.TypeCounts = append(v.TypeCounts, dataTypeCount{Type: t, Count: counts[t]})
	}
	return v, nil
}

func (s *Server) renderDataList(w http.ResponseWriter, r *http.Request, p Page, botID int64) {
	v, err := s.dataStorageView(r, botID)
	if err != nil {
		s.fail(w, r, p, err)
		return
	}
	s.render(w, http.StatusOK, "module_item", "data_storage_list_fragment", withData(p, v))
}

func (s *Server) handleDataList(w http.ResponseWriter, r *http.Request, p Page) {
	id, ok := s.botID(w, r, p)
	if !ok {
		return
	}
	s.renderDataList(w, r, p, id)
}

// findDataVar loads the variables and returns the one in the path.
func (s *Server) findDataVar(r *http.Request, botID int64) (api.DataVariable, []api.DataVariable, error) {
	vars, err := s.api.DataVariables(r.Context(), session(r), botID)
	if err != nil {
		return api.DataVariable{}, nil, err
	}
	vid, _ := strconv.ParseInt(r.PathValue("vid"), 10, 64)
	for _, v := range vars {
		if v.ID == vid {
			return v, vars, nil
		}
	}
	return api.DataVariable{}, vars, &api.Error{Status: http.StatusNotFound, Key: "error.data.unknown"}
}

// handleDataForm renders the new/edit dialog body.
func (s *Server) handleDataForm(w http.ResponseWriter, r *http.Request, p Page) {
	id, ok := s.botID(w, r, p)
	if !ok {
		return
	}
	view := dataFormView{BotID: id, Types: dataTypes, Var: api.DataVariable{Type: "text", Owner: "shared", PerServer: true}}
	var vars []api.DataVariable
	var err error
	if r.PathValue("vid") != "" {
		view.Edit = true
		view.Var, vars, err = s.findDataVar(r, id)
	} else {
		vars, err = s.api.DataVariables(r.Context(), session(r), id)
	}
	if err != nil {
		s.failTo(w, r, p, err, "#data-form-error")
		return
	}
	for _, v := range vars {
		if v.Group != "" && !slices.Contains(view.Groups, v.Group) {
			view.Groups = append(view.Groups, v.Group)
		}
	}
	slices.Sort(view.Groups)
	s.render(w, http.StatusOK, "module_item", "data_storage_form_fragment", withData(p, view))
}

func dataVarFromForm(r *http.Request) api.DataVariable {
	v := api.DataVariable{
		Key:          strings.TrimSpace(r.PostFormValue("key")),
		Name:         strings.TrimSpace(r.PostFormValue("name")),
		Description:  strings.TrimSpace(r.PostFormValue("description")),
		Type:         r.PostFormValue("type"),
		Owner:        r.PostFormValue("owner"),
		PerServer:    r.PostFormValue("per_server") == "true",
		DefaultValue: r.PostFormValue("default_value"),
		Group:        strings.TrimSpace(r.PostFormValue("group")),
	}
	// Channel IDs belong to one server anyway.
	if v.Owner == "channel" {
		v.PerServer = true
	}
	return v
}

func (s *Server) handleDataCreate(w http.ResponseWriter, r *http.Request, p Page) {
	id, ok := s.botID(w, r, p)
	if !ok {
		return
	}
	if _, err := s.api.CreateDataVariable(r.Context(), session(r), id, dataVarFromForm(r)); err != nil {
		s.failTo(w, r, p, err, "#data-form-error")
		return
	}
	w.Header().Set("HX-Trigger", "bothub:close-dialogs")
	s.renderDataList(w, r, p, id)
}

func (s *Server) handleDataUpdate(w http.ResponseWriter, r *http.Request, p Page) {
	id, ok := s.botID(w, r, p)
	if !ok {
		return
	}
	v := dataVarFromForm(r)
	v.ID, _ = strconv.ParseInt(r.PathValue("vid"), 10, 64)
	if _, err := s.api.UpdateDataVariable(r.Context(), session(r), id, v); err != nil {
		s.failTo(w, r, p, err, "#data-form-error")
		return
	}
	w.Header().Set("HX-Trigger", "bothub:close-dialogs")
	s.renderDataList(w, r, p, id)
}

func (s *Server) handleDataDelete(w http.ResponseWriter, r *http.Request, p Page) {
	id, ok := s.botID(w, r, p)
	if !ok {
		return
	}
	vid, _ := strconv.ParseInt(r.PathValue("vid"), 10, 64)
	if err := s.api.DeleteDataVariable(r.Context(), session(r), id, vid); err != nil {
		s.failTo(w, r, p, err, "#data-form-error")
		return
	}
	w.Header().Set("HX-Trigger", "bothub:close-dialogs")
	s.renderDataList(w, r, p, id)
}

// renderDataValues renders the values panel; q, sort and page come from the
// request (query for GET, form for the change requests).
func (s *Server) renderDataValues(w http.ResponseWriter, r *http.Request, p Page, botID int64, target string) {
	v, _, err := s.findDataVar(r, botID)
	if err != nil {
		s.failTo(w, r, p, err, target)
		return
	}
	q := strings.TrimSpace(r.FormValue("q"))
	sort := r.FormValue("sort")
	if sort != "value" {
		sort = "updated"
	}
	page, _ := strconv.Atoi(r.FormValue("page"))
	page = max(page, 1)
	res, err := s.api.DataValues(r.Context(), session(r), botID, v.ID, q, page, sort)
	if err != nil {
		s.failTo(w, r, p, err, target)
		return
	}
	pages := max(1, (res.Total+res.PageSize-1)/max(res.PageSize, 1))
	view := dataValuesView{
		BotID: botID, Var: v, Q: q, Sort: sort, Page: res, Pages: pages,
		Prev: max(res.Page-1, 1), Next: min(res.Page+1, pages),
		NeedServer: v.PerServer, NeedOwner: v.Owner != "shared", OwnerIsUser: v.Owner == "member",
	}
	s.render(w, http.StatusOK, "module_item", "data_storage_values_fragment", withData(p, view))
}

func valuesTarget(r *http.Request) string { return "#data-values-error-" + r.PathValue("vid") }

func (s *Server) handleDataValues(w http.ResponseWriter, r *http.Request, p Page) {
	id, ok := s.botID(w, r, p)
	if !ok {
		return
	}
	s.renderDataValues(w, r, p, id, valuesTarget(r))
}

func (s *Server) handleDataSetValue(w http.ResponseWriter, r *http.Request, p Page) {
	id, ok := s.botID(w, r, p)
	if !ok {
		return
	}
	vid, _ := strconv.ParseInt(r.PathValue("vid"), 10, 64)
	v := api.DataValue{ServerID: strings.TrimSpace(r.PostFormValue("server_id")), OwnerID: strings.TrimSpace(r.PostFormValue("owner_id")), Value: r.PostFormValue("value")}
	if err := s.api.SetDataValue(r.Context(), session(r), id, vid, v); err != nil {
		s.failTo(w, r, p, err, valuesTarget(r))
		return
	}
	s.renderDataValues(w, r, p, id, valuesTarget(r))
}

func (s *Server) handleDataDeleteValue(w http.ResponseWriter, r *http.Request, p Page) {
	id, ok := s.botID(w, r, p)
	if !ok {
		return
	}
	vid, _ := strconv.ParseInt(r.PathValue("vid"), 10, 64)
	q := r.URL.Query()
	if err := s.api.DeleteDataValue(r.Context(), session(r), id, vid, q.Get("server_id"), q.Get("owner_id"), q.Get("all") == "true"); err != nil {
		s.failTo(w, r, p, err, valuesTarget(r))
		return
	}
	// Keep the search, drop the page: the list got shorter.
	r.URL.RawQuery = url.Values{"q": {q.Get("q")}, "sort": {q.Get("sort")}}.Encode()
	s.renderDataValues(w, r, p, id, valuesTarget(r))
}

func (s *Server) handleDataLookup(w http.ResponseWriter, r *http.Request, p Page) {
	id, ok := s.botID(w, r, p)
	if !ok {
		return
	}
	who := strings.TrimSpace(r.URL.Query().Get("id"))
	view := dataLookupView{BotID: id, ID: who, Names: map[int64]string{}}
	if who != "" {
		items, err := s.api.LookupDataValues(r.Context(), session(r), id, who)
		if err != nil {
			if api.AsError(err).Status != http.StatusUnprocessableEntity {
				s.failTo(w, r, p, err, "#data-lookup")
				return
			}
			view.Error = true
		}
		view.Items = items
		vars, err := s.api.DataVariables(r.Context(), session(r), id)
		if err == nil {
			for _, v := range vars {
				view.Names[v.ID] = v.Name
			}
		}
	}
	s.render(w, http.StatusOK, "module_item", "data_storage_lookup_fragment", withData(p, view))
}
