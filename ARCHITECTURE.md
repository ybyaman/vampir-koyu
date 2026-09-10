# Vampir Köyü — Mimari Tasarım

Bu belge, birkaç arkadaşının senin bilgisayarında çalışan bir sunucuya bağlanıp
"Vampir Köyü" (Werewolf/Mafia tarzı, gece-gündüz döngülü sosyal çıkarım oyunu)
oynayabilmesi için uçtan uca mimariyi anlatır.

## 1. Genel Bakış

```
                        İNTERNET
                            │
                            │  https://xxxx.trycloudflare.com
                            ▼
                 ┌─────────────────────┐
                 │  Cloudflare Tunnel   │   (senin makinende çalışan
                 │  (cloudflared)       │    küçük bir process)
                 └──────────┬──────────┘
                            │  localhost:3000
                            ▼
   ┌───────────────────────────────────────────────────┐
   │                SENİN BİLGİSAYARIN                  │
   │                                                     │
   │   ┌───────────────────────────────────────────┐   │
   │   │  Node.js Sunucu (Express + Socket.io)      │   │
   │   │                                             │   │
   │   │   ├─ HTTP: statik dosyalar (public/)       │   │
   │   │   ├─ HTTP: /api/auth/* (kayıt/giriş/çıkış)  │   │
   │   │   ├─ WebSocket: gerçek zamanlı oyun olayları│   │
   │   │   ├─ auth.js: hesap + oturum (session)      │   │
   │   │   ├─ gameManager.js: oda/oyun durum makinesi│   │
   │   │   └─ roles.js: rol tanımları ve gece mantığı│   │
   │   └───────────────────┬─────────────────────────┘   │
   │                       │                             │
   │                       ▼                             │
   │           ┌─────────────────────┐                   │
   │           │  SQLite (data.db)   │                   │
   │           │  better-sqlite3     │                   │
   │           └─────────────────────┘                   │
   └───────────────────────────────────────────────────┘

        Arkadaşların (tarayıcıdan bağlanır):
        Ayşe ──┐
        Mehmet ─┼──► https://xxxx.trycloudflare.com  (herkes aynı adrese girer)
        Zeynep ─┘
```

