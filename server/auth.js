// auth.js — E-posta + şifre ile hesap oluşturma/giriş ve oturum (session)
// yönetimi. Bu proje self-hosted, küçük bir arkadaş grubu partisi için
// tasarlandığından bilinçli olarak sade tutuldu: e-posta doğrulama/şifre
// sıfırlama YOK (mail sunucusu gerektirir), oturumlar süresiz geçerlidir.
// Şifreler asla düz metin saklanmaz — Node'un kendi crypto.scrypt'i ile
// tuzlanıp (salt) hash'lenir; bcrypt gibi ekstra bir native bağımlılık
// eklemeye gerek kalmaz.

const crypto = require('crypto');
const db = require('./db');

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
// Kullanıcı adı: 2-20 karakter, harf/rakam/alt çizgi (Türkçe karakterler dahil).
const USERNAME_RE = /^[a-zA-Z0-9ğüşıöçĞÜŞİÖÇ_]{2,20}$/;

function hashPassword(password) {
  const salt = crypto.randomBytes(16).toString('hex');
  const hash = crypto.scryptSync(password, salt, 64).toString('hex');
  return `${salt}:${hash}`;
}

function verifyPassword(password, stored) {
  const [salt, hash] = String(stored || '').split(':');
  if (!salt || !hash) return false;
  const check = crypto.scryptSync(password, salt, 64).toString('hex');
  const a = Buffer.from(hash, 'hex');
  const b = Buffer.from(check, 'hex');
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b); // zamanlama saldırılarına karşı sabit-zamanlı karşılaştırma
}

function createSession(userId) {
  const token = crypto.randomBytes(32).toString('hex');
  db.createSession(token, userId);
  return token;
}

function toPublicUser(user) {
  return { id: user.id, username: user.username, email: user.email };
}

function register({ email, password, username }) {
  email = String(email || '').trim().toLowerCase();
  username = String(username || '').trim();
  password = String(password || '');

  if (!EMAIL_RE.test(email)) throw new Error('INVALID_EMAIL');
  if (password.length < 6) throw new Error('WEAK_PASSWORD');
  if (!USERNAME_RE.test(username)) throw new Error('INVALID_USERNAME');
  if (db.getUserByEmail(email)) throw new Error('EMAIL_TAKEN');
  if (db.getUserByUsername(username)) throw new Error('USERNAME_TAKEN');

  const user = db.createUser(email, username, hashPassword(password));
  const token = createSession(user.id);
  return { token, user: toPublicUser(user) };
}

function login({ email, password }) {
  email = String(email || '').trim().toLowerCase();
  password = String(password || '');
  const user = db.getUserByEmail(email);
  if (!user || !verifyPassword(password, user.password_hash)) throw new Error('INVALID_CREDENTIALS');
  const token = createSession(user.id);
  return { token, user: toPublicUser(user) };
}

function getUserBySessionToken(token) {
  if (!token) return null;
  const session = db.getSession(token);
  if (!session) return null;
  const user = db.getUserById(session.user_id);
  return user ? toPublicUser(user) : null;
}

function logout(token) {
  if (token) db.deleteSession(token);
}

module.exports = { register, login, getUserBySessionToken, logout };
