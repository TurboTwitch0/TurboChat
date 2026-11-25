(() => {
  "use strict";
  const $ = s => document.querySelector(s), $$ = s => [...document.querySelectorAll(s)];
  const localHosts = new Set(["localhost", "127.0.0.1", "::1"]);
  const API_BASE = localHosts.has(location.hostname) && location.port !== "3001" ? `${location.protocol}//${location.hostname}:3001` : "";
  const usePolling = !localHosts.has(location.hostname) && !location.port;
  const appOrigin = API_BASE || location.origin;
  const storageKey = "orbit.chat.v3";
  const VOICE_SAMPLE_RATE = 24000;
  let damagedSaved = null;
  const saved = (() => {
    let raw = null;
    try {
      raw = localStorage.getItem(storageKey);
      if (raw === null) return {};
      const value = JSON.parse(raw);
      if (value && typeof value === "object" && !Array.isArray(value)) return value;
    } catch { /* A damaged record must not prevent opening the app. */ }
    damagedSaved = raw; return {};
  })();
  const validGuest = saved.guest && typeof saved.guest.id === "string" && saved.guest.id.trim() && typeof saved.guest.name === "string" && saved.guest.name.trim();
  const guest = validGuest ? saved.guest : { id: crypto.randomUUID(), name: `Guest ${100 + Math.floor(Math.random() * 900)}` };
  const defaultRooms = [
    { id: "global", name: "The World", emoji: "◎", color: "#7763d8", type: "channel" },
    { id: "music", name: "Now Playing", emoji: "♫", color: "#a07ae1", type: "channel" },
    { id: "travel", name: "Somewhere New", emoji: "⌖", color: "#48a898", type: "channel" },
    { id: "makers", name: "The Makers Table", emoji: "✳", color: "#c18858", type: "channel" },
    { id: "lounge", name: "The Slow Lounge", emoji: "☾", color: "#7180c4", type: "channel" }
  ];
  const info = {
    global: ["The World", "The whole world, one conversation.", "◎", "A little hello can go a long way. Where are you joining us from?"],
    music: ["Now Playing", "Share a song and listen from wherever you are.", "♫", "Put on a song. Tell us what it means to you."],
    travel: ["Somewhere New", "Postcards, plans, and places you dream about.", "⌖", "If you could wake up anywhere tomorrow, where would it be?"],
    makers: ["The Makers Table", "A friendly corner for things in progress.", "✳", "Show us what you’re making, learning, or figuring out."],
    lounge: ["The Slow Lounge", "A softer room for slower conversations.", "☾", "Take a breath. What’s one good thing from today?"]
  };
  const savedRoom = typeof saved.active === "string" ? saved.active : "";
  const savedVoiceRoom = savedRoom.startsWith("voice-") ? savedRoom : "";
  const state = { guest, profile: null, active: savedVoiceRoom ? "global" : savedRoom || "global", view: ["discover", "chat", "people", "voice"].includes(saved.view) ? saved.view : "discover", loading: true, channelErrors: {}, rooms: [], parties: [], servers: [], messages: {}, music: null, members: [], registered: 1428, goal: 1500, followingRooms: Array.isArray(saved.followingRooms) ? saved.followingRooms : [], connected: false, stream: null, peerId: crypto.randomUUID(), voiceRoom: "", joiningVoice: false, voiceMembers: [], muted: false, deafened: false, voiceError: "", voiceMobileOpen: false };
  const loadingChannels = new Set();
  let showcaseIndex = 0;
  const showcaseNotes = {
    global: ["START ANYWHERE", "A big world. One open conversation.", "#b5a0ff"],
    music: ["FIND YOUR SOUNDTRACK", "Share a song. Listen a little closer.", "#d2b2ff"],
    travel: ["A CHANGE OF SCENERY", "Places you’ve been. Places you dream of.", "#93e0cd"],
    makers: ["THINGS IN PROGRESS", "Ideas, projects, and your next little win.", "#e2b58b"],
    lounge: ["TAKE YOUR TIME", "Slow down. There’s room for you here.", "#a4b5ff"]
  };
  function renderShowcase() {
    const current = defaultRooms[showcaseIndex];
    const [kicker, description, accent] = showcaseNotes[current.id];
    $("#showcaseCards").innerHTML = `<article class="stage-room-card is-current" style="--room-accent:${accent}" aria-label="Selected public room: ${esc(current.name)}"><span class="room-preview-symbol" aria-hidden="true">${esc(current.emoji)}</span><span class="stage-card-kicker">${esc(kicker)}</span><h3>${esc(current.name)}</h3><p>${esc(description)}</p><span class="stage-card-footer">Public room · Explore as a guest</span></article>`;
    $("#showcaseOpen").dataset.channel = current.id;
    $("#showcaseOpen").textContent = `Open ${current.name} ↗`;
    $("#showcaseSelection").textContent = `${String(showcaseIndex + 1).padStart(2, "0")} / ${String(defaultRooms.length).padStart(2, "0")} — ${current.name}`;
    $$("#showcaseChoices [data-showcase-select]").forEach(button => { const index = Number(button.dataset.showcaseSelect), selected = index === showcaseIndex; button.textContent = defaultRooms[index].name; button.setAttribute("aria-pressed", String(selected)); button.classList.toggle("selected", selected); });
  }
  function selectShowcase(index, focus = false) {
    if (!Number.isInteger(index)) return;
    showcaseIndex = (index % defaultRooms.length + defaultRooms.length) % defaultRooms.length;
    renderShowcase();
    if (focus) $(`#showcaseChoices [data-showcase-select="${showcaseIndex}"]`)?.focus();
  }
  function showcaseKeydown(event) {
    if (!event.target.closest("#showcaseChoices [data-showcase-select]") || event.isComposing || event.altKey || event.ctrlKey || event.metaKey) return;
    const keyIndex = { ArrowRight: showcaseIndex + 1, ArrowLeft: showcaseIndex - 1, Home: 0, End: defaultRooms.length - 1 };
    if (!Object.hasOwn(keyIndex, event.key)) return;
    event.preventDefault(); selectShowcase(keyIndex[event.key], true);
  }
  let mic = null, audioContext = null, micSource = null, micProcessor = null, relaySocket = null, outputGain = null, outputSchedule = new Map(), toastTimer, reconnectTimer, typingTimer, typingStopTimer, pollTimer, lastEventSeq = 0, lastHeartbeat = 0, lastMessageSync = 0, lastVoiceHeartbeat = 0, localTyping = false, polling = false;
  const typingPeers = new Map();
  const voicePeers = new Map();
  const pendingIce = new Map();
  const voiceSignalQueues = new Map();
  const blockedVoicePeers = new Map();
  const esc = s => String(s ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  const name = () => state.profile?.name || state.guest.name;
  const emojiChoices = [
    ["👋", "Wave hello"], ["💜", "Purple heart love"], ["❤️", "Red heart love"], ["👍", "Thumbs up yes"],
    ["🙌", "Raised hands celebrate"], ["👏", "Clap applause"], ["🎉", "Party celebration"], ["🔥", "Fire amazing"],
    ["😂", "Laugh tears of joy"], ["😊", "Smile happy"], ["🥰", "Smiling with hearts"], ["😎", "Cool sunglasses"],
    ["🤔", "Thinking curious"], ["👀", "Eyes looking"], ["😮", "Surprised wow"], ["😢", "Sad crying"],
    ["🫶", "Heart hands care"], ["🙏", "Thank you please"], ["💯", "Hundred perfect"], ["✅", "Check done"],
    ["✨", "Sparkles magic"], ["⭐", "Star favorite"], ["🌈", "Rainbow"], ["🌻", "Sunflower"],
    ["☕", "Coffee break"], ["🍕", "Pizza food"], ["🎧", "Headphones music"], ["🎵", "Music note song"],
    ["🎮", "Game controller"], ["🚀", "Rocket launch"], ["🌍", "Earth world"], ["🌙", "Moon night"]
  ];
  const reactionRequests = new Set();
  const reactionRequestKey = (channel, id) => `${identityVersion}:${channel}:${id}`;
  const messageTime = new Intl.DateTimeFormat([], { hour: "numeric", minute: "2-digit" });
  const messageDay = new Intl.DateTimeFormat([], { month: "long", day: "numeric", year: "numeric" });
  const messageRows = new Map();
  let messageListRoom, messageListIdentity;
  // Only explicit web URLs become links. All user text and attributes stay escaped.
  function formatMessageText(value) {
    const text = String(value ?? ""); let result = "", end = 0;
    for (const match of text.matchAll(/https?:\/\/[^\s<>"'`]+/gi)) {
      let link = match[0].replace(/[.,!?;:]+$/, "");
      for (const [open, close] of [["(", ")"], ["[", "]"]]) {
        while (link.endsWith(close) && link.split(close).length > link.split(open).length) link = link.slice(0, -1);
      }
      result += esc(text.slice(end, match.index));
      try {
        const url = new URL(link);
        if (!url.hostname || url.username || url.password) throw new Error("Not a public web link");
        result += `<a class="message-link" href="${esc(url.href)}" target="_blank" rel="noopener noreferrer nofollow ugc" title="Open link in a new tab">${esc(link)}</a>`;
      } catch { result += esc(link); }
      end = match.index + link.length;
    }
    return result + esc(text.slice(end));
  }
  const drafts = saved.drafts && typeof saved.drafts === "object" && !Array.isArray(saved.drafts) ? saved.drafts : {};
  const draftBooks = saved.draftsByIdentity && typeof saved.draftsByIdentity === "object" && !Array.isArray(saved.draftsByIdentity) ? saved.draftsByIdentity : {};
  const replyDrafts = saved.replyDrafts && typeof saved.replyDrafts === "object" && !Array.isArray(saved.replyDrafts) ? saved.replyDrafts : {};
  const replyBooks = saved.replyDraftsByIdentity && typeof saved.replyDraftsByIdentity === "object" && !Array.isArray(saved.replyDraftsByIdentity) ? saved.replyDraftsByIdentity : {};
  let draftIdentity = typeof saved.draftIdentity === "string" ? saved.draftIdentity : "", accountBusy = false, draftsResolved = false;
  state.unread = {};
  state.memberPanelOpen = saved.memberPanelOpen !== false;
  state.voiceSelection = savedVoiceRoom;
  state.replySupport = false;
  state.deliverySupport = false;
  state.cleanupSupport = false;
  let worldHistoryReset = saved.worldHistoryReset && Number.isFinite(saved.worldHistoryReset.through) && Array.isArray(saved.worldHistoryReset.ids) ? saved.worldHistoryReset : null;
  let worldHistoryInitialized = saved.worldHistoryInitialized === true || !!worldHistoryReset;
  const messageFollow = { room: null, pinned: true, generation: 0, adjusting: false, frame: null, anchor: null };
  let identityVersion = 0, modalGeneration = 0, modalOpener = null, pollingHasSnapshot = false, refreshDirectory = null;
  const save = () => {
    if (draftIdentity) { draftBooks[draftIdentity] = { ...drafts }; replyBooks[draftIdentity] = { ...replyDrafts }; }
    try {
      if (damagedSaved !== null) {
        localStorage.setItem(`${storageKey}.recovery.${Date.now()}`, damagedSaved);
        damagedSaved = null;
      }
      localStorage.setItem(storageKey, JSON.stringify({ guest: state.guest, active: state.active, view: state.view, memberPanelOpen: state.memberPanelOpen, followingRooms: state.followingRooms, drafts, draftIdentity, draftsByIdentity: draftBooks, replyDrafts, replyDraftsByIdentity: replyBooks, worldHistoryReset, worldHistoryInitialized }));
      state.storageAvailable = true; return true;
    } catch { state.storageAvailable = false; return false; }
  };
  function chooseDrafts(profile) {
    const next = profile ? `user-${profile.id}` : `guest-${state.guest.id}`;
    if (draftIdentity && draftIdentity !== next) {
      draftBooks[draftIdentity] = { ...drafts };
      replyBooks[draftIdentity] = { ...replyDrafts };
      for (const key of Object.keys(drafts)) delete drafts[key];
      for (const key of Object.keys(replyDrafts)) delete replyDrafts[key];
      Object.assign(drafts, draftBooks[next] || {});
      Object.assign(replyDrafts, replyBooks[next] || {});
    }
    draftIdentity = next; draftsResolved = true; save(); restoreDraft();
  }
  function unreadBadge(channel) {
    const count = state.unread[channel] || 0;
    return count ? `<em class="unread-badge" aria-label="${count} unread messages">${count > 99 ? "99+" : count}</em>` : "";
  }
  const scrollBehavior = () => window.matchMedia?.("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth";
  function visibleMessages(channel, items = state.messages[channel] || []) {
    if (channel !== "global" || !worldHistoryReset) return items;
    const ids = new Set(worldHistoryReset.ids);
    return items.filter(item => item.pending || item.failed || (!ids.has(item.id) && !(Date.parse(item.createdAt) < worldHistoryReset.through)));
  }
  function renderWorldHistory() {
    $("#worldHistoryBar").classList.toggle("hidden", state.active !== "global");
    $("#worldHistoryStatus").textContent = worldHistoryReset ? `Earlier texts hidden in this ${state.storageAvailable === false ? "tab" : "browser"}. New messages appear here.` : "History view · Only in this browser";
    $("#worldHistoryToggle").textContent = worldHistoryReset ? "Restore history" : "Hide earlier texts";
    $("#worldHistoryToggle").disabled = !worldHistoryReset && (state.loading || loadingChannels.has("global") || !(state.messages.global || []).some(item => !item.pending && !item.failed));
  }
  function initializeWorldHistory(channel, items) {
    if (channel !== "global" || worldHistoryInitialized) return;
    worldHistoryInitialized = true;
    const earlier = items.filter(item => !item.pending && !item.failed);
    if (earlier.length) worldHistoryReset = { through: Math.max(0, ...earlier.map(item => Date.parse(item.createdAt) || 0)), ids: earlier.map(item => item.id), hiddenAt: new Date().toISOString() };
    save();
  }
  function hideWorldHistory() {
    if (state.active !== "global" || state.loading || loadingChannels.has("global")) return;
    const items = (state.messages.global || []).filter(item => !item.pending && !item.failed);
    if (!items.length) return;
    worldHistoryInitialized = true;
    worldHistoryReset = { through: Math.max(0, ...items.map(item => Date.parse(item.createdAt) || 0)), ids: items.map(item => item.id), hiddenAt: new Date().toISOString() };
    save(); renderMessages({ scrollToBottom: true });
    toast(`Earlier World texts hidden in this ${state.storageAvailable === false ? "tab" : "browser"}. Restore them anytime.`);
  }
  function restoreWorldHistory() { worldHistoryInitialized = true; worldHistoryReset = null; save(); renderMessages({ scrollToBottom: true }); toast("The World's history is visible again in this browser."); }
  function captureReadingAnchor() {
    const feed = $("#messages"), edge = feed.getBoundingClientRect?.().top;
    const article = [...(feed.querySelectorAll?.("[data-message-id]") || [])].find(item => item.getBoundingClientRect().bottom > edge);
    return { id: article?.dataset.messageId, offset: article ? article.getBoundingClientRect().top - edge : 0, top: feed.scrollTop };
  }
  function restoreReadingAnchor(anchor) {
    if (!anchor) return;
    const feed = $("#messages"), article = anchor.id && [...(feed.querySelectorAll?.("[data-message-id]") || [])].find(item => item.dataset.messageId === anchor.id);
    feed.scrollTop = article ? feed.scrollTop + article.getBoundingClientRect().top - feed.getBoundingClientRect().top - anchor.offset : anchor.top;
  }
  function updateJumpLatest() { $("#jumpLatest").classList.toggle("hidden", messageFollow.pinned || state.view !== "chat"); }
  function cancelBottomScroll() {
    messageFollow.generation++;
    if (messageFollow.frame !== null) cancelAnimationFrame(messageFollow.frame);
    messageFollow.frame = null; messageFollow.adjusting = false;
  }
  function pauseMessageFollow() {
    cancelBottomScroll(); messageFollow.pinned = false; messageFollow.anchor = captureReadingAnchor(); updateJumpLatest();
  }
  function scheduleBottomScroll() {
    if (!messageFollow.pinned || state.view !== "chat" || messageFollow.room !== state.active) return;
    cancelBottomScroll(); messageFollow.adjusting = true;
    const generation = messageFollow.generation, channel = state.active;
    const settle = remaining => {
      if (generation !== messageFollow.generation || !messageFollow.pinned || channel !== state.active || state.view !== "chat") return;
      const feed = $("#messages");
      feed.scrollTo({ top: Math.max(0, feed.scrollHeight - feed.clientHeight), behavior: "auto" });
      if (remaining) messageFollow.frame = requestAnimationFrame(() => settle(remaining - 1));
      else { messageFollow.frame = null; messageFollow.adjusting = false; }
    };
    settle(2);
  }
  function scrollToLatest(force = true) {
    if (force) { messageFollow.pinned = true; messageFollow.anchor = null; }
    updateJumpLatest(); scheduleBottomScroll();
  }
  function enterMessageRoom(id) { cancelBottomScroll(); messageFollow.room = id; messageFollow.pinned = true; messageFollow.anchor = null; updateJumpLatest(); }
  function handleFeedScroll() {
    if (messageFollow.adjusting || state.view !== "chat") return;
    const feed = $("#messages"), atBottom = feed.scrollHeight - feed.clientHeight - feed.scrollTop <= 4;
    if (atBottom) scrollToLatest();
    else { messageFollow.pinned = false; messageFollow.anchor = captureReadingAnchor(); updateJumpLatest(); }
  }
  function initMessageScrolling() {
    const feed = $("#messages");
    feed.addEventListener("scroll", handleFeedScroll, { passive: true });
    feed.addEventListener("wheel", event => { if (event.deltaY < 0) pauseMessageFollow(); }, { passive: true });
    let touchY = 0;
    feed.addEventListener("touchstart", event => { touchY = event.touches[0]?.clientY || 0; }, { passive: true });
    feed.addEventListener("touchmove", event => { if ((event.touches[0]?.clientY || 0) > touchY) pauseMessageFollow(); }, { passive: true });
    feed.addEventListener("pointerdown", event => { if (event.target === feed) pauseMessageFollow(); }, { passive: true });
    feed.addEventListener("keydown", event => {
      if (["ArrowUp", "PageUp", "Home"].includes(event.key) || (event.key === " " && event.shiftKey)) pauseMessageFollow();
      if (event.key === "End" && !event.shiftKey) { event.preventDefault(); scrollToLatest(); }
    });
    const layoutChanged = () => { if (messageFollow.pinned) scheduleBottomScroll(); else restoreReadingAnchor(messageFollow.anchor); };
    if (typeof ResizeObserver !== "undefined") { const observer = new ResizeObserver(layoutChanged); observer.observe(feed); observer.observe($("#messageList")); }
    feed.addEventListener("load", layoutChanged, true);
    document.fonts?.ready.then(layoutChanged);
    document.fonts?.addEventListener("loadingdone", layoutChanged);
    window.addEventListener("resize", layoutChanged);
    $("#jumpLatest").onclick = () => scrollToLatest();
    $("#worldHistoryToggle").onclick = () => worldHistoryReset ? restoreWorldHistory() : hideWorldHistory();
  }
  function updateComposer() {
    const input = $("#messageInput");
    $("#charCount").textContent = input.value.length;
    input.style.height = "auto"; input.style.height = `${Math.min(input.scrollHeight, 130)}px`;
    const tooLong = input.value.trim().length > 700;
    const replyWaiting = draftsResolved && !!replySnapshot(replyDrafts[state.active]) && !state.replySupport;
    $("#draftHint").textContent = tooLong ? "Use 700 characters or fewer to send." : replyWaiting ? "Replies are updating. Cancel the reply to send a regular message." : input.value ? state.storageAvailable === false ? "Draft kept in this tab" : "Draft saved on this device" : "";
    $("#sendButton").disabled = !state.connected || !input.value.trim() || tooLong || replyWaiting;
    renderReplyPreview();
  }
  function replySnapshot(value) {
    if (!value || typeof value.id !== "string" || !/^[\w-]{1,100}$/.test(value.id) || typeof value.text !== "string") return null;
    return { id: value.id, user: String(value.user || "Guest").slice(0, 32), text: value.text.slice(0, 180) };
  }
  function renderReplyPreview() {
    const reply = draftsResolved ? replySnapshot(replyDrafts[state.active]) : null;
    $("#replyPreview").classList.toggle("hidden", !reply);
    $("#replyUser").textContent = reply?.user || ""; $("#replyText").textContent = reply?.text || "";
    $("#messageInput").setAttribute("aria-describedby", reply ? "replyUser replyText" : "draftHint");
  }
  function startReply(id) {
    if (!state.replySupport) return toast("Quoted replies are not available on this server yet. You can still send regular messages.");
    const item = visibleMessages(state.active).find(message => message.id === id && !message.pending && !message.failed);
    const reply = replySnapshot(item); if (!reply) return;
    replyDrafts[state.active] = reply; save(); renderReplyPreview(); $("#messageInput").focus();
  }
  function cancelReply() { delete replyDrafts[state.active]; save(); updateComposer(); $("#messageInput").focus(); }
  function jumpToMessage(id) {
    const target = [...$("#messages").querySelectorAll("[data-message-id]")].find(item => item.dataset.messageId === id);
    if (!target) {
      if (state.active === "global" && (state.messages.global || []).some(item => item.id === id)) {
        toast("That message is in hidden history. Restore history to see it."); $("#worldHistoryToggle").focus();
      } else toast("The original is outside the loaded history. Its quote is saved here.");
      return;
    }
    pauseMessageFollow(); target.scrollIntoView({ block: "center", behavior: scrollBehavior() });
    target.classList.add("search-highlight"); setTimeout(() => target.classList.remove("search-highlight"), 1800);
  }
  function saveDraft() { const value = $("#messageInput").value; if (value) drafts[state.active] = value; else delete drafts[state.active]; save(); updateComposer(); }
  function restoreDraft() { $("#messageInput").value = typeof drafts[state.active] === "string" ? drafts[state.active].slice(0, 700) : ""; updateComposer(); }
  function clearTyping() { clearTimeout(typingTimer); clearTimeout(typingStopTimer); sendTyping(false); for (const [key, value] of typingPeers) if (key.endsWith(":timer")) clearTimeout(value); typingPeers.clear(); renderTyping(); }
  let deliveryToast = null;
  function toast(message, delivery = null) { const el = $("#toast"); deliveryToast = delivery ? { identity: identityVersion, message: delivery } : null; el.textContent = message; el.classList.add("show"); clearTimeout(toastTimer); toastTimer = setTimeout(() => { el.classList.remove("show"); deliveryToast = null; }, 3000); }
  async function api(path, options = {}) {
    const controller = typeof AbortController === "function" ? new AbortController() : null, method = (options.method || "GET").toUpperCase();
    const deadline = controller && setTimeout(() => controller.abort(), 15000);
    try {
      const response = await fetch(`${API_BASE}${path}`, { ...options, credentials: "include", headers: { "Content-Type": "application/json", ...(options.headers || {}) }, signal: controller?.signal });
      let data;
      try { data = await response.json(); }
      catch (error) { if (controller?.signal.aborted) throw error; throw new Error(response.ok ? "Chat returned an unreadable response. Please try again." : `Chat is unavailable (${response.status}). Please try again.`); }
      if (!data || typeof data !== "object" || Array.isArray(data)) throw new Error("Chat returned an unreadable response. Please try again.");
      if (!response.ok) { const error = new Error(typeof data.error === "string" ? data.error : `Request failed (${response.status}).`); error.status = response.status; throw error; }
      return data;
    } catch (error) {
      if (controller?.signal.aborted) {
        const timeout = new Error(method === "GET" ? "The connection took too long. Please try again." : "The request took too long to confirm. Check for changes before trying again.");
        timeout.code = "REQUEST_TIMEOUT"; timeout.uncertain = method !== "GET"; throw timeout;
      }
      if (error instanceof TypeError) { const network = new Error("Couldn’t reach chat. Check your connection and try again."); network.uncertain = method !== "GET"; throw network; }
      if (method !== "GET" && !error.status) error.uncertain = true;
      throw error;
    } finally { if (deadline) clearTimeout(deadline); }
  }
  function allRooms() { return [...defaultRooms, ...state.rooms, ...state.parties, ...state.servers.flatMap(server => server.channels.map(channel => ({ ...channel, serverId: server.id, serverName: server.name, emoji: channel.type === "voice" ? "◖" : "#", topic: server.description || `A channel in ${server.name}.` })))]; }
  function room(id) { return allRooms().find(x => x.id === id) || { id, name: "Party", emoji: "✦", topic: "A private room for good people." }; }
  function canManageParty(item = room(state.active)) { return !!(state.cleanupSupport && state.profile && item.type === "party" && item.ownerId === state.profile.id); }
  function setConnected(value, label) {
    state.connected = value; $("#connectionLabel").textContent = label || (value ? "Connected" : "Reconnecting…");
    $("#connectionLabel").classList.toggle("offline", !value); updateComposer(); renderVoice();
    $("#connectionBanner").classList.toggle("hidden", value);
    $("#connectionBanner").classList.toggle("is-loading", state.loading);
    $("#connectionMessage").textContent = state.loading ? "Finding your conversations…" : state.storageAvailable === false ? "Chat is reconnecting. You can keep writing; your draft stays in this tab." : "Chat is reconnecting. You can keep writing; your draft stays on this device.";
    $("#retryConnection").classList.toggle("hidden", state.loading);
  }
  function renderRoomList() {
    const rooms = allRooms();
    const row = item => `<button class="space-row ${state.active === item.id ? "selected" : ""}" data-channel="${esc(item.id)}"><span style="--tile:${esc(item.color || "#6758ad")}">${esc(item.emoji || "✦")}</span><b>${esc(item.name)}</b>${unreadBadge(item.id)}</button>`;
    $("#spaceList").innerHTML = [...defaultRooms, ...state.rooms].map(row).join("");
    $("#partyList").innerHTML = state.parties.map(row).join("");
    $("#partySection").classList.toggle("hidden", !state.parties.length);
    const followed = rooms.filter(item => state.followingRooms.includes(item.id));
    $("#followingSection").classList.toggle("hidden", followed.length === 0);
    $("#followingList").innerHTML = followed.map(row).join("");
    $("#serverList").innerHTML = state.servers.map(server => { const isOwner = server.ownerId === state.profile?.id || server.ownerId === `guest-${state.guest.id}`; return `<section class="server-group"><div class="server-heading"><span>${esc(server.emoji || "✳")} ${esc(server.name)}</span><div><button data-server-invite="${esc(server.id)}" title="Invite to ${esc(server.name)}">↗</button>${isOwner ? `<button data-add-channel="${esc(server.id)}" title="Add channel">＋</button>` : ""}</div></div>${(server.channels || []).map(channel => `<button class="space-row server-channel ${state.active === channel.id ? "selected" : ""}" data-channel="${esc(channel.id)}"><span class="channel-type-icon">${channel.type === "voice" ? "◖" : "#"}</span><b>${esc(channel.name)}</b>${unreadBadge(channel.id)}</button>`).join("")}</section>`; }).join("") || `<div class="server-empty">Make a server to gather your people and add text or voice channels.</div>`;
    renderVoiceRooms();
    const unread = [...new Set(rooms.map(item => item.id))].reduce((total, id) => total + (state.unread[id] || 0), 0);
    for (const [buttonId, badgeId] of [["#roomsButton", "#roomDirectoryBadge"], ["#phoneRooms", "#phoneRoomBadge"]]) {
      const badge = $(badgeId);
      badge.textContent = unread > 99 ? "99+" : unread || "";
      badge.classList.toggle("hidden", !unread);
      $(buttonId).setAttribute("aria-label", unread ? `Rooms, ${unread} unread ${unread === 1 ? "message" : "messages"}` : "Rooms");
    }
    refreshDirectory?.();
  }
  function setMemberPanel(open, remember = true) {
    state.memberPanelOpen = open;
    $("#chatView").classList.toggle("members-collapsed", !open);
    const button = $("#desktopMembers");
    const label = open ? "Hide members" : "Show members";
    button.setAttribute("aria-expanded", String(open));
    button.setAttribute("aria-label", label);
    button.title = label;
    if (remember) save();
  }
  function renderMembers(filter = $("#memberSearch").value.toLowerCase()) {
    const members = state.members.filter(item => item.name.toLowerCase().includes(filter));
    $("#onlineCount").textContent = state.members.length; $("#activeMemberCount").textContent = members.length; $("#registeredCount").textContent = state.registered.toLocaleString(); $("#goalCount").textContent = state.registered.toLocaleString();
    $("#goalFill").style.width = `${Math.min(100, state.registered / state.goal * 100)}%`;
    const row = item => `<div class="member-row"><span class="avatar">${esc(item.emoji || "✦")}</span><span><b>${esc(item.name)}${item.id === `guest-${state.guest.id}` ? " <small>(you)</small>" : ""}</b><small>${esc(item.about || (item.registered ? "Registered member" : "Guest"))}</small></span><i class="${esc(item.status || "online")}" title="${esc(item.status || "online")}"></i></div>`;
    $("#memberList").innerHTML = members.length ? members.map(row).join("") : `<div class="empty-state">${state.connected ? "You're here first. Say hello." : "Connecting to the chat…"}</div>`;
    $("#peopleList").innerHTML = members.length ? members.map(item => `<div class="person-card"><span class="avatar">${esc(item.emoji || "✦")}</span><b>${esc(item.name)}</b><small>${item.registered ? "Member" : "Guest"}</small></div>`).join("") : `<div class="empty-state">Invite someone to join you.</div>`;
  }
  function renderMessageActions(item) {
    if (item.pending) return '<span class="message-delivery">Sending…</span>';
    if (item.failed) {
      const retry = `<button type="button" class="retry-message" data-retry-message="${esc(item.id)}">Try again</button>`;
      const sendPlain = replySnapshot(item.replyTo) ? `<button type="button" class="retry-message" data-retry-plain="${esc(item.id)}">Send without reply</button>` : "";
      return `<span class="message-delivery failed">${item.uncertain ? "Delivery unconfirmed" : "Not sent"}</span>${retry}${sendPlain}`;
    }
    const who = state.profile ? `user-${state.profile.id}` : `guest-${state.guest.id}`;
    const busy = reactionRequests.has(reactionRequestKey(state.active, item.id));
    const reactions = Object.entries(item.reactions || {}).filter(([, list]) => Array.isArray(list) && list.length).map(([emoji, list]) => {
      const mine = list.some(person => person?.id === who), label = emojiChoices.find(choice => choice[0] === emoji)?.[1] || emoji;
      const people = list.slice(0, 8).map(person => person?.id === who ? "You" : person?.name || "Someone").join(", ");
      return `<button type="button" class="reaction ${mine ? "is-mine" : ""}" data-react="${esc(item.id)}" data-emoji="${esc(emoji)}" data-action-key="reaction:${esc(emoji)}" aria-pressed="${mine}" aria-label="${esc(label)}: ${list.length} ${list.length === 1 ? "reaction" : "reactions"}. ${mine ? "Remove your reaction" : "Add your reaction"}" title="${esc(people)}${list.length > 8 ? ` and ${list.length - 8} more` : ""}" ${busy ? 'aria-disabled="true"' : ""}>${esc(emoji)} <span>${list.length}</span></button>`;
    }).join("");
    const picker = `<button type="button" class="message-tool" data-reaction-picker="${esc(item.id)}" data-action-key="react" aria-label="Choose a reaction" aria-haspopup="dialog" ${busy ? 'aria-disabled="true"' : ""}>☺ <span>React</span></button>`;
    const reply = state.replySupport ? `<button type="button" class="message-tool" data-reply="${esc(item.id)}" data-action-key="reply">↩ Reply</button>` : "";
    const copy = `<button type="button" class="message-tool" data-copy-message="${esc(item.id)}" data-action-key="copy" aria-label="Copy message text">⧉ <span>Copy</span></button>`;
    return reactions + picker + reply + copy;
  }
  function renderMessage(item, actions = renderMessageActions(item)) {
    const stamp = new Date(item.createdAt ?? NaN), reply = replySnapshot(item.replyTo);
    const time = Number.isFinite(stamp.getTime()) ? `<time datetime="${stamp.toISOString()}" title="${esc(stamp.toLocaleString())}">${esc(messageTime.format(stamp))}</time>` : "";
    const quote = reply ? `<button type="button" class="message-quote" data-jump-reply="${esc(reply.id)}" aria-label="Go to original message from ${esc(reply.user)}"><span aria-hidden="true">↩</span><b>${esc(reply.user)}</b><span class="quote-text">${esc(reply.text)}</span></button>` : "";
    return `<article class="message ${item.failed ? "message-failed" : ""}" data-message-id="${esc(item.id)}"><span class="avatar">${esc(item.emoji || "✦")}</span><div class="message-body"><div class="message-meta"><b>${esc(item.user || "Guest")}</b>${item.registered ? "<i>member</i>" : ""}${time}</div>${quote}<p>${formatMessageText(item.text)}</p><div class="message-actions">${actions}</div></div></article>`;
  }
  function replaceMessageActions(node, html) {
    const actions = node.querySelector(".message-actions");
    const actionKey = button => button && actions.contains(button) ? button.dataset.actionKey : "";
    const focused = actionKey(document.activeElement), opener = actionKey(modalOpener);
    actions.innerHTML = html;
    if (!focused && !opener) return;
    const buttons = [...actions.querySelectorAll("[data-action-key]")];
    const findButton = key => buttons.find(button => button.dataset.actionKey === key)
      || buttons.find(button => button.dataset.actionKey === "react");
    if (opener) modalOpener = findButton(opener);
    if (focused) (findButton(focused) || $("#messages")).focus({ preventScroll: true });
  }
  // Keep existing rows mounted so a delivery event cannot interrupt reading or tapping an older message.
  function syncMessageList(list, rows) {
    if (messageListRoom !== state.active || messageListIdentity !== identityVersion) {
      list.replaceChildren(); messageRows.clear();
      messageListRoom = state.active; messageListIdentity = identityVersion;
    }
    const keep = new Set(rows.map(row => row.key));
    for (const [key, row] of messageRows) {
      if (keep.has(key)) continue;
      row.node.remove(); messageRows.delete(key);
    }
    let cursor = list.firstElementChild;
    for (const row of rows) {
      const previous = messageRows.get(row.key);
      let node = previous?.node;
      if (!node || previous.html !== row.html) {
        const template = document.createElement("template");
        template.innerHTML = row.html;
        const replacement = template.content.firstElementChild;
        if (node && node === cursor) cursor = replacement;
        node?.replaceWith(replacement);
        node = replacement;
        if (row.actions !== undefined) node.querySelector(".message-actions").innerHTML = row.actions;
      } else if (previous.actions !== row.actions) {
        replaceMessageActions(node, row.actions);
      }
      if (node !== cursor) list.insertBefore(node, cursor);
      cursor = node.nextElementSibling;
      messageRows.set(row.key, { ...row, node });
    }
  }
  function renderMessages({ scrollToBottom = false } = {}) {
    const current = room(state.active), rawItems = state.messages[state.active] || [], items = visibleMessages(state.active, rawItems);
    $("#manageParty").classList.toggle("hidden", !canManageParty(current));
    const feed = $("#messages"), list = $("#messageList");
    if (messageFollow.room !== state.active) enterMessageRoom(state.active);
    const anchor = !scrollToBottom && !messageFollow.pinned ? captureReadingAnchor() : null;
    messageFollow.adjusting = true;
    const finish = () => {
      if (scrollToBottom || messageFollow.pinned) scrollToLatest(scrollToBottom);
      else { restoreReadingAnchor(anchor); messageFollow.anchor = anchor; messageFollow.adjusting = false; updateJumpLatest(); }
    };
    const channelInfo = info[state.active] || [current.name, current.topic || "Come in and say hello.", current.emoji || "✦", current.topic || "A friendly space for good conversation."];
    renderHeader(); $("#topicText").textContent = channelInfo[3];
    const isFollowing = state.followingRooms.includes(state.active);
    $("#followButton").textContent = isFollowing ? "✓ Following" : "✧ Follow";
    $("#followButton").classList.toggle("following", isFollowing);
    $("#followButton").setAttribute("aria-pressed", String(isFollowing));
    $("#musicPanel").classList.toggle("hidden", state.active !== "music");
    renderWorldHistory();
    if (!rawItems.length && (state.loading || loadingChannels.has(state.active))) {
      feed.setAttribute("aria-busy", "true");
      syncMessageList(list, [{ key: "loading", html: '<div class="conversation-loading" role="status"><span class="loading-orbit" aria-hidden="true">◌</span><b>Finding your conversations…</b><div class="skeleton-message"></div><div class="skeleton-message short"></div><div class="skeleton-message"></div></div>' }]);
      finish(); return;
    }
    feed.setAttribute("aria-busy", "false");
    if (!rawItems.length && state.channelErrors[state.active]) {
      syncMessageList(list, [{ key: "offline", html: `<div class="offline-card"><img src="assets/turbochat-mark.svg" alt="" width="60" height="60"><h2>Couldn’t load this room</h2><p>${state.storageAvailable === false ? "Keep this tab open to keep your draft." : "Your draft stays on this device while you reconnect."}</p><p class="connection-detail">${esc(state.channelErrors[state.active])}</p><button data-retry-channel>Try this room again ↻</button></div>` }]);
      finish(); return;
    }
    const rows = [];
    if (!items.length) {
      const hiddenHistory = state.active === "global" && worldHistoryReset;
      const heading = hiddenHistory ? "You’re starting with a fresh view." : `Start the conversation in ${channelInfo[0]}.`;
      rows.push({ key: "empty", html: `<div class="welcome-card"><span aria-hidden="true">${esc(channelInfo[2])}</span><div><h2>${esc(heading)}</h2>${hiddenHistory ? "" : `<p>${esc(channelInfo[3])}</p>`}<div class="empty-actions"><button class="primary-action" data-compose>${hiddenHistory ? "Write a hello" : "Write the first hello"}</button><button class="text-action" data-search-open>Find another room</button></div></div></div>` });
    }
    let previousDay = "";
    for (const item of items) {
      const date = new Date(item.createdAt ?? NaN);
      if (Number.isFinite(date.getTime())) {
        const day = date.toDateString();
        if (day !== previousDay) rows.push({ key: `date:${day}`, html: `<div class="day-label">${esc(messageDay.format(date))}</div>` });
        previousDay = day;
      }
      rows.push({ key: `message:${item.id}`, html: renderMessage(item, ""), actions: renderMessageActions(item) });
    }
    syncMessageList(list, rows);
    finish();
    renderVoice();
  }
  function sameDelivery(first, second) {
    return !!first.clientMessageId && first.clientMessageId === second.clientMessageId && first.text === second.text &&
      (first.replyTo?.id || "") === (second.replyTo?.id || "") && (first.userId || "") === (second.userId || "") && !!first.registered === !!second.registered;
  }
  function messageOrder(first, second) {
    const a = Date.parse(first.createdAt), b = Date.parse(second.createdAt);
    return (a || 0) - (b || 0) || (Number.isFinite(a) && Number.isFinite(b) ? first.id.localeCompare(second.id) : 0);
  }
  function mergeMessages(channel, incoming) {
    const existing = state.messages[channel] || [];
    const delivered = (incoming || []).filter(item => !item.pending && !item.failed && item.clientMessageId);
    if (deliveryToast?.identity === identityVersion && delivered.some(item => sameDelivery(deliveryToast.message, item))) {
      clearTimeout(toastTimer); $("#toast").textContent = ""; $("#toast").classList.remove("show"); deliveryToast = null;
    }
    const retained = existing.filter(item => !(item.pending || item.failed) || !delivered.some(confirmed => sameDelivery(item, confirmed)));
    const byId = new Map(retained.map(item => [item.id, item]));
    for (const item of incoming || []) {
      const previous = byId.get(item.id);
      byId.set(item.id, previous ? { ...previous, ...item, reactions: item.reactions ?? previous.reactions } : item);
    }
    const merged = [...byId.values()].sort(messageOrder).slice(-250);
    const changed = merged.length !== existing.length || merged.some((item, i) => item.id !== existing[i]?.id || JSON.stringify(item.reactions || {}) !== JSON.stringify(existing[i]?.reactions || {}) || item.pending !== existing[i]?.pending);
    state.messages[channel] = merged;
    return changed;
  }
  function addMessage(channel, item, notifyUnread = true) {
    const existing = state.messages[channel] || [], isNew = !existing.some(message => message.id === item.id);
    const ownMessage = (item.userId && item.userId === state.profile?.id) || existing.some(message => ((message.pending || message.failed) && sameDelivery(message, item)) || (message.pending && message.user === item.user && message.text === item.text));
    const changed = mergeMessages(channel, [item]);
    if (notifyUnread && isNew && !ownMessage && (state.active !== channel || state.view !== "chat")) { state.unread[channel] = (state.unread[channel] || 0) + 1; renderRoomList(); }
    if (changed && state.active === channel) renderMessages();
  }
  function toggleFollow(id = state.active) {
    const item = allRooms().find(room => room.id === id && room.type !== "voice");
    if (!item) return;
    const index = state.followingRooms.indexOf(id);
    if (index < 0) {
      state.followingRooms.push(id);
      toast(`Following ${item.name}.`);
    } else {
      state.followingRooms.splice(index, 1);
      toast(`Unfollowed ${item.name}.`);
    }
    save(); renderRoomList();
    if (id === state.active) renderMessages();
  }
  async function loadChannel(id) {
    const version = identityVersion;
    loadingChannels.add(id); delete state.channelErrors[id]; if (state.active === id) renderMessages();
    try { const data = await api(`/api/messages?channel=${encodeURIComponent(id)}&guestId=${encodeURIComponent(state.guest.id)}`); if (version === identityVersion) { mergeMessages(id, data.messages || []); initializeWorldHistory(id, data.messages || []); } }
    catch (error) { if (version === identityVersion) state.channelErrors[id] = error.message; }
    finally { loadingChannels.delete(id); if (version === identityVersion && state.active === id) renderMessages(); }
  }
  async function bootstrap() {
    let data, channel = state.active; const version = identityVersion;
    try { data = await api(`/api/bootstrap?channel=${encodeURIComponent(channel)}&guestId=${encodeURIComponent(state.guest.id)}`); }
    catch (error) {
      if (version !== identityVersion) return;
      if (channel === "global" || ![403, 404].includes(error.status)) throw error;
      if (state.active === channel) state.active = "global"; channel = "global"; save(); toast("That saved room is no longer available. You’re back in World chat.");
      data = await api(`/api/bootstrap?channel=global&guestId=${encodeURIComponent(state.guest.id)}`);
    }
    if (version !== identityVersion) return;
    state.loading = false; delete state.channelErrors[channel]; initializeWorldHistory(channel, data.messages || []);
    state.rooms = data.rooms || []; state.parties = data.parties || []; state.servers = [...new Map((data.servers || []).map(server => [server.id, server])).values()]; mergeMessages(channel, data.messages || []); state.members = data.members || []; state.registered = Number(data.registeredCount) || 1428; state.goal = Number(data.memberGoal) || 1500; state.replySupport = data.features?.messageReplies === true; state.deliverySupport = data.features?.messageDeliveryIds === true; state.cleanupSupport = data.features?.safeSelfCleanup === true; renderRoomList(); renderMessages(); renderMembers(); updateMusic(data.music || null); restoreDraft();
  }
  function connectLive() {
    state.stream?.close();
    if (usePolling) { pollingHasSnapshot = false; clearInterval(pollTimer); pollUpdates(); pollTimer = setInterval(pollUpdates, 1200); return; }
    const query = new URLSearchParams({ guestId: state.guest.id, name: name(), peerId: state.peerId });
    const stream = new EventSource(`${API_BASE}/api/events?${query}`, { withCredentials: true }); state.stream = stream;
    stream.onopen = () => { clearTimeout(reconnectTimer); setConnected(true, "Live"); };
    stream.onerror = () => { setConnected(false, "Reconnecting…"); if (state.voiceRoom || state.joiningVoice) leaveVoice(true); };
    stream.addEventListener("update", event => { let data; try { data = JSON.parse(event.data); } catch { return; } receiveLiveEvent(data); });
  }
  function receiveLiveEvent(data, notifyUnread = true) {
      if (data.type === "message") addMessage(data.channel, data.message, notifyUnread);
      if (data.type === "typing" && data.channel === state.active && data.id !== `guest-${state.guest.id}` && data.id !== `user-${state.profile?.id}`) { typingPeers.set(data.id, data.name); renderTyping(); clearTimeout(typingPeers.get(`${data.id}:timer`)); typingPeers.set(`${data.id}:timer`, setTimeout(() => { typingPeers.delete(data.id); renderTyping(); }, 2800)); }
      if (data.type === "typing-stop") { const timer = typingPeers.get(`${data.id}:timer`); if (timer) clearTimeout(timer); typingPeers.delete(data.id); typingPeers.delete(`${data.id}:timer`); if (data.channel === state.active) renderTyping(); }
      if (data.type === "reaction") {
        const item = (state.messages[data.channel] || []).find(message => message.id === data.messageId);
        if (item && JSON.stringify(item.reactions || {}) !== JSON.stringify(data.reactions || {})) {
          item.reactions = data.reactions;
          if (state.active === data.channel) renderMessages();
        }
      }
      if (data.type === "presence") { state.members = data.members || []; state.registered = Number(data.registeredCount) || 1428; renderMembers(); }
      if (data.type === "room" && data.room?.type !== "party" && !state.rooms.some(r => r.id === data.room.id)) { state.rooms.unshift(data.room); renderRoomList(); }
      if (data.type === "server" && data.server) { const index = state.servers.findIndex(server => server.id === data.server.id); if (index < 0) state.servers.unshift(data.server); else state.servers[index] = data.server; renderRoomList(); }
      if (data.type === "music") updateMusic(data.track);
      if (data.type === "voice" && data.room === (state.voiceRoom || state.joiningVoice)) {
        state.voiceMembers = data.participants || []; renderVoice();
        const generation = voiceConnectionGeneration;
        if (usePolling && state.voiceRoom) connectToVoiceMembers(state.voiceMembers).catch(error => {
          if (generation !== voiceConnectionGeneration) return;
          state.voiceError = error.message; renderVoice();
        });
      }
      if (data.type === "signal" && data.room === state.voiceRoom && data.to === state.peerId) {
        if ((blockedVoicePeers.get(data.from) || 0) > Date.now()) return;
        const generation = voiceConnectionGeneration;
        handleVoiceSignal(data).catch(error => {
          if (generation !== voiceConnectionGeneration) return;
          if (error.status === 409) { dropVoicePeer(data.from); return; }
          state.voiceError = error.message; renderVoice();
        });
      }
  }
  async function pollUpdates() {
    if (polling) return; polling = true;
    const version = identityVersion;
    try {
      if (Date.now() - lastHeartbeat > 10000) { await api("/api/presence", { method: "POST", body: JSON.stringify({ guestId: state.guest.id, guestName: name() }) }); lastHeartbeat = Date.now(); }
      const result = await api(`/api/updates?after=${lastEventSeq}&guestId=${encodeURIComponent(state.guest.id)}&peerId=${encodeURIComponent(state.peerId)}`);
      if (version !== identityVersion) return;
      for (const event of result.events || []) receiveLiveEvent(event, pollingHasSnapshot);
      pollingHasSnapshot = true;
      if (state.voiceRoom) await refreshVoicePresence();
      if (version !== identityVersion) return;
      const presenceChanged = JSON.stringify(state.members) !== JSON.stringify(result.members || []);
      state.members = result.members || []; state.registered = Number(result.registeredCount) || state.registered; if (presenceChanged) renderMembers();
      if (Date.now() - lastMessageSync > 4500) {
        const channel = state.active;
        const latest = await api(`/api/messages?channel=${encodeURIComponent(channel)}&guestId=${encodeURIComponent(state.guest.id)}`);
        if (version !== identityVersion) return;
        if (mergeMessages(channel, latest.messages || []) && state.active === channel) renderMessages();
        lastMessageSync = Date.now();
      }
      lastEventSeq = Math.max(lastEventSeq, Number(result.nextSeq) || 0); setConnected(true, "Live");
    } catch { if (version === identityVersion) setConnected(false, "Reconnecting…"); } finally { polling = false; }
  }
  function renderTyping() { const names = [...typingPeers.entries()].filter(([key]) => !key.endsWith(":timer")).map(([, value]) => value); $("#typingIndicator").textContent = names.length ? `${names.slice(0, 2).join(", ")}${names.length > 2 ? ` and ${names.length - 2} others` : names.length === 1 ? " is" : " are"} typing…` : ""; }
  function sendTyping(typing) { if (localTyping === typing) return; localTyping = typing; api("/api/typing", { method: "POST", body: JSON.stringify({ channel: state.active, typing, guestId: state.guest.id, guestName: name() }) }).catch(() => {}); }
  async function sendMessage(value, retryId = "", withoutReply = false) {
    const content = value.trim(); if (!content || !state.connected) return;
    if (content.length > 700) return toast("Use 700 characters or fewer to send.");
    const channel = state.active, version = identityVersion;
    const retry = retryId && (state.messages[channel] || []).find(item => item.id === retryId);
    if (retryId && !retry?.failed) return;
    const reply = withoutReply ? null : replySnapshot(retryId ? retry?.replyTo : replyDrafts[channel]);
    const clientMessageId = retryId && !withoutReply ? retry.clientMessageId : state.deliverySupport ? crypto.randomUUID() : "";
    if (reply && !state.replySupport) return toast("Replies are updating. Cancel the reply or use Send without reply.");
    if (retryId) state.messages[channel] = (state.messages[channel] || []).filter(item => item.id !== retryId);
    else { $("#messageInput").value = ""; delete replyDrafts[channel]; saveDraft(); }
    clearTyping();
    const tempId = `pending-${crypto.randomUUID()}`, pending = { id: tempId, user: name(), userId: state.profile?.id || "", registered: !!state.profile, emoji: state.profile?.emoji || "✦", text: content, createdAt: new Date().toISOString(), reactions: {}, pending: true, ...(clientMessageId ? { clientMessageId } : {}), ...(reply ? { replyTo: reply } : {}) };
    mergeMessages(channel, [pending]); if (state.active === channel) renderMessages({ scrollToBottom: true });
    try { const result = await api("/api/messages", { method: "POST", body: JSON.stringify({ channel, text: content, guestId: state.guest.id, guestName: name(), ...(clientMessageId ? { clientMessageId } : {}), ...(reply ? { replyTo: reply.id } : {}) }) }); if (version !== identityVersion) return; state.messages[channel] = (state.messages[channel] || []).filter(item => item.id !== tempId); mergeMessages(channel, [result.message]); if (state.active === channel) renderMessages(); }
    catch (error) { if (version !== identityVersion) return; const item = (state.messages[channel] || []).find(item => item.id === tempId); if (!item && (state.messages[channel] || []).some(confirmed => !confirmed.pending && !confirmed.failed && sameDelivery(pending, confirmed))) return; if (item) { item.pending = false; item.failed = true; item.uncertain = error.uncertain === true; } if (state.active === channel) renderMessages(); toast(error.uncertain ? `${error.message} Your text is kept above. Check the conversation before using Try again.` : `${error.message} Your message is kept above. Use Try again to resend.`, pending); }
  }
  async function selectChannel(id) {
    const channel = allRooms().find(item => item.id === id);
    if (!channel) return;
    if (channel.type === "voice") return selectVoiceRoom(id);
    if (id === state.active && state.view === "chat") return loadChannel(id);
    saveDraft(); clearTyping();
    state.active = id; enterMessageRoom(id); save(); restoreDraft(); renderRoomList();
    setView("chat"); renderMessages(); await loadChannel(id);
  }
  function modal(title, subtitle, body, focusSelector) {
    modalGeneration++;
    refreshDirectory = null;
    if (!$("#modalRoot").childElementCount) modalOpener = document.activeElement;
    $("#modalRoot").innerHTML = `<div class="modal-backdrop"><section class="modal" role="dialog" aria-modal="true" aria-labelledby="modalTitle" aria-describedby="modalDescription"><div class="modal-header"><div class="modal-brand"><img src="assets/turbochat-mark.svg" alt="" width="30" height="30"><span>TurboChat</span></div><button class="modal-close" data-close aria-label="Close dialog">×</button></div><div class="modal-content"><h2 id="modalTitle">${esc(title)}</h2><p id="modalDescription">${esc(subtitle)}</p>${body}</div></section></div>`;
    $(".app-shell").inert = true; $("#mobileVoice").inert = true;
    $("[data-close]").addEventListener("click", closeModal); $(".modal-backdrop").addEventListener("click", e => { if (e.target.classList.contains("modal-backdrop")) closeModal(); });
    ((focusSelector && $(focusSelector)) || $(".modal input:not([readonly])") || $(".modal button:not([data-close])") || $("[data-close]")).focus();
  }
  function closeModal() { if (accountBusy) return; modalGeneration++; refreshDirectory = null; $("#modalRoot").innerHTML = ""; $(".app-shell").inert = false; $("#mobileVoice").inert = false; if (modalOpener?.isConnected) modalOpener.focus(); modalOpener = null; }
  function openRoomDirectory() {
    if (accountBusy) return;
    const filters = [["all", "All rooms"], ["unread", "Unread"], ["following", "Following"]];
    modal("Rooms", "Open a conversation or a voice room.", `
      <div class="room-directory">
        <div class="directory-toolbar">
          <input id="roomDirectorySearch" type="search" aria-label="Filter rooms and servers" placeholder="Search rooms and servers" autocomplete="off">
          <button type="button" id="directoryCreate" class="directory-create">＋ Create</button>
        </div>
        <div id="roomDirectoryFilters" class="directory-filters" role="group" aria-label="Show rooms">
          ${filters.map(([id, label]) => `<button type="button" class="directory-filter" data-directory-filter="${id}" aria-pressed="${id === "all"}">${label}</button>`).join("")}
        </div>
        <p id="roomDirectoryStatus" class="directory-status" role="status"></p>
        <div id="roomDirectoryResults"></div>
      </div>`,
    window.matchMedia?.("(max-width: 760px)").matches ? '[data-directory-filter="all"]' : "#roomDirectorySearch");

    const input = $("#roomDirectorySearch"), results = $("#roomDirectoryResults"), buttons = $("#roomDirectoryFilters");
    let mode = "all", previousMarkup = "", matches = [];
    const render = () => {
      const term = input.value.trim().toLowerCase();
      const available = [...new Map(allRooms().map(item => [item.id, item])).values()];
      matches = available.filter(item => {
        if (mode === "unread" && !state.unread[item.id]) return false;
        if (mode === "following" && !state.followingRooms.includes(item.id)) return false;
        return !term || [item.name, item.serverName, item.topic].some(value => String(value || "").toLowerCase().includes(term));
      });
      for (const button of buttons.querySelectorAll("[data-directory-filter]")) {
        const selected = button.dataset.directoryFilter === mode;
        button.classList.toggle("active", selected);
        button.setAttribute("aria-pressed", String(selected));
      }
      const groups = new Map();
      for (const item of matches) {
        const key = item.serverId ? `server:${item.serverId}` : item.type === "party" ? "parties" : "public";
        if (!groups.has(key)) groups.set(key, []);
        groups.get(key).push(item);
      }
      const section = (key, items) => {
        const server = state.servers.find(server => `server:${server.id}` === key);
        const heading = server?.name || (key === "parties" ? "Private parties" : "Public rooms");
        const owned = server && [state.profile?.id, `guest-${state.guest.id}`].includes(server.ownerId);
        const invite = server ? `<button type="button" data-server-invite="${esc(server.id)}" aria-label="Invite to ${esc(server.name)}">Invite</button>` : "";
        const create = owned ? `<button type="button" data-add-channel="${esc(server.id)}" aria-label="Add channel to ${esc(server.name)}">＋ Channel</button>` : "";
        return `<section class="directory-section"><div class="directory-heading"><h3>${esc(heading)}</h3><div class="directory-actions">${invite}${create}</div></div>${items.map(roomRow).join("")}</section>`;
      };
      const roomRow = item => {
        const voice = item.type === "voice";
        const current = voice ? state.view === "voice" && (state.voiceSelection || state.voiceRoom) === item.id : state.active === item.id;
        const following = state.followingRooms.includes(item.id);
        const details = voice ? "Voice" : item.type === "party" ? "Private chat" : item.serverId ? "Text channel" : "Public chat";
        const follow = voice ? "" : `<button type="button" class="directory-follow" data-directory-follow="${esc(item.id)}" aria-pressed="${following}" aria-label="Follow ${esc(item.name)}" title="${following ? "Unfollow" : "Follow"} ${esc(item.name)}">${following ? "★" : "☆"}</button>`;
        return `<div class="directory-entry"><button type="button" class="directory-row" data-directory-room="${esc(item.id)}"${current ? ' aria-current="true"' : ""}><span class="directory-glyph" aria-hidden="true">${esc(item.emoji || "#")}</span><span class="directory-name"><b>${esc(item.name)}</b><small class="directory-meta">${details}${following ? " · Following" : ""}</small></span>${unreadBadge(item.id)}<span class="directory-arrow" aria-hidden="true">›</span></button>${follow}</div>`;
      };
      const empty = term ? "No matching rooms." : mode === "unread" ? "You’re caught up." : "Star a room to add it to Following.";
      const markup = matches.length ? [...groups].map(([key, items]) => section(key, items)).join("") : `<p class="directory-empty">${empty}</p>`;
      if (markup !== previousMarkup) {
        const focused = document.activeElement;
        const focusedControl = Object.entries(focused?.dataset || {}).find(([key]) => key === "directoryRoom" || key === "directoryFollow");
        results.innerHTML = markup;
        previousMarkup = markup;
        if (focusedControl) {
          const [key, id] = focusedControl;
          const replacement = [...results.querySelectorAll("[data-directory-room], [data-directory-follow]")].find(button => button.dataset[key] === id);
          // When a room is unfollowed in the Following filter, keep the user in the results controls.
          (replacement || buttons.querySelector(".active") || input).focus({ preventScroll: true });
        }
      }
      const status = $("#roomDirectoryStatus");
      const count = `${matches.length} ${matches.length === 1 ? "room" : "rooms"}`;
      if (status.textContent !== count) status.textContent = count;
    };
    input.oninput = render;
    input.onkeydown = event => {
      if (event.key !== "Enter" || event.isComposing || matches.length !== 1) return;
      event.preventDefault(); openDirectoryRoom(matches[0].id);
    };
    buttons.onclick = event => {
      const next = event.target.closest("[data-directory-filter]")?.dataset.directoryFilter;
      if (!filters.some(([id]) => id === next)) return;
      mode = next; render();
    };
    $("#directoryCreate").onclick = createRoomMenu;
    refreshDirectory = render;
    render();
  }
  function openDirectoryRoom(id) {
    if (!allRooms().some(item => item.id === id)) return;
    closeModal();
    return selectChannel(id);
  }
  function insertComposerEmoji(emoji, selection) {
    if (!emojiChoices.some(choice => choice[0] === emoji) || selection.version !== identityVersion || selection.channel !== state.active || !draftsResolved) return false;
    const input = $("#messageInput"), start = Math.min(selection.start, input.value.length), end = Math.min(selection.end, input.value.length);
    const value = input.value.slice(0, start) + emoji + input.value.slice(end);
    if (value.length > 700) { toast("Make a little room first. Messages can be up to 700 characters."); return false; }
    input.value = value; saveDraft();
    closeModal(); input.focus(); input.setSelectionRange(start + emoji.length, start + emoji.length);
    return true;
  }
  function emojiPicker(messageId = "") {
    if (accountBusy) return;
    const input = $("#messageInput"), channel = state.active, version = identityVersion;
    if (messageId && reactionRequests.has(reactionRequestKey(channel, messageId))) return;
    const item = messageId && visibleMessages(channel).find(message => message.id === messageId && !message.pending && !message.failed);
    if (messageId && !item) return;
    if (!messageId && !draftsResolved) return toast("Your account is still connecting. Try again in a moment.");
    const selection = { channel, version, start: input.selectionStart ?? input.value.length, end: input.selectionEnd ?? input.value.length };
    modal(messageId ? "A little reaction goes a long way." : "Find your kind of hello.", messageId ? "Pick a reaction. Tap it again on the message to remove it." : "Choose an emoji to add at your cursor.", `${item ? `<blockquote class="picker-context"><b>${esc(item.user || "Guest")}</b><p>${esc(String(item.text || "").slice(0, 160))}</p></blockquote>` : ""}<label class="emoji-search-label" for="emojiSearch">Search emoji</label><input id="emojiSearch" class="search-input" type="search" placeholder="Try love, laugh, music…" autocomplete="off"><div id="emojiChoices" class="emoji-grid" aria-label="Emoji choices"></div><p id="emojiResultStatus" class="picker-status" role="status"></p>`);
    const searchInput = $("#emojiSearch"), choices = $("#emojiChoices");
    const update = () => {
      const term = searchInput.value.trim().toLowerCase();
      const matches = emojiChoices.filter(([emoji, label]) => label.toLowerCase().includes(term) || emoji.includes(term));
      choices.innerHTML = matches.map(([emoji, label]) => `<button type="button" class="emoji-choice" data-choose-emoji="${esc(emoji)}" aria-label="${esc(label)}" title="${esc(label)}">${esc(emoji)}</button>`).join("");
      $("#emojiResultStatus").textContent = matches.length ? `${matches.length} emoji · ${messageId ? "Choose one to react" : "Added to your draft, ready when you are"}` : "No emoji found. Try another word.";
    };
    choices.onclick = event => {
      const button = event.target.closest("[data-choose-emoji]"); if (!button) return;
      if (version !== identityVersion || channel !== state.active) { closeModal(); return; }
      if (messageId) { closeModal(); toggleReaction(messageId, button.dataset.chooseEmoji, channel); }
      else insertComposerEmoji(button.dataset.chooseEmoji, selection);
    };
    searchInput.oninput = update; update(); searchInput.focus();
  }
  async function toggleReaction(messageId, emoji, channel = state.active) {
    const key = reactionRequestKey(channel, messageId), version = identityVersion;
    const item = visibleMessages(channel).find(message => message.id === messageId && !message.pending && !message.failed);
    if (!item || reactionRequests.has(key)) return;
    if (!state.connected) return toast("Reconnect to add a reaction. Your message stays here.");
    reactionRequests.add(key);
    const updateButtons = busy => {
      const row = messageRows.get(`message:${messageId}`)?.node;
      for (const button of row?.querySelectorAll("[data-react], [data-reaction-picker]") || []) {
        if (busy) button.setAttribute("aria-disabled", "true");
        else button.removeAttribute("aria-disabled");
      }
    };
    if (channel === state.active) updateButtons(true);
    try {
      const result = await api("/api/reactions", { method: "POST", body: JSON.stringify({ channel, messageId, emoji, guestId: state.guest.id, guestName: name() }) });
      if (version !== identityVersion) return;
      const current = (state.messages[channel] || []).find(message => message.id === messageId);
      if (current) current.reactions = result.reactions;
    } catch (error) { if (version === identityVersion) toast(error.uncertain ? "Reaction not confirmed. Check the message before trying again." : error.message); }
    finally {
      reactionRequests.delete(key);
      if (version === identityVersion && channel === state.active) { updateButtons(false); renderMessages(); }
    }
  }
  async function copyMessage(messageId) {
    const version = identityVersion, channel = state.active, generation = modalGeneration;
    const item = visibleMessages(channel).find(message => message.id === messageId && !message.pending && !message.failed);
    if (!item) return;
    try {
      if (!navigator.clipboard?.writeText) throw new Error("Clipboard unavailable");
      await navigator.clipboard.writeText(item.text);
      if (version === identityVersion && generation === modalGeneration) toast("Message copied.");
    } catch {
      if (version !== identityVersion || channel !== state.active || generation !== modalGeneration) return;
      modal("Copy this message.", "Your browser couldn’t use the clipboard. Select the text below and copy it.", `<label for="copyMessageText">Message text</label><textarea id="copyMessageText" class="copy-message-text" rows="5" readonly>${esc(item.text)}</textarea>`);
      $("#copyMessageText").focus(); $("#copyMessageText").select();
    }
  }
  function setAccountBusy(busy) {
    accountBusy = busy;
    $$("#modalRoot button, #modalRoot input, #modalRoot select").forEach(control => control.disabled = busy);
    $("#modalRoot").setAttribute("aria-busy", String(busy));
    if (busy && $(".modal")) { $(".modal").setAttribute("tabindex", "-1"); $(".modal").focus(); }
  }
  function createRoomMenu() {
    modal("Make a place for your people.", "Choose a space that fits your conversation.", `<div class="modal-actions"><button id="makeServer" class="modal-choice"><b>✳ Community server</b><small>Keep text and voice channels together.</small></button><button id="makeRoom" class="modal-choice"><b># Open conversation</b><small>A public room anyone can join.</small></button><button id="makeParty" class="modal-choice"><b>✦ Invite-only party</b><small>A private conversation for people you invite.</small></button></div>`);
    $("#makeServer").onclick = createServerModal;
    $("#makeRoom").onclick = () => roomForm(false); $("#makeParty").onclick = () => roomForm(true);
  }
  function createServerModal() {
    modal("Start your server", "Gather a community around the things you love. Every server starts with a text channel and a voice lounge.", `<form id="serverForm"><label>Server name<input id="serverName" required minlength="2" maxlength="42" placeholder="The late night club"></label><label>Server icon<select id="serverEmoji"><option>✳</option><option>🎮</option><option>🎨</option><option>🎧</option><option>🌱</option><option>🚀</option><option>📚</option></select></label><label>About this server<input id="serverDescription" maxlength="120" placeholder="What brings your people together?"></label><p id="serverError" class="auth-error" role="alert"></p><button class="submit-button">Create server</button></form>`);
    $("#serverForm").onsubmit = async event => {
      event.preventDefault(); const button = event.currentTarget.querySelector(".submit-button"); button.disabled = true; button.textContent = "Creating…";
      try {
        const result = await api("/api/servers", { method: "POST", body: JSON.stringify({ name: $("#serverName").value.trim(), emoji: $("#serverEmoji").value, description: $("#serverDescription").value.trim(), guestId: state.guest.id }) });
        state.servers = [result.server, ...state.servers.filter(server => server.id !== result.server.id)]; closeModal(); renderRoomList(); await selectChannel(result.server.channels[0].id); inviteCreated(result.server, result.inviteCode, "server");
      } catch (error) { $("#serverError").textContent = error.message; button.disabled = false; button.textContent = "Create server"; }
    };
  }
  function addServerChannelModal(serverId) {
    const server = state.servers.find(item => item.id === serverId); if (!server) return;
    modal(`Add a channel to ${server.name}`, "Text channels are for messages. Voice channels open the live voice room.", `<form id="serverChannelForm"><label>Channel name<input id="serverChannelName" required maxlength="40" placeholder="general-chat"></label><label>Channel type<select id="serverChannelType"><option value="text"># Text</option><option value="voice">◖ Voice</option></select></label><p id="serverChannelError" class="auth-error" role="alert"></p><button class="submit-button">Add channel</button></form>`);
    $("#serverChannelForm").onsubmit = async event => {
      event.preventDefault(); const button = event.currentTarget.querySelector(".submit-button"); button.disabled = true;
      try {
        const result = await api("/api/servers/channels", { method: "POST", body: JSON.stringify({ serverId, name: $("#serverChannelName").value.trim(), type: $("#serverChannelType").value, guestId: state.guest.id }) });
        state.servers = state.servers.map(item => item.id === serverId ? result.server : item); closeModal(); renderRoomList(); await selectChannel(result.channel.id);
      } catch (error) { $("#serverChannelError").textContent = error.message; button.disabled = false; }
    };
  }
  async function inviteToServer(serverId) {
    try { const result = await api("/api/servers/invite", { method: "POST", body: JSON.stringify({ id: serverId, guestId: state.guest.id }) }); const server = state.servers.find(item => item.id === serverId); inviteCreated(server, result.inviteCode, "server"); }
    catch (error) { toast(error.message); }
  }
  function roomForm(isParty) {
    modal(isParty ? "Start a party." : "Start a community room.", "Give people a good reason to join the conversation.", `<form id="roomForm"><label>Name<input id="roomName" required minlength="2" maxlength="42" placeholder="${isParty ? "Friday night crew" : "Book lovers unite"}"></label><label>Conversation starter<input id="roomTopic" maxlength="100" placeholder="What should people talk about?"></label><p id="roomError" class="auth-error" role="alert"></p><button class="submit-button">Create ${isParty ? "party" : "room"} →</button></form>`);
    $("#roomForm").onsubmit = async event => {
      event.preventDefault(); const form = event.currentTarget, button = form.querySelector("button"), errorNode = $("#roomError"); button.disabled = true; errorNode.textContent = "";
      try {
        const result = await api(isParty ? "/api/parties" : "/api/rooms", { method: "POST", body: JSON.stringify({ name: $("#roomName").value.trim(), topic: $("#roomTopic").value.trim(), owner: name(), guestId: state.guest.id }) });
        if (isParty) state.parties.unshift(result.room); else state.rooms.unshift(result.room);
        closeModal(); await selectChannel(result.room.id);
        if (isParty) inviteCreated(result.room, result.inviteCode); else toast("Your room is open to everyone.");
      } catch (error) { if (form.isConnected) errorNode.textContent = error.message; button.disabled = false; }
    };
  }
  function packInvite(data) { return btoa(unescape(encodeURIComponent(JSON.stringify(data)))).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, ""); }
  function bindInviteCopy(link) {
    const input = $("#inviteLink"), button = $("#copyInvite"), status = $("#inviteCopyStatus"), version = identityVersion;
    const current = () => version === identityVersion && input.isConnected && button.isConnected;
    button.onclick = async () => {
      if (button.disabled) return;
      button.disabled = true; status.textContent = "";
      try {
        if (!navigator.clipboard?.writeText) throw new Error("Clipboard unavailable");
        await navigator.clipboard.writeText(link);
        if (current()) status.textContent = "Invite copied.";
      } catch {
        if (!current()) return;
        input.focus(); input.select();
        let copied = false;
        try { copied = document.execCommand?.("copy") === true; } catch {}
        status.textContent = copied ? "Invite copied." : "Your browser couldn’t copy the link. Copy the selected link manually.";
      } finally { if (current()) button.disabled = false; }
    };
  }
  function inviteCreated(item, code, kind = "party") {
    const link = `${appOrigin}${location.pathname}?invite=${packInvite({ kind, id: item.id, inviteCode: code, name: item.name, topic: item.topic })}`;
    modal(`Invite someone to ${item.name}.`, kind === "server" ? "Anyone with this link can join your server." : "Anyone with this invite can join your private party.", `<div class="invite-box"><input id="inviteLink" aria-label="Invite link" aria-describedby="inviteCopyStatus" readonly value="${esc(link)}"><button id="copyInvite" class="submit-button">Copy invite</button></div><p id="inviteCopyStatus" class="invite-copy-status" role="status"></p><button id="doneInvite" class="subtle-button">Done</button>`);
    bindInviteCopy(link);
    $("#doneInvite").onclick = closeModal;
  }
  async function processInvite(version = identityVersion) {
    const encoded = new URLSearchParams(location.search).get("invite"); if (!encoded) return;
    try {
      const data = JSON.parse(decodeURIComponent(escape(atob(encoded.replace(/-/g, "+").replace(/_/g, "/")))));
      if (data.kind === "server") {
        const result = await api("/api/servers/join", { method: "POST", body: JSON.stringify({ id: data.id, inviteCode: data.inviteCode, guestId: state.guest.id }) });
        if (version !== identityVersion) return;
        state.servers = state.servers.filter(server => server.id !== result.server.id); state.servers.unshift(result.server); state.active = result.server.channels[0].id; renderRoomList();
      } else {
        const result = await api("/api/parties/join", { method: "POST", body: JSON.stringify({ id: data.id, inviteCode: data.inviteCode, guestId: state.guest.id }) });
        if (version !== identityVersion) return;
        state.parties = (state.parties || []).filter(item => item.id !== result.room.id); state.parties.unshift(result.room); state.active = result.room.id;
      }
      state.view = "chat"; save(); history.replaceState({}, "", location.pathname); toast(`You joined ${data.name || "the server"}.`);
    } catch (error) { if (version !== identityVersion) return; history.replaceState({}, "", location.pathname); toast(error.message); }
  }
  function inviteGeneral() {
    const link = `${appOrigin}${location.pathname}`;
    modal("Invite someone to Orbit.", "Send this link so a friend can join the conversation.", `<div class="invite-box"><input id="inviteLink" aria-label="Invite link" aria-describedby="inviteCopyStatus" readonly value="${esc(link)}"><button id="copyInvite" class="submit-button">Copy link</button></div><p id="inviteCopyStatus" class="invite-copy-status" role="status"></p>`);
    bindInviteCopy(link);
  }
  function authModal(mode = "login", draft = {}) {
    const register = mode === "register";
    modal(register ? "Make room for you." : "Your people are a hello away.", register ? "Create a TurboChat account to keep your profile and server memberships." : "Sign in to your TurboChat account. You can also keep exploring as a guest.", `<div class="auth-tabs"><button id="toLogin" class="${register ? "" : "active"}">Sign in</button><button id="toRegister" class="${register ? "active" : ""}">Create account</button></div><form id="authForm">${register ? `<label>Display name<input id="authName" required minlength="2" maxlength="32" autocomplete="nickname" placeholder="What should we call you?"></label>` : ""}<label>Email<input id="authEmail" type="email" required autocomplete="email" autocapitalize="none" spellcheck="false" placeholder="you@example.com"></label><label>Password<input id="authPassword" type="password" required minlength="${register ? "8" : "1"}" maxlength="128" autocomplete="${register ? "new-password" : "current-password"}" placeholder="${register ? "At least 8 characters" : "Your password"}"></label><button type="button" id="togglePassword" class="password-toggle" aria-pressed="false">Show password</button><p id="authError" class="auth-error" role="alert"></p><button class="submit-button">${register ? "Create account" : "Sign in"} <span aria-hidden="true">↗</span></button></form>${state.profile ? `<button id="logout" class="subtle-button">Sign out</button>` : ""}<div class="guest-divider"><span>or take a look around</span></div><button id="guestMode" class="subtle-button guest-action">Continue as ${esc(state.guest.name)} →</button>`);
    $("#authEmail").value = draft.email || "";
    if (register) $("#authName").value = draft.name || "";
    $("#authPassword").value = "";
    $("#toLogin").setAttribute("aria-pressed", String(!register)); $("#toRegister").setAttribute("aria-pressed", String(register));
    $("#togglePassword").onclick = () => { const input = $("#authPassword"), show = input.type === "password"; input.type = show ? "text" : "password"; $("#togglePassword").textContent = show ? "Hide password" : "Show password"; $("#togglePassword").setAttribute("aria-pressed", String(show)); };
    const switchMode = next => {
      if (next === mode) return;
      authModal(next, { email: $("#authEmail").value, name: register ? $("#authName").value : draft.name });
    };
    $("#toLogin").onclick = () => switchMode("login"); $("#toRegister").onclick = () => switchMode("register");
    $("#authForm").onsubmit = async e => {
      e.preventDefault(); if (accountBusy) return; const form = e.currentTarget, button = form.querySelector(".submit-button"), errorField = form.querySelector("#authError"); setAccountBusy(true); errorField.textContent = ""; button.textContent = register ? "Creating account…" : "Signing in…";
      let signedIn = null, synced = false;
      try {
        const endpoint = register ? "/api/register" : "/api/login";
        const result = await api(endpoint, { method: "POST", body: JSON.stringify({ name: register ? $("#authName").value.trim() : undefined, email: $("#authEmail").value.trim(), password: $("#authPassword").value, guestId: state.guest.id }) });
        const session = await api("/api/me");
        if (!session.user || session.user.id !== result.user?.id) throw new Error("Sign-in could not be confirmed. The service may not have kept the session, or this browser may be blocking cookies. You can continue as a guest and try again later.");
        signedIn = session.user; synced = await refreshIdentity(session.user);
      } catch (error) { if (form.isConnected) errorField.textContent = error.message; button.textContent = register ? "Create account" : "Sign in"; }
      finally { setAccountBusy(false); }
      if (signedIn) { if (form.isConnected) closeModal(); toast(synced ? `Welcome, ${signedIn.name}.` : `Signed in as ${signedIn.name}. Your conversations are reconnecting.`); }
    };
    $("#guestMode").onclick = () => state.profile ? signOut() : closeModal();
    if ($("#logout")) $("#logout").onclick = signOut;
  }
  function profileModal() {
    if (!state.profile) return authModal("login");
    const emojis = ["✦","🌙","🌻","🦊","🐸","🐈","🎧","🚀","🌊","⭐","🍄","🪐"];
    modal("Your profile", "Make your little corner feel like you.", `<form id="profileForm"><label>Display name<input id="profileName" required minlength="2" maxlength="32" value="${esc(state.profile.name)}" autocomplete="nickname"></label><label>Avatar<select id="profileEmoji">${emojis.map(emoji => `<option value="${emoji}" ${state.profile.emoji === emoji ? "selected" : ""}>${emoji}</option>`).join("")}</select></label><label>About me<input id="profileAbout" maxlength="100" value="${esc(state.profile.about || "")}" placeholder="A little about you"></label><label>Status<select id="profileStatus"><option value="online" ${state.profile.status !== "idle" && state.profile.status !== "dnd" ? "selected" : ""}>Online</option><option value="idle" ${state.profile.status === "idle" ? "selected" : ""}>Idle</option><option value="dnd" ${state.profile.status === "dnd" ? "selected" : ""}>Do not disturb</option></select></label><p id="profileError" class="auth-error" role="alert"></p><button class="submit-button">Save profile</button></form><button id="profileSignOut" class="subtle-button">Sign out</button>${canManageParty() ? `<button id="profileManageParty" class="subtle-button">Manage this private party</button>` : ""}${state.cleanupSupport ? `<div class="account-danger-zone"><b>Account privacy</b><p>Remove an unused account when you no longer need it. Shared content stays protected.</p><button id="deleteAccountOpen" class="danger-outline" type="button">Delete unused account</button></div>` : ""}`);
    $("#profileForm").onsubmit = async event => {
      event.preventDefault(); if (accountBusy) return; const form = event.currentTarget, button = form.querySelector(".submit-button"), errorField = form.querySelector("#profileError"); setAccountBusy(true); button.textContent = "Saving…";
      let savedProfile = false;
      try {
        const result = await api("/api/profile", { method: "POST", body: JSON.stringify({ name: $("#profileName").value.trim(), emoji: $("#profileEmoji").value, about: $("#profileAbout").value.trim(), status: $("#profileStatus").value }) });
        state.profile = result.user; updateIdentity(); renderMembers(); renderMessages(); connectLive(); savedProfile = true;
      } catch (error) { if (form.isConnected) errorField.textContent = error.message; button.textContent = "Save profile"; }
      finally { setAccountBusy(false); }
      if (savedProfile) { closeModal(); toast("Profile saved."); }
    };
    $("#profileSignOut").onclick = signOut;
    if ($("#profileManageParty")) $("#profileManageParty").onclick = partyDeletionModal;
    if ($("#deleteAccountOpen")) $("#deleteAccountOpen").onclick = accountDeletionModal;
  }
  function partyDeletionModal() {
    const party = state.parties.find(item => item.id === state.active);
    if (!party || !canManageParty(party)) return;
    modal("Remove this private party?", "Only a party used exclusively by you can be removed here. Shared conversations are protected. This permanently removes this party and its saved messages.", `<form id="partyDeleteForm"><label>Type the party name to confirm<input id="partyDeleteName" required maxlength="42" autocomplete="off" spellcheck="false" placeholder="${esc(party.name)}"></label><p id="partyDeleteError" class="auth-error" role="alert"></p><button class="submit-button danger-button">Delete my private party</button></form>`);
    $("#partyDeleteForm").onsubmit = async event => {
      event.preventDefault(); if (accountBusy) return;
      const form = event.currentTarget, errorField = form.querySelector("#partyDeleteError"), button = form.querySelector(".submit-button"), confirmation = $("#partyDeleteName").value;
      if (confirmation !== party.name) { errorField.textContent = "Type the party name exactly as shown."; return; }
      setAccountBusy(true); errorField.textContent = ""; button.textContent = "Deleting…"; let removed = false;
      try {
        await api("/api/parties/delete", { method: "POST", body: JSON.stringify({ id: party.id, confirmName: confirmation }) });
        if (state.voiceRoom === party.id) await leaveVoice(true);
        clearTyping(); state.parties = state.parties.filter(item => item.id !== party.id); delete state.messages[party.id]; delete state.unread[party.id]; delete drafts[party.id]; delete replyDrafts[party.id]; delete state.channelErrors[party.id];
        state.followingRooms = state.followingRooms.filter(id => id !== party.id);
        if (state.active === party.id) { state.active = "global"; restoreDraft(); enterMessageRoom("global"); setView("chat"); }
        save(); renderRoomList(); renderMessages(); removed = true;
      } catch (error) { if (form.isConnected) errorField.textContent = error.message; button.textContent = "Delete my private party"; }
      finally { setAccountBusy(false); }
      if (removed) { closeModal(); toast("Your private party was deleted."); }
    };
  }
  function accountDeletionModal() {
    if (!state.profile || !state.cleanupSupport) return;
    const accountId = state.profile.id;
    modal("Delete an unused account?", "This permanently removes your sign-in and profile. Accounts with saved messages, servers or private parties cannot be removed here. Delete your sole-use private parties first; shared spaces and other people's content are protected.", `<form id="accountDeleteForm"><label>Current password<input id="accountDeletePassword" type="password" required maxlength="128" autocomplete="current-password"></label><label>Type DELETE to confirm<input id="accountDeleteConfirm" required autocomplete="off" autocapitalize="characters" spellcheck="false" placeholder="DELETE"></label><p id="accountDeleteError" class="auth-error" role="alert"></p><button class="submit-button danger-button">Permanently delete unused account</button></form>`);
    $("#accountDeleteForm").onsubmit = async event => {
      event.preventDefault(); if (accountBusy) return;
      const form = event.currentTarget, errorField = form.querySelector("#accountDeleteError"), button = form.querySelector(".submit-button");
      const confirmation = $("#accountDeleteConfirm").value, password = $("#accountDeletePassword").value;
      if (confirmation !== "DELETE") { errorField.textContent = "Type DELETE to confirm."; return; }
      setAccountBusy(true); errorField.textContent = ""; button.textContent = "Deleting…"; let removed = false, synced = false;
      try {
        await api("/api/account/delete", { method: "POST", body: JSON.stringify({ password, confirmation }) });
        removed = true; synced = await refreshIdentity(null, true);
        delete draftBooks[`user-${accountId}`]; delete replyBooks[`user-${accountId}`]; save();
      } catch (error) { if (form.isConnected) errorField.textContent = error.message; button.textContent = "Permanently delete unused account"; }
      finally { setAccountBusy(false); }
      if (removed) { closeModal(); toast(synced ? "Your unused account was deleted. You can continue as a guest." : "Your unused account was deleted. Conversations are reconnecting."); }
    };
  }
  async function refreshIdentity(profile, resetChannel = false) {
    clearTimeout(reconnectTimer); saveDraft(); clearTyping(); identityVersion++; state.stream?.close(); clearInterval(pollTimer);
    const version = identityVersion; let synced = false;
    if (state.voiceRoom || state.joiningVoice) await leaveVoice(true);
    if (version !== identityVersion) return false;
    state.profile = profile; state.voiceSelection = ""; if (resetChannel) state.active = "global"; chooseDrafts(profile);
    state.messages = {}; state.parties = []; state.servers = []; state.members = []; state.unread = {}; lastEventSeq = 0; lastHeartbeat = 0; lastMessageSync = 0;
    state.loading = true; setConnected(false, "Loading conversations…");
    updateIdentity(); renderRoomList(); renderMessages(); renderMembers();
    try { await bootstrap(); if (version !== identityVersion) return false; synced = true; return true; }
    catch (error) {
      if (version !== identityVersion) return false;
      state.loading = false; state.channelErrors[state.active] = error.message; setConnected(false, "Reconnecting…"); renderMessages();
      reconnectTimer = setTimeout(() => { if (version === identityVersion) start(); }, 8000); return false;
    } finally { if (synced && version === identityVersion) connectLive(); }
  }
  async function signOut() {
    if (accountBusy) return; setAccountBusy(true);
    let signedOut = false, synced = false;
    try {
      saveDraft(); clearTyping();
      if (state.voiceRoom || state.joiningVoice) await leaveVoice(true);
      await api("/api/logout", { method: "POST", body: "{}" });
      signedOut = true; synced = await refreshIdentity(null, true);
    } catch (error) { toast(error.message); }
    finally { setAccountBusy(false); }
    if (signedOut) { closeModal(); toast(synced ? "Signed out." : "Signed out. Your conversations are reconnecting."); }
  }
  function updateIdentity() { $("#identityHint").textContent = state.profile ? `Signed in as ${state.profile.name}` : `Chatting as ${state.guest.name}`; $("#profileButton").textContent = state.profile?.emoji || (state.profile ? state.profile.name[0].toUpperCase() : "G"); $("#topProfile").textContent = state.profile ? `${state.profile.emoji || "◉"} ${state.profile.name}` : "Sign in"; $("#discoverAccount").textContent = state.profile ? "Your profile ↗" : "Sign in to your space ↗"; $("#discoverIdentity").textContent = state.profile ? `Welcome back, ${state.profile.name}. Your next conversation is waiting.` : "No introduction needed. Explore as a guest, or sign in to your profile."; }
  const originalTracks = [
    ["neon", "Neon Postcards", "Retro pop · 112 BPM", "neon-postcards.wav"],
    ["midnight", "Midnight Arcade", "Synthwave · 118 BPM", "midnight-arcade.wav"],
    ["dreamwave", "Dreamwave Radio", "Dream pop · 96 BPM", "dreamwave-radio.wav"],
    ["orbit", "Slow Orbit", "Ambient pop · 82 BPM", "slow-orbit.wav"]
  ];
  let displayedMusicDetails, displayedMusicPlayer;
  let songDraftVersion = 0, sharingSong = false;
  function updateMusic(track) {
    if (track === undefined || Date.parse(track?.createdAt) < Date.parse(state.music?.createdAt)) return;
    let url;
    if (track) {
      try { url = new URL(track.url); } catch { /* Unusable saved track. */ }
      if (!url || !["http:", "https:"].includes(url.protocol)) {
        if (state.music) return;
        track = null;
        url = undefined;
      }
    }
    state.music = track;
    const details = track
      ? `<div class="current-track"><span>♫</span><div><b>${esc(track.title)}</b><small>Shared by ${esc(track.submittedBy)}</small></div></div>`
      : '<div class="no-track">♫ <b>No song has been shared yet.</b><small>Pick an original track below.</small></div>';
    if (details !== displayedMusicDetails) {
      $("#musicTrack").innerHTML = details;
      displayedMusicDetails = details;
    }
    let player = "";
    if (url) {
      let yt = "";
      const path = url.pathname.split("/");
      if (url.hostname === "youtu.be") yt = path[1] || "";
      else if (/(^|\.)youtube\.com$/.test(url.hostname)) {
        const pathVideo = ["shorts", "live", "embed", "v"].includes(path[1]) ? path[2] : "";
        yt = pathVideo || url.searchParams.get("v") || "";
      }
      if (/^[\w-]{11}$/.test(yt)) player = `<iframe class="embed-player" src="https://www.youtube-nocookie.com/embed/${encodeURIComponent(yt)}?rel=0" title="Shared YouTube player" allow="autoplay; encrypted-media; picture-in-picture" allowfullscreen></iframe>`;
      else if (/(^|\.)soundcloud\.com$/.test(url.hostname)) player = `<iframe class="embed-player" src="https://w.soundcloud.com/player/?url=${encodeURIComponent(url.href)}&auto_play=false" title="Shared SoundCloud player" allow="autoplay"></iframe>`;
      else player = `<audio controls preload="metadata" aria-label="Shared audio player" src="${esc(url.href)}"></audio>`;
    }
    // The POST response and live update can describe the same track. Keep the
    // mounted player for the same source so playback and controls stay intact.
    if (player !== displayedMusicPlayer) {
      $("#musicPlayer").innerHTML = player;
      displayedMusicPlayer = player;
    }
  }
  async function shareOriginalTrack(id) {
    const original = originalTracks.find(([key]) => key === id);
    if (!original) return;
    const [, title, , file] = original, version = identityVersion;
    try {
      const result = await api("/api/music", { method: "POST", body: JSON.stringify({ title, url: new URL(`/media/${file}`, appOrigin).href, guestName: name() }) });
      if (identityVersion !== version) return;
      updateMusic(result.track);
      toast(`Shared ${title} in Now Playing.`);
    } catch (error) { if (identityVersion === version) toast(error.message); }
  }
  async function shareMusic(event) {
    event.preventDefault();
    if (sharingSong) return;
    const form = event.currentTarget, button = form.querySelector("button");
    const version = identityVersion, draftVersion = songDraftVersion;
    const title = $("#musicTitle").value, url = $("#musicUrl").value;
    sharingSong = true;
    button.setAttribute("aria-disabled", "true");
    button.textContent = "Sharing…";
    try {
      const result = await api("/api/music", { method: "POST", body: JSON.stringify({ title: title.trim(), url: url.trim(), guestName: name() }) });
      if (identityVersion !== version) return;
      updateMusic(result.track);
      if (songDraftVersion === draftVersion) form.reset();
      toast("Song shared in Now Playing.");
    } catch (error) { if (identityVersion === version) toast(error.message); }
    finally {
      sharingSong = false;
      button.setAttribute("aria-disabled", "false");
      button.textContent = "Share song";
    }
  }
  function voiceTabRoom(rooms = allRooms()) {
    return [state.voiceSelection, state.voiceRoom, state.joiningVoice, state.active].find(id => rooms.some(item => item.id === id)) || "global";
  }
  let voiceRoomListMarkup = "";
  function renderVoiceRooms() {
    const rooms = allRooms(), selectedRoom = voiceTabRoom(rooms);
    const list = $("#voiceRoomList");
    const markup = rooms.map(item => {
      const selected = selectedRoom === item.id;
      const label = state.voiceRoom === item.id ? "In call" : selected ? "Selected" : "";
      const name = item.serverName ? `${item.serverName} / ${item.name}` : item.name;
      return `<button type="button" class="voice-room-option ${selected ? "selected" : ""}" data-voice-room="${esc(item.id)}" aria-pressed="${selected}"><span aria-hidden="true">${esc(item.emoji || "✦")}</span><b>${esc(name)}</b>${label ? `<small>${label}</small>` : ""}</button>`;
    }).join("");
    if (markup === voiceRoomListMarkup) return;
    const focused = document.activeElement?.dataset?.voiceRoom;
    list.innerHTML = markup;
    voiceRoomListMarkup = markup;
    if (focused) [...list.querySelectorAll("[data-voice-room]")].find(button => button.dataset.voiceRoom === focused)?.focus({ preventScroll: true });
  }
  function selectVoiceRoom(id) {
    if (!allRooms().some(item => item.id === id)) return;
    if (state.voiceSelection !== id && !state.voiceRoom) state.voiceError = "";
    state.voiceSelection = id;
    setView("voice");
    renderVoice();
  }
  function renderHeader() {
    const current = room(state.active), details = info[state.active] || [current.name, current.topic || "Come in and say hello.", current.emoji || "✦"];
    const headings = { discover: ["Explore TurboChat", "Find your people. Keep the conversation going.", "✳"], people: ["Your people", "See who’s online and invite friends.", "♧"], voice: ["Voice chat", "Choose a room and join when you’re ready.", "◖"] };
    const heading = headings[state.view] || details;
    $("#channelTitle").textContent = heading[0]; $("#channelSubtitle").textContent = heading[1]; $("#channelGlyph").textContent = heading[2];
  }
  function setView(view) {
    if (!["discover", "chat", "people", "voice"].includes(view)) return;
    const previousView = state.view;
    state.view = view; $(".main-panel").dataset.view = view; save(); renderHeader();
    if (view === "chat" && state.unread[state.active]) { delete state.unread[state.active]; renderRoomList(); }
    ["discover", "chat", "people", "voice"].forEach(name => $(`#${name}View`).classList.toggle("hidden", name !== view));
    $$('[data-view]').forEach(button => { button.classList.toggle("active", button.dataset.view === view); button.setAttribute("aria-pressed", String(button.dataset.view === view)); });
    if (view === "voice") renderVoiceRooms();
    updateJumpLatest();
    if (view === "chat" && previousView !== "chat") {
      if (messageFollow.pinned) scrollToLatest(false);
      else restoreReadingAnchor(messageFollow.anchor);
    }
  }
  function renderVoice() {
    const joined = Boolean(state.voiceRoom);
    const sideRoom = state.voiceRoom || state.joiningVoice || state.active;
    const tabRoom = voiceTabRoom();
    const showTabControls = joined && state.voiceRoom === tabRoom;
    const otherCall = joined && !showTabControls;
    const others = state.voiceMembers.filter(item => item.peerId !== state.peerId).length;
    const relayReady = relaySocket && relaySocket.readyState === window.WebSocket?.OPEN;
    const peerAudioReady = [...voicePeers.values()].some(peer => peer.connectionState === "connected");
    const audioReady = joined && (usePolling ? peerAudioReady : relayReady);
    let audioLabel = "Connecting audio…";
    if (audioReady) audioLabel = "Voice connected";
    else if (usePolling) audioLabel = others ? "Connecting to callers…" : "Waiting for someone";
    if (!state.connected) audioLabel = "Chat reconnecting";
    else if (state.voiceError) audioLabel = "Voice needs attention";
    const roomRoster = others ? `${others} ${others === 1 ? "person" : "people"} here` : "waiting for someone";
    let status = "Join voice to start talking";
    if (state.voiceError) status = state.voiceError;
    else if (state.joiningVoice) status = `Joining ${room(state.joiningVoice).name}…`;
    else if (joined) status = audioReady && state.connected ? `${audioLabel} · ${roomRoster}` : audioLabel;
    else if (!state.connected) status = "Connect to chat first";
    const participants = joined ? state.voiceMembers.map(item => {
      const self = item.peerId === state.peerId;
      const muted = self ? state.muted || state.deafened : item.muted || item.deafened;
      return `<span class="voice-person${muted ? " muted" : ""}">${muted ? "⌁" : "◖"} ${esc(item.name)}${self ? " (you)" : ""}</span>`;
    }).join("") : "";
    const unavailable = Boolean(state.joiningVoice) || (!state.connected && !joined);
    const joinLabel = state.joiningVoice ? "Joining…" : joined ? "Leave voice" : "Join voice";
    const muteLabel = state.muted ? "Unmute" : "Mute";
    const deafenLabel = state.deafened ? "Undeafen" : "Deafen";

    $("#voiceRoomName").textContent = `${room(sideRoom).name} voice`;
    $("#voiceToggle").textContent = joinLabel;
    $("#voiceToggle").disabled = unavailable;
    $("#voiceMute").classList.toggle("hidden", !joined);
    $("#voiceDeafen").classList.toggle("hidden", !joined);
    $("#voiceMute").textContent = muteLabel;
    $("#voiceDeafen").textContent = deafenLabel;
    $("#voiceStatus").textContent = status;
    $("#voiceDot").classList.toggle("active", joined);
    $("#mobileVoiceCount").textContent = state.voiceMembers.length;
    $("#rightPanel").classList.toggle("mobile-open", state.voiceMobileOpen);
    $("#voiceParticipants").innerHTML = participants;
    $("#mobileVoice").setAttribute("aria-expanded", String(state.voiceMobileOpen));
    $("#mobileVoice").setAttribute("aria-label", state.voiceMobileOpen ? "Hide voice controls" : "Show voice controls");
    $("#mobileVoice").classList.toggle("joined", joined);

    $("#voiceTabRoomName").textContent = `${room(tabRoom).name} voice`;
    $("#voiceTabStatus").textContent = otherCall ? `You’re in ${room(state.voiceRoom).name}. Leave that call to join this room.` : status;
    $("#voiceTabDot").classList.toggle("active", showTabControls);
    $("#voiceTabParticipants").innerHTML = (showTabControls && participants) || `<p>${showTabControls ? "Waiting for someone to join." : otherCall ? "Your current call is still open." : "Your call starts when you join."}</p>`;
    $("#voiceTabJoin").textContent = otherCall ? "Leave current call" : joinLabel;
    $("#voiceTabJoin").disabled = unavailable;
    $("#voiceTabMute").classList.toggle("hidden", !showTabControls);
    $("#voiceTabDeafen").classList.toggle("hidden", !showTabControls);
    $("#voiceTabMute").textContent = muteLabel;
    $("#voiceTabDeafen").textContent = deafenLabel;
    $(".voice-wave").classList.toggle("is-active", showTabControls && !state.muted && !state.deafened && !state.voiceError);

    $("#voiceDock").classList.toggle("hidden", !joined);
    $("#voiceDock").classList.toggle("voice-warning", joined && Boolean(state.voiceError || !state.connected));
    $("#voiceDockRoom").textContent = joined ? room(state.voiceRoom).name : "";
    let dockStatus = audioLabel;
    if (joined && state.connected && !state.voiceError) {
      if (state.deafened) dockStatus = "Deafened";
      else if (state.muted) dockStatus = "Mic muted";
    }
    $("#voiceDockStatus").textContent = joined ? dockStatus : "";
    $("#voiceDockMute").textContent = muteLabel;
    $("#voiceDockMute").setAttribute("aria-label", `${muteLabel} microphone`);
    $("#voiceDockMute").setAttribute("aria-pressed", String(state.muted));
    $("#phoneVoiceTab").classList.toggle("joined", joined);
    renderVoiceRooms();
  }
  function voiceSocketUrl() {
    const base = new URL(API_BASE || location.origin);
    const url = new URL("/api/voice/audio", base); url.protocol = base.protocol === "https:" ? "wss:" : "ws:";
    url.searchParams.set("room", state.voiceRoom); url.searchParams.set("peerId", state.peerId); url.searchParams.set("guestId", state.guest.id); return url.href;
  }
  async function captureVoiceMic() {
    const stream = await navigator.mediaDevices.getUserMedia({ audio: {
      channelCount: { ideal: 1 }, sampleRate: { ideal: 48000 }, sampleSize: { ideal: 16 },
      echoCancellation: true, noiseSuppression: true, autoGainControl: true
    } });
    for (const track of stream.getAudioTracks()) track.contentHint = "speech";
    return stream;
  }
  function receiveAudio(buffer) {
    if (!(buffer instanceof ArrayBuffer) || buffer.byteLength < 10 || !audioContext || !outputGain) return;
    const view = new DataView(buffer), idLength = view.getUint16(0, false);
    if (buffer.byteLength < 2 + idLength + 6) return;
    const from = new TextDecoder().decode(new Uint8Array(buffer, 2, idLength));
    const offset = 2 + idLength, rate = view.getUint32(offset, true), samples = new Int16Array(buffer, offset + 4);
    if (!rate || !samples.length) return;
    const audio = audioContext.createBuffer(1, samples.length, rate), channel = audio.getChannelData(0);
    for (let i = 0; i < samples.length; i++) channel[i] = samples[i] / 32768;
    const source = audioContext.createBufferSource(); source.buffer = audio; source.connect(outputGain);
    const start = Math.max(audioContext.currentTime + .04, outputSchedule.get(from) || 0); source.start(start); outputSchedule.set(from, start + audio.duration);
  }
  function sendAudio(event) {
    const output = event.outputBuffer.getChannelData(0); output.fill(0);
    if (!relaySocket || relaySocket.readyState !== WebSocket.OPEN || state.muted || state.deafened) return;
    const input = event.inputBuffer.getChannelData(0), step = audioContext.sampleRate / VOICE_SAMPLE_RATE, count = Math.floor(input.length / step);
    if (!count) return;
    const packet = new ArrayBuffer(4 + count * 2), view = new DataView(packet); view.setUint32(0, VOICE_SAMPLE_RATE, true);
    for (let i = 0; i < count; i++) {
      const position = i * step, index = Math.floor(position), fraction = position - index;
      const sample = input[index] * (1 - fraction) + (input[Math.min(index + 1, input.length - 1)] || 0) * fraction;
      view.setInt16(4 + i * 2, Math.round(Math.max(-1, Math.min(1, sample)) * 32767), true);
    }
    relaySocket.send(packet);
  }
  function connectVoiceAudio() {
    relaySocket = new WebSocket(voiceSocketUrl()); relaySocket.binaryType = "arraybuffer";
    relaySocket.onopen = () => { state.voiceError = ""; renderVoice(); };
    relaySocket.onmessage = event => receiveAudio(event.data);
    relaySocket.onerror = () => { if (state.voiceRoom) { state.voiceError = "Voice audio could not connect. Check this server’s network access."; renderVoice(); } };
    relaySocket.onclose = () => { if (state.voiceRoom) { state.voiceError = "Voice audio disconnected. Leave and rejoin voice."; renderVoice(); } };
    micSource = audioContext.createMediaStreamSource(mic); micProcessor = audioContext.createScriptProcessor(1024, 1, 1);
    outputGain = audioContext.createGain(); outputGain.gain.value = state.deafened ? 0 : 1; outputGain.connect(audioContext.destination);
    micProcessor.onaudioprocess = sendAudio; micSource.connect(micProcessor); micProcessor.connect(audioContext.destination);
  }
  let voiceJoinAttempt = null, voicePresenceRequest = null, pendingVoiceLeave = null;
  let voiceConnectionGeneration = 0;

  function requestVoiceJoin(details) {
    return api("/api/voice/join", { method: "POST", body: JSON.stringify(details) });
  }
  async function refreshVoicePresence() {
    if (!state.voiceRoom || Date.now() - lastVoiceHeartbeat <= 5000 || voicePresenceRequest) return;
    const roomId = state.voiceRoom, version = identityVersion, generation = voiceConnectionGeneration;
    const current = () => version === identityVersion && generation === voiceConnectionGeneration && state.voiceRoom === roomId;
    const request = requestVoiceJoin({ room: roomId, peerId: state.peerId, guestId: state.guest.id, guestName: name() });
    voicePresenceRequest = request;
    try {
      const result = await request;
      if (!current()) return;
      lastVoiceHeartbeat = Date.now();
      await connectToVoiceMembers(result.participants || []);
    } catch (error) {
      if (current()) throw error;
    } finally {
      if (voicePresenceRequest === request) voicePresenceRequest = null;
    }
  }
  function closeVoiceContext(context) {
    return context && context.state !== "closed" ? context.close().catch(() => {}) : Promise.resolve();
  }
  function disposeVoiceAttempt(attempt) {
    if (!attempt) return;
    attempt.stream?.getTracks().forEach(track => track.stop());
    attempt.stream = null;
    const context = attempt.context;
    attempt.context = null;
    return closeVoiceContext(context);
  }
  async function joinVoice(origin = "sidebar") {
    if (state.voiceRoom) return leaveVoice();
    if (voiceJoinAttempt) return;
    if (!state.connected) return toast("Wait for chat to reconnect before joining voice.");
    if (!navigator.mediaDevices?.getUserMedia) return toast("Microphone access needs HTTPS or localhost.");
    if (usePolling && !window.RTCPeerConnection) return toast("This browser does not support secure WebRTC voice.");

    const roomId = origin === "tab" ? voiceTabRoom() : state.active;
    if (!allRooms().some(item => item.id === roomId)) return toast("This voice room is no longer available.");
    const version = identityVersion;
    const details = { room: roomId, peerId: state.peerId, guestId: state.guest.id, guestName: name() };
    const attempt = { details, context: null, stream: null, request: null };
    const current = () => voiceJoinAttempt === attempt && version === identityVersion && state.connected;
    voiceJoinAttempt = attempt;
    state.joiningVoice = roomId;
    state.voiceError = "";
    renderVoice();
    try {
      if (!usePolling) {
        attempt.context = new AudioContext();
        await attempt.context.resume();
        if (!current()) return;
      }
      attempt.stream = await captureVoiceMic();
      if (!current()) return;
      if (pendingVoiceLeave) await pendingVoiceLeave;
      if (!current()) return;
      attempt.request = requestVoiceJoin(details);
      const result = await attempt.request;
      if (!current()) {
        if (voiceJoinAttempt === attempt) await leaveVoice(true);
        return;
      }
      mic = attempt.stream;
      audioContext = attempt.context;
      attempt.stream = null;
      attempt.context = null;
      state.voiceRoom = roomId;
      state.joiningVoice = false;
      state.voiceMembers = result.participants || [];
      lastVoiceHeartbeat = Date.now();
      if (usePolling) {
        blockedVoicePeers.clear();
        await connectToVoiceMembers(state.voiceMembers);
      } else {
        connectVoiceAudio();
        renderVoice();
      }
    } catch (error) {
      if (voiceJoinAttempt !== attempt) return;
      const cleanup = leaveVoice(true);
      if (version === identityVersion) {
        state.voiceError = error.message;
        renderVoice();
        toast(error.message);
      }
      await cleanup;
    } finally {
      if (voiceJoinAttempt === attempt) {
        voiceJoinAttempt = null;
        state.joiningVoice = false;
        renderVoice();
      }
      await disposeVoiceAttempt(attempt);
    }
  }
  async function leaveVoice(silent = false) {
    voiceConnectionGeneration++;
    const attempt = voiceJoinAttempt;
    const previous = state.voiceRoom || state.joiningVoice;
    const details = attempt?.details || { room: previous, peerId: state.peerId, guestId: state.guest.id };
    const pendingUpdate = voicePresenceRequest || attempt?.request;
    if (state.voiceRoom || attempt?.request) {
      const sendLeave = () => api("/api/voice/leave", { method: "POST", body: JSON.stringify(details) }).catch(() => {});
      const request = pendingUpdate ? pendingUpdate.catch(() => {}).then(sendLeave) : sendLeave();
      pendingVoiceLeave = request;
      request.finally(() => { if (pendingVoiceLeave === request) pendingVoiceLeave = null; });
    }

    voiceJoinAttempt = null;
    state.voiceRoom = "";
    state.joiningVoice = false;
    state.voiceMembers = [];
    state.muted = false;
    state.deafened = false;
    state.voiceError = "";
    lastVoiceHeartbeat = 0;
    for (const pc of voicePeers.values()) {
      clearTimeout(pc.__orbitOfferRetry);
      pc.close();
    }
    voicePeers.clear();
    pendingIce.clear();
    voiceSignalQueues.clear();
    blockedVoicePeers.clear();
    $("#remoteAudio").replaceChildren();
    const socket = relaySocket;
    relaySocket = null;
    if (socket) {
      socket.onopen = null;
      socket.onclose = null;
      socket.onerror = null;
      socket.onmessage = null;
      socket.close();
    }
    micProcessor?.disconnect();
    micSource?.disconnect();
    outputGain?.disconnect();
    micProcessor = null;
    micSource = null;
    outputGain = null;
    mic?.getTracks().forEach(track => track.stop());
    mic = null;
    const context = audioContext;
    audioContext = null;
    outputSchedule.clear();
    renderVoice();
    if (!silent && previous) toast("You left voice.");
    await Promise.all([disposeVoiceAttempt(attempt), closeVoiceContext(context), pendingVoiceLeave]);
  }
  async function setVoiceDevice() {
    mic?.getAudioTracks().forEach(track => track.enabled = !state.muted && !state.deafened); if (outputGain) outputGain.gain.value = state.deafened ? 0 : 1; $("#remoteAudio").querySelectorAll("audio").forEach(audio => audio.muted = state.deafened); renderVoice();
    if (!state.voiceRoom) return;
    try { await api("/api/voice/state", { method: "POST", body: JSON.stringify({ room: state.voiceRoom, peerId: state.peerId, muted: state.muted, deafened: state.deafened, guestId: state.guest.id }) }); } catch (error) { toast(error.message); }
  }
  async function sendVoiceSignal(targetId, signal) {
    const generation = voiceConnectionGeneration;
    const room = state.voiceRoom;
    const previous = voiceSignalQueues.get(targetId) || Promise.resolve();
    const next = previous.catch(() => {}).then(() => {
      if (!room || generation !== voiceConnectionGeneration) return;
      return api("/api/voice/signal", { method: "POST", body: JSON.stringify({ room, peerId: state.peerId, targetId, signal, guestId: state.guest.id }) });
    });
    voiceSignalQueues.set(targetId, next);
    try { await next; } finally { if (voiceSignalQueues.get(targetId) === next) voiceSignalQueues.delete(targetId); }
  }
  function waitForIceGathering(pc) {
    if (pc.iceGatheringState === "complete") return Promise.resolve();
    return new Promise(resolve => {
      const timeout = setTimeout(finish, 6000);
      function finish() { clearTimeout(timeout); pc.removeEventListener("icegatheringstatechange", onState); resolve(); }
      function onState() { if (pc.iceGatheringState === "complete") finish(); }
      pc.addEventListener("icegatheringstatechange", onState);
    });
  }
  async function connectToVoiceMembers(participants) {
    const generation = voiceConnectionGeneration;
    const now = Date.now();
    for (const [peerId, expiresAt] of blockedVoicePeers) if (expiresAt <= now) blockedVoicePeers.delete(peerId);
    const liveParticipants = (participants || []).filter(item => !blockedVoicePeers.has(item.peerId));
    const activePeers = new Set(liveParticipants.map(item => item.peerId));
    for (const [peerId, pc] of voicePeers) if (!activePeers.has(peerId)) {
      clearTimeout(pc.__orbitOfferRetry); pc.close(); voicePeers.delete(peerId); pendingIce.delete(peerId);
      document.querySelector(`[data-peer-audio="${CSS.escape(peerId)}"]`)?.remove();
    }
    state.voiceMembers = liveParticipants; renderVoice();
    for (const participant of liveParticipants) {
      if (generation !== voiceConnectionGeneration || !state.voiceRoom) return;
      if (participant.peerId === state.peerId) continue;
      // One side creates the offer, even when both users join at nearly the same time.
      try { await connectVoicePeer(participant.peerId, state.peerId > participant.peerId); }
      catch (error) {
        if (generation !== voiceConnectionGeneration) return;
        if (error.status !== 409) throw error;
        dropVoicePeer(participant.peerId);
      }
    }
  }
  function dropVoicePeer(peerId) {
    const pc = voicePeers.get(peerId); if (pc) { clearTimeout(pc.__orbitOfferRetry); pc.close(); }
    voicePeers.delete(peerId); pendingIce.delete(peerId); voiceSignalQueues.delete(peerId);
    // A 409 can also mean the other join was lost in a concurrent Blobs write.
    // Retry after the next heartbeat instead of suppressing the peer for a long time.
    blockedVoicePeers.set(peerId, Date.now() + 4500);
    state.voiceMembers = state.voiceMembers.filter(item => item.peerId !== peerId);
    document.querySelector(`[data-peer-audio="${CSS.escape(peerId)}"]`)?.remove(); renderVoice();
  }
  async function connectVoicePeer(peerId, offerer) {
    if (voicePeers.has(peerId) || !mic) return voicePeers.get(peerId);
    const pc = new RTCPeerConnection({ iceServers: [
      { urls: "stun:stun.l.google.com:19302" },
      { urls: "stun:stun.cloudflare.com:3478" },
      { urls: "stun:stun.cloudflare.com:53" }
    ] });
    voicePeers.set(peerId, pc);
    const current = () => state.voiceRoom && voicePeers.get(peerId) === pc;
    for (const track of mic.getTracks()) {
      const sender = pc.addTrack(track, mic);
      if (track.kind === "audio" && sender.setParameters) {
        try {
          const parameters = sender.getParameters();
          parameters.encodings ||= [{}];
          parameters.encodings[0].maxBitrate = 64000;
          await sender.setParameters(parameters);
        } catch { /* Keep the browser's default Opus settings if tuning is unsupported. */ }
      }
    }
    if (!current()) return;
    pc.ontrack = event => {
      if (!current()) return;
      let audio = document.querySelector(`[data-peer-audio="${CSS.escape(peerId)}"]`);
      if (!audio) {
        audio = document.createElement("audio");
        audio.autoplay = true;
        audio.playsInline = true;
        audio.dataset.peerAudio = peerId;
        audio.muted = state.deafened;
        $("#remoteAudio").append(audio);
      }
      audio.srcObject = event.streams[0] || new MediaStream([event.track]);
      audio.play().catch(() => {
        if (!current()) return;
        state.voiceError = "Voice connected. Tap the page once to enable audio playback.";
        renderVoice();
      });
    };
    pc.onconnectionstatechange = () => {
      if (!current()) return;
      const interrupted = "A peer voice connection was interrupted. Rejoin the voice room.";
      if (pc.connectionState === "connected") {
        clearTimeout(pc.__orbitOfferRetry);
        if (state.voiceError === interrupted) state.voiceError = "";
      }
      if (["failed", "disconnected"].includes(pc.connectionState)) state.voiceError = interrupted;
      renderVoice();
    };
    if (offerer) {
      const offer = await pc.createOffer(); await pc.setLocalDescription(offer); await waitForIceGathering(pc);
      if (!current()) return;
      const description = pc.localDescription;
      try { await sendVoiceSignal(peerId, { description }); }
      catch (error) { if (error.status !== 409) throw error; }
      scheduleVoiceOfferRetry(peerId, pc, description);
    }
    return pc;
  }
  function scheduleVoiceOfferRetry(peerId, pc, description, attempt = 0) {
    clearTimeout(pc.__orbitOfferRetry);
    if (attempt >= 8 || pc.remoteDescription || pc.signalingState === "closed") return;
    pc.__orbitOfferRetry = setTimeout(async () => {
      if (!state.voiceRoom || voicePeers.get(peerId) !== pc || pc.remoteDescription || pc.signalingState === "closed") return;
      try { await sendVoiceSignal(peerId, { description }); }
      catch (error) { if (error.status !== 409) { state.voiceError = error.message; renderVoice(); } }
      scheduleVoiceOfferRetry(peerId, pc, description, attempt + 1);
    }, 2200);
  }
  async function handleVoiceSignal(event) {
    const signal = event.signal || {}; let pc = voicePeers.get(event.from);
    if (!pc && signal.description?.type === "offer") pc = await connectVoicePeer(event.from, false);
    if (!pc) return;
    if (signal.description) {
      if (signal.description.type === "offer" && pc.remoteDescription?.sdp === signal.description.sdp && pc.localDescription?.type === "answer") {
        await sendVoiceSignal(event.from, { description: pc.localDescription }); return;
      }
      if (signal.description.type === "answer") clearTimeout(pc.__orbitOfferRetry);
      await pc.setRemoteDescription(signal.description);
      if (signal.description.type === "offer") {
        const answer = await pc.createAnswer(); await pc.setLocalDescription(answer); await waitForIceGathering(pc);
        await sendVoiceSignal(event.from, { description: pc.localDescription });
      }
      const queued = pendingIce.get(event.from) || []; pendingIce.delete(event.from); for (const candidate of queued) await pc.addIceCandidate(candidate);
    }
    if (signal.candidate) { if (pc.remoteDescription) await pc.addIceCandidate(signal.candidate); else { const queued = pendingIce.get(event.from) || []; queued.push(signal.candidate); pendingIce.set(event.from, queued); } }
  }
  function showRules() { modal("A small promise to each other.", "Orbit works best when everyone gets to be a person here.", `<ul class="rules"><li>Be curious before you judge. People arrive with different stories.</li><li>Make room for quieter voices. A thoughtful reply goes a long way.</li><li>Keep personal information personal. Share only what feels right to you.</li><li>If someone asks you to stop, let the conversation breathe.</li></ul>`); }
  function search() {
    modal("Find a conversation.", "Search rooms and recent messages. Older history may not be included.", `<input id="searchInput" class="search-input" aria-label="Search rooms and messages" placeholder="Try music, travel, or a message…" autocomplete="off"><div class="search-tabs"><button class="active" data-search-mode="rooms" aria-pressed="true">Rooms</button><button data-search-mode="messages" aria-pressed="false">Messages</button></div><p id="searchStatus" class="search-status" role="status"></p><button id="searchRetry" class="subtle-button search-retry hidden" type="button">Retry unavailable rooms ↻</button><div id="searchResults" class="search-results" aria-live="polite" aria-busy="false"></div>`);
    let mode = "rooms", historyPromise = null, historyRequested = false, loading = false;
    const generation = modalGeneration, version = identityVersion;
    const cache = new Map(Object.entries(state.messages)), loaded = new Set(), failed = new Set();
    const results = $("#searchResults"), input = $("#searchInput"), status = $("#searchStatus"), retry = $("#searchRetry");
    const current = () => input.isConnected && generation === modalGeneration && version === identityVersion;
    const textRooms = () => [...new Map(allRooms().filter(item => item.type !== "voice").map(item => [item.id, item])).values()];
    const roomResults = term => allRooms().filter(item => [item.name, item.topic, item.serverName, info[item.id] ? item.id : "", info[item.id]?.[1], info[item.id]?.[3]].some(value => String(value || "").toLowerCase().includes(term))).map(item => `<button data-search-room="${esc(item.id)}">${esc(item.emoji || "✦")} ${esc(item.name)}<small>${esc(item.topic || "")}</small></button>`).join("") || `<p class="empty-state">No matching room yet.</p>`;
    const messageResults = term => {
      const words = term.split(/\s+/).filter(Boolean), hits = [], available = new Set(textRooms().map(item => item.id));
      for (const [channel, messages] of cache) {
        if (!available.has(channel)) continue;
        for (const item of visibleMessages(channel, messages)) {
          const content = String(item.text || "").toLowerCase();
          if (words.every(word => content.includes(word))) hits.push({ channel, item });
        }
      }
      hits.sort((a, b) => new Date(b.item.createdAt || 0) - new Date(a.item.createdAt || 0));
      return hits.slice(0, 30).map(({ channel, item }) => `<button class="message-search-result" data-search-message="${esc(item.id)}" data-search-channel="${esc(channel)}"><b>${esc(item.user || "Guest")} <small>in ${esc(room(channel).name)}</small></b><span>${esc(String(item.text || "").slice(0, 180))}</span></button>`).join("") || `<p class="empty-state">${loading || failed.size ? "No matches in messages loaded so far." : "No matching recent messages."}</p>`;
    };
    const showResults = html => {
      if (results.innerHTML === html) return;
      const focused = document.activeElement;
      const result = focused?.closest?.("[data-search-message], [data-search-room]");
      const selection = result && results.contains(result) ? { ...result.dataset } : null;
      results.innerHTML = html;
      if (selection) {
        const replacement = [...results.querySelectorAll("[data-search-message], [data-search-room]")].find(button => selection.searchMessage ? button.dataset.searchMessage === selection.searchMessage && button.dataset.searchChannel === selection.searchChannel : button.dataset.searchRoom === selection.searchRoom);
        (replacement || input).focus({ preventScroll: true });
      }
    };
    const render = term => {
      const messageSearch = mode === "messages" && term.length >= 2;
      results.setAttribute("aria-busy", String(messageSearch && loading));
      retry.classList.toggle("hidden", !messageSearch || loading || !failed.size);
      status.textContent = !messageSearch ? "" : loading ? "Searching recent history… Available matches appear below." : failed.size ? `Couldn’t refresh ${failed.size} ${failed.size === 1 ? "room" : "rooms"}. Showing available messages; retry to complete the search.` : `Searched recent history in ${loaded.size} ${loaded.size === 1 ? "room" : "rooms"}. Showing up to 30 matches.`;
      if (!term) { showResults(`<p class="empty-state">${mode === "rooms" ? "Choose a room or start typing to search." : "Type at least two characters to search messages."}</p>`); return; }
      if (mode === "rooms") { showResults(roomResults(term)); return; }
      if (term.length < 2) { showResults(`<p class="empty-state">Type at least two characters to search messages.</p>`); return; }
      showResults(messageResults(term));
    };
    const loadHistory = async id => {
      try {
        const data = await api(`/api/messages?channel=${encodeURIComponent(id)}&guestId=${encodeURIComponent(state.guest.id)}`);
        if (!current()) return;
        const messages = new Map((cache.get(id) || []).map(item => [item.id, item]));
        for (const item of data.messages || []) messages.set(item.id, item);
        cache.set(id, [...messages.values()].sort(messageOrder).slice(-250)); loaded.add(id); failed.delete(id);
      } catch { if (current()) failed.add(id); }
    };
    const loadHistories = () => {
      if (historyPromise || !current()) return;
      historyRequested = true; loading = true; render(input.value.trim().toLowerCase());
      historyPromise = (async () => {
        const rooms = textRooms().filter(item => !loaded.has(item.id));
        for (let i = 0; i < rooms.length && current(); i += 6) {
          await Promise.all(rooms.slice(i, i + 6).map(item => loadHistory(item.id)));
          if (current()) render(input.value.trim().toLowerCase());
        }
      })().finally(() => {
        loading = false; historyPromise = null;
        if (current()) render(input.value.trim().toLowerCase());
      });
    };
    const update = () => {
      const term = input.value.trim().toLowerCase(); render(term);
      if (mode === "messages" && term.length >= 2 && !historyRequested) loadHistories();
    };
    $$("[data-search-mode]").forEach(button => button.onclick = () => {
      mode = button.dataset.searchMode;
      $$("[data-search-mode]").forEach(tab => { const selected = tab === button; tab.classList.toggle("active", selected); tab.setAttribute("aria-pressed", String(selected)); }); update();
    });
    retry.onclick = () => { input.focus(); loadHistories(); };
    input.oninput = update; input.focus(); update();
  }
  function bind() {
    initMessageScrolling();
    setMemberPanel(state.memberPanelOpen, false);
    $("#desktopMembers").onclick = () => setMemberPanel(!state.memberPanelOpen);
    $("#roomsButton").onclick = $("#phoneRooms").onclick = openRoomDirectory;
    document.addEventListener("click", event => {
      const showcaseChoice = event.target.closest("[data-showcase-select]"); if (showcaseChoice) selectShowcase(Number(showcaseChoice.dataset.showcaseSelect));
      if (event.target.closest("[data-compose]")) { setView("chat"); $("#messageInput").focus(); }
      if (event.target.closest("[data-search-open]")) search();
      if (event.target.closest("[data-retry-channel]")) state.connected ? loadChannel(state.active) : start();
      const addChannel = event.target.closest("[data-add-channel]"); if (addChannel) addServerChannelModal(addChannel.dataset.addChannel);
      const inviteServer = event.target.closest("[data-server-invite]"); if (inviteServer) inviteToServer(inviteServer.dataset.serverInvite);
      const channel = event.target.closest("[data-channel]"); if (channel) selectChannel(channel.dataset.channel);
      const directoryRoom = event.target.closest("[data-directory-room]"); if (directoryRoom) return openDirectoryRoom(directoryRoom.dataset.directoryRoom);
      const directoryFollow = event.target.closest("[data-directory-follow]"); if (directoryFollow) return toggleFollow(directoryFollow.dataset.directoryFollow);
      const voiceRoom = event.target.closest("[data-voice-room]"); if (voiceRoom) selectVoiceRoom(voiceRoom.dataset.voiceRoom);
      const searchRoom = event.target.closest("[data-search-room]"); if (searchRoom) { const id = searchRoom.dataset.searchRoom; closeModal(); selectChannel(id); }
      const searchMessage = event.target.closest("[data-search-message]"); if (searchMessage) {
        const id = searchMessage.dataset.searchMessage, channelId = searchMessage.dataset.searchChannel; closeModal();
        selectChannel(channelId).then(() => requestAnimationFrame(() => {
          const target = document.querySelector(`[data-message-id="${CSS.escape(id)}"]`);
          if (target) { pauseMessageFollow(); target.scrollIntoView({ block: "center", behavior: scrollBehavior() }); target.classList.add("search-highlight"); setTimeout(() => target.classList.remove("search-highlight"), 1800); }
        }));
      }
      const track = event.target.closest("[data-track]"); if (track) shareOriginalTrack(track.dataset.track);
      const react = event.target.closest("[data-react]"); if (react) toggleReaction(react.dataset.react, react.dataset.emoji);
      const reactionPicker = event.target.closest("[data-reaction-picker]"); if (reactionPicker) emojiPicker(reactionPicker.dataset.reactionPicker);
      const copy = event.target.closest("[data-copy-message]"); if (copy) copyMessage(copy.dataset.copyMessage);
      const retry = event.target.closest("[data-retry-message]"); if (retry) { const item = (state.messages[state.active] || []).find(item => item.id === retry.dataset.retryMessage); if (item?.failed) sendMessage(item.text, item.id); }
      const retryPlain = event.target.closest("[data-retry-plain]"); if (retryPlain) { const item = (state.messages[state.active] || []).find(item => item.id === retryPlain.dataset.retryPlain); if (item?.failed) sendMessage(item.text, item.id, true); }
      const reply = event.target.closest("[data-reply]"); if (reply) startReply(reply.dataset.reply);
      const original = event.target.closest("[data-jump-reply]"); if (original) jumpToMessage(original.dataset.jumpReply);
    });
    $("#createSpace").onclick = $("#railCreate").onclick = createRoomMenu; $("#createServer").onclick = createServerModal; $("#searchOpen").onclick = $("#mobileSearch").onclick = search; $("#inviteButton").onclick = $("#peopleInvite").onclick = inviteGeneral;
    $("#followButton").onclick = () => toggleFollow();
    $("#manageParty").onclick = partyDeletionModal;
    $("#retryConnection").onclick = start;
    $("#showcasePrevious").onclick = () => selectShowcase(showcaseIndex - 1);
    $("#showcaseNext").onclick = () => selectShowcase(showcaseIndex + 1);
    $("#roomShowcase").onkeydown = showcaseKeydown;
    renderShowcase();
    $("#discoverAccount").onclick = () => state.profile ? profileModal() : authModal();
    $("#helpButton").onclick = $("#peopleRules").onclick = showRules; $("#profileButton").onclick = $("#topProfile").onclick = () => state.profile ? profileModal() : authModal();
    $("#messageForm").onsubmit = e => { e.preventDefault(); sendMessage($("#messageInput").value); };
    $("#cancelReply").onclick = cancelReply;
    $("#messageInput").oninput = e => { saveDraft(); clearTimeout(typingStopTimer); if (e.currentTarget.value.trim()) { if (!localTyping) { clearTimeout(typingTimer); typingTimer = setTimeout(() => sendTyping(true), 180); } typingStopTimer = setTimeout(() => sendTyping(false), 1600); } else { clearTimeout(typingTimer); sendTyping(false); } };
    $("#messageInput").onkeydown = e => { if (e.key === "Enter" && !e.shiftKey && !e.isComposing && e.keyCode !== 229) { e.preventDefault(); clearTimeout(typingTimer); clearTimeout(typingStopTimer); sendTyping(false); sendMessage(e.currentTarget.value); } };
    window.addEventListener("resize", updateComposer);
    $("#emojiButton").onclick = () => emojiPicker();
    $("#musicForm").onsubmit = shareMusic;
    $("#musicForm").oninput = () => { songDraftVersion++; };
    const trackCards = originalTracks.map(([id, title, mood]) => `<button type="button" data-track="${id}" class="track-card"><span aria-hidden="true">♫</span><b>${title}</b><small>${mood}</small><i>Share</i></button>`).join("");
    $("#musicPlayback").innerHTML = `<div id="musicTrack" role="status"></div><div id="musicPlayer"></div><div class="originals"><div class="originals-title"><b>Orbit Originals</b><small>Made for this room</small></div><div class="track-grid">${trackCards}</div></div>`;
    $("#memberSearch").oninput = e => renderMembers(e.target.value.toLowerCase());
    $("#voiceToggle").onclick = () => joinVoice();
    $("#voiceTabJoin").onclick = () => joinVoice("tab");
    $("#voiceMute").onclick = $("#voiceTabMute").onclick = $("#voiceDockMute").onclick = () => { state.muted = !state.muted; return setVoiceDevice(); };
    $("#voiceDeafen").onclick = $("#voiceTabDeafen").onclick = () => { state.deafened = !state.deafened; return setVoiceDevice(); };
    $("#mobileVoice").onclick = () => { state.voiceMobileOpen = !state.voiceMobileOpen; renderVoice(); };
    $("#voiceDockOpen").onclick = () => selectVoiceRoom(state.voiceRoom);
    $("#voiceDockLeave").onclick = () => leaveVoice();
    $$("[data-view]").forEach(button => button.onclick = () => setView(button.dataset.view));
    document.addEventListener("keydown", e => {
      if (accountBusy) { if (e.key === "Tab") { e.preventDefault(); $(".modal")?.focus(); } return; }
      if (e.isComposing) return;
      if (e.key === "Escape" && !$(".modal") && replyDrafts[state.active]) { e.preventDefault(); cancelReply(); return; }
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") { e.preventDefault(); search(); }
      if (e.key === "Escape") { closeModal(); state.voiceMobileOpen = false; renderVoice(); }
      if (e.key === "Tab" && $(".modal")) { const controls = $$(".modal button:not([disabled]), .modal input:not([disabled]), .modal select:not([disabled]), .modal textarea:not([disabled]), .modal a[href]").filter(item => item.getClientRects().length); const first = controls[0], last = controls.at(-1); if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last?.focus(); } else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first?.focus(); } }
    });
    window.addEventListener("pagehide", () => { if (state.voiceRoom) navigator.sendBeacon(`${API_BASE}/api/voice/leave`, new Blob([JSON.stringify({ room: state.voiceRoom, peerId: state.peerId, guestId: state.guest.id })], { type: "application/json" })); relaySocket?.close(); micProcessor?.disconnect(); micSource?.disconnect(); mic?.getTracks().forEach(track => track.stop()); audioContext?.close(); state.stream?.close(); });
  }
  async function start() {
    const version = identityVersion;
    clearTimeout(reconnectTimer); state.loading = true; setConnected(false, "Connecting…"); save(); setView(state.view); renderMessages();
    try {
      const me = await api("/api/me"); if (version !== identityVersion) return;
      state.profile = me.user; chooseDrafts(me.user); await processInvite(version); if (version !== identityVersion) return;
      await bootstrap(); if (version !== identityVersion) return;
      updateIdentity(); setView(state.view); connectLive();
    } catch (error) { if (version !== identityVersion) return; state.loading = false; state.channelErrors[state.active] = error.message; setConnected(false, "Reconnecting…"); renderMessages(); reconnectTimer = setTimeout(start, 8000); }
  }
  bind(); renderMessages(); updateIdentity(); start();
})();
