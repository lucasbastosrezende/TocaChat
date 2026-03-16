const express = require('express');
const httpProxy = require('http-proxy');
const https = require('https');
const fs = require('fs');
const path = require('path');
const logStream = fs.createWriteStream(path.join(__dirname, 'gateway.log'), { flags: 'a' });

function log(msg) {
    const time = new Date().toISOString();
    const line = `[${time}] ${msg}\n`;
    console.log(msg);
    logStream.write(line);
}

const app = express();

const PORT = 8080;
const FLASK_SERVER = 'http://localhost:3000';

// Carregar Certificados
const certPath = path.join(__dirname, 'certs', 'fullchain.pem');
const keyPath = path.join(__dirname, 'certs', 'privkey.pem');

let httpsOptions = {};
try {
    httpsOptions = {
        cert: fs.readFileSync(certPath),
        key: fs.readFileSync(keyPath)
    };
    console.log('[SSL] Certificados carregados com sucesso.');
} catch (err) {
    console.error('[SSL Error] Falha ao carregar certificados:', err.message);
    process.exit(1);
}

const proxy = httpProxy.createProxyServer({
    xfwd: true,
    changeOrigin: true,
    proxyTimeout: 1800000, // 30 minutes
    timeout: 1800000
});

// Logging middleware
app.use((req, res, next) => {
    log(`[Gateway] ${req.method} ${req.url} - ${req.headers['content-length'] || 0} bytes`);
    next();
});

console.log('--- Gateway TocaChat (HTTPS + WebSocket Enabled) ---');

// Error handling for proxy
proxy.on('error', (err, req, res) => {
    log(`[Proxy Error] ${err.message}`);
    if (res && res.writeHead) {
        res.writeHead(500, { 'Content-Type': 'text/plain' });
        res.end('Proxy Error');
    }
});

// Upgrade logging for debugging WebSockets
proxy.on('proxyReqWs', (proxyReq, req, socket, options, head) => {
    console.log(`[Proxy] WS Upgrade Request: ${req.url} -> ${options.target}`);
});

proxy.on('open', (proxySocket) => {
    console.log('[Proxy] WebSocket connection opened');
});

proxy.on('close', (res, socket, head) => {
    console.log('[Proxy] WebSocket connection closed');
});

// Routing

app.all('/socket.io*', (req, res) => {
    proxy.web(req, res, { target: FLASK_SERVER });
});

app.all('/*', (req, res) => {
    proxy.web(req, res, { target: FLASK_SERVER });
});

const server = https.createServer(httpsOptions, app);
server.timeout = 600000; // 10 minutes session timeout
server.keepAliveTimeout = 65000;

// Handle WebSocket upgrades
server.on('upgrade', (req, socket, head) => {
    console.log(`[Gateway] Upgrade request received: ${req.url}`);
    if (req.url.startsWith('/socket.io')) {
        proxy.ws(req, socket, head, { target: FLASK_SERVER });
    } else {
        console.warn(`[Gateway] Unauthorized upgrade path: ${req.url}`);
        socket.destroy();
    }
});

server.listen(PORT, () => {
    console.log(`Gateway unificado rodando em https://tocachat.duckdns.org:${PORT} (SECURE)`);
    console.log(`- Redirecionando /socket.io para Flask (3000) com WSS`);
    console.log(`- Redirecionando todo o resto para Flask (3000)`);
});
