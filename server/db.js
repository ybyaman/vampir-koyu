// db.js — SQLite kalıcı katmanı (better-sqlite3, senkron API).
// Oyunun ANLIK durumu (kim hayatta, sıra kimde, geri sayım vb.) bilerek
// burada tutulmaz — o gameManager.js içinde bellekte yaşar. Bu dosya sadece
// kalıcı olması gereken şeyleri saklar: oda/oyuncu kayıtları, oyun geçmişi,
// gece/gündüz olay günlüğü ve sohbet mesajları.

const path = require('path');
const fs = require('fs');
const Database = require('better-sqlite3');

const DATA_DIR = path.join(__dirname, '..', 'data');
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

const db = new Database(path.join(DATA_DIR, 'vampirkoyu.db'));
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

db.exec(`
CREATE TABLE IF NOT EXISTS rooms (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  code        TEXT UNIQUE NOT NULL,
  name        TEXT NOT NULL,
  status      TEXT NOT NULL DEFAULT 'lobby',   -- lobby | playing | finished
  created_at  TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS players (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  room_id       INTEGER NOT NULL REFERENCES rooms(id) ON DELETE CASCADE,
  client_token  TEXT NOT NULL,        -- tarayıcının localStorage'da tuttuğu, oyuncuyu tanımlayan token
  nickname      TEXT NOT NULL,
  role          TEXT,                 -- villager | vampire | jester | doctor
  is_alive      INTEGER NOT NULL DEFAULT 1,
  is_host       INTEGER NOT NULL DEFAULT 0,
  joined_at     TEXT NOT NULL DEFAULT (datetime('now')),
  left_at       TEXT,
  UNIQUE(room_id, client_token)
);

CREATE TABLE IF NOT EXISTS games (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  room_id       INTEGER NOT NULL REFERENCES rooms(id) ON DELETE CASCADE,
  started_at    TEXT NOT NULL DEFAULT (datetime('now')),
  ended_at      TEXT,
  winner        TEXT                  -- villagers | vampires | null (devam ediyor)
);

CREATE TABLE IF NOT EXISTS game_logs (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  room_id         INTEGER NOT NULL REFERENCES rooms(id) ON DELETE CASCADE,
  game_id         INTEGER NOT NULL REFERENCES games(id) ON DELETE CASCADE,
  round_number    INTEGER NOT NULL,
  phase           TEXT NOT NULL,       -- night | day_discussion | day_vote
  event_type      TEXT NOT NULL,       -- kill | save | check | vote | lynch | game_over ...
  actor_nickname  TEXT,
  target_nickname TEXT,
  detail          TEXT,
  created_at      TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS chat_messages (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  room_id     INTEGER NOT NULL REFERENCES rooms(id) ON DELETE CASCADE,
  nickname    TEXT NOT NULL,
  channel     TEXT NOT NULL DEFAULT 'lobby',  -- lobby | day | dead | vampire
  message     TEXT NOT NULL,
  created_at  TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS users (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  email          TEXT UNIQUE NOT NULL COLLATE NOCASE,
  username       TEXT UNIQUE NOT NULL COLLATE NOCASE,
  password_hash  TEXT NOT NULL,
  created_at     TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS sessions (
  token       TEXT PRIMARY KEY,
  user_id     INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at  TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS game_players (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  game_id       INTEGER NOT NULL REFERENCES games(id) ON DELETE CASCADE,
  room_id       INTEGER NOT NULL REFERENCES rooms(id) ON DELETE CASCADE,
  user_id       INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  nickname      TEXT NOT NULL,
  role          TEXT NOT NULL,
  team          TEXT NOT NULL,
  alive_at_end  INTEGER NOT NULL DEFAULT 0,
  won           INTEGER NOT NULL DEFAULT 0,
  created_at    TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_players_room ON players(room_id);
CREATE INDEX IF NOT EXISTS idx_logs_room_game ON game_logs(room_id, game_id);
CREATE INDEX IF NOT EXISTS idx_chat_room_channel ON chat_messages(room_id, channel);
CREATE INDEX IF NOT EXISTS idx_sessions_user ON sessions(user_id);
CREATE INDEX IF NOT EXISTS idx_game_players_user ON game_players(user_id);
CREATE INDEX IF NOT EXISTS idx_game_players_game ON game_players(game_id);
`);

