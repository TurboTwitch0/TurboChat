import { getStore } from "@netlify/blobs";
import { createHash, randomBytes, randomUUID, scrypt as scryptCallback, timingSafeEqual } from "node:crypto";
import { promisify } from "node:util";

const scrypt = promisify(scryptCallback);
const baseline = 1428;
const goal = 1500;
const maxEvents = 500;
const clean = (value, size = 200) => typeof value === "string" ? value.trim().slice(0, size) : "";
const validId = value => typeof value === "string" && /^[\w-]{1,100}$/.test(value) ? value : "";
const publicUser = user => user ? { id: user.id, name: user.name, email: user.email, emoji: user.emoji } : null;
const safeRoom = room => { if (!room) return room; const { inviteCode, ...value } = room; return value; };
function reply(statusCode, body, extra = {}) {
  const headers = { "content-type": "application/json; charset=utf-8", "cache-control": "no-store", "x-content-type-options": "nosniff", ...extra };
  return new Response(statusCode === 204 ? null : JSON.stringify(body), { status: statusCode, headers });
}
function parseCookie(header, key) {
  const item = (header || "").split(";").map(x => x.trim()).find(x => x.startsWith(`${key}=`));
  try { return item ? decodeURIComponent(item.slice(key.length + 1)) : ""; } catch { return ""; }
}
function identity(data, user) { return user ? `user-${user.id}` : validId(data?.guestId) ? `guest-${validId(data.guestId)}` : ""; }
function isMember(room, who) { return !!who && (room?.memberKeys || []).includes(who); }
function publicMember(entry) { return { id: entry.id, name: entry.name, emoji: entry.emoji, registered: !!entry.registered }; }
function pushEvent(db, event) { db.nextEventSeq = (db.nextEventSeq || 0) + 1; db.events.push({ ...event, seq: db.nextEventSeq, at: Date.now() }); db.events = db.events.slice(-maxEvents); }
const emailKey = email => createHash("sha256").update(email).digest("hex");
async function readMessages(store, db, channel) {
  const merged = new Map((db.messages[channel] || []).map(item => [item.id, item]));
  const { blobs } = await store.list({ prefix: `messages/${channel}/` });
  const recent = blobs.sort((a, b) => a.key.localeCompare(b.key)).slice(-250);
  const records = await Promise.all(recent.map(blob => store.get(blob.key, { type: "json" })));
  for (const item of records) if (item?.id) {
    const previous = merged.get(item.id);
    merged.set(item.id, previous ? { ...item, ...previous, reactions: previous.reactions ?? item.reactions } : item);
  }
  return [...merged.values()].sort((a, b) => new Date(a.createdAt) - new Date(b.createdAt)).slice(-250);
}

export default async function handler(request) {
  const url = new URL(request.url);
  const path = url.pathname.replace(/^\/.netlify\/functions\/api/, "/api").replace(/\/$/, "") || "/";
  const method = request.method.toUpperCase();
  if (method === "OPTIONS") return reply(204, {});
  let data = {};
  if (method !== "GET" && method !== "HEAD") {
    try { data = request.body ? await request.json() : {}; }
    catch { return reply(400, { error: "Invalid request body." }); }
  }
  try {
    const store = getStore("orbit-chat");
    const db = await store.get("state", { type: "json" }) || { users: [], messages: {}, rooms: [], parties: [], music: null, events: [], presence: {} };
    db.users ||= []; db.messages ||= {}; db.rooms ||= []; db.parties ||= []; db.events ||= []; db.presence ||= {}; db.voicePeers ||= {};
    if (!db.eventSequenceVersion) { db.nextEventSeq = 0; for (const event of db.events) event.seq = ++db.nextEventSeq; db.eventSequenceVersion = 1; await store.setJSON("state", db); }
    const session = parseCookie(request.headers.get("cookie"), "orbit_session");
    const sessionUserId = session ? await store.get(`auth/sessions/${session}`, { type: "text" }) : null;
    const userId = sessionUserId || db.sessions?.[session];
    const user = userId ? (await store.get(`auth/users/${userId}`, { type: "json" }) || db.users.find(item => item.id === userId)) : null;
    const who = identity(data, user);
    const setCookie = token => ({ "set-cookie": `orbit_session=${encodeURIComponent(token)}; HttpOnly; SameSite=Lax; Path=/; Max-Age=2592000; Secure` });
    const save = () => store.setJSON("state", db);
    const getParty = channel => db.parties.find(item => item.id === channel);
    const canSee = channel => { const party = getParty(channel); return !party || isMember(party, who); };
    const online = Object.values(db.presence).filter(member => Date.now() - member.seenAt < 30000);
    db.presence = Object.fromEntries(Object.entries(db.presence).filter(([, member]) => Date.now() - member.seenAt < 30000));
    db.voicePeers = Object.fromEntries(Object.entries(db.voicePeers).filter(([, peer]) => Date.now() - peer.seenAt < 30000));

    if (method === "GET" && ["/health", "/api/health"].includes(path)) return reply(200, { ok: true, service: "orbit-netlify" });
    if (method === "GET" && path === "/api/me") return reply(200, { user: publicUser(user) });
    if (method === "POST" && path === "/api/presence") {
      if (!who) return reply(400, { error: "Refresh the page and try again." });
      db.presence[who] = { id: who, name: user?.name || clean(data.guestName, 32) || "Guest", emoji: user?.emoji || "✦", registered: !!user, seenAt: Date.now() };
      for (const peer of Object.values(db.voicePeers)) if (peer.who === who) peer.seenAt = Date.now();
      pushEvent(db, { type: "presence", members: Object.values(db.presence).map(publicMember), registeredCount: baseline + db.users.length }); await save();
      return reply(200, { ok: true });
    }
    if (method === "GET" && path === "/api/bootstrap") {
      const channel = validId(url.searchParams.get("channel")) || "global";
      if (!canSee(channel)) return reply(403, { error: "Join this party from its invite link first." });
      return reply(200, { messages: await readMessages(store, db, channel), rooms: db.rooms, parties: db.parties.filter(room => isMember(room, who)).map(safeRoom), music: db.music, members: online.map(publicMember), registeredCount: baseline + db.users.length, memberGoal: goal });
    }
    if (method === "GET" && path === "/api/messages") {
      const channel = validId(url.searchParams.get("channel")) || "global";
      if (!canSee(channel)) return reply(403, { error: "Join this party from its invite link first." });
      return reply(200, { messages: await readMessages(store, db, channel) });
    }
    if (method === "GET" && path === "/api/updates") {
      const after = Number(url.searchParams.get("after")) || 0;
      const peerId = validId(url.searchParams.get("peerId"));
      return reply(200, { events: db.events.filter(event => event.seq > after && (!event.channel || canSee(event.channel)) && (event.type !== "signal" || event.to === peerId)), nextSeq: db.nextEventSeq || 0, members: online.map(publicMember), registeredCount: baseline + db.users.length });
    }
    if (method === "POST" && path === "/api/messages") {
      const channel = validId(data.channel) || "global", content = clean(data.text, 700);
      if (!content) return reply(400, { error: "Write a message first." });
      if (!who) return reply(400, { error: "Refresh the page and try again." });
      if (!canSee(channel)) return reply(403, { error: "Join this party from its invite link first." });
      const message = { id: randomUUID(), user: user?.name || clean(data.guestName, 32) || "Guest", userId: user?.id || "", registered: !!user, emoji: user?.emoji || "✦", text: content, reactions: {}, createdAt: new Date().toISOString() };
      // Store messages under unique immutable keys so concurrent serverless
      // writes cannot replace another message from the shared state snapshot.
      const messageKey = `messages/${channel}/${message.createdAt.replace(/\D/g, "")}-${message.id}`;
      await store.setJSON(messageKey, message);
      const { blobs } = await store.list({ prefix: `messages/${channel}/` });
      if (blobs.length > 300) {
        for (const old of blobs.sort((a, b) => a.key.localeCompare(b.key)).slice(0, blobs.length - 250)) await store.delete(old.key);
      }
      db.messages[channel] ||= []; db.messages[channel].push(message); db.messages[channel] = db.messages[channel].slice(-250);
      pushEvent(db, { type: "message", channel, message }); await save().catch(() => {}); return reply(201, { message });
    }
    if (method === "POST" && path === "/api/typing") {
      if (!who) return reply(400, { error: "Refresh the page and try again." });
      const channel = validId(data.channel) || "global";
      if (!canSee(channel)) return reply(403, { error: "Join this party before typing there." });
      pushEvent(db, { type: data.typing ? "typing" : "typing-stop", channel, id: who, name: user?.name || clean(data.guestName, 32) || "Guest" }); await save(); return reply(202, { ok: true });
    }
    if (method === "POST" && path === "/api/reactions") {
      const channel = validId(data.channel) || "global", message = (db.messages[channel] || []).find(item => item.id === validId(data.messageId));
      if (!canSee(channel)) return reply(403, { error: "Join this party first." });
      if (!message) return reply(404, { error: "That message is no longer here." });
      message.reactions ||= {}; const emoji = clean(data.emoji, 8); message.reactions[emoji] ||= [];
      const list = message.reactions[emoji], idx = list.findIndex(item => item.id === who);
      if (idx >= 0) list.splice(idx, 1); else list.push({ id: who, name: clean(data.guestName, 32) || "Guest" });
      if (!list.length) delete message.reactions[emoji]; pushEvent(db, { type: "reaction", channel, messageId: message.id, reactions: message.reactions }); await save();
      return reply(200, { reactions: message.reactions });
    }
    if (method === "POST" && ["/api/rooms", "/api/parties"].includes(path)) {
      const party = path.endsWith("parties"), name = clean(data.name, 42);
      if (!who) return reply(400, { error: "Refresh the page and try again." });
      if (name.length < 2) return reply(400, { error: "Give the room a name with at least two characters." });
      const inviteCode = party ? randomBytes(18).toString("base64url") : "";
      const room = { id: `${party ? "party" : "room"}-${randomUUID()}`, name, title: name, topic: clean(data.topic, 100), emoji: party ? "✦" : "✳", color: party ? "#8069bd" : "#3c998b", type: party ? "party" : "channel", owner: user?.name || clean(data.owner, 32) || "Guest", memberKeys: [who], inviteCode, createdAt: new Date().toISOString() };
      (party ? db.parties : db.rooms).unshift(room); pushEvent(db, { type: "room", room: safeRoom(room) }); await save(); return reply(201, { room: safeRoom(room), inviteCode });
    }
    if (method === "POST" && path === "/api/parties/join") {
      const room = db.parties.find(item => item.id === validId(data.id));
      if (!room || !who || !data.inviteCode || data.inviteCode !== room.inviteCode) return reply(404, { error: "This party invite is invalid or expired." });
      if (!room.memberKeys.includes(who)) room.memberKeys.push(who);
      pushEvent(db, { type: "room", room: safeRoom(room) }); await save(); return reply(200, { room: safeRoom(room) });
    }
    if (method === "POST" && path === "/api/music") {
      const rawUrl = clean(data.url, 1000), title = clean(data.title, 100); let parsed;
      try { parsed = new URL(rawUrl); } catch { return reply(400, { error: "Paste a valid audio, YouTube, or SoundCloud link." }); }
      if (!["http:", "https:"].includes(parsed.protocol)) return reply(400, { error: "Use an HTTP or HTTPS link." });
      const audio = /\.(mp3|m4a|ogg|oga|wav|aac|flac|opus)(?:$|\?)/i.test(parsed.pathname + parsed.search);
      if (!audio && !/(^|\.)youtube\.com$|^youtu\.be$|(^|\.)soundcloud\.com$/.test(parsed.hostname)) return reply(400, { error: "Use a YouTube, SoundCloud, or direct audio file link." });
      db.music = { url: parsed.toString(), title: title || parsed.hostname, submittedBy: user?.name || clean(data.guestName, 32) || "Guest", createdAt: new Date().toISOString() };
      pushEvent(db, { type: "music", track: db.music }); await save(); return reply(200, { track: db.music });
    }
    if (method === "POST" && path === "/api/register") {
      const name = clean(data.name, 32), email = clean(data.email, 120).toLowerCase(), password = typeof data.password === "string" ? data.password : "";
      if (name.length < 2) return reply(400, { error: "Choose a name with at least two characters." });
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return reply(400, { error: "Enter a valid email address." });
      if (password.length < 8 || password.length > 128) return reply(400, { error: "Use a password between 8 and 128 characters." });
      const indexedUser = email ? await store.get(`auth/emails/${emailKey(email)}`, { type: "json" }) : null;
      if (indexedUser || db.users.some(item => item.email === email)) return reply(409, { error: "That email already has an account. Sign in instead." });
      const salt = randomBytes(16).toString("hex"), hash = (await scrypt(password, salt, 64)).toString("hex");
      const created = { id: randomUUID(), name, email, salt, passwordHash: hash, emoji: [...name][0].toUpperCase() };
      db.users.push(created); db.sessions ||= {}; const token = randomBytes(32).toString("base64url"); db.sessions[token] = created.id;
      await Promise.all([store.setJSON(`auth/users/${created.id}`, created), store.setJSON(`auth/emails/${emailKey(email)}`, created), store.set(`auth/sessions/${token}`, created.id)]);
      pushEvent(db, { type: "presence", members: online.map(publicMember), registeredCount: baseline + db.users.length }); await save().catch(() => {});
      return reply(201, { user: publicUser(created) }, setCookie(token));
    }
    if (method === "POST" && path === "/api/login") {
      const email = clean(data.email, 120).toLowerCase(), password = typeof data.password === "string" ? data.password : "";
      const found = await store.get(`auth/emails/${emailKey(email)}`, { type: "json" }) || db.users.find(item => item.email === email);
      if (!found || password.length > 128 || !(await scrypt(password, found.salt, 64)).equals(Buffer.from(found.passwordHash, "hex"))) return reply(401, { error: "Email or password didn’t match." });
      const token = randomBytes(32).toString("base64url"); await store.set(`auth/sessions/${token}`, found.id); db.sessions ||= {}; db.sessions[token] = found.id; await save().catch(() => {}); return reply(200, { user: publicUser(found) }, setCookie(token));
    }
    if (method === "POST" && path === "/api/logout") {
      if (session) await store.delete(`auth/sessions/${session}`); if (db.sessions) delete db.sessions[session]; await save().catch(() => {}); return reply(200, { ok: true }, { "set-cookie": "orbit_session=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0; Secure" });
    }
    if (path === "/api/voice/join" && method === "POST") {
      const room = validId(data.room), peerId = validId(data.peerId);
      if (!who || !room || !peerId) return reply(400, { error: "Reconnect to chat before joining voice." });
      if (!canSee(room)) return reply(403, { error: "Join this party before entering voice." });
      const previous = db.voicePeers[peerId];
      const sameSession = previous?.who === who && previous?.room === room;
      const peer = { peerId, room, who, name: user?.name || clean(data.guestName, 32) || "Guest", muted: sameSession && previous.muted, deafened: sameSession && previous.deafened, seenAt: Date.now() };
      db.voicePeers[peerId] = peer;
      const participants = Object.values(db.voicePeers).filter(item => item.room === room).map(({ peerId, name, muted, deafened }) => ({ peerId, name, muted, deafened }));
      // A join also acts as a heartbeat. Only announce a roster change so this
      // repair path does not flood the shared event log while people are talking.
      if (!previous || previous.room !== room || previous.name !== peer.name) pushEvent(db, { type: "voice", room, participants });
      await save(); return reply(200, { participants });
    }
    if (path === "/api/voice/leave" && method === "POST") {
      const peerId = validId(data.peerId), peer = db.voicePeers[peerId];
      if (peer && peer.who === who) {
        const room = peer.room; delete db.voicePeers[peerId];
        pushEvent(db, { type: "voice", room, participants: Object.values(db.voicePeers).filter(item => item.room === room).map(({ peerId, name, muted, deafened }) => ({ peerId, name, muted, deafened })) });
      }
      await save(); return reply(200, { ok: true });
    }
    if (path === "/api/voice/state" && method === "POST") {
      const peer = db.voicePeers[validId(data.peerId)];
      if (!peer || peer.who !== who || peer.room !== validId(data.room)) return reply(409, { error: "Rejoin voice to change microphone settings." });
      peer.muted = !!data.muted; peer.deafened = !!data.deafened; peer.seenAt = Date.now();
      pushEvent(db, { type: "voice", room: peer.room, participants: Object.values(db.voicePeers).filter(item => item.room === peer.room).map(({ peerId, name, muted, deafened }) => ({ peerId, name, muted, deafened })) }); await save(); return reply(200, { ok: true });
    }
    if (path === "/api/voice/signal" && method === "POST") {
      const from = db.voicePeers[validId(data.peerId)], targetId = validId(data.targetId), target = db.voicePeers[targetId];
      if (!from || from.who !== who || from.room !== validId(data.room) || !target || target.room !== from.room || !data.signal || typeof data.signal !== "object") return reply(409, { error: "The other caller left voice. Rejoin and try again." });
      pushEvent(db, { type: "signal", room: from.room, from: from.peerId, to: targetId, signal: data.signal }); await save(); return reply(202, { ok: true });
    }
    if (path.startsWith("/api/voice/")) return reply(404, { error: "Unknown voice route." });
    return reply(404, { error: "Unknown Orbit route." });
  } catch (error) {
    console.error("Netlify API error:", error);
    return reply(500, { error: "The chat service could not complete this request. Check Netlify function logs." });
  }
}
