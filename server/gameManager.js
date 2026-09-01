// gameManager.js — Oda/oyun durum makinesi.
//
// Oyunun ANLIK durumu (kim hayatta, hangi fazdayız, kim kime oy verdi...)
// burada, sunucu belleğinde (RAM) tutulur — çünkü saniyeler içinde çok
// sayıda olay tetiklenir ve her seferinde diske gitmek gereksiz olur.
// Kalıcı olması gereken şeyler (oda kaydı, oyun sonucu, geçmiş, sohbet
// günlüğü) db.js üzerinden SQLite'a yazılır.
//
// NOT: Sunucu yeniden başlatılırsa bellekteki canlı odalar sıfırlanır
// (SQLite'daki geçmiş kayıtlar kalır). Bu, birkaç arkadaş arası bir parti
// oyunu için kabul edilebilir bir basitliktir.

const { customAlphabet } = require('nanoid');
const db = require('./db');
const { ROLES, MIN_PLAYERS, assignRoles, shuffle } = require('./roles');

const genCode = customAlphabet('ABCDEFGHJKLMNPQRSTUVWXYZ23456789', 5); // karışabilecek karakterler (I, O, 0, 1) çıkarıldı

const NIGHT_MS = 25_000;
const DAY_DISCUSSION_MS = 60_000;
const DAY_VOTE_MS = 45_000;

// Sohbette her oyuncuya atanan takma isim rengi. Koyu zeminde okunaklı,
// birbirinden belirgin şekilde ayırt edilebilir tonlar. #ffd166 (host
// etiketi/rol adı rengi) ile karışmasın diye palette dahil edilmedi.
const CHAT_COLOR_PALETTE = [
  '#5ec8ff', // açık mavi
  '#ff8a65', // mercan turuncu
  '#8bd450', // yeşil
  '#c792ea', // lila
  '#ff6fa8', // pembe
  '#4fd4c4', // turkuaz
  '#ffab40', // amber
  '#82aaff', // indigo
  '#e57373', // kırmızımsı
  '#a1887f', // toprak tonu
  '#69f0ae', // nane yeşili
  '#f06292', // fuşya
];

// Oyuncu dizisine, mümkün olduğunca birbirinden farklı renkler ata (palet
// karıştırılır, oyuncu sayısı paleti aşarsa baştan tekrar döner).
function assignChatColors(players) {
  const shuffledColors = shuffle(CHAT_COLOR_PALETTE);
  players.forEach((p, i) => {
    p.color = shuffledColors[i % shuffledColors.length];
  });
}

// Lobiye yeni katılan tek bir oyuncuya, odadaki diğerleriyle çakışmayan
// (mümkünse) bir renk seçer. Oyun başladığında zaten assignChatColors ile
// herkese toptan taze renk verilecek; bu sadece lobi sohbeti içindir.
function pickColorForNewPlayer(room) {
  const used = new Set([...room.players.values()].map((p) => p.color).filter(Boolean));
  const available = CHAT_COLOR_PALETTE.filter((c) => !used.has(c));
  const pool = available.length > 0 ? available : CHAT_COLOR_PALETTE;
  return pool[Math.floor(Math.random() * pool.length)];
}

/** @type {Map<string, any>} oda kodu -> oda durumu */
const rooms = new Map();

let ioRef = null;
function init(io) {
  ioRef = io;
}

function clearRoomTimer(room) {
  if (room.timer) {
    clearTimeout(room.timer);
    room.timer = null;
  }
}

function alivePlayers(room) {
  return [...room.players.values()].filter((p) => p.alive);
}

function playerBySocket(socket) {
  const code = socket.data.roomCode;
  const token = socket.data.clientToken;
  if (!code || !token) return {};
  const room = rooms.get(code);
  if (!room) return {};
  return { room, player: room.players.get(token) };
}

// ---------- Genel yayın yardımcıları ----------

function publicPlayerView(room, p) {
  // Bir oyuncu öldüğünde rolü OTOMATİK açıklanmaz — kendisi isterse
  // (player:revealRole ile) diğerlerine gösterebilir. Oyun bittiğinde ise
  // herkesin rolü zaten açıklanır.
  const revealRole = room.phase === 'game_over' || !!p.revealed;
  return {
    nickname: p.nickname,
    isHost: p.isHost,
    alive: p.alive,
    connected: p.connected,
    revealed: !!p.revealed,
    role: revealRole ? p.role : undefined,
    color: p.color || null,
  };
}

