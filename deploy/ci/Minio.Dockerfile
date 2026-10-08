FROM debian:bookworm-slim
COPY --chmod=0755 minio /usr/local/bin/minio
ENTRYPOINT ["/usr/local/bin/minio"]
