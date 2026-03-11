const { PeerServer } = require('peer');

console.log('Starting PeerJS signaling server on port 9000...');

const peerServer = PeerServer({
  port: 9000,
  path: '/myapp',
  allow_discovery: true
});

peerServer.on('connection', (client) => {
  console.log(`[PeerServer] Client connected: ${client.getId()}`);
});

peerServer.on('disconnect', (client) => {
  console.log(`[PeerServer] Client disconnected: ${client.getId()}`);
});

console.log('PeerServer is running! Connecting peers should use port 9000 and path /myapp.');
