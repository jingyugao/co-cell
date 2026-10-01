package main

import (
	"encoding/json"
	"flag"
	"fmt"
	"log"
	"net/http"
	"runtime"
	"time"
)

var version = "dev"

func main() {
	port := flag.Int("port", 8080, "HTTP listen port")
	showVersion := flag.Bool("version", false, "Print the demo image version")
	flag.Parse()
	if *showVersion {
		fmt.Println(version)
		return
	}
	if *port < 1 || *port > 65535 {
		log.Fatal("port must be between 1 and 65535")
	}
	mux := http.NewServeMux()
	mux.HandleFunc("/", func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(w).Encode(map[string]string{
			"service": "cocell-demo",
			"version": version,
			"go":      runtime.Version(),
			"path":    r.URL.Path,
		})
	})
	server := &http.Server{
		Addr:              fmt.Sprintf(":%d", *port),
		Handler:           mux,
		ReadHeaderTimeout: 10 * time.Second,
	}
	log.Printf("CoCell demo %s listening on %s", version, server.Addr)
	log.Fatal(server.ListenAndServe())
}
