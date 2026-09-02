// index.js — HTTP + WebSocket sunucusu.
// Statik dosyaları (public/) servis eder ve Socket.io üzerinden tüm oyun
// olaylarını gameManager.js'e devreder.

const path = require('path');
const http = require('http');
const express = require('express');
const { Server } = require('socket.io');

const gm = require('./gameManager');
const db = require('./db');

const PORT = process.env.PORT || 3000;

const app = express();
app.use(express.static(path.join(__dirname, '..', 'public')));

const server = http.createServer(app);
const io = new Server(server, {
  // Cloudflare Tunnel / ngrok gibi ters proxy'lerin arkasında da sorunsuz
  // çalışması için hem websocket hem polling'e izin veriyoruz.
  cors: { origin: '*' },
});

gm.init(io);

function ok(cb, data) {
  if (typeof cb === 'function') cb({ ok: true, ...data });
}
function fail(cb, error) {
  if (typeof cb === 'function') cb({ ok: false, error: String(error && error.message || error) });
}

io.on('connection', (socket) => {
  socket.on('room:create', ({ nickname, clientToken } = {}, cb) => {
    try {
      if (!clientToken) throw new Error('MISSING_TOKEN');
      const room = gm.createRoom(String(nickname || 'Oyuncu').trim().slice(0, 20) || 'Oyuncu');
      const { player } = gm.joinRoom(socket, room.code, clientToken, nickname);
      ok(cb, { code: room.code, player: { nickname: player.nickname, isHost: player.isHost } });
    } catch (err) {
      fail(cb, err);
    }
  });

  socket.on('room:join', ({ code, nickname, clientToken } = {}, cb) => {
    try {
      if (!clientToken) throw new Error('MISSING_TOKEN');
      if (!code) throw new Error('MISSING_CODE');
      const { room, player } = gm.joinRoom(socket, code, clientToken, nickname);

      // Katılan kişiye o an geçerli sohbet geçmişini gönder (en azından lobi).
      const history = db.getChatHistory(room.roomId, 'lobby', 50);
      history.forEach((m) =>
        socket.emit('chat:message', { id: m.id, nickname: m.nickname, channel: m.channel, message: m.message, createdAt: m.created_at })
      );

      ok(cb, { code: room.code, player: { nickname: player.nickname, isHost: player.isHost } });
    } catch (err) {
      fail(cb, err);
    }
  });

  socket.on('game:start', (_payload, cb) => {
    try {
      gm.startGame(socket);
      ok(cb, {});
    } catch (err) {
      fail(cb, err);
    }
  });

  socket.on('night:action', ({ actionType, target } = {}, cb) => {
    try {
      gm.submitNightAction(socket, actionType, target);
      ok(cb, {});
    } catch (err) {
      fail(cb, err);
    }
  });

  socket.on('day:vote', ({ target } = {}, cb) => {
    try {
      gm.submitVote(socket, target);
      ok(cb, {});
    } catch (err) {
      fail(cb, err);
    }
  });

  socket.on('chat:send', ({ message } = {}, cb) => {
    try {
      gm.sendChat(socket, message);
      ok(cb, {});
    } catch (err) {
      fail(cb, err);
    }
  });

  socket.on('game:playAgain', (_payload, cb) => {
    try {
      gm.playAgain(socket);
      ok(cb, {});
    } catch (err) {
      fail(cb, err);
    }
  });

  socket.on('game:forceEnd', (_payload, cb) => {
    try {
      gm.forceEndGame(socket);
      ok(cb, {});
    } catch (err) {
      fail(cb, err);
    }
  });

  socket.on('player:revealRole', (_payload, cb) => {
    try {
      gm.revealOwnRole(socket);
      ok(cb, {});
    } catch (err) {
      fail(cb, err);
    }
  });

  socket.on('player:lastWords', ({ message } = {}, cb) => {
    try {
      gm.sendLastWords(socket, message);
      ok(cb, {});
    } catch (err) {
      fail(cb, err);
    }
  });

  socket.on('disconnect', () => {
    gm.handleDisconnect(socket);
  });
});

server.listen(PORT, () => {
  console.log(`Vampir Köyü sunucusu çalışıyor: http://localhost:${PORT}`);
});
