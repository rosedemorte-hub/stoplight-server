/**
 * Stoplight Server
 * Real-time status sharing via Socket.io
 * Rooms are password-protected, max 10 users each.
 */

const express    = require('express');
const http       = require('http');
const { Server } = require('socket.io');
const jwt        = require('jsonwebtoken');
const bcrypt     = require('bcryptjs');
const cors       = require('cors');
const crypto     = require('crypto');

const app    = express();
const server = http.createServer(app);

const JWT_SECRET = process.env.JWT_SECRET || 'change-this-secret-in-production';
const PORT       = process.env.PORT || 3001;
const MAX_USERS  = 10;

app.use(cors());
app.use(express.json());

// ── In-memory store ──────────────────────────────────────────────
// rooms: Map<roomCode, Room>
// Room = { code, passwordHash, users: Map<socketId, User>, createdAt }
// User = { id, email, displayName, bodyColor, status, isHost }
const rooms    = new Map();
const sessions = new Map(); // socketId → { roomCode }

// ── Helpers ──────────────────────────────────────────────────────
function generateRoomCode() {
  // 6-char uppercase hex e.g. "A3F2C1"
  return crypto.randomBytes(3).toString('hex').toUpperCase();
}

function roomSnapshot(room) {
  return Array.from(room.users.values()).map(u => ({
    id:          u.id,
    displayName: u.displayName,
    bodyColor:   u.bodyColor,
    status:      u.status,
    isHost:      u.isHost
    // email intentionally omitted from broadcasts
  }));
}

// ── Socket.io ─────────────────────────────────────────────────────
const io = new Server(server, {
  cors: { origin: '*', methods: ['GET', 'POST'] }
});

io.on('connection', (socket) => {
  console.log(`[+] Connected: ${socket.id}`);

  // ── Create room (host) ─────────────────────────────────────────
  socket.on('create_room', async ({ email, displayName, bodyColor, password }) => {
    if (!email || !displayName || !password) {
      return socket.emit('room_error', { message: 'Missing required fields.' });
    }
    try {
      const roomCode     = generateRoomCode();
      const passwordHash = await bcrypt.hash(password, 10);

      const user = {
        id:          socket.id,
        email,
        displayName: displayName.trim().slice(0, 24),
        bodyColor:   bodyColor || '#e94560',
        status:      'green',
        isHost:      true
      };

      rooms.set(roomCode, {
        code:         roomCode,
        passwordHash,
        users:        new Map([[socket.id, user]]),
        createdAt:    new Date()
      });

      sessions.set(socket.id, { roomCode });
      socket.join(roomCode);

      const token = jwt.sign(
        { socketId: socket.id, roomCode, email },
        JWT_SECRET,
        { expiresIn: '24h' }
      );

      socket.emit('room_created', {
        roomCode,
        token,
        me:    user,
        users: roomSnapshot(rooms.get(roomCode))
      });

      console.log(`[Room] ${roomCode} created by "${displayName}"`);
    } catch (err) {
      socket.emit('room_error', { message: 'Could not create room.' });
    }
  });

  // ── Join room ─────────────────────────────────────────────────
  socket.on('join_room', async ({ email, displayName, bodyColor, roomCode, password }) => {
    if (!email || !displayName || !roomCode || !password) {
      return socket.emit('room_error', { message: 'Missing required fields.' });
    }

    const code = roomCode.trim().toUpperCase();
    const room = rooms.get(code);

    if (!room) {
      return socket.emit('room_error', { message: 'Room not found. Check the room code.' });
    }

    const passwordValid = await bcrypt.compare(password, room.passwordHash);
    if (!passwordValid) {
      return socket.emit('room_error', { message: 'Incorrect room password.' });
    }

    if (room.users.size >= MAX_USERS) {
      return socket.emit('room_error', { message: `Room is full (max ${MAX_USERS} users).` });
    }

    const user = {
      id:          socket.id,
      email,
      displayName: displayName.trim().slice(0, 24),
      bodyColor:   bodyColor || '#3a86ff',
      status:      'green',
      isHost:      false
    };

    room.users.set(socket.id, user);
    sessions.set(socket.id, { roomCode: code });
    socket.join(code);

    const token = jwt.sign(
      { socketId: socket.id, roomCode: code, email },
      JWT_SECRET,
      { expiresIn: '24h' }
    );

    // Send full user list to the joining user
    socket.emit('room_joined', {
      roomCode: code,
      token,
      me:    user,
      users: roomSnapshot(room)
    });

    // Announce arrival to everyone else
    socket.to(code).emit('user_joined', { user });

    console.log(`[Room] "${displayName}" joined ${code} (${room.users.size}/${MAX_USERS})`);
  });

  // ── Set status ────────────────────────────────────────────────
  socket.on('set_status', ({ status }) => {
    if (!['red', 'yellow', 'green'].includes(status)) return;

    const session = sessions.get(socket.id);
    if (!session) return;

    const room = rooms.get(session.roomCode);
    if (!room) return;

    const user = room.users.get(socket.id);
    if (!user) return;

    user.status = status;

    io.to(session.roomCode).emit('status_changed', {
      userId: socket.id,
      status
    });
  });

  // ── Update display name or body color ─────────────────────────
  socket.on('update_profile', ({ displayName, bodyColor }) => {
    const session = sessions.get(socket.id);
    if (!session) return;

    const room = rooms.get(session.roomCode);
    if (!room) return;

    const user = room.users.get(socket.id);
    if (!user) return;

    if (displayName) user.displayName = displayName.trim().slice(0, 24);
    if (bodyColor)   user.bodyColor   = bodyColor;

    io.to(session.roomCode).emit('profile_updated', {
      userId:      socket.id,
      displayName: user.displayName,
      bodyColor:   user.bodyColor
    });
  });

  // ── Disconnect ────────────────────────────────────────────────
  socket.on('disconnect', () => {
    const session = sessions.get(socket.id);
    if (session) {
      const room = rooms.get(session.roomCode);
      if (room) {
        room.users.delete(socket.id);
        io.to(session.roomCode).emit('user_left', { userId: socket.id });

        // Schedule empty-room cleanup after 5 minutes
        if (room.users.size === 0) {
          setTimeout(() => {
            const r = rooms.get(session.roomCode);
            if (r && r.users.size === 0) {
              rooms.delete(session.roomCode);
              console.log(`[Room] ${session.roomCode} cleaned up (empty)`);
            }
          }, 5 * 60 * 1000);
        }
      }
      sessions.delete(socket.id);
    }
    console.log(`[-] Disconnected: ${socket.id}`);
  });
});

// ── REST endpoints ────────────────────────────────────────────────
app.get('/health', (req, res) => {
  res.json({ status: 'ok', rooms: rooms.size, uptime: process.uptime() });
});

// ── Start ─────────────────────────────────────────────────────────
server.listen(PORT, () => {
  console.log(`Stoplight server listening on port ${PORT}`);
});
