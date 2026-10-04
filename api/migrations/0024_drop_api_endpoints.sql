-- API / Secrets keeps secrets only (name, value, description). API endpoints
-- (base URL + auth header) are gone: an address is a secret too, and plugins
-- send requests with ctx.http.secret, the API Request block with "address
-- from secret" + "key from secret". Plugin access goes through
-- secret_plugin_shares (services.secrets).

DROP TABLE endpoint_plugin_shares;
DROP TABLE api_endpoints;
