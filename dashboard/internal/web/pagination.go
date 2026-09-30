package web

import (
	"net/http"
	"strconv"

	"github.com/Kljub/BothubV3/dashboard/internal/api"
)

// botsPerPage: 5 per row, at most 3 rows; the "add bot" tile takes one slot.
const botsPerPage = 5*3 - 1

// botGridView is the data for the "bot_grid" template.
type botGridView struct {
	Bots        []api.Bot
	Page, Pages int
}

// botGrid returns one page of bots. page is clamped to the valid range, so a
// page that became empty (bot deleted) shows the last page instead.
func botGrid(bots []api.Bot, page int) botGridView {
	pages := max(1, (len(bots)+botsPerPage-1)/botsPerPage)
	page = min(max(page, 1), pages)
	from := (page - 1) * botsPerPage
	to := min(from+botsPerPage, len(bots))
	return botGridView{Bots: bots[from:to], Page: page, Pages: pages}
}

func pageParam(r *http.Request) int {
	n, _ := strconv.Atoi(r.URL.Query().Get("page"))
	return n
}

// pagerView is the data for the "pagination" template. Items are page numbers;
// 0 stands for a gap ("…").
type pagerView struct {
	Page, Pages, Prev, Next int
	URL, Target             string
	Items                   []int
}

// pager lists the first, last and the pages around the current one.
func pager(page, pages int, url, target string) pagerView {
	v := pagerView{Page: page, Pages: pages, Prev: max(1, page-1), Next: min(pages, page+1), URL: url, Target: target}
	last := 0
	for i := 1; i <= pages; i++ {
		if i == 1 || i == pages || (i >= page-1 && i <= page+1) {
			if last != 0 && i-last > 1 {
				v.Items = append(v.Items, 0)
			}
			v.Items = append(v.Items, i)
			last = i
		}
	}
	return v
}
