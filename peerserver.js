const { PeerServer } = require('peer');

const PORT = 9000;

console.log(`Starting PeerJS signaling server on port ${PORT}...`);

const peerServer = PeerServer({

  port: PORT,

  path: '/myapp',

  allow_discovery: true,

  proxied: true,        // importante se usar nginx / proxy

  pingInterval: 20000   // evita desconexões frequentes

});

peerServer.on('connection', (client) => {
  console.log(`[PeerServer] Client connected: ${client.getId()}`);
});

peerServer.on('disconnect', (client) => {
  console.log(`[PeerServer] Client disconnected: ${client.getId()}`);
});

peerServer.on('error', (err) => {
  console.error('[PeerServer] Error:', err);
});

process.on('uncaughtException', (err) => {
  console.error('Uncaught Exception:', err);
});

process.on('unhandledRejection', (err) => {
  console.error('Unhandled Rejection:', err);
});

console.log(`PeerServer running at http://localhost:${PORT}/myapp`);