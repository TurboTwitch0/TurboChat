import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import vm from "node:vm";

const source = await readFile(new URL("../app.js", import.meta.url), "utf8");
const entry = "bind(); renderMessages(); updateIdentity(); start();";
assert.ok(source.includes(entry), "The test harness must replace only the application startup.");
// Expose functions in the test-only copy; production does not export internals.
const testSource = source.replace(entry, "globalThis.app = { state, drafts, openRoomDirectory, setMemberPanel, formatMessageText, insertComposerEmoji, emojiPicker, toggleReaction, copyMessage, canManageParty, partyDeletionModal, accountDeletionModal, profileModal, replyDrafts, startReply, cancelReply, jumpToMessage, renderMessage, chooseDrafts, addMessage, setView, renderRoomList, saveDraft, restoreDraft, selectChannel, pollUpdates, sendMessage, receiveLiveEvent, typingPeers, bind, renderMessages, renderVoice, setConnected, loadChannel, bootstrap, scrollBehavior, renderShowcase, selectShowcase, showcaseKeydown, messageFollow, scrollToLatest, scheduleBottomScroll, handleFeedScroll, pauseMessageFollow, initMessageScrolling, enterMessageRoom, visibleMessages, hideWorldHistory, restoreWorldHistory, api, authModal, refreshIdentity, start, signOut, roomForm, inviteGeneral, inviteCreated };");

// Response metadata is a fixture-only wrapper; application payloads stay unchanged.
const mockHttp = (data, options = {}) => ({ fixtureResponse: { data, status: 200, ...options } });

