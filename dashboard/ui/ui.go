// Package ui embeds templates, static files and translations into the binary.
package ui

import "embed"

//go:embed templates static lang
var FS embed.FS
