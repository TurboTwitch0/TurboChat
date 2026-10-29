import test from "node:test";
import assert from "node:assert/strict";
import { createHash, randomBytes } from "node:crypto";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createApiHandler } from "../netlify/functions/api.mjs";

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const credentials = { name: "Session Check", email: "session-check@example.invalid", password: "isolated-test-password", guestId: "isolated-guest" };
const cookieOf = response => response.headers.get("set-cookie")?.split(";")[0] || "";

function hostedFixture() {
  const records = new Map();
  const reads = [];
  const store = {
    async get(key, options = {}) { reads.push({ key, ...options }); const value = records.get(key); return value === undefined ? null : options.type === "json" ? JSON.parse(value) : value; },
    async set(key, value) { records.set(key, value); },
    async setJSON(key, value) { records.set(key, JSON.stringify(value)); },
    async delete(key) { records.delete(key); },
    async list({ prefix }) { return { blobs: [...records.keys()].filter(key => key.startsWith(prefix)).map(key => ({ key })) }; }
  };
  const storeConfigurations = [];
  const handler = createApiHandler(options => { storeConfigurations.push(options); return store; });
  const request = (url, body, cookie = "") => handler(new Request(`https://orbit.test${url}`, { method: body ? "POST" : "GET", headers: { "Content-Type": "application/json", cookie }, ...(body ? { body: JSON.stringify(body) } : {}) }));
  return { records, reads, store, request, handler, storeConfigurations };
}

async function registerCleanupAccount(request, tag) {
  const data = { name: `Cleanup ${tag}`, email: `cleanup-${tag}@example.invalid`, password: "isolated-cleanup-password", guestId: `cleanup-${tag}` };
  const response = await request("/api/register", data);
  assert.equal(response.status, 201);
  return { data, cookie: cookieOf(response), user: (await response.json()).user };
}

async function checkUnknownPrivateChannels(request) {
  for (const channel of ["party-unknown", "channel-unknown", "voice-unknown"]) {
    for (const route of ["bootstrap", "messages"]) assert.equal((await request(`/api/${route}?channel=${channel}&guestId=unknown-space-guest`)).status, 403);
    for (const route of ["messages", "typing", "reactions", "voice/join", "voice/state", "voice/signal"]) {
      const response = await request(`/api/${route}`, { guestId: "unknown-space-guest", channel, room: channel, peerId: "unknown-space-peer", targetId: "unknown-target", text: "Do not make private IDs public", messageId: "unknown-message", emoji: "💜", signal: {} });
      assert.equal(response.status, 403, `${route} must deny missing private space ${channel}`);
    }
  }
}

test("ordinary hosted membership and message routes consistently request strong reads", async () => {
  const { request, records, store, reads, storeConfigurations } = hostedFixture();
  const guestId = "strong-space-owner";
  const { room } = await (await request("/api/parties", { guestId, name: "Immediate private conversation" })).json();
  const posted = await request("/api/messages", { guestId, channel: room.id, text: "Available immediately after creation" });
  assert.equal(posted.status, 201);
  const message = (await posted.json()).message;
  const loaded = await request(`/api/messages?channel=${room.id}&guestId=${guestId}`);
  assert.equal(loaded.status, 200);
  assert.equal((await loaded.json()).messages[0].id, message.id);
  assert.equal((await request(`/api/bootstrap?channel=${room.id}&guestId=${guestId}`)).status, 200);
  assert.equal((await request(`/api/updates?after=0&guestId=${guestId}`)).status, 200);
  assert.ok(storeConfigurations.length >= 5);
  assert.ok(storeConfigurations.every(options => options?.name === "orbit-chat" && options.consistency === "strong"), "ordinary requests must use the strong store, including message listings");
  const stateReads = reads.filter(read => read.key === "state"), messageReads = reads.filter(read => read.key.startsWith("messages/"));
  assert.ok(stateReads.length >= 5 && stateReads.every(read => read.consistency === "strong"));
  assert.ok(messageReads.length > 0 && messageReads.every(read => read.consistency === "strong"));

  await checkUnknownPrivateChannels(request);
  const state = JSON.parse(records.get("state"));
  state.events.push({ type: "message", channel: "channel-unknown", message: { id: "private-stale-message", text: "Never expose this" }, seq: ++state.nextEventSeq });
  state.events.push({ type: "voice", room: "voice-unknown", participants: [{ peerId: "private-peer", name: "Private caller" }], seq: ++state.nextEventSeq });
  await store.setJSON("state", state);
  const updates = (await (await request("/api/updates?after=0&guestId=unknown-space-guest")).json()).events;
  assert.ok(!updates.some(event => event.channel === "channel-unknown" || event.room === "voice-unknown"));
});

