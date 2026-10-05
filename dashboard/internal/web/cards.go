package web

import (
	"encoding/json"
	"mime"
	"net/http"
	"os"
	"path/filepath"
	"strconv"

	"github.com/Kljub/BothubV3/dashboard/internal/api"
)

// Card Designer: the list of a bot's cards on the module page and the Card
// Studio (/bots/cards/{cid}). The browser edits and saves through the API
// proxy (/api/v1/bots/{id}/cards); the shared renderer, its templates and
// fonts come from SHARED_DIR/cards (served at /cards/), the same files the
// bot draws with.

func init() {
	_ = mime.AddExtensionType(".mjs", "text/javascript; charset=utf-8")
	_ = mime.AddExtensionType(".ttf", "font/ttf")
}

func cardsDir() string {
	dir := os.Getenv("SHARED_DIR")
	if dir == "" {
		dir = "/shared"
	}
	return filepath.Join(dir, "cards")
}

// cardFiles serves render.mjs, templates.json and fonts/* (no secrets in there).
func cardFiles() http.Handler {
	return http.StripPrefix("/cards/", cacheStatic(http.FileServer(http.Dir(cardsDir()))))
}

var cardKinds = []string{"welcome", "welcome-back", "goodbye", "boost", "milestone", "rank", "custom"}

type cardRow struct {
	api.Card
	DesignJSON string // for the preview canvas (data attribute)
}

type cardsView struct {
	BotID int64
	Items []cardRow
	Kinds []string
}

func (s *Server) cardsView(r *http.Request, botID int64) (cardsView, error) {
	items, err := s.api.Cards(r.Context(), session(r), botID)
	if err != nil {
		return cardsView{}, err
	}
	v := cardsView{BotID: botID, Kinds: cardKinds}
	for _, c := range items {
		v.Items = append(v.Items, cardRow{Card: c, DesignJSON: string(c.Design)})
	}
	return v, nil
}

type cardStudioView struct {
	BotID      int64
	Card       api.Card
	DesignJSON string
	Kinds      []string
	Texts      string // i18n of the studio (JSON)
}

// handleCardStudio opens one card in the Card Studio.
func (s *Server) handleCardStudio(w http.ResponseWriter, r *http.Request, p Page) {
	bot, ok := s.selectedBotOrHome(w, r, p)
	if !ok {
		return
	}
	cid, _ := strconv.ParseInt(r.PathValue("cid"), 10, 64)
	card, err := s.api.Card(r.Context(), session(r), bot.ID, cid)
	if err != nil {
		s.fail(w, r, p, err)
		return
	}
	p.SelectedBot = &bot
	p.Nav = "bot_modules"
	texts, _ := json.Marshal(s.prefixTexts(p.Locale, "cards."))
	data := map[string]any{"Bot": bot, "Section": "modules", "Kind": "card_studio", "Category": "utility",
		"Studio": cardStudioView{BotID: bot.ID, Card: card, DesignJSON: string(card.Design), Kinds: cardKinds, Texts: string(texts)}}
	// Its own full-screen page, like the command builder.
	s.render(w, http.StatusOK, "card_builder", "card_builder_layout", withData(p, data))
}
