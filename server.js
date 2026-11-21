require('dotenv').config();
const path = require('path');
const fs = require('fs');
const http = require('http');
const express = require('express');
const helmet = require('helmet');
const morgan = require('morgan');
const multer = require('multer');
const Database = require('better-sqlite3');
const { Server } = require('socket.io');
const { v4: uuidv4 } = require('uuid');

const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: process.env.NODE_ENV === 'production' ? false : '*' }, maxHttpBufferSize: 1e6 });
const PORT = Number(process.env.PORT || 3000);
const ROOT = __dirname;
const uploadDir = path.join(ROOT, 'uploads');
const dataDir = path.join(ROOT, 'data');

fs.mkdirSync(uploadDir, { recursive: true });
fs.mkdirSync(dataDir, { recursive: true });

const db = new Database(path.join(dataDir, 'puttappu.sqlite'));
db.pragma('journal_mode = WAL');
db.exec(`
CREATE TABLE IF NOT EXISTS users (
 id TEXT PRIMARY KEY, name TEXT NOT NULL, handle TEXT NOT NULL UNIQUE,
 bio TEXT DEFAULT '', avatar TEXT DEFAULT '', created_at TEXT DEFAULT CURRENT_TIMESTAMP,
 updated_at TEXT DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE IF NOT EXISTS rooms (
 id TEXT PRIMARY KEY, title TEXT NOT NULL, club TEXT NOT NULL DEFAULT 'general',
 host_user_id TEXT NOT NULL, created_at TEXT DEFAULT CURRENT_TIMESTAMP, active INTEGER DEFAULT 1
);
`);

app.use(helmet({ contentSecurityPolicy: false }));
app.use(morgan('tiny'));
app.use(express.json({ limit: '1mb' }));
app.use('/uploads', express.static(uploadDir));
app.use(express.static(path.join(ROOT, 'public')));

const upload = multer({
 storage: multer.diskStorage({ destination: uploadDir, filename: (req, file, cb) => cb(null, `${uuidv4()}${path.extname(file.originalname).toLowerCase()}`) }),
 limits: { fileSize: 3 * 1024 * 1024 },
 fileFilter: (req, file, cb) => cb(null, /^image\/(jpeg|png|webp|gif)$/.test(file.mimetype))
});