async function checkCleanupRejections(request) {
  assert.equal((await request("/api/parties/delete", { id: "party-unknown", confirmName: "Unknown" })).status, 401);
  assert.equal((await request("/api/account/delete", { password: "unused", confirmation: "DELETE" })).status, 401);
  const owner = await registerCleanupAccount(request, "rejections-owner"), visitor = await registerCleanupAccount(request, "rejections-visitor");
  const created = await request("/api/parties", { name: "Shared party" }, owner.cookie);
  assert.equal(created.status, 201);
  const { room, inviteCode } = await created.json();
  assert.equal(room.ownerId, owner.user.id);
  assert.equal((await request("/api/parties/delete", { id: room.id, confirmName: "shared party" }, owner.cookie)).status, 400);
  assert.equal((await request("/api/parties/delete", { id: room.id, confirmName: room.name }, visitor.cookie)).status, 403);
  assert.equal((await request("/api/account/delete", { password: "wrong-password", confirmation: "DELETE" }, owner.cookie)).status, 401);
  assert.equal((await request("/api/account/delete", { password: owner.data.password, confirmation: "delete" }, owner.cookie)).status, 400);
  assert.equal((await request("/api/account/delete", { password: owner.data.password, confirmation: "DELETE" }, owner.cookie)).status, 409);
  assert.equal((await request("/api/parties/join", { id: room.id, inviteCode }, visitor.cookie)).status, 200);
  assert.equal((await request("/api/parties/delete", { id: room.id, confirmName: room.name }, owner.cookie)).status, 409);
  const author = await registerCleanupAccount(request, "rejections-author");
  assert.equal((await request("/api/messages", { channel: "global", text: "Keep authored content" }, author.cookie)).status, 201);
  assert.equal((await request("/api/account/delete", { password: author.data.password, confirmation: "DELETE" }, author.cookie)).status, 409);
  const serverOwner = await registerCleanupAccount(request, "rejections-server");
  assert.equal((await request("/api/servers", { name: "Keep this server" }, serverOwner.cookie)).status, 201);
  assert.equal((await request("/api/account/delete", { password: serverOwner.data.password, confirmation: "DELETE" }, serverOwner.cookie)).status, 409);
  await checkUnknownPrivateChannels(request);
  return { owner, room };
}

test("hosted cleanup rejects unauthorized, unconfirmed, shared, legacy, and used data", async () => {
  const { request, records, store } = hostedFixture();
  const { owner } = await checkCleanupRejections(request);
  const created = await request("/api/parties", { name: "Protected legacy party" }, owner.cookie);
  const { room } = await created.json();
  let state = JSON.parse(records.get("state"));
  delete state.parties.find(party => party.id === room.id).ownerId;
  await store.setJSON("state", state);
  assert.equal((await request("/api/parties/delete", { id: room.id, confirmName: room.name }, owner.cookie)).status, 409);
  const foreignParty = (await (await request("/api/parties", { name: "Protected foreign message" }, owner.cookie)).json()).room;
  await store.setJSON(`messages/${foreignParty.id}/20261029000000000-foreign`, { id: "foreign", userId: "another-account", text: "Keep someone else's message" });
  assert.equal((await request("/api/parties/delete", { id: foreignParty.id, confirmName: foreignParty.name }, owner.cookie)).status, 409);
  assert.ok(records.has(`messages/${foreignParty.id}/20261029000000000-foreign`));
  const durableAuthor = await registerCleanupAccount(request, "durable-author");
  await store.setJSON("messages/music/20261029000000000-durable", { id: "durable", userId: durableAuthor.user.id, text: "Not in the shared state cache" });
  assert.equal((await request("/api/account/delete", { password: durableAuthor.data.password, confirmation: "DELETE" }, durableAuthor.cookie)).status, 409);
});

