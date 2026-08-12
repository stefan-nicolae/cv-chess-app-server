const crypto = require('crypto')
const http = require('http')
const WebSocket = require('ws')

const configuredPort = Number.parseInt(process.env.PORT, 10)
const PORT = Number.isInteger(configuredPort) && configuredPort > 0 && configuredPort <= 65535
  ? configuredPort
  : 8080
const MAX_MEMBERS = 10
const MAX_ROOM_MEMBERS = 2
const MAX_COMMANDS_PER_SECOND = 5
const MAX_RATE_LIMIT_VIOLATIONS = 3
const MAX_PAYLOAD_BYTES = 32 * 1024
const MAX_BUFFERED_BYTES = 256 * 1024
const DELIVERY_CONFIRMATION_TIMEOUT_MS = 5000
const ROOM_ID_PATTERN = /^[A-Za-z0-9]{8,64}$/
const COMMAND_ID_PATTERN = /^[A-Za-z0-9_-]{8,128}$/
const PIECE_TYPES = new Set(['Pawn', 'Rook', 'Knight', 'Bishop', 'Queen', 'King'])
const PIECE_COLORS = new Set(['thisSide', 'thatSide'])
const REQUESTS = new Set([
  'requestRoomID',
  'joinRoom',
  'URLroomID',
  'newChessboard',
  'commandReceived',
  'capturedPiece',
  'checkmateWinner',
  'enPassant'
])

const rooms = new Map()
const pendingDeliveries = new Map()

const getRandomColor = () => Math.random() < 0.5 ? 'white' : 'black'

function safeClose(ws, code, reason) {
  if(ws.readyState !== WebSocket.OPEN) return

  try {
    ws.close(code, reason)
  } catch {
    ws.terminate()
  }
}

function safeSend(ws, payload, callback) {
  let serialized
  try {
    serialized = JSON.stringify(payload)
  } catch(error) {
    if(callback) callback(error)
    return false
  }

  if(ws.readyState !== WebSocket.OPEN) {
    if(callback) callback(new Error('WebSocket is not open.'))
    return false
  }

  const byteLength = Buffer.byteLength(serialized)
  if(ws.bufferedAmount + byteLength > MAX_BUFFERED_BYTES) {
    if(callback) callback(new Error('WebSocket output buffer limit reached.'))
    safeClose(ws, 1013, 'Client is not receiving messages fast enough')
    return false
  }

  try {
    ws.send(serialized, error => {
      if(error) safeClose(ws, 1011, 'Message delivery failed')
      if(callback) callback(error)
    })
    return true
  } catch(error) {
    if(callback) callback(error)
    safeClose(ws, 1011, 'Message delivery failed')
    return false
  }
}

function generateID(length = 10) {
  const characters = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789'
  let id

  do {
    const bytes = crypto.randomBytes(length)
    id = Array.from(bytes, byte => characters[byte % characters.length]).join('')
  } while(rooms.has(id))

  return id
}

function isPlainObject(value) {
  return value !== null &&
    typeof value === 'object' &&
    !Array.isArray(value) &&
    Object.getPrototypeOf(value) === Object.prototype
}

function hasExactKeys(value, keys) {
  const actualKeys = Object.keys(value)
  return actualKeys.length === keys.length && keys.every(key => actualKeys.includes(key))
}

function isBoardCoordinate(value) {
  return Number.isInteger(value) && value >= 0 && value <= 7
}

function normalizePiece(piece) {
  if(!isPlainObject(piece) || !hasExactKeys(piece, ['color', 'position', 'type'])) {
    return undefined
  }

  if(
    !PIECE_COLORS.has(piece.color) ||
    !PIECE_TYPES.has(piece.type) ||
    !Array.isArray(piece.position) ||
    piece.position.length !== 2 ||
    !piece.position.every(isBoardCoordinate)
  ) {
    return undefined
  }

  return {
    color: piece.color,
    position: [piece.position[0], piece.position[1]],
    type: piece.type
  }
}