function broadcastRoomState(room) {
  const state = {
    code: room.code,
    name: room.name,
    phase: room.phase,
    round: room.round,
    phaseEndsAt: room.phaseEndsAt,
    players: [...room.players.values()].map((p) => publicPlayerView(room, p)),
  };
  ioRef.to(room.code).emit('room:state', state);
}

function emitToPlayer(room, clientToken, event, payload) {
  const p = room.players.get(clientToken);
  if (p && p.socketId) ioRef.to(p.socketId).emit(event, payload);
}

function emitToTeam(room, roleKey, event, payload) {
  for (const p of room.players.values()) {
    if (p.role === roleKey && p.alive && p.socketId) ioRef.to(p.socketId).emit(event, payload);
  }
}

function sendRolePrivately(room, player) {
  if (!player.socketId || !player.role) return;
  ioRef.to(player.socketId).emit('role:assigned', {
    role: player.role,
    info: ROLES[player.role],
    teammates:
      player.role === 'vampire'
        ? [...room.players.values()]
            .filter((p) => p.role === 'vampire' && p.clientToken !== player.clientToken)
            .map((p) => p.nickname)
        : [],
  });
}

// ---------- Oda yönetimi ----------

function createRoom(hostNickname) {
  let code;
  do {
    code = genCode();
  } while (rooms.has(code));

  const name = `${hostNickname} Odası`;
  const dbRoom = db.createRoom(code, name);
  const room = {
    code,
    roomId: dbRoom.id,
    name,
    phase: 'lobby',
    round: 0,
    gameId: null,
    hostToken: null,
    players: new Map(), // clientToken -> player
    night: null,
    dayVotes: new Map(),
    timer: null,
    phaseEndsAt: null,
  };
  rooms.set(code, room);
  return room;
}

function roomExists(code) {
  return rooms.has(String(code || '').toUpperCase());
}

function joinRoom(socket, code, clientToken, nickname) {
  code = String(code || '').toUpperCase();
  const room = rooms.get(code);
  if (!room) throw new Error('ROOM_NOT_FOUND');

  const existing = room.players.get(clientToken);
  if (!existing && room.phase !== 'lobby') {
    throw new Error('GAME_IN_PROGRESS');
  }

  let player;
  if (existing) {
    existing.socketId = socket.id;
    existing.connected = true;
    if (nickname && nickname.trim()) existing.nickname = nickname.trim().slice(0, 20);
    player = existing;
  } else {
    const isHost = room.players.size === 0;
    const cleanNick = String(nickname || 'Oyuncu').trim().slice(0, 20) || 'Oyuncu';
    const dbPlayer = db.addPlayer(room.roomId, clientToken, cleanNick, isHost);
    player = {
      id: dbPlayer.id,
      clientToken,
      nickname: cleanNick,
      role: null,
      alive: true,
      revealed: false,
      isHost,
      connected: true,
      socketId: socket.id,
      color: null,
    };
    player.color = pickColorForNewPlayer(room);
    room.players.set(clientToken, player);
    if (isHost) room.hostToken = clientToken;
  }

  socket.join(code);
  socket.data.roomCode = code;
  socket.data.clientToken = clientToken;

  // Oyun ortasında yeniden bağlanan oyuncuya rolünü tekrar hatırlat.
  if (room.phase !== 'lobby' && player.role) {
    sendRolePrivately(room, player);
  }

  broadcastRoomState(room);
  return { room, player };
}

function handleDisconnect(socket) {
  const { room, player } = playerBySocket(socket);
  if (!room || !player) return;
  if (player.socketId !== socket.id) return; // zaten başka bir soketle yeniden bağlanmış, bunu yok say

  if (room.phase === 'lobby') {
    // Lobide bağlantısı kopan oyuncunun henüz kaybedecek bir oyun durumu
    // (rol, oy vb.) yok — listeden tamamen kaldır ki sayaç doğru kalsın.
    room.players.delete(player.clientToken);
    if (room.hostToken === player.clientToken) {
      const next = room.players.values().next().value;
      room.hostToken = next ? next.clientToken : null;
      if (next) next.isHost = true;
    }
  } else {
    // Oyun sürüyorsa oyuncuyu koru (rolü/oyu kaybolmasın) — sadece
    // "bağlantı yok" olarak işaretle, aynı token ile geri dönebilsin.
    player.connected = false;
    player.socketId = null;
  }
  broadcastRoomState(room);
}

// ---------- Oyun akışı ----------