test("hosted sole-party and unused-account cleanup resists stale state and old credentials", async () => {
  const { request, records, store, reads, storeConfigurations } = hostedFixture();
  const other = await registerCleanupAccount(request, "unchanged-other");
  const publicRoom = (await (await request("/api/rooms", { name: "Keep this public room" }, other.cookie)).json()).room;
  const otherMessage = (await (await request("/api/messages", { channel: publicRoom.id, text: "Keep this other-account text" }, other.cookie)).json()).message;
  const owner = await registerCleanupAccount(request, "complete-owner");
  const secondSession = cookieOf(await request("/api/login", owner.data));
  const { room, inviteCode } = await (await request("/api/parties", { name: "Delete only this private party" }, owner.cookie)).json();
  assert.equal((await request("/api/messages", { channel: room.id, text: "My disposable private text" }, owner.cookie)).status, 201);
  assert.equal((await request("/api/voice/join", { room: room.id, peerId: "cleanup-peer" }, owner.cookie)).status, 200);
  const staleState = JSON.parse(records.get("state")), oldProfile = JSON.parse(records.get(`auth/users/${owner.user.id}`));
  const oldSessions = [...records.entries()].filter(([key]) => key.startsWith("auth/sessions/"));
  const removed = await request("/api/parties/delete", { id: room.id, confirmName: room.name }, owner.cookie);
  assert.equal(removed.status, 200);
  assert.equal((await removed.json()).ok, true);
  assert.ok(![...records.keys()].some(key => key.startsWith(`messages/${room.id}/`)));
  const afterParty = JSON.parse(records.get("state"));
  assert.ok(!afterParty.parties.some(party => party.id === room.id));
  assert.equal(afterParty.messages[room.id], undefined);
  assert.ok(!afterParty.events.some(event => event.channel === room.id || event.room === room.id || event.room?.id === room.id));
  assert.ok(!Object.values(afterParty.voicePeers).some(peer => peer.room === room.id));

  await store.setJSON("state", staleState);
  for (const cookie of [owner.cookie, ""]) {
    assert.equal((await request(`/api/messages?channel=${room.id}`, null, cookie)).status, 403);
    assert.equal((await request(`/api/bootstrap?channel=${room.id}`, null, cookie)).status, 403);
    const events = (await (await request("/api/updates?after=0", null, cookie)).json()).events;
    assert.ok(!events.some(event => event.channel === room.id || event.room === room.id || event.room?.id === room.id));
  }
  assert.equal((await request("/api/parties/join", { id: room.id, inviteCode }, other.cookie)).status, 404);
  for (const route of ["messages", "typing", "reactions", "voice/join"]) assert.equal((await request(`/api/${route}`, { channel: room.id, room: room.id, peerId: "cleanup-peer", text: "Cannot resurrect" }, owner.cookie)).status, 403);
  assert.equal((await request("/api/bootstrap", null, owner.cookie)).status, 200);
  const deleted = await request("/api/account/delete", { password: owner.data.password, confirmation: "DELETE" }, owner.cookie);
  assert.equal(deleted.status, 200);
  assert.match(deleted.headers.get("set-cookie"), /Max-Age=0/);
  assert.equal(records.has(`auth/users/${owner.user.id}`), false);
  await store.setJSON("state", staleState);
  await store.setJSON(`auth/users/${owner.user.id}`, oldProfile);
  const emailHash = createHash("sha256").update(owner.data.email).digest("hex");
  await store.setJSON(`auth/emails/${emailHash}`, oldProfile);
  for (const [key, value] of oldSessions) await store.set(key, value);
  for (const cookie of [owner.cookie, secondSession]) assert.equal((await (await request("/api/me", null, cookie)).json()).user, null);
  assert.equal((await request("/api/login", owner.data)).status, 401);
  assert.equal((await request("/api/profile", { name: "Cannot restore", emoji: "✦" }, owner.cookie)).status, 401);
  const replacementData = { ...owner.data, password: "new-isolated-password" };
  const replacement = await request("/api/register", replacementData);
  assert.equal(replacement.status, 201);
  const newUser = (await replacement.json()).user;
  assert.notEqual(newUser.id, owner.user.id);
  await store.setJSON(`auth/emails/${emailHash}`, oldProfile); // A late old profile save must not replace the new login owner.
  assert.equal((await request("/api/login", owner.data)).status, 401);
  assert.equal((await (await request("/api/login", replacementData)).json()).user.id, newUser.id);
  assert.equal((await (await request("/api/login", other.data)).json()).user.id, other.user.id);
  const unchanged = await (await request(`/api/messages?channel=${publicRoom.id}`, null, other.cookie)).json();
  assert.deepEqual(unchanged.messages.find(message => message.id === otherMessage.id), otherMessage);
  const health = await (await request("/api/health")).json();
  assert.equal(health.release, "turbochat-21"); assert.equal(health.features.safeSelfCleanup, true);
  assert.equal((await (await request("/api/bootstrap")).json()).features.safeSelfCleanup, true);
  assert.ok(storeConfigurations.some(options => options?.consistency === "strong"));
  assert.ok(reads.filter(read => read.key.startsWith("deleted-parties/") || read.key.startsWith("auth/deleted-")).every(read => read.consistency === "strong"));
});

