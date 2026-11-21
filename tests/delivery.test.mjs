import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { createServer } from "node:net";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createApiHandler } from "../netlify/functions/api.mjs";

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const cookieOf = response => response.headers.get("set-cookie")?.split(";")[0] || "";
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };

function hostedFixture() {
  const records = new Map(), reads = [];
  const store = {
    async get(key, options = {}) { reads.push(key); const value = records.get(key); return value === undefined ? null : options.type === "json" ? JSON.parse(value) : value; },
    async set(key, value) { records.set(key, value); },
    async setJSON(key, value) { records.set(key, JSON.stringify(value)); },
    async delete(key) { records.delete(key); },
    async list({ prefix }) { return { blobs: [...records.keys()].filter(key => key.startsWith(prefix)).map(key => ({ key })) }; }
  };
  const handler = createApiHandler(() => store);
  const requestFor = handler => (url, body, cookie = "") => handler(new Request(`https://isolated.test${url}`, { method: body ? "POST" : "GET", headers: { "Content-Type": "application/json", cookie }, ...(body ? { body: JSON.stringify(body) } : {}) }));
  return { records, reads, store, handler, requestFor, request: requestFor(handler) };
}

async function checkDeliveryContract(request) {
  const guest = { guestId: "delivery-owner", guestName: "Delivery owner" };
  const body = { ...guest, channel: "global", text: "One intended delivery", clientMessageId: "stable-delivery-id" };
  const bootstrap = await (await request("/api/bootstrap?channel=global&guestId=delivery-owner")).json();
  assert.equal(bootstrap.features.messageDeliveryIds, true);
  const first = await request("/api/messages", body); assert.equal(first.status, 201);
  const message = (await first.json()).message;
  assert.equal(message.clientMessageId, body.clientMessageId);
  // The first HTTP response may have been lost; repeated attempts retain identity.
  const replays = await Promise.all(Array.from({ length: 4 }, () => request("/api/messages", body)));
  for (const response of replays) {
    assert.equal(response.status, 200);
    const replay = await response.json(); assert.equal(replay.message.id, message.id); assert.equal(replay.replayed, true);
  }
  assert.equal((await request("/api/reactions", { guestId: guest.guestId, channel: "global", messageId: message.id, emoji: "💙" })).status, 200);
  const afterReaction = (await (await request("/api/messages", body)).json()).message;
  assert.equal(afterReaction.reactions["💙"].length, 1, "Replay must not replace saved reactions with the original delivery snapshot");
  assert.equal((await request("/api/messages", { ...body, text: "Changed text with the same ID" })).status, 409);
  assert.equal((await request("/api/messages", { ...body, replyTo: "different-reply-target" })).status, 409);
  const concurrent = await Promise.all(["First payload", "Different payload"].map(text => request("/api/messages", { ...body, text, clientMessageId: "concurrent-conflict" })));
  assert.deepEqual(concurrent.map(response => response.status).sort(), [201, 409]);
  const winner = (await concurrent.find(response => response.status === 201).json()).message;

  const anotherAuthor = await (await request("/api/messages", { ...body, guestId: "another-delivery-owner" })).json();
  const anotherRoom = await (await request("/api/messages", { ...body, channel: "music" })).json();
  assert.notEqual(anotherAuthor.message.id, message.id); assert.notEqual(anotherRoom.message.id, message.id);
  const replyBody = { ...guest, channel: "global", text: "A retained quote", replyTo: message.id, clientMessageId: "stable-reply-id" };
  const reply = (await (await request("/api/messages", replyBody)).json()).message;
  const replayedReply = await request("/api/messages", replyBody); assert.equal(replayedReply.status, 200);
  assert.deepEqual((await replayedReply.json()).message.replyTo, reply.replyTo);
  assert.equal((await request("/api/messages", { ...replyBody, replyTo: "" })).status, 409);
  for (const clientMessageId of ["", "../bad", [], null, "x".repeat(101)]) assert.equal((await request("/api/messages", { ...body, clientMessageId })).status, 400);
  const legacyBody = { ...guest, channel: "global", text: "Legacy repeat remains intentional" };
  const legacy = await Promise.all([request("/api/messages", legacyBody), request("/api/messages", legacyBody)]);
  const legacyMessages = await Promise.all(legacy.map(response => response.json()));
  assert.notEqual(legacyMessages[0].message.id, legacyMessages[1].message.id);
  assert.equal(legacyMessages[0].message.clientMessageId, undefined);
  const history = (await (await request("/api/messages?channel=global&guestId=delivery-owner")).json()).messages;
  assert.equal(history.filter(item => item.id === message.id).length, 1);
  assert.equal(history.find(item => item.id === message.id).text, body.text);
  assert.equal(history.find(item => item.id === winner.id).text, winner.text, "A conflicting concurrent retry cannot replace the accepted payload");
  const privateRoom = (await (await request("/api/parties", { ...guest, name: "Private deliveries" })).json()).room;
  const privateBody = { ...body, channel: privateRoom.id };
  assert.equal((await request("/api/messages", privateBody)).status, 201);
  assert.equal((await request("/api/messages", { ...privateBody, guestId: "outsider" })).status, 403);
  return { body, message, replyBody, reply };
}

