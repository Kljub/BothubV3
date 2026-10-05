//go:build windows

package main

// diskSpace is not measured on Windows dev runs.
func diskSpace(string) (int64, int64) { return 0, 0 }