function normalizeBoard(value) {
  if(typeof value !== 'string') return undefined

  let board
  try {
    board = JSON.parse(value)
  } catch {
    return undefined
  }

  if(!Array.isArray(board) || board.length !== 8) return undefined

  let pieceCount = 0
  const positions = new Set()
  const normalizedBoard = []

  for(const row of board) {
    if(!Array.isArray(row) || row.length !== 8) return undefined

    const normalizedRow = []
    for(const cell of row) {
      if(cell === null) {
        normalizedRow.push(null)
        continue
      }

      const piece = normalizePiece(cell)
      if(!piece) return undefined

      pieceCount += 1
      if(pieceCount > 32) return undefined

      const positionKey = `${piece.position[0]},${piece.position[1]}`
      if(positions.has(positionKey)) return undefined
      positions.add(positionKey)
      normalizedRow.push(piece)
    }

    normalizedBoard.push(normalizedRow)
  }

  return JSON.stringify(normalizedBoard)
}

function normalizeCapturedPieces(value) {
  if(typeof value !== 'string') return undefined

  let captured
  try {
    captured = JSON.parse(value)
  } catch {
    return undefined
  }

  if(!isPlainObject(captured) || !hasExactKeys(captured, ['enemy', 'allied'])) {
    return undefined
  }

  const normalized = {}
  for(const side of ['enemy', 'allied']) {
    if(!Array.isArray(captured[side]) || captured[side].length > 16) return undefined

    normalized[side] = []
    for(const rawPiece of captured[side]) {
      const piece = normalizePiece(rawPiece)
      if(!piece) return undefined
      normalized[side].push(piece)
    }
  }

  return JSON.stringify(normalized)
}

function validateMessage(message) {
  if(!isPlainObject(message) || typeof message.request !== 'string' || !REQUESTS.has(message.request)) {
    return undefined
  }

  switch(message.request) {
    case 'requestRoomID':
      return hasExactKeys(message, ['request']) ? message : undefined

    case 'joinRoom':
    case 'URLroomID':
      return hasExactKeys(message, ['request', 'value']) &&
        typeof message.value === 'string' &&
        ROOM_ID_PATTERN.test(message.value)
        ? message
        : undefined

    case 'newChessboard':
    case 'commandReceived': {
      if(
        !hasExactKeys(message, ['request', 'value', 'commandId']) ||
        typeof message.commandId !== 'string' ||
        !COMMAND_ID_PATTERN.test(message.commandId)
      ) {
        return undefined
      }

      const board = normalizeBoard(message.value)
      return board === undefined ? undefined : { ...message, value: board }
    }

    case 'capturedPiece': {
      if(!hasExactKeys(message, ['request', 'value'])) return undefined
      const captured = normalizeCapturedPieces(message.value)
      return captured === undefined ? undefined : { ...message, value: captured }
    }

    case 'checkmateWinner':
      return hasExactKeys(message, ['request', 'value']) &&
        (message.value === 'white' || message.value === 'black')
        ? message
        : undefined

    case 'enPassant':
      return hasExactKeys(message, ['request', 'value']) &&
        Array.isArray(message.value) &&
        message.value.length === 2 &&
        message.value.every(isBoardCoordinate)
        ? message
        : undefined

    default:
      return undefined
  }
}

function sendRoomError(ws, message) {
  safeSend(ws, { response: 'roomError', error: message })
}

function sendCommandResult(ws, response, commandId, error) {
  if(!commandId) return

  safeSend(ws, {
    response,
    commandId,
    ...(error && { error })
  })
}

function failPendingDelivery(commandId, error) {
  const pending = pendingDeliveries.get(commandId)
  if(!pending) return

  clearTimeout(pending.timeout)
  pendingDeliveries.delete(commandId)
  sendCommandResult(pending.sender, 'commandDeliveryFailed', commandId, error)
}

function clearPendingDeliveriesFor(ws) {
  for(const [commandId, pending] of pendingDeliveries) {
    if(pending.recipient === ws) {
      failPendingDelivery(
        commandId,
        'The other player disconnected before confirming the board.'
      )
    } else if(pending.sender === ws) {
      clearTimeout(pending.timeout)
      pendingDeliveries.delete(commandId)
    }
  }
}