const cleanUser = row => row && ({ id: row.id, name: row.name, handle: row.handle, bio: row.bio, avatar: row.avatar });
app.get('/api/health', (req, res) => res.json({ ok: true, service: 'PuTtAppu', timestamp: new Date().toISOString() }));
app.post('/api/users', (req, res) => {
  const name = String(req.body.name || '').trim().slice(0, 40);
  const handle = String(req.body.handle || '').trim().toLowerCase().replace(/[^a-z0-9_]/g, '').slice(0, 24);
  const bio = String(req.body.bio || '').trim().slice(0, 160);
  if (!name || handle.length < 3) return res.status(400).json({ error: 'Name and a 3+ character username are required.' });
  const id = req.body.id && String(req.body.id).slice(0, 64) || uuidv4();
  try {
    db.prepare(`INSERT INTO users(id,name,handle,bio) VALUES(@id,@name,@handle,@bio)
      ON CONFLICT(id) DO UPDATE SET name=excluded.name, handle=excluded.handle, bio=excluded.bio, updated_at=CURRENT_TIMESTAMP`).run({ id, name, handle, bio });
    res.json({ user: cleanUser(db.prepare('SELECT * FROM users WHERE id=?').get(id)) });
  } catch (e) { res.status(409).json({ error: 'That username is already taken.' }); }
});
app.get('/api/users/:id', (req, res) => {
  const user = cleanUser(db.prepare('SELECT * FROM users WHERE id=?').get(req.params.id));
  user ? res.json({ user }) : res.status(404).json({ error: 'User not found' });
});
app.post('/api/users/:id/avatar', upload.single('avatar'), (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'Choose a PNG, JPG, WEBP or GIF image up to 3 MB.' });
  const avatar = `/uploads/${req.file.filename}`;
  const result = db.prepare('UPDATE users SET avatar=?, updated_at=CURRENT_TIMESTAMP WHERE id=?').run(avatar, req.params.id);
  if (!result.changes) return res.status(404).json({ error: 'User not found' });
  res.json({ avatar });
});
app.get('/api/rooms', (req, res) => {
  const rooms = db.prepare('SELECT * FROM rooms WHERE active=1 ORDER BY created_at DESC LIMIT 50').all();
  res.json({ rooms: rooms.map(r => ({ id: r.id, title: r.title, club: r.club, hostUserId: r.host_user_id, inviteUrl: `${process.env.PUBLIC_URL || `http://localhost:${PORT}`}/?room=${r.id}` })) });
});

// Socket state is authoritative for current listeners/speakers. SQLite stores room records.
const roomMembers = new Map(); // roomId -> Map(socketId -> participant)
const socketRoom = new Map();
const socketUser = new Map();
function publicMembers(roomId) {
  const members = [...(roomMembers.get(roomId)?.values() || [])];
  return { participants: members, listenerCount: members.filter(x => x.role === 'listener').length, speakerCount: members.filter(x => x.role === 'speaker' || x.role === 'host').length };
}
function broadcastRoom(roomId) { io.to(`room:${roomId}`).emit('room:presence', publicMembers(roomId)); }
function leaveRoom(socket) {
  const roomId = socketRoom.get(socket.id); if (!roomId) return;
  const members = roomMembers.get(roomId); if (members) { members.delete(socket.id); if (!members.size) roomMembers.delete(roomId); }
  socket.leave(`room:${roomId}`); socketRoom.delete(socket.id); broadcastRoom(roomId);
}
io.on('connection', socket => {
  socket.on('profile:set', payload => {
    const id = String(payload?.id || '').slice(0,64);
    const row = id && db.prepare('SELECT * FROM users WHERE id=?').get(id);
    if (row) socketUser.set(socket.id, cleanUser(row));
  });
  socket.on('room:create', ({ title, club }, ack = () => {}) => {
    const user = socketUser.get(socket.id);
    if (!user) return ack({ error: 'Create or load your profile first.' });
    const id = uuidv4().slice(0, 8);
    const roomTitle = String(title || 'PuTtAppu Live Room').trim().slice(0, 70);
    const roomClub = String(club || 'general').slice(0, 30);
    db.prepare('INSERT INTO rooms(id,title,club,host_user_id) VALUES(?,?,?,?)').run(id, roomTitle, roomClub, user.id);
    ack({ roomId: id, inviteUrl: `${process.env.PUBLIC_URL || `http://localhost:${PORT}`}/?room=${id}` });
  });
  socket.on('room:join', ({ roomId, role }, ack = () => {}) => {
    const user = socketUser.get(socket.id);
    const room = db.prepare('SELECT * FROM rooms WHERE id=? AND active=1').get(String(roomId || '').slice(0,40));
    if (!user) return ack({ error: 'Set your profile first.' });
    if (!room) return ack({ error: 'Room not found or closed.' });
    leaveRoom(socket);
    const rid = room.id;
    if (!roomMembers.has(rid)) roomMembers.set(rid, new Map());
    const actualRole = user.id === room.host_user_id ? 'host' : (role === 'speaker' ? 'speaker' : 'listener');
    const participant = { socketId: socket.id, userId: user.id, name: user.name, handle: user.handle, avatar: user.avatar, role: actualRole, joinedAt: Date.now() };
    roomMembers.get(rid).set(socket.id, participant); socketRoom.set(socket.id, rid); socket.join(`room:${rid}`);
    ack({ ok: true, room: { id: room.id, title: room.title, club: room.club }, ...publicMembers(rid) });
    broadcastRoom(rid);
    socket.to(`room:${rid}`).emit('rtc:peer-joined', { socketId: socket.id, participant });
  });
  socket.on('room:role', role => {
    const rid = socketRoom.get(socket.id); const members = roomMembers.get(rid); const p = members?.get(socket.id);
    if (!p || p.role === 'host') return;
    p.role = role === 'speaker' ? 'speaker' : 'listener'; broadcastRoom(rid);
  });
  // WebRTC signaling relay. Media is peer-to-peer; this server does not record audio.
  for (const event of ['rtc:offer', 'rtc:answer', 'rtc:ice']) socket.on(event, payload => {
    const rid = socketRoom.get(socket.id); if (!rid || !payload?.to) return;
    const target = roomMembers.get(rid)?.get(String(payload.to)); if (!target) return;
    io.to(target.socketId).emit(event, { ...payload, from: socket.id });
  });
  socket.on('room:leave', () => leaveRoom(socket));
  socket.on('disconnect', () => { leaveRoom(socket); socketUser.delete(socket.id); });
});

app.get('*', (req, res) => res.sendFile(path.join(ROOT, 'public', 'index.html')));
server.listen(PORT, '0.0.0.0', () => console.log(`PuTtAppu listening on ${PORT}`));