function deferred() {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

function fixture({ storage = new Map(), request = () => undefined, reducedMotion = false, storageBlocked = false, locationSearch = "", replySupport = true, navigator = {}, copy = () => false } = {}) {
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
  // Model only the feed's shallow DOM. Browser integration checks native focus;
  // these nodes let the unit suite detect replacement of otherwise unchanged rows.
  const firstElementMarkup = html => {
    const tags = /<\/?([a-z][\w:-]*)\b[^>]*>/gi;
    const voidTags = new Set(["area", "base", "br", "col", "embed", "hr", "img", "input", "link", "meta", "param", "source", "track", "wbr"]);
    let start = -1, depth = 0;
    for (const match of html.matchAll(tags)) {
      if (start < 0) start = match.index;
      if (match[0].startsWith("</")) depth--;
      else if (!voidTags.has(match[1].toLowerCase()) && !match[0].endsWith("/>")) depth++;
      if (depth === 0) return { html: html.slice(start, match.index + match[0].length), end: match.index + match[0].length };
    }
    return null;
  };
  const feedRow = html => {
    let original = html, actions = null, actionStart = 0, actionEnd = 0;
    const node = {
      parentNode: null, dataset: {},
      querySelectorAll: () => [],
      querySelector(selector) {
        if (selector !== ".message-actions" || !/^<article\b/i.test(original)) return null;
        if (!actions) {
          const match = /<div\b[^>]*class="message-actions"[^>]*>/.exec(original);
          if (!match) return null;
          const block = firstElementMarkup(original.slice(match.index));
          actionStart = match.index + match[0].length;
          actionEnd = match.index + block.html.lastIndexOf("</div>");
          let content = original.slice(actionStart, actionEnd);
          actions = { updates: 0, contains: () => false, querySelectorAll: () => [] };
          Object.defineProperty(actions, "innerHTML", { get: () => content, set: value => { content = value; actions.updates++; } });
        }
        return actions;
      },
      remove() {
        if (!this.parentNode) return;
        const siblings = this.parentNode.children, index = siblings.indexOf(this);
        if (index >= 0) siblings.splice(index, 1);
        this.parentNode = null;
      },
      replaceWith(replacement) { const parent = this.parentNode; if (parent) { parent.insertBefore(replacement, this); this.remove(); } }
    };
    for (const [, name, value] of html.slice(0, html.indexOf(">") + 1).matchAll(/data-([\w-]+)="([^"]*)"/g)) node.dataset[name.replace(/-([a-z])/g, (_, letter) => letter.toUpperCase())] = value;
    Object.defineProperties(node, {
      outerHTML: { get: () => actions ? original.slice(0, actionStart) + actions.innerHTML + original.slice(actionEnd) : original },
      innerHTML: {
        get: () => node.outerHTML.slice(node.outerHTML.indexOf(">") + 1, node.outerHTML.lastIndexOf("</")),
        set(value) { original = original.slice(0, original.indexOf(">") + 1) + value + original.slice(original.lastIndexOf("</")); actions = null; }
      },
      nextElementSibling: { get: () => node.parentNode?.children[node.parentNode.children.indexOf(node) + 1] || null },
      isConnected: { get: () => !!node.parentNode?.isConnected }
    });
    return node;
  };
  const feedChildren = node => {
    node.children = [];
    node.insertBefore = (child, next) => {
      if (child === next) return child;
      assert.ok(next === null || node.children.includes(next), "insertBefore requires a current sibling or null");
      child.remove?.();
      const index = next === null ? node.children.length : node.children.indexOf(next);
      node.children.splice(index, 0, child); child.parentNode = node; return child;
    };
    node.replaceChildren = (...children) => {
      for (const child of node.children) child.parentNode = null;
      node.children.length = 0;
      for (const child of children) node.insertBefore(child, null);
    };
    Object.defineProperties(node, {
      firstElementChild: { get: () => node.children[0] || null },
      innerHTML: {
        get: () => node.children.map(child => child.outerHTML).join(""),
        set(html) {
          node.replaceChildren();
          let remaining = String(html);
          for (let parsed; (parsed = firstElementMarkup(remaining)); remaining = remaining.slice(parsed.end)) node.insertBefore(feedRow(parsed.html), null);
        }
      }
    });
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
        setSelectionRange(start, end) { this.selectionStart = start; this.selectionEnd = end; },
        select() { this.selected = true; this.setSelectionRange(0, this.value.length); },
        replaceChildren() { this.innerHTML = ""; },
        scrollTo(options) { this.scrollTop = options.top; this.lastScroll = options; },
        dispatchEvent(event) {
          const detail = { target: this, ...event, currentTarget: this };
          this[`on${event.type}`]?.(detail);
          dispatch(eventListeners, event.type, detail);
        },
        querySelector: child => element(child.startsWith("#") ? child : `${selector} ${child}`),
        querySelectorAll: child => selector === "#roomDirectoryFilters" && child === "[data-directory-filter]" ? directoryFilters : []
      };
      Object.defineProperty(node, "scrollTop", {
        get: () => Math.min(scrollTop, Math.max(0, node.scrollHeight - node.clientHeight)),
        set: value => { scrollTop = Math.max(0, Math.min(Number(value) || 0, node.scrollHeight - node.clientHeight)); }
      });
      if (selector === "#messageList") feedChildren(node);
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
  const directoryFilters = ["all", "unread", "following"].map(filter => {
    const button = element(`#roomDirectoryFilters [data-directory-filter="${filter}"]`); button.dataset.directoryFilter = filter; return button;
  });
  const context = vm.createContext({
    location: { hostname: "orbit.test", protocol: "https:", port: "", origin: "https://orbit.test", pathname: "/", search: locationSearch },
    history: { replaceState: (...args) => historyChanges.push(args) },
    localStorage: { getItem: key => storage.get(key) ?? null, setItem: (key, value) => { if (storageBlocked) throw new Error("Browser storage is unavailable"); storage.set(key, value); } },
    crypto: { randomUUID }, URL, URLSearchParams, console, Event, AbortController, btoa, atob,
    document: {
      execCommand: copy,
      createElement(tag) {
        assert.equal(tag, "template", "the feed fixture supports inert HTML templates only");
        const template = { content: { firstElementChild: null } };
        Object.defineProperty(template, "innerHTML", { set: html => { const parsed = firstElementMarkup(String(html)); template.content.firstElementChild = parsed ? feedRow(parsed.html) : null; } });
        return template;
      },
      querySelector: selector => selector === ".modal" ? null : element(selector),
      querySelectorAll: selector => selector === "#showcaseChoices [data-showcase-select]" ? showcaseChoices : selector === "[data-search-mode]" ? searchModes : selector.includes("[data-directory-filter]") ? directoryFilters : [],
      addEventListener: (type, listener) => listeners.set(type, listener),
      fonts: { ready: fontReady.promise, addEventListener: (type, listener) => addListener(fontListeners, type, listener) }
    },
    window: { addEventListener: (type, listener) => addListener(windowListeners, type, listener), matchMedia: () => ({ matches: reducedMotion }) }, navigator,
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

test("creating a room or party opens its chat while preserving the active call and old draft", async () => {
  for (const isParty of [false, true]) {
    const created = { id: isParty ? "party-created" : "room-created", name: "A new conversation", type: isParty ? "party" : "channel" };
    const { app, element, requests } = fixture({ request: record => record.url.pathname === (isParty ? "/api/parties" : "/api/rooms") ? { room: created, inviteCode: "test-invite" } : undefined });
    app.state.view = "discover"; app.state.voiceRoom = "global";
    element("#messageInput").value = "Keep my World draft";
    app.roomForm(isParty); element("#roomName").value = created.name; element("#roomTopic").value = "A topic";
    const form = element("#roomForm"); await form.onsubmit({ preventDefault() {}, currentTarget: form });
    assert.equal(app.state.active, created.id); assert.equal(app.state.view, "chat");
    assert.equal(app.messageFollow.room, created.id); assert.equal(app.state.voiceRoom, "global");
    assert.equal(app.drafts.global, "Keep my World draft"); assert.equal(element("#messageInput").value, "");
    assert.ok(!requests.some(record => record.url.pathname === "/api/voice/leave"), "opening a text conversation must not hang up an active call");
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

test("switching account modes preserves identity fields without keeping passwords or persisting the draft", () => {
  const { app, element, storage } = fixture();
  app.authModal();
  element("#authEmail").value = "first@example.test"; element("#authPassword").value = "only-in-this-form";
  element("#toLogin").onclick();
  assert.equal(element("#authPassword").value, "only-in-this-form", "Selecting the current mode must leave its form intact");
  element("#toRegister").onclick();
  assert.equal(element("#authEmail").value, "first@example.test"); assert.equal(element("#authPassword").value, "");
  assert.equal(element("#toRegister").getAttribute("aria-pressed"), "true");
  element("#authName").value = "My display name"; element("#authEmail").value = "edited@example.test"; element("#authPassword").value = "new-secret";
  element("#toLogin").onclick();
  assert.equal(element("#authEmail").value, "edited@example.test"); assert.equal(element("#authPassword").value, "");
  assert.equal(element("#toLogin").getAttribute("aria-pressed"), "true");
  element("#toRegister").onclick();
  assert.equal(element("#authName").value, "My display name"); assert.equal(element("#authEmail").value, "edited@example.test");
  app.authModal();
  assert.equal(element("#authEmail").value, "", "A new sign-in visit must not retain the previous dialog draft");
  assert.equal([...storage.values()].some(value => /edited@example|new-secret|My display name/.test(value)), false);
});

test("both invitation flows copy their exact link and announce success only after the clipboard confirms", async () => {
  for (const created of [false, true]) {
    const copied = [], pending = deferred();
    const { app, element } = fixture({ navigator: { clipboard: { writeText: text => { copied.push(text); return pending.promise; } } } });
    if (created) app.inviteCreated({ id: "private-fixture", name: 'My <party> \"name\"', topic: "Music" }, "fixture-code");
    else app.inviteGeneral();
    const button = element("#copyInvite"), status = element("#inviteCopyStatus");
    const first = button.onclick(); await button.onclick();
    assert.equal(copied.length, 1); assert.equal(button.disabled, true); assert.equal(status.textContent, "");
    const link = new URL(copied[0]);
    assert.equal(link.origin, "https://orbit.test");
    if (created) {
      const invite = JSON.parse(atob(link.searchParams.get("invite").replace(/-/g, "+").replace(/_/g, "/")));
      assert.equal(invite.id, "private-fixture"); assert.equal(invite.inviteCode, "fixture-code");
    } else assert.equal(link.href, "https://orbit.test/");
    assert.match(element("#modalRoot").innerHTML, /aria-label="Invite link" aria-describedby="inviteCopyStatus"/);
    pending.resolve(); await first;
    assert.equal(status.textContent, "Invite copied."); assert.equal(button.disabled, false);
  }
});

test("blocked invite copying offers selected manual text and never claims an unsuccessful copy", async () => {
  for (const result of [false, true, "throw"]) {
    let attempts = 0;
    const { app, element } = fixture({ navigator: { clipboard: { writeText: async () => { throw new Error("Clipboard blocked"); } } }, copy(command) { attempts++; assert.equal(command, "copy"); if (result === "throw") throw new Error("Copy blocked"); return result; } });
    app.inviteGeneral(); await element("#copyInvite").onclick();
    assert.equal(attempts, 1); assert.equal(element("#inviteLink").selected, true); assert.equal(element("#inviteLink").focused, true);
    assert.equal(element("#copyInvite").disabled, false);
    if (result === true) assert.equal(element("#inviteCopyStatus").textContent, "Invite copied.");
    else assert.match(element("#inviteCopyStatus").textContent, /couldn’t copy.*manually/);
    assert.notEqual(element("#toast").textContent, "Invite copied.");
  }
});

test("a closed invite cannot reclaim focus or report late clipboard results", async () => {
  for (const failed of [false, true]) {
    const pending = deferred(); let attempts = 0;
    const { app, element } = fixture({ navigator: { clipboard: { writeText: () => pending.promise } }, copy() { attempts++; return true; } });
    app.inviteGeneral();
    const input = element("#inviteLink"), status = element("#inviteCopyStatus"), copied = element("#copyInvite").onclick();
    input.isConnected = false;
    if (failed) pending.reject(new Error("Late clipboard failure")); else pending.resolve();
    await copied;
    assert.equal(status.textContent, ""); assert.equal(input.focused, undefined); assert.equal(attempts, 0);
  }
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
    assert.match(element("#messageList").innerHTML, /fresh view/i);
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
  assert.match(element("#worldHistoryStatus").textContent, /Earlier texts hidden in this tab/);
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

test("message links escape surrounding text and attributes while preserving URL punctuation", () => {
  const { app } = fixture();
  const html = app.formatMessageText('<b>Hello</b> https://example.com/find?q=one&next=two, (https://example.org/wiki/Thing_(example)).');
  assert.match(html, /^&lt;b&gt;Hello&lt;\/b&gt; /);
  assert.match(html, /href="https:\/\/example\.com\/find\?q=one&amp;next=two"/);
  assert.match(html, />https:\/\/example\.com\/find\?q=one&amp;next=two<\/a>, /);
  assert.match(html, /href="https:\/\/example\.org\/wiki\/Thing_\(example\)"/);
  assert.match(html, /<\/a>\)\.$/);
  assert.equal((html.match(/<a /g) || []).length, 2);
  assert.equal((html.match(/target="_blank" rel="noopener noreferrer nofollow ugc"/g) || []).length, 2);
  const injection = app.formatMessageText('https://example.com/" onclick="alert(1)"><img src=x onerror=bad>');
  assert.doesNotMatch(injection, /<img|<script|href="[^"]*" onclick=/);
  assert.match(injection, /&quot; onclick=&quot;alert\(1\)&quot;&gt;&lt;img/);
});

test("only explicit valid HTTP web links without embedded credentials are clickable", () => {
  const { app } = fixture();
  for (const unsafe of ["javascript:alert(1)", "data:text/html,<script>bad()</script>", "ftp://example.com/file", "//example.com/path", "http://user:password@example.com/", "https://someone@example.com/", "https://"]) {
    assert.doesNotMatch(app.formatMessageText(unsafe), /<a /, unsafe);
  }
  const html = app.formatMessageText("HTTP://example.com/path! then https://example.net/ok?");
  assert.equal((html.match(/<a /g) || []).length, 2);
  assert.match(html, /href="http:\/\/example\.com\/path"/);
  assert.match(html, /<\/a>! then /);
  assert.match(html, /<\/a>\?$/);
});

test("composer emoji replaces the selected text and persists its draft without dropping a reply", () => {
  const { app, element, storage, requests } = fixture();
  app.chooseDrafts(null); app.state.messages.global = [{ id: "emoji-original", user: "Friend", text: "Keep this context" }];
  app.startReply("emoji-original");
  const input = element("#messageInput"); input.value = "Hello replace friend"; app.saveDraft();
  assert.equal(app.insertComposerEmoji("👋", { channel: "global", version: 0, start: 6, end: 13 }), true);
  assert.equal(input.value, "Hello 👋 friend");
  assert.equal(input.selectionStart, 8); assert.equal(input.selectionEnd, 8);
  assert.equal(input.focused, true);
  assert.equal(app.replyDrafts.global.id, "emoji-original");
  const saved = JSON.parse(storage.get("orbit.chat.v3"));
  assert.equal(saved.draftsByIdentity[`guest-${app.state.guest.id}`].global, input.value);
  assert.equal(saved.replyDraftsByIdentity[`guest-${app.state.guest.id}`].global.id, "emoji-original");
  assert.equal(requests.length, 0, "choosing emoji must not send a message");
});

test("emoji insertion respects the full 700-unit message limit without truncating existing text", () => {
  const { app, element } = fixture(); app.chooseDrafts(null);
  const input = element("#messageInput"), select = { channel: "global", version: 0, start: 698, end: 698 };
  input.value = "a".repeat(698); app.saveDraft();
  assert.equal(app.insertComposerEmoji("👋", select), true);
  assert.equal(input.value.length, 700); assert.equal(input.value, "a".repeat(698) + "👋");
  input.value = "b".repeat(699); app.saveDraft(); input.setSelectionRange(699, 699);
  app.replyDrafts.global = { id: "keep-reply", user: "Friend", text: "Reply stays" };
  assert.equal(app.insertComposerEmoji("👋", { ...select, start: 699, end: 699 }), false);
  assert.equal(input.value, "b".repeat(699)); assert.equal(app.drafts.global, input.value);
  assert.equal(input.selectionStart, 699); assert.equal(app.replyDrafts.global.id, "keep-reply");
  assert.match(element("#toast").textContent, /700 characters/);
  input.value = "c".repeat(700); app.saveDraft();
  assert.equal(app.insertComposerEmoji("👋", { ...select, start: 200, end: 202 }), true);
  assert.equal(input.value, "c".repeat(200) + "👋" + "c".repeat(498));
  assert.equal(input.value.length, 700);
});

test("stale emoji selections cannot write into another account or room's draft", () => {
  const { app, element } = fixture();
  const input = element("#messageInput"), selection = { channel: "global", version: 0, start: 0, end: 0 };
  input.value = "Unresolved account";
  assert.equal(app.insertComposerEmoji("👋", selection), false);
  app.chooseDrafts(null); input.value = "Keep this text"; app.saveDraft();
  for (const [emoji, invalid] of [["👋", { ...selection, version: 1 }], ["👋", { ...selection, channel: "music" }], ["not-an-emoji", selection]]) {
    assert.equal(app.insertComposerEmoji(emoji, invalid), false);
    assert.equal(input.value, "Keep this text"); assert.equal(app.drafts.global, "Keep this text");
  }
});

test("searchable composer picker uses the captured caret and offers an understandable empty state", () => {
  const { app, element, requests } = fixture(); app.chooseDrafts(null);
  const input = element("#messageInput"); input.value = "Play this song"; input.setSelectionRange(5, 9); app.saveDraft();
  app.emojiPicker();
  assert.match(element("#modalRoot").innerHTML, /Search emoji/);
  element("#emojiSearch").value = "no-such-emoji"; element("#emojiSearch").oninput();
  assert.equal(element("#emojiChoices").innerHTML, ""); assert.match(element("#emojiResultStatus").textContent, /No emoji found/);
  element("#emojiSearch").value = "MuSiC"; element("#emojiSearch").oninput();
  assert.match(element("#emojiChoices").innerHTML, /data-choose-emoji="🎵"/);
  assert.doesNotMatch(element("#emojiChoices").innerHTML, /data-choose-emoji="🍕"/);
  element("#emojiChoices").onclick({ target: { closest: () => ({ dataset: { chooseEmoji: "🎵" } }) } });
  assert.equal(input.value, "Play 🎵 song"); assert.equal(input.selectionStart, 7);
  assert.equal(element("#modalRoot").innerHTML, ""); assert.equal(app.drafts.global, input.value);
  assert.equal(requests.length, 0);
});

test("reaction controls identify your prefixed account or guest identity and escape participant names", () => {
  const { app } = fixture();
  const item = { id: "reaction-own", text: "Hello", reactions: { "💜": [{ id: `guest-${app.state.guest.id}`, name: "Guest" }, { id: "user-other", name: '<img src=x onerror="bad">' }] } };
  let html = app.renderMessage(item);
  assert.match(html, /class="reaction is-mine"/); assert.match(html, /aria-pressed="true"/);
  assert.match(html, /title="You, &lt;img/); assert.doesNotMatch(html, /<img src=x/);
  app.state.profile = { id: "registered", name: "Registered" };
  html = app.renderMessage(item); assert.match(html, /aria-pressed="false"/);
  item.reactions["💜"] = [{ id: "registered", name: "Incorrect raw id" }];
  assert.match(app.renderMessage(item), /aria-pressed="false"/);
  item.reactions["💜"] = [{ id: "user-registered", name: "Registered" }];
  assert.match(app.renderMessage(item), /aria-pressed="true"/);
  item.reactions.broken = null;
  assert.doesNotThrow(() => app.renderMessage(item), "malformed legacy reaction entries must not break the feed");
});

test("reactions wait for confirmation, block duplicate toggles, and preserve the reading position", async () => {
  const response = deferred(), started = deferred();
  const { app, element, requests, flushFrames } = fixture({ request(record) {
    if (record.url.pathname === "/api/reactions") { started.resolve(); return response.promise; }
  } });
  app.chooseDrafts(null); app.state.connected = true; app.state.loading = false; app.state.view = "chat";
  const original = { id: "reaction-target", user: "Friend", text: "Keep reading", reactions: { "💜": [{ id: "user-friend", name: "Friend" }] } };
  app.state.messages.global = [original];
  const feed = element("#messages"); feed.scrollHeight = 5000; feed.clientHeight = 600; feed.scrollTop = 350;
  app.enterMessageRoom("global");
  app.messageFollow.pinned = false; app.messageFollow.anchor = { top: 350 };
  const pending = app.toggleReaction(original.id, "💜"); await started.promise;
  assert.equal(original.reactions["💜"].length, 1, "no optimistic count before the server confirms");
  assert.match(app.renderMessage(original), /data-emoji="💜"[^>]*disabled/);
  await app.toggleReaction(original.id, "💜");
  assert.equal(requests.filter(record => record.url.pathname === "/api/reactions").length, 1);
  response.resolve({ reactions: { "💜": [...original.reactions["💜"], { id: `guest-${app.state.guest.id}`, name: "Me" }] } });
  await pending; flushFrames();
  assert.equal(app.state.messages.global[0].reactions["💜"].length, 2);
  assert.match(element("#messageList").innerHTML, /aria-pressed="true"/);
  assert.doesNotMatch(app.renderMessage(original), /data-emoji="💜"[^>]*disabled/);
  assert.equal(feed.scrollTop, 350);
});

test("a rejected reaction keeps existing counts, composer text and reply context", async () => {
  const { app, element } = fixture({ request(record) {
    if (record.url.pathname === "/api/reactions") return mockHttp({ error: "That message is no longer here." }, { status: 404 });
  } });
  app.chooseDrafts(null); app.state.connected = true; app.state.loading = false;
  const reactions = { "💜": [{ id: "user-friend", name: "Friend" }] };
  app.state.messages.global = [{ id: "durable-only", user: "Friend", text: "A visible message", reactions }];
  app.startReply("durable-only"); element("#messageInput").value = "Keep my unfinished reply"; app.saveDraft();
  await app.toggleReaction("durable-only", "💜");
  assert.equal(JSON.stringify(app.state.messages.global[0].reactions), JSON.stringify(reactions));
  assert.equal(element("#messageInput").value, "Keep my unfinished reply"); assert.equal(app.drafts.global, "Keep my unfinished reply");
  assert.equal(app.replyDrafts.global.id, "durable-only"); assert.match(element("#toast").textContent, /no longer here/);
  assert.doesNotMatch(app.renderMessage(app.state.messages.global[0]), /data-emoji="💜"[^>]*disabled/);
});

test("reaction responses from a previous session cannot alter the next account's cached message", async () => {
  const response = deferred(), started = deferred();
  const { app } = fixture({ request(record) {
    if (record.url.pathname === "/api/reactions") { started.resolve(); return response.promise; }
  } });
  app.chooseDrafts(null); app.state.connected = true; app.state.loading = false;
  app.state.messages.global = [{ id: "shared-message", text: "Earlier session", reactions: {} }];
  const pending = app.toggleReaction("shared-message", "💜"); await started.promise;
  await app.refreshIdentity({ id: "next-account", name: "Next account" }, true);
  app.state.messages.global = [{ id: "shared-message", text: "Current account snapshot", reactions: {} }];
  response.resolve({ reactions: { "💜": [{ id: "guest-previous", name: "Previous session" }] } });
  await pending;
  assert.equal(app.state.profile.id, "next-account");
  assert.equal(Object.keys(app.state.messages.global[0].reactions).length, 0);
  assert.equal(app.state.messages.global[0].text, "Current account snapshot");
});

test("copy sends exact message text to the clipboard and provides escaped manual fallback", async () => {
  const copied = [], message = { id: "copy-target", text: 'Raw <text> & "quotes"\nSecond line' };
  const success = fixture({ navigator: { clipboard: { writeText: async text => copied.push(text) } } });
  success.app.state.messages.global = [message];
  await success.app.copyMessage(message.id);
  assert.deepEqual(copied, [message.text]); assert.equal(success.element("#toast").textContent, "Message copied.");
  assert.equal(success.element("#modalRoot").innerHTML, "");
  const fallback = fixture(); fallback.app.chooseDrafts(null); fallback.app.state.messages.global = [message];
  fallback.element("#messageInput").value = "My own draft"; fallback.app.saveDraft();
  await fallback.app.copyMessage(message.id);
  assert.match(fallback.element("#modalRoot").innerHTML, /readonly>Raw &lt;text&gt; &amp; &quot;quotes&quot;/);
  assert.doesNotMatch(fallback.element("#modalRoot").innerHTML, /Raw <text>/);
  assert.equal(fallback.element("#copyMessageText").selected, true);
  assert.equal(fallback.element("#messageInput").value, "My own draft"); assert.equal(fallback.app.drafts.global, "My own draft");
});

test("message tools cannot act on pending, failed or deliberately hidden messages", async () => {
  const copied = [], { app, element, requests } = fixture({ navigator: { clipboard: { writeText: async text => copied.push(text) } } });
  app.chooseDrafts(null); app.state.loading = false; app.state.connected = true;
  app.state.messages.global = [{ id: "hidden-tool-target", text: "Earlier text", createdAt: "2026-10-27T12:00:00Z" }];
  app.hideWorldHistory();
  app.state.messages.global.push({ id: "pending-tool-target", text: "Sending", pending: true }, { id: "failed-tool-target", text: "Unsent", failed: true });
  for (const id of ["hidden-tool-target", "pending-tool-target", "failed-tool-target"]) {
    app.emojiPicker(id); await app.toggleReaction(id, "💜"); await app.copyMessage(id);
  }
  assert.equal(requests.length, 0); assert.deepEqual(copied, []); assert.equal(element("#modalRoot").innerHTML, "");
});

test("live arrivals preserve existing message rows, reply context and the composer draft", () => {
  const { app, element } = fixture(); app.chooseDrafts(null); app.state.loading = false; app.state.view = "chat";
  app.state.messages.global = [
    { id: "mounted-original", user: "Friend", text: "A message I am reading", createdAt: "2026-11-19T12:00:00Z" },
    { id: "mounted-reply", user: "Another friend", text: "An answer", replyTo: { id: "mounted-original", user: "Friend", text: "A message I am reading" }, createdAt: "2026-11-19T12:01:00Z" }
  ];
  app.renderMessages();
  const list = element("#messageList"), find = id => list.children.find(node => node.dataset.messageId === id);
  const original = find("mounted-original"), reply = find("mounted-reply"), originalActions = original.querySelector(".message-actions");
  const replyActions = reply.querySelector(".message-actions"), originalWrites = originalActions.updates;
  app.startReply("mounted-original"); element("#messageInput").value = "My unfinished reply"; app.saveDraft();
  app.addMessage("global", { id: "mounted-arrival", user: "New friend", text: "A new hello", createdAt: "2026-11-19T12:02:00Z" });
  assert.equal(find("mounted-original"), original); assert.equal(find("mounted-reply"), reply);
  assert.equal(original.isConnected, true); assert.equal(reply.isConnected, true);
  assert.equal(original.querySelector(".message-actions"), originalActions); assert.equal(originalActions.updates, originalWrites);
  app.receiveLiveEvent({ type: "reaction", channel: "global", messageId: "mounted-reply", reactions: { "💜": [{ id: "user-friend", name: "Friend" }] } });
  assert.equal(find("mounted-reply"), reply, "a reaction must update controls without replacing its message body");
  assert.equal(reply.querySelector(".message-actions"), replyActions);
  assert.match(reply.outerHTML, /data-jump-reply="mounted-original"/); assert.match(reply.outerHTML, /data-emoji="💜"/);
  assert.equal(originalActions.updates, originalWrites);
  assert.equal(element("#messageInput").value, "My unfinished reply"); assert.equal(app.drafts.global, "My unfinished reply");
  assert.equal(app.replyDrafts.global.id, "mounted-original");
});

test("identical polling and reaction snapshots leave mounted rows and controls untouched", () => {
  const { app, element } = fixture(); app.state.loading = false;
  const message = { id: "unchanged-row", user: "Friend", text: "Keep this mounted", createdAt: "2026-11-19T12:00:00Z", reactions: { "💜": [{ id: "user-friend", name: "Friend" }] } };
  app.state.messages.global = [message]; app.renderMessages();
  const list = element("#messageList"), before = [...list.children], row = list.children.find(node => node.dataset.messageId === message.id);
  const actions = row.querySelector(".message-actions"), writes = actions.updates;
  for (let count = 0; count < 3; count++) {
    app.addMessage("global", JSON.parse(JSON.stringify(message)));
    app.receiveLiveEvent({ type: "reaction", channel: "global", messageId: message.id, reactions: JSON.parse(JSON.stringify(message.reactions)) });
    app.renderMessages();
  }
  assert.deepEqual(list.children, before); assert.equal(row.querySelector(".message-actions"), actions); assert.equal(actions.updates, writes);
  assert.equal((list.innerHTML.match(/data-message-id=/g) || []).length, 1);
});

test("history inserted before existing messages changes order without replacing their nodes", () => {
  const { app, element } = fixture(); app.state.loading = false;
  app.state.messages.music = [{ id: "later-history", text: "Already visible", createdAt: "2026-11-19T12:00:00Z" }];
  app.state.active = "music"; app.renderMessages();
  const list = element("#messageList"), later = list.children.find(node => node.dataset.messageId === "later-history");
  app.addMessage("music", { id: "earlier-history", text: "Backfilled earlier conversation", createdAt: "2026-11-18T12:00:00Z" });
  const messages = list.children.filter(node => node.dataset.messageId);
  assert.deepEqual(messages.map(node => node.dataset.messageId), ["earlier-history", "later-history"]);
  assert.equal(messages[1], later); assert.equal(later.isConnected, true);
  assert.match(list.innerHTML, /November 18, 2026/); assert.match(list.innerHTML, /November 19, 2026/);
});

test("channel and account switches remove previous private DOM while preserving identity-scoped drafts", async () => {
  const { app, element } = fixture(); app.chooseDrafts(null); app.state.loading = false; app.state.active = "party-mounted";
  app.state.parties = [{ id: "party-mounted", name: "Private mounted party", type: "party" }];
  app.state.messages["party-mounted"] = [{ id: "private-mounted", user: "Friend", text: "Private party text", createdAt: "2026-11-19T12:00:00Z" }];
  app.renderMessages();
  const list = element("#messageList"), privateNode = list.children.find(node => node.dataset.messageId === "private-mounted");
  element("#messageInput").value = "Private party draft"; app.saveDraft();
  await app.selectChannel("music");
  assert.equal(privateNode.isConnected, false); assert.doesNotMatch(list.innerHTML, /Private party text/);
  assert.equal(app.drafts["party-mounted"], "Private party draft");
  await app.selectChannel("party-mounted");
  assert.equal(element("#messageInput").value, "Private party draft");
  const reopened = list.children.find(node => node.dataset.messageId === "private-mounted");
  assert.notEqual(reopened, privateNode); assert.equal(reopened.isConnected, true);
  await app.refreshIdentity({ id: "next-mounted-account", name: "Next account" }, true);
  assert.equal(reopened.isConnected, false); assert.doesNotMatch(list.innerHTML, /Private party text/);
  assert.equal(app.drafts["party-mounted"], undefined); assert.equal(element("#messageInput").value, "");
});

test("pending and failed delivery updates preserve unrelated message rows and newer reply drafts", async () => {
  const response = deferred(), started = deferred();
  const { app, element } = fixture({ request(record) {
    if (record.url.pathname === "/api/messages" && record.method === "POST") { started.resolve(); return response.promise; }
  } });
  app.chooseDrafts(null); app.state.loading = false; app.state.connected = true;
  app.state.messages.global = [{ id: "unrelated-mounted", user: "Friend", text: "Keep reading this", createdAt: "2026-11-19T12:00:00Z" }];
  app.renderMessages();
  const list = element("#messageList"), unrelated = list.children.find(node => node.dataset.messageId === "unrelated-mounted");
  element("#messageInput").value = "A message in flight"; app.saveDraft();
  const sending = app.sendMessage(element("#messageInput").value); await started.promise;
  const pending = app.state.messages.global.find(item => item.pending);
  assert.match(list.innerHTML, /Sending…/); assert.equal(list.children.find(node => node.dataset.messageId === unrelated.dataset.messageId), unrelated);
  app.startReply("unrelated-mounted"); element("#messageInput").value = "A newer unsent reply"; app.saveDraft();
  response.resolve(mockHttp({ error: "Chat could not accept the message." }, { status: 400 })); await sending;
  assert.equal(list.children.find(node => node.dataset.messageId === unrelated.dataset.messageId), unrelated);
  assert.equal(app.state.messages.global.find(item => item.id === pending.id).failed, true);
  assert.match(list.innerHTML, /data-retry-message=/);
  assert.equal(element("#messageInput").value, "A newer unsent reply"); assert.equal(app.replyDrafts.global.id, "unrelated-mounted");
});

test("a late send confirmation respects scrolling back into history after pressing Send", async () => {
  const response = deferred(), started = deferred();
  const { app, element, flushFrames } = fixture({ request(record) {
    if (record.url.pathname === "/api/messages" && record.method === "POST") { started.resolve(); return response.promise; }
  } });
  app.bind(); app.chooseDrafts(null); app.state.loading = false; app.state.view = "chat"; app.state.connected = true;
  app.state.messages.global = [{ id: "reading-during-send", text: "Some earlier history", createdAt: "2026-11-19T12:00:00Z" }];
  const feed = element("#messages"); feed.scrollHeight = 7000; feed.clientHeight = 600;
  app.renderMessages(); flushFrames();
  const sending = app.sendMessage("An outgoing message"); await started.promise; flushFrames();
  feed.dispatchEvent({ type: "wheel", deltaY: -200 }); feed.scrollTop = 400; feed.dispatchEvent({ type: "scroll" });
  response.resolve({ message: { id: "accepted-after-reading", text: "An outgoing message", createdAt: "2026-11-19T12:01:00Z" } });
  await sending; flushFrames();
  assert.equal(feed.scrollTop, 400); assert.equal(app.messageFollow.pinned, false);
  assert.equal(element("#jumpLatest").classList.contains("hidden"), false);
  assert.match(element("#messageList").innerHTML, /accepted-after-reading/); assert.doesNotMatch(element("#messageList").innerHTML, /Sending…/);
});

test("the room directory shows joined spaces with escaped labels and leaves composition untouched", () => {
  const { app, element, requests } = fixture(); app.chooseDrafts(null); app.state.loading = false; app.state.view = "chat";
  app.state.rooms = [{ id: "room-directory", name: "A public room", topic: "A public topic", type: "channel" }];
  app.state.parties = [{ id: "party-directory", name: '<img src=x onerror="bad">', type: "party" }];
  app.state.servers = [{ id: "server-directory", name: "Design friends", description: "Make things together", channels: [{ id: "channel-directory", name: "studio", type: "text" }, { id: "voice-directory", name: "workshop", type: "voice" }] }];
  app.state.messages.global = [{ id: "directory-reply", user: "Friend", text: "Keep this reply context" }];
  app.startReply("directory-reply"); element("#messageInput").value = "Keep my multiline\ndraft"; app.saveDraft();
  app.openRoomDirectory();
  const results = element("#roomDirectoryResults").innerHTML;
  for (const id of ["global", "music", "room-directory", "party-directory", "channel-directory", "voice-directory"]) assert.match(results, new RegExp(`data-directory-room="${id}"`));
  assert.doesNotMatch(results, /data-channel=|<img src=x/); assert.match(results, /&lt;img src=x/);
  const selected = /<button\b[^>]*data-directory-room="global"[^>]*>/.exec(results)?.[0];
  assert.match(selected || "", /aria-current="true"/);
  assert.equal(app.state.active, "global"); assert.equal(app.state.view, "chat");
  assert.equal(element("#messageInput").value, "Keep my multiline\ndraft"); assert.equal(app.replyDrafts.global.id, "directory-reply");
  assert.equal(requests.length, 0);
});

test("directory search and unread/following filters update live without selecting a room", () => {
  const { app, element } = fixture(); app.chooseDrafts(null); app.state.loading = false; app.state.view = "chat";
  app.state.parties = [{ id: "party-filtered", name: "Close friends", type: "party" }];
  app.state.servers = [{ id: "server-filtered", name: "Design friends", channels: [{ id: "channel-filtered", name: "studio", type: "text" }] }];
  app.state.followingRooms = ["music", "party-filtered", "party-not-joined"];
  app.state.unread = { music: 1 }; app.openRoomDirectory();
  const search = element("#roomDirectorySearch"), results = element("#roomDirectoryResults");
  const filter = value => element("#roomDirectoryFilters").onclick({ target: { closest: selector => selector === "[data-directory-filter]" ? { dataset: { directoryFilter: value } } : null } });
  search.value = "DeSiGn"; search.oninput();
  assert.match(results.innerHTML, /data-directory-room="channel-filtered"/); assert.doesNotMatch(results.innerHTML, /data-directory-room="music"/);
  search.value = ""; search.oninput(); filter("unread");
  assert.equal(element('#roomDirectoryFilters [data-directory-filter="unread"]').getAttribute("aria-pressed"), "true");
  assert.equal(element('#roomDirectoryFilters [data-directory-filter="all"]').getAttribute("aria-pressed"), "false");
  assert.match(results.innerHTML, /data-directory-room="music"/); assert.doesNotMatch(results.innerHTML, /data-directory-room="travel"/);
  app.addMessage("travel", { id: "directory-live-unread", user: "Friend", text: "A new postcard" });
  assert.match(results.innerHTML, /data-directory-room="travel"/, "an open unread list should reflect a new message");
  filter("following");
  assert.match(results.innerHTML, /data-directory-room="music"/); assert.match(results.innerHTML, /data-directory-room="party-filtered"/);
  assert.doesNotMatch(results.innerHTML, /data-directory-room="travel"|party-not-joined/);
  search.value = "no matching room anywhere"; search.oninput();
  assert.doesNotMatch(results.innerHTML, /data-directory-room=/);
  assert.match(results.innerHTML, /no|try|find/i);
  assert.equal(app.state.active, "global"); assert.equal(app.state.view, "chat");
});

test("phone and tablet room badges reflect available unread conversations and cap their visible totals", () => {
  const { app, element } = fixture(); app.state.loading = false; app.state.view = "chat";
  app.state.unread = { music: 120, travel: 4, "party-not-joined": 30 }; app.renderRoomList();
  for (const selector of ["#roomDirectoryBadge", "#phoneRoomBadge"]) assert.equal(element(selector).textContent, "99+");
  for (const selector of ["#roomsButton", "#phoneRooms"]) {
    assert.match(element(selector).getAttribute("aria-label"), /124/);
    assert.doesNotMatch(element(selector).getAttribute("aria-label"), /154/);
  }
  app.addMessage("music", { id: "badge-live", user: "Friend", text: "A new song" });
  app.addMessage("music", { id: "badge-live", user: "Friend", text: "A new song" });
  assert.match(element("#roomsButton").getAttribute("aria-label"), /125/);
  app.state.unread = {}; app.renderRoomList();
  for (const selector of ["#roomDirectoryBadge", "#phoneRoomBadge"]) assert.notEqual(element(selector).textContent, "99+", "clearing unread must remove stale totals");
});

test("directory text selection opens its chat, clears only that unread count and keeps the call", async () => {
  const { app, element, listeners, requests } = fixture(); app.bind(); app.chooseDrafts(null); app.state.loading = false; app.state.view = "chat";
  app.state.voiceRoom = "global"; app.state.unread = { music: 2, travel: 3 };
  element("#messageInput").value = "Keep the World draft"; app.saveDraft(); app.openRoomDirectory();
  listeners.get("click")({ target: { closest: selector => selector === "[data-directory-room]" ? { dataset: { directoryRoom: "music" } } : null } });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(app.state.active, "music"); assert.equal(app.state.view, "chat"); assert.equal(app.state.unread.music || 0, 0); assert.equal(app.state.unread.travel, 3);
  assert.equal(app.state.voiceRoom, "global"); assert.equal(app.drafts.global, "Keep the World draft"); assert.equal(element("#modalRoot").innerHTML, "");
  assert.ok(requests.some(record => record.url.pathname === "/api/messages" && record.url.searchParams.get("channel") === "music"));
  assert.ok(!requests.some(record => record.url.pathname === "/api/voice/leave" || record.url.pathname === "/api/voice/join"));
});

test("directory voice selection previews voice without moving the text room, draft or active call", async () => {
  const { app, element, listeners, requests } = fixture(); app.bind(); app.chooseDrafts(null); app.state.loading = false; app.state.view = "chat";
  app.state.active = "music"; app.state.voiceRoom = "global";
  app.state.servers = [{ id: "server-voice-directory", name: "Friends", channels: [{ id: "voice-directory-preview", name: "hangout", type: "voice" }] }];
  element("#messageInput").value = "Keep my music draft"; app.saveDraft(); app.openRoomDirectory();
  listeners.get("click")({ target: { closest: selector => selector === "[data-directory-room]" ? { dataset: { directoryRoom: "voice-directory-preview" } } : null } });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(app.state.view, "voice"); assert.equal(app.state.voiceSelection, "voice-directory-preview"); assert.equal(app.state.active, "music");
  assert.equal(app.state.voiceRoom, "global"); assert.equal(element("#messageInput").value, "Keep my music draft"); assert.equal(app.drafts.music, "Keep my music draft");
  assert.match(element("#voiceTabJoin").textContent, /leave current call/i); assert.equal(element("#voiceTabMute").classList.contains("hidden"), true);
  assert.equal(element("#modalRoot").innerHTML, "");
  assert.ok(!requests.some(record => record.url.pathname.startsWith("/api/voice/")), "previewing voice must never start or end a call");
  const selected = app.state.voiceSelection;
  await app.selectChannel("voice-not-joined");
  assert.equal(app.state.active, "music"); assert.equal(app.state.voiceSelection, selected);
});

test("the member panel toggle remembers its preference while preserving chat and voice state", () => {
  const { app, element, storage, requests, flushFrames } = fixture(); app.bind(); app.chooseDrafts(null); app.state.loading = false; app.state.view = "chat";
  app.state.voiceRoom = "global"; app.state.messages.global = [{ id: "member-toggle-reading", user: "Friend", text: "Keep this message mounted" }];
  app.renderMessages(); flushFrames();
  const list = element("#messageList"), row = list.children.find(node => node.dataset.messageId === "member-toggle-reading");
  app.startReply("member-toggle-reading"); element("#messageInput").value = "My unfinished reply"; app.saveDraft();
  const feed = element("#messages"); feed.scrollHeight = 5000; feed.clientHeight = 600; feed.scrollTop = 320;
  app.messageFollow.pinned = false; app.messageFollow.anchor = { top: 320 };
  assert.equal(element("#desktopMembers").getAttribute("aria-expanded"), "true");
  element("#desktopMembers").onclick(); flushFrames();
  assert.equal(element("#chatView").classList.contains("members-collapsed"), true);
  assert.equal(element("#desktopMembers").getAttribute("aria-expanded"), "false"); assert.match(element("#desktopMembers").getAttribute("aria-label"), /show/i);
  assert.equal(JSON.parse(storage.get("orbit.chat.v3")).memberPanelOpen, false);
  assert.equal(list.children.find(node => node.dataset.messageId === "member-toggle-reading"), row);
  assert.equal(feed.scrollTop, 320); assert.equal(element("#messageInput").value, "My unfinished reply"); assert.equal(app.replyDrafts.global.id, "member-toggle-reading");
  assert.equal(app.state.voiceRoom, "global"); assert.equal(requests.length, 0);
  const reloaded = fixture({ storage }); reloaded.app.bind();
  assert.equal(reloaded.element("#chatView").classList.contains("members-collapsed"), true); assert.equal(reloaded.element("#desktopMembers").getAttribute("aria-expanded"), "false");
  reloaded.element("#desktopMembers").onclick();
  assert.equal(reloaded.element("#chatView").classList.contains("members-collapsed"), false); assert.match(reloaded.element("#desktopMembers").getAttribute("aria-label"), /hide/i);
});

test("member panel preferences default safely and remain usable when browser storage is blocked", () => {
  for (const value of [undefined, null, "false", 0]) {
    const storage = new Map([["orbit.chat.v3", JSON.stringify({ memberPanelOpen: value })]]);
    const { app, element } = fixture({ storage }); app.bind();
    assert.equal(element("#chatView").classList.contains("members-collapsed"), false);
    assert.equal(element("#desktopMembers").getAttribute("aria-expanded"), "true");
  }
  const { app, element } = fixture({ storageBlocked: true }); app.bind(); app.chooseDrafts(null);
  element("#messageInput").value = "Keep writing with storage blocked"; app.saveDraft();
  assert.doesNotThrow(() => app.setMemberPanel(false)); assert.equal(element("#chatView").classList.contains("members-collapsed"), true);
  assert.doesNotThrow(() => app.setMemberPanel(true)); assert.equal(element("#chatView").classList.contains("members-collapsed"), false);
  assert.equal(element("#messageInput").value, "Keep writing with storage blocked"); assert.equal(app.drafts.global, element("#messageInput").value);
});

test("the voice dock follows the joined call and opens controls without replacing the text draft", async () => {
  const { app, element, requests } = fixture(); app.bind(); app.chooseDrafts(null); app.state.loading = false; app.state.connected = true; app.state.active = "music";
  app.renderVoice(); assert.equal(element("#voiceDock").classList.contains("hidden"), true);
  app.state.voiceRoom = "global"; app.state.voiceSelection = "global"; app.renderVoice();
  assert.equal(element("#voiceDock").classList.contains("hidden"), false); assert.match(element("#voiceDockRoom").textContent, /World/);
  assert.equal(element("#phoneVoiceTab").classList.contains("joined"), true);
  element("#messageInput").value = "Music notes while talking"; app.saveDraft();
  element("#voiceDockOpen").onclick();
  assert.equal(app.state.view, "voice"); assert.equal(app.state.active, "music"); assert.equal(app.state.voiceRoom, "global");
  assert.equal(element("#messageInput").value, "Music notes while talking");
  element("#voiceDockMute").onclick(); await new Promise(resolve => setImmediate(resolve));
  assert.equal(app.state.muted, true);
  assert.ok(requests.some(record => record.url.pathname === "/api/voice/state" && record.body.room === "global" && record.body.muted === true));
  assert.ok(!requests.some(record => record.url.pathname === "/api/voice/join" || record.url.pathname === "/api/voice/leave"));
  element("#voiceDockLeave").onclick(); await new Promise(resolve => setImmediate(resolve));
  assert.equal(app.state.voiceRoom, ""); assert.equal(element("#voiceDock").classList.contains("hidden"), true); assert.equal(element("#phoneVoiceTab").classList.contains("joined"), false);
  assert.equal(element("#messageInput").value, "Music notes while talking"); assert.equal(app.drafts.music, "Music notes while talking");
});

test("directory Enter opens its sole search result and respects IME text confirmation", async () => {
  const { app, element, requests } = fixture(); app.bind(); app.chooseDrafts(null); app.state.loading = false; app.state.view = "chat";
  app.state.rooms = [{ id: "room-keyboard-directory", name: "Unique keyboard room", type: "channel" }];
  element("#messageInput").value = "A draft before searching"; app.saveDraft(); app.openRoomDirectory();
  const search = element("#roomDirectorySearch"); search.value = "Unique keyboard"; search.oninput();
  assert.equal(element("#roomDirectoryStatus").textContent, "1 room");
  let prevented = false;
  search.onkeydown({ key: "Enter", isComposing: true, preventDefault() { prevented = true; } });
  assert.equal(prevented, false); assert.equal(app.state.active, "global"); assert.equal(requests.length, 0);
  search.onkeydown({ key: "Enter", isComposing: false, preventDefault() { prevented = true; } });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(prevented, true); assert.equal(app.state.active, "room-keyboard-directory"); assert.equal(app.state.view, "chat");
  assert.equal(element("#modalRoot").innerHTML, ""); assert.equal(app.drafts.global, "A draft before searching");
  assert.ok(requests.some(record => record.url.pathname === "/api/messages" && record.url.searchParams.get("channel") === "room-keyboard-directory"));
});