async function checkReplyContract(request) {
  const guestId = "reply-owner", sender = { guestId, guestName: "Original-author-".repeat(4) };
  const originalResponse = await request("/api/messages", { ...sender, channel: "global", text: "Original message content. ".repeat(16) });
  assert.equal(originalResponse.status, 201);
  const original = (await originalResponse.json()).message;
  assert.equal(original.replyTo, undefined, "ordinary messages retain their existing format");
  const expected = { id: original.id, user: original.user.slice(0, 32), text: original.text.slice(0, 180) };
  const response = await request("/api/messages", {
    guestId, guestName: "Reply author", channel: "global", text: "A reply with context", replyTo: original.id,
    replySnapshot: { id: "forged-id", user: "Forged author", text: "Forged original" }
  });
  assert.equal(response.status, 201);
  const reply = (await response.json()).message;
  assert.deepEqual(reply.replyTo, expected, "the server constructs the preview from the stored target");
  assert.equal(reply.replyTo.user.length, 32);
  assert.equal(reply.replyTo.text.length, 180);
  const history = await (await request(`/api/messages?channel=global&guestId=${guestId}`)).json();
  assert.deepEqual(history.messages.find(message => message.id === reply.id).replyTo, expected);

  const plain = await request("/api/messages", { guestId, channel: "global", text: "No reply selected", replyTo: "" });
  assert.equal(plain.status, 201);
  assert.equal((await plain.json()).message.replyTo, undefined);
  for (const replyTo of [null, {}, [], 42, true, "../other-channel", " target ", "x".repeat(101)]) {
    const invalid = await request("/api/messages", { guestId, channel: "global", text: "Invalid reply", replyTo });
    assert.equal(invalid.status, 400, `malformed reply target ${JSON.stringify(replyTo)} must be rejected`);
    assert.match((await invalid.json()).error, /valid message to reply/);
  }
  for (const [channel, replyTo] of [["global", "missing-message"], ["music", original.id]]) {
    const unavailable = await request("/api/messages", { guestId, channel, text: "Unavailable reply", replyTo });
    assert.equal(unavailable.status, 400);
    assert.match((await unavailable.json()).error, /no longer available in this conversation/);
  }

  const created = await request("/api/servers", { name: "Private replies", guestId });
  assert.equal(created.status, 201);
  const privateChannel = (await created.json()).server.channels[0].id;
  const privateOriginalResponse = await request("/api/messages", { guestId, channel: privateChannel, text: "Private original content" });
  assert.equal(privateOriginalResponse.status, 201);
  const privateOriginal = (await privateOriginalResponse.json()).message;
  const privateReplyResponse = await request("/api/messages", { guestId, channel: privateChannel, text: "Private reply", replyTo: privateOriginal.id });
  assert.equal(privateReplyResponse.status, 201);
  const privateReply = (await privateReplyResponse.json()).message;
  assert.equal(privateReply.replyTo.id, privateOriginal.id);
  assert.equal((await request(`/api/messages?channel=${privateChannel}&guestId=reply-outsider`)).status, 403);
  assert.equal((await request("/api/messages", { guestId: "reply-outsider", channel: privateChannel, text: "Unauthorized reply", replyTo: privateOriginal.id })).status, 403);
  const leakedReference = await request("/api/messages", { guestId: "reply-outsider", channel: "global", text: "Cross-channel reply", replyTo: privateOriginal.id });
  assert.equal(leakedReference.status, 400);
  assert.ok(!(await leakedReference.text()).includes(privateOriginal.text), "an unavailable reply error must not reveal private content");
  return { guestId, original, reply, expected, privateChannel, privateReply };
}