async function checkDeliveryCleanup(request) {
  const account = { name: "Delivery cleanup", email: "delivery-cleanup@example.invalid", password: "isolated-cleanup-password" };
  const created = await request("/api/register", account), cookie = cookieOf(created);
  assert.equal(created.status, 201);
  const { room } = await (await request("/api/parties", { name: "Sole-use delivery cleanup" }, cookie)).json();
  assert.equal((await request("/api/messages", { channel: room.id, text: "A removable sole-use message", clientMessageId: "cleanup-delivery" }, cookie)).status, 201);
  assert.equal((await request("/api/parties/delete", { id: room.id, confirmName: room.name }, cookie)).status, 200);
  assert.equal((await request("/api/messages", { channel: room.id, text: "No replay after deletion", clientMessageId: "cleanup-delivery" }, cookie)).status, 403);
  assert.equal((await request("/api/account/delete", { password: account.password, confirmation: "DELETE" }, cookie)).status, 200, "Delivery companion records must not retain private content or block authorized cleanup");
}

async function checkRejectedSessions(request) {
  const account = name => ({ name, email: `${name.toLowerCase()}@delivery-test.invalid`, password: "isolated-delivery-password", guestId: `${name}-guest` });
  const a = await request("/api/register", account("SenderA")), b = await request("/api/register", account("SenderB"));
  assert.equal(a.status, 201); assert.equal(b.status, 201);
  const cookieA = cookieOf(a), cookieB = cookieOf(b), userB = (await b.json()).user;
  assert.equal((await request("/api/logout", {}, cookieA)).status, 200);
  const body = { channel: "global", text: "Never downgrade this signed-in write", guestId: "SenderA-guest", guestName: "SenderA", clientMessageId: "revoked-delivery" };
  for (const cookie of [cookieA, "orbit_session=invalid", "orbit_session=", "orbit_session=%ZZ"]) {
    const response = await request("/api/messages", body, cookie);
    assert.equal(response.status, 401); assert.match((await response.json()).error, /sign-in has ended/);
    assert.equal(response.headers.get("set-cookie"), null, "An old response must not clear a newer browser session");
  }
  assert.equal((await (await request("/api/me", null, cookieB)).json()).user.id, userB.id);
  const history = (await (await request("/api/messages?channel=global&guestId=SenderA-guest")).json()).messages;
  assert.equal(history.some(item => item.text === body.text), false);
  assert.equal((await request("/api/messages", { ...body, text: "A genuine guest can still send", clientMessageId: "genuine-guest" })).status, 201);
}

test("hosted delivery replay preserves legacy clients, access checks and payload identity", async () => {
  const { request, records, store } = hostedFixture();
  const { body, message, replyBody, reply } = await checkDeliveryContract(request);
  await checkRejectedSessions(request); await checkDeliveryCleanup(request);
  const state = JSON.parse(records.get("state")); state.messages.global = [];
  await store.setJSON("state", state);
  // Simulate a stale shared snapshot and an original that aged out of history.
  for (const [key, value] of records) if (key.startsWith("messages/global/") && JSON.parse(value).id === message.id) records.delete(key);
  const replay = await request("/api/messages", replyBody); assert.equal(replay.status, 200);
  assert.deepEqual((await replay.json()).message, reply);
  // An expired (rather than explicitly revoked) session must also be rejected.
  const expired = "x".repeat(43);
  await store.setJSON(`auth/sessions/${expired}`, { userId: "expired-account", expiresAt: Date.now() - 1 });
  assert.equal((await request("/api/messages", body, `orbit_session=${expired}`)).status, 401);
});

test("overlapping identical deliveries within one hosted instance create one record and one event", async () => {
  const { request, records } = hostedFixture();
  const body = { channel: "global", text: "Concurrent same intent", guestId: "concurrent-guest", clientMessageId: "concurrent-delivery" };
  const responses = await Promise.all(Array.from({ length: 8 }, () => request("/api/messages", body)));
  assert.deepEqual(responses.map(response => response.status).sort(), [200, 200, 200, 200, 200, 200, 200, 201]);
  const messages = await Promise.all(responses.map(response => response.json()));
  assert.equal(new Set(messages.map(item => item.message.id)).size, 1);
  assert.equal([...records.keys()].filter(key => key.startsWith("messages/global/delivery-")).length, 1);
  assert.equal(JSON.parse(records.get("state")).events.filter(event => event.type === "message").length, 1);
});

