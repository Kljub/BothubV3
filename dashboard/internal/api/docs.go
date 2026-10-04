package api

import (
	"context"
	"fmt"
	"net/http"
	"net/url"
)

// DocArticle is an article written in the dashboard (the shipped guides are
// Markdown files in shared/docs). Lang "" = every language.
type DocArticle struct {
	ID        int64  `json:"id"`
	Category  string `json:"category"`
	Slug      string `json:"slug"`
	Lang      string `json:"lang"`
	Title     string `json:"title"`
	Summary   string `json:"summary"`
	Content   string `json:"content,omitempty"`
	Published bool   `json:"published"`
	Sort      int    `json:"sort"`
	Author    string `json:"author"`
	CreatedAt string `json:"createdAt"`
	UpdatedAt string `json:"updatedAt"`
}

// DocCategory is an own docs category next to the shipped ones.
type DocCategory struct {
	Slug  string `json:"slug"`
	Icon  string `json:"icon"`
	Title string `json:"title"`
	Sort  int    `json:"sort"`
}

// DocsList: every own article (drafts too, without content) and the own categories.
type DocsList struct {
	Articles   []DocArticle  `json:"articles"`
	Categories []DocCategory `json:"categories"`
}

func (c *Client) Docs(ctx context.Context, s Session) (DocsList, error) {
	var out DocsList
	_, err := c.do(ctx, s, http.MethodGet, "/api/v1/docs", nil, &out)
	return out, err
}

func (c *Client) Doc(ctx context.Context, s Session, id int64) (DocArticle, error) {
	var out DocArticle
	_, err := c.do(ctx, s, http.MethodGet, fmt.Sprintf("/api/v1/docs/%d", id), nil, &out)
	return out, err
}

// SaveDoc creates (id 0) or changes an article.
func (c *Client) SaveDoc(ctx context.Context, s Session, id int64, in DocArticle) (DocArticle, error) {
	var out DocArticle
	body := map[string]any{"category": in.Category, "slug": in.Slug, "lang": in.Lang, "title": in.Title, "summary": in.Summary, "content": in.Content, "published": in.Published, "sort": in.Sort}
	method, path := http.MethodPost, "/api/v1/docs"
	if id > 0 {
		method, path = http.MethodPut, fmt.Sprintf("/api/v1/docs/%d", id)
	}
	_, err := c.do(ctx, s, method, path, body, &out)
	return out, err
}

func (c *Client) DeleteDoc(ctx context.Context, s Session, id int64) error {
	_, err := c.do(ctx, s, http.MethodDelete, fmt.Sprintf("/api/v1/docs/%d", id), nil, nil)
	return err
}

func (c *Client) SaveDocCategory(ctx context.Context, s Session, in DocCategory) error {
	_, err := c.do(ctx, s, http.MethodPost, "/api/v1/docs/categories", in, nil)
	return err
}

func (c *Client) DeleteDocCategory(ctx context.Context, s Session, slug string) error {
	_, err := c.do(ctx, s, http.MethodDelete, "/api/v1/docs/categories/"+url.PathEscape(slug), nil, nil)
	return err
}
