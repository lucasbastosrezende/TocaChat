const express = require('express');
const httpProxy = require('http-proxy');
const https = require('https');
const fs = require('fs');
const path = require('path');
const app = express();

const PORT = 8080;
const FLASK_SERVER = 'http://localhost:3000';
const PEERJS_SERVER = 'http://localhost:9000';

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
    xfwd: true // Adiciona headers X-Forwarded-For e X-Forwarded-Proto
});

console.log('--- Gateway TocaChat (HTTPS + WebSocket Enabled) ---');

// Error handling for proxy
proxy.on('error', (err, req, res) => {
    console.error('[Proxy Error]', err);
    if (res && res.writeHead) {
        res.writeHead(500, { 'Content-Type': 'text/plain' });
        res.end('Proxy Error');
    }
});

// Routing
app.all('/myapp*', (req, res) => {
    proxy.web(req, res, { target: PEERJS_SERVER });
});

app.all('/socket.io*', (req, res) => {
    proxy.web(req, res, { target: FLASK_SERVER });
});

app.all('/*', (req, res) => {
    proxy.web(req, res, { target: FLASK_SERVER });
});

const server = https.createServer(httpsOptions, app);

// Handle WebSocket upgrades
server.on('upgrade', (req, socket, head) => {
    if (req.url.startsWith('/myapp')) {
        proxy.ws(req, socket, head, { target: PEERJS_SERVER });
    } else if (req.url.startsWith('/socket.io')) {
        proxy.ws(req, socket, head, { target: FLASK_SERVER });
    } else {
        socket.destroy();
    }
});

server.listen(PORT, () => {
    console.log(`Gateway unificado rodando em https://tocachat.duckdns.org:${PORT} (SECURE)`);
    console.log(`- Redirecionando /myapp para PeerJS (9000) com WSS`);
    console.log(`- Redirecionando /socket.io para Flask (3000) com WSS`);
    console.log(`- Redirecionando todo o resto para Flask (3000)`);
});
