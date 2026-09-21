import http from 'node:http';

const port = Number(process.argv[2] || 40000);

http.createServer((request, response) => {
  const [target, ...rest] = (request.url || '/').slice(1).split('/');
  const targetPort = Number(target);
  if (!Number.isInteger(targetPort) || targetPort < 1 || targetPort > 65535) {
    response.writeHead(400).end('invalid target port');
    return;
  }
  const upstream = http.request({
    host: '127.0.0.1', port: targetPort, method: request.method,
    path: `/${rest.join('/')}`, headers: request.headers,
  }, upstreamResponse => {
    response.writeHead(upstreamResponse.statusCode || 502, upstreamResponse.headers);
    upstreamResponse.pipe(response);
  });
  upstream.on('error', error => response.writeHead(504).end(error.message));
  request.pipe(upstream);
}).listen(port, '0.0.0.0', () => console.log(`cellbox-proxy listening on :${port}`));