function startGame(socket) {
  const code = socket.data.roomCode;
  const room = rooms.get(code);
  if (!room) throw new Error('ROOM_NOT_FOUND');
  if (socket.data.clientToken !== room.hostToken) throw new Error('NOT_HOST');
  if (room.phase !== 'lobby') throw new Error('ALREADY_STARTED');
  const players = [...room.players.values()];
  if (players.length < MIN_PLAYERS) throw new Error('NOT_ENOUGH_PLAYERS');

  const assignment = assignRoles(players);
  for (const p of players) {
    p.role = assignment.get(p.clientToken);
    p.alive = true;
    p.revealed = false;
    db.setPlayerRole(p.id, p.role);
  }
  // Her yeni oyunda herkese taze, birbirinden ayırt edilebilir sohbet
  // rengi ata (sohbetteki isim bu renkle yazılır).
  assignChatColors(players);

  room.gameId = db.createGame(room.roomId);
  room.round = 1;
  db.setRoomStatus(room.roomId, 'playing');

  for (const p of players) sendRolePrivately(room, p);

  startNightPhase(room);
}

function startNightPhase(room) {
  clearRoomTimer(room);
  room.phase = 'night';
  room.night = { vampireVotes: new Map(), doctorProtect: null };
  room.phaseEndsAt = Date.now() + NIGHT_MS;
  broadcastRoomState(room);
  room.timer = setTimeout(() => resolveNight(room), NIGHT_MS);
}

function requiredNightActionsDone(room) {
  const alive = alivePlayers(room);
  const vampires = alive.filter((p) => p.role === 'vampire');
  const doctor = alive.find((p) => p.role === 'doctor');
  const vampiresDone = vampires.length === 0 || vampires.every((v) => room.night.vampireVotes.has(v.clientToken));
  const doctorDone = !doctor || !!room.night.doctorProtect;
  return vampiresDone && doctorDone;
}

function submitNightAction(socket, actionType, targetNickname) {
  const { room, player } = playerBySocket(socket);
  if (!room || !player) throw new Error('NOT_IN_ROOM');
  if (room.phase !== 'night') throw new Error('WRONG_PHASE');
  if (!player.alive) throw new Error('DEAD');

  const target = [...room.players.values()].find((p) => p.nickname === targetNickname && p.alive);
  if (!target) throw new Error('INVALID_TARGET');

  if (actionType === 'vampire_vote') {
    if (player.role !== 'vampire') throw new Error('WRONG_ROLE');
    room.night.vampireVotes.set(player.clientToken, target.clientToken);
    emitToTeam(room, 'vampire', 'night:vampireProgress', {
      votes: [...room.night.vampireVotes.entries()].map(([voter, t]) => ({
        voter: room.players.get(voter).nickname,
        target: room.players.get(t).nickname,
      })),
    });
  } else if (actionType === 'doctor_protect') {
    if (player.role !== 'doctor') throw new Error('WRONG_ROLE');
    room.night.doctorProtect = target.clientToken;
    emitToPlayer(room, player.clientToken, 'night:doctorConfirm', { targetNickname: target.nickname });
  } else {
    throw new Error('UNKNOWN_ACTION');
  }

  if (requiredNightActionsDone(room)) {
    clearRoomTimer(room);
    resolveNight(room);
  }
}

function tallyVotes(voteMap, eligibleTokens) {
  // voteMap: clientToken(oy veren) -> clientToken(hedef) | 'skip'
  const counts = new Map();
  for (const target of voteMap.values()) {
    if (target === 'skip') continue;
    counts.set(target, (counts.get(target) || 0) + 1);
  }
  let max = 0;
  let winners = [];
  for (const [target, c] of counts.entries()) {
    if (!eligibleTokens.has(target)) continue;
    if (c > max) {
      max = c;
      winners = [target];
    } else if (c === max) {
      winners.push(target);
    }
  }
  if (winners.length !== 1 || max === 0) return null; // eşitlik ya da hiç oy yok -> kimse elenmez
  return winners[0];
}

