const WebSocket = require('ws');
const http = require('http');
const ROOMS = {}
const clients = []

function generateRoomId(length = 8) {
  const characters = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  let randomId = '';

  for (let i = 0; i < length; i++) {
    const randomIndex = Math.floor(Math.random() * characters.length);
    randomId += characters.charAt(randomIndex);
  }

  return "ROOM" + randomId;
}

const server = http.createServer((req, res) => {
  res.writeHead(200, { 'Content-Type': 'text/plain' });
  res.end('WebSocket server is running');
});

const wss = new WebSocket.Server({ server });

const sendToTheOther = (ws, msg) => {
  if(ROOMS[ws.roomID]) {
    ROOMS[ws.roomID].forEach(user => {
      if(user !== ws) {
        user.send(JSON.stringify(msg))
      }})
  }
}

wss.on('connection', (ws) => {
  console.log('Client connected');
  clients.push(ws)

  ws.on('message', (message) => {
    console.log(`Received: ${message}`);
  
    message = JSON.parse(message)

    switch(message.request) {
      case "requestRoomID": 
        const roomID = generateRoomId()
        ws.send(JSON.stringify({
          "response": "roomID",
          "value": roomID
        }))
        ws.roomID = roomID
        ROOMS[roomID] = [ws]
        break
      case "joinRoom": 
        const joiningRoomID = message.value;
        if(ws.roomID === joiningRoomID) {
          ws.send(JSON.stringify({
            "response": "roomError",
            "error": "You cannot join your own room."
          })); 
        } else {
          if (ROOMS[joiningRoomID] && ROOMS[joiningRoomID].length === 1) {
            ROOMS[joiningRoomID].push(ws);
            ws.roomID = joiningRoomID;
            
            ROOMS[joiningRoomID].forEach(user => {
              user.send(JSON.stringify({
                "response": "roomJoined",
                "value": joiningRoomID
              }))
            })

            if(!ROOMS[ws.roomID]) return
            const color = Math.random() < 0.5 ? "white" : "black"
            ROOMS[ws.roomID][0].send(JSON.stringify({
              "response": "color",
              "value": color
            }))
            ROOMS[ws.roomID][1].send(JSON.stringify({
              "response": "color",
              "value": color === "white" ? "black" : "white"
            })) 
          } else {
            ws.send(JSON.stringify({
              "response": "roomError",
              "error": "Room does not exist or is full"
            }));
          }
        }
        break
      case "newChessboard":
        ROOMS[ws.roomID].forEach(user => {
          if(user !== ws) {
            user.send(JSON.stringify({
              "response": "newChessboard",
              "value": message.value
            }))
          }
        })
        break
      case "capturedPiece":
        sendToTheOther(ws, {
          response: "capturedPiece",
          value: message.value
        })
        break
      }
  });

  ws.on('close', () => {
    const indexToRemove = clients.indexOf(ws);
    clients.splice(indexToRemove, 1);    
    const roomID = ws.roomID
    console.log(ws.roomID)
    if (roomID && ROOMS[roomID]) {
      delete ROOMS[roomID]
    }
  });
});

setInterval(() => {
  const roomsWithActiveClients = [];
  for (const roomID in ROOMS) {
    if (ROOMS.hasOwnProperty(roomID) && ROOMS[roomID].length > 0) {
      roomsWithActiveClients.push(roomID);
    }
  }

  const allExistingRooms = Object.keys(ROOMS);

  for (const roomID of allExistingRooms) {
    if (!roomsWithActiveClients.includes(roomID)) {
      delete ROOMS[roomID];
      console.log(`Room ${roomID} deleted because it's empty.`);
    }
  }
}, 1000);


server.listen(8080, () => {
  console.log('WebSocket server is running on http://localhost:8080');
});
