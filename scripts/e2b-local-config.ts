export function localUrl(value: string, name: string): string {
  const url = new URL(value);
  if (
    !["http:", "https:"].includes(url.protocol) ||
    !["127.0.0.1", "localhost", "[::1]"].includes(url.hostname) ||
    url.username || url.password || url.search || url.hash || url.pathname !== "/"
  ) {
    throw new Error(`${name} 必须是无账号、路径、查询参数的本地回环 HTTP(S) 地址`);
  }
  return url.origin;
}

