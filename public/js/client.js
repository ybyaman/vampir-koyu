// client.js — Sunucudan gelen olaylara göre arayüzü güncelleyen, tek
// sayfalık (framework'süz) istemci mantığı.

(() => {
  const socket = io();

  // ---------- Kalıcı istemci kimliği ----------
  // Hesap yok; sadece bu tarayıcıyı diğerlerinden ayırmak ve sayfa
  // yenilenince / bağlantı kopunca aynı oyuncu olarak geri dönebilmek için.
  let clientToken = localStorage.getItem('vk_token');
  if (!clientToken) {
    clientToken = (crypto.randomUUID ? crypto.randomUUID() : String(Math.random()).slice(2));
    localStorage.setItem('vk_token', clientToken);
  }
  const savedNickname = localStorage.getItem('vk_nickname') || '';
  const savedRoom = localStorage.getItem('vk_room') || '';

  const state = {
    code: null,
    nickname: savedNickname,
    isHost: false,
    phase: 'join',
    round: 0,
    players: [],
    phaseEndsAt: null,
    myRole: null,
    roleInfo: null,
    teammates: [],
    alive: true,
    revealed: false,
    lastWordsSaid: false,
    votedNicknames: new Set(),
    nicknameColors: {},
  };

  let previousPhase = null;

  // ---------- Yardımcılar ----------
  const $ = (id) => document.getElementById(id);

  function showScreen(id) {
    document.querySelectorAll('.screen').forEach((s) => s.classList.remove('active'));
    $(id).classList.add('active');
  }

  function toast(msg) {
    const el = $('toast');
    el.textContent = msg;
    el.hidden = false;
    clearTimeout(toast._t);
    toast._t = setTimeout(() => { el.hidden = true; }, 3500);
  }

  function screenForPhase(phase) {
    if (phase === 'lobby') return 'screen-lobby';
    if (phase === 'game_over') return 'screen-gameover';
    return 'screen-game';
  }

  // ---------- Giriş ekranı ----------
  $('nicknameInput').value = savedNickname;

  document.querySelectorAll('.tab-btn').forEach((btn) => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('.tab-btn').forEach((b) => b.classList.remove('active'));
      document.querySelectorAll('.tab-panel').forEach((p) => p.classList.remove('active'));
      btn.classList.add('active');
      $(`tab-${btn.dataset.tab}`).classList.add('active');
    });
  });

  function currentNickname() {
    return ($('nicknameInput').value || '').trim().slice(0, 20);
  }

  function showJoinError(msg) {
    const el = $('joinError');
    el.textContent = msg;
    el.hidden = false;
  }

  const ERROR_MESSAGES = {
    MISSING_TOKEN: 'Bir şeyler ters gitti, sayfayı yenile.',
    MISSING_CODE: 'Oda kodu gerekli.',
    ROOM_NOT_FOUND: 'Bu kodda bir oda bulunamadı. Kodu kontrol et.',
    GAME_IN_PROGRESS: 'Bu odada oyun zaten başlamış, yeni oyuncu giremez.',
    NOT_HOST: 'Bu işlemi sadece oda kurucusu (host) yapabilir.',
    ALREADY_STARTED: 'Oyun zaten başladı.',
    NOT_ENOUGH_PLAYERS: 'Oyunu başlatmak için en az 4 oyuncu gerekiyor.',
    WRONG_PHASE: 'Şu an bu işlem yapılamaz.',
    WRONG_ROLE: 'Bu aksiyon senin rolüne uygun değil.',
    DEAD: 'Öldüğün için bu aksiyonu yapamazsın.',
    INVALID_TARGET: 'Geçersiz hedef.',
    CANNOT_CHAT_NOW: 'Şu an bu kanalda mesaj gönderemezsin.',
    GAME_NOT_OVER: 'Oyun henüz bitmedi.',
    NOT_IN_ROOM: 'Bir odada değilsin.',
    NOT_DEAD: 'Rolünü sadece öldükten sonra açıklayabilirsin.',
    CANNOT_SELF_PROTECT_TWICE: 'Art arda iki gece kendini koruyamazsın — başka birini seç.',
    ALREADY_SAID: 'Son sözünü zaten söyledin.',
    EMPTY_MESSAGE: 'Boş mesaj gönderemezsin.',
  };
  function friendlyError(err) {
    return ERROR_MESSAGES[err] || err || 'Bilinmeyen hata';
  }

  $('createRoomBtn').addEventListener('click', () => {
    const nickname = currentNickname();
    if (!nickname) return showJoinError('Lütfen bir takma isim gir.');
    $('joinError').hidden = true;
    socket.emit('room:create', { nickname, clientToken }, (res) => {
      if (!res.ok) return showJoinError(friendlyError(res.error));
      afterJoinSuccess(res);
    });
  });

  $('joinRoomBtn').addEventListener('click', () => {
    const nickname = currentNickname();
    const code = ($('roomCodeInput').value || '').trim().toUpperCase();
    if (!nickname) return showJoinError('Lütfen bir takma isim gir.');
    if (!code) return showJoinError('Lütfen oda kodunu gir.');
    $('joinError').hidden = true;
    socket.emit('room:join', { code, nickname, clientToken }, (res) => {
      if (!res.ok) return showJoinError(friendlyError(res.error));
      afterJoinSuccess(res);
    });
  });

  function afterJoinSuccess(res) {
    state.code = res.code;
    state.nickname = res.player.nickname;
    state.isHost = res.player.isHost;
    localStorage.setItem('vk_nickname', state.nickname);
    localStorage.setItem('vk_room', state.code);
    $('roomBadge').hidden = false;
    $('roomCodeLabel').textContent = state.code;
    // room:state olayı ekranı doğru faza göre zaten açacak.
  }

  $('copyLinkBtn').addEventListener('click', async () => {
    const url = `${location.origin}/?room=${state.code}`;
    try {
      await navigator.clipboard.writeText(url);
      toast('Davet linki kopyalandı!');
    } catch {
      toast(url);
    }
  });

  // URL'de ?room=KOD varsa katılma sekmesini aç ve kodu doldur.
  const urlRoom = new URLSearchParams(location.search).get('room');
  if (urlRoom) {
    document.querySelector('.tab-btn[data-tab="join"]').click();
    $('roomCodeInput').value = urlRoom.toUpperCase();
  }

  // Sayfa açılışında daha önce bir odadaysak otomatik yeniden katıl.
  if (savedRoom && savedNickname && !urlRoom) {
    socket.emit('room:join', { code: savedRoom, nickname: savedNickname, clientToken }, (res) => {
      if (res.ok) afterJoinSuccess(res);
      else localStorage.removeItem('vk_room');
    });
  }

  // ---------- Lobi ----------
  function renderLobby() {
    const list = $('lobbyPlayerList');
    list.innerHTML = '';
    state.players.forEach((p) => {
      const li = document.createElement('li');
      li.innerHTML = `<span>${escapeHtml(p.nickname)}</span>`;
      if (p.isHost) li.innerHTML += '<span class="tag host">Host</span>';
      if (!p.connected) li.innerHTML += '<span class="tag offline">Bağlantı yok</span>';
      list.appendChild(li);
    });
    $('startGameBtn').hidden = !state.isHost;
    $('startGameBtn').disabled = state.players.length < 4;
    $('lobbyHint').textContent = state.players.length < 4
      ? `Başlamak için en az 4 oyuncu gerekiyor (şu an ${state.players.length}).`
      : `${state.players.length} oyuncu hazır. ${state.isHost ? 'Oyunu başlatabilirsin!' : 'Host\'un başlatmasını bekliyoruz.'}`;
  }

  $('startGameBtn').addEventListener('click', () => {
    socket.emit('game:start', {}, (res) => {
      if (!res.ok) toast(friendlyError(res.error));
    });
  });

  // ---------- Oyun ekranı: rol kartı ----------
  function renderRoleCard() {
    if (!state.roleInfo) return;
    $('roleName').textContent = state.roleInfo.name;
    $('roleDesc').textContent = state.roleInfo.description;
    if (state.myRole === 'vampire' && state.teammates.length) {
      $('teammatesBox').hidden = false;
      $('teammatesList').textContent = state.teammates.join(', ');
    } else {
      $('teammatesBox').hidden = true;
    }
    // Öldükten sonra rolünü isteğe bağlı olarak herkese açıklayabilme.
    const showRevealOption = !state.alive && !state.revealed && state.phase !== 'lobby' && state.phase !== 'game_over';
    $('revealRoleBox').hidden = !showRevealOption;
    // Öldükten sonra (oyun bitene kadar) bir kez son söz söyleyebilme.
    const showLastWordsOption = !state.alive && !state.lastWordsSaid && state.phase !== 'lobby' && state.phase !== 'game_over';
    $('lastWordsBox').hidden = !showLastWordsOption;
  }

  $('revealRoleBtn').addEventListener('click', () => {
    socket.emit('player:revealRole', {}, (res) => {
      if (!res.ok) toast(friendlyError(res.error));
    });
  });

  $('lastWordsForm').addEventListener('submit', (e) => {
    e.preventDefault();
    const input = $('lastWordsInput');
    const message = input.value.trim();
    if (!message) return;
    $('lastWordsBtn').disabled = true;
    socket.emit('player:lastWords', { message }, (res) => {
      $('lastWordsBtn').disabled = false;
      if (!res.ok) return toast(friendlyError(res.error));
      state.lastWordsSaid = true;
      input.value = '';
      renderRoleCard();
    });
  });

  // ---------- Oyun ekranı: oyuncu listesi ----------
  function renderGamePlayers() {
    const list = $('gamePlayerList');
    list.innerHTML = '';
    state.players.forEach((p) => {
      const li = document.createElement('li');
      if (!p.alive) li.classList.add('dead');
      li.innerHTML = `<span>${escapeHtml(p.nickname)}</span>`;
      if (p.isHost) li.innerHTML += '<span class="tag host">Host</span>';
      if (p.role) li.innerHTML += `<span class="tag">${roleName(p.role)}</span>`;
      if (state.phase === 'day_vote' && p.alive && state.votedNicknames.has(p.nickname)) {
        li.innerHTML += '<span class="tag voted">✓ Oy verdi</span>';
      }
      if (!p.connected) li.innerHTML += '<span class="tag offline">Bağlantı yok</span>';
      list.appendChild(li);
    });
  }

  const ROLE_NAMES = { villager: 'Köylü', vampire: 'Vampir', jester: 'Soytarı', doctor: 'Doktor' };
  function roleName(key) { return ROLE_NAMES[key] || key; }

  // ---------- Oyun ekranı: faz / aksiyon alanı ----------
  const PHASE_LABELS = {
    night: '🌙 Gece',
    day_discussion: '☀️ Gündüz — Tartışma',
    day_vote: '🗳️ Gündüz — Oylama',
  };

  let timerInterval = null;
  const TIMER_BLINK_THRESHOLD = 15; // saniye
  function startTimer() {
    clearInterval(timerInterval);
    timerInterval = setInterval(() => {
      const timerEl = $('phaseTimer');
      if (!state.phaseEndsAt) { timerEl.textContent = ''; timerEl.classList.remove('timer-critical'); return; }
      const remaining = Math.max(0, Math.round((state.phaseEndsAt - Date.now()) / 1000));
      const m = String(Math.floor(remaining / 60)).padStart(2, '0');
      const s = String(remaining % 60).padStart(2, '0');
      timerEl.textContent = `${m}:${s}`;
      // Son 15 saniyede yanıp sönerek süre daralmasını görsel olarak vurgula.
      timerEl.classList.toggle('timer-critical', remaining > 0 && remaining <= TIMER_BLINK_THRESHOLD);
    }, 500);
  }

  function aliveOthers() {
    return state.players.filter((p) => p.alive && p.nickname !== state.nickname);
  }
  function aliveAll() {
    return state.players.filter((p) => p.alive);
  }

  // Oyuncu seçip ardından "Eminim" butonuyla onaylayan genel bileşen.
  // options: [{ value, label }]. onConfirm sadece "Eminim"e basılınca çağrılır
  // (tek tıkla yanlışlıkla oy/aksiyon gönderilmesin diye). onConfirm'e ikinci
  // parametre olarak bir onError callback'i geçilir — sunucu isteği reddederse
  // (örn. "art arda kendini koruyamazsın") arayüz tekrar seçim yapılabilir
  // hale gelsin diye çağrılmalıdır; aksi halde buton sonsuza kadar
  // "gönderildi" görünümünde asılı kalır.
  function buildSelectConfirmGrid(promptLabel, options, onConfirm) {
    const wrap = document.createElement('div');
    const p = document.createElement('p');
    p.className = 'muted';
    p.textContent = promptLabel;
    wrap.appendChild(p);

    const grid = document.createElement('div');
    grid.className = 'target-grid';

    const confirmBtn = document.createElement('button');
    confirmBtn.textContent = 'Eminim ✓';
    confirmBtn.className = 'primary confirm-btn';
    confirmBtn.disabled = true;

    let selected = null;
    options.forEach((opt) => {
      const btn = document.createElement('button');
      btn.textContent = opt.label;
      btn.addEventListener('click', () => {
        selected = opt.value;
        grid.querySelectorAll('button').forEach((b) => b.classList.remove('selected'));
        btn.classList.add('selected');
        confirmBtn.disabled = false;
      });
      grid.appendChild(btn);
    });

    confirmBtn.addEventListener('click', () => {
      if (selected === null) return;
      grid.querySelectorAll('button').forEach((b) => (b.disabled = true));
      confirmBtn.disabled = true;
      confirmBtn.textContent = 'Gönderildi — diğerleri bekleniyor...';
      onConfirm(selected, () => {
        // Sunucu isteği reddetti (örn. kural ihlali) — tekrar seçim
        // yapabilsinler diye arayüzü eski haline döndür.
        grid.querySelectorAll('button').forEach((b) => (b.disabled = false));
        confirmBtn.disabled = selected === null;
        confirmBtn.textContent = 'Eminim ✓';
      });
    });

    wrap.appendChild(grid);
    wrap.appendChild(confirmBtn);
    return wrap;
  }

  function sendNightAction(actionType, target, onError) {
    socket.emit('night:action', { actionType, target }, (res) => {
      if (!res.ok) {
        toast(friendlyError(res.error));
        if (onError) onError();
      }
    });
  }

  function sendVote(target, onError) {
    socket.emit('day:vote', { target }, (res) => {
      if (!res.ok) {
        toast(friendlyError(res.error));
        if (onError) onError();
      }
    });
  }

  function renderActionArea() {
    const el = $('actionArea');
    el.innerHTML = '';
    $('chatChannelHint').textContent = '';

    if (state.phase === 'night') {
      if (!state.alive) {
        el.innerHTML = '<p class="muted">Öldün — geceyi sadece izliyorsun.</p>';
        return;
      }
      if (state.myRole === 'vampire') {
        const options = aliveOthers().map((p) => ({ value: p.nickname, label: p.nickname }));
        el.appendChild(buildSelectConfirmGrid(
          'Bu gece kimi öldürmek istiyorsunuz? Seç, takım arkadaşlarınla konuş, emin olunca onayla.',
          options,
          (n, onError) => sendNightAction('vampire_vote', n, onError)
        ));
        $('chatChannelHint').textContent = '(vampir kanalı)';
      } else if (state.myRole === 'doctor') {
        const options = aliveAll().map((p) => ({ value: p.nickname, label: p.nickname }));
        el.appendChild(buildSelectConfirmGrid('Kimi korumak istiyorsun?', options, (n, onError) => sendNightAction('doctor_protect', n, onError)));
      } else {
        el.innerHTML = '<p class="muted">Gece oluyor... Vampirler ve doktor gizlice hareket ediyor. Sabah ne olduğunu öğreneceksin.</p>';
      }
    } else if (state.phase === 'day_discussion') {
      el.innerHTML = '<p class="muted">Tartışma zamanı! Kim vampir olabilir konuşun, sonra oylama başlayacak.</p>';
      $('chatChannelHint').textContent = '(gündüz sohbeti)';
    } else if (state.phase === 'day_vote') {
      $('chatChannelHint').textContent = '(gündüz sohbeti)';
      if (!state.alive) {
        el.innerHTML = '<p class="muted">Öldün — oylamayı sadece izliyorsun.</p>';
        return;
      }
      const options = aliveOthers().map((p) => ({ value: p.nickname, label: p.nickname }));
      options.push({ value: 'skip', label: 'Çekimser Kal' });
      el.appendChild(buildSelectConfirmGrid('Kimin asılmasını istiyorsun? Seç ve emin olunca onayla.', options, (n, onError) => sendVote(n, onError)));
      const tally = document.createElement('div');
      tally.id = 'voteTally';
      tally.className = 'muted';
      tally.style.marginTop = '10px';
      el.appendChild(tally);
    }
  }

  // ---------- Sohbet ----------
  function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  }

  const CHANNEL_LABELS = { lobby: 'Lobi', day: 'Gündüz', vampire: 'Vampir', dead: 'Ölüler' };

  function appendChatTo(containerId, msg) {
    const log = $(containerId);
    const div = document.createElement('div');
    div.className = `msg msg-${msg.channel}`;
    const nickColor = state.nicknameColors[msg.nickname];
    const nickStyle = nickColor ? ` style="color:${nickColor}"` : '';
    div.innerHTML = `<span class="ch ch-${msg.channel}">${CHANNEL_LABELS[msg.channel] || msg.channel}</span><span class="nick"${nickStyle}>${escapeHtml(msg.nickname)}:</span> ${escapeHtml(msg.message)}`;
    log.appendChild(div);
    log.scrollTop = log.scrollHeight;
  }

  $('lobbyChatForm').addEventListener('submit', (e) => {
    e.preventDefault();
    const input = $('lobbyChatInput');
    if (!input.value.trim()) return;
    socket.emit('chat:send', { message: input.value }, (res) => {
      if (!res.ok) toast(friendlyError(res.error));
    });
    input.value = '';
  });

  $('gameChatForm').addEventListener('submit', (e) => {
    e.preventDefault();
    const input = $('gameChatInput');
    if (!input.value.trim()) return;
    socket.emit('chat:send', { message: input.value }, (res) => {
      if (!res.ok) toast(friendlyError(res.error));
    });
    input.value = '';
  });

  socket.on('chat:message', (msg) => {
    if (msg.channel === 'lobby') appendChatTo('lobbyChatLog', msg);
    else appendChatTo('gameChatLog', msg);
  });

  // ---------- Roller dağıtılırken 3-2-1 geri sayımı ----------
  function runCountdown(onDone) {
    const overlay = $('countdownOverlay');
    const numberEl = $('countdownNumber');
    overlay.hidden = false;
    const seq = ['3', '2', '1', 'Başlıyor!'];
    let i = 0;
    function step() {
      numberEl.textContent = seq[i];
      numberEl.classList.remove('pulse');
      void numberEl.offsetWidth; // animasyonu yeniden başlatmak için reflow tetikle
      numberEl.classList.add('pulse');
      i += 1;
      if (i < seq.length) {
        setTimeout(step, 800);
      } else {
        setTimeout(() => { overlay.hidden = true; onDone(); }, 700);
      }
    }
    step();
  }

  // ---------- Gece/gündüz görsel göstergesi (kart + tüm sayfa teması) ----------
  function updatePhaseVisuals() {
    const card = document.querySelector('.phase-card');
    const isNight = state.phase === 'night';
    const isDay = state.phase === 'day_discussion' || state.phase === 'day_vote';
    document.body.classList.toggle('theme-day', isDay);
    if (isNight) {
      $('phaseIcon').textContent = '🌙';
      card.classList.add('is-night');
      card.classList.remove('is-day');
    } else if (isDay) {
      $('phaseIcon').textContent = '☀️';
      card.classList.add('is-day');
      card.classList.remove('is-night');
    } else {
      card.classList.remove('is-night', 'is-day');
    }
  }

  function resetPhaseTheme() {
    document.body.classList.remove('theme-day');
  }

  // ---------- Ölüm efekti ----------
  function showDeathEffect(nickname) {
    if (!nickname) return;
    const overlay = $('deathOverlay');
    const caption = $('deathCaption');
    caption.textContent = nickname === state.nickname ? `Sen öldün, ${nickname}!` : `${nickname} öldü!`;
    overlay.hidden = false;
    overlay.classList.remove('play');
    void overlay.offsetWidth; // animasyonu yeniden başlatmak için reflow tetikle
    overlay.classList.add('play');
    clearTimeout(showDeathEffect._t);
    showDeathEffect._t = setTimeout(() => { overlay.hidden = true; }, 2200);
  }

  // ---------- Son söz efekti (ekranın ortasında) ----------
  function showLastWordsEffect(nickname, message) {
    const overlay = $('lastWordsOverlay');
    $('lastWordsNick').textContent = `${nickname} son sözünü söyledi:`;
    $('lastWordsText').textContent = `"${message}"`;
    overlay.hidden = false;
    overlay.classList.remove('play');
    void overlay.offsetWidth; // animasyonu yeniden başlatmak için reflow tetikle
    overlay.classList.add('play');
    clearTimeout(showLastWordsEffect._t);
    showLastWordsEffect._t = setTimeout(() => { overlay.hidden = true; }, 5000);
  }

  // ---------- Sunucudan gelen oyun olayları ----------
  socket.on('room:state', (payload) => {
    const startingNewGame = previousPhase === 'lobby' && payload.phase === 'night';
    previousPhase = payload.phase;

    state.code = payload.code;
    state.phase = payload.phase;
    state.round = payload.round;
    state.phaseEndsAt = payload.phaseEndsAt;
    state.players = payload.players;
    state.nicknameColors = {};
    payload.players.forEach((p) => {
      if (p.color) state.nicknameColors[p.nickname] = p.color;
    });
    const me = payload.players.find((p) => p.nickname === state.nickname);
    if (me) {
      state.isHost = me.isHost;
      state.alive = me.alive;
      state.revealed = me.revealed;
    }

    if (state.phase !== 'day_vote') state.votedNicknames = new Set();

    $('roomBadge').hidden = false;
    $('roomCodeLabel').textContent = state.code;

    const gameInProgress = ['night', 'day_discussion', 'day_vote'].includes(state.phase);
    $('forceEndBtn').hidden = !(state.isHost && gameInProgress);

    function applyScreen() {
      showScreen(screenForPhase(state.phase));
      if (state.phase === 'lobby') {
        resetPhaseTheme();
        renderLobby();
      } else if (state.phase === 'game_over') {
        // gameOver ekranı 'game:over' olayında dolduruluyor.
        resetPhaseTheme();
      } else {
        updatePhaseVisuals();
        $('phaseLabel').textContent = `${PHASE_LABELS[state.phase] || state.phase} — Tur ${state.round}`;
        renderGamePlayers();
        renderRoleCard();
        renderActionArea();
        startTimer();
      }
    }

    if (startingNewGame) {
      // Önceki oyundan kalan sohbet mesajları yeni oyunda görünmesin.
      $('gameChatLog').innerHTML = '';
      state.lastWordsSaid = false;
      runCountdown(applyScreen);
    } else {
      applyScreen();
    }
  });

  $('forceEndBtn').addEventListener('click', () => {
    const confirmed = confirm('Oyunu şimdi erken bitirmek istediğine emin misin? Kimse kazanmamış sayılacak ve herkesin rolü açıklanacak.');
    if (!confirmed) return;
    socket.emit('game:forceEnd', {}, (res) => {
      if (!res.ok) toast(friendlyError(res.error));
    });
  });

  socket.on('role:assigned', (payload) => {
    state.myRole = payload.role;
    state.roleInfo = payload.info;
    state.teammates = payload.teammates || [];
    renderRoleCard();
  });

  socket.on('night:doctorConfirm', (payload) => {
    toast(`${payload.targetNickname} kişisini koruyorsun.`);
  });

  socket.on('player:lastWordsAnnounced', (payload) => {
    showLastWordsEffect(payload.nickname, payload.message);
  });

  socket.on('night:vampireProgress', () => {
    // Şimdilik sadece bilgi amaçlı; istenirse burada canlı oy listesi gösterilebilir.
  });

  socket.on('day:announcement', (payload) => {
    $('phaseAnnouncement').textContent = payload.announcement;
    if (payload.died) showDeathEffect(payload.died);
  });

  socket.on('day:voteProgress', (payload) => {
    state.votedNicknames = new Set(Object.keys(payload.tally));
    renderGamePlayers();
    const tally = $('voteTally');
    if (!tally) return;
    const lines = Object.entries(payload.tally).map(([voter, target]) => `${voter} → ${target}`);
    tally.innerHTML = `<strong>Anlık oylar:</strong><br>${lines.join('<br>') || 'Henüz oy yok.'}`;
  });

  socket.on('day:result', (payload) => {
    $('phaseAnnouncement').textContent = payload.announcement;
    toast(payload.announcement);
    if (payload.died) showDeathEffect(payload.died);
  });

  socket.on('game:over', (payload) => {
    $('gameOverTitle').textContent = payload.winner === 'aborted'
      ? `Oyun Bitti — ${payload.winnerLabel}`
      : `Oyun Bitti — ${payload.winnerLabel} Kazandı!`;
    $('gameOverAnnouncement').textContent = payload.lastAnnouncement || '';
    const tbody = document.querySelector('#roleRevealTable tbody');
    tbody.innerHTML = '';
    payload.roles.forEach((r) => {
      const tr = document.createElement('tr');
      tr.innerHTML = `<td>${escapeHtml(r.nickname)}</td><td>${roleName(r.role)}</td><td>${r.alive ? 'Hayatta' : 'Öldü'}</td>`;
      tbody.appendChild(tr);
    });
    $('playAgainBtn').hidden = !state.isHost;
    $('waitHostHint').hidden = state.isHost;
    showScreen('screen-gameover');
  });

  $('playAgainBtn').addEventListener('click', () => {
    socket.emit('game:playAgain', {}, (res) => {
      if (!res.ok) toast(friendlyError(res.error));
    });
  });

  socket.on('connect_error', () => toast('Sunucuya bağlanılamadı, tekrar deneniyor...'));
  socket.on('disconnect', () => toast('Bağlantı koptu, tekrar bağlanılıyor...'));
})();