function getCurrentRoom(ws) {
  if(!ws.roomID) return undefined
  const room = rooms.get(ws.roomID)
  return room && room.has(ws) ? room : undefined
}

function detachWaitingRoom(ws) {
  const room = getCurrentRoom(ws)
  if(!room) {
    ws.roomID = undefined
    return true
  }

  if(room.size !== 1) return false

  rooms.delete(ws.roomID)
  room.delete(ws)
  ws.roomID = undefined
  return true
}

function closeRoomForSocket(ws) {
  const roomID = ws.roomID
  const room = getCurrentRoom(ws)
  ws.roomID = undefined

  if(!room) return

  rooms.delete(roomID)
  room.delete(ws)

  for(const partner of room) {
    partner.roomID = undefined
    safeSend(partner, { response: 'disconnect' })
  }

  room.clear()
}

function sendRoomJoined(roomID) {
  const room = rooms.get(roomID)
  if(!room || room.size !== MAX_ROOM_MEMBERS) return

  const colors = []
  colors[0] = getRandomColor()
  colors[1] = colors[0] === 'white' ? 'black' : 'white'

  Array.from(room).forEach((client, index) => {
    safeSend(client, { response: 'roomJoined', value: roomID })
    safeSend(client, { response: 'color', value: colors[index] })
  })
}

function createRoom(ws, requestedRoomID) {
  if(!detachWaitingRoom(ws)) {
    sendRoomError(ws, 'You are already in an active room.')
    return
  }

  const roomID = requestedRoomID || generateID()
  rooms.set(roomID, new Set([ws]))
  ws.roomID = roomID
  safeSend(ws, { response: 'roomID', value: roomID })
}

function requestRoom(ws) {
  const currentRoom = getCurrentRoom(ws)
  if(currentRoom) {
    if(currentRoom.size === 1) {
      safeSend(ws, { response: 'roomID', value: ws.roomID })
    } else {
      sendRoomError(ws, 'You are already in an active room.')
    }
    return
  }

  createRoom(ws)
}

function joinRoom(ws, roomID, createIfMissing) {
  if(ws.roomID === roomID) {
    sendRoomError(ws, 'Room is either yours, occupied or inexistent.')
    return
  }

  const targetRoom = rooms.get(roomID)
  if(targetRoom && targetRoom.size >= MAX_ROOM_MEMBERS) {
    sendRoomError(ws, 'Room is either yours, occupied or inexistent.')
    return
  }

  if(!targetRoom && !createIfMissing) {
    sendRoomError(ws, 'Room is either yours, occupied or inexistent.')
    return
  }

  if(!detachWaitingRoom(ws)) {
    sendRoomError(ws, 'You are already in an active room.')
    return
  }

  if(!targetRoom) {
    createRoom(ws, roomID)
    return
  }

  targetRoom.add(ws)
  ws.roomID = roomID
  sendRoomJoined(roomID)
}

function getPartner(ws) {
  const room = getCurrentRoom(ws)
  if(!room || room.size !== MAX_ROOM_MEMBERS) return undefined
  return Array.from(room).find(client => client !== ws)
}

function relayToPartner(ws, response, value) {
  const partner = getPartner(ws)
  if(!partner || partner.readyState !== WebSocket.OPEN) {
    sendRoomError(ws, 'The other player is not connected.')
    return
  }

  safeSend(partner, { response, value })
}

function sendBoardToPartner(ws, value, commandId) {
  const partner = getPartner(ws)
  if(!partner || partner.readyState !== WebSocket.OPEN) {
    sendCommandResult(
      ws,
      'commandDeliveryFailed',
      commandId,
      'The other player is not connected.'
    )
    return
  }

  if(pendingDeliveries.has(commandId)) {
    sendCommandResult(ws, 'commandDeliveryFailed', commandId, 'The command ID is already in use.')
    return
  }

  for(const pending of pendingDeliveries.values()) {
    if(pending.sender === ws) {
      sendCommandResult(ws, 'commandDeliveryFailed', commandId, 'A move is already awaiting confirmation.')
      return
    }
  }

  const timeout = setTimeout(() => {
    failPendingDelivery(commandId, 'The other player did not confirm the board in time.')
  }, DELIVERY_CONFIRMATION_TIMEOUT_MS)

  pendingDeliveries.set(commandId, {
    sender: ws,
    recipient: partner,
    value,
    timeout
  })

  safeSend(partner, {
    response: 'newChessboard',
    value,
    commandId
  }, error => {
    if(error) failPendingDelivery(commandId, 'The command could not be delivered.')
  })
}

