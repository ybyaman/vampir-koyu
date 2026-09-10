// client.js — Sunucudan gelen olaylara göre arayüzü güncelleyen, tek
// sayfalık (framework'süz) istemci mantığı.

(() => {
  // ---------- Hesap (e-posta + şifre) oturumu ----------
  // Artık serbest bir "takma isim" yok — kayıt olurken seçtiğin kullanıcı
  // adı, tüm odalarda/oyunlarda görünen kalıcı ismin. Oturum token'ı bu
  // tarayıcıda localStorage'da tutulur ve her Socket.io bağlantısında
  // (handshake) sunucuya gösterilir; sunucu geçersiz/eksik token'ı reddeder.
  function getToken() { return localStorage.getItem('vk_session_token') || ''; }
  function getUsername() { return localStorage.getItem('vk_username') || ''; }
  function setSession(token, username) {
    localStorage.setItem('vk_session_token', token);
    localStorage.setItem('vk_username', username);
  }
  function clearSession() {
    localStorage.removeItem('vk_session_token');
    localStorage.removeItem('vk_username');
  }

  const socket = io({
    // Fonksiyon olarak veriyoruz ki her (yeniden) bağlantı denemesinde
    // localStorage'daki GÜNCEL token okunsun (örn. az önce giriş yapıldıysa).
    auth: (cb) => cb({ token: getToken() }),
  });

  const savedRoom = localStorage.getItem('vk_room') || '';

  const state = {
    code: null,
    nickname: getUsername(),
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
  let hasEnteredApp = false; // ilk başarılı (kimlik doğrulanmış) bağlantıda oda ekranına bir kez geçmek için

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

  // Sekmeli alanlar (hesap ekranındaki Giriş/Kayıt VE oda ekranındaki
  // Oda Kur/Odaya Katıl) birbirinden bağımsız çalışsın diye her tık sadece
  // kendi ekranındaki (.screen) sekme+panel çiftini etkiler.
  document.querySelectorAll('.tab-btn').forEach((btn) => {
    btn.addEventListener('click', () => {
      const scope = btn.closest('.screen') || document;
      scope.querySelectorAll('.tab-btn').forEach((b) => b.classList.remove('active'));
      scope.querySelectorAll('.tab-panel').forEach((p) => p.classList.remove('active'));
      btn.classList.add('active');
      $(`tab-${btn.dataset.tab}`).classList.add('active');
    });
  });

  function showJoinError(msg) {
    const el = $('joinError');
    el.textContent = msg;
    el.hidden = false;
  }

  const ERROR_MESSAGES = {
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

  // ---------- Hesap ekranı: giriş / kayıt ----------
  const AUTH_ERROR_MESSAGES = {
    INVALID_EMAIL: 'Geçerli bir e-posta adresi gir.',
    WEAK_PASSWORD: 'Şifre en az 6 karakter olmalı.',
    INVALID_USERNAME: 'Kullanıcı adı 2-20 karakter olmalı (harf, rakam, _).',
    EMAIL_TAKEN: 'Bu e-posta ile zaten bir hesap var — Giriş Yap sekmesini dener misin?',
    USERNAME_TAKEN: 'Bu kullanıcı adı alınmış, başka bir tane dene.',
    INVALID_CREDENTIALS: 'E-posta ya da şifre yanlış.',
  };
  function friendlyAuthError(err) {
    return AUTH_ERROR_MESSAGES[err] || err || 'Bilinmeyen hata';
  }
  function showAuthError(msg) {
    const el = $('authError');
    el.textContent = msg;
    el.hidden = false;
  }

  async function callAuthApi(path, body) {
    try {
      const res = await fetch(path, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      return await res.json();
    } catch {
      return { ok: false, error: 'SERVER_ERROR' };
    }
  }

  function onAuthSuccess(token, user) {
    setSession(token, user.username);
    state.nickname = user.username;
    $('authError').hidden = true;
    socket.connect(); // token artık hazır — bağlantıyı (yeniden) dene
  }

  $('loginForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    $('authError').hidden = true;
    const email = $('loginEmail').value.trim();
    const password = $('loginPassword').value;
    $('loginBtn').disabled = true;
    const data = await callAuthApi('/api/auth/login', { email, password });
    $('loginBtn').disabled = false;
    if (!data.ok) return showAuthError(friendlyAuthError(data.error));
    onAuthSuccess(data.token, data.user);
  });

  $('registerForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    $('authError').hidden = true;
    const email = $('registerEmail').value.trim();
    const username = $('registerUsername').value.trim();
    const password = $('registerPassword').value;
    $('registerBtn').disabled = true;
    const data = await callAuthApi('/api/auth/register', { email, username, password });
    $('registerBtn').disabled = false;
    if (!data.ok) return showAuthError(friendlyAuthError(data.error));
    onAuthSuccess(data.token, data.user);
  });

  $('logoutBtn').addEventListener('click', async () => {
    const token = getToken();
    clearSession();
    localStorage.removeItem('vk_room');
    try {
      await fetch('/api/auth/logout', { method: 'POST', headers: { Authorization: `Bearer ${token}` } });
    } catch { /* çıkışı yine de tamamla */ }
    location.reload();
  });

  // ---------- Giriş (oda) ekranı ----------
  $('createRoomBtn').addEventListener('click', () => {
    $('joinError').hidden = true;
    socket.emit('room:create', {}, (res) => {
      if (!res.ok) return showJoinError(friendlyError(res.error));
      afterJoinSuccess(res);
    });
  });

  $('joinRoomBtn').addEventListener('click', () => {
    const code = ($('roomCodeInput').value || '').trim().toUpperCase();
    if (!code) return showJoinError('Lütfen oda kodunu gir.');
    $('joinError').hidden = true;
    socket.emit('room:join', { code }, (res) => {
      if (!res.ok) return showJoinError(friendlyError(res.error));
      afterJoinSuccess(res);
    });
  });

  function afterJoinSuccess(res) {
    state.code = res.code;
    state.nickname = res.player.nickname;
    state.isHost = res.player.isHost;
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

  // İlk kimlik doğrulanmış bağlantı kurulduğunda hesap ekranından oda
  // ekranına geç; daha önce bir odadaysak (ve bir davet linkiyle gelmediysek)
  // otomatik olarak o odaya yeniden katıl.
  socket.on('connect', () => {
    $('accountUsername').textContent = getUsername();
    $('accountBadge').hidden = false;
    if (!hasEnteredApp) {
      hasEnteredApp = true;
      $('joinWelcomeName').textContent = getUsername();
      showScreen('screen-join');
      if (savedRoom && !urlRoom) {
        socket.emit('room:join', { code: savedRoom }, (res) => {
          if (res.ok) afterJoinSuccess(res);
          else localStorage.removeItem('vk_room');
        });
      }
    }
  });

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

  // ---------- Roller dağıtılırken 3-2-1 geri sayımı + rol açılışı ----------
  // "3, 2, 1, Başlıyor!" bittikten sonra aynı büyük yazı bu sefer oyuncunun
  // ROLÜNÜ gösterir, bir an öyle durur, sonra animasyonlu şekilde küçülerek
  // ekranın ortasından rol kartındaki (#roleName) gerçek yerine "uçar" —
  // böylece rolünü öğrenmek daha belirgin/dramatik bir an oluyor.
  function runCountdown(onDone) {
    const overlay = $('countdownOverlay');
    const numberEl = $('countdownNumber');
    const captionEl = $('countdownCaption');
    captionEl.textContent = 'Roller dağıtılıyor...';
    numberEl.style.transition = '';
    numberEl.style.transform = '';
    numberEl.style.opacity = '1';
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
        setTimeout(() => {
          // Ekranı oyun ekranına geçir (rol kartı #roleName ile birlikte
          // GERÇEK, son konumunda render edilsin) — hâlâ üstünü kaplayan
          // bu overlay sayesinde kullanıcı bu geçişi görmez.
          onDone();
          playRoleRevealTransition(overlay, numberEl, captionEl);
        }, 700);
      }
    }
    step();
  }

  function playRoleRevealTransition(overlay, numberEl, captionEl) {
    const target = $('roleName');
    const roleInfo = state.roleInfo;
    if (!target || !roleInfo) {
      // Rol bilgisi bir şekilde henüz gelmediyse animasyonu atla, sadece kapat.
      overlay.hidden = true;
      return;
    }
    captionEl.textContent = 'Rolün:';
    numberEl.textContent = roleInfo.name;
    numberEl.classList.remove('pulse');
    void numberEl.offsetWidth;
    numberEl.classList.add('pulse');

    // Pulse-in animasyonu (0.8sn) bitip yazı bir an net şekilde görününce,
    // hedefin (gerçek #roleName) ekrandaki konum/boyutunu ölçüp oraya
    // doğru küçülerek taşıyan bir FLIP geçişi başlat.
    setTimeout(() => {
      const fromRect = numberEl.getBoundingClientRect();
      const toRect = target.getBoundingClientRect();
      const dx = (toRect.left + toRect.width / 2) - (fromRect.left + fromRect.width / 2);
      const dy = (toRect.top + toRect.height / 2) - (fromRect.top + fromRect.height / 2);
      const fromFontSize = parseFloat(getComputedStyle(numberEl).fontSize);
      const toFontSize = parseFloat(getComputedStyle(target).fontSize);
      const scale = toFontSize / fromFontSize;

      numberEl.style.transition = 'transform 0.9s cubic-bezier(0.6, -0.05, 0.15, 1), opacity 0.9s ease';
      numberEl.style.transform = `translate(${dx}px, ${dy}px) scale(${scale})`;
      numberEl.style.opacity = '0';

      setTimeout(() => {
        overlay.hidden = true;
        numberEl.style.transition = '';
        numberEl.style.transform = '';
        numberEl.style.opacity = '1';
      }, 950);
    }, 900);
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
  // Bu büyük/kırmızı tam ekran efekt SADECE ölen kişi sen isen gösterilir —
  // başka biri öldüğünde bu efekti görmek, sanki sen ölmüşsün gibi hissettiriyordu.
  // Başkasının öldüğü zaten faz duyurusunda (phaseAnnouncement) ve/veya
  // toast'ta ismiyle birlikte düz metin olarak bildiriliyor.
  function showDeathEffect(nickname) {
    if (!nickname) return;
    if (nickname !== state.nickname) return;
    const overlay = $('deathOverlay');
    const caption = $('deathCaption');
    caption.textContent = `Sen öldün, ${nickname}!`;
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

  // ---------- Sesli sohbet (WebRTC, faz-duyarlı, bas-konuş) ----------
  // Ses hiçbir zaman sunucudan geçmez — tarayıcılar arasında doğrudan
  // (P2P) akar. Sunucu sadece "şu an kim hangi kanalda" bilgisini ve
  // bağlantı kurulum mesajlarını (SDP/ICE) aktarır. Sadece ücretsiz genel
  // STUN sunucusu kullanılır (TURN yok) — bazı kısıtlı/kurumsal ağlarda
  // ses bağlantısı kurulamayabilir; böyle durumda yazılı sohbet her zaman
  // yedek olarak çalışmaya devam eder.
  const RTC_CONFIG = { iceServers: [{ urls: 'stun:stun.l.google.com:19302' }] };
  const voice = {
    enabled: false,
    localStream: null,
    channel: null,
    peers: new Map(), // clientToken -> RTCPeerConnection
  };

  function renderVoicePanel() {
    const label = $('voiceChannelLabel');
    const pttBtn = $('voicePttBtn');
    if (!voice.enabled) return;
    if (!voice.channel) {
      label.textContent = 'Şu an sesli kanalın yok (izliyorsun).';
      pttBtn.disabled = true;
      setTalking(false);
    } else {
      label.textContent = `Kanal: ${CHANNEL_LABELS[voice.channel] || voice.channel} (${voice.peers.size} kişi)`;
      pttBtn.disabled = false;
    }
  }

  function setTalking(isTalking) {
    if (!voice.localStream) return;
    voice.localStream.getAudioTracks().forEach((t) => { t.enabled = isTalking; });
    $('voicePttBtn').classList.toggle('talking', isTalking);
  }

  function ensureVoicePeer(remoteToken, remoteNickname) {
    if (voice.peers.has(remoteToken)) return voice.peers.get(remoteToken);
    const pc = new RTCPeerConnection(RTC_CONFIG);
    voice.peers.set(remoteToken, pc);
    if (voice.localStream) {
      voice.localStream.getTracks().forEach((t) => pc.addTrack(t, voice.localStream));
    }
    pc.onicecandidate = (e) => {
      if (e.candidate) {
        socket.emit('voice:signal', { to: remoteToken, data: { type: 'candidate', candidate: e.candidate } });
      }
    };
    pc.ontrack = (e) => {
      let audioEl = document.getElementById('voiceAudio-' + remoteToken);
      if (!audioEl) {
        audioEl = document.createElement('audio');
        audioEl.id = 'voiceAudio-' + remoteToken;
        audioEl.autoplay = true;
        $('voiceAudioContainer').appendChild(audioEl);
      }
      audioEl.srcObject = e.streams[0];
    };
    // İki taraf da aynı anda teklif göndermesin (glare) diye: clientToken'ı
    // alfabetik olarak küçük olan taraf teklifi başlatır.
    if (clientToken < remoteToken) {
      pc.onnegotiationneeded = async () => {
        try {
          const offer = await pc.createOffer();
          await pc.setLocalDescription(offer);
          socket.emit('voice:signal', { to: remoteToken, data: { type: 'offer', sdp: pc.localDescription } });
        } catch { /* bağlantı kurulamadı, sessizce yut — metin sohbeti yedek */ }
      };
    }
    return pc;
  }

  function closeVoicePeer(remoteToken) {
    const pc = voice.peers.get(remoteToken);
    if (pc) { pc.close(); voice.peers.delete(remoteToken); }
    const audioEl = document.getElementById('voiceAudio-' + remoteToken);
    if (audioEl) audioEl.remove();
  }

  function closeAllVoicePeers() {
    [...voice.peers.keys()].forEach(closeVoicePeer);
  }

  async function enableVoice() {
    if (voice.enabled) return;
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
      toast('Bu tarayıcı sesli sohbeti desteklemiyor.');
      return;
    }
    try {
      voice.localStream = await navigator.mediaDevices.getUserMedia({ audio: true });
    } catch {
      toast('Mikrofona erişilemedi (izin reddedildi ya da mikrofon bulunamadı).');
      return;
    }
    // Bas-konuş: mikrofon varsayılan olarak kapalı, sadece tuşa/butona
    // basılı tutulduğunda açık.
    voice.localStream.getAudioTracks().forEach((t) => { t.enabled = false; });
    voice.enabled = true;
    $('voiceToggleBtn').hidden = true;
    $('voiceActiveControls').hidden = false;
    $('voiceStatusText').textContent = 'Sesli sohbet açık';
    // Faz zaten ortasındaysa, bir sonraki geçişi beklemeden şu anki kanalı sor.
    socket.emit('voice:requestChannel', {}, () => {});
    renderVoicePanel();
  }

  function disableVoice() {
    if (!voice.enabled) return;
    closeAllVoicePeers();
    if (voice.localStream) voice.localStream.getTracks().forEach((t) => t.stop());
    voice.localStream = null;
    voice.enabled = false;
    voice.channel = null;
    $('voiceToggleBtn').hidden = false;
    $('voiceActiveControls').hidden = true;
    $('voiceStatusText').textContent = 'Sesli sohbet kapalı';
  }

  socket.on('voice:channel', (payload) => {
    if (!voice.enabled) return; // sesli sohbeti hiç açmadıysak ilgilenmiyoruz
    closeAllVoicePeers();
    voice.channel = payload.channel;
    (payload.peers || []).forEach((p) => ensureVoicePeer(p.clientToken, p.nickname));
    setTalking(false);
    renderVoicePanel();
  });

  socket.on('voice:peerJoined', (payload) => {
    if (!voice.enabled) return;
    ensureVoicePeer(payload.clientToken, payload.nickname);
    renderVoicePanel();
  });

  socket.on('voice:peerLeft', (payload) => {
    if (!voice.enabled) return;
    closeVoicePeer(payload.clientToken);
    renderVoicePanel();
  });

  socket.on('voice:signal', async (payload) => {
    if (!voice.enabled) return;
    const pc = ensureVoicePeer(payload.from, payload.fromNickname);
    const data = payload.data;
    try {
      if (data.type === 'offer') {
        await pc.setRemoteDescription(new RTCSessionDescription(data.sdp));
        const answer = await pc.createAnswer();
        await pc.setLocalDescription(answer);
        socket.emit('voice:signal', { to: payload.from, data: { type: 'answer', sdp: pc.localDescription } });
      } else if (data.type === 'answer') {
        await pc.setRemoteDescription(new RTCSessionDescription(data.sdp));
      } else if (data.type === 'candidate') {
        try { await pc.addIceCandidate(data.candidate); } catch { /* yut */ }
      }
    } catch { /* tek bağlantı kurulamasa da oyun/metin sohbeti etkilenmesin */ }
  });

  $('voiceToggleBtn').addEventListener('click', enableVoice);
  $('voiceDisableBtn').addEventListener('click', disableVoice);

  const voicePttBtn = $('voicePttBtn');
  ['mousedown', 'touchstart'].forEach((ev) => voicePttBtn.addEventListener(ev, (e) => {
    e.preventDefault();
    if (!voicePttBtn.disabled) setTalking(true);
  }));
  ['mouseup', 'mouseleave', 'touchend', 'touchcancel'].forEach((ev) => voicePttBtn.addEventListener(ev, () => setTalking(false)));

  // Space tuşu ile de bas-konuş yapılabilsin — ama bir metin kutusuna
  // yazarken boşluk tuşunu ELE GEÇİRMESİN.
  document.addEventListener('keydown', (e) => {
    if (e.code !== 'Space' || e.repeat) return;
    const tag = (document.activeElement && document.activeElement.tagName) || '';
    if (tag === 'INPUT' || tag === 'TEXTAREA') return;
    if (!voice.enabled || voicePttBtn.disabled) return;
    e.preventDefault();
    setTalking(true);
  });
  document.addEventListener('keyup', (e) => {
    if (e.code !== 'Space') return;
    setTalking(false);
  });

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
    $('voicePanel').hidden = false;

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

  socket.on('connect_error', (err) => {
    if (err && err.message === 'UNAUTHORIZED') {
      // Token yok ya da geçersiz/süresi dolmuş — hesap ekranına dön, sessizce
      // (toast'la kullanıcıyı rahatsız etmeden) tekrar giriş istensin.
      clearSession();
      hasEnteredApp = false;
      $('accountBadge').hidden = true;
      $('roomBadge').hidden = true;
      showScreen('screen-auth');
      return;
    }
    toast('Sunucuya bağlanılamadı, tekrar deneniyor...');
  });
  socket.on('disconnect', () => toast('Bağlantı koptu, tekrar bağlanılıyor...'));
})();
