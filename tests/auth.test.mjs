import test from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
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
  const handler = createApiHandler(() => store);
  const request = (url, body, cookie = "") => handler(new Request(`https://orbit.test${url}`, { method: body ? "POST" : "GET", headers: { "Content-Type": "application/json", cookie }, ...(body ? { body: JSON.stringify(body) } : {}) }));
  return { records, reads, store, request, handler };
}

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