test("independent hosted instances use the same canonical delivery key without claiming a global creation lock", async () => {
  const { requestFor, store, records } = hostedFixture();
  const barrier = deferred(), originalGet = store.get; let initialReads = 0;
  store.get = async (key, options) => {
    const value = await originalGet(key, options);
    if (key.includes("/delivery-") && value === null) { if (++initialReads === 2) barrier.resolve(); await barrier.promise; }
    return value;
  };
  const first = requestFor(createApiHandler(() => store)), second = requestFor(createApiHandler(() => store));
  const body = { channel: "global", text: "Same intent across instances", guestId: "separate-instance-guest", clientMessageId: "separate-instance-delivery" };
  const responses = await Promise.all([first("/api/messages", body), second("/api/messages", body)]);
  const messages = await Promise.all(responses.map(response => response.json()));
  assert.equal(messages[0].message.id, messages[1].message.id);
  assert.equal([...records.keys()].filter(key => key.startsWith("messages/global/delivery-")).length, 1);
  const history = (await (await first("/api/messages?channel=global&guestId=separate-instance-guest")).json()).messages;
  assert.equal(history.length, 1);
});

test("mixed legacy and stable delivery keys retain bounded history and prune by creation time", async () => {
  const { request, store, records, reads } = hostedFixture();
  await request("/api/bootstrap?channel=global&guestId=retention-guest");
  const seeds = [];
  for (let index = 0; index < 301; index++) {
    const id = index < 201 ? `delivery-${createHash("sha256").update(String(index)).digest("hex")}` : `seed-${index}`;
    const message = { id, text: `Retained ${index}`, createdAt: new Date(Date.UTC(2026, 0, 1, 0, 0, index)).toISOString(), reactions: {} };
    seeds.push(message);
    if (index < 201) await store.setJSON(`messages/global/delivery-${id}`, { ...message, clientMessageId: `seed-client-${index}` });
    await store.setJSON(`messages/global/${message.createdAt.replace(/\D/g, "")}-${id}`, message);
  }
  reads.length = 0;
  const history = (await (await request("/api/messages?channel=global&guestId=retention-guest")).json()).messages;
  assert.equal(history.length, 250); assert.equal(history[0].id, seeds[51].id); assert.equal(history.at(-1).id, seeds[300].id);
  assert.equal(reads.filter(key => /^messages\/global\/\d{17}-/.test(key)).length, 300);
  assert.equal((await request("/api/messages", { channel: "global", text: "Newest", guestId: "retention-guest", clientMessageId: "newest-delivery" })).status, 201);
  assert.equal([...records.keys()].filter(key => /^messages\/global\/\d{17}-/.test(key)).length, 250);
  assert.equal(records.has(`messages/global/delivery-${seeds[0].id}`), false);
  assert.equal(records.has(`messages/global/delivery-${seeds[52].id}`), true);
  const pruned = (await (await request("/api/messages?channel=global&guestId=retention-guest")).json()).messages;
  assert.equal(pruned.length, 250); assert.equal(pruned[0].id, seeds[52].id); assert.equal(pruned.at(-1).text, "Newest");
});

test("equal timestamps have stable order and replay keeps its original history position", async () => {
  const { request, store, records } = hostedFixture();
  await request("/api/bootstrap?channel=global&guestId=equal-guest");
  const body = { channel: "global", text: "Original equal-time delivery", guestId: "equal-guest", clientMessageId: "equal-delivery" };
  const id = `delivery-${createHash("sha256").update(JSON.stringify(["guest-equal-guest", "global", body.clientMessageId])).digest("hex")}`;
  const first = { id, text: body.text, clientMessageId: body.clientMessageId, createdAt: "2026-01-01T00:00:00.000Z", reactions: {}, userId: "", registered: false };
  for (const message of [first, { id: "legacy-z", text: "Same time, another post", createdAt: first.createdAt }, { id: "legacy-a", text: "Same time, earlier ID", createdAt: first.createdAt }]) await store.setJSON(`messages/global/${message.createdAt.replace(/\D/g, "")}-${message.id}`, message);
  await store.setJSON(`messages/global/delivery-${id}`, first);
  const before = (await (await request("/api/messages?channel=global&guestId=equal-guest")).json()).messages;
  const count = records.size, replay = await request("/api/messages", body); assert.equal(replay.status, 200);
  assert.equal((await replay.json()).message.createdAt, first.createdAt); assert.equal(records.size, count);
  const after = (await (await request("/api/messages?channel=global&guestId=equal-guest")).json()).messages;
  assert.deepEqual(after.map(item => item.id), before.map(item => item.id));
  assert.deepEqual(after.map(item => item.id), [...after.map(item => item.id)].sort());
  assert.equal((await request("/api/messages", { ...body, text: "Conflicting replacement" })).status, 409);
  assert.equal(JSON.parse(records.get(`messages/global/delivery-${id}`)).text, body.text);
});