function resolveNight(room) {
  clearRoomTimer(room);
  const aliveTokens = new Set(alivePlayers(room).map((p) => p.clientToken));
  const victimToken = tallyVotes(room.night.vampireVotes, aliveTokens);
  let announcement;
  let died = null;

  if (victimToken) {
    const victim = room.players.get(victimToken);
    const saved = room.night.doctorProtect === victimToken;
    if (saved) {
      announcement = 'Doktor bu gece birini kurtardı! Kimse hayatını kaybetmedi.';
      db.addGameLog(room.roomId, room.gameId, room.round, 'night', 'save', 'Doktor', victim.nickname, null);
    } else {
      victim.alive = false;
      db.setPlayerAlive(victim.id, false);
      announcement = `${victim.nickname} gece vampirler tarafından öldürüldü.`;
      db.addGameLog(room.roomId, room.gameId, room.round, 'night', 'kill', 'Vampirler', victim.nickname, null);
      died = victim.nickname;
    }
  } else {
    announcement = 'Bu gece kimse ölmedi.';
  }

  const winner = checkWinCondition(room);
  if (winner) {
    endGame(room, winner, announcement);
    return;
  }
  startDayDiscussion(room, announcement, died);
}

function startDayDiscussion(room, announcement, died) {
  clearRoomTimer(room);
  room.phase = 'day_discussion';
  room.phaseEndsAt = Date.now() + DAY_DISCUSSION_MS;
  ioRef.to(room.code).emit('day:announcement', { announcement, round: room.round, died: died || null });
  broadcastRoomState(room);
  room.timer = setTimeout(() => startDayVote(room), DAY_DISCUSSION_MS);
}

function startDayVote(room) {
  clearRoomTimer(room);
  room.phase = 'day_vote';
  room.dayVotes = new Map();
  room.phaseEndsAt = Date.now() + DAY_VOTE_MS;
  broadcastRoomState(room);
  room.timer = setTimeout(() => resolveDayVote(room), DAY_VOTE_MS);
}

function broadcastVoteTally(room) {
  const tally = {};
  for (const [voter, target] of room.dayVotes.entries()) {
    const voterName = room.players.get(voter)?.nickname;
    const targetName = target === 'skip' ? 'Çekimser' : room.players.get(target)?.nickname;
    tally[voterName] = targetName;
  }
  ioRef.to(room.code).emit('day:voteProgress', { tally });
}

function submitVote(socket, targetNickname) {
  const { room, player } = playerBySocket(socket);
  if (!room || !player) throw new Error('NOT_IN_ROOM');
  if (room.phase !== 'day_vote') throw new Error('WRONG_PHASE');
  if (!player.alive) throw new Error('DEAD');

  if (targetNickname === 'skip') {
    room.dayVotes.set(player.clientToken, 'skip');
  } else {
    const target = [...room.players.values()].find((p) => p.nickname === targetNickname && p.alive);
    if (!target) throw new Error('INVALID_TARGET');
    room.dayVotes.set(player.clientToken, target.clientToken);
  }

  broadcastVoteTally(room);

  const alive = alivePlayers(room);
  if (room.dayVotes.size >= alive.length) {
    clearRoomTimer(room);
    resolveDayVote(room);
  }
}

function resolveDayVote(room) {
  clearRoomTimer(room);
  const aliveTokens = new Set(alivePlayers(room).map((p) => p.clientToken));
  const lynchedToken = tallyVotes(room.dayVotes, aliveTokens);
  let announcement;
  let died = null;
  let lynchedPlayer = null;

  if (lynchedToken) {
    lynchedPlayer = room.players.get(lynchedToken);
    lynchedPlayer.alive = false;
    db.setPlayerAlive(lynchedPlayer.id, false);
    announcement = `Oylama sonucunda ${lynchedPlayer.nickname} asıldı. Rolü: ${ROLES[lynchedPlayer.role].name}.`;
    db.addGameLog(room.roomId, room.gameId, room.round, 'day_vote', 'lynch', 'Köy', lynchedPlayer.nickname, lynchedPlayer.role);
    died = lynchedPlayer.nickname;
  } else {
    announcement = 'Oylama sonuçlandı ama kimse asılmadı.';
  }

  ioRef.to(room.code).emit('day:result', { announcement, died });

  // Soytarı asılırsa oyunu tek başına anında kazanır, oyun orada biter.
  if (lynchedPlayer && lynchedPlayer.role === 'jester') {
    endGame(room, 'jester', announcement, `${lynchedPlayer.nickname} (Soytarı) — Kazandı!`);
    return;
  }

  const winner = checkWinCondition(room);
  if (winner) {
    endGame(room, winner, announcement);
    return;
  }
  room.round += 1;
  startNightPhase(room);
}

function checkWinCondition(room) {
  const alive = alivePlayers(room);
  const vampireCount = alive.filter((p) => p.role === 'vampire').length;
  const otherCount = alive.length - vampireCount;
  if (vampireCount === 0) return 'villagers';
  if (vampireCount >= otherCount) return 'vampires';
  return null;
}

