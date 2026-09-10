// index.js — HTTP + WebSocket sunucusu.
// Statik dosyaları (public/) servis eder ve Socket.io üzerinden tüm oyun
// olaylarını gameManager.js'e devreder.

const path = require('path');
const http = require('http');
const express = require('express');
const { Server } = require('socket.io');

const gm = require('./gameManager');
const db = require('./db');
const auth = require('./auth');

const PORT = process.env.PORT || 3000;

const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, '..', 'public')));

// ---------- Hesap uçları (e-posta + şifre ile kayıt/giriş) ----------
// Not: kendi kendine barındırılan (self-hosted), küçük bir arkadaş grubu
// partisi için tasarlandığından bilinçli olarak sade: e-posta doğrulama ve
// şifre sıfırlama YOK. Oturum token'ı istemcide localStorage'da tutulur ve
// Socket.io bağlantısı kurulurken (handshake) sunucuya gösterilir.
const AUTH_ERROR_STATUS = {
  INVALID_EMAIL: 400,
  WEAK_PASSWORD: 400,
  INVALID_USERNAME: 400,
  EMAIL_TAKEN: 409,
  USERNAME_TAKEN: 409,
  INVALID_CREDENTIALS: 401,
};

app.post('/api/auth/register', (req, res) => {
  try {
    const { token, user } = auth.register(req.body || {});
    res.json({ ok: true, token, user });
  } catch (err) {
    const code = err.message;
    res.status(AUTH_ERROR_STATUS[code] || 400).json({ ok: false, error: code });
  }
});

app.post('/api/auth/login', (req, res) => {
  try {
    const { token, user } = auth.login(req.body || {});
    res.json({ ok: true, token, user });
  } catch (err) {
    const code = err.message;
    res.status(AUTH_ERROR_STATUS[code] || 400).json({ ok: false, error: code });
  }
});

app.post('/api/auth/logout', (req, res) => {
  const header = req.get('authorization') || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : null;
  auth.logout(token);
  res.json({ ok: true });
});

const server = http.createServer(app);
const io = new Server(server, {
  // Cloudflare Tunnel / ngrok gibi ters proxy'lerin arkasında da sorunsuz
  // çalışması için hem websocket hem polling'e izin veriyoruz.
  cors: { origin: '*' },
});

// Her Socket.io bağlantısı, bağlantı kurulurken (handshake) geçerli bir
// oturum token'ı göstermek ZORUNDA — göstermezse bağlantı reddedilir ve
// istemci tarafında 'connect_error' (mesaj: UNAUTHORIZED) olarak görünür.
// Oda/oyuncu kimliği artık istemcinin gönderdiği serbest bir nickname'e
// değil, hesabın kendisine (kullanıcı adına) bağlı.
io.use((socket, next) => {
  const token = socket.handshake.auth && socket.handshake.auth.token;
  const user = auth.getUserBySessionToken(token);
  if (!user) return next(new Error('UNAUTHORIZED'));
  socket.data.userId = user.id;
  socket.data.username = user.username;
  socket.data.clientToken = `u${user.id}`;
  next();
});

gm.init(io);

function ok(cb, data) {
  if (typeof cb === 'function') cb({ ok: true, ...data });
}
function fail(cb, error) {
  if (typeof cb === 'function') cb({ ok: false, error: String(error && error.message || error) });
}

io.on('connection', (socket) => {
  socket.on('room:create', (_payload, cb) => {
    try {
      const room = gm.createRoom(socket.data.username);
      const { player } = gm.joinRoom(socket, room.code, socket.data.clientToken, socket.data.username);
      ok(cb, { code: room.code, player: { nickname: player.nickname, isHost: player.isHost } });
    } catch (err) {
      fail(cb, err);
    }
  });

  socket.on('room:join', ({ code } = {}, cb) => {
    try {
      if (!code) throw new Error('MISSING_CODE');
      const { room, player } = gm.joinRoom(socket, code, socket.data.clientToken, socket.data.username);

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

  // Sesli sohbet: WebRTC teklif/cevap/ICE mesajlarını sunucu SADECE aktarır
  // (relay) — ses verisi asla sunucudan geçmez, tarayıcılar arasında
  // doğrudan (P2P) akar.
  socket.on('voice:signal', ({ to, data } = {}, cb) => {
    try {
      gm.relayVoiceSignal(socket, to, data);
      ok(cb, {});
    } catch (err) {
      fail(cb, err);
    }
  });

  // İstemci sesli sohbeti faz ortasında açarsa, bir sonraki geçişi
  // beklemeden o anki kanal/peer bilgisini isteyebilsin diye.
  socket.on('voice:requestChannel', (_payload, cb) => {
    try {
      gm.requestVoiceChannel(socket);
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