test("a retry repairs history when the first request saved only its delivery record", async () => {
  const { request, store, records } = hostedFixture();
  const originalSet = store.setJSON; let failHistory = true;
  store.setJSON = async (key, value) => {
    if (failHistory && /^messages\/global\/\d{17}-/.test(key)) { failHistory = false; throw new Error("Isolated interrupted history write"); }
    return originalSet(key, value);
  };
  const body = { channel: "global", text: "Recover the partial save", guestId: "partial-guest", clientMessageId: "partial-delivery" };
  const originalError = console.error; console.error = () => {};
  try { assert.equal((await request("/api/messages", body)).status, 500); } finally { console.error = originalError; }
  const canonical = JSON.parse([...records].find(([key]) => key.startsWith("messages/global/delivery-"))[1]);
  const replay = await request("/api/messages", body); assert.equal(replay.status, 200); assert.equal((await replay.json()).message.id, canonical.id);
  const history = (await (await request("/api/messages?channel=global&guestId=partial-guest")).json()).messages;
  assert.equal(history.length, 1); assert.equal(history[0].id, canonical.id);
});

test("missing and pruned event cursors remain sequence-based and replay adds no new event", async () => {
  const { request, store, records } = hostedFixture();
  await request("/api/bootstrap?channel=global&guestId=cursor-guest");
  const state = JSON.parse(records.get("state"));
  const messages = Array.from({ length: 600 }, (_, index) => ({ id: `opaque-${600 - index}`, text: `Earlier ${index}`, createdAt: new Date(Date.UTC(2026, 0, 1, 0, 0, index)).toISOString() }));
  state.messages.global = messages.slice(-250); state.nextEventSeq = 600;
  state.events = messages.map((message, index) => ({ type: "message", channel: "global", message, seq: index + 1 }));
  await store.setJSON("state", state);
  const body = { channel: "global", text: "Newest cursor delivery", guestId: "cursor-guest", clientMessageId: "cursor-delivery" };
  assert.equal((await request("/api/messages", body)).status, 201);
  for (const query of ["", "&after=1"]) {
    const result = await (await request(`/api/updates?guestId=cursor-guest${query}`)).json();
    assert.equal(result.events.length, 500); assert.equal(result.events[0].seq, 102); assert.equal(result.nextSeq, 601);
  }
  assert.equal((await (await request("/api/updates?guestId=cursor-guest&after=600")).json()).events.length, 1);
  assert.equal((await request("/api/messages", body)).status, 200);
  const afterReplay = await (await request("/api/updates?guestId=cursor-guest&after=601")).json();
  assert.equal(afterReplay.events.length, 0); assert.equal(afterReplay.nextSeq, 601);
  const history = (await (await request("/api/messages?channel=global&guestId=cursor-guest")).json()).messages;
  assert.equal(history.length, 250); assert.equal(history.at(-1).text, body.text);
});

test("local deliveries replay after restart and reject revoked-session guest downgrade", async () => {
  const dataDir = await mkdtemp(path.join(tmpdir(), "turbochat-delivery-"));
  const listener = createServer(); listener.listen(0, "127.0.0.1"); await once(listener, "listening");
  const port = listener.address().port; await new Promise(resolve => listener.close(resolve));
  let child;
  const start = async () => {
    child = spawn(process.execPath, ["server.js"], { cwd: repo, env: { ...process.env, PORT: String(port), ORBIT_DATA_DIR: dataDir }, stdio: ["ignore", "pipe", "pipe"] });
    await Promise.race([once(child.stdout, "data"), once(child, "exit").then(([code]) => { throw new Error(`Server exited ${code}`); })]);
  };
  const stop = async () => { const exited = once(child, "exit"); child.kill(); await exited; child = null; };
  const request = (url, body, cookie = "") => fetch(`http://127.0.0.1:${port}${url}`, { method: body ? "POST" : "GET", headers: { "Content-Type": "application/json", cookie }, ...(body ? { body: JSON.stringify(body) } : {}) });
  try {
    await start(); const { body, message } = await checkDeliveryContract(request); await checkRejectedSessions(request); await checkDeliveryCleanup(request);
    await stop(); await start();
    const replay = await request("/api/messages", body); assert.equal(replay.status, 200); assert.equal((await replay.json()).message.id, message.id);
  } finally {
    if (child) await stop();
    assert.ok(dataDir.startsWith(path.join(tmpdir(), "turbochat-delivery-")));
    await rm(dataDir, { recursive: true, force: true });
  }
});
