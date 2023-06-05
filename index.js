// Import required modules
const express = require('express');
const http = require('http');
const cors = require('cors');
const mediasoup = require('mediasoup');
const WebSocket = require('ws');

const rooms = new Map();
const sockets = new Map();

(async function() {
  // Create an Express app
  const app = express();

  // Serve static files from the "public" folder
  app.use(express.static('public'));
  app.use(express.json());
  app.use(cors({ origin: '*' }));

  app.get('/', (req, res) => {
    res.send('Pongo Webrtc Server')
  })

  app.get('/health-check', (req, res) => {
    res.send('all good bro')
  })

  app.post('/uqbar-chain-id', (req, res) => {
    try {
      const { method } = req.body
      if (method === 'eth_chainId') {
        res.send({
          "jsonrpc": "2.0",
          "id": req.body.id,
          "error": null,
          "result": "0x7261627175"
        })
      } else if (method === 'eth_blockNumber') {
        res.send({
          "jsonrpc": "2.0",
          "id": req.body.id,
          "error": null,
          "result": "0x0"
        })
      } else {
        res.send('NO OP')
      }
    } catch {
      res.status(500).send('error')
    }
  })

  // Create an HTTP server
  const server = http.createServer(app);

  // Create a WebSocket server
  const wss = new WebSocket.Server({ server });

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

  // Load SSL/TLS certificate and key
  // const options = {
  //   key: fs.readFileSync('/path/to/ssl/key'),
  //   cert: fs.readFileSync('/path/to/ssl/cert')
  // };

  // const server = https.createServer(options, app);

  // Create a Mediasoup worker
  const worker = await mediasoup.createWorker({
    logLevel: 'warn',
  });

  // Create a Mediasoup router
  const router = await worker.createRouter({
    mediaCodecs: [
      {
        kind: 'audio',
        mimeType: 'audio/opus',
        clockRate: 48000,
        channels: 2,
      },
      {
        kind: 'video',
        mimeType: 'video/VP8',
        clockRate: 90000,
        parameters: {
          'x-google-start-bitrate': 1000,
        },
      },
    ],
  });

  // Check if a room already exists for a given chat
  app.get('/capabilities', async (req, res) => {
    res.json({ routerRtpCapabilities: router.rtpCapabilities });
  });

  // Handle incoming request to create or retrieve a new room
  app.post('/rooms', async (req, res) => {
    // Use the chatId as the roomId
    const roomId = req.body.roomId

    let transport

    if (rooms.has(roomId)) {
      transport = rooms.get(roomId).transport;
    } else {
      // Create a new Mediasoup transport for the room
      transport = await router.createWebRtcTransport({
        listenIps: [{ ip: '0.0.0.0', announcedIp: '127.0.0.1' }],
        enableUdp: true,
        enableTcp: true,
        preferUdp: true,
      });

      // Save the transport and room ID for later use
      rooms.set(roomId, { transport, peers: new Map(), consumers: new Map() });
    }

    res.json({ transport: {
      id             : transport.id,
      iceParameters  : transport.iceParameters,
      iceCandidates  : transport.iceCandidates,
      dtlsParameters : transport.dtlsParameters,
      sctpParameters : transport.sctpParameters
    } });
  });

  // Connect the client sendTransport to the room's transport
  app.post('/rooms/:roomId/transports/:transportId/connect', async (req, res) => {
    const roomId = req.params.roomId;
    const { ship, dtlsParameters, rtpCapabilities } = req.body;

    // Retrieve the transport for the room
    const { transport, peers } = rooms.get(roomId);

    if (!peers.has(ship)) {
      peers.set(ship, { producers: {}, consumers: {}, rtpCapabilities });
    } else {
      peers.get(ship).rtpCapabilities = rtpCapabilities;
    }

    // Connect the transport
    await transport.connect({ dtlsParameters });

    res.json({ id: transport.id });
  });

  // Create a producer
  app.post('/rooms/:roomId/transports/:transportId/produce', async (req, res) => {
    const roomId = req.params.roomId;
    const { ship, kind, rtpParameters, appData } = req.body;

    // Retrieve the transport for the room
    const { transport, peers } = rooms.get(roomId);

    // Create a new Mediasoup producer for the peer
    const producer = await transport.produce({ kind, rtpParameters });

    // Add the producer to the peer's producer
    if (!peers.has(ship)) {
      peers.set(ship, { producers: { [kind]: producer }, consumers: {} });
    } else {
      peers.get(ship).producers[kind] = producer;
    }

    // Add the consumer to each other peer
    peers.forEach(async (value, key) => {
      if (key !== ship && value.rtpCapabilities) {
        const consumer = await transport.consume({ producerId: producer.id, rtpCapabilities: value.rtpCapabilities, paused: true });
        if (!value.consumers[ship]) {
          value.consumers[ship] = { [kind]: consumer }
        } else {
          value.consumers[ship][kind] = consumer;
        }

        sockets.get(key)?.send(JSON.stringify({ addConsumer: { ship: key, kind, consumer } }))
      }
    });

    // Return the peer ID to the client
    res.json({ id: producer.id });
  });


  // Get all the consumers for a newly-connected peer
  app.get('/rooms/:roomId/peers/:ship/consumers', async (req, res) => {
    const { roomId, ship } = req.params;

    // Retrieve the transport for the room and the peer's producer
    const { transport, peers } = rooms.get(roomId);

    const peer = peers.get(ship);

    if (peer && peer.rtpCapabilities && peer.consumers && !Object.keys(peer.consumers).length) {
      peers.forEach(async (value, key) => {
        if (key !== ship && rtpCapabilities) {
          Object.keys(value.producers).forEach(async (kind) => {
            const consumer = await transport.consume({ producerId: value.producers[kind].id, rtpCapabilities, paused: true });
            
            if (!peer.consumers[key]) {
              peer.consumers[key] = { [kind]: consumer }
            } else {
              peer.consumers[key][kind] = consumer;
            }
          });
        }
      });
    }

    res.json({ consumers: peer.consumers });
  });

  // Resume a consumer
  app.post('/rooms/:roomId/peers/:ship/consumers/:targetShip/:kind/resume/', async (req, res) => {
    const { roomId, ship, targetShip, kind } = req.params.roomId;

    // Resume the consumer
    rooms.get(roomId).peers.get(ship).consumers[targetShip][kind].resume();

    // Return the consumer's ID and parameters to the client
    res.sendStatus(200);
  });

  // Handle incoming requests to close a peer's connection
  app.delete('/rooms/:roomId/peers/:ship', async (req, res) => {
    const { roomId, ship } = req.params.roomId;
    console.log('DELETE')

    // Retrieve the transport for the room and the peer's producers and consumers
    const { peers } = rooms.get(roomId);
    const { producers, consumers } = peers.get(ship);
    Object.values(producers).forEach(p => p.close())
    Object.values(consumers).forEach(consumerShip => {
      Object.values(consumerShip).forEach(consumer => consumer.close())
    })

    peers.forEach(async (value, key) => {
      if (key !== ship && value?.consumers[ship]) {
        delete value.consumers[ship]
        sockets.get(key)?.send(JSON.stringify({ removeConsumer: { ship } }))
      }
    });

    // Remove the peer from the room's list of peers
    peers.delete(ship);

    // Return success status to the client
    res.sendStatus(200);
  });

  // Start the HTTP server
  const port = process.env.PORT || 3000;
  server.listen(port, () => {
    console.log(`Server is running on port ${port}`);
  });
})()