test("hosted replies persist trusted previews and reject invalid or inaccessible targets", async () => {
  const { request, records, store, reads } = hostedFixture();
  const { guestId, original, reply, expected, privateChannel, privateReply } = await checkReplyContract(request);
  const persisted = [...records.entries()].find(([key, value]) => key.startsWith("messages/global/") && JSON.parse(value).id === reply.id);
  assert.deepEqual(JSON.parse(persisted[1]).replyTo, expected);
  const ownUpdates = await (await request(`/api/updates?after=0&guestId=${guestId}`)).json();
  assert.deepEqual(ownUpdates.events.find(event => event.message?.id === reply.id).message.replyTo, expected);
  assert.equal(ownUpdates.events.find(event => event.message?.id === privateReply.id).message.replyTo.text, "Private original content");
  const outsiderUpdates = await (await request("/api/updates?after=0&guestId=reply-outsider")).json();
  assert.ok(!outsiderUpdates.events.some(event => event.channel === privateChannel));

  // The immutable message is authoritative even when a concurrent shared-state
  // save omitted it from the cached channel history.
  const state = JSON.parse(records.get("state"));
  state.messages.global = [];
  await store.setJSON("state", state);
  const fromBlob = await request("/api/messages", { guestId, channel: "global", text: "Reply to durable target", replyTo: original.id });
  assert.equal(fromBlob.status, 201);
  assert.deepEqual((await fromBlob.json()).message.replyTo, expected);
  assert.ok(reads.some(read => read.key.startsWith("messages/global/") && read.consistency === "strong"));
});

test('hosted API rejects JSON values that are not request objects before accessing storage', async () => {
  const { handler, records, reads } = hostedFixture();
  for (const data of [null, [], 'text', 42, true]) {
    const response = await handler(new Request('https://orbit.test/api/register', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(data)
    }));
    assert.equal(response.status, 400);
    assert.match((await response.json()).error, /JSON object/);
  }
  assert.equal(records.size, 0);
  assert.equal(reads.length, 0);
});

test("hosted accounts retain sessions, reject bad passwords, and revoke on sign-out", async () => {
  const { request, records, reads } = hostedFixture();
  const created = await request("/api/register", credentials);
  assert.equal(created.status, 201);
  assert.match(created.headers.get("set-cookie"), /HttpOnly; SameSite=Lax.*Secure/);
  const cookie = cookieOf(created), user = (await created.json()).user;
  assert.equal((await (await request("/api/me", null, cookie)).json()).user.id, user.id);
  assert.equal((await request("/api/login", { ...credentials, password: "wrong-password" })).status, 401);
  const login = await request("/api/login", { ...credentials, email: credentials.email.toUpperCase() });
  assert.equal(login.status, 200);
  const newCookie = cookieOf(login);
  assert.notEqual(newCookie, cookie);
  assert.equal((await (await request("/api/me", null, newCookie)).json()).user.id, user.id);
  const logout = await request("/api/logout", {}, newCookie);
  assert.equal(logout.status, 200);
  assert.match(logout.headers.get("set-cookie"), /Max-Age=0/);
  assert.equal((await (await request("/api/me", null, newCookie)).json()).user, null);
  const authReads = reads.filter(read => read.key.startsWith("auth/"));
  assert.ok(authReads.length > 0 && authReads.every(read => read.consistency === "strong"));
  assert.ok(![...records.values()].some(value => value.includes(credentials.password)));
});

