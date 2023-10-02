const WebSocket = require('ws');
const http = require('http');

const rooms = {}

const getRandomColor = () => Math.random() < 0.5 ? "white" : "black";

function generateID(length=10) {
  const characters = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  let id = '';

  for (let i = 0; i < length; i++) {
    const randomIndex = Math.floor(Math.random() * characters.length);
    id += characters.charAt(randomIndex);
  }

  return id;
}

function okToJoin(roomID) {
  const color1 = getRandomColor()
  const color2 = color1 === "white" ? "black": "white"
  const colors = [color1, color2]
  rooms[roomID].forEach((ws, index) => {
    ws.send(JSON.stringify({
      response: "roomJoined",
      value: roomID
    }))
    ws.send(JSON.stringify({
      response: "color",
      value: colors[index]
    }))
  })
}

function sendDisconnect(roomID) {
  if(!rooms[roomID]) return
  rooms[roomID].forEach(ws => {
    ws.send(JSON.stringify({
      response: "disconnect"
    }))
  })
}

function sendToPartner(ws, message) {
  rooms[ws.roomID].forEach(user => {
    if(user !== ws) {
      user.send(message)
    }
  })
}

function sendRoomError(ws, message) {
  ws.send(JSON.stringify({
    response: "roomError",
    error: message}))
}

const server = http.createServer((req, res) => {
  res.writeHead(200, { 'Content-Type': 'text/plain' });
  res.end('WebSocket server is running');
});

const wss = new WebSocket.Server({ server });

wss.on('connection', (ws) => {
  console.log('Client connected');

  ws.on('message', (message) => {
    console.log(`Received: ${message}`);
  
    message = JSON.parse(message)
    switch(message.request) {
      case "requestRoomID":
        var roomID = generateID()
        rooms[roomID] = [ws]
        ws.roomID = roomID
        ws.send(JSON.stringify({
          response: "roomID",
          value: roomID
        }))
        break
      case "joinRoom":
        var roomID = message.value
        if(ws.roomID===roomID || !rooms[roomID] || rooms[roomID].length === 2) {
          sendRoomError(ws, "Room is either yours, occupied or inexistent.")
          break
        }
        rooms[roomID].push(ws)
        ws.roomID = roomID
        okToJoin(roomID)
        break
      case "URLroomID":
        var roomID = message.value
        if(ws.roomID===roomID || rooms[roomID].length === 2) {
          sendRoomError(ws, "Room is either yours, occupied or inexistent.")
          break
        }
        if(!rooms[roomID]) {
          rooms[roomID] = [ws]
          ws.roomID = roomID
        } else {
          rooms[roomID].push(ws)
          ws.roomID = roomID
          okToJoin(roomID)
        }
        break
      default: 
        sendToPartner(ws, JSON.stringify({
          response: message.request,
          value: message.value
        }))
        break
    }
  });

  ws.on('close', () => {
    sendDisconnect(ws.roomID)
    delete rooms[ws.roomID]
  });
})

server.listen(8080, () => {
  console.log('WebSocket server is running on http://localhost:8080');
});