// ---------- Odalar ----------

function createRoom(code, name) {
  const stmt = db.prepare('INSERT INTO rooms (code, name) VALUES (?, ?)');
  const info = stmt.run(code, name);
  return getRoomById(info.lastInsertRowid);
}

function getRoomByCode(code) {
  return db.prepare('SELECT * FROM rooms WHERE code = ?').get(code);
}

function getRoomById(id) {
  return db.prepare('SELECT * FROM rooms WHERE id = ?').get(id);
}

function setRoomStatus(roomId, status) {
  db.prepare('UPDATE rooms SET status = ? WHERE id = ?').run(status, roomId);
}

// ---------- Oyuncular ----------

function addPlayer(roomId, clientToken, nickname, isHost) {
  const stmt = db.prepare(`
    INSERT INTO players (room_id, client_token, nickname, is_host)
    VALUES (?, ?, ?, ?)
    ON CONFLICT(room_id, client_token) DO UPDATE SET
      nickname = excluded.nickname,
      left_at = NULL
  `);
  stmt.run(roomId, clientToken, nickname, isHost ? 1 : 0);
  return getPlayerByToken(roomId, clientToken);
}

function getPlayerByToken(roomId, clientToken) {
  return db.prepare('SELECT * FROM players WHERE room_id = ? AND client_token = ?')
    .get(roomId, clientToken);
}

function getPlayersByRoom(roomId) {
  return db.prepare('SELECT * FROM players WHERE room_id = ? ORDER BY id ASC').all(roomId);
}

function setPlayerRole(playerId, role) {
  db.prepare('UPDATE players SET role = ? WHERE id = ?').run(role, playerId);
}

function setPlayerAlive(playerId, alive) {
  db.prepare('UPDATE players SET is_alive = ? WHERE id = ?').run(alive ? 1 : 0, playerId);
}

function markPlayerLeft(playerId) {
  db.prepare("UPDATE players SET left_at = datetime('now') WHERE id = ?").run(playerId);
}

function resetPlayersForNewGame(roomId) {
  db.prepare('UPDATE players SET role = NULL, is_alive = 1 WHERE room_id = ?').run(roomId);
}

// ---------- Oyunlar ----------

function createGame(roomId) {
  const info = db.prepare('INSERT INTO games (room_id) VALUES (?)').run(roomId);
  return info.lastInsertRowid;
}

function endGame(gameId, winner) {
  db.prepare("UPDATE games SET ended_at = datetime('now'), winner = ? WHERE id = ?")
    .run(winner, gameId);
}

// ---------- Olay günlüğü ----------