test("hosted legacy sessions migrate and cannot return after concurrent stale state writes", async () => {
  const { request, records, store } = hostedFixture();
  const created = await request("/api/register", credentials), user = (await created.json()).user;
  const token = randomBytes(32).toString("base64url"), cookie = `orbit_session=${token}`;
  const state = JSON.parse(records.get("state"));
  state.sessions = { [token]: user.id };
  await store.setJSON("state", state);
  await store.set(`auth/sessions/${token}`, user.id);
  assert.equal((await (await request("/api/me", null, cookie)).json()).user.id, user.id);
  assert.ok(JSON.parse(records.get(`auth/sessions/${token}`)).expiresAt > Date.now());
  assert.equal((await request("/api/logout", {}, cookie)).status, 200);
  await store.setJSON("state", state); // Another request saved its pre-logout snapshot.
  assert.equal((await (await request("/api/me", null, cookie)).json()).user, null);
  // An older in-flight legacy migration must not undo the separate revocation.
  await store.setJSON(`auth/sessions/${token}`, { userId: user.id, expiresAt: Date.now() + 10000 });
  assert.equal((await (await request("/api/me", null, cookie)).json()).user, null);
  const expired = randomBytes(32).toString("base64url");
  await store.setJSON(`auth/sessions/${expired}`, { userId: user.id, expiresAt: Date.now() - 1 });
  assert.equal((await (await request("/api/me", null, `orbit_session=${expired}`)).json()).user, null);
});

test("guest private servers survive bootstrap and remain inaccessible to other guests", async () => {
  const { request } = hostedFixture();
  const created = await request("/api/servers", { name: "Private test server", guestId: credentials.guestId });
  assert.equal(created.status, 201);
  const server = (await created.json()).server, channel = server.channels[0].id;
  const own = await request(`/api/bootstrap?channel=${channel}&guestId=${credentials.guestId}`);
  assert.equal(own.status, 200);
  assert.equal((await own.json()).servers[0].id, server.id);
  assert.equal((await request(`/api/messages?channel=${channel}&guestId=other-guest`)).status, 403);
  assert.equal((await request(`/api/messages?channel=${channel}&guestId=${credentials.guestId}`)).status, 200);
});

