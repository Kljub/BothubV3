package main

import "testing"

func TestImageMime(t *testing.T) {
	png := []byte("\x89PNG\r\n\x1a\n\x00\x00\x00\rIHDR")
	avif := []byte("\x00\x00\x00\x1cftypavif\x00\x00\x00\x00")
	if imageMime(png) != "image/png" || imageMime(avif) != "image/avif" || imageMime([]byte("hello world, no picture")) != "" {
		t.Fatal("imageMime does not tell the picture types apart")
	}
}