function confirmReceivedCommand(ws, message) {
  const pending = pendingDeliveries.get(message.commandId)
  if(!pending || pending.recipient !== ws) return

  if(message.value !== pending.value) {
    failPendingDelivery(message.commandId, "The players' boards did not match.")
    return
  }

  clearTimeout(pending.timeout)
  pendingDeliveries.delete(message.commandId)
  sendCommandResult(pending.sender, 'commandDelivered', message.commandId)
}

function isRateLimited(ws) {
  const now = Date.now()
  ws.commandTimestamps = ws.commandTimestamps.filter(timestamp => now - timestamp < 1000)

  if(ws.commandTimestamps.length >= MAX_COMMANDS_PER_SECOND) {
    ws.rateLimitViolations += 1
    safeSend(ws, {
      response: 'rateLimitError',
      error: `Rate limit exceeded. Maximum ${MAX_COMMANDS_PER_SECOND} commands per second.`
    })

    if(ws.rateLimitViolations >= MAX_RATE_LIMIT_VIOLATIONS) {
      safeClose(ws, 1008, 'Repeated rate limit violations')
    }
    return true
  }

  if(ws.commandTimestamps.length === 0) ws.rateLimitViolations = 0
  ws.commandTimestamps.push(now)
  return false
}

function handleMessage(ws, data, isBinary) {
  if(isRateLimited(ws)) return

  if(isBinary) {
    sendRoomError(ws, 'Binary commands are not supported.')
    return
  }

  let parsedMessage
  try {
    parsedMessage = JSON.parse(data.toString('utf8'))
  } catch {
    sendRoomError(ws, 'Invalid command.')
    return
  }

  const message = validateMessage(parsedMessage)
  if(!message) {
    sendRoomError(ws, 'Invalid command.')
    return
  }

  switch(message.request) {
    case 'requestRoomID':
      requestRoom(ws)
      break
    case 'joinRoom':
      joinRoom(ws, message.value, false)
      break
    case 'URLroomID':
      joinRoom(ws, message.value, true)
      break
    case 'newChessboard':
      sendBoardToPartner(ws, message.value, message.commandId)
      break
    case 'commandReceived':
      confirmReceivedCommand(ws, message)
      break
    case 'capturedPiece':
    case 'checkmateWinner':
    case 'enPassant':
      relayToPartner(ws, message.request, message.value)
      break
  }
}

const server = http.createServer((req, res) => {
  res.writeHead(200, { 'Content-Type': 'text/plain' })
  res.end('WebSocket server is running')
})

const wss = new WebSocket.Server({
  server,
  maxPayload: MAX_PAYLOAD_BYTES,
  perMessageDeflate: false
})

wss.on('connection', ws => {
  if(wss.clients.size > MAX_MEMBERS) {
    safeSend(ws, {
      response: 'serverError',
      error: `Server is full. The maximum number of members is ${MAX_MEMBERS}.`
    }, () => safeClose(ws, 1013, 'Server member limit reached'))
    return
  }

  ws.commandTimestamps = []
  ws.rateLimitViolations = 0

  console.log('Client connected')

  ws.on('message', (data, isBinary) => {
    try {
      handleMessage(ws, data, isBinary)
    } catch {
      sendRoomError(ws, 'Invalid command.')
    }
  })

  ws.on('error', () => {
    // The close handler owns all room and pending-delivery cleanup.
  })

  ws.on('close', () => {
    clearPendingDeliveriesFor(ws)
    closeRoomForSocket(ws)
    console.log('Client disconnected')
  })
})

server.listen(PORT, '0.0.0.0', () => {
  console.log(`WebSocket server is running on http://0.0.0.0:${PORT}`)
})