function addGameLog(roomId, gameId, roundNumber, phase, eventType, actorNickname, targetNickname, detail) {
  db.prepare(`
    INSERT INTO game_logs (room_id, game_id, round_number, phase, event_type, actor_nickname, target_nickname, detail)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).run(roomId, gameId, roundNumber, phase, eventType, actorNickname || null, targetNickname || null, detail || null);
}

function getGameLogs(gameId) {
  return db.prepare('SELECT * FROM game_logs WHERE game_id = ? ORDER BY id ASC').all(gameId);
}

// ---------- Sohbet ----------

function addChatMessage(roomId, nickname, channel, message) {
  const info = db.prepare(`
    INSERT INTO chat_messages (room_id, nickname, channel, message)
    VALUES (?, ?, ?, ?)
  `).run(roomId, nickname, channel, message);
  return db.prepare('SELECT * FROM chat_messages WHERE id = ?').get(info.lastInsertRowid);
}

function getChatHistory(roomId, channel, limit = 100) {
  return db.prepare(`
    SELECT * FROM chat_messages WHERE room_id = ? AND channel = ?
    ORDER BY id DESC LIMIT ?
  `).all(roomId, channel, limit).reverse();
}

// ---------- Oyun-oyuncu geçmişi (profil/istatistik sayfası için) ----------
// Her BİTEN oyun için, o oyunda yer alan her hesaplı oyuncunun rolünü,
// takımını, oyun sonunda hayatta olup olmadığını ve kazanıp kazanmadığını
// tek bir satır olarak burada saklıyoruz. `players` tablosu odanın ANLIK
// durumunu tuttuğu (yeni oyunda role/is_alive sıfırlanır) için geçmiş
// istatistik burada, ayrı ve kalıcı bir tabloda tutulmalı.
function addGamePlayers(rows) {
  if (!rows || rows.length === 0) return;
  const stmt = db.prepare(`
    INSERT INTO game_players (game_id, room_id, user_id, nickname, role, team, alive_at_end, won)
    VALUES (@gameId, @roomId, @userId, @nickname, @role, @team, @aliveAtEnd, @won)
  `);
  const insertMany = db.transaction((items) => {
    for (const item of items) stmt.run(item);
  });
  insertMany(rows);
}

function getUserGameSummary(userId) {
  return db.prepare(`
    SELECT COUNT(*) AS gamesPlayed, COALESCE(SUM(won), 0) AS wins
    FROM game_players WHERE user_id = ?
  `).get(userId);
}

function getUserRoleBreakdown(userId) {
  return db.prepare(`
    SELECT role, COUNT(*) AS played, COALESCE(SUM(won), 0) AS wins
    FROM game_players WHERE user_id = ?
    GROUP BY role
    ORDER BY played DESC, wins DESC
  `).all(userId);
}

function getUserGameHistory(userId, limit = 20) {
  return db.prepare(`
    SELECT gp.role, gp.team, gp.alive_at_end, gp.won,
           g.id AS gameId, g.started_at, g.ended_at, g.winner,
           r.code AS roomCode, r.name AS roomName
    FROM game_players gp
    JOIN games g ON g.id = gp.game_id
    JOIN rooms r ON r.id = gp.room_id
    WHERE gp.user_id = ?
    ORDER BY g.id DESC
    LIMIT ?
  `).all(userId, limit);
}

// ---------- Kullanıcı hesapları ----------

function createUser(email, username, passwordHash) {
  const info = db.prepare('INSERT INTO users (email, username, password_hash) VALUES (?, ?, ?)')
    .run(email, username, passwordHash);
  return getUserById(info.lastInsertRowid);
}

function getUserById(id) {
  return db.prepare('SELECT * FROM users WHERE id = ?').get(id);
}

function getUserByEmail(email) {
  return db.prepare('SELECT * FROM users WHERE email = ?').get(email);
}

function getUserByUsername(username) {
  return db.prepare('SELECT * FROM users WHERE username = ?').get(username);
}

// ---------- Oturumlar (session) ----------

function createSession(token, userId) {
  db.prepare('INSERT INTO sessions (token, user_id) VALUES (?, ?)').run(token, userId);
}

function getSession(token) {
  return db.prepare('SELECT * FROM sessions WHERE token = ?').get(token);
}

function deleteSession(token) {
  db.prepare('DELETE FROM sessions WHERE token = ?').run(token);
}

module.exports = {
  db,
  createRoom,
  getRoomByCode,
  getRoomById,
  setRoomStatus,
  addPlayer,
  getPlayerByToken,
  getPlayersByRoom,
  setPlayerRole,
  setPlayerAlive,
  markPlayerLeft,
  resetPlayersForNewGame,
  createGame,
  endGame,
  addGameLog,
  getGameLogs,
  addChatMessage,
  getChatHistory,
  addGamePlayers,
  getUserGameSummary,
  getUserRoleBreakdown,
  getUserGameHistory,
  createUser,
  getUserById,
  getUserByEmail,
  getUserByUsername,
  createSession,
  getSession,
  deleteSession,
};
