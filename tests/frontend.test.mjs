import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import vm from "node:vm";

const source = await readFile(new URL("../app.js", import.meta.url), "utf8");
const entry = "bind(); renderMessages(); restoreDraft(); updateIdentity(); start();";
assert.ok(source.includes(entry), "The test harness must replace only the application startup.");
// Expose functions in the test-only copy; production does not export internals.
const testSource = source.replace(entry, "globalThis.app = { state, drafts, saveDraft, restoreDraft, selectChannel, pollUpdates, sendMessage, receiveLiveEvent, typingPeers, bind };");

function deferred() {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

function fixture({ storage = new Map(), request = () => undefined } = {}) {
  const elements = new Map(), requests = [], timers = new Map(), listeners = new Map();
  let timerId = 0;
  const element = selector => {
    if (!elements.has(selector)) {
      const classes = new Set();
      elements.set(selector, {
        value: "", textContent: "", innerHTML: "", style: {}, dataset: {},
        scrollTop: 0, scrollHeight: 180, clientHeight: 120, disabled: false,
        classList: {
          add: name => classes.add(name), remove: name => classes.delete(name),
          contains: name => classes.has(name),
          toggle(name, enabled) { if (enabled ?? !classes.has(name)) classes.add(name); else classes.delete(name); }
        },
        setAttribute() {}, addEventListener() {}, focus() {},
        scrollTo({ top }) { this.scrollTop = top; },
        dispatchEvent(event) { this[`on${event.type}`]?.({ ...event, currentTarget: this }); }
      });
    }
    return elements.get(selector);
  };
  const context = vm.createContext({
    location: { hostname: "orbit.test", protocol: "https:", port: "", origin: "https://orbit.test", pathname: "/", search: "" },
    localStorage: { getItem: key => storage.get(key) ?? null, setItem: (key, value) => storage.set(key, value) },
    crypto: { randomUUID }, URL, URLSearchParams, console, Event,
    document: {
      querySelector: selector => selector === ".modal" ? null : element(selector),
      querySelectorAll: () => [],
      addEventListener: (type, listener) => listeners.set(type, listener)
    },
    window: { addEventListener() {} }, navigator: {},
    setTimeout: callback => { timers.set(++timerId, callback); return timerId; },
    clearTimeout: id => timers.delete(id), setInterval: () => ++timerId, clearInterval() {},
    requestAnimationFrame: callback => callback(),
    fetch: async (url, options = {}) => {
      const parsed = new URL(url, "https://orbit.test");
      const record = { url: parsed, method: options.method || "GET", body: options.body ? JSON.parse(options.body) : null };
      requests.push(record);
      const custom = await request(record);
      const data = custom ?? (parsed.pathname === "/api/messages" ? { messages: [] } : { events: [], members: [], nextSeq: 0 });
      return { ok: true, status: 200, json: async () => data };
    }
  });
  vm.runInContext(testSource, context, { filename: "app.js" });
  return { app: context.app, element, requests, timers, storage };
}

test("a delayed room poll cannot put the previous room's messages in the newly selected room", async () => {
  const response = deferred(), started = deferred();
  const { app } = fixture({ request(record) {
    if (record.url.pathname === "/api/messages" && record.url.searchParams.get("channel") === "global") {
      started.resolve(); return response.promise;
    }
  } });
  const poll = app.pollUpdates();
  await started.promise;
  await app.selectChannel("music");
  response.resolve({ messages: [{ id: "world-only", text: "World history", createdAt: "2026-10-27T12:00:00Z" }] });
  await poll;
  assert.equal(app.state.active, "music");
  assert.equal(app.state.messages.global[0].id, "world-only");
  assert.equal(app.state.messages.music.length, 0);
});

test("room drafts survive switching rooms and reloading the application", async () => {
  const { app, element, storage } = fixture();
  element("#messageInput").value = "A world draft";
  app.saveDraft();
  await app.selectChannel("music");
  assert.equal(element("#messageInput").value, "");
  element("#messageInput").value = "A music draft";
  app.saveDraft();
  await app.selectChannel("global");
  assert.equal(element("#messageInput").value, "A world draft");
  const reload = fixture({ storage });
  reload.app.restoreDraft();
  assert.equal(reload.app.state.active, "global");
  assert.equal(reload.element("#messageInput").value, "A world draft");
  await reload.app.selectChannel("music");
  assert.equal(reload.element("#messageInput").value, "A music draft");
});

test("a failed send preserves newer text and keeps the unsent message available to retry", async () => {
  const response = deferred();
  const { app, element } = fixture({ request: record => record.method === "POST" && record.url.pathname === "/api/messages" ? response.promise : undefined });
  app.state.connected = true;
  element("#messageInput").value = "First message";
  app.saveDraft();
  const sending = app.sendMessage(element("#messageInput").value);
  element("#messageInput").value = "Newer draft";
  app.saveDraft();
  response.reject(new Error("Network unavailable"));
  await sending;
  assert.equal(element("#messageInput").value, "Newer draft");
  assert.equal(app.drafts.global, "Newer draft");
  assert.equal(app.state.messages.global[0].text, "First message");
  assert.equal(app.state.messages.global[0].failed, true);
  assert.equal(app.state.messages.global[0].pending, false);
  assert.match(element("#messages").innerHTML, /Try again/);
});

test("a failed send in the previous room cannot replace the active room's draft", async () => {
  const response = deferred();
  const { app, element } = fixture({ request: record => record.method === "POST" && record.url.pathname === "/api/messages" ? response.promise : undefined });
  app.state.connected = true;
  element("#messageInput").value = "Unsent World message";
  const sending = app.sendMessage(element("#messageInput").value);
  await app.selectChannel("music");
  element("#messageInput").value = "Keep this music draft";
  app.saveDraft();
  response.reject(new Error("Network unavailable"));
  await sending;
  assert.equal(app.state.active, "music");
  assert.equal(element("#messageInput").value, "Keep this music draft");
  assert.equal(app.drafts.music, "Keep this music draft");
  assert.equal(app.state.messages.music.length, 0);
  assert.equal(app.state.messages.global[0].failed, true);
});

test("typing-stop clears both the peer and its visible typing indicator", () => {
  const { app, element, timers } = fixture();
  app.receiveLiveEvent({ type: "typing", id: "other-guest", name: "Someone", channel: "global" });
  assert.match(element("#typingIndicator").textContent, /Someone is typing/);
  assert.equal(timers.size, 1);
  app.receiveLiveEvent({ type: "typing-stop", id: "other-guest", channel: "global" });
  assert.equal(element("#typingIndicator").textContent, "");
  assert.equal(app.typingPeers.size, 0);
  assert.equal(timers.size, 0);
});

test("Enter during IME composition does not send or suppress text confirmation", () => {
  const { app, element, requests } = fixture();
  app.bind(); app.state.connected = true;
  const input = element("#messageInput"); input.value = "入力中";
  let prevented = 0;
  for (const composition of [{ isComposing: true, keyCode: 13 }, { isComposing: false, keyCode: 229 }]) {
    input.onkeydown({ key: "Enter", shiftKey: false, currentTarget: input, preventDefault: () => prevented++, ...composition });
  }
  assert.equal(prevented, 0);
  assert.equal(input.value, "入力中");
  assert.equal(requests.length, 0);
  assert.equal(app.state.messages.global, undefined);
});
