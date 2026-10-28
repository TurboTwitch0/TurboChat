(() => {
  "use strict";
  const $ = s => document.querySelector(s), $$ = s => [...document.querySelectorAll(s)];
  const localHosts = new Set(["localhost", "127.0.0.1", "::1"]);
  const API_BASE = localHosts.has(location.hostname) && location.port !== "3001" ? `${location.protocol}//${location.hostname}:3001` : "";
  const usePolling = !localHosts.has(location.hostname) && !location.port;
  const appOrigin = API_BASE || location.origin;
  const storageKey = "orbit.chat.v3";
  const VOICE_SAMPLE_RATE = 24000;
  const saved = (() => { try { return JSON.parse(localStorage.getItem(storageKey) || "{}"); } catch { return {}; } })();
  const guest = saved.guest || { id: crypto.randomUUID(), name: `Guest ${100 + Math.floor(Math.random() * 900)}` };
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
  const state = { guest, profile: null, active: saved.active || "global", view: ["discover", "chat", "people", "voice"].includes(saved.view) ? saved.view : "discover", loading: true, channelErrors: {}, rooms: [], parties: [], servers: [], messages: {}, music: null, members: [], registered: 1428, goal: 1500, followingRooms: Array.isArray(saved.followingRooms) ? saved.followingRooms : [], connected: false, stream: null, peerId: crypto.randomUUID(), voiceRoom: "", joiningVoice: false, voiceMembers: [], muted: false, deafened: false, voiceError: "", voiceMobileOpen: false };
  const loadingChannels = new Set();
  let mic = null, audioContext = null, micSource = null, micProcessor = null, relaySocket = null, outputGain = null, outputSchedule = new Map(), toastTimer, reconnectTimer, typingTimer, typingStopTimer, pollTimer, lastEventSeq = 0, lastHeartbeat = 0, lastMessageSync = 0, lastVoiceHeartbeat = 0, localTyping = false, polling = false;
  const typingPeers = new Map();
  const voicePeers = new Map();
  const pendingIce = new Map();
  const voiceSignalQueues = new Map();
  const blockedVoicePeers = new Map();
  const esc = s => String(s ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  const name = () => state.profile?.name || state.guest.name;
  const drafts = saved.drafts && typeof saved.drafts === "object" && !Array.isArray(saved.drafts) ? saved.drafts : {};
  let identityVersion = 0, modalOpener = null;
  const save = () => { try { localStorage.setItem(storageKey, JSON.stringify({ guest: state.guest, active: state.active, view: state.view, followingRooms: state.followingRooms, drafts })); state.storageAvailable = true; return true; } catch { state.storageAvailable = false; return false; } };
  const scrollBehavior = () => window.matchMedia?.("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth";
  function updateComposer() {
    const input = $("#messageInput");
    $("#charCount").textContent = input.value.length;
    input.style.height = "auto"; input.style.height = `${Math.min(input.scrollHeight, 130)}px`;
    $("#draftHint").textContent = input.value ? state.storageAvailable === false ? "Draft kept in this tab" : "Draft saved on this device" : "";
    $("#sendButton").disabled = !state.connected || !input.value.trim();
  }
  function saveDraft() { const value = $("#messageInput").value; if (value) drafts[state.active] = value; else delete drafts[state.active]; save(); updateComposer(); }
  function restoreDraft() { $("#messageInput").value = typeof drafts[state.active] === "string" ? drafts[state.active].slice(0, 700) : ""; updateComposer(); }
  function clearTyping() { clearTimeout(typingTimer); clearTimeout(typingStopTimer); sendTyping(false); for (const [key, value] of typingPeers) if (key.endsWith(":timer")) clearTimeout(value); typingPeers.clear(); renderTyping(); }
  function toast(message) { const el = $("#toast"); el.textContent = message; el.classList.add("show"); clearTimeout(toastTimer); toastTimer = setTimeout(() => el.classList.remove("show"), 3000); }
  async function api(path, options = {}) {
    const response = await fetch(`${API_BASE}${path}`, { credentials: "include", headers: { "Content-Type": "application/json", ...(options.headers || {}) }, ...options });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) { const error = new Error(data.error || `Request failed (${response.status}).`); error.status = response.status; throw error; }
    return data;
  }
  function allRooms() { return [...defaultRooms, ...state.rooms, ...state.parties, ...state.servers.flatMap(server => server.channels.map(channel => ({ ...channel, serverId: server.id, serverName: server.name, emoji: channel.type === "voice" ? "◖" : "#", topic: server.description || `A channel in ${server.name}.` })))]; }
  function room(id) { return allRooms().find(x => x.id === id) || { id, name: "Party", emoji: "✦", topic: "A private room for good people." }; }
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
    const row = item => `<button class="space-row ${state.active === item.id ? "selected" : ""}" data-channel="${esc(item.id)}"><span style="--tile:${esc(item.color || "#6758ad")}">${esc(item.emoji || "✦")}</span><b>${esc(item.name)}</b></button>`;
    $("#spaceList").innerHTML = [...defaultRooms, ...state.rooms, ...state.parties].map(row).join("");
    $("#mobileRoomNav").innerHTML = rooms.map(item => `<button class="mobile-room-chip ${state.active === item.id ? "selected" : ""}" data-channel="${esc(item.id)}" title="${esc(item.name)}"><span>${esc(item.emoji || "✦")}</span>${esc(item.name)}${state.followingRooms.includes(item.id) ? `<i aria-label="Following">★</i>` : ""}</button>`).join("");
    const followed = rooms.filter(item => state.followingRooms.includes(item.id));
    $("#followingSection").classList.toggle("hidden", followed.length === 0);
    $("#followingList").innerHTML = followed.map(row).join("");
    $("#serverList").innerHTML = state.servers.map(server => { const isOwner = server.ownerId === state.profile?.id || server.ownerId === `guest-${state.guest.id}`; return `<section class="server-group"><div class="server-heading"><span>${esc(server.emoji || "✳")} ${esc(server.name)}</span><div><button data-server-invite="${esc(server.id)}" title="Invite to ${esc(server.name)}">↗</button>${isOwner ? `<button data-add-channel="${esc(server.id)}" title="Add channel">＋</button>` : ""}</div></div>${(server.channels || []).map(channel => `<button class="space-row server-channel ${state.active === channel.id ? "selected" : ""}" data-channel="${esc(channel.id)}"><span class="channel-type-icon">${channel.type === "voice" ? "◖" : "#"}</span><b>${esc(channel.name)}</b></button>`).join("")}</section>`; }).join("") || `<div class="server-empty">Make a server to gather your people and add text or voice channels.</div>`;
    renderVoiceRooms();
  }
  function renderMembers(filter = $("#memberSearch").value.toLowerCase()) {
    const members = state.members.filter(item => item.name.toLowerCase().includes(filter));
    $("#onlineCount").textContent = state.members.length; $("#activeMemberCount").textContent = members.length; $("#registeredCount").textContent = state.registered.toLocaleString(); $("#goalCount").textContent = state.registered.toLocaleString();
    $("#goalFill").style.width = `${Math.min(100, state.registered / state.goal * 100)}%`;
    const row = item => `<div class="member-row"><span class="avatar">${esc(item.emoji || "✦")}</span><span><b>${esc(item.name)}${item.id === `guest-${state.guest.id}` ? " <small>(you)</small>" : ""}</b><small>${esc(item.about || (item.registered ? "Registered member" : "Guest"))}</small></span><i class="${esc(item.status || "online")}" title="${esc(item.status || "online")}"></i></div>`;
    $("#memberList").innerHTML = members.length ? members.map(row).join("") : `<div class="empty-state">${state.connected ? "You're here first. Say hello." : "Connecting to the chat…"}</div>`;
    $("#peopleList").innerHTML = members.length ? members.map(item => `<div class="person-card"><span class="avatar">${esc(item.emoji || "✦")}</span><b>${esc(item.name)}</b><small>${item.registered ? "Member" : "Guest"}</small></div>`).join("") : `<div class="empty-state">Invite someone to join you.</div>`;
  }
  function renderMessage(item, i) {
    const reactions = Object.entries(item.reactions || {}).map(([emoji, list]) => `<button class="reaction" data-react="${esc(item.id)}" data-emoji="${esc(emoji)}">${esc(emoji)} ${list.length}</button>`).join("");
    const stamp = new Date(item.createdAt || Date.now());
    const actions = item.pending ? `<span class="message-delivery">Sending…</span>` : item.failed ? `<span class="message-delivery failed">Not sent</span><button class="retry-message" data-retry-message="${esc(item.id)}">Try again</button>` : `${reactions}<button class="reaction" data-react="${esc(item.id)}" data-emoji="💜" aria-label="React with a purple heart">💜 +</button><button class="reply-link" data-reply="${i}">↩ Reply</button>`;
    return `<article class="message ${item.failed ? "message-failed" : ""}" data-message-id="${esc(item.id)}"><span class="avatar">${esc(item.emoji || "✦")}</span><div class="message-body"><div class="message-meta"><b>${esc(item.user || "Guest")}</b>${item.registered ? `<i>member</i>` : ""}<time datetime="${esc(stamp.toISOString())}" title="${esc(stamp.toLocaleString())}">${new Intl.DateTimeFormat([], { hour: "numeric", minute: "2-digit" }).format(stamp)}</time></div><p>${esc(item.text)}</p><div class="message-actions">${actions}</div></div></article>`;
  }
  function renderMessages({ scrollToBottom = false } = {}) {
    const current = room(state.active), items = state.messages[state.active] || [];
    const feed = $("#messages"), previousTop = feed.scrollTop, wasAtBottom = feed.scrollHeight - feed.scrollTop - feed.clientHeight < 140;
    const channelInfo = info[state.active] || [current.name, current.topic || "Come in and say hello.", current.emoji || "✦", current.topic || "A friendly space for good conversation."];
    renderHeader(); $("#topicText").textContent = channelInfo[3];
    const isFollowing = state.followingRooms.includes(state.active);
    $("#followButton").textContent = isFollowing ? "✓ Following" : "✧ Follow";
    $("#followButton").classList.toggle("following", isFollowing);
    $("#followButton").setAttribute("aria-pressed", String(isFollowing));
    $("#messageInput").placeholder = `Message ${channelInfo[0]}…`; $("#musicPanel").classList.toggle("hidden", state.active !== "music");
    if (!items.length && (state.loading || loadingChannels.has(state.active))) {
      feed.setAttribute("aria-busy", "true"); feed.innerHTML = `<div class="conversation-loading" role="status"><span class="loading-orbit" aria-hidden="true">◌</span><b>Finding your conversations</b><p>A little hello is on its way.</p><div class="skeleton-message"></div><div class="skeleton-message short"></div><div class="skeleton-message"></div></div>`; return;
    }
    feed.setAttribute("aria-busy", "false");
    if (!items.length && state.channelErrors[state.active]) {
      feed.innerHTML = `<div class="offline-card"><img src="assets/turbochat-mark.svg" alt="" width="60" height="60"><small>LET’S RECONNECT</small><h2>Your conversation can wait.<br>Your words are still here.</h2><p>We couldn’t load this room. ${state.storageAvailable === false ? "Keep this tab open to keep your draft." : "Your draft stays on this device while you reconnect."}</p><p class="connection-detail">${esc(state.channelErrors[state.active])}</p><button data-retry-channel>Try this room again ↻</button></div>`; return;
    }
    const greeting = `<div class="welcome-card ${items.length ? "has-history" : "is-empty"}"><span>${esc(channelInfo[2])}</span><div><small>${items.length ? "YOUR CONVERSATION" : "A FRESH START"}</small><h2>${state.active === "global" ? "Good conversations start with a hello." : `Make yourself at home in ${esc(channelInfo[0])}.`}</h2><p>${items.length ? "Pick up where the conversation left off." : esc(channelInfo[3])}</p>${items.length ? "" : `<div class="empty-actions"><button class="primary-action" data-compose>Write the first hello <span>↗</span></button><button class="text-action" data-search-open>Find another room</button></div><div class="empty-note">Your message is sent only when you press Send.</div>`}</div></div>${items.length ? `<div class="day-label">CONVERSATION HISTORY</div>` : ""}`;
    let previousDay = "";
    feed.innerHTML = greeting + items.map((item, i) => { const date = new Date(item.createdAt || Date.now()), day = date.toLocaleDateString(); const label = day !== previousDay ? `<div class="day-label">${esc(date.toLocaleDateString([], { month: "long", day: "numeric", year: "numeric" }))}</div>` : ""; previousDay = day; return label + renderMessage(item, i); }).join("");
    if (scrollToBottom || wasAtBottom) feed.scrollTo({ top: feed.scrollHeight, behavior: scrollBehavior() });
    else feed.scrollTop = previousTop;
    $("#voiceRoomName").textContent = `${channelInfo[0]} voice`; renderVoice();
  }
  function mergeMessages(channel, incoming) {
    const existing = state.messages[channel] || [], byId = new Map(existing.map(item => [item.id, item]));
    for (const item of incoming || []) {
      const previous = byId.get(item.id);
      byId.set(item.id, previous ? { ...previous, ...item, reactions: item.reactions ?? previous.reactions } : item);
    }
    const merged = [...byId.values()].sort((a, b) => new Date(a.createdAt || 0) - new Date(b.createdAt || 0)).slice(-250);
    const changed = merged.length !== existing.length || merged.some((item, i) => item.id !== existing[i]?.id || JSON.stringify(item.reactions || {}) !== JSON.stringify(existing[i]?.reactions || {}) || item.pending !== existing[i]?.pending);
    state.messages[channel] = merged;
    return changed;
  }
  function addMessage(channel, item) { if (mergeMessages(channel, [item]) && state.active === channel) renderMessages(); }
  function toggleFollow() {
    const index = state.followingRooms.indexOf(state.active);
    if (index < 0) { state.followingRooms.push(state.active); toast(`Following ${room(state.active).name}. Find it in your sidebar.`); }
    else { state.followingRooms.splice(index, 1); toast(`Unfollowed ${room(state.active).name}.`); }
    save(); renderRoomList(); renderMessages();
  }
  async function loadChannel(id) {
    const version = identityVersion;
    loadingChannels.add(id); delete state.channelErrors[id]; if (state.active === id) renderMessages();
    try { const data = await api(`/api/messages?channel=${encodeURIComponent(id)}&guestId=${encodeURIComponent(state.guest.id)}`); if (version === identityVersion) mergeMessages(id, data.messages || []); }
    catch (error) { if (version === identityVersion) state.channelErrors[id] = error.message; }
    finally { loadingChannels.delete(id); if (version === identityVersion && state.active === id) renderMessages(); }
  }
  async function bootstrap() {
    let data, channel = state.active; const version = identityVersion;
    try { data = await api(`/api/bootstrap?channel=${encodeURIComponent(channel)}&guestId=${encodeURIComponent(state.guest.id)}`); }
    catch (error) {
      if (channel === "global" || ![403, 404].includes(error.status)) throw error;
      if (state.active === channel) state.active = "global"; channel = "global"; save(); toast("That saved room is no longer available. You’re back in World chat.");
      data = await api(`/api/bootstrap?channel=global&guestId=${encodeURIComponent(state.guest.id)}`);
    }
    if (version !== identityVersion) return;
    state.loading = false; delete state.channelErrors[channel];
    state.rooms = data.rooms || []; state.parties = data.parties || []; state.servers = [...new Map((data.servers || []).map(server => [server.id, server])).values()]; mergeMessages(channel, data.messages || []); state.members = data.members || []; state.registered = Number(data.registeredCount) || 1428; state.goal = Number(data.memberGoal) || 1500; state.music = data.music || null; renderRoomList(); renderMessages(); renderMembers(); renderMusic(); restoreDraft();
  }
  function connectLive() {
    state.stream?.close();
    if (usePolling) { clearInterval(pollTimer); pollUpdates(); pollTimer = setInterval(pollUpdates, 1200); return; }
    const query = new URLSearchParams({ guestId: state.guest.id, name: name(), peerId: state.peerId });
    const stream = new EventSource(`${API_BASE}/api/events?${query}`, { withCredentials: true }); state.stream = stream;
    stream.onopen = () => { clearTimeout(reconnectTimer); setConnected(true, "Live"); };
    stream.onerror = () => { setConnected(false, "Reconnecting…"); if (state.voiceRoom) leaveVoice(true); };
    stream.addEventListener("update", event => { let data; try { data = JSON.parse(event.data); } catch { return; } receiveLiveEvent(data); });
  }
  function receiveLiveEvent(data) {
      if (data.type === "message") addMessage(data.channel, data.message);
      if (data.type === "typing" && data.channel === state.active && data.id !== `guest-${state.guest.id}` && data.id !== `user-${state.profile?.id}`) { typingPeers.set(data.id, data.name); renderTyping(); clearTimeout(typingPeers.get(`${data.id}:timer`)); typingPeers.set(`${data.id}:timer`, setTimeout(() => { typingPeers.delete(data.id); renderTyping(); }, 2800)); }
      if (data.type === "typing-stop") { const timer = typingPeers.get(`${data.id}:timer`); if (timer) clearTimeout(timer); typingPeers.delete(data.id); typingPeers.delete(`${data.id}:timer`); if (data.channel === state.active) renderTyping(); }
      if (data.type === "reaction") { const item = (state.messages[data.channel] || []).find(m => m.id === data.messageId); if (item) { item.reactions = data.reactions; if (state.active === data.channel) renderMessages(); } }
      if (data.type === "presence") { state.members = data.members || []; state.registered = Number(data.registeredCount) || 1428; renderMembers(); }
      if (data.type === "room" && data.room?.type !== "party" && !state.rooms.some(r => r.id === data.room.id)) { state.rooms.unshift(data.room); renderRoomList(); }
      if (data.type === "server" && data.server) { const index = state.servers.findIndex(server => server.id === data.server.id); if (index < 0) state.servers.unshift(data.server); else state.servers[index] = data.server; renderRoomList(); }
      if (data.type === "music") { state.music = data.track; renderMusic(); }
      if (data.type === "voice" && data.room === (state.voiceRoom || state.joiningVoice)) {
        state.voiceMembers = data.participants || []; renderVoice();
        if (state.voiceRoom) connectToVoiceMembers(state.voiceMembers).catch(error => { state.voiceError = error.message; renderVoice(); });
      }
      if (data.type === "signal" && data.room === state.voiceRoom && data.to === state.peerId) {
        if ((blockedVoicePeers.get(data.from) || 0) > Date.now()) return;
        handleVoiceSignal(data).catch(error => {
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
      for (const event of result.events || []) receiveLiveEvent(event);
      if (state.voiceRoom && Date.now() - lastVoiceHeartbeat > 5000) {
        const voice = await api("/api/voice/join", { method: "POST", body: JSON.stringify({ room: state.voiceRoom, peerId: state.peerId, guestId: state.guest.id, guestName: name() }) });
        lastVoiceHeartbeat = Date.now(); state.voiceMembers = voice.participants || []; renderVoice();
        await connectToVoiceMembers(state.voiceMembers);
      }
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
    } catch { setConnected(false, "Reconnecting…"); } finally { polling = false; }
  }
  function renderTyping() { const names = [...typingPeers.entries()].filter(([key]) => !key.endsWith(":timer")).map(([, value]) => value); $("#typingIndicator").textContent = names.length ? `${names.slice(0, 2).join(", ")}${names.length > 2 ? ` and ${names.length - 2} others` : names.length === 1 ? " is" : " are"} typing…` : ""; }
  function sendTyping(typing) { if (localTyping === typing) return; localTyping = typing; api("/api/typing", { method: "POST", body: JSON.stringify({ channel: state.active, typing, guestId: state.guest.id, guestName: name() }) }).catch(() => {}); }
  async function sendMessage(value, retryId = "") {
    const content = value.trim(); if (!content || !state.connected) return;
    const channel = state.active, version = identityVersion;
    if (retryId) state.messages[channel] = (state.messages[channel] || []).filter(item => item.id !== retryId);
    else { $("#messageInput").value = ""; saveDraft(); }
    clearTyping();
    const tempId = `pending-${crypto.randomUUID()}`, pending = { id: tempId, user: name(), emoji: state.profile?.emoji || "✦", text: content, createdAt: new Date().toISOString(), reactions: {}, pending: true };
    mergeMessages(channel, [pending]); if (state.active === channel) renderMessages({ scrollToBottom: true });
    try { const result = await api("/api/messages", { method: "POST", body: JSON.stringify({ channel, text: content, guestId: state.guest.id, guestName: name() }) }); if (version !== identityVersion) return; state.messages[channel] = (state.messages[channel] || []).filter(item => item.id !== tempId); mergeMessages(channel, [result.message]); if (state.active === channel) renderMessages({ scrollToBottom: true }); }
    catch (error) { if (version !== identityVersion) return; const item = (state.messages[channel] || []).find(item => item.id === tempId); if (item) { item.pending = false; item.failed = true; } if (state.active === channel) renderMessages(); toast(`${error.message} Your message is kept above. Use Try again to resend.`); }
  }
  async function selectChannel(id) {
    if (!allRooms().some(item => item.id === id)) return;
    saveDraft(); clearTyping();
    if (state.voiceRoom && state.voiceRoom !== id) await leaveVoice(true);
    state.active = id; save(); restoreDraft(); renderRoomList();
    if (room(id).type === "voice") { $("#voiceTabRoomName").textContent = room(id).name; setView("voice"); renderVoiceRooms(); return; }
    setView("chat"); renderMessages(); await loadChannel(id);
  }
  function modal(title, subtitle, body) {
    if (!$("#modalRoot").childElementCount) modalOpener = document.activeElement;
    $("#modalRoot").innerHTML = `<div class="modal-backdrop"><section class="modal" role="dialog" aria-modal="true" aria-labelledby="modalTitle" aria-describedby="modalDescription"><button class="modal-close" data-close aria-label="Close dialog">×</button><div class="modal-brand"><img src="assets/turbochat-mark.svg" alt="" width="30" height="30"><span>TurboChat</span></div><h2 id="modalTitle">${esc(title)}</h2><p id="modalDescription">${esc(subtitle)}</p>${body}</section></div>`;
    $(".app-shell").inert = true; $("#mobileVoice").inert = true;
    $("[data-close]").addEventListener("click", closeModal); $(".modal-backdrop").addEventListener("click", e => { if (e.target.classList.contains("modal-backdrop")) closeModal(); });
    ($(".modal input:not([readonly])") || $(".modal button:not([data-close])") || $("[data-close]")).focus();
  }
  function closeModal() { $("#modalRoot").innerHTML = ""; $(".app-shell").inert = false; $("#mobileVoice").inert = false; if (modalOpener?.isConnected) modalOpener.focus(); modalOpener = null; }
  function createRoomMenu() {
    modal("Make a place for your people.", "Create an open room or a private party.", `<div class="modal-actions"><button id="makeRoom" class="modal-choice"><b>✳ Community room</b><small>Anyone can find and join.</small></button><button id="makeParty" class="modal-choice"><b>✦ Invite-only party</b><small>Only people with your invite can enter.</small></button></div>`);
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
    modal(isParty ? "Start a party." : "Start a community room.", "Give people a good reason to join the conversation.", `<form id="roomForm"><label>Name<input id="roomName" required minlength="2" maxlength="42" placeholder="${isParty ? "Friday night crew" : "Book lovers unite"}"></label><label>Conversation starter<input id="roomTopic" maxlength="100" placeholder="What should people talk about?"></label><button class="submit-button">Create ${isParty ? "party" : "room"} →</button></form>`);
    $("#roomForm").onsubmit = async event => {
      event.preventDefault(); const button = event.currentTarget.querySelector("button"); button.disabled = true;
      try {
        const result = await api(isParty ? "/api/parties" : "/api/rooms", { method: "POST", body: JSON.stringify({ name: $("#roomName").value.trim(), topic: $("#roomTopic").value.trim(), owner: name(), guestId: state.guest.id }) });
        if (isParty) state.parties.unshift(result.room); else state.rooms.unshift(result.room);
        saveDraft(); clearTyping(); state.active = result.room.id; save(); restoreDraft(); await loadChannel(state.active); closeModal(); renderRoomList(); renderMessages();
        if (isParty) inviteCreated(result.room, result.inviteCode); else toast("Your room is open to everyone.");
      } catch (error) { toast(error.message); button.disabled = false; }
    };
  }
  function packInvite(data) { return btoa(unescape(encodeURIComponent(JSON.stringify(data)))).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, ""); }
  function inviteCreated(item, code, kind = "party") {
    const link = `${appOrigin}${location.pathname}?invite=${packInvite({ kind, id: item.id, inviteCode: code, name: item.name, topic: item.topic })}`;
    modal(`Invite someone to ${item.name}.`, kind === "server" ? "Anyone with this link can join your server." : "Anyone with this invite can join your private party.", `<div class="invite-box"><input id="inviteLink" readonly value="${esc(link)}"><button id="copyInvite" class="submit-button">Copy invite</button></div><button id="doneInvite" class="subtle-button">Done</button>`);
    $("#copyInvite").onclick = async () => { try { await navigator.clipboard.writeText(link); toast("Invite copied."); } catch { $("#inviteLink").select(); document.execCommand("copy"); toast("Invite copied."); } };
    $("#doneInvite").onclick = closeModal;
  }
  async function processInvite() {
    const encoded = new URLSearchParams(location.search).get("invite"); if (!encoded) return;
    try {
      const data = JSON.parse(decodeURIComponent(escape(atob(encoded.replace(/-/g, "+").replace(/_/g, "/")))));
      if (data.kind === "server") {
        const result = await api("/api/servers/join", { method: "POST", body: JSON.stringify({ id: data.id, inviteCode: data.inviteCode, guestId: state.guest.id }) });
        state.servers = state.servers.filter(server => server.id !== result.server.id); state.servers.unshift(result.server); state.active = result.server.channels[0].id; renderRoomList();
      } else {
        const result = await api("/api/parties/join", { method: "POST", body: JSON.stringify({ id: data.id, inviteCode: data.inviteCode, guestId: state.guest.id }) });
        state.parties = (state.parties || []).filter(item => item.id !== result.room.id); state.parties.unshift(result.room); state.active = result.room.id;
      }
      state.view = "chat"; save(); history.replaceState({}, "", location.pathname); toast(`You joined ${data.name || "the server"}.`);
    } catch (error) { history.replaceState({}, "", location.pathname); toast(error.message); }
  }
  function inviteGeneral() {
    const link = `${appOrigin}${location.pathname}`;
    modal("Invite someone to Orbit.", "Send this link so a friend can join the conversation.", `<div class="invite-box"><input id="inviteLink" readonly value="${esc(link)}"><button id="copyInvite" class="submit-button">Copy link</button></div>`);
    $("#copyInvite").onclick = async () => { try { await navigator.clipboard.writeText(link); toast("Invite copied."); } catch { $("#inviteLink").select(); document.execCommand("copy"); toast("Invite copied."); } };
  }
  function authModal(mode = "login") {
    const register = mode === "register";
    modal(register ? "Make room for you." : "Your people are a hello away.", register ? "Create a TurboChat account to keep your profile and server memberships." : "Sign in to your TurboChat account. You can also keep exploring as a guest.", `<div class="auth-tabs"><button id="toLogin" class="${register ? "" : "active"}">Sign in</button><button id="toRegister" class="${register ? "active" : ""}">Create account</button></div><form id="authForm">${register ? `<label>Display name<input id="authName" required minlength="2" maxlength="32" autocomplete="nickname" placeholder="What should we call you?"></label>` : ""}<label>Email<input id="authEmail" type="email" required autocomplete="email" autocapitalize="none" spellcheck="false" placeholder="you@example.com"></label><label>Password<input id="authPassword" type="password" required minlength="${register ? "8" : "1"}" maxlength="128" autocomplete="${register ? "new-password" : "current-password"}" placeholder="${register ? "At least 8 characters" : "Your password"}"></label><button type="button" id="togglePassword" class="password-toggle" aria-pressed="false">Show password</button><p id="authError" class="auth-error" role="alert"></p><button class="submit-button">${register ? "Create account" : "Sign in"} <span aria-hidden="true">↗</span></button></form>${state.profile ? `<button id="logout" class="subtle-button">Sign out</button>` : ""}<div class="guest-divider"><span>or take a look around</span></div><button id="guestMode" class="subtle-button guest-action">Continue as ${esc(state.guest.name)} →</button>`);
    $("#togglePassword").onclick = () => { const input = $("#authPassword"), show = input.type === "password"; input.type = show ? "text" : "password"; $("#togglePassword").textContent = show ? "Hide password" : "Show password"; $("#togglePassword").setAttribute("aria-pressed", String(show)); };
    $("#toLogin").onclick = () => authModal("login"); $("#toRegister").onclick = () => authModal("register");
    $("#authForm").onsubmit = async e => {
      e.preventDefault(); const button = e.currentTarget.querySelector(".submit-button"); button.disabled = true; button.textContent = register ? "Creating account…" : "Signing in…";
      try {
        const endpoint = register ? "/api/register" : "/api/login";
        const result = await api(endpoint, { method: "POST", body: JSON.stringify({ name: register ? $("#authName").value.trim() : undefined, email: $("#authEmail").value.trim(), password: $("#authPassword").value, guestId: state.guest.id }) });
        const session = await api("/api/me");
        if (!session.user || session.user.id !== result.user?.id) throw new Error("Your account was accepted, but this browser did not receive its sign-in session. Check cookies for this site and try again.");
        await refreshIdentity(session.user); closeModal(); toast(`Welcome, ${session.user.name}.`);
      } catch (error) { if ($("#authError")) $("#authError").textContent = error.message; button.disabled = false; button.textContent = register ? "Create account" : "Sign in"; }
    };
    $("#guestMode").onclick = () => state.profile ? signOut() : closeModal();
    if ($("#logout")) $("#logout").onclick = signOut;
  }
  function profileModal() {
    if (!state.profile) return authModal("login");
    const emojis = ["✦","🌙","🌻","🦊","🐸","🐈","🎧","🚀","🌊","⭐","🍄","🪐"];
    modal("Your profile", "Make your little corner feel like you.", `<form id="profileForm"><label>Display name<input id="profileName" required minlength="2" maxlength="32" value="${esc(state.profile.name)}" autocomplete="nickname"></label><label>Avatar<select id="profileEmoji">${emojis.map(emoji => `<option value="${emoji}" ${state.profile.emoji === emoji ? "selected" : ""}>${emoji}</option>`).join("")}</select></label><label>About me<input id="profileAbout" maxlength="100" value="${esc(state.profile.about || "")}" placeholder="A little about you"></label><label>Status<select id="profileStatus"><option value="online" ${state.profile.status !== "idle" && state.profile.status !== "dnd" ? "selected" : ""}>Online</option><option value="idle" ${state.profile.status === "idle" ? "selected" : ""}>Idle</option><option value="dnd" ${state.profile.status === "dnd" ? "selected" : ""}>Do not disturb</option></select></label><p id="profileError" class="auth-error" role="alert"></p><button class="submit-button">Save profile</button></form><button id="profileSignOut" class="subtle-button">Sign out</button>`);
    $("#profileForm").onsubmit = async event => {
      event.preventDefault(); const button = event.currentTarget.querySelector(".submit-button"); button.disabled = true; button.textContent = "Saving…";
      try {
        const result = await api("/api/profile", { method: "POST", body: JSON.stringify({ name: $("#profileName").value.trim(), emoji: $("#profileEmoji").value, about: $("#profileAbout").value.trim(), status: $("#profileStatus").value }) });
        state.profile = result.user; closeModal(); updateIdentity(); renderMembers(); renderMessages(); connectLive(); toast("Profile saved.");
      } catch (error) { $("#profileError").textContent = error.message; button.disabled = false; button.textContent = "Save profile"; }
    };
    $("#profileSignOut").onclick = signOut;
  }
  async function refreshIdentity(profile) {
    saveDraft(); clearTyping(); identityVersion++; state.stream?.close(); clearInterval(pollTimer);
    state.profile = profile; state.messages = {}; state.parties = []; state.servers = []; state.members = []; lastEventSeq = 0; lastHeartbeat = 0; lastMessageSync = 0;
    updateIdentity(); renderRoomList(); renderMessages(); renderMembers();
    try { await bootstrap(); } finally { connectLive(); }
  }
  async function signOut() {
    const button = $("#profileSignOut") || $("#logout"); if (button) button.disabled = true;
    try {
      saveDraft(); clearTyping();
      if (state.voiceRoom) await leaveVoice(true);
      await api("/api/logout", { method: "POST", body: "{}" });
      for (const id of [...state.parties.map(item => item.id), ...state.servers.flatMap(item => item.channels.map(channel => channel.id))]) delete drafts[id];
      state.active = "global"; restoreDraft(); await refreshIdentity(null); closeModal(); toast("Signed out.");
    } catch (error) { toast(error.message); if (button) button.disabled = false; }
  }
  function updateIdentity() { $("#identityHint").textContent = state.profile ? `Signed in as ${state.profile.name}` : `Chatting as ${state.guest.name}`; $("#profileButton").textContent = state.profile?.emoji || (state.profile ? state.profile.name[0].toUpperCase() : "G"); $("#topProfile").textContent = state.profile ? `${state.profile.emoji || "◉"} ${state.profile.name}` : "Sign in"; $("#discoverAccount").textContent = state.profile ? "Your profile ↗" : "Sign in to your space ↗"; $("#discoverIdentity").textContent = state.profile ? `Welcome back, ${state.profile.name}. Your next conversation is waiting.` : "No introduction needed. Explore as a guest, or sign in to your profile."; }
  function renderMusic() {
    const builtins = [
      ["neon", "Neon Postcards", "Retro pop · 112 BPM", "neon-postcards.wav"], ["midnight", "Midnight Arcade", "Synthwave · 118 BPM", "midnight-arcade.wav"], ["dreamwave", "Dreamwave Radio", "Dream pop · 96 BPM", "dreamwave-radio.wav"], ["orbit", "Slow Orbit", "Ambient pop · 82 BPM", "slow-orbit.wav"]
    ];
    const library = `<div class="originals"><div class="originals-title"><b>Orbit Originals</b><small>Made for this room</small></div><div class="track-grid">${builtins.map(([id, title, mood]) => `<button data-track="${id}" class="track-card"><span>♫</span><b>${title}</b><small>${mood}</small><i>Play</i></button>`).join("")}</div></div>`;
    if (!state.music) { $("#musicPlayback").innerHTML = `<div class="no-track">♫ <b>No song is playing yet.</b><small>Pick an original track below.</small></div>${library}`; return; }
    let url; try { url = new URL(state.music.url); } catch { state.music = null; return renderMusic(); }
    const yt = url.hostname.includes("youtu") ? (url.hostname === "youtu.be" ? url.pathname.slice(1) : url.searchParams.get("v") || "") : "";
    let player = yt && /^[\w-]{11}$/.test(yt) ? `<iframe class="embed-player" src="https://www.youtube-nocookie.com/embed/${encodeURIComponent(yt)}?rel=0" title="${esc(state.music.title)}" allow="autoplay; encrypted-media; picture-in-picture" allowfullscreen></iframe>` : url.hostname.includes("soundcloud.com") ? `<iframe class="embed-player" src="https://w.soundcloud.com/player/?url=${encodeURIComponent(url.href)}&auto_play=false" title="${esc(state.music.title)}" allow="autoplay"></iframe>` : `<audio controls preload="metadata" src="${esc(url.href)}"></audio>`;
    $("#musicPlayback").innerHTML = `<div class="current-track"><span>♫</span><div><b>${esc(state.music.title)}</b><small>Shared by ${esc(state.music.submittedBy)}</small></div></div>${player}${library}`;
  }
  async function playBuiltin(id) {
    const files = { neon: ["Neon Postcards", "neon-postcards.wav"], midnight: ["Midnight Arcade", "midnight-arcade.wav"], dreamwave: ["Dreamwave Radio", "dreamwave-radio.wav"], orbit: ["Slow Orbit", "slow-orbit.wav"] };
    if (!files[id]) return;
    try { const [title, file] = files[id]; const result = await api("/api/music", { method: "POST", body: JSON.stringify({ title, url: new URL(`/media/${file}`, appOrigin).href, guestName: name() }) }); state.music = result.track; renderMusic(); toast(`${title} is ready. Press play to listen.`); }
    catch (error) { toast(error.message); }
  }
  async function shareMusic(event) {
    event.preventDefault(); const button = event.currentTarget.querySelector("button"); button.disabled = true;
    try { const result = await api("/api/music", { method: "POST", body: JSON.stringify({ title: $("#musicTitle").value.trim(), url: $("#musicUrl").value.trim(), guestName: name() }) }); state.music = result.track; renderMusic(); event.currentTarget.reset(); toast("Song shared in Now Playing."); }
    catch (error) { toast(error.message); } finally { button.disabled = false; }
  }
  function renderVoiceRooms() {
    const rooms = allRooms();
    $("#voiceRoomList").innerHTML = rooms.map(item => `<button class="voice-room-option ${state.active === item.id ? "selected" : ""}" data-voice-room="${esc(item.id)}"><span>${esc(item.emoji || "✦")}</span><b>${esc(item.name)}</b><small>${state.voiceRoom === item.id ? "● In voice" : "Open room"}</small></button>`).join("");
  }
  async function selectVoiceRoom(id) {
    await selectChannel(id); renderVoice();
  }
  function renderHeader() {
    const current = room(state.active), details = info[state.active] || [current.name, current.topic || "Come in and say hello.", current.emoji || "✦"];
    const headings = { discover: ["Explore TurboChat", "Find your people. Keep the conversation going.", "✳"], people: ["Your people", "Good conversations bring us a little closer.", "♧"] };
    const heading = headings[state.view] || details;
    $("#channelTitle").textContent = heading[0]; $("#channelSubtitle").textContent = heading[1]; $("#channelGlyph").textContent = heading[2];
  }
  function setView(view) {
    if (!["discover", "chat", "people", "voice"].includes(view)) return;
    state.view = view; save(); renderHeader();
    ["discover", "chat", "people", "voice"].forEach(name => $(`#${name}View`).classList.toggle("hidden", name !== view));
    $("#mobileRoomNav").classList.toggle("is-hidden", view !== "chat");
    $$('[data-view]').forEach(button => { button.classList.toggle("active", button.dataset.view === view); button.setAttribute("aria-pressed", String(button.dataset.view === view)); });
    if (view === "voice") renderVoiceRooms();
  }
  function renderVoice() {
    const self = !!state.voiceRoom, others = state.voiceMembers.filter(item => item.peerId !== state.peerId);
    const status = state.voiceError || (!state.connected ? "Connect to chat first" : !self ? "Join voice to start talking" : usePolling ? `Peer voice connected · ${others.length ? `${others.length} ${others.length === 1 ? "person" : "people"} here` : "waiting for someone"}` : relaySocket?.readyState === WebSocket.OPEN ? `Voice audio connected · ${others.length ? `${others.length} ${others.length === 1 ? "person" : "people"} here` : "waiting for someone"}` : "Connecting voice audio…");
    const participants = self ? state.voiceMembers.map(item => `<span class="voice-person ${(item.peerId === state.peerId ? state.muted || state.deafened : item.muted || item.deafened) ? "muted" : ""}">${item.muted || item.deafened ? "⌁" : "◖"} ${esc(item.name)}${item.peerId === state.peerId ? " (you)" : ""}</span>`).join("") : "";
    $("#voiceRoomName").textContent = `${room(state.active).name} voice`; $("#voiceToggle").textContent = state.joiningVoice ? "Joining…" : self ? "Leave voice" : "Join voice";
    $("#voiceToggle").disabled = state.joiningVoice || (!state.connected && !self); $("#voiceMute").classList.toggle("hidden", !self); $("#voiceDeafen").classList.toggle("hidden", !self);
    $("#voiceMute").textContent = state.muted ? "Unmute" : "Mute"; $("#voiceDeafen").textContent = state.deafened ? "Undeafen" : "Deafen"; $("#voiceStatus").textContent = status;
    $("#voiceDot").classList.toggle("active", self || state.voiceMembers.length > 0); $("#mobileVoiceCount").textContent = state.voiceMembers.length;
    $("#rightPanel").classList.toggle("mobile-open", self || state.voiceMobileOpen); $("#voiceParticipants").innerHTML = participants;
    $("#voiceTabRoomName").textContent = `${room(state.active).name} voice`; $("#voiceTabStatus").textContent = status; $("#voiceTabDot").classList.toggle("active", self);
    $("#voiceTabParticipants").innerHTML = participants || `<p>${self ? "You’re connected. Waiting for someone to join." : "It’s quiet here. Be the first to join."}</p>`;
    $("#voiceTabJoin").textContent = state.joiningVoice ? "Joining…" : self ? "Leave voice" : "Join voice"; $("#voiceTabJoin").disabled = state.joiningVoice || (!state.connected && !self);
    $("#voiceTabMute").classList.toggle("hidden", !self); $("#voiceTabDeafen").classList.toggle("hidden", !self); $("#voiceTabMute").textContent = state.muted ? "Unmute" : "Mute"; $("#voiceTabDeafen").textContent = state.deafened ? "Undeafen" : "Deafen";
    $("#mobileVoice").classList.toggle("joined", self); $(".voice-wave").classList.toggle("is-active", self && !state.muted && !state.deafened && !state.voiceError); renderVoiceRooms();
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
  async function joinVoice() {
    if (usePolling) return joinVoiceWebRTC();
    if (state.voiceRoom) return leaveVoice(); if (!state.connected) return toast("Wait for chat to reconnect before joining voice.");
    state.joiningVoice = true; state.voiceError = ""; renderVoice();
    try {
      if (!navigator.mediaDevices?.getUserMedia) throw new Error("Microphone access needs HTTPS or localhost.");
      audioContext = new AudioContext(); await audioContext.resume();
      mic = await captureVoiceMic();
      state.joiningVoice = state.active;
      const result = await api("/api/voice/join", { method: "POST", body: JSON.stringify({ room: state.active, peerId: state.peerId, guestId: state.guest.id }) });
      state.voiceRoom = state.active; state.joiningVoice = false; state.voiceMembers = result.participants || []; connectVoiceAudio(); renderVoice();
    } catch (error) { state.joiningVoice = false; mic?.getTracks().forEach(track => track.stop()); mic = null; if (audioContext) await audioContext.close().catch(() => {}); audioContext = null; renderVoice(); toast(error.message); }
  }
  async function leaveVoice(silent = false) {
    const previous = state.voiceRoom || state.joiningVoice;
    if (state.voiceRoom) api("/api/voice/leave", { method: "POST", body: JSON.stringify({ room: state.voiceRoom, peerId: state.peerId, guestId: state.guest.id }) }).catch(() => {});
    for (const pc of voicePeers.values()) { clearTimeout(pc.__orbitOfferRetry); pc.close(); } voicePeers.clear(); pendingIce.clear(); voiceSignalQueues.clear(); blockedVoicePeers.clear(); $("#remoteAudio").replaceChildren();
    const socket = relaySocket; relaySocket = null; socket?.close(); micProcessor?.disconnect(); micSource?.disconnect(); outputGain?.disconnect(); micProcessor = null; micSource = null; outputGain = null;
    mic?.getTracks().forEach(track => track.stop()); mic = null; if (audioContext) await audioContext.close().catch(() => {}); audioContext = null; outputSchedule.clear();
    state.voiceRoom = ""; state.joiningVoice = false; state.voiceMembers = []; state.muted = false; state.deafened = false; state.voiceError = ""; lastVoiceHeartbeat = 0; renderVoice(); if (!silent && previous) toast("You left voice.");
  }
  async function setVoiceDevice() {
    mic?.getAudioTracks().forEach(track => track.enabled = !state.muted && !state.deafened); if (outputGain) outputGain.gain.value = state.deafened ? 0 : 1; $("#remoteAudio").querySelectorAll("audio").forEach(audio => audio.muted = state.deafened); renderVoice();
    if (!state.voiceRoom) return;
    try { await api("/api/voice/state", { method: "POST", body: JSON.stringify({ room: state.voiceRoom, peerId: state.peerId, muted: state.muted, deafened: state.deafened, guestId: state.guest.id }) }); } catch (error) { toast(error.message); }
  }
  async function sendVoiceSignal(targetId, signal) {
    const previous = voiceSignalQueues.get(targetId) || Promise.resolve();
    const next = previous.catch(() => {}).then(() => api("/api/voice/signal", { method: "POST", body: JSON.stringify({ room: state.voiceRoom, peerId: state.peerId, targetId, signal, guestId: state.guest.id }) }));
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
      if (participant.peerId === state.peerId) continue;
      // One side creates the offer, even when both users join at nearly the same time.
      try { await connectVoicePeer(participant.peerId, state.peerId > participant.peerId); }
      catch (error) {
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
    pc.ontrack = event => { let audio = document.querySelector(`[data-peer-audio="${CSS.escape(peerId)}"]`); if (!audio) { audio = document.createElement("audio"); audio.autoplay = true; audio.playsInline = true; audio.dataset.peerAudio = peerId; audio.muted = state.deafened; $("#remoteAudio").append(audio); } audio.srcObject = event.streams[0] || new MediaStream([event.track]); audio.play().catch(() => { state.voiceError = "Voice connected. Tap the page once to enable audio playback."; renderVoice(); }); };
    pc.onconnectionstatechange = () => {
      if (pc.connectionState === "connected") clearTimeout(pc.__orbitOfferRetry);
      if (["failed", "disconnected"].includes(pc.connectionState)) { state.voiceError = "A peer voice connection was interrupted. Rejoin the voice room."; renderVoice(); }
    };
    if (offerer) {
      const offer = await pc.createOffer(); await pc.setLocalDescription(offer); await waitForIceGathering(pc);
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
  async function joinVoiceWebRTC() {
    if (state.voiceRoom) return leaveVoice(); if (!state.connected) return toast("Wait for chat to reconnect before joining voice.");
    if (!navigator.mediaDevices?.getUserMedia || !window.RTCPeerConnection) return toast("This browser does not support secure WebRTC voice.");
    state.joiningVoice = state.active; state.voiceError = ""; renderVoice();
    try {
      mic = await captureVoiceMic();
      const result = await api("/api/voice/join", { method: "POST", body: JSON.stringify({ room: state.active, peerId: state.peerId, guestId: state.guest.id, guestName: name() }) });
      state.voiceRoom = state.active; state.joiningVoice = false; state.voiceMembers = result.participants || []; renderVoice();
      lastVoiceHeartbeat = Date.now(); blockedVoicePeers.clear(); await connectToVoiceMembers(state.voiceMembers);
    } catch (error) { state.joiningVoice = false; mic?.getTracks().forEach(track => track.stop()); mic = null; for (const pc of voicePeers.values()) pc.close(); voicePeers.clear(); state.voiceError = error.message; renderVoice(); toast(error.message); }
  }
  function showRules() { modal("A small promise to each other.", "Orbit works best when everyone gets to be a person here.", `<ul class="rules"><li>Be curious before you judge. People arrive with different stories.</li><li>Make room for quieter voices. A thoughtful reply goes a long way.</li><li>Keep personal information personal. Share only what feels right to you.</li><li>If someone asks you to stop, let the conversation breathe.</li></ul>`); }
  function search() {
    modal("Find a conversation.", "Search rooms or find a message in your conversations.", `<input id="searchInput" class="search-input" aria-label="Search rooms and messages" placeholder="Try music, travel, or a message…" autocomplete="off"><div class="search-tabs"><button class="active" data-search-mode="rooms">Rooms</button><button data-search-mode="messages">Messages</button></div><div id="searchResults" class="search-results" aria-live="polite"></div>`);
    let mode = "rooms", historyPromise = null;
    const cache = new Map(Object.entries(state.messages));
    const results = $("#searchResults"), input = $("#searchInput");
    const roomResults = term => allRooms().filter(item => item.name.toLowerCase().includes(term) || (item.topic || "").toLowerCase().includes(term)).map(item => `<button data-search-room="${esc(item.id)}">${esc(item.emoji || "✦")} ${esc(item.name)}<small>${esc(item.topic || "")}</small></button>`).join("") || `<p class="empty-state">No matching room yet.</p>`;
    const messageResults = term => {
      const words = term.split(/\s+/).filter(Boolean), hits = [];
      for (const [channel, messages] of cache) for (const item of messages) {
        const content = String(item.text || "").toLowerCase();
        if (words.every(word => content.includes(word))) hits.push({ channel, item });
      }
      hits.sort((a, b) => new Date(b.item.createdAt || 0) - new Date(a.item.createdAt || 0));
      return hits.slice(0, 30).map(({ channel, item }) => `<button class="message-search-result" data-search-message="${esc(item.id)}" data-search-channel="${esc(channel)}"><b>${esc(item.user || "Guest")} <small>in ${esc(room(channel).name)}</small></b><span>${esc(String(item.text || "").slice(0, 180))}</span></button>`).join("") || `<p class="empty-state">No matching messages yet.</p>`;
    };
    const render = term => {
      if (!term) { results.innerHTML = `<p class="empty-state">${mode === "rooms" ? "Choose a room or start typing to search." : "Type at least two characters to search messages."}</p>`; return; }
      if (mode === "rooms") { results.innerHTML = roomResults(term); return; }
      if (term.length < 2) { results.innerHTML = `<p class="empty-state">Type at least two characters to search messages.</p>`; return; }
      results.innerHTML = messageResults(term);
    };
    const loadHistory = async id => {
      if (cache.has(id)) return;
      try { const data = await api(`/api/messages?channel=${encodeURIComponent(id)}&guestId=${encodeURIComponent(state.guest.id)}`); cache.set(id, data.messages || []); }
      catch { cache.set(id, []); }
    };
    const update = () => {
      const term = input.value.trim().toLowerCase();
      render(term);
      if (mode !== "messages" || term.length < 2 || historyPromise) return;
      results.innerHTML = `<p class="empty-state">Searching your conversations…</p>`;
      historyPromise = (async () => {
        const rooms = allRooms();
        for (let i = 0; i < rooms.length; i += 6) await Promise.all(rooms.slice(i, i + 6).map(item => loadHistory(item.id)));
      })().finally(() => { if (input.isConnected && mode === "messages") render(input.value.trim().toLowerCase()); });
    };
    $$("[data-search-mode]").forEach(button => button.onclick = () => { mode = button.dataset.searchMode; $$("[data-search-mode]").forEach(tab => tab.classList.toggle("active", tab === button)); update(); });
    input.oninput = update; input.focus(); update();
  }
  function bind() {
    document.addEventListener("click", event => {
      if (event.target.closest("[data-compose]")) { setView("chat"); $("#messageInput").focus(); }
      if (event.target.closest("[data-search-open]")) search();
      if (event.target.closest("[data-retry-channel]")) state.connected ? loadChannel(state.active) : start();
      const addChannel = event.target.closest("[data-add-channel]"); if (addChannel) addServerChannelModal(addChannel.dataset.addChannel);
      const inviteServer = event.target.closest("[data-server-invite]"); if (inviteServer) inviteToServer(inviteServer.dataset.serverInvite);
      const channel = event.target.closest("[data-channel]"); if (channel) selectChannel(channel.dataset.channel);
      const voiceRoom = event.target.closest("[data-voice-room]"); if (voiceRoom) selectVoiceRoom(voiceRoom.dataset.voiceRoom);
      const searchRoom = event.target.closest("[data-search-room]"); if (searchRoom) { const id = searchRoom.dataset.searchRoom; closeModal(); selectChannel(id); }
      const searchMessage = event.target.closest("[data-search-message]"); if (searchMessage) {
        const id = searchMessage.dataset.searchMessage, channelId = searchMessage.dataset.searchChannel; closeModal();
        selectChannel(channelId).then(() => requestAnimationFrame(() => {
          const target = document.querySelector(`[data-message-id="${CSS.escape(id)}"]`);
          if (target) { target.scrollIntoView({ block: "center", behavior: scrollBehavior() }); target.classList.add("search-highlight"); setTimeout(() => target.classList.remove("search-highlight"), 1800); }
        }));
      }
      const track = event.target.closest("[data-track]"); if (track) playBuiltin(track.dataset.track);
      const react = event.target.closest("[data-react]"); if (react) api("/api/reactions", { method: "POST", body: JSON.stringify({ channel: state.active, messageId: react.dataset.react, emoji: react.dataset.emoji, guestId: state.guest.id, guestName: name() }) }).catch(error => toast(error.message));
      const retry = event.target.closest("[data-retry-message]"); if (retry) { const item = (state.messages[state.active] || []).find(item => item.id === retry.dataset.retryMessage); if (item?.failed) sendMessage(item.text, item.id); }
      const reply = event.target.closest("[data-reply]"); if (reply) { const item = (state.messages[state.active] || [])[Number(reply.dataset.reply)]; const input = $("#messageInput"); input.value = (`@${item?.user || "Guest"} ` + input.value).slice(0, 700); saveDraft(); input.focus(); }
    });
    $("#createSpace").onclick = createRoomMenu; $("#createServer").onclick = $("#railCreate").onclick = createServerModal; $("#searchOpen").onclick = $("#mobileSearch").onclick = search; $("#inviteButton").onclick = $("#peopleInvite").onclick = inviteGeneral;
    $("#followButton").onclick = toggleFollow;
    $("#retryConnection").onclick = start;
    $("#discoverAccount").onclick = () => state.profile ? profileModal() : authModal();
    $("#helpButton").onclick = showRules; $("#profileButton").onclick = $("#topProfile").onclick = () => state.profile ? profileModal() : authModal();
    $("#messageForm").onsubmit = e => { e.preventDefault(); sendMessage($("#messageInput").value); };
    $("#messageInput").oninput = e => { saveDraft(); clearTimeout(typingStopTimer); if (e.currentTarget.value.trim()) { if (!localTyping) { clearTimeout(typingTimer); typingTimer = setTimeout(() => sendTyping(true), 180); } typingStopTimer = setTimeout(() => sendTyping(false), 1600); } else { clearTimeout(typingTimer); sendTyping(false); } };
    $("#messageInput").onkeydown = e => { if (e.key === "Enter" && !e.shiftKey && !e.isComposing && e.keyCode !== 229) { e.preventDefault(); clearTimeout(typingTimer); clearTimeout(typingStopTimer); sendTyping(false); sendMessage(e.currentTarget.value); } };
    $("#emojiButton").onclick = () => { $("#messageInput").value += "👋"; $("#messageInput").dispatchEvent(new Event("input")); $("#messageInput").focus(); };
    $("#musicForm").onsubmit = shareMusic; $("#memberSearch").oninput = e => renderMembers(e.target.value.toLowerCase());
    $("#voiceToggle").onclick = $("#voiceTabJoin").onclick = joinVoice; $("#voiceMute").onclick = $("#voiceTabMute").onclick = () => { state.muted = !state.muted; setVoiceDevice(); }; $("#voiceDeafen").onclick = $("#voiceTabDeafen").onclick = () => { state.deafened = !state.deafened; setVoiceDevice(); }; $("#mobileVoice").onclick = () => { if (state.voiceRoom) { joinVoice(); return; } state.voiceMobileOpen = !state.voiceMobileOpen; renderVoice(); };
    $$("[data-view]").forEach(button => button.onclick = () => setView(button.dataset.view));
    document.addEventListener("keydown", e => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") { e.preventDefault(); search(); }
      if (e.key === "Escape") closeModal();
      if (e.key === "Tab" && $(".modal")) { const controls = $$(".modal button:not([disabled]), .modal input:not([disabled]), .modal select:not([disabled]), .modal textarea:not([disabled]), .modal a[href]").filter(item => item.getClientRects().length); const first = controls[0], last = controls.at(-1); if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last?.focus(); } else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first?.focus(); } }
    });
    window.addEventListener("pagehide", () => { if (state.voiceRoom) navigator.sendBeacon(`${API_BASE}/api/voice/leave`, new Blob([JSON.stringify({ room: state.voiceRoom, peerId: state.peerId, guestId: state.guest.id })], { type: "application/json" })); relaySocket?.close(); micProcessor?.disconnect(); micSource?.disconnect(); mic?.getTracks().forEach(track => track.stop()); audioContext?.close(); state.stream?.close(); });
  }
  async function start() {
    clearTimeout(reconnectTimer); state.loading = true; setConnected(false, "Connecting…"); save(); setView(state.view); renderMessages();
    try { const me = await api("/api/me"); state.profile = me.user; await processInvite(); await bootstrap(); updateIdentity(); setView(state.view); connectLive(); }
    catch (error) { state.loading = false; state.channelErrors[state.active] = error.message; setConnected(false, "Reconnecting…"); renderMessages(); reconnectTimer = setTimeout(start, 8000); }
  }
  bind(); renderMessages(); restoreDraft(); updateIdentity(); start();
})();
