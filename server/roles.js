// roles.js — Rol tanımları ve oyuncu sayısına göre rol dağıtımı.

const ROLES = {
  villager: {
    key: 'villager',
    name: 'Köylü',
    team: 'villagers',
    description: 'Özel bir yeteneğin yok. Gündüz tartışıp doğru kişiyi asarak vampirleri bulmaya çalış.',
  },
  vampire: {
    key: 'vampire',
    name: 'Vampir',
    team: 'vampires',
    description: 'Her gece diğer vampirlerle birlikte bir kurbanı seçip öldürürsünüz. Kimliğini gündüz gizli tut.',
  },
  jester: {
    key: 'jester',
    name: 'Soytarı',
    team: 'neutral',
    description: 'Kimsenin takımında değilsin. Gece yapabileceğin bir şey yok. Tek amacın: gündüz oylamasıyla asılmak! Asılırsan oyunu tek başına kazanırsın ve oyun orada biter.',
  },
  doctor: {
    key: 'doctor',
    name: 'Doktor',
    team: 'villagers',
    description: 'Her gece bir oyuncuyu (kendin dahil) koru; o kişi o gece vampir saldırısından kurtulur.',
  },
};

const MIN_PLAYERS = 4;

// Basit Fisher-Yates karıştırma.
function shuffle(arr) {
  const a = arr.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

// Oyuncu sayısına göre rol sayıları belirler. Yaklaşık her 4 oyuncudan
// biri vampir olur; 4+ oyuncuda 1 soytarı, 5+ oyuncuda 1 doktor eklenir.
// Vampir takımı hiçbir zaman diğer takıma eşit ya da fazla başlamaz.
function computeRoleCounts(playerCount) {
  if (playerCount < MIN_PLAYERS) {
    throw new Error(`En az ${MIN_PLAYERS} oyuncu gerekli.`);
  }
  let vampireCount = Math.max(1, Math.floor(playerCount / 4));
  const jesterCount = 1;
  const doctorCount = playerCount >= 5 ? 1 : 0;

  // Vampir takımının köy takımından az kalmasını garanti et.
  while (vampireCount >= playerCount - vampireCount && vampireCount > 1) {
    vampireCount--;
  }

  const villagerCount = playerCount - vampireCount - jesterCount - doctorCount;
  return { vampireCount, jesterCount, doctorCount, villagerCount: Math.max(0, villagerCount) };
}

// players: [{clientToken, ...}] — dönen dizi aynı sırada değil, karıştırılmış
// {clientToken -> roleKey} eşlemesi döner.
function assignRoles(players) {
  const counts = computeRoleCounts(players.length);
  const pool = [
    ...Array(counts.vampireCount).fill('vampire'),
    ...Array(counts.jesterCount).fill('jester'),
    ...Array(counts.doctorCount).fill('doctor'),
    ...Array(counts.villagerCount).fill('villager'),
  ];
  const shuffledRoles = shuffle(pool);
  const shuffledPlayers = shuffle(players);
  const assignment = new Map();
  shuffledPlayers.forEach((p, i) => assignment.set(p.clientToken, shuffledRoles[i]));
  return assignment;
}

module.exports = { ROLES, MIN_PLAYERS, computeRoleCounts, assignRoles, shuffle };
