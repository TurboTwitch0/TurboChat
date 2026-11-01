import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import vm from "node:vm";

const source = await readFile(new URL("../app.js", import.meta.url), "utf8");
const entry = "bind(); renderMessages(); updateIdentity(); start();";
assert.ok(source.includes(entry), "The test harness must replace only the application startup.");
// Expose functions in the test-only copy; production does not export internals.
const testSource = source.replace(entry, "globalThis.app = { state, drafts, canManageParty, partyDeletionModal, accountDeletionModal, profileModal, replyDrafts, startReply, cancelReply, jumpToMessage, renderMessage, chooseDrafts, addMessage, setView, renderRoomList, saveDraft, restoreDraft, selectChannel, pollUpdates, sendMessage, receiveLiveEvent, typingPeers, bind, renderMessages, renderVoice, setConnected, loadChannel, bootstrap, scrollBehavior, renderShowcase, selectShowcase, showcaseKeydown, messageFollow, scrollToLatest, scheduleBottomScroll, handleFeedScroll, pauseMessageFollow, initMessageScrolling, enterMessageRoom, visibleMessages, hideWorldHistory, restoreWorldHistory, api, authModal, refreshIdentity, start, signOut, roomForm };");

// Response metadata is a fixture-only wrapper; application payloads stay unchanged.
const mockHttp = (data, options = {}) => ({ fixtureResponse: { data, status: 200, ...options } });