Tek bir Node.js süreci hem web sayfalarını (statik HTML/CSS/JS) hem de
gerçek zamanlı oyun iletişimini (WebSocket üzerinden Socket.io) yönetir.
Oyun durumu **bellekte** (RAM'de, `gameManager.js` içinde) tutulur çünkü anlık
tepki hızı gerekir; SQLite ise **kalıcı kayıt** için kullanılır: oda geçmişi,
oyuncu istatistikleri, sohbet günlüğü, oyun sonuçları. Sunucu yeniden
başlatılsa bile geçmiş oyunlar ve istatistikler kaybolmaz — sadece o an açık
olan oyunun canlı durumu sıfırlanır.

## 2. Bileşenler

### 2.1 Sunucu (`server/index.js`)
- Express: `public/` klasöründeki statik dosyaları (HTML/CSS/JS) sunar.
- Socket.io: tarayıcı ile sunucu arasında düşük gecikmeli, çift yönlü olay
  akışı sağlar (oda kurma, katılma, gece aksiyonu, oy verme, sohbet, vb).
- Her tarayıcı sekmesi bir Socket.io bağlantısıdır; bağlantı bir odaya
  (`socket.join(roomCode)`) katılır, böylece o odaya yayın yapmak tek satır
  kod (`io.to(roomCode).emit(...)`) ile olur.

### 2.2 Oyun Motoru (`server/gameManager.js`, `server/roles.js`)
Sunucu içinde çalışan, veritabanından bağımsız, saf durum makinesi:

```
LOBBY → (host başlatır) → GECE → GÜNDÜZ_TARTIŞMA → GÜNDÜZ_OYLAMA
           ▲                                              │
           └──────────────── (oyun bitmedi) ───────────────┘
                                     │
                                (oyun bitti)
                                     ▼
                                OYUN_BİTTİ
```

- **LOBBY**: Oyuncular kendi hesaplarıyla (bkz. [2.7 Hesap ve
  Oturum](#27-hesap-ve-oturum-serverauthjs)) katılır, host (odayı açan
  kişi) oyunu başlatır. Oyuncu sayısına göre roller otomatik dağıtılır (yaklaşık her
  4 oyuncudan 1'i vampir, 4. oyuncudan itibaren her zaman 1 doktor var;
  soytarı SADECE 5+ oyuncuda eklenir — tam 4 oyuncuda soytarı yerine
  doktor vardır, bkz. `roles.js` — `computeRoleCounts`).
- **GECE** (25 sn): Vampirler ortak bir kurbanı seçer (özel vampir kanalı),
  Doktor birini korur (kendisi dahil — ama **art arda iki gece kendini
  koruyamaz**, bkz. `room.doctorLastSelfProtect` / `gameManager.js`).
  Soytarının gece yapacağı bir şey yok. Herkes aksiyonunu verince (ya da
  süre dolunca) gece çözülür.
- **GÜNDÜZ_TARTIŞMA** (60 sn): Gece kim öldüyse duyurulur, süreli genel
  sohbet açılır.
- **GÜNDÜZ_OYLAMA** (45 sn): Herkes asılacak kişiye oy verir ya da çekimser
  kalır, en çok oyu alan elenir ve rolü açıklanır. Çekimser oylar gerçek
  bir ağırlık taşır: en çok oyu alan kişinin oyu, çekimser sayısına eşit
  ya da azsa kimse asılmaz (bkz. `tallyVotes` — `max <= skipCount` kontrolü).
- Soytarı asılırsa oyunu o an tek başına kazanır ve oyun biter. Aksi halde
  her turun sonunda kazanma koşulu kontrol edilir: tüm vampirler öldüyse
  köylüler kazanır; vampir sayısı diğer oyuncu sayısına eşit ya da
  fazlaysa vampirler kazanır.
- Ölen bir oyuncu, ölümü için bir kez "son söz" mesajı yayınlayabilir
  (`player:lastWords` → `player:lastWordsAnnounced`); istemci bunu ekranın
  ortasında birkaç saniyeliğine büyük şekilde gösterir.

### 2.3 Veritabanı (`server/db.js`, SQLite)
Kalıcı olması gereken, "o anki oyunun RAM durumu" olmayan her şey burada:

| Tablo | Amaç |
|---|---|
| `rooms` | Oda kodu, adı, durumu, oluşturulma zamanı |
| `players` | Oyuncunun hangi odada, hangi takma isimle, hangi rolde olduğu |
| `games` | Başlayan her oyun turu, başlangıç/bitiş zamanı, kazanan taraf |
| `game_logs` | Gece aksiyonları, oylamalar, ölümler (oyun sonu özeti/geçmiş için) |
| `chat_messages` | Gündüz/gece/ölüler sohbeti geçmişi |

SQLite tek dosyadır (`data/vampirkoyu.db`), kurulum gerektirmez, birkaç
arkadaşının aynı anda oynadığı bu ölçekte fazlasıyla yeterlidir.

### 2.4 Frontend (`public/`)
Tek sayfalık, framework'süz (vanilla JS) bir arayüz:
- Hesap ekranı: e-posta/şifre ile giriş ya da kayıt (bkz. 2.7).
- Giriş (oda) ekranı: oda kur / oda koduyla katıl — artık isim sormaz,
  hesabın kullanıcı adını otomatik kullanır.
- Lobi ekranı: katılan oyuncu listesi, host için "Oyunu Başlat" butonu.
- Oyun ekranı: rol kartı (sadece sana özel), faz göstergesi, geri sayım,
  sohbet kutusu, gece aksiyonu / gündüz oylama arayüzü.
- Oturum token'ı `localStorage`'da tutulur (`vk_session_token`); sayfa
  yenilenirse veya bağlantı kopup geri gelirse aynı hesapla/oyuncuyla
  odaya otomatik geri bağlanır (bkz. 2.7).
- Her oyuncuya (katıldığında, ve her yeni oyun başında yeniden) sunucu
  tarafında bir sohbet rengi atanır (`gameManager.js` — `CHAT_COLOR_PALETTE`,
  `assignChatColors`); bu renk `room:state` ile istemciye gider ve sohbette
  oyuncunun ismi o renkle yazılır. Gece/gündüz arası arka plan (ve tüm
  kart/panel/kenarlık) renk geçişi 3 saniyelik, yavaş bir CSS `transition`
  ile animasyonludur — bu değişkenler `@property` ile "renk" tipinde kayıtlı
  olduğu için (`style.css`), tarayıcı tüm bağımlı elemanları TEK bir yerden
  (body üzerindeki transition'dan) otomatik ve senkronize şekilde birbirine
  geçirir; @property olmadan CSS custom property'lerinin değişimi tarayıcı
  tarafından animasyonlu geçirilemez — "anlık geçiş" şikayetinin kök nedeni
  buydu.

### 2.5 İnternete Açma (Cloudflare Tunnel)
Kendi bilgisayarın genelde doğrudan internetten erişilebilir değildir (ev
ağı NAT arkasındadır). Router'da port açmak yerine `cloudflared` adlı küçük
bir programı çalıştırarak bilgisayarından Cloudflare'e giden bir "tünel"
kurulur; Cloudflare sana `https://rastgele-isim.trycloudflare.com` gibi
herkese açık bir adres verir. Bu adres WebSocket'i (Socket.io'nun kullandığı
protokol) ve HTTPS'i otomatik destekler — router ayarı, statik IP ya da
port yönlendirme gerekmez. Arkadaşların sadece bu linke tıklar.

Detaylı adımlar `README.md` içinde.

### 2.6 Sesli Sohbet (WebRTC, `voice:*` olayları)
Ses verisi hiçbir zaman sunucudan geçmez — tarayıcılar arası doğrudan
(P2P) `RTCPeerConnection` mesh bağlantısı kurulur (SFU yok, her istemci
kendi kanalındaki diğer herkesle ayrı bir bağlantı açar). Sunucunun tek
işi, zaten var olan Socket.io bağlantısı üzerinden iki şeyi aktarmak:

1. **Kanal ataması** — kimin şu an hangi sesli kanalda olduğu.
2. **Sinyalleşme** — bağlantı kurulumu için gereken SDP teklif/cevap ve
   ICE aday mesajları (`voice:signal`).

**Kanal mantığı yazılı sohbetle birebir aynı fonksiyonu paylaşır**
(`resolveChatChannel(room, player)` — `gameManager.js`): gece vampirse
`'vampire'`, ölüyse `'dead'`, gündüz/lobideyse `'day'`/`'lobby'`. Hem
`sendChat` hem `syncVoiceChannels`/`relayVoiceSignal`/`requestVoiceChannel`
aynı fonksiyonu çağırır — bu sayede sesli ve yazılı kanal ataması asla
birbirinden sapamaz (iki ayrı mantık yazılıp senkronsuz kalma riski yok).

**Gizlilik açısından kritik tasarım kararı:** bir oyuncunun hangi sesli
kanalda olduğu bilgisi ASLA `room:state` gibi herkese açık bir yayınla
gönderilmez — gece fazında bu bilgi vampirlerin kimliğini ele verirdi.
Bunun yerine mevcut özel `emitToPlayer` mekanizması kullanılır:
`syncVoiceChannels(room)` her faz geçişinde/ölüm/bağlantı kopmasında
çalışır, önceki ve yeni kanal atamalarını karşılaştırıp SADECE ilgili
oyunculara özel olarak `voice:channel` (kendi tam anlık kanal+peer listen)
veya artımlı `voice:peerJoined`/`voice:peerLeft` olayları gönderir.

**Faz ortasında mikrofonu açma:** Bir oyuncu sesli sohbeti bir faz
geçişinin tam ortasında açarsa, bir sonraki geçişi beklemeden anlık kanal
bilgisini `voice:requestChannel` ile isteyebilir (`requestVoiceChannel` —
`syncVoiceChannels`'ın aksine bu, diğer oyuncuların artımlı senkron
durumunu bozmadan sadece isteyen oyuncuya cevap verir).

**Glare önleme:** İki taraf da aynı anda `onnegotiationneeded` tetikleyip
birbirine teklif (offer) göndermesin diye, `clientToken`'ı alfabetik
sırada küçük olan taraf teklifi başlatır (`ensureVoicePeer` —
`public/js/client.js`) — tam "perfect negotiation" desenine gerek kalmadan,
bu küçük ölçekte (kanal başına birkaç kişi) yeterli ve basit bir çözüm.

**Bas-konuş (push-to-talk):** Mikrofon akışı (`getUserMedia`) her zaman
açık tutulur, sadece ses parçası (`MediaStreamTrack.enabled`) basılı
tutulduğunda `true` yapılır — akışı sürekli başlatıp durdurmak yerine bu
yaklaşım hem daha hızlı tepki verir hem de yeniden müzakere (renegotiation)
gerektirmez.

**Bilinen kısıt — TURN yok:** Sadece ücretsiz genel bir STUN sunucusu
kullanılır (`RTC_CONFIG` — `public/js/client.js`), TURN sunucusu (relay)
yoktur. Simetrik NAT'lar arkasındaki ya da P2P trafiği engelleyen kısıtlı
ağlarda (bazı kurumsal/okul ağları) doğrudan bağlantı kurulamayabilir.
Kendi TURN sunucunu kurup eklemek istersen `RTC_CONFIG.iceServers`
listesine eklemen yeterli olur. Bu durumda bile yazılı sohbet her zaman
çalışmaya devam eder — sesli sohbet tamamen "en iyi çaba" (best-effort)
ek bir katmandır, oyunun temel akışı ona bağımlı değildir.

### 2.7 Hesap ve Oturum (`server/auth.js`)
Önceden bu proje hesapsızdı: her tarayıcı, kendi rastgele ürettiği ve
`localStorage`'da tuttuğu bir `clientToken` ile kimliklenirdi. Artık gerçek
(ama bilinçli olarak sade) bir e-posta+şifre hesap sistemi var:

- **Şifreler** asla düz metin saklanmaz — Node'un yerleşik `crypto.scrypt`'i
  ile rastgele bir tuzla (salt) hash'lenir (`hashPassword`/`verifyPassword`
  — `auth.js`). Bunun için ekstra bir native bağımlılık (örn. bcrypt)
  eklemeye gerek kalmadı.
- **Kayıt/giriş** iki düz REST ucu (`POST /api/auth/register`,
  `POST /api/auth/login` — `server/index.js`) üzerinden olur; başarılı
  olursa rastgele bir **oturum token'ı** (`crypto.randomBytes(32)`) üretilip
  `sessions` tablosuna yazılır ve istemciye döner.
- İstemci bu token'ı `localStorage`'da tutar ve her Socket.io
  bağlantısında **handshake sırasında** (`io({ auth: (cb) => cb({token}) })`)
  sunucuya gösterir. Sunucu tarafında bir `io.use` ara katmanı
  (middleware) bu token'ı doğrular; geçersiz/eksikse bağlantı reddedilir
  (istemci bunu `connect_error` olayında `UNAUTHORIZED` mesajıyla görür ve
  hesap ekranına döner).
- Doğrulama başarılıysa `socket.data.userId`/`username` set edilir ve oda
  içi kalıcı kimlik (`clientToken`, eskiden rastgele üretilirdi) artık
  **hesaba bağlı ve deterministik**: `` `u${userId}` ``. Bunun pratik
  faydası: aynı hesapla farklı bir tarayıcıdan/cihazdan bağlansan bile
  (aynı odaya) aynı oyuncu olarak tanınırsın.
- `room:create`/`room:join` artık istemciden nickname/token ALMAZ — ikisi
  de sunucu tarafında, doğrulanmış `socket.data`'dan okunur. Bu hem daha
  güvenli (nickname sahteciliği imkansız) hem de istemci tarafını
  basitleştirir.
- **Bilinçli kısıtlar:** e-posta doğrulama yok, şifre sıfırlama yok (SMTP
  gerektirir), oturumlar süresiz geçerli (kullanım ölçeği ve tehdit modeli
  düşünüldüğünde — küçük bir arkadaş grubu partisi — bu kabul edilebilir
  bir basitleştirme).

## 3. Veri Akışı Örneği (bir gece turu)

1. Sunucu `GECE` fazına geçer, tüm istemcilere `phase:night` olayı yayınlar.
2. Vampir oyuncuların istemcisi kurban seçme arayüzünü açar; her vampir
   `night:vampireVote` olayıyla oyunu sunucuya bildirir.
3. Doktor `night:doctorProtect` olayını gönderir.
4. `gameManager.js` tüm gerekli aksiyonlar geldiğinde (ya da 25 saniyelik
   süre dolduğunda) geceyi çözer: kurban öldü mü, doktor kurtardı mı?
5. Sonuç `game_logs` tablosuna yazılır, `phase:day` olayıyla tüm oyunculara
   "bu gece ... öldü / kimse ölmedi" duyurulur.
6. Sohbet ve oylama aynı prensiple ilerler.

## 4. Neden bu seçimler?

- **Node.js + Socket.io**: WebSocket üzerinden anlık, çift yönlü oyun
  olaylarını yönetmek için en olgun ve iyi belgelenmiş araç seti.
- **SQLite**: Ayrı bir veritabanı sunucusu kurmana gerek kalmaz; tek dosya,
  yedeklemesi bile `data.db` dosyasını kopyalamak kadar basit.
- **Bellek içi oyun durumu + SQLite kalıcı katman**: Oyun içi hız için RAM,
  geçmiş/istatistik için disk — ikisi birbirini tamamlar, birbirinin yerini
  tutmaz.
- **Cloudflare Tunnel**: Router'ına dokunmadan, port yönlendirmeden, statik
  IP olmadan güvenli ve HTTPS'li şekilde dışarıya açılmanın en az sürtünmeli
  yolu; ngrok'a göre ücretsiz kullanımda süre/bağlantı kısıtı yoktur.
- **WebRTC (mesh, sunucu üzerinden sinyal aktarımı)**: Ses için ayrı bir
  medya sunucusu (SFU/TURN) kurmadan, mevcut Socket.io bağlantısını
  sinyalleşme kanalı olarak yeniden kullanarak sesli sohbeti neredeyse
  sıfır ek altyapıyla eklemenin en basit yolu. Bu küçük grup (parti)
  ölçeğinde (kanal başına genelde birkaç kişi) mesh topolojisi SFU'dan
  daha basit ve yeterlidir; bedeli TURN'süz kısıtlı ağlarda bağlantının
  bazen kurulamaması, ki bu durumda yazılı sohbet yedek olarak kalır.
- **`crypto.scrypt` ile parola hash'leme (bcrypt yerine)**: Node'un
  standart kütüphanesinde hazır geliyor — ekstra bir native bağımlılık
  (derleme/prebuilt-binary riski taşıyan, bu projede `better-sqlite3` ile
  zaten bir kez yaşanmış bir sorun kaynağı) eklemeden, kabul görmüş,
  güvenli bir parola hash algoritması kullanmanın en sürtünmesiz yolu.
- **Basit oturum token'ı (JWT yerine)**: Süresiz, sunucu tarafında
  saklanan (SQLite `sessions` tablosu) rastgele bir token — imzalı/kendi
  kendini doğrulayan bir JWT'ye kıyasla daha az esnek (örn. token
  içeriğini değiştirip yeniden imzalamak gerekmez) ama iptal etmesi
  (çıkış yap = satırı sil) çok daha basit ve bu ölçekte yeterli.
