# 🧛 Vampir Köyü

**Kendi bilgisayarında çalıştırıp arkadaşlarınla oynayabileceğin, gerçek
zamanlı, gece/gündüz döngülü bir sosyal çıkarım (Werewolf / Mafia tarzı)
parti oyunu — vampir temalı.**

![Node.js](https://img.shields.io/badge/Node.js-LTS-3c873a?logo=node.js&logoColor=white)
![Socket.io](https://img.shields.io/badge/Socket.io-realtime-010101?logo=socket.io&logoColor=white)
![SQLite](https://img.shields.io/badge/SQLite-persistence-003b57?logo=sqlite&logoColor=white)
![License](https://img.shields.io/badge/license-MIT-blue)

Hesap yok, kurulum derdi yok, aylık ücret yok — kendi makinende çalıştırıp
internete açtığın anda arkadaşların tarayıcıdan bağlanıp oynayabilir.

---

## İçindekiler

- [Özellikler](#özellikler)
- [Nasıl çalışır?](#nasıl-çalışır)
- [Hızlı başlangıç](#hızlı-başlangıç)
  - [1. Kurulum](#1-kurulum-ilk-sefer)
  - [2. Sunucuyu başlatma](#2-sunucuyu-başlatma)
  - [3. İnternete açma](#3-arkadaşlarının-bağlanabilmesi-için-internete-açma-cloudflare-tunnel)
  - [4. Oyuna başlama](#4-oyuna-başlama)
- [Nasıl oynanır?](#nasıl-oynanır-kısa-kurallar)
- [Proje yapısı](#proje-yapısı)
- [Güvenlik ve gizlilik notları](#güvenlik-ve-gizlilik-notları)
- [Sorun giderme](#sorun-giderme)
- [Lisans](#lisans)

---

## Özellikler

- 🌗 **Gece/gündüz döngüsü** — gece vampirler kurbanını seçer, gündüz
  tartışma ve oylamayla asılacak kişi belirlenir; faz değişince arka plan
  1 saniyelik yumuşak bir animasyonla aydınlanır/kararır.
- 🎭 **4 rol** — Köylü, Vampir, Soytarı (asılırsa tek başına kazanır),
  Doktor — oyuncu sayısına göre otomatik dağıtılır.
- 💬 **Gerçek zamanlı sohbet** — lobi, gündüz, vampirlere özel gece kanalı
  ve ölüler kanalı; her oyuncunun kendine özel, her yeni oyunda yeniden
  karıştırılan bir sohbet rengi var.
- ✅ **Seç + Onayla akışı** — gece aksiyonu ve gündüz oyu yanlışlıkla tek
  tıkla gönderilmez, "Eminim ✓" ile onaylanır; herkes onaylayınca faz süresi
  dolmadan erken ilerler.
- 💀 **Görsel efektler** — 3-2-1 rol dağıtım geri sayımı, ölüm efekti, kim
  oy verdi göstergesi.
- 🔌 **Kopan bağlantıdan otomatik dönüş** — sayfa yenilense ya da bağlantı
  kesilip gelse bile aynı oyuncu olarak kaldığın yerden devam edersin.
- 🗄️ **Kalıcı geçmiş** — oda/oyuncu/oyun/sohbet kayıtları SQLite ile tek
  dosyada (`data/vampirkoyu.db`) tutulur, sunucuyu yeniden başlatsan bile
  geçmiş kaybolmaz (o an açık oyunun canlı durumu hariç).

## Nasıl çalışır?

Tek bir Node.js süreci hem statik web sayfalarını hem de Socket.io
üzerinden gerçek zamanlı oyun olaylarını yönetir; oyun durumu hız için
bellekte, geçmiş/istatistik için SQLite'ta tutulur. Kendi bilgisayarını
internete açmak için **Cloudflare Tunnel** kullanılır — router ayarı,
statik IP ya da port yönlendirme gerekmez.

Mimarinin tam şeması, veri akışı ve tasarım kararlarının gerekçeleri için
**[ARCHITECTURE.md](ARCHITECTURE.md)** dosyasına bakabilirsin. Bu README
sadece "nasıl kurarım" ve "nasıl oynanır" sorularına odaklanır.

## Hızlı başlangıç

### 1. Kurulum (ilk sefer)

1. [Node.js](https://nodejs.org) kurulu değilse indirip kur. **LTS (uzun
   destekli) sürümü** seç — çok yeni "Current" sürümler (örn. Node 25/26)
   bazı native paketlerin (`better-sqlite3`) henüz derlenmiş hazır dosyası
   olmayabildiği için kurulum hatası verebilir. Sorun yaşarsan aşağıdaki
   [Sorun Giderme](#sorun-giderme) bölümüne bak.
2. Bu depoyu klonla (ya da ZIP olarak indirip çıkar):
   ```bash
   git clone https://github.com/ybyaman/vampir-koyu.git
   cd vampir-koyu
   ```
3. Bağımlılıkları kur (sadece ilk seferde gerekli):
   ```bash
   npm install
   ```

### 2. Sunucuyu başlatma

```bash
npm start
```

Terminalde şunu görmelisin:
```
Vampir Köyü sunucusu çalışıyor: http://localhost:3000
```

Tarayıcından `http://localhost:3000` adresine girip kendi bilgisayarında
test edebilirsin. Ama arkadaşların **kendi evlerinden** bağlanacaksa
`localhost` işe yaramaz — 3. adıma geç.

Sunucuyu durdurmak için terminalde `Ctrl + C`.

### 3. Arkadaşlarının bağlanabilmesi için internete açma (Cloudflare Tunnel)

Ev ağın genelde dışarıdan doğrudan erişilemez (router NAT arkasında).
En kolay ve router ayarı gerektirmeyen çözüm **Cloudflare Tunnel**'dır —
ücretsizdir, hesap açmana bile gerek yoktur ("quick tunnel").

<details>
<summary><strong>3.1 — <code>cloudflared</code> kurulumu (tek seferlik)</strong></summary>

- **Windows**: PowerShell'de:
  ```
  winget install --id Cloudflare.cloudflared
  ```
  (winget yoksa: https://github.com/cloudflare/cloudflared/releases adresinden `.exe` indir.)

- **macOS**:
  ```
  brew install cloudflared
  ```

- **Linux (Debian/Ubuntu)**:
  ```
  curl -L --output cloudflared.deb https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-linux-amd64.deb
  sudo dpkg -i cloudflared.deb
  ```

</details>

**3.2 — Tüneli açma (her oyun oturumunda)**

Node sunucusu (`npm start`) **çalışırken**, ikinci bir terminal penceresi aç
ve şunu çalıştır:

```bash
cloudflared tunnel --url http://localhost:3000
```

Birkaç saniye içinde terminalde şöyle bir satır göreceksin:

```
https://kucuk-rastgele-isim.trycloudflare.com
```

Bu adres, arkadaşlarının tarayıcıdan gireceği **herkese açık link**. Bu linki
kopyalayıp arkadaşlarına gönder (WhatsApp, Discord, ne kullanıyorsanız).
Bu pencereyi kapatmadığın sürece link çalışmaya devam eder; kapatırsan tünel
kesilir ve yeniden açtığında **yeni bir link** üretilir (bu, hesapsız "quick
tunnel" modunun normal davranışıdır — sorun değil, sadece yeni linki tekrar
paylaşman gerekir).

<details>
<summary><strong>3.3 — Cloudflare Tunnel bağlanamıyorsa: ngrok'a geç</strong></summary>

Bazı ev ağlarında / İSS'lerde / VPN'lerde `cloudflared`'in kullandığı 7844
portu (UDP ve TCP) engellenmiş olabilir. Bunun belirtisi terminalde şöyle
satırlar görmektir:

```
UDP Connectivity  ...  FAIL  QUIC connection failed
TCP Connectivity  ...  FAIL  HTTP/2 connection is blocked or unreachable
ERROR: Allow outbound QUIC traffic on port 7844 or use HTTP2.
```

Bu durumda önce: (1) aktif bir VPN/güvenlik duvarı yazılımı varsa kapatıp
tekrar dene, (2) farklı bir ağdan (örn. telefon hotspot'u) dene — eğer orada
çalışıyorsa sorun kesin olarak o ağın port kısıtlamasıdır.

Ağ kısıtlaması gerçekten kalkmıyorsa, **ngrok** neredeyse her zaman çalışır
çünkü standart 443 portunu kullanır:

```bash
brew install ngrok                      # macOS (Windows: https://ngrok.com/download)
```

ngrok artık ücretsiz kullanım için bile bir hesap istiyor:
https://dashboard.ngrok.com/signup adresinden kaydolup "Your Authtoken"
sayfasından token'ını al, sonra:

```bash
ngrok config add-authtoken <TOKEN>
```

Node sunucusu (`npm start`) çalışırken, başka bir terminalde:

```bash
ngrok http 3000
```

Terminalde çıkan `https://xxxx.ngrok-free.app` adresini arkadaşlarına
gönder (oda linki için sonuna `/?room=AB3K9` ekle). Ücretsiz planda her
başlatışta URL değişir, tıpkı Cloudflare quick tunnel gibi.

</details>

### 4. Oyuna başlama

1. Sen (host) linke girip bir takma isim yazıp **"Oda Kur"**a tıkla.
2. Ekranda bir **oda kodu** (örn. `AB3K9`) ve "Linki Kopyala" butonu göreceksin.
   Bu linki (`https://.../?room=AB3K9`) arkadaşlarına gönder — link,
   oda kodunu otomatik doldurur, onlar sadece isim yazıp "Katıl"a basar.
3. En az **4 oyuncu** odaya girdiğinde host "Oyunu Başlat" butonunu görür.
4. Roller otomatik dağıtılır, herkesin ekranında sadece kendi rolü görünür.

## Nasıl oynanır? (kısa kurallar)

Roller (oyuncu sayısına göre otomatik dağıtılır, yaklaşık her 4 kişiden 1'i vampir):

| Rol | Takım | Yetenek |
|---|---|---|
| 🧑‍🌾 **Köylü** | Köy | Özel yeteneği yok, gündüz tartışıp doğru tahmini yapmaya çalışır. |
| 🧛 **Vampir** | Vampirler | Geceleri diğer vampirlerle birlikte bir kurban seçip öldürür. Kimliğini gündüz gizler. |
| 🃏 **Soytarı** | Kimse (tarafsız) | Gece yapacağı bir şey yok. Tek amacı **gündüz oylamasıyla asılmak** — asılırsa oyunu tek başına kazanır ve oyun orada biter! |
| 💉 **Doktor** | Köy | Her gece bir kişiyi (kendisi dahil) korur; o kişi o gece ölmez. |

Tur akışı:

1. **Gece** (25 sn) — Vampirler kurbanı seçer, Doktor korur.
2. **Gündüz — Tartışma** (60 sn) — Gece kim öldü (ya da kimse ölmedi mi) açıklanır, herkes serbestçe tartışır.
3. **Gündüz — Oylama** (45 sn) — Herkes asılacak kişiye oy verir (ya da çekimser kalır). En çok oyu alan asılır ve rolü açıklanır.
4. Soytarı asılırsa **oyun hemen orada biter, soytarı kazanır**. Aksi halde: tüm vampirler ölürse **köylüler kazanır**; vampir sayısı diğer oyuncu sayısına eşit ya da fazla olursa **vampirler kazanır**.

Ölen oyuncular "ölüler sohbeti"nden birbirleriyle konuşmaya devam edebilir
ama canlılara mesaj gönderemez. Vampirler gece kendi aralarında özel bir
kanaldan konuşabilir.

<details>
<summary><strong>Diğer oyun içi ayrıntılar (host kontrolü, rol açıklama, sohbet renkleri...)</strong></summary>

**Host kontrolü — Oyunu Erken Bitir:** Oyun sırasında (gece ya da gündüz
fark etmez) host, faz kartının üstünde beliren **"Oyunu Erken Bitir"**
butonuna basarak oyunu istediği an iptal edebilir. Kimse kazanmış sayılmaz,
herkesin rolü açığa çıkar ve "Tekrar Oyna" ile lobiye dönülür. Yanlışlıkla
basılmasın diye bir onay penceresi çıkar.

**Ölünce rol otomatik açıklanmaz:** Bir oyuncu öldüğünde rolü diğerlerine
otomatik gösterilmez — sadece "Öldü" yazar. Ölen oyuncu isterse rol
kartındaki **"Rolümü Herkese Aç"** butonuna basıp rolünü açıklayabilir,
istemezse oyun bitene kadar gizli kalır (oyun sonunda herkesin rolü zaten
açıklanır).

**Seç + Onayla:** Gece aksiyonlarında (özellikle vampir kurban seçimi) ve
gündüz oylamasında, bir isme tıklamak onu sadece **seçer** — gerçekten
göndermek için ayrıca **"Eminim ✓"** butonuna basman gerekir. Bu sayede
yanlışlıkla tıklayıp erken oy vermezsin; herkes "Eminim"e basınca o faz
(gece ya da oylama) süresi dolmadan erken sonuçlanır.

**Görsel gece/gündüz göstergesi:** Faz kartının başlığında gece 🌙, gündüz
☀️ ikonu belirir; hem faz kartının hem de tüm sayfanın rengi buna göre
değişir — gece koyu, gündüz aynı mor aileden ama daha açık bir ton olur.
Bu renk geçişi 1 saniyelik yumuşak bir animasyonla olur. Ayrıca her yeni
oyun başladığında roller dağıtılmadan önce kısa bir 3-2-1 geri sayım
animasyonu oynar.

**Ölüm efekti:** Biri öldüğünde (gece vampir saldırısıyla ya da gündüz
asılarak) ekranda kısa süreli bir kafatası 💀 efekti ve "... öldü!" yazısı
belirir, sonra otomatik kaybolur.

**Sohbet daha net:** Oyun ekranında sohbet kutusu sola alındı ve
büyütüldü; her mesajın solunda kanalına göre renkli bir çizgi (lobi, gündüz,
vampir, ölüler) olduğu için kimin nerede konuştuğunu ayırt etmek artık
daha kolay. Yeni bir oyun başladığında önceki oyunun sohbet geçmişi
temizlenir.

**Herkesin kendi sohbet rengi:** Tüm oyuncuların ismi sohbette aynı sarı
renkte yazılmıyor — her oyuncuya katıldığında (lobide) birbirinden farklı,
göz alıcı bir renk atanır ve isimleri sohbette hep o renkle görünür. Her
yeni oyun başladığında (roller dağıtılırken) bu renkler yeniden karıştırılıp
taze baştan dağıtılır.

**Kim oy verdi?** Gündüz oylaması sırasında oy kullanan oyuncuların
isminin yanında oyuncu listesinde anlık bir ✓ **"Oy verdi"** etiketi
belirir — kimin henüz oy vermediğini bir bakışta görürsün.

**Bağlantısı kopan oyuncular:** Lobide (oyun başlamadan önce) bağlantısı
kopan biri artık listeden tamamen kaldırılır ve oyuncu sayacı otomatik
güncellenir. (Oyun başladıktan sonra kopan biri, rolünü/durumunu
kaybetmesin diye "Bağlantı yok" etiketiyle listede kalmaya devam eder —
aynı bağlantıyla geri dönebilir.)

</details>

## Proje yapısı

```
vampir-koyu/
├── server/
│   ├── index.js         # Express + Socket.io bootstrap, socket olay handler'ları
│   ├── gameManager.js    # Oda/oyun durum makinesi (gece → gündüz → oylama)
│   ├── roles.js          # Rol tanımları ve oyuncu sayısına göre rol dağıtımı
│   └── db.js              # SQLite şeması ve yardımcı fonksiyonlar
├── public/
│   ├── index.html         # Tek sayfalık arayüz
│   ├── css/style.css       # Gece/gündüz temaları, animasyonlar
│   └── js/client.js        # İstemci mantığı (framework'süz, vanilla JS)
├── ARCHITECTURE.md          # Uçtan uca mimari, veri akışı, tasarım kararları
├── README.md                  # Bu dosya
└── package.json
```

## Güvenlik ve gizlilik notları

- Bu proje bir **arkadaş grubu partisi** için tasarlandı; kullanıcı hesabı,
  şifre, e-posta gibi bir sistem yok. Oda kodunu bilen herkes katılabilir —
  linki sadece davet etmek istediğin kişilerle paylaş.
- Cloudflare quick tunnel her açılışta yeni ve tahmin edilmesi zor bir adres
  üretir; yine de linki halka açık yerlerde paylaşma.
- Oyun verileri (oda/oyuncu/oyun geçmişi, sohbet) `data/vampirkoyu.db`
  dosyasında bilgisayarında saklanır, hiçbir yere gönderilmez ve depoya
  (`.gitignore` ile) dahil edilmez.
- Sunucuyu (`npm start` ve `cloudflared`) kapattığında oyun erişilemez hale
  gelir; bir sonraki oyunda `npm start` + tünel adımlarını tekrarlaman yeterli.

## Sorun giderme

<details>
<summary><strong>Kurulum ve çalıştırma sorunları</strong></summary>

- **"npm: command not found"** → Node.js kurulu değil, [1. Kurulum](#1-kurulum-ilk-sefer) adımına bak.
- **`npm install` hata veriyor** → İnternet bağlantını kontrol et, tekrar dene.
- **Arkadaşların "bağlanamıyor" diyor** → `cloudflared` penceresinin hâlâ açık
  olduğundan ve doğru linki (en son üretilen) paylaştığından emin ol.
- **Oda kodu bulunamadı hatası** → Sunucuyu yeniden başlattıysan (`npm start`)
  önceki odalar bellekte silinir; yeni bir oda kurman gerekir.
- **`npm install` sırasında `better-sqlite3` / `node-gyp` / `v8::...` derleme
  hatası** → Çok yeni bir Node.js sürümü (örn. 25/26 "Current") kullanıyorsun
  ve bu paketin o sürüm için henüz hazır (prebuilt) binary'si yok, kaynaktan
  derlemeye çalışıp başarısız oluyor. Çözüm: [nvm](https://github.com/nvm-sh/nvm)
  ile bir LTS sürüme geç:
  ```bash
  curl -o- https://raw.githubusercontent.com/nvm-sh/nvm/v0.40.1/install.sh | bash
  # terminali yeniden aç, sonra:
  nvm install 22
  nvm use 22
  cd vampir-koyu
  rm -rf node_modules package-lock.json
  npm install
  ```
- **`cloudflared` sürekli "Failed to dial a quic connection" / "Retrying
  connection" yazıp bir türlü bağlanamıyor** → Terminalde ayrıca
  `UDP Connectivity ... FAIL` / `TCP Connectivity ... FAIL` gibi bir tablo
  görüyorsan, bulunduğun ağ `cloudflared`'in kullandığı 7844 portunu
  engelliyordur (kurumsal/okul ağlarında sık görülür). Kendi ev
  internetinden veya telefon hotspot'undan tekrar dene; hâlâ olmuyorsa
  yukarıdaki **"Cloudflare Tunnel bağlanamıyorsa: ngrok'a geç"** bölümündeki
  adımlara geç.

</details>

## Lisans

[MIT](LICENSE) — istediğin gibi kopyalayıp değiştirebilir, kendi arkadaş
grubun için uyarlayabilirsin.
