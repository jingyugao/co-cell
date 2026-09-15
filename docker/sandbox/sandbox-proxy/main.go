package main

import (
	"fmt"
	"io"
	"log"
	"net/http"
	"os"
	"strconv"
	"strings"
)

func main() {
	port := 40000
	if len(os.Args) > 1 {
		if p, err := strconv.Atoi(os.Args[1]); err == nil {
			port = p
		}
	}

	http.HandleFunc("/", handler)
	log.Printf("sandbox-proxy listening on :%d", port)
	if err := http.ListenAndServe(fmt.Sprintf(":%d", port), nil); err != nil {
		log.Fatal(err)
	}
}

func handler(w http.ResponseWriter, r *http.Request) {
	// Path: /<targetPort>/<rest>
	path := strings.TrimPrefix(r.URL.Path, "/")
	idx := strings.Index(path, "/")
	if idx < 0 {
		idx = len(path)
	}
	targetPort, err := strconv.Atoi(path[:idx])
	if err != nil || targetPort < 1 || targetPort > 65535 {
		http.Error(w, "invalid target port", http.StatusBadRequest)
		return
	}

	targetPath := "/"
	if idx < len(path) {
		targetPath = "/" + path[idx+1:]
	}
	if r.URL.RawQuery != "" {
		targetPath += "?" + r.URL.RawQuery
	}

	targetURL := fmt.Sprintf("http://127.0.0.1:%d%s", targetPort, targetPath)

	proxyReq, err := http.NewRequest(r.Method, targetURL, r.Body)
	if err != nil {
		http.Error(w, err.Error(), http.StatusBadGateway)
		return
	}
	copyHeader(proxyReq.Header, r.Header)

	resp, err := http.DefaultTransport.RoundTrip(proxyReq)
	if err != nil {
		http.Error(w, err.Error(), http.StatusGatewayTimeout)
		return
	}
	defer resp.Body.Close()

	copyHeader(w.Header(), resp.Header)
	w.WriteHeader(resp.StatusCode)
	io.Copy(w, resp.Body)
}

func copyHeader(dst, src http.Header) {
	for k, vv := range src {
		for _, v := range vv {
			dst.Add(k, v)
		}
	}
}