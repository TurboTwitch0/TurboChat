import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import vm from "node:vm";

const source = await readFile(new URL("../app.js", import.meta.url), "utf8");
const entry = "bind(); renderMessages(); restoreDraft(); updateIdentity(); start();";
assert.ok(source.includes(entry), "The test harness must replace only the application startup.");
// Expose functions in the test-only copy; production does not export internals.
const testSource = source.replace(entry, "globalThis.app = { state, drafts, saveDraft, restoreDraft, selectChannel, pollUpdates, sendMessage, receiveLiveEvent, typingPeers, bind, renderMessages, renderVoice, setConnected, loadChannel, scrollBehavior, renderShowcase, selectShowcase, showcaseKeydown };");

function deferred() {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

function fixture({ storage = new Map(), request = () => undefined, reducedMotion = false, storageBlocked = false } = {}) {
  const elements = new Map(), requests = [], timers = new Map(), intervals = new Map(), listeners = new Map();
  let timerId = 0;
  const element = selector => {
    if (!elements.has(selector)) {
      const classes = new Set(), attributes = new Map();
      elements.set(selector, {
        value: "", textContent: "", innerHTML: "", style: {}, dataset: {},
        scrollTop: 0, scrollHeight: 180, clientHeight: 120, disabled: false,
        classList: {
          add: name => classes.add(name), remove: name => classes.delete(name),
          contains: name => classes.has(name),
          toggle(name, enabled) { if (enabled ?? !classes.has(name)) classes.add(name); else classes.delete(name); }
        },
        setAttribute: (name, value) => attributes.set(name, value),
        getAttribute: name => attributes.get(name),
        addEventListener() {}, focus() { this.focused = true; },
        scrollTo(options) { this.scrollTop = options.top; this.lastScroll = options; },
        dispatchEvent(event) { this[`on${event.type}`]?.({ ...event, currentTarget: this }); }
      });
    }
    return elements.get(selector);
  };
  const showcaseChoices = Array.from({ length: 5 }, (_, index) => {
    const choice = element(`#showcaseChoices [data-showcase-select="${index}"]`);
    choice.dataset.showcaseSelect = String(index);
    return choice;
  });
  const context = vm.createContext({
    location: { hostname: "orbit.test", protocol: "https:", port: "", origin: "https://orbit.test", pathname: "/", search: "" },
    localStorage: { getItem: key => storage.get(key) ?? null, setItem: (key, value) => { if (storageBlocked) throw new Error("Browser storage is unavailable"); storage.set(key, value); } },
    crypto: { randomUUID }, URL, URLSearchParams, console, Event,
    document: {
      querySelector: selector => selector === ".modal" ? null : element(selector),
      querySelectorAll: selector => selector === "#showcaseChoices [data-showcase-select]" ? showcaseChoices : [],
      addEventListener: (type, listener) => listeners.set(type, listener)
    },
    window: { addEventListener() {}, matchMedia: () => ({ matches: reducedMotion }) }, navigator: {},
    setTimeout: callback => { timers.set(++timerId, callback); return timerId; },
    clearTimeout: id => timers.delete(id),
    setInterval: callback => { intervals.set(++timerId, callback); return timerId; },
    clearInterval: id => intervals.delete(id),
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
  return { app: context.app, element, requests, timers, intervals, storage, listeners };
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

test("initial loading does not claim an empty conversation or offer a premature first message", () => {
  const { app, element } = fixture();
  app.renderMessages();
  assert.equal(element("#messages").getAttribute("aria-busy"), "true");
  assert.match(element("#messages").innerHTML, /Finding your conversations/);
  assert.doesNotMatch(element("#messages").innerHTML, /A FRESH START|data-compose|Write the first hello/);
  app.state.loading = false;
  app.renderMessages();
  assert.equal(element("#messages").getAttribute("aria-busy"), "false");
  assert.match(element("#messages").innerHTML, /A FRESH START|data-compose/);
});

test("the first-hello action focuses the composer without sending a message", () => {
  const { app, element, listeners, requests } = fixture();
  app.bind(); app.state.loading = false;
  const action = { dataset: {} };
  listeners.get("click")({ target: { closest: selector => selector === "[data-compose]" ? action : null } });
  assert.equal(app.state.view, "chat");
  assert.equal(element("#messageInput").focused, true);
  assert.equal(requests.length, 0);
});

test("a failed room load shows a recoverable error and leaves the saved draft intact", async () => {
  const pending = deferred();
  let attempts = 0;
  const { app, element } = fixture({ request(record) {
    if (record.url.pathname === "/api/messages") return ++attempts === 1 ? pending.promise : { messages: [] };
  } });
  app.state.loading = false;
  element("#messageInput").value = "Keep this draft"; app.saveDraft();
  const loading = app.loadChannel("global");
  assert.equal(element("#messages").getAttribute("aria-busy"), "true");
  pending.reject(new Error("Network <unavailable>"));
  await loading;
  assert.equal(element("#messages").getAttribute("aria-busy"), "false");
  assert.match(element("#messages").innerHTML, /data-retry-channel/);
  assert.match(element("#messages").innerHTML, /Network &lt;unavailable&gt;/);
  assert.doesNotMatch(element("#messages").innerHTML, /data-compose/);
  assert.equal(element("#messageInput").value, "Keep this draft");
  assert.equal(app.drafts.global, "Keep this draft");
  await app.loadChannel("global");
  assert.equal(app.state.channelErrors.global, undefined);
  assert.match(element("#messages").innerHTML, /data-compose/);
});

test("connection feedback explains offline sending while keeping composition available", () => {
  const { app, element } = fixture();
  element("#messageInput").value = "Draft during a reconnect";
  app.setConnected(false);
  assert.equal(element("#connectionBanner").classList.contains("hidden"), false);
  assert.match(element("#connectionMessage").textContent, /Finding your conversations/);
  assert.equal(element("#retryConnection").classList.contains("hidden"), true);
  app.state.loading = false; app.setConnected(false);
  assert.match(element("#connectionMessage").textContent, /keep writing/);
  assert.equal(element("#retryConnection").classList.contains("hidden"), false);
  assert.equal(element("#sendButton").disabled, true);
  assert.equal(element("#messageInput").disabled, false);
  app.setConnected(true);
  assert.equal(element("#connectionBanner").classList.contains("hidden"), true);
  assert.equal(element("#sendButton").disabled, false);
});

test("conversation scrolling respects the reduced-motion preference", () => {
  for (const reducedMotion of [false, true]) {
    const { app, element } = fixture({ reducedMotion });
    app.state.loading = false;
    app.renderMessages({ scrollToBottom: true });
    assert.equal(app.scrollBehavior(), reducedMotion ? "auto" : "smooth");
    assert.equal(element("#messages").lastScroll.behavior, reducedMotion ? "auto" : "smooth");
  }
});

test("voice animation represents only a joined, unmuted, healthy voice session", () => {
  const { app, element } = fixture();
  app.state.connected = true;
  app.renderVoice();
  assert.equal(element(".voice-wave").classList.contains("is-active"), false);
  app.state.voiceRoom = "global"; app.renderVoice();
  assert.equal(element(".voice-wave").classList.contains("is-active"), true);
  for (const [key, value] of [["muted", true], ["deafened", true], ["voiceError", "Audio disconnected"]]) {
    app.state[key] = value; app.renderVoice();
    assert.equal(element(".voice-wave").classList.contains("is-active"), false);
    app.state[key] = key === "voiceError" ? "" : false;
  }
});

test("blocked browser storage keeps the draft in memory and never claims it was saved on the device", async () => {
  const { app, element, storage } = fixture({ storageBlocked: true });
  app.state.loading = false;
  element("#messageInput").value = "A draft kept in this tab";
  app.saveDraft();
  assert.equal(app.state.storageAvailable, false);
  assert.equal(app.drafts.global, "A draft kept in this tab");
  assert.equal(storage.size, 0);
  assert.equal(element("#draftHint").textContent, "Draft kept in this tab");
  app.setConnected(false);
  assert.match(element("#connectionMessage").textContent, /stays in this tab/);
  assert.doesNotMatch(element("#connectionMessage").textContent, /on this device/);
  app.state.channelErrors.global = "The room could not load";
  app.renderMessages();
  assert.match(element("#messages").innerHTML, /Keep this tab open to keep your draft/);
  assert.doesNotMatch(element("#messages").innerHTML, /stays on this device/);
  await app.selectChannel("music");
  await app.selectChannel("global");
  assert.equal(element("#messageInput").value, "A draft kept in this tab");
  assert.equal(element("#draftHint").textContent, "Draft kept in this tab");
});

test("public room previews wrap selection and update the open action without navigating or autoplay", () => {
  const { app, element, requests, timers, intervals } = fixture();
  app.bind();
  assert.equal(element("#showcaseOpen").dataset.channel, "global");
  element("#showcasePrevious").onclick();
  assert.equal(element("#showcaseOpen").dataset.channel, "lounge");
  assert.match(element("#showcaseSelection").textContent, /05 \/ 05 — The Slow Lounge/);
  element("#showcaseNext").onclick();
  assert.equal(element("#showcaseOpen").dataset.channel, "global");
  app.selectShowcase(2);
  assert.equal(element("#showcaseOpen").dataset.channel, "travel");
  assert.match(element("#showcaseOpen").textContent, /Open Somewhere New/);
  for (let index = 0; index < 5; index++) {
    assert.equal(element(`#showcaseChoices [data-showcase-select="${index}"]`).getAttribute("aria-pressed"), String(index === 2));
  }
  assert.equal(app.state.active, "global");
  assert.equal(app.state.view, "discover");
  assert.equal(requests.length, 0);
  assert.equal(timers.size, 0);
  assert.equal(intervals.size, 0);
});

test("the room showcase contains public descriptions and never includes private content or identities", () => {
  const { app, element } = fixture();
  app.state.rooms = [{ id: "custom-room", name: "Custom sensitive name" }];
  app.state.parties = [{ id: "private-party", name: "Private party name", type: "party" }];
  app.state.servers = [{ id: "private-server", name: "Private server name", channels: [{ id: "secret-channel", name: "Secret channel name" }] }];
  app.state.messages.global = [{ id: "private-message", user: "Private member name", text: "Private message contents" }];
  app.state.profile = { id: "private-person", name: "Private profile name" };
  for (let index = 0; index < 5; index++) {
    app.selectShowcase(index);
    const markup = element("#showcaseCards").innerHTML;
    assert.match(markup, /PUBLIC ROOM/);
    assert.match(markup, /aria-label="Selected public room:/);
    assert.match(markup, /aria-label="Preview /);
    assert.doesNotMatch(markup, /Custom sensitive|Private party|Private server|Secret channel|Private member|Private message|Private profile/);
  }
});

test("showcase keyboard selection stays inside its controls and respects modifiers and composition", () => {
  const { app, element, requests } = fixture();
  app.bind();
  const handler = element("#roomShowcase").onkeydown;
  let prevented = 0;
  const event = (key, inside = true, extra = {}) => ({
    key, target: { closest: selector => inside && selector === "#showcaseChoices [data-showcase-select]" ? {} : null },
    preventDefault: () => prevented++, ...extra
  });
  handler(event("ArrowRight"));
  assert.equal(element("#showcaseOpen").dataset.channel, "music");
  assert.equal(element('#showcaseChoices [data-showcase-select="1"]').focused, true);
  handler(event("End"));
  assert.equal(element("#showcaseOpen").dataset.channel, "lounge");
  handler(event("Home"));
  assert.equal(element("#showcaseOpen").dataset.channel, "global");
  handler(event("ArrowLeft"));
  assert.equal(element("#showcaseOpen").dataset.channel, "lounge");
  assert.equal(prevented, 4);
  for (const ignored of [event("ArrowRight", false), event("ArrowRight", true, { ctrlKey: true }), event("ArrowRight", true, { metaKey: true }), event("ArrowRight", true, { altKey: true }), event("ArrowRight", true, { isComposing: true }), event("a"), event("Enter")]) handler(ignored);
  assert.equal(prevented, 4);
  assert.equal(element("#showcaseOpen").dataset.channel, "lounge");
  assert.equal(app.state.active, "global");
  assert.equal(requests.length, 0);
});

test("touch or click previews select only, while the explicit open action navigates to that public room", () => {
  const { app, element, listeners, requests } = fixture();
  app.bind();
  const click = listeners.get("click");
  click({ target: { closest: selector => selector === "[data-showcase-select]" ? { dataset: { showcaseSelect: "1" } } : null } });
  assert.equal(element("#showcaseOpen").dataset.channel, "music");
  assert.equal(app.state.active, "global");
  assert.equal(requests.length, 0);
  click({ target: { closest: selector => selector === "[data-channel]" ? element("#showcaseOpen") : null } });
  assert.equal(app.state.active, "music");
  assert.equal(app.state.view, "chat");
  assert.ok(requests.some(request => request.url.pathname === "/api/messages" && request.url.searchParams.get("channel") === "music"));
});