test("local sessions survive a server restart and stay revoked after a second restart", async () => {
  const work = path.resolve(repo, "..", "auth-test-work");
  await mkdir(work, { recursive: true });
  const dataDir = await mkdtemp(path.join(work, "session-"));
  const listener = createServer(); listener.listen(0, "127.0.0.1"); await once(listener, "listening");
  const port = listener.address().port; await new Promise(resolve => listener.close(resolve));
  let child;
  const start = async () => {
    child = spawn(process.execPath, ["server.js"], { cwd: repo, env: { ...process.env, PORT: String(port), ORBIT_DATA_DIR: dataDir }, stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
    await Promise.race([once(child.stdout, "data"), once(child, "exit").then(([code]) => { throw new Error(`Server exited ${code}`); })]);
  };
  const stop = async () => { const exited = once(child, "exit"); child.kill(); await exited; child = null; };
  const request = (url, body, cookie = "") => fetch(`http://127.0.0.1:${port}${url}`, { method: body ? "POST" : "GET", headers: { "Content-Type": "application/json", cookie }, ...(body ? { body: JSON.stringify(body) } : {}) });
  try {
    await start();
    for (const data of [null, [], 'text', 42, true]) {
      const response = await fetch(`http://127.0.0.1:${port}/api/register`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(data) });
      assert.equal(response.status, 400);
      assert.match((await response.json()).error, /JSON object/);
    }
    const created = await request("/api/register", credentials);
    assert.equal(created.status, 201);
    const cookie = cookieOf(created), user = (await created.json()).user;
    assert.equal((await request("/api/login", { ...credentials, password: "wrong-password" })).status, 401);
    await stop(); await start();
    assert.equal((await (await request("/api/me", null, cookie)).json()).user.id, user.id);
    const persisted = await readFile(path.join(dataDir, "orbit.json"), "utf8");
    assert.ok(!persisted.includes(credentials.password));
    assert.ok(!persisted.includes(cookie.split("=")[1]));
    assert.equal((await request("/api/logout", {}, cookie)).status, 200);
    assert.equal((await (await request("/api/me", null, cookie)).json()).user, null);
    await stop(); await start();
    assert.equal((await (await request("/api/me", null, cookie)).json()).user, null);
    assert.equal((await request("/api/profile", { name: "Unauthorized", emoji: "✦" }, cookie)).status, 401);
  } finally {
    if (child) await stop();
    assert.ok(dataDir.startsWith(`${work}${path.sep}`));
    await rm(dataDir, { recursive: true, force: true });
  }
});

test("local replies retain context after restart and broadcast only server-built previews", async () => {
  const work = path.resolve(repo, "..", "auth-test-work");
  await mkdir(work, { recursive: true });
  const dataDir = await mkdtemp(path.join(work, "replies-"));
  const listener = createServer(); listener.listen(0, "127.0.0.1"); await once(listener, "listening");
  const port = listener.address().port; await new Promise(resolve => listener.close(resolve));
  let child, streamController;
  const start = async () => {
    child = spawn(process.execPath, ["server.js"], { cwd: repo, env: { ...process.env, PORT: String(port), ORBIT_DATA_DIR: dataDir }, stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
    await Promise.race([once(child.stdout, "data"), once(child, "exit").then(([code]) => { throw new Error(`Server exited ${code}`); })]);
  };
  const stop = async () => { const exited = once(child, "exit"); child.kill(); await exited; child = null; };
  const request = (url, body) => fetch(`http://127.0.0.1:${port}${url}`, { method: body ? "POST" : "GET", headers: { "Content-Type": "application/json" }, ...(body ? { body: JSON.stringify(body) } : {}) });
  try {
    await start();
    const { guestId, original, reply, expected, privateChannel } = await checkReplyContract(request);
    streamController = new AbortController();
    const stream = await fetch(`http://127.0.0.1:${port}/api/events?guestId=${guestId}&peerId=reply-stream-test`, { signal: streamController.signal });
    assert.equal(stream.status, 200);
    const reader = stream.body.getReader(), decoder = new TextDecoder();
    const streamedReplyResponse = await request("/api/messages", { guestId, channel: "global", text: "A live reply", replyTo: original.id });
    assert.equal(streamedReplyResponse.status, 201);
    const streamedReply = (await streamedReplyResponse.json()).message;
    const timeout = setTimeout(() => streamController.abort(), 5000);
    try {
      let buffer = "", received;
      while (!received) {
        const { done, value } = await reader.read();
        assert.ok(!done, "the live stream must include the new reply");
        buffer += decoder.decode(value, { stream: true });
        let boundary;
        while ((boundary = buffer.indexOf("\n\n")) >= 0) {
          const event = buffer.slice(0, boundary); buffer = buffer.slice(boundary + 2);
          const json = event.split("\n").find(line => line.startsWith("data: "))?.slice(6);
          if (json) { const data = JSON.parse(json); if (data.message?.id === streamedReply.id) received = data; }
        }
      }
      assert.equal(received.type, "message");
      assert.equal(received.channel, "global");
      assert.deepEqual(received.message.replyTo, expected);
    } finally { clearTimeout(timeout); streamController.abort(); await reader.cancel().catch(() => {}); }
    await stop(); await start();
    const history = await (await request(`/api/messages?channel=global&guestId=${guestId}`)).json();
    assert.deepEqual(history.messages.find(message => message.id === reply.id).replyTo, expected);
    assert.equal((await request(`/api/messages?channel=${privateChannel}&guestId=reply-outsider`)).status, 403);
    const persisted = JSON.parse(await readFile(path.join(dataDir, "orbit.json"), "utf8"));
    assert.deepEqual(persisted.messages.global.find(message => message.id === streamedReply.id).replyTo, expected);
  } finally {
    streamController?.abort();
    if (child) await stop();
    assert.ok(dataDir.startsWith(`${work}${path.sep}`));
    await rm(dataDir, { recursive: true, force: true });
  }
});

test("local cleanup protects shared content and persists deletion independently of old state", async () => {
  const work = path.resolve(repo, "..", "auth-test-work"); await mkdir(work, { recursive: true });
  const dataDir = await mkdtemp(path.join(work, "cleanup-"));
  const listener = createServer(); listener.listen(0, "127.0.0.1"); await once(listener, "listening");
  const port = listener.address().port; await new Promise(resolve => listener.close(resolve));
  let child;
  const start = async () => {
    child = spawn(process.execPath, ["server.js"], { cwd: repo, env: { ...process.env, PORT: String(port), ORBIT_DATA_DIR: dataDir }, stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
    await Promise.race([once(child.stdout, "data"), once(child, "exit").then(([code]) => { throw new Error(`Server exited ${code}`); })]);
  };
  const stop = async () => { const exited = once(child, "exit"); child.kill(); await exited; child = null; };
  const request = (url, body, cookie = "") => fetch(`http://127.0.0.1:${port}${url}`, { method: body ? "POST" : "GET", headers: { "Content-Type": "application/json", cookie }, ...(body ? { body: JSON.stringify(body) } : {}) });
  try {
    await start();
    const { owner: protectedOwner } = await checkCleanupRejections(request);
    const legacy = (await (await request("/api/parties", { name: "Local legacy" }, protectedOwner.cookie)).json()).room;
    const foreign = (await (await request("/api/parties", { name: "Local foreign content" }, protectedOwner.cookie)).json()).room;
    await stop();
    const seeded = JSON.parse(await readFile(path.join(dataDir, "orbit.json"), "utf8"));
    delete seeded.parties.find(party => party.id === legacy.id).ownerId;
    seeded.messages[foreign.id] = [{ id: "foreign", userId: "another-user", text: "Never delete another person's text" }];
    await writeFile(path.join(dataDir, "orbit.json"), JSON.stringify(seeded)); await start();
    assert.equal((await request("/api/parties/delete", { id: legacy.id, confirmName: legacy.name }, protectedOwner.cookie)).status, 409);
    assert.equal((await request("/api/parties/delete", { id: foreign.id, confirmName: foreign.name }, protectedOwner.cookie)).status, 409);

    const owner = await registerCleanupAccount(request, "complete-local");
    const secondSession = cookieOf(await request("/api/login", owner.data));
    const { room } = await (await request("/api/parties", { name: "My local cleanup party" }, owner.cookie)).json();
    assert.equal((await request("/api/messages", { channel: room.id, text: "My own local text" }, owner.cookie)).status, 201);
    const staleState = await readFile(path.join(dataDir, "orbit.json"), "utf8");
    assert.equal((await request("/api/parties/delete", { id: room.id, confirmName: room.name }, owner.cookie)).status, 200);
    assert.equal((await request(`/api/messages?channel=${room.id}`, null, owner.cookie)).status, 403);
    const removed = await request("/api/account/delete", { password: owner.data.password, confirmation: "DELETE" }, owner.cookie);
    assert.equal(removed.status, 200); assert.match(removed.headers.get("set-cookie"), /Max-Age=0/);
    await stop(); await writeFile(path.join(dataDir, "orbit.json"), staleState); await start();
    for (const cookie of [owner.cookie, secondSession]) assert.equal((await (await request("/api/me", null, cookie)).json()).user, null);
    assert.equal((await request("/api/login", owner.data)).status, 401);
    assert.equal((await request(`/api/messages?channel=${room.id}`, null, owner.cookie)).status, 403);
    const otherMessages = (await (await request(`/api/messages?channel=${foreign.id}`, null, protectedOwner.cookie)).json()).messages;
    assert.equal(otherMessages[0].text, "Never delete another person's text");
    const replacementData = { ...owner.data, password: "new-local-isolated-password" };
    const replacement = await request("/api/register", replacementData);
    assert.equal(replacement.status, 201);
    assert.notEqual((await replacement.json()).user.id, owner.user.id);
    assert.equal((await request("/api/login", owner.data)).status, 401);
    assert.equal((await request("/api/login", replacementData)).status, 200);
    const health = await (await request("/api/health")).json();
    assert.equal(health.release, "turbochat-21"); assert.equal(health.features.safeSelfCleanup, true);
    assert.equal((await (await request("/api/bootstrap")).json()).features.safeSelfCleanup, true);
  } finally {
    if (child) await stop();
    assert.ok(dataDir.startsWith(`${work}${path.sep}`)); await rm(dataDir, { recursive: true, force: true });
  }
});
