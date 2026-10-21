"use strict";
const http = require("node:http");
const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const { promisify } = require("node:util");
const scrypt = promisify(crypto.scrypt);
const root = __dirname;
const dataDir = process.env.ORBIT_DATA_DIR || path.join(root, "data");
const dataFile = path.join(dataDir, "orbit.json");
const port = Number(process.env.PORT || 3001);
const memberBaseline = 1428;
const memberGoal = 1500;
const online = new Map();
const sessions = new Map();
const emptyStore = () => ({ users: [], messages: {}, rooms: [], parties: [], servers: [], music: null });
let store = emptyStore();
try { store = { ...emptyStore(), ...JSON.parse(fs.readFileSync(dataFile, "utf8")) }; }
catch (error) { if (error.code !== "ENOENT") console.error("Store read failed:", error.message); }
const text = (value, max = 200) => typeof value === "string" ? value.trim().slice(0, max) : "";
const safeId = value => typeof value === "string" && /^[\w-]{1,100}$/.test(value) ? value : "";
const registeredCount = () => memberBaseline + store.users.length;
function persist() {
  fs.mkdirSync(dataDir, { recursive: true });
  const tmp = `${dataFile}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(store), { mode: 0o600 });
  fs.renameSync(tmp, dataFile);
}
function cookie(req, key) {
  const part = (req.headers.cookie || "").split(";").map(item => item.trim()).find(item => item.startsWith(`${key}=`));
  try { return part ? decodeURIComponent(part.slice(key.length + 1)) : ""; } catch { return ""; }
}
function userFor(req) { const id = sessions.get(cookie(req, "orbit_session")); return store.users.find(user => user.id === id) || null; }
function identity(req, data = {}) { const user = userFor(req); return user ? `user-${user.id}` : safeId(data.guestId) ? `guest-${safeId(data.guestId)}` : ""; }
function safeUser(user) { return user && { id: user.id, name: user.name, email: user.email, emoji: user.emoji, about: user.about || "", status: user.status || "online" }; }
function sendJson(res, status, value, extra = {}) {
  const body = JSON.stringify(value);
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff", ...extra });
  res.end(body);
}
function eventFor(connection, value) {
  if (!connection.res.destroyed && !connection.res.writableEnded) connection.res.write(`event: update\ndata: ${JSON.stringify(value)}\n\n`);
}
function publicMembers() {
  const unique = new Map();
  for (const item of online.values()) unique.set(item.id, { id: item.id, name: item.name, emoji: item.emoji, about: item.about || "", status: item.status || "online", registered: item.registered });
  return [...unique.values()];
}
function broadcast(value, predicate = item => eventVisible(item, value)) { for (const item of online.values()) if (predicate(item)) eventFor(item, value); }
function presence() { broadcast({ type: "presence", members: publicMembers(), registeredCount: registeredCount() }); }
function participants(room) { return [...online.values()].filter(item => item.voiceRoom === room).map(item => ({ peerId: item.peerId, name: item.name, muted: item.muted, deafened: item.deafened })); }
function voiceUpdate(room) {
  broadcast({ type: "voice", room, participants: participants(room) }, item => canReadChannel(room, item.memberKey));
}
function roomMember(room, who) { return !!who && (room.memberKeys || []).includes(who); }
function canReadRoom(room, who) { return room.type !== "party" || roomMember(room, who); }
function serverForChannel(channel) { return (store.servers || []).find(server => (server.channels || []).some(item => item.id === channel)); }
function canReadChannel(channel, who) { const party = store.parties.find(item => item.id === channel), server = serverForChannel(channel); return party ? roomMember(party, who) : !server || roomMember(server, who); }
function publicServer(server) { return { id: server.id, name: server.name, emoji: server.emoji, description: server.description || "", ownerId: server.ownerId, channels: server.channels || [] }; }
function migrateGuestMemberships(guestId, userId) {
  const guestKey = `guest-${safeId(guestId)}`;
  if (guestKey === "guest-") return;
  for (const party of store.parties) {
    if (!(party.memberKeys || []).includes(guestKey)) continue;
    party.memberKeys = party.memberKeys.filter(key => key !== guestKey);
    if (!party.memberKeys.includes(`user-${userId}`)) party.memberKeys.push(`user-${userId}`);
  }
  for (const server of store.servers || []) {
    if (!(server.memberKeys || []).includes(guestKey)) continue;
    server.memberKeys = server.memberKeys.filter(key => key !== guestKey);
    if (!server.memberKeys.includes(`user-${userId}`)) server.memberKeys.push(`user-${userId}`);
    if (server.ownerId === guestKey) server.ownerId = userId;
  }
}
function eventVisible(item, value) {
  if (value.channel) {
    const room = store.parties.find(part => part.id === value.channel);
    if (room && !roomMember(room, item.memberKey)) return false;
    const server = serverForChannel(value.channel);
    if (server && !roomMember(server, item.memberKey)) return false;
  }
  if (value.room && value.type === "room") {
    const room = value.room.type === "party" ? value.room : store.parties.find(part => part.id === value.room.id);
    if (room && !roomMember(room, item.memberKey)) return false;
  }
  if (value.serverId) {
    const server = (store.servers || []).find(entry => entry.id === value.serverId);
    if (server && !roomMember(server, item.memberKey)) return false;
  }
  return true;
}
function live(req, res, url) {
  const user = userFor(req);
  const guestId = safeId(url.searchParams.get("guestId")) || crypto.randomUUID();
  const peerId = safeId(url.searchParams.get("peerId")) || crypto.randomUUID();
  const name = text(user?.name || url.searchParams.get("name"), 32) || "Guest";
  const item = { res, id: user ? `user-${user.id}` : `guest-${guestId}`, memberKey: user ? `user-${user.id}` : `guest-${guestId}`, peerId, name, emoji: user?.emoji || [...name][0].toUpperCase(), about: user?.about || "", status: user?.status || "online", registered: !!user, voiceRoom: "", muted: false, deafened: false };
  res.writeHead(200, { "Content-Type": "text/event-stream; charset=utf-8", "Cache-Control": "no-cache, no-transform", Connection: "keep-alive", "X-Accel-Buffering": "no" });
  res.write(": connected\n\n");
  const old = online.get(peerId);
  if (old && old.res !== res) { old.audioSocket?.end(); old.res.end(); online.delete(peerId); }
  online.set(peerId, item);
  eventFor(item, { type: "presence", members: publicMembers(), registeredCount: registeredCount() });
  presence();
  req.on("close", () => {
    if (online.get(peerId) !== item) return;
    online.delete(peerId);
    item.audioSocket?.end();
    if (item.voiceRoom) voiceUpdate(item.voiceRoom);
    presence();
  });
}
async function readBody(req) {
  let raw = "";
  for await (const chunk of req) { raw += chunk; if (raw.length > 65536) throw Object.assign(new Error("Request body is too large."), { status: 413 }); }
  try { return JSON.parse(raw || "{}"); } catch { throw Object.assign(new Error("Invalid request body."), { status: 400 }); }
}
function cookieHeader(token, req) { return `orbit_session=${encodeURIComponent(token)}; HttpOnly; SameSite=Lax; Path=/; Max-Age=2592000${req.socket.encrypted || process.env.COOKIE_SECURE === "true" ? "; Secure" : ""}`; }
const mime = { ".html": "text/html; charset=utf-8", ".css": "text/css; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".svg": "image/svg+xml", ".png": "image/png", ".jpg": "image/jpeg", ".wav": "audio/wav", ".ico": "image/x-icon" };
const server = http.createServer(async (req, res) => {
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("Referrer-Policy", "strict-origin-when-cross-origin");
  const url = new URL(req.url, `http://${req.headers.host || "localhost"}`);
  const origin = req.headers.origin;
  if (origin) {
    try {
      const parsed = new URL(origin), hosts = new Set(["localhost", "127.0.0.1", "::1"]);
      if (parsed.protocol === "http:" && parsed.hostname === url.hostname && hosts.has(url.hostname)) {
        res.setHeader("Access-Control-Allow-Origin", origin); res.setHeader("Access-Control-Allow-Credentials", "true");
        res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS"); res.setHeader("Access-Control-Allow-Headers", "Content-Type"); res.setHeader("Vary", "Origin");
      }
    } catch {}
  }
  if (req.method === "OPTIONS") { res.writeHead(204); return res.end(); }
  try {
    if (req.method === "GET" && url.pathname === "/health") return sendJson(res, 200, { ok: true, service: "orbit-chat" });
    if (req.method === "GET" && url.pathname === "/api/events") return live(req, res, url);
    if (req.method === "GET" && url.pathname === "/api/me") return sendJson(res, 200, { user: safeUser(userFor(req)) });
    if (req.method === "GET" && url.pathname === "/api/bootstrap") {
      const who = identity(req, { guestId: url.searchParams.get("guestId") });
      const channel = safeId(url.searchParams.get("channel")) || "global";
      if (!canReadChannel(channel, who)) return sendJson(res, 403, { error: "Join this server from its invite link first." });
      return sendJson(res, 200, { messages: (store.messages[channel] || []).slice(-250), rooms: store.rooms, parties: store.parties.filter(item => roomMember(item, who)), servers: (store.servers || []).filter(item => roomMember(item, who)).map(publicServer), music: store.music, members: publicMembers(), registeredCount: registeredCount(), memberGoal });
    }
    if (req.method === "GET" && url.pathname === "/api/messages") {
      const channel = safeId(url.searchParams.get("channel")) || "global", who = identity(req, { guestId: url.searchParams.get("guestId") });
      if (!canReadChannel(channel, who)) return sendJson(res, 403, { error: "Join this server from its invite link first." });
      return sendJson(res, 200, { messages: (store.messages[channel] || []).slice(-250) });
    }
    if (req.method === "POST" && url.pathname === "/api/messages") {
      const data = await readBody(req), channel = safeId(data.channel) || "global", content = text(data.text, 700), who = identity(req, data), user = userFor(req);
      if (!content) return sendJson(res, 400, { error: "Write a message first." });
      if (!who) return sendJson(res, 400, { error: "Refresh the page and try again." });
      if (!canReadChannel(channel, who)) return sendJson(res, 403, { error: "Join this server from its invite link first." });
      const message = { id: crypto.randomUUID(), user: user?.name || text(data.guestName, 32) || "Guest", userId: user?.id || "", registered: !!user, emoji: user?.emoji || "✦", text: content, reactions: {}, createdAt: new Date().toISOString() };
      store.messages[channel] ||= []; store.messages[channel].push(message); store.messages[channel] = store.messages[channel].slice(-250); persist();
      broadcast({ type: "message", channel, message }, item => eventVisible(item, { type: "message", channel }));
      return sendJson(res, 201, { message });
    }
    if (req.method === "POST" && url.pathname === "/api/typing") {
      const data = await readBody(req), channel = safeId(data.channel) || "global", who = identity(req, data), user = userFor(req);
      if (!who) return sendJson(res, 400, { error: "Refresh the page and try again." });
      if (!canReadChannel(channel, who)) return sendJson(res, 403, { error: "Join this server before typing there." });
      const message = { type: data.typing ? "typing" : "typing-stop", channel, id: who, name: user?.name || text(data.guestName, 32) || "Guest" };
      broadcast(message, item => item.memberKey !== who && eventVisible(item, { type: "message", channel }));
      return sendJson(res, 202, { ok: true });
    }
    if (req.method === "POST" && url.pathname === "/api/reactions") {
      const data = await readBody(req), channel = safeId(data.channel) || "global", who = identity(req, data), messageId = safeId(data.messageId), emoji = text(data.emoji, 8);
      if (!canReadChannel(channel, who)) return sendJson(res, 403, { error: "Join this server from its invite link first." });
      const message = (store.messages[channel] || []).find(item => item.id === messageId);
      if (!message) return sendJson(res, 404, { error: "That message is no longer here." });
      message.reactions ||= {}; message.reactions[emoji] ||= [];
      const list = message.reactions[emoji], index = list.findIndex(item => item.id === who);
      if (index >= 0) list.splice(index, 1); else list.push({ id: who, name: text(data.guestName, 32) || "Guest" });
      if (!list.length) delete message.reactions[emoji];
      persist(); broadcast({ type: "reaction", channel, messageId, reactions: message.reactions }, item => eventVisible(item, { type: "message", channel }));
      return sendJson(res, 200, { reactions: message.reactions });
    }
    if (req.method === "POST" && ["/api/rooms", "/api/parties"].includes(url.pathname)) {
      const data = await readBody(req), party = url.pathname.endsWith("parties"), name = text(data.name, 42), who = identity(req, data);
      if (!who) return sendJson(res, 400, { error: "Refresh the page and try again." });
      if (name.length < 2) return sendJson(res, 400, { error: "Give the room a name with at least two characters." });
      const inviteCode = party ? crypto.randomBytes(18).toString("base64url") : "";
      const room = { id: `${party ? "party" : "room"}-${crypto.randomUUID()}`, name, title: name, topic: text(data.topic, 100), emoji: party ? "✦" : "✳", color: party ? "#8069bd" : "#3c998b", type: party ? "party" : "channel", owner: userFor(req)?.name || text(data.owner, 32) || "Guest", memberKeys: [who], inviteCode, createdAt: new Date().toISOString() };
      (party ? store.parties : store.rooms).unshift(room); persist();
      const publicRoom = { ...room }; delete publicRoom.inviteCode;
      broadcast({ type: "room", room: publicRoom });
      return sendJson(res, 201, { room: publicRoom, inviteCode });
    }
    if (req.method === "POST" && url.pathname === "/api/servers") {
      const data = await readBody(req), who = identity(req, data), name = text(data.name, 42), user = userFor(req);
      if (!who) return sendJson(res, 400, { error: "Reconnect to Orbit and try again." });
      if (name.length < 2) return sendJson(res, 400, { error: "Server names need at least two characters." });
      const server = { id: `server-${crypto.randomUUID()}`, name, description: text(data.description, 120), emoji: text(data.emoji, 8) || "✳", ownerId: user?.id || who, memberKeys: [who], inviteCode: crypto.randomBytes(18).toString("base64url"), channels: [{ id: `channel-${crypto.randomUUID()}`, name: "general", type: "text" }, { id: `voice-${crypto.randomUUID()}`, name: "voice-lounge", type: "voice" }], createdAt: new Date().toISOString() };
      store.servers.unshift(server); persist(); broadcast({ type: "server", server: publicServer(server) }, item => roomMember(server, item.memberKey));
      return sendJson(res, 201, { server: publicServer(server), inviteCode: server.inviteCode });
    }
    if (req.method === "POST" && url.pathname === "/api/servers/join") {
      const data = await readBody(req), server = (store.servers || []).find(item => item.id === safeId(data.id)), who = identity(req, data);
      if (!server || !who || !data.inviteCode || data.inviteCode !== server.inviteCode) return sendJson(res, 404, { error: "This server invite is invalid or expired." });
      if (!server.memberKeys.includes(who)) server.memberKeys.push(who); persist();
      broadcast({ type: "server", server: publicServer(server) }, item => roomMember(server, item.memberKey));
      return sendJson(res, 200, { server: publicServer(server) });
    }
    if (req.method === "POST" && url.pathname === "/api/servers/invite") {
      const data = await readBody(req), server = (store.servers || []).find(item => item.id === safeId(data.id)), who = identity(req, data);
      if (!server || !roomMember(server, who)) return sendJson(res, 403, { error: "Join that server before inviting people." });
      server.inviteCode = crypto.randomBytes(18).toString("base64url"); persist(); return sendJson(res, 200, { inviteCode: server.inviteCode });
    }
    if (req.method === "POST" && url.pathname === "/api/servers/channels") {
      const data = await readBody(req), server = (store.servers || []).find(item => item.id === safeId(data.serverId)), who = identity(req, data), user = userFor(req);
      if (!server || !roomMember(server, who)) return sendJson(res, 403, { error: "Join that server before adding a channel." });
      if (server.ownerId !== (user?.id || who)) return sendJson(res, 403, { error: "Only the server owner can add channels." });
      const name = text(data.name, 40).toLowerCase().replace(/\s+/g, "-");
      if (!/^[a-z0-9][a-z0-9-]{0,39}$/.test(name)) return sendJson(res, 400, { error: "Use letters, numbers, and hyphens for the channel name." });
      if (server.channels.some(item => item.name === name)) return sendJson(res, 409, { error: "That channel name already exists." });
      const type = data.type === "voice" ? "voice" : "text", channel = { id: `${type === "voice" ? "voice" : "channel"}-${crypto.randomUUID()}`, name, type };
      server.channels.push(channel); persist(); broadcast({ type: "server", server: publicServer(server) }, item => roomMember(server, item.memberKey));
      return sendJson(res, 201, { channel, server: publicServer(server) });
    }
    if (req.method === "POST" && url.pathname === "/api/parties/join") {
      const data = await readBody(req), room = store.parties.find(item => item.id === safeId(data.id)), who = identity(req, data);
      if (!room || !who || !data.inviteCode || data.inviteCode !== room.inviteCode) return sendJson(res, 404, { error: "This party invite is invalid or expired." });
      if (!room.memberKeys.includes(who)) room.memberKeys.push(who);
      persist(); const publicRoom = { ...room }; delete publicRoom.inviteCode;
      const item = { ...publicRoom };
      broadcast({ type: "room", room: item }, connection => roomMember(room, connection.memberKey));
      return sendJson(res, 200, { room: publicRoom });
    }
    if (req.method === "POST" && url.pathname === "/api/music") {
      const data = await readBody(req), rawUrl = text(data.url, 1000), title = text(data.title, 100); let parsed;
      try { parsed = new URL(rawUrl); } catch { return sendJson(res, 400, { error: "Paste a valid audio, YouTube, or SoundCloud link." }); }
      if (!["http:", "https:"].includes(parsed.protocol)) return sendJson(res, 400, { error: "Use an HTTP or HTTPS link." });
      const audio = /\.(mp3|m4a|ogg|oga|wav|aac|flac|opus)(?:$|\?)/i.test(parsed.pathname + parsed.search);
      if (!audio && !/(^|\.)youtube\.com$|^youtu\.be$|(^|\.)soundcloud\.com$/.test(parsed.hostname)) return sendJson(res, 400, { error: "Use a YouTube, SoundCloud, or direct audio file link." });
      store.music = { url: parsed.toString(), title: title || parsed.hostname, submittedBy: userFor(req)?.name || text(data.guestName, 32) || "Guest", createdAt: new Date().toISOString() };
      persist(); broadcast({ type: "music", track: store.music }); return sendJson(res, 200, { track: store.music });
    }
    if (req.method === "POST" && url.pathname === "/api/register") {
      const data = await readBody(req), name = text(data.name, 32), email = text(data.email, 120).toLowerCase(), password = typeof data.password === "string" ? data.password : "";
      if (name.length < 2) return sendJson(res, 400, { error: "Choose a name with at least two characters." });
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return sendJson(res, 400, { error: "Enter a valid email address." });
      if (password.length < 8 || password.length > 128) return sendJson(res, 400, { error: "Use a password between 8 and 128 characters." });
      if (store.users.some(item => item.email === email)) return sendJson(res, 409, { error: "That email already has an account. Sign in instead." });
      const salt = crypto.randomBytes(16).toString("hex"), hash = (await scrypt(password, salt, 64)).toString("hex");
      const user = { id: crypto.randomUUID(), name, email, salt, passwordHash: hash, emoji: [...name][0].toUpperCase(), about: "", status: "online" };
      migrateGuestMemberships(data.guestId, user.id);
      store.users.push(user); persist(); const token = crypto.randomBytes(32).toString("base64url"); sessions.set(token, user.id); presence();
      return sendJson(res, 201, { user: safeUser(user) }, { "Set-Cookie": cookieHeader(token, req) });
    }
    if (req.method === "POST" && url.pathname === "/api/login") {
      const data = await readBody(req), email = text(data.email, 120).toLowerCase(), password = typeof data.password === "string" ? data.password : "", user = store.users.find(item => item.email === email);
      if (!user || !(await scrypt(password, user.salt, 64)).equals(Buffer.from(user.passwordHash, "hex"))) return sendJson(res, 401, { error: "Email or password didn’t match." });
      migrateGuestMemberships(data.guestId, user.id); if (data.guestId) persist();
      const token = crypto.randomBytes(32).toString("base64url"); sessions.set(token, user.id); return sendJson(res, 200, { user: safeUser(user) }, { "Set-Cookie": cookieHeader(token, req) });
    }
    if (req.method === "POST" && url.pathname === "/api/logout") {
      sessions.delete(cookie(req, "orbit_session")); return sendJson(res, 200, { ok: true }, { "Set-Cookie": "orbit_session=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0" });
    }
    if (req.method === "POST" && url.pathname === "/api/profile") {
      const user = userFor(req); if (!user) return sendJson(res, 401, { error: "Sign in to edit your profile." });
      const data = await readBody(req), name = text(data.name, 32), emoji = text(data.emoji, 8), allowed = new Set(["✦","🌙","🌻","🦊","🐸","🐈","🎧","🚀","🌊","⭐","🍄","🪐"]);
      if (name.length < 2) return sendJson(res, 400, { error: "Your display name needs at least two characters." });
      if (!allowed.has(emoji)) return sendJson(res, 400, { error: "Choose an avatar from the list." });
      user.name = name; user.emoji = emoji; user.about = text(data.about, 100); user.status = ["online","idle","dnd"].includes(data.status) ? data.status : "online";
      for (const peer of online.values()) if (peer.memberKey === `user-${user.id}`) Object.assign(peer, { name, emoji, about: user.about, status: user.status });
      persist(); presence(); return sendJson(res, 200, { user: safeUser(user) });
    }
    if (req.method === "POST" && url.pathname.startsWith("/api/voice/")) {
      const data = await readBody(req), who = identity(req, data), room = safeId(data.room), peerId = safeId(data.peerId);
      const peer = online.get(peerId), roomStore = store.parties.find(item => item.id === room);
      if (roomStore && !roomMember(roomStore, who) || serverForChannel(room) && !canReadChannel(room, who)) return sendJson(res, 403, { error: "Join this server before entering voice." });
      if (url.pathname === "/api/voice/join") {
        if (!peer || peer.memberKey !== who || !room) return sendJson(res, 409, { error: "Your chat connection is still starting. Try again." });
        peer.voiceRoom = room; voiceUpdate(room); return sendJson(res, 200, { participants: participants(room) });
      }
      if (url.pathname === "/api/voice/leave") {
        if (peer?.memberKey === who && peer.voiceRoom) { const previous = peer.voiceRoom; peer.voiceRoom = ""; peer.audioSocket?.end(); peer.audioSocket = null; voiceUpdate(previous); }
        return sendJson(res, 200, { ok: true });
      }
      if (url.pathname === "/api/voice/state") {
        if (!peer || peer.memberKey !== who || peer.voiceRoom !== room) return sendJson(res, 409, { error: "Rejoin voice to change microphone settings." });
        peer.muted = !!data.muted; peer.deafened = !!data.deafened; voiceUpdate(room); return sendJson(res, 200, { ok: true });
      }
      if (url.pathname === "/api/voice/signal") {
        const target = online.get(safeId(data.targetId));
        if (!peer || peer.memberKey !== who || peer.voiceRoom !== room || !target || target.voiceRoom !== room || !data.signal || typeof data.signal !== "object") return sendJson(res, 409, { error: "The other caller left voice. Rejoin and try again." });
        eventFor(target, { type: "signal", room, from: peerId, signal: data.signal }); return sendJson(res, 202, { ok: true });
      }
    }
    if (req.method === "GET" || req.method === "HEAD") {
      const requestPath = decodeURIComponent(url.pathname === "/" ? "/index.html" : url.pathname);
      const file = path.resolve(root, `.${requestPath}`);
      if (!file.startsWith(`${root}${path.sep}`)) return sendJson(res, 403, { error: "Forbidden." });
      let stat; try { stat = fs.statSync(file); } catch { return sendJson(res, 404, { error: "Not found." }); }
      if (!stat.isFile()) return sendJson(res, 404, { error: "Not found." });
      const assetName = path.basename(file);
      const cache = ["index.html", "app.js", "styles.css"].includes(assetName) ? "no-cache" : "public, max-age=300";
      res.writeHead(200, { "Content-Type": mime[path.extname(file)] || "application/octet-stream", "Content-Length": stat.size, "Cache-Control": cache });
      if (req.method === "HEAD") return res.end();
      fs.createReadStream(file).pipe(res); return;
    }
    return sendJson(res, 404, { error: "Unknown Orbit route." });
  } catch (error) {
    if (!res.headersSent) return sendJson(res, error.status || 500, { error: error.status ? error.message : "The server could not complete that request." });
    res.destroy(); if (!error.status) console.error(error);
  }
});
const wsFrame = (opcode, payload) => {
  let header;
  if (payload.length < 126) header = Buffer.from([0x80 | opcode, payload.length]);
  else if (payload.length <= 65535) { header = Buffer.alloc(4); header[0] = 0x80 | opcode; header[1] = 126; header.writeUInt16BE(payload.length, 2); }
  else { header = Buffer.alloc(10); header[0] = 0x80 | opcode; header[1] = 127; header.writeBigUInt64BE(BigInt(payload.length), 2); }
  return Buffer.concat([header, payload]);
};
server.on("upgrade", (req, socket, head) => {
  const url = new URL(req.url, `http://${req.headers.host || "localhost"}`);
  const peerId = safeId(url.searchParams.get("peerId")), room = safeId(url.searchParams.get("room"));
  const peer = online.get(peerId), who = identity(req, { guestId: url.searchParams.get("guestId") });
  const key = req.headers["sec-websocket-key"];
  if (url.pathname !== "/api/voice/audio" || !key || !peer || peer.memberKey !== who || peer.voiceRoom !== room) {
    socket.write("HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n"); socket.destroy(); return;
  }
  const accept = crypto.createHash("sha1").update(`${key}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`).digest("base64");
  socket.write(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`);
  peer.audioSocket?.end(); peer.audioSocket = socket;
  let pending = Buffer.alloc(0);
  const consume = chunk => {
    pending = Buffer.concat([pending, chunk]);
    while (pending.length >= 2) {
      const a = pending[0], b = pending[1], opcode = a & 15, masked = !!(b & 128); let length = b & 127, offset = 2;
      if (length === 126) { if (pending.length < 4) return; length = pending.readUInt16BE(2); offset = 4; }
      else if (length === 127) { if (pending.length < 10) return; const large = pending.readBigUInt64BE(2); if (large > 8192n) { socket.destroy(); return; } length = Number(large); offset = 10; }
      if (!masked || length > 8192) { socket.destroy(); return; }
      if (pending.length < offset + 4 + length) return;
      const mask = pending.subarray(offset, offset + 4), payload = Buffer.from(pending.subarray(offset + 4, offset + 4 + length));
      for (let i = 0; i < payload.length; i++) payload[i] ^= mask[i & 3];
      pending = pending.subarray(offset + 4 + length);
      if (opcode === 8) { socket.end(wsFrame(8, payload)); return; }
      if (opcode === 9) { socket.write(wsFrame(10, payload)); continue; }
      if (opcode !== 2 || peer.muted || peer.deafened || peer.voiceRoom !== room || payload.length < 6) continue;
      const sender = Buffer.from(peer.peerId), packet = Buffer.alloc(2 + sender.length + payload.length);
      packet.writeUInt16BE(sender.length, 0); sender.copy(packet, 2); payload.copy(packet, 2 + sender.length);
      const frame = wsFrame(2, packet);
      for (const recipient of online.values()) if (recipient !== peer && recipient.voiceRoom === room && !recipient.deafened && recipient.audioSocket && !recipient.audioSocket.destroyed) recipient.audioSocket.write(frame);
    }
  };
  socket.on("data", consume); socket.on("close", () => { if (peer.audioSocket === socket) peer.audioSocket = null; });
  socket.on("error", () => { if (peer.audioSocket === socket) peer.audioSocket = null; });
  if (head.length) consume(head);
});
const keepalive = setInterval(() => { for (const item of online.values()) if (!item.res.destroyed) item.res.write(": keepalive\n\n"); }, 20000);
keepalive.unref();
server.listen(port, "0.0.0.0", () => console.log(`Orbit is ready on port ${port}`));
for (const signal of ["SIGINT", "SIGTERM"]) process.on(signal, () => { clearInterval(keepalive); server.close(() => process.exit(0)); });
