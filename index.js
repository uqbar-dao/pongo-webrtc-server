// Import required modules
const express = require('express');
const http = require('http');
const WebSocket = require('ws');

// Create an Express app
const app = express();

// Serve static files from the "public" folder
app.use(express.static('public'));

app.get('/', (req, res) => {
  res.send('hello world')
})

app.get('/health-check', (req, res) => {
  res.send('all good bro')
})

// Create an HTTP server
const server = http.createServer(app);

// Create a WebSocket server
const wss = new WebSocket.Server({ server });

const sockets = new Map();

// Set up WebSocket connection handling
wss.on('connection', (ws) => {
  let socketId

  // Handle incoming messages from the client
  ws.on('message', (message) => {
    try {
      const data = JSON.parse(message);
  
      if (data.id) {
        socketId = data.id;
        sockets.set(data.id, ws);
        return;
      }
  
      // If the message is intended for a specific client, send it
      if (data.target && sockets.has(data.target)) {
        const targetWs = sockets.get(data.target);
        targetWs.send(JSON.stringify(data.content));
      }
    } catch (err) {
      console.warn(err)
    }
  });

  // Handle WebSocket disconnection
  ws.on('close', () => {
    socketId && sockets.delete(socketId);
  });
});

// Start the HTTP server
const port = process.env.PORT || 3000;
server.listen(port, () => {
  console.log(`Server is running on port ${port}`);
});
