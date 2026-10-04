package api

import (
	"context"
	"fmt"
	"net/http"
	"net/url"
	"strconv"
	"time"
)

// Data Storage module (openapi: tag data-storage).

type DataVariable struct {
	ID           int64  `json:"id,omitempty"`
	Key          string `json:"key,omitempty"`
	Name         string `json:"name"`
	Description  string `json:"description"`
	Type         string `json:"type"`
	Owner        string `json:"owner"`
	PerServer    bool   `json:"perServer"`
	DefaultValue string `json:"defaultValue"`
	Group        string `json:"group"`
	Values       int    `json:"values,omitempty"`
	UsedIn       int    `json:"usedIn,omitempty"`
	// Plugin: ID of the plugin that created it (SDK variables.create); only that plugin changes it.
	Plugin    string    `json:"plugin,omitempty"`
	UpdatedAt time.Time `json:"updatedAt,omitzero"`
}

type DataValue struct {
	ServerID  string    `json:"serverId"`
	OwnerID   string    `json:"ownerId"`
	Value     string    `json:"value"`
	UpdatedAt time.Time `json:"updatedAt,omitzero"`
	// Lookup only.
	VariableID int64  `json:"variableId,omitempty"`
	Key        string `json:"key,omitempty"`
}

type DataValuePage struct {
	Items    []DataValue `json:"items"`
	Total    int         `json:"total"`
	Page     int         `json:"page"`
	PageSize int         `json:"pageSize"`
}

func dataPath(botID int64, rest string) string {
	return fmt.Sprintf("/api/v1/bots/%d/data%s", botID, rest)
}

func (c *Client) DataVariables(ctx context.Context, s Session, botID int64) ([]DataVariable, error) {
	var out list[DataVariable]
	_, err := c.do(ctx, s, http.MethodGet, dataPath(botID, "/variables"), nil, &out)
	return out.Items, err
}

func (c *Client) CreateDataVariable(ctx context.Context, s Session, botID int64, v DataVariable) (DataVariable, error) {
	var out DataVariable
	_, err := c.do(ctx, s, http.MethodPost, dataPath(botID, "/variables"), v, &out)
	return out, err
}

func (c *Client) UpdateDataVariable(ctx context.Context, s Session, botID int64, v DataVariable) (DataVariable, error) {
	var out DataVariable
	id := v.ID
	v.ID, v.Key = 0, ""
	_, err := c.do(ctx, s, http.MethodPut, dataPath(botID, fmt.Sprintf("/variables/%d", id)), v, &out)
	return out, err
}

func (c *Client) DeleteDataVariable(ctx context.Context, s Session, botID, id int64) error {
	_, err := c.do(ctx, s, http.MethodDelete, dataPath(botID, fmt.Sprintf("/variables/%d", id)), nil, nil)
	return err
}

func (c *Client) DataValues(ctx context.Context, s Session, botID, id int64, q string, page int, sort string) (DataValuePage, error) {
	var out DataValuePage
	query := url.Values{"q": {q}, "page": {strconv.Itoa(page)}, "sort": {sort}}
	_, err := c.do(ctx, s, http.MethodGet, dataPath(botID, fmt.Sprintf("/variables/%d/values?%s", id, query.Encode())), nil, &out)
	return out, err
}

func (c *Client) SetDataValue(ctx context.Context, s Session, botID, id int64, v DataValue) error {
	_, err := c.do(ctx, s, http.MethodPut, dataPath(botID, fmt.Sprintf("/variables/%d/values", id)), DataValue{ServerID: v.ServerID, OwnerID: v.OwnerID, Value: v.Value}, nil)
	return err
}

// DeleteDataValue deletes one value; with all it resets every value of the variable.
func (c *Client) DeleteDataValue(ctx context.Context, s Session, botID, id int64, serverID, ownerID string, all bool) error {
	query := url.Values{"serverId": {serverID}, "ownerId": {ownerID}}
	if all {
		query = url.Values{"all": {"true"}}
	}
	_, err := c.do(ctx, s, http.MethodDelete, dataPath(botID, fmt.Sprintf("/variables/%d/values?%s", id, query.Encode())), nil, nil)
	return err
}

func (c *Client) LookupDataValues(ctx context.Context, s Session, botID int64, id string) ([]DataValue, error) {
	var out list[DataValue]
	_, err := c.do(ctx, s, http.MethodGet, dataPath(botID, "/lookup?id="+url.QueryEscape(id)), nil, &out)
	return out.Items, err
}