const WINNER_LABELS = {
  villagers: 'Köylüler',
  vampires: 'Vampirler',
  aborted: 'Kimse — oyun erken bitirildi',
};

function endGame(room, winner, lastAnnouncement, winnerLabelOverride) {
  clearRoomTimer(room);
  room.phase = 'game_over';
  db.endGame(room.gameId, winner);
  db.setRoomStatus(room.roomId, 'finished');
  db.addGameLog(room.roomId, room.gameId, room.round, 'game_over', 'game_over', null, null, winner);

  const roles = [...room.players.values()].map((p) => ({ nickname: p.nickname, role: p.role, alive: p.alive }));
  ioRef.to(room.code).emit('game:over', {
    winner, // 'villagers' | 'vampires' | 'aborted' | 'jester'
    winnerLabel: winnerLabelOverride || WINNER_LABELS[winner] || winner,
    lastAnnouncement,
    roles,
  });
  broadcastRoomState(room);
}

// Host, devam eden bir oyunu (gece/gündüz fark etmez) istediği an iptal edip
// herkesin rollerini açığa çıkararak bitirebilir. Kazanan taraf yok — 'aborted'.
function forceEndGame(socket) {
  const code = socket.data.roomCode;
  const room = rooms.get(code);
  if (!room) throw new Error('ROOM_NOT_FOUND');
  if (socket.data.clientToken !== room.hostToken) throw new Error('NOT_HOST');
  if (!['night', 'day_discussion', 'day_vote'].includes(room.phase)) throw new Error('WRONG_PHASE');
  endGame(room, 'aborted', 'Oyun host tarafından erken bitirildi.');
}

function playAgain(socket) {
  const code = socket.data.roomCode;
  const room = rooms.get(code);
  if (!room) throw new Error('ROOM_NOT_FOUND');
  if (socket.data.clientToken !== room.hostToken) throw new Error('NOT_HOST');
  if (room.phase !== 'game_over') throw new Error('GAME_NOT_OVER');

  for (const p of room.players.values()) {
    p.role = null;
    p.alive = true;
    p.revealed = false;
  }
  db.resetPlayersForNewGame(room.roomId);
  db.setRoomStatus(room.roomId, 'lobby');
  room.phase = 'lobby';
  room.round = 0;
  room.gameId = null;
  room.night = null;
  room.dayVotes = new Map();
  room.phaseEndsAt = null;
  broadcastRoomState(room);
}

// Ölen bir oyuncu isterse rolünü diğer herkese açıklayabilir. Otomatik
// değildir — sadece kendisi bu olayı tetikleyebilir.
function revealOwnRole(socket) {
  const { room, player } = playerBySocket(socket);
  if (!room || !player) throw new Error('NOT_IN_ROOM');
  if (player.alive) throw new Error('NOT_DEAD');
  if (player.revealed) return; // zaten açık, sessizce yok say
  player.revealed = true;
  broadcastRoomState(room);
}

// ---------- Sohbet ----------

function sendChat(socket, message) {
  const { room, player } = playerBySocket(socket);
  if (!room || !player) throw new Error('NOT_IN_ROOM');
  const text = String(message || '').trim().slice(0, 500);
  if (!text) return;

  let channel;
  if (room.phase === 'lobby') {
    channel = 'lobby';
  } else if (!player.alive) {
    channel = 'dead';
  } else if (player.role === 'vampire' && room.phase === 'night') {
    channel = 'vampire';
  } else if (room.phase === 'day_discussion' || room.phase === 'day_vote') {
    channel = 'day';
  } else {
    throw new Error('CANNOT_CHAT_NOW');
  }

  const row = db.addChatMessage(room.roomId, player.nickname, channel, text);
  const payload = { id: row.id, nickname: player.nickname, channel, message: text, createdAt: row.created_at };

  if (channel === 'lobby' || channel === 'day') {
    ioRef.to(room.code).emit('chat:message', payload);
  } else if (channel === 'vampire') {
    emitToTeam(room, 'vampire', 'chat:message', payload);
  } else if (channel === 'dead') {
    for (const p of room.players.values()) {
      if (!p.alive && p.socketId) ioRef.to(p.socketId).emit('chat:message', payload);
    }
  }
}

module.exports = {
  init,
  createRoom,
  roomExists,
  joinRoom,
  handleDisconnect,
  startGame,
  submitNightAction,
  submitVote,
  sendChat,
  playAgain,
  forceEndGame,
  revealOwnRole,
  rooms,
};
