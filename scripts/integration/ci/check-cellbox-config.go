package main

import (
	"fmt"
	"os"

	"cellbox.local/cellbox/internal/service"
)

// Copied inside the pinned Cellbox module so this uses its real schema.
func main() {
	if _, err := service.LoadConfig(os.Stdin); err != nil {
		fmt.Fprintln(os.Stderr, "Invalid CI Cellbox configuration:", err)
		os.Exit(1)
	}
	fmt.Println("CI Cellbox configuration validated")
}