function deferred() {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

function fixture({ storage = new Map(), request = () => undefined, reducedMotion = false, storageBlocked = false, locationSearch = "", replySupport = true } = {}) {
  const elements = new Map(), requests = [], timers = new Map(), timerDelays = new Map(), intervals = new Map(), listeners = new Map(), historyChanges = [];
  const frames = new Map(), windowListeners = new Map(), fontListeners = new Map(), resizeObservers = [], fontReady = deferred();
  let timerId = 0, frameId = 0;
  const addListener = (collection, type, listener) => {
    if (!collection.has(type)) collection.set(type, []);
    collection.get(type).push(listener);
  };
  const dispatch = (collection, type, event = {}) => {
    for (const listener of collection.get(type) || []) listener({ type, ...event });
  };
  const element = selector => {
    if (!elements.has(selector)) {
      const classes = new Set(), attributes = new Map(), eventListeners = new Map();
      let scrollTop = 0;
      const node = {
        value: "", textContent: "", innerHTML: "", style: {}, dataset: {}, isConnected: true,
        scrollHeight: 180, clientHeight: 120, disabled: false,
        classList: {
          add: name => classes.add(name), remove: name => classes.delete(name),
          contains: name => classes.has(name),
          toggle(name, enabled) { if (enabled ?? !classes.has(name)) classes.add(name); else classes.delete(name); }
        },
        setAttribute: (name, value) => attributes.set(name, value),
        getAttribute: name => attributes.get(name),
        addEventListener: (type, listener) => addListener(eventListeners, type, listener),
        focus() { this.focused = true; },
        replaceChildren() { this.innerHTML = ""; },
        scrollTo(options) { this.scrollTop = options.top; this.lastScroll = options; },
        dispatchEvent(event) {
          const detail = { target: this, ...event, currentTarget: this };
          this[`on${event.type}`]?.(detail);
          dispatch(eventListeners, event.type, detail);
        },
        querySelector: child => element(child.startsWith("#") ? child : `${selector} ${child}`),
        querySelectorAll: () => []
      };
      Object.defineProperty(node, "scrollTop", {
        get: () => Math.min(scrollTop, Math.max(0, node.scrollHeight - node.clientHeight)),
        set: value => { scrollTop = Math.max(0, Math.min(Number(value) || 0, node.scrollHeight - node.clientHeight)); }
      });
      elements.set(selector, node);
    }
    return elements.get(selector);
  };
  const showcaseChoices = Array.from({ length: 5 }, (_, index) => {
    const choice = element(`#showcaseChoices [data-showcase-select="${index}"]`);
    choice.dataset.showcaseSelect = String(index);
    return choice;
  });
  const searchModes = ["rooms", "messages"].map(mode => {
    const tab = element(`[data-search-mode="${mode}"]`); tab.dataset.searchMode = mode; return tab;
  });
  const context = vm.createContext({
    location: { hostname: "orbit.test", protocol: "https:", port: "", origin: "https://orbit.test", pathname: "/", search: locationSearch },
    history: { replaceState: (...args) => historyChanges.push(args) },
    localStorage: { getItem: key => storage.get(key) ?? null, setItem: (key, value) => { if (storageBlocked) throw new Error("Browser storage is unavailable"); storage.set(key, value); } },
    crypto: { randomUUID }, URL, URLSearchParams, console, Event, AbortController, btoa, atob,
    document: {
      querySelector: selector => selector === ".modal" ? null : element(selector),
      querySelectorAll: selector => selector === "#showcaseChoices [data-showcase-select]" ? showcaseChoices : selector === "[data-search-mode]" ? searchModes : [],
      addEventListener: (type, listener) => listeners.set(type, listener),
      fonts: { ready: fontReady.promise, addEventListener: (type, listener) => addListener(fontListeners, type, listener) }
    },
    window: { addEventListener: (type, listener) => addListener(windowListeners, type, listener), matchMedia: () => ({ matches: reducedMotion }) }, navigator: {},
    setTimeout: (callback, delay) => { timers.set(++timerId, callback); timerDelays.set(timerId, delay); return timerId; },
    clearTimeout: id => { timers.delete(id); timerDelays.delete(id); },
    setInterval: callback => { intervals.set(++timerId, callback); return timerId; },
    clearInterval: id => intervals.delete(id),
    requestAnimationFrame: callback => { frames.set(++frameId, callback); return frameId; },
    cancelAnimationFrame: id => frames.delete(id),
    ResizeObserver: class {
      constructor(callback) { this.callback = callback; this.targets = new Set(); resizeObservers.push(this); }
      observe(target) { this.targets.add(target); }
      unobserve(target) { this.targets.delete(target); }
      disconnect() { this.targets.clear(); }
    },
    fetch: async (url, options = {}) => {
      const parsed = new URL(url, "https://orbit.test");
      const record = { url: parsed, method: options.method || "GET", body: options.body ? JSON.parse(options.body) : null, signal: options.signal };
      requests.push(record);
      const abortable = async work => {
        let onAbort;
        try {
          return await Promise.race([Promise.resolve().then(work), new Promise((resolve, reject) => {
            onAbort = () => reject(options.signal.reason);
            if (options.signal?.aborted) onAbort();
            else options.signal?.addEventListener("abort", onAbort, { once: true });
          })]);
        } finally { options.signal?.removeEventListener("abort", onAbort); }
      };
      const custom = await abortable(() => request(record));
      if (custom?.fixtureResponse) {
        const response = custom.fixtureResponse;
        return { ok: response.status >= 200 && response.status < 300, status: response.status, json: () => abortable(() => {
          if (response.jsonError) throw response.jsonError;
          return response.data;
        }) };
      }
      const data = custom ?? (parsed.pathname === "/api/messages" ? { messages: [] } : { events: [], members: [], nextSeq: 0 });
      return { ok: true, status: 200, json: async () => data };
    }
  });
  vm.runInContext(testSource, context, { filename: "app.js" });
  context.app.state.replySupport = replySupport;
  const flushFrames = () => {
    for (let pass = 0; frames.size; pass++) {
      assert.ok(pass < 30, "Bottom-follow work must settle instead of scheduling frames forever.");
      const batch = [...frames.values()]; frames.clear();
      for (const callback of batch) callback(performance.now());
    }
  };
  const resize = target => {
    for (const observer of resizeObservers) {
      const targets = [...observer.targets].filter(node => !target || node === target);
      if (targets.length) observer.callback(targets.map(node => ({ target: node })), observer);
    }
  };
  return { app: context.app, element, requests, timers, timerDelays, intervals, storage, listeners, frames, flushFrames, resize, historyChanges, windowEvent: (type, event) => dispatch(windowListeners, type, event), fontEvent: type => dispatch(fontListeners, type), finishFonts: async () => { fontReady.resolve(); await fontReady.promise; } };
}

test("damaged saved settings open safely and preserve the original before saving a new guest", () => {
  for (const raw of ["null", "[]", "42", '"old settings"', "{unfinished"]) {
    const storage = new Map([["orbit.chat.v3", raw]]);
    const { app, element } = fixture({ storage });
    app.bind(); app.chooseDrafts(null); app.renderMessages();
    assert.equal(typeof app.state.guest.id, "string");
    assert.match(app.state.guest.name, /^Guest /);
    assert.equal(app.state.storageAvailable, true);
    assert.equal([...storage].find(([key]) => key.startsWith("orbit.chat.v3.recovery."))?.[1], raw);
    element("#messageInput").value = "Recovered and ready to chat";
    app.saveDraft();
    assert.equal(JSON.parse(storage.get("orbit.chat.v3")).drafts.global, "Recovered and ready to chat");
  }
});

test("recovery storage failure keeps the damaged original and new drafts usable in memory", () => {
  const storage = new Map([["orbit.chat.v3", "null"]]);
  const { app, element } = fixture({ storage, storageBlocked: true });
  app.chooseDrafts(null);
  element("#messageInput").value = "Keep this draft in the tab"; app.saveDraft();
  assert.equal(storage.get("orbit.chat.v3"), "null");
  assert.equal(app.state.storageAvailable, false);
  app.restoreDraft();
  assert.equal(element("#messageInput").value, "Keep this draft in the tab");
  assert.equal(element("#draftHint").textContent, "Draft kept in this tab");
});

test("invalid saved guest details cannot break identity display or replace valid drafts", () => {
  for (const guest of [42, "old guest", {}, { id: "", name: "" }, { id: "old", name: 17 }]) {
    const storage = new Map([["orbit.chat.v3", JSON.stringify({ guest, drafts: { global: "Still here" } })]]);
    const { app, element } = fixture({ storage });
    app.chooseDrafts(null); app.bind();
    assert.match(app.state.guest.name, /^Guest /);
    assert.equal(element("#messageInput").value, "Still here");
  }
});

test("a stalled poll times out, releases its lock, and reconnects on the next attempt", async () => {
  const started = deferred(), stalled = deferred(); let attempts = 0;
  const testCase = fixture({ request(record) {
    if (record.url.pathname === "/api/updates" && ++attempts === 1) { started.resolve(); return stalled.promise; }
  } });
  const { app, element, requests, timers, timerDelays } = testCase;
  app.state.connected = true;
  const poll = app.pollUpdates(); await started.promise;
  const deadline = [...timerDelays].find(([, delay]) => delay === 15000)?.[0];
  assert.ok(deadline, "A stalled request must have a bounded deadline");
  timers.get(deadline)(); await poll;
  assert.equal(app.state.connected, false);
  assert.match(element("#connectionLabel").textContent, /Reconnecting/);
  assert.equal(requests.find(record => record.url.pathname === "/api/updates").signal.aborted, true);
  assert.equal(timers.size, 0, "Request deadlines are removed after failure");
  await app.pollUpdates();
  assert.equal(requests.filter(record => record.url.pathname === "/api/updates").length, 2);
  assert.equal(app.state.connected, true);
  assert.equal(timers.size, 0, "Successful requests also remove their deadlines");
});

test("unreadable responses fail clearly while a valid server rejection keeps its message and status", async () => {
  const cases = [
    [mockHttp(null, { jsonError: new SyntaxError("Unexpected HTML") }), /unreadable response/],
    [mockHttp([]), /unreadable response/], [mockHttp(null), /unreadable response/],
    [mockHttp("proxy response"), /unreadable response/],
    [mockHttp(null, { status: 502, jsonError: new SyntaxError("Unexpected HTML") }), /unavailable \(502\)/]
  ];
  for (const [response, message] of cases) {
    const { app, timers } = fixture({ request: () => response });
    await assert.rejects(app.api("/api/me"), message);
    assert.equal(timers.size, 0);
  }
  const { app, timers } = fixture({ request: () => mockHttp({ error: "That password was not accepted." }, { status: 401 }) });
  await assert.rejects(app.api("/api/login", { method: "POST", body: "{}" }), error => {
    assert.equal(error.message, "That password was not accepted.");
    assert.equal(error.status, 401); assert.notEqual(error.uncertain, true); return true;
  });
  assert.equal(timers.size, 0);
});

test("an unconfirmed send retains its text, warns about delivery, and never retries automatically", async () => {
  const started = deferred(), stalled = deferred();
  const { app, element, requests, timers, timerDelays } = fixture({ request(record) {
    if (record.url.pathname === "/api/messages" && record.method === "POST") { started.resolve(); return stalled.promise; }
  } });
  app.state.connected = true; app.state.loading = false; app.state.view = "chat";
  element("#messageInput").value = "Keep this unconfirmed message";
  const send = app.sendMessage(element("#messageInput").value); await started.promise;
  element("#messageInput").value = "A newer draft"; app.saveDraft();
  const deadline = [...timerDelays].find(([, delay]) => delay === 15000)?.[0]; assert.ok(deadline);
  timers.get(deadline)(); await send;
  const item = app.state.messages.global[0];
  assert.equal(item.text, "Keep this unconfirmed message"); assert.equal(item.failed, true); assert.equal(item.uncertain, true);
  assert.equal(element("#messageInput").value, "A newer draft");
  assert.match(element("#messageList").innerHTML, /Delivery unconfirmed/);
  assert.match(element("#toast").textContent, /Check the conversation before using Try again/);
  for (const callback of [...timers.values()]) callback();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(requests.filter(record => record.method === "POST" && record.url.pathname === "/api/messages").length, 1);
});

test("creating a room or party opens its chat, leaves the old voice room, and preserves the old draft", async () => {
  for (const isParty of [false, true]) {
    const created = { id: isParty ? "party-created" : "room-created", name: "A new conversation", type: isParty ? "party" : "channel" };
    const { app, element, requests } = fixture({ request: record => record.url.pathname === (isParty ? "/api/parties" : "/api/rooms") ? { room: created, inviteCode: "test-invite" } : undefined });
    app.state.view = "discover"; app.state.voiceRoom = "global";
    element("#messageInput").value = "Keep my World draft";
    app.roomForm(isParty); element("#roomName").value = created.name; element("#roomTopic").value = "A topic";
    const form = element("#roomForm"); await form.onsubmit({ preventDefault() {}, currentTarget: form });
    assert.equal(app.state.active, created.id); assert.equal(app.state.view, "chat");
    assert.equal(app.messageFollow.room, created.id); assert.equal(app.state.voiceRoom, "");
    assert.equal(app.drafts.global, "Keep my World draft"); assert.equal(element("#messageInput").value, "");
    assert.ok(requests.some(record => record.url.pathname === "/api/voice/leave" && record.body.room === "global"));
    assert.ok(requests.some(record => record.url.pathname === "/api/messages" && record.url.searchParams.get("channel") === created.id));
    assert.equal(element("#chatView").classList.contains("hidden"), false);
    if (isParty) assert.match(element("#modalRoot").innerHTML, /Invite someone to A new conversation/);
  }
});

test("a rejected room creation keeps the form values and presents its error beside the form", async () => {
  const { app, element } = fixture({ request: record => record.url.pathname === "/api/rooms" ? mockHttp({ error: "Choose another room name." }, { status: 400 }) : undefined });
  app.roomForm(false); element("#roomName").value = "My room"; element("#roomTopic").value = "Keep this topic";
  const form = element("#roomForm"); await form.onsubmit({ preventDefault() {}, currentTarget: form });
  assert.equal(element("#roomError").textContent, "Choose another room name.");
  assert.equal(form.querySelector("button").disabled, false);
  assert.equal(element("#roomName").value, "My room"); assert.equal(element("#roomTopic").value, "Keep this topic");
  assert.equal(app.state.active, "global"); assert.equal(app.state.rooms.length, 0);
});

test("a confirmed sign-in survives a conversation outage and schedules recovery without claiming sign-in failed", async () => {
  const profile = { id: "verified-test-person", name: "Test person" };
  const { app, element, requests, timerDelays, intervals, storage } = fixture({ request(record) {
    if (["/api/login", "/api/me"].includes(record.url.pathname)) return { user: profile };
    if (record.url.pathname === "/api/bootstrap") return mockHttp({ error: "Conversations are unavailable." }, { status: 503 });
  } });
  app.chooseDrafts(null); element("#messageInput").value = "Keep this guest draft";
  app.authModal(); element("#authEmail").value = "person@example.test"; element("#authPassword").value = "fixture-password";
  const form = element("#authForm"); await form.onsubmit({ preventDefault() {}, currentTarget: form });
  assert.equal(app.state.profile.id, profile.id); assert.equal(app.state.connected, false); assert.equal(app.state.loading, false);
  assert.equal(app.drafts.global, undefined);
  assert.equal(JSON.parse(storage.get("orbit.chat.v3")).draftsByIdentity[`guest-${app.state.guest.id}`].global, "Keep this guest draft");
  assert.match(element("#identityHint").textContent, /Signed in as Test person/);
  assert.equal(element("#modalRoot").innerHTML, ""); assert.equal(element("#authError").textContent, "");
  assert.match(element("#toast").textContent, /Signed in as Test person.*conversations are reconnecting/);
  assert.equal(element("#connectionBanner").classList.contains("hidden"), false);
  assert.ok([...timerDelays.values()].includes(8000)); assert.equal(intervals.size, 0);
  assert.equal(requests.filter(record => record.url.pathname === "/api/login").length, 1);
  element("#messageInput").value = "Keep this account draft"; app.saveDraft();
  await app.signOut();
  assert.equal(app.state.profile, null); assert.equal(app.state.connected, false);
  assert.equal(element("#messageInput").value, "Keep this guest draft");
  assert.equal(JSON.parse(storage.get("orbit.chat.v3")).draftsByIdentity[`user-${profile.id}`].global, "Keep this account draft");
  assert.match(element("#toast").textContent, /Signed out.*conversations are reconnecting/);
});

test("an accepted login without a confirmed session stays a guest and offers a truthful retry", async () => {
  const { app, element, requests } = fixture({ request(record) {
    if (record.url.pathname === "/api/login") return { user: { id: "unconfirmed-person", name: "Test person" } };
    if (record.url.pathname === "/api/me") return { user: null };
  } });
  app.authModal(); const form = element("#authForm");
  await form.onsubmit({ preventDefault() {}, currentTarget: form });
  assert.equal(app.state.profile, null);
  assert.match(element("#authError").textContent, /Sign-in could not be confirmed/);
  assert.equal(form.querySelector(".submit-button").disabled, false);
  assert.equal(requests.some(record => record.url.pathname === "/api/bootstrap"), false);
});

test("stale startup session results and failures cannot overwrite a newer confirmed identity", async () => {
  for (const fails of [false, true]) {
    const session = deferred(), started = deferred(), profile = { id: "new-person", name: "New identity" };
    const { app, element, timerDelays } = fixture({ request(record) {
      if (record.url.pathname === "/api/me") { started.resolve(); return session.promise; }
      if (record.url.pathname === "/api/bootstrap") return mockHttp({ error: "Reconnect later" }, { status: 503 });
    } });
    const startup = app.start(); await started.promise;
    assert.equal(await app.refreshIdentity(profile), false);
    const before = [...timerDelays].filter(([, delay]) => delay === 8000);
    if (fails) session.reject(new Error("Stale connection failure")); else session.resolve({ user: null });
    await startup;
    assert.equal(app.state.profile.id, profile.id); assert.equal(app.state.channelErrors.global, "Reconnect later");
    assert.match(element("#identityHint").textContent, /New identity/);
    assert.deepEqual([...timerDelays].filter(([, delay]) => delay === 8000), before, "The stale startup cannot replace the current recovery timer");
  }
});

test("an invite response from an earlier identity cannot join a room after identity changes", async () => {
  const join = deferred(), started = deferred(), profile = { id: "new-person", name: "New identity" };
  const invite = btoa(JSON.stringify({ kind: "party", id: "old-private-party", inviteCode: "old-code", name: "Old invitation" }));
  const { app, requests, historyChanges } = fixture({ locationSearch: `?invite=${encodeURIComponent(invite)}`, request(record) {
    if (record.url.pathname === "/api/me") return { user: null };
    if (record.url.pathname === "/api/parties/join") { started.resolve(); return join.promise; }
    if (record.url.pathname === "/api/bootstrap") return mockHttp({ error: "Reconnect later" }, { status: 503 });
  } });
  const startup = app.start(); await started.promise;
  await app.refreshIdentity(profile);
  join.resolve({ room: { id: "old-private-party", name: "Old invitation", type: "party" } }); await startup;
  assert.equal(app.state.profile.id, profile.id); assert.equal(app.state.active, "global");
  assert.equal(app.state.parties.length, 0); assert.equal(app.state.view, "discover");
  assert.equal(historyChanges.length, 0);
  assert.equal(requests.filter(record => record.url.pathname === "/api/bootstrap").length, 1);
});

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
  assert.match(element("#messageList").innerHTML, /Try again/);
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
  assert.match(element("#messageList").innerHTML, /Finding your conversations/);
  assert.doesNotMatch(element("#messageList").innerHTML, /A FRESH START|data-compose|Write the first hello/);
  app.state.loading = false;
  app.renderMessages();
  assert.equal(element("#messages").getAttribute("aria-busy"), "false");
  assert.match(element("#messageList").innerHTML, /A FRESH START|data-compose/);
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
  assert.match(element("#messageList").innerHTML, /data-retry-channel/);
  assert.match(element("#messageList").innerHTML, /Network &lt;unavailable&gt;/);
  assert.doesNotMatch(element("#messageList").innerHTML, /data-compose/);
  assert.equal(element("#messageInput").value, "Keep this draft");
  assert.equal(app.drafts.global, "Keep this draft");
  await app.loadChannel("global");
  assert.equal(app.state.channelErrors.global, undefined);
  assert.match(element("#messageList").innerHTML, /data-compose/);
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

test("conversation pinning reaches the exact bottom without animation for either motion preference", () => {
  for (const reducedMotion of [false, true]) {
    const { app, element, flushFrames } = fixture({ reducedMotion });
    app.state.loading = false; app.state.view = "chat";
    app.renderMessages({ scrollToBottom: true });
    flushFrames();
    assert.equal(app.scrollBehavior(), reducedMotion ? "auto" : "smooth");
    assert.equal(element("#messages").lastScroll.behavior, "auto");
    assert.equal(element("#messages").scrollTop, element("#messages").scrollHeight - element("#messages").clientHeight);
  }
});

test("a long conversation follows content, viewport, media, and font layout changes to its actual bottom", async () => {
  const { app, element, flushFrames, resize, windowEvent, fontEvent, finishFonts } = fixture();
  app.bind(); app.state.loading = false; app.state.view = "chat";
  app.state.messages.global = Array.from({ length: 200 }, (_, index) => ({ id: `long-${index}`, text: `Conversation line ${index}`, createdAt: "2026-10-27T12:00:00Z" }));
  const feed = element("#messages"), list = element("#messageList");
  feed.scrollHeight = 24500; feed.clientHeight = 600;
  app.renderMessages();
  feed.scrollHeight = 25240; // Content settles after the first render.
  flushFrames();
  assert.equal(feed.scrollTop, 24640);
  assert.equal(app.messageFollow.pinned, true);
  assert.equal((list.innerHTML.match(/data-message-id=/g) || []).length, 200);
  for (const relayout of [() => resize(list), () => resize(feed), () => windowEvent("resize"), () => feed.dispatchEvent({ type: "load" }), () => fontEvent("loadingdone"), finishFonts]) {
    feed.scrollHeight += 137; feed.clientHeight -= 11;
    await relayout(); flushFrames();
    assert.equal(feed.scrollTop, feed.scrollHeight - feed.clientHeight);
  }
  feed.scrollHeight = 100; feed.clientHeight = 600; resize(list); flushFrames();
  assert.equal(feed.scrollTop, 0);
});

test("entering a room waits for its asynchronous history and ignores a previous room's queued scroll", async () => {
  const response = deferred();
  const { app, element, frames, flushFrames } = fixture({ request(record) {
    if (record.url.pathname === "/api/messages" && record.url.searchParams.get("channel") === "music") return response.promise;
  } });
  app.bind(); app.state.loading = false; app.state.view = "chat";
  const feed = element("#messages"); feed.scrollHeight = 8000; feed.clientHeight = 500;
  app.renderMessages();
  const oldFrame = [...frames.values()][0];
  const opening = app.selectChannel("music");
  assert.equal(feed.getAttribute("aria-busy"), "true");
  feed.scrollHeight = 18600;
  response.resolve({ messages: [{ id: "music-history", text: "Last music message", createdAt: "2026-10-27T12:00:00Z" }] });
  await opening; flushFrames();
  assert.equal(app.messageFollow.room, "music");
  assert.match(element("#messageList").innerHTML, /Last music message/);
  assert.equal(feed.scrollTop, 18100);
  feed.dispatchEvent({ type: "wheel", deltaY: -100 }); feed.scrollTop = 300;
  feed.dispatchEvent({ type: "scroll" });
  oldFrame(); flushFrames();
  assert.equal(feed.scrollTop, 300);
  assert.equal(app.messageFollow.pinned, false);
});

test("manual history reading cancels queued following and stays put until Jump to latest", () => {
  const { app, element, frames, flushFrames, resize, windowEvent } = fixture();
  app.bind(); app.state.loading = false; app.state.view = "chat";
  app.state.messages.global = [{ id: "existing", text: "Existing conversation", createdAt: "2026-10-27T12:00:00Z" }];
  const feed = element("#messages"); feed.scrollHeight = 9000; feed.clientHeight = 600;
  app.renderMessages(); flushFrames();
  app.scheduleBottomScroll();
  const staleFrame = [...frames.values()][0];
  feed.dispatchEvent({ type: "wheel", deltaY: -120 }); feed.scrollTop = 700;
  feed.dispatchEvent({ type: "scroll" });
  app.state.messages.global.push({ id: "incoming", text: "A new incoming message", createdAt: "2026-10-27T12:01:00Z" });
  feed.scrollHeight += 2000; app.renderMessages();
  resize(element("#messageList")); windowEvent("resize"); feed.dispatchEvent({ type: "load" });
  staleFrame(); flushFrames();
  assert.equal(feed.scrollTop, 700);
  assert.equal(app.messageFollow.pinned, false);
  assert.equal(element("#jumpLatest").classList.contains("hidden"), false);
  element("#jumpLatest").onclick(); flushFrames();
  assert.equal(feed.scrollTop, 10400);
  assert.equal(app.messageFollow.pinned, true);
  assert.equal(element("#jumpLatest").classList.contains("hidden"), true);
});

test("late layout growth above a reader preserves the same visible message", () => {
  const { app, element, flushFrames, resize } = fixture();
  app.bind(); app.state.loading = false; app.state.view = "chat";
  const feed = element("#messages"); feed.scrollHeight = 6000; feed.clientHeight = 600;
  app.renderMessages(); flushFrames(); feed.scrollTop = 500;
  let growth = 0;
  const article = { dataset: { messageId: "reading-line" }, getBoundingClientRect: () => ({ top: 120 + growth - (feed.scrollTop - 500), bottom: 200 + growth - (feed.scrollTop - 500) }) };
  feed.getBoundingClientRect = () => ({ top: 100 }); feed.querySelectorAll = () => [article];
  feed.dispatchEvent({ type: "wheel", deltaY: -100 }); feed.dispatchEvent({ type: "scroll" });
  growth = 96; feed.scrollHeight += growth; resize(element("#messageList")); flushFrames();
  assert.equal(feed.scrollTop, 596);
  assert.equal(article.getBoundingClientRect().top, 120);
  assert.equal(app.messageFollow.pinned, false);
});

test("sending while reading history resumes following through optimistic and accepted message layout", async () => {
  const response = deferred();
  const { app, element, flushFrames } = fixture({ request(record) {
    if (record.url.pathname === "/api/messages" && record.method === "POST") return response.promise;
  } });
  app.bind(); app.state.loading = false; app.state.view = "chat"; app.state.connected = true;
  const feed = element("#messages"); feed.scrollHeight = 6000; feed.clientHeight = 600;
  app.renderMessages(); flushFrames();
  feed.dispatchEvent({ type: "wheel", deltaY: -100 }); feed.scrollTop = 500; feed.dispatchEvent({ type: "scroll" });
  feed.scrollHeight = 6200;
  const sending = app.sendMessage("A reply from here"); flushFrames();
  assert.equal(app.messageFollow.pinned, true);
  assert.equal(feed.scrollTop, 5600);
  assert.match(element("#messageList").innerHTML, /Sending…/);
  feed.scrollHeight = 6570;
  response.resolve({ message: { id: "accepted-own-message", text: "A reply from here", createdAt: "2026-10-27T12:01:00Z" } });
  await sending; flushFrames();
  assert.equal(feed.scrollTop, 5970);
  assert.match(element("#messageList").innerHTML, /accepted-own-message/);
  assert.doesNotMatch(element("#messageList").innerHTML, /Sending…/);
});

test("the first successful World history load starts clean once, keeps new arrivals, and remembers Restore across reload", async () => {
  const old = [{ id: "initial-world-history", text: "Earlier shared World text", createdAt: "2026-10-27T12:00:00Z" }];
  const fresh = { id: "after-initial-view", text: "A new arrival after the clean view", createdAt: "2026-10-27T12:00:01Z" };
  for (const method of ["bootstrap", "loadChannel"]) {
    const response = deferred();
    const { app, element, storage, requests } = fixture({ request: record => ["/api/bootstrap", "/api/messages"].includes(record.url.pathname) ? response.promise : undefined });
    app.bind(); app.state.view = "chat"; if (method === "loadChannel") app.state.loading = false;
    const loading = method === "bootstrap" ? app.bootstrap() : app.loadChannel("global");
    assert.notEqual(JSON.parse(storage.get("orbit.chat.v3") || "{}").worldHistoryInitialized, true);
    response.resolve({ messages: old }); await loading;
    assert.equal(app.visibleMessages("global").length, 0);
    assert.equal(app.state.messages.global.length, 1);
    assert.match(element("#messageList").innerHTML, /A fresh view of The World/);
    assert.equal(element("#worldHistoryToggle").textContent, "Restore history");
    assert.equal(JSON.parse(storage.get("orbit.chat.v3")).worldHistoryInitialized, true);
    app.receiveLiveEvent({ type: "message", channel: "global", message: fresh });
    assert.deepEqual([...app.visibleMessages("global")].map(item => item.id), [fresh.id]);
    const refreshed = fixture({ storage, request: record => ["/api/bootstrap", "/api/messages"].includes(record.url.pathname) ? { messages: [...old, fresh] } : undefined });
    refreshed.app.bind(); await refreshed.app.bootstrap();
    assert.deepEqual([...refreshed.app.visibleMessages("global")].map(item => item.id), [fresh.id]);
    refreshed.element("#worldHistoryToggle").onclick();
    assert.equal(refreshed.app.visibleMessages("global").length, 2);
    const restored = JSON.parse(storage.get("orbit.chat.v3"));
    assert.equal(restored.worldHistoryInitialized, true); assert.equal(restored.worldHistoryReset, null);
    const reloaded = fixture({ storage, request: record => ["/api/bootstrap", "/api/messages"].includes(record.url.pathname) ? { messages: [...old, fresh] } : undefined });
    reloaded.app.bind(); await reloaded.app.bootstrap(); await reloaded.app.loadChannel("global");
    assert.equal(reloaded.app.visibleMessages("global").length, 2);
    assert.match(reloaded.element("#messageList").innerHTML, /Earlier shared World text/);
    assert.equal(reloaded.element("#worldHistoryToggle").textContent, "Hide earlier texts");
    assert.ok([...requests, ...refreshed.requests, ...reloaded.requests].every(record => record.method === "GET"));
  }
});

test("World history hiding persists locally through reload and history refresh while preserving new messages and other data", async () => {
  const old = [
    { id: "world-old", user: "Earlier", text: "Old World text", createdAt: "2026-10-26T12:00:00Z" },
    { id: "world-cutoff", user: "Latest earlier", text: "Cutoff World text", createdAt: "2026-10-27T12:00:00Z" }
  ];
  const unsent = [
    { id: "pending-local", text: "Pending local text", pending: true, createdAt: "2026-10-25T12:00:00Z" },
    { id: "failed-local", text: "Failed local text", failed: true, createdAt: "2026-10-25T12:00:00Z" }
  ];
  const fresh = [
    { id: "same-time-new", text: "New message at the same timestamp", createdAt: "2026-10-27T12:00:00Z" },
    { id: "world-new", text: "New World text", createdAt: "2026-10-27T12:00:01Z" },
    { id: "unloaded-earlier", text: "An older backfilled message", createdAt: "2026-10-25T12:00:00Z" }
  ];
  const other = [{ id: "music-old", text: "Keep this music text", createdAt: "2026-10-25T12:00:00Z" }];
  const { app, element, storage, requests } = fixture();
  app.bind(); app.state.loading = false; app.state.view = "chat";
  const profile = { id: "local-profile", name: "Keep profile" }; app.state.profile = profile;
  const history = [...old, ...unsent]; app.state.messages.global = history; app.state.messages.music = other;
  app.state.followingRooms = ["music"]; app.drafts.music = "Keep music draft";
  element("#messageInput").value = "Keep World draft"; app.saveDraft();
  app.renderMessages(); element("#worldHistoryToggle").onclick();
  assert.equal(requests.length, 0);
  assert.equal(app.state.messages.global, history);
  assert.equal(app.state.messages.music, other);
  assert.equal(app.state.profile, profile);
  assert.equal(element("#messageInput").value, "Keep World draft");
  assert.deepEqual([...app.visibleMessages("global")].map(item => item.id), ["pending-local", "failed-local"]);
  assert.deepEqual([...app.visibleMessages("music")].map(item => item.id), ["music-old"]);
  assert.match(element("#worldHistoryStatus").textContent, /hidden in this browser/);
  const saved = JSON.parse(storage.get("orbit.chat.v3"));
  assert.deepEqual(saved.worldHistoryReset.ids, ["world-old", "world-cutoff"]);
  assert.equal(saved.drafts.global, "Keep World draft"); assert.equal(saved.drafts.music, "Keep music draft");
  assert.deepEqual(saved.followingRooms, ["music"]);
  const reload = fixture({ storage, request: record => record.url.pathname === "/api/messages" ? { messages: [...old, ...unsent, ...fresh] } : undefined });
  reload.app.bind(); reload.app.state.loading = false;
  await reload.app.loadChannel("global"); reload.app.restoreDraft();
  assert.deepEqual([...reload.app.visibleMessages("global")].map(item => item.id).sort(), ["failed-local", "pending-local", "same-time-new", "world-new"]);
  assert.doesNotMatch(reload.element("#messageList").innerHTML, /Old World text|Cutoff World text|older backfilled/);
  assert.match(reload.element("#messageList").innerHTML, /New World text/);
  assert.equal(reload.element("#messageInput").value, "Keep World draft");
  const beforeRestore = reload.requests.length;
  reload.element("#worldHistoryToggle").onclick();
  assert.equal(reload.requests.length, beforeRestore);
  assert.equal(JSON.parse(storage.get("orbit.chat.v3")).worldHistoryReset, null);
  assert.equal(reload.app.visibleMessages("global").length, 7);
  assert.match(reload.element("#messageList").innerHTML, /Old World text|Cutoff World text/);
  assert.equal(reload.app.drafts.music, "Keep music draft");
  assert.ok(reload.requests.every(record => record.method === "GET"));
});

test("World history controls are room-scoped and describe tab-only hiding when storage is blocked", async () => {
  const { app, element, storage, requests } = fixture({ storageBlocked: true });
  app.bind(); app.state.loading = false; app.state.view = "chat";
  app.state.messages.global = [{ id: "existing-world", text: "Earlier text", createdAt: "2026-10-27T12:00:00Z" }];
  app.renderMessages(); element("#worldHistoryToggle").onclick();
  assert.equal(app.visibleMessages("global").length, 0); assert.equal(storage.size, 0);
  assert.match(element("#worldHistoryStatus").textContent, /hidden in this tab/);
  assert.match(element("#messageList").innerHTML, /Earlier texts are hidden in this tab/);
  assert.match(element("#toast").textContent, /hidden in this tab/);
  await app.selectChannel("music");
  assert.equal(element("#worldHistoryBar").classList.contains("hidden"), true);
  app.hideWorldHistory(); assert.equal(app.visibleMessages("global").length, 0);
  await app.selectChannel("global");
  assert.equal(element("#worldHistoryBar").classList.contains("hidden"), false);
  element("#worldHistoryToggle").onclick();
  assert.equal(app.visibleMessages("global").length, 1);
  assert.ok(requests.every(record => record.method === "GET"));
});

test("reply actions use visible message identities after earlier World history is hidden", () => {
  const { app, element, listeners, requests } = fixture();
  app.bind(); app.state.loading = false; app.state.view = "chat";
  app.state.messages.global = [{ id: "hidden-reply", user: "Earlier person", text: "Earlier text", createdAt: "2026-10-27T12:00:00Z" }];
  app.hideWorldHistory();
  app.state.messages.global.push({ id: "visible-reply", user: "New person", text: "A new thought", createdAt: "2026-10-27T12:00:01Z" });
  app.renderMessages();
  assert.match(element("#messageList").innerHTML, /data-reply="visible-reply"/);
  assert.doesNotMatch(element("#messageList").innerHTML, /data-reply="hidden-reply"/);
  element("#messageInput").value = "My thought";
  const reply = id => listeners.get("click")({ target: { closest: selector => selector === "[data-reply]" ? { dataset: { reply: id } } : null } });
  reply("visible-reply"); assert.equal(element("#messageInput").value, "My thought");
  assert.equal(app.replyDrafts.global.id, "visible-reply");
  reply("hidden-reply"); assert.equal(element("#messageInput").value, "My thought");
  assert.equal(app.replyDrafts.global.id, "visible-reply");
  assert.equal(requests.length, 0);
});

test("message search respects the local World history cutoff while retaining other rooms' results", async () => {
  const old = { id: "search-hidden", user: "Earlier", text: "Shared search phrase from earlier", createdAt: "2026-10-27T12:00:00Z" };
  const other = { id: "search-music", user: "Music person", text: "Shared search phrase in music", createdAt: "2026-10-26T12:00:00Z" };
  const fresh = { id: "search-visible", user: "New person", text: "Shared search phrase from today", createdAt: "2026-10-27T12:00:01Z" };
  const { app, element, requests } = fixture({ request(record) {
    if (record.url.pathname === "/api/messages") return { messages: record.url.searchParams.get("channel") === "global" ? [old, fresh] : [] };
  } });
  app.bind(); app.state.loading = false; app.state.view = "chat";
  app.state.messages.global = [old]; app.state.messages.music = [other]; app.hideWorldHistory();
  app.state.messages.global.push(fresh);
  element("#searchOpen").onclick();
  const input = element("#searchInput"); input.isConnected = true; input.value = "shared search phrase";
  element('[data-search-mode="messages"]').onclick();
  await new Promise(resolve => setImmediate(resolve));
  const results = element("#searchResults").innerHTML;
  assert.match(results, /data-search-message="search-visible"/);
  assert.match(results, /data-search-message="search-music"/);
  assert.doesNotMatch(results, /data-search-message="search-hidden"|Shared search phrase from earlier/);
  assert.ok(requests.every(record => record.method === "GET"));
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

test("the mobile voice panel opens only on request and closes without leaving voice", () => {
  const { app, element, listeners, requests } = fixture();
  app.bind(); app.state.connected = true; app.state.voiceRoom = "global";
  app.renderVoice();
  const panel = element("#rightPanel"), toggle = element("#mobileVoice");
  assert.equal(panel.classList.contains("mobile-open"), false);
  assert.equal(toggle.getAttribute("aria-expanded"), "false");
  assert.equal(toggle.getAttribute("aria-label"), "Show voice controls");
  toggle.onclick();
  assert.equal(panel.classList.contains("mobile-open"), true);
  assert.equal(toggle.getAttribute("aria-expanded"), "true");
  assert.equal(toggle.getAttribute("aria-label"), "Hide voice controls");
  assert.equal(app.state.voiceRoom, "global");
  toggle.onclick();
  assert.equal(panel.classList.contains("mobile-open"), false);
  assert.equal(toggle.getAttribute("aria-expanded"), "false");
  assert.equal(app.state.voiceRoom, "global");
  toggle.onclick();
  listeners.get("keydown")({ key: "Escape" });
  assert.equal(app.state.voiceMobileOpen, false);
  assert.equal(panel.classList.contains("mobile-open"), false);
  assert.equal(toggle.getAttribute("aria-expanded"), "false");
  assert.equal(app.state.voiceRoom, "global");
  assert.equal(requests.length, 0);
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
  assert.match(element("#messageList").innerHTML, /Keep this tab open to keep your draft/);
  assert.doesNotMatch(element("#messageList").innerHTML, /stays on this device/);
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
    assert.match(markup, /Public room/i);
    assert.match(markup, /aria-label="Selected public room:/);
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

test("changing a public room preview preserves the current room and its multiline draft", async () => {
  const { app, element, requests, storage } = fixture();
  app.bind(); app.state.loading = false;
  element("#messageInput").value = "Keep the World draft"; app.saveDraft();
  await app.selectChannel("music");
  element("#messageInput").value = "A music draft\nwith a second line"; app.saveDraft();
  app.state.view = "discover";
  const requestCount = requests.length;
  app.selectShowcase(2);
  assert.equal(element("#showcaseOpen").dataset.channel, "travel");
  assert.equal(app.state.active, "music");
  assert.equal(element("#messageInput").value, "A music draft\nwith a second line");
  assert.equal(app.drafts.global, "Keep the World draft");
  assert.equal(app.drafts.music, "A music draft\nwith a second line");
  assert.equal(requests.length, requestCount);
  const reload = fixture({ storage }); reload.app.restoreDraft();
  assert.equal(reload.app.state.active, "music");
  assert.equal(reload.element("#messageInput").value, "A music draft\nwith a second line");
});

test("opening a public room and submitting its composer sends there while retaining another room's draft", async () => {
  const { app, element, listeners, requests } = fixture({ request(record) {
    if (record.method === "POST" && record.url.pathname === "/api/messages") return {
      message: { id: "accepted-travel-message", text: record.body.text, user: "Local guest", createdAt: "2026-10-27T12:00:00Z", reactions: {} }
    };
  } });
  app.bind(); app.state.loading = false; app.state.connected = true;
  element("#messageInput").value = "Keep my World draft"; app.saveDraft();
  app.selectShowcase(2);
  listeners.get("click")({ target: { closest: selector => selector === "[data-channel]" ? element("#showcaseOpen") : null } });
  assert.equal(app.state.active, "travel");
  assert.equal(app.state.view, "chat");
  assert.equal(element("#messageInput").value, "");
  element("#messageInput").value = "A new thought\nfor this room"; app.saveDraft();
  let prevented = 0;
  element("#messageForm").onsubmit({ preventDefault: () => prevented++ });
  await new Promise(resolve => setImmediate(resolve));
  const sent = requests.filter(request => request.method === "POST" && request.url.pathname === "/api/messages");
  assert.equal(prevented, 1);
  assert.equal(sent.length, 1);
  assert.equal(sent[0].body.channel, "travel");
  assert.equal(sent[0].body.text, "A new thought\nfor this room");
  assert.ok(app.state.messages.travel.some(message => message.id === "accepted-travel-message"));
  assert.equal(element("#messageInput").value, "");
  assert.equal(element("#sendButton").disabled, true);
  assert.equal(app.drafts.travel, undefined);
  assert.equal(app.drafts.global, "Keep my World draft");
  await app.selectChannel("global");
  assert.equal(element("#messageInput").value, "Keep my World draft");
});

test("guest and account drafts remain private and restore across identity switches and reloads", async () => {
  const { app, element, storage } = fixture();
  const firstAccount = { id: "first-account" }, secondAccount = { id: "second-account" };
  app.chooseDrafts(null);
  element("#messageInput").value = "Guest World draft"; app.saveDraft();

  app.chooseDrafts(firstAccount);
  assert.equal(element("#messageInput").value, "");
  assert.equal(app.drafts.global, undefined);
  element("#messageInput").value = "First account World draft"; app.saveDraft();
  await app.selectChannel("music");
  element("#messageInput").value = "First account music draft"; app.saveDraft();

  app.chooseDrafts(secondAccount);
  assert.equal(element("#messageInput").value, "");
  assert.equal(app.drafts.global, undefined);
  element("#messageInput").value = "Second account music draft"; app.saveDraft();
  app.chooseDrafts(firstAccount);
  assert.equal(element("#messageInput").value, "First account music draft");
  assert.equal(app.drafts.global, "First account World draft");

  app.chooseDrafts(null);
  assert.equal(element("#messageInput").value, "");
  await app.selectChannel("global");
  assert.equal(element("#messageInput").value, "Guest World draft");

  const reload = fixture({ storage });
  reload.app.chooseDrafts(secondAccount);
  assert.equal(reload.element("#messageInput").value, "");
  await reload.app.selectChannel("music");
  assert.equal(reload.element("#messageInput").value, "Second account music draft");
  reload.app.chooseDrafts(firstAccount);
  assert.equal(reload.element("#messageInput").value, "First account music draft");
  await reload.app.selectChannel("global");
  assert.equal(reload.element("#messageInput").value, "First account World draft");
});

test("legacy unowned drafts bind to the resolved account without becoming guest drafts", () => {
  const storage = new Map([["orbit.chat.v3", JSON.stringify({ guest: { id: "legacy-guest", name: "Guest" }, drafts: { global: "Legacy account draft" } })]]);
  const { app, element } = fixture({ storage });
  const account = { id: "legacy-account" };
  app.chooseDrafts(account);
  assert.equal(element("#messageInput").value, "Legacy account draft");
  app.chooseDrafts(null);
  assert.equal(element("#messageInput").value, "");
  assert.equal(app.drafts.global, undefined);
  app.chooseDrafts(account);
  assert.equal(element("#messageInput").value, "Legacy account draft");
  const reload = fixture({ storage });
  reload.app.chooseDrafts(null);
  assert.equal(reload.element("#messageInput").value, "");
  reload.app.chooseDrafts(account);
  assert.equal(reload.element("#messageInput").value, "Legacy account draft");
});

test("unread counts deduplicate live messages and treat only the open chat as read", () => {
  const { app } = fixture();
  app.state.loading = false; app.state.active = "global"; app.state.view = "discover";
  const world = { id: "world-live", text: "A World message", createdAt: "2026-10-27T12:00:00Z" };
  app.addMessage("global", world);
  assert.equal(app.state.unread.global, 1, "the current channel is unread while its chat view is closed");
  app.addMessage("global", world);
  assert.equal(app.state.unread.global, 1, "a repeated live event must not increment unread");
  app.setView("chat");
  assert.equal(app.state.unread.global || 0, 0);
  app.addMessage("global", { ...world, id: "world-visible" });
  assert.equal(app.state.unread.global || 0, 0);

  const music = { id: "music-live", text: "A music message", createdAt: "2026-10-27T12:00:01Z" };
  app.addMessage("music", music);
  app.addMessage("music", { ...music, reactions: { "💜": ["another-member"] } });
  assert.equal(app.state.unread.music, 1, "updates to an existing message are not new unread messages");
  app.setView("voice");
  app.addMessage("global", { ...world, id: "world-while-in-voice" });
  assert.equal(app.state.unread.global, 1);
  app.setView("chat");
  assert.equal(app.state.unread.global || 0, 0);
  assert.equal(app.state.unread.music, 1, "reading World must leave another room's unread count intact");
});

test("opening an unread room clears that room's count while retaining the other rooms' counts", async () => {
  const { app } = fixture();
  app.state.loading = false; app.state.view = "chat";
  app.addMessage("music", { id: "music-unread", text: "Music", createdAt: "2026-10-27T12:00:00Z" });
  app.addMessage("travel", { id: "travel-unread", text: "Travel", createdAt: "2026-10-27T12:00:01Z" });
  assert.equal(app.state.unread.music, 1);
  assert.equal(app.state.unread.travel, 1);
  await app.selectChannel("music");
  assert.equal(app.state.active, "music");
  assert.equal(app.state.view, "chat");
  assert.equal(app.state.unread.music || 0, 0);
  assert.equal(app.state.unread.travel, 1);
});

test("the first polling snapshot restores history without treating old events as new unread messages", () => {
  const { app } = fixture();
  app.state.view = "chat"; app.state.active = "global";
  app.receiveLiveEvent({ type: "message", channel: "music", message: { id: "snapshot-message", text: "Earlier music conversation" } }, false);
  assert.equal(app.state.messages.music[0].id, "snapshot-message");
  assert.equal(app.state.unread.music, undefined);
  app.receiveLiveEvent({ type: "message", channel: "music", message: { id: "new-live-message", text: "A new arrival" } });
  assert.equal(app.state.unread.music, 1);
});

test("a sender's accepted message is not marked unread after switching away", () => {
  const { app } = fixture();
  app.state.view = "chat"; app.state.active = "global"; app.state.profile = { id: "the-sender" };
  app.addMessage("music", { id: "own-accepted", userId: "the-sender", text: "My message" });
  assert.equal(app.state.unread.music, undefined);
  app.state.profile = null;
  app.state.messages.music = [{ id: "pending-local", pending: true, user: "Guest", text: "My guest message" }];
  app.addMessage("music", { id: "guest-accepted", user: "Guest", text: "My guest message" });
  assert.equal(app.state.unread.music, undefined);
});

test("reply context preserves a full draft and follows its room and account through reload", async () => {
  const { app, element, storage } = fixture();
  app.chooseDrafts(null); app.state.loading = false;
  const original = { id: "reply-original", user: "First person", text: "Original conversation" };
  app.state.messages.global = [original];
  element("#messageInput").value = "x".repeat(700); app.saveDraft(); app.startReply(original.id);
  assert.equal(element("#messageInput").value.length, 700);
  assert.equal(app.replyDrafts.global.id, original.id);
  assert.equal(element("#replyUser").textContent, original.user);
  await app.selectChannel("music");
  assert.equal(element("#replyPreview").classList.contains("hidden"), true);
  await app.selectChannel("global");
  assert.equal(element("#replyPreview").classList.contains("hidden"), false);
  const reload = fixture({ storage }); reload.app.chooseDrafts(null);
  assert.equal(reload.app.replyDrafts.global.id, original.id);
  assert.equal(reload.element("#messageInput").value.length, 700);
  reload.app.chooseDrafts({ id: "other-account" });
  assert.equal(reload.app.replyDrafts.global, undefined);
  assert.equal(reload.element("#replyPreview").classList.contains("hidden"), true);
  reload.app.chooseDrafts(null); reload.app.cancelReply();
  assert.equal(reload.app.replyDrafts.global, undefined);
  assert.equal(reload.element("#messageInput").value.length, 700);
});

test("sending a reply keeps optimistic context and sends only the target identifier", async () => {
  const response = deferred();
  const { app, element, requests } = fixture({ request: record => record.method === "POST" && record.url.pathname === "/api/messages" ? response.promise : undefined });
  app.chooseDrafts(null); app.state.connected = true; app.state.loading = false;
  app.state.messages.global = [{ id: "original", user: "Friend", text: "What are you making?" }];
  app.startReply("original"); element("#messageInput").value = "A new project"; app.saveDraft();
  const sending = app.sendMessage(element("#messageInput").value);
  const request = requests.find(record => record.url.pathname === "/api/messages" && record.method === "POST");
  assert.equal(request.body.replyTo, "original");
  assert.equal(app.state.messages.global.find(item => item.pending).replyTo.user, "Friend");
  assert.equal(app.replyDrafts.global, undefined);
  response.resolve({ message: { id: "accepted-reply", user: "Me", text: "A new project", replyTo: { id: "original", user: "Friend", text: "What are you making?" } } });
  await sending;
  assert.equal(app.state.messages.global.find(item => item.id === "accepted-reply").replyTo.id, "original");
  assert.match(element("#messageList").innerHTML, /data-jump-reply="original"/);
});

test("a failed reply retains context and can be retried without it without changing a newer draft", async () => {
  let attempts = 0;
  const { app, element, requests } = fixture({ request(record) {
    if (record.method !== "POST" || record.url.pathname !== "/api/messages") return;
    if (++attempts === 1) throw new Error("Original no longer available");
    return { message: { id: "retry-accepted", user: "Me", text: record.body.text } };
  } });
  app.chooseDrafts(null); app.state.connected = true; app.state.loading = false;
  app.state.messages.global = [{ id: "old-original", user: "Friend", text: "Earlier" }, { id: "new-original", user: "Friend", text: "New topic" }];
  app.startReply("old-original"); element("#messageInput").value = "My reply"; app.saveDraft(); await app.sendMessage("My reply");
  const failed = app.state.messages.global.find(item => item.failed);
  assert.equal(failed.replyTo.id, "old-original");
  assert.match(element("#messageList").innerHTML, /data-retry-plain=/);
  element("#messageInput").value = "A newer draft"; app.saveDraft(); app.startReply("new-original");
  await app.sendMessage(failed.text, failed.id, true);
  const outgoing = requests.filter(record => record.method === "POST" && record.url.pathname === "/api/messages");
  assert.equal(outgoing[1].body.replyTo, undefined);
  assert.equal(element("#messageInput").value, "A newer draft");
  assert.equal(app.replyDrafts.global.id, "new-original");
});

test("reply quotes escape user content and respect intentionally hidden World history", () => {
  const { app, element } = fixture();
  const html = app.renderMessage({ id: "safe-reply", text: "Answer", replyTo: { id: "unsafe-original", user: "<img onerror=bad>", text: "<script>bad()</script>" } });
  assert.match(html, /&lt;script&gt;/); assert.doesNotMatch(html, /<script>/);
  assert.match(html, /data-jump-reply="unsafe-original"/);
  app.state.loading = false; app.state.messages.global = [{ id: "hidden-original", text: "Earlier", createdAt: "2026-10-27T12:00:00Z" }];
  app.hideWorldHistory(); app.jumpToMessage("hidden-original");
  assert.match(element("#toast").textContent, /hidden history/);
  assert.equal(element("#worldHistoryToggle").focused, true);
  assert.equal(app.visibleMessages("global").length, 0);
});

test("an older API keeps regular messaging working and cannot silently drop saved reply context", async () => {
  const { app, element, requests } = fixture({ replySupport: false, request(record) {
    if (record.method === "POST" && record.url.pathname === "/api/messages") return { message: { id: "plain-accepted", text: record.body.text } };
  } });
  app.chooseDrafts(null); app.state.connected = true; app.state.loading = false;
  app.state.messages.global = [{ id: "original", user: "Friend", text: "Earlier topic" }];
  app.startReply("original"); assert.equal(app.replyDrafts.global, undefined);
  assert.doesNotMatch(app.renderMessage(app.state.messages.global[0]), /data-reply=/);
  element("#messageInput").value = "Ordinary message"; await app.sendMessage("Ordinary message");
  assert.equal(requests.filter(item => item.method === "POST" && item.url.pathname === "/api/messages").length, 1);
  app.replyDrafts.global = { id: "original", user: "Friend", text: "Earlier topic" };
  element("#messageInput").value = "Keep this saved reply"; app.saveDraft();
  assert.equal(element("#sendButton").disabled, true);
  assert.match(element("#draftHint").textContent, /Replies are updating/);
  await app.sendMessage(element("#messageInput").value);
  assert.equal(requests.filter(item => item.method === "POST" && item.url.pathname === "/api/messages").length, 1);
  assert.equal(element("#messageInput").value, "Keep this saved reply");
  app.cancelReply(); assert.equal(element("#sendButton").disabled, false);
});

test("reply controls follow the API capability declared by bootstrap", async () => {
  let supported = false;
  const { app } = fixture({ request(record) {
    if (record.url.pathname === "/api/bootstrap") return { messages: [], rooms: [], parties: [], servers: [], features: supported ? { messageReplies: true } : undefined };
  } });
  await app.bootstrap(); assert.equal(app.state.replySupport, false);
  supported = true; await app.bootstrap(); assert.equal(app.state.replySupport, true);
});

test("private-party management is shown only for a signed-in owner on a capable backend", () => {
  const { app, element } = fixture();
  app.state.loading = false; app.state.active = "party-owned";
  app.state.parties = [{ id: "party-owned", type: "party", name: "My private party", ownerId: "owner" }];
  app.state.profile = { id: "owner", name: "Owner" };
  app.renderMessages(); assert.equal(element("#manageParty").classList.contains("hidden"), true);
  app.state.cleanupSupport = true;
  app.renderMessages(); assert.equal(element("#manageParty").classList.contains("hidden"), false);
  app.state.profile = { id: "another-person" }; app.renderMessages(); assert.equal(element("#manageParty").classList.contains("hidden"), true);
  app.state.profile = { id: "owner" }; delete app.state.parties[0].ownerId;
  app.renderMessages(); assert.equal(element("#manageParty").classList.contains("hidden"), true, "legacy display names must not be treated as ownership proof");
});

test("party removal requires exact confirmation and clears only that party's local state", async () => {
  const { app, element, requests } = fixture({ request(record) {
    if (record.url.pathname === "/api/parties/delete") return { ok: true };
  } });
  app.state.profile = { id: "owner" }; app.state.cleanupSupport = true; app.state.loading = false; app.state.active = "party-owned";
  app.state.parties = [{ id: "party-owned", type: "party", name: "My private party", ownerId: "owner" }, { id: "party-retained", type: "party", name: "Keep this party", ownerId: "owner" }];
  app.state.messages = { "party-owned": [{ id: "mine", text: "Mine" }], "party-retained": [{ id: "keep", text: "Keep this history" }] };
  app.chooseDrafts(app.state.profile); app.drafts["party-owned"] = "Private draft"; app.drafts.global = "World draft";
  app.partyDeletionModal(); const form = element("#partyDeleteForm");
  element("#partyDeleteName").value = "Wrong name"; await form.onsubmit({ preventDefault() {}, currentTarget: form });
  assert.match(element("#partyDeleteError").textContent, /exactly/); assert.equal(requests.length, 0);
  element("#partyDeleteName").value = "My private party"; await form.onsubmit({ preventDefault() {}, currentTarget: form });
  assert.equal(requests.find(record => record.url.pathname === "/api/parties/delete").body.confirmName, "My private party");
  assert.equal(app.state.active, "global"); assert.equal(app.drafts["party-owned"], undefined); assert.equal(app.drafts.global, "World draft");
  assert.equal(app.state.messages["party-retained"][0].text, "Keep this history"); assert.equal(app.state.parties.length, 1);
});

test("unused-account removal requires confirmation and retains the account when reauthentication fails", async () => {
  const { app, element, requests } = fixture({ request(record) {
    if (record.url.pathname === "/api/account/delete") return mockHttp({ error: "Current password did not match." }, { status: 401 });
  } });
  app.state.profile = { id: "owner", name: "Owner" }; app.state.cleanupSupport = true; app.chooseDrafts(app.state.profile);
  element("#messageInput").value = "Keep my local draft"; app.saveDraft(); app.accountDeletionModal();
  const form = element("#accountDeleteForm"); element("#accountDeleteConfirm").value = "delete";
  await form.onsubmit({ preventDefault() {}, currentTarget: form }); assert.equal(requests.length, 0);
  element("#accountDeleteConfirm").value = "DELETE"; element("#accountDeletePassword").value = "wrong-test-password";
  await form.onsubmit({ preventDefault() {}, currentTarget: form });
  assert.match(element("#accountDeleteError").textContent, /password did not match/);
  assert.equal(app.state.profile.id, "owner"); assert.equal(app.drafts.global, "Keep my local draft");
});
