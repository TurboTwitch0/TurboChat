(() => {
  "use strict";
  const $ = s => document.querySelector(s), $$ = s => [...document.querySelectorAll(s)];
  const localHosts = new Set(["localhost", "127.0.0.1", "::1"]);
  const API_BASE = localHosts.has(location.hostname) && location.port !== "3001" ? `${location.protocol}//${location.hostname}:3001` : "";
  const usePolling = !localHosts.has(location.hostname) && !location.port;
  const appOrigin = API_BASE || location.origin;
  const storageKey = "orbit.chat.v3";
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
  const state = { guest, profile: null, active: saved.active || "global", rooms: [], parties: [], messages: {}, music: null, members: [], registered: 1428, goal: 1500, followingRooms: Array.isArray(saved.followingRooms) ? saved.followingRooms : [], connected: false, stream: null, peerId: crypto.randomUUID(), voiceRoom: "", joiningVoice: false, voiceMembers: [], muted: false, deafened: false, voiceError: "", voiceMobileOpen: false };
  let mic = null, audioContext = null, micSource = null, micProcessor = null, relaySocket = null, outputGain = null, outputSchedule = new Map(), toastTimer, reconnectTimer, typingTimer, typingStopTimer, pollTimer, lastEventSeq = 0, lastHeartbeat = 0, lastMessageSync = 0, lastVoiceHeartbeat = 0, localTyping = false, polling = false;
  const typingPeers = new Map();
  const voicePeers = new Map();
  const pendingIce = new Map();
  const voiceSignalQueues = new Map();
  const blockedVoicePeers = new Map();
  const esc = s => String(s ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  const name = () => state.profile?.name || state.guest.name;
  const save = () => localStorage.setItem(storageKey, JSON.stringify({ guest: state.guest, active: state.active, followingRooms: state.followingRooms }));
  function toast(message) { const el = $("#toast"); el.textContent = message; el.classList.add("show"); clearTimeout(toastTimer); toastTimer = setTimeout(() => el.classList.remove("show"), 3000); }
  async function api(path, options = {}) {
    const response = await fetch(`${API_BASE}${path}`, { credentials: "include", headers: { "Content-Type": "application/json", ...(options.headers || {}) }, ...options });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) { const error = new Error(data.error || `Request failed (${response.status}).`); error.status = response.status; throw error; }
    return data;
  }
  function allRooms() { return [...defaultRooms, ...state.rooms, ...state.parties]; }
  function room(id) { return allRooms().find(x => x.id === id) || { id, name: "Party", emoji: "✦", topic: "A private room for good people." }; }
  function setConnected(value, label) {
    state.connected = value; $("#connectionLabel").textContent = label || (value ? "Connected" : "Reconnecting…");
    $("#connectionLabel").classList.toggle("offline", !value); $("#messageInput").disabled = !value; $("#sendButton").disabled = !value; renderVoice();
  }
  function renderRoomList() {
    const rooms = allRooms();
    const row = item => `<button class="space-row ${state.active === item.id ? "selected" : ""}" data-channel="${esc(item.id)}"><span style="--tile:${esc(item.color || "#6758ad")}">${esc(item.emoji || "✦")}</span><b>${esc(item.name)}</b></button>`;
    $("#spaceList").innerHTML = rooms.map(row).join("");
    $("#mobileRoomNav").innerHTML = rooms.map(item => `<button class="mobile-room-chip ${state.active === item.id ? "selected" : ""}" data-channel="${esc(item.id)}" title="${esc(item.name)}"><span>${esc(item.emoji || "✦")}</span>${esc(item.name)}${state.followingRooms.includes(item.id) ? `<i aria-label="Following">★</i>` : ""}</button>`).join("");
    const followed = rooms.filter(item => state.followingRooms.includes(item.id));
    $("#followingSection").classList.toggle("hidden", followed.length === 0);
    $("#followingList").innerHTML = followed.map(row).join(""); renderVoiceRooms();
  }
  function renderMembers(filter = $("#memberSearch").value.toLowerCase()) {
    const members = state.members.filter(item => item.name.toLowerCase().includes(filter));
    $("#onlineCount").textContent = state.members.length; $("#activeMemberCount").textContent = members.length; $("#registeredCount").textContent = state.registered.toLocaleString(); $("#goalCount").textContent = state.registered.toLocaleString();
    $("#goalFill").style.width = `${Math.min(100, state.registered / state.goal * 100)}%`;
    const row = item => `<div class="member-row"><span class="avatar">${esc(item.emoji || "✦")}</span><span><b>${esc(item.name)}${item.id === `guest-${state.guest.id}` ? " <small>(you)</small>" : ""}</b><small>${item.registered ? "Registered member" : "Guest"}</small></span><i></i></div>`;
    $("#memberList").innerHTML = members.length ? members.map(row).join("") : `<div class="empty-state">${state.connected ? "You're here first. Say hello." : "Connecting to the chat…"}</div>`;
    $("#peopleList").innerHTML = members.length ? members.map(item => `<div class="person-card"><span class="avatar">${esc(item.emoji || "✦")}</span><b>${esc(item.name)}</b><small>${item.registered ? "Member" : "Guest"}</small></div>`).join("") : `<div class="empty-state">Invite someone to join you.</div>`;
  }
  function renderMessage(item, i) {
    const reactions = Object.entries(item.reactions || {}).map(([emoji, list]) => `<button class="reaction" data-react="${esc(item.id)}" data-emoji="${esc(emoji)}">${esc(emoji)} ${list.length}</button>`).join("");
    return `<article class="message"><span class="avatar">${esc(item.emoji || "✦")}</span><div class="message-body"><div class="message-meta"><b>${esc(item.user || "Guest")}</b>${item.registered ? `<i>member</i>` : ""}<time>${new Intl.DateTimeFormat([], { hour: "numeric", minute: "2-digit" }).format(new Date(item.createdAt || Date.now()))}</time></div><p>${esc(item.text)}</p><div class="message-actions">${reactions}<button class="reaction" data-react="${esc(item.id)}" data-emoji="💜">💜 +</button><button class="reply-link" data-reply="${i}">↩ Reply</button></div></div></article>`;
  }
  function renderMessages({ scrollToBottom = false } = {}) {
    const current = room(state.active), items = state.messages[state.active] || [];
    const feed = $("#messages"), previousTop = feed.scrollTop, wasAtBottom = feed.scrollHeight - feed.scrollTop - feed.clientHeight < 140;
    const channelInfo = info[state.active] || [current.name, current.topic || "Come in and say hello.", current.emoji || "✦", current.topic || "A friendly space for good conversation."];
    $("#channelTitle").textContent = channelInfo[0]; $("#channelSubtitle").textContent = channelInfo[1]; $("#channelGlyph").textContent = channelInfo[2]; $("#topicText").textContent = channelInfo[3];
    const isFollowing = state.followingRooms.includes(state.active);
    $("#followButton").textContent = isFollowing ? "✓ Following" : "✧ Follow";
    $("#followButton").classList.toggle("following", isFollowing);
    $("#followButton").setAttribute("aria-pressed", String(isFollowing));
    $("#messageInput").placeholder = `Message ${channelInfo[0]}…`; $("#musicPanel").classList.toggle("hidden", state.active !== "music");
    const greeting = `<div class="welcome-card"><span>${esc(channelInfo[2])}</span><div><h2>${state.active === "global" ? "The world is a little smaller now." : `Welcome to ${esc(channelInfo[0])}.`}</h2><p>${items.length ? "Join the conversation. Messages arrive live." : "No messages yet. Start the conversation."}</p></div></div><div class="day-label">LIVE CONVERSATION</div>`;
    feed.innerHTML = greeting + items.map(renderMessage).join("");
    if (scrollToBottom || wasAtBottom) feed.scrollTo({ top: feed.scrollHeight, behavior: "smooth" });
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
    try { const data = await api(`/api/messages?channel=${encodeURIComponent(id)}&guestId=${encodeURIComponent(state.guest.id)}`); if (mergeMessages(id, data.messages || []) && state.active === id) renderMessages(); }
    catch (error) { toast(error.message); }
  }
  async function bootstrap() {
    let data;
    try { data = await api(`/api/bootstrap?channel=${encodeURIComponent(state.active)}&guestId=${encodeURIComponent(state.guest.id)}`); }
    catch (error) {
      if (state.active === "global" || ![403, 404].includes(error.status)) throw error;
      state.active = "global"; save(); toast("That saved room is no longer available. You’re back in World chat.");
      data = await api(`/api/bootstrap?channel=global&guestId=${encodeURIComponent(state.guest.id)}`);
    }
    state.rooms = data.rooms || []; state.parties = data.parties || []; mergeMessages(state.active, data.messages || []); state.members = data.members || []; state.registered = Number(data.registeredCount) || 1428; state.goal = Number(data.memberGoal) || 1500; state.music = data.music || null; renderRoomList(); renderMessages(); renderMembers(); renderMusic();
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
      if (data.type === "typing-stop") { const timer = typingPeers.get(`${data.id}:timer`); if (timer) clearTimeout(timer); typingPeers.delete(`${data.id}:timer`); if (data.channel === state.active) renderTyping(); }
      if (data.type === "reaction") { const item = (state.messages[data.channel] || []).find(m => m.id === data.messageId); if (item) { item.reactions = data.reactions; if (state.active === data.channel) renderMessages(); } }
      if (data.type === "presence") { state.members = data.members || []; state.registered = Number(data.registeredCount) || 1428; renderMembers(); }
      if (data.type === "room" && data.room?.type !== "party" && !state.rooms.some(r => r.id === data.room.id)) { state.rooms.unshift(data.room); renderRoomList(); }
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
    try {
      if (Date.now() - lastHeartbeat > 10000) { await api("/api/presence", { method: "POST", body: JSON.stringify({ guestId: state.guest.id, guestName: name() }) }); lastHeartbeat = Date.now(); }
      const result = await api(`/api/updates?after=${lastEventSeq}&guestId=${encodeURIComponent(state.guest.id)}&peerId=${encodeURIComponent(state.peerId)}`);
      for (const event of result.events || []) receiveLiveEvent(event);
      if (state.voiceRoom && Date.now() - lastVoiceHeartbeat > 5000) {
        const voice = await api("/api/voice/join", { method: "POST", body: JSON.stringify({ room: state.voiceRoom, peerId: state.peerId, guestId: state.guest.id, guestName: name() }) });
        lastVoiceHeartbeat = Date.now(); state.voiceMembers = voice.participants || []; renderVoice();
        await connectToVoiceMembers(state.voiceMembers);
      }
      const presenceChanged = JSON.stringify(state.members) !== JSON.stringify(result.members || []);
      state.members = result.members || []; state.registered = Number(result.registeredCount) || state.registered; if (presenceChanged) renderMembers();
      if (Date.now() - lastMessageSync > 4500) {
        const latest = await api(`/api/messages?channel=${encodeURIComponent(state.active)}&guestId=${encodeURIComponent(state.guest.id)}`);
        if (mergeMessages(state.active, latest.messages || [])) renderMessages();
        lastMessageSync = Date.now();
      }
      lastEventSeq = Math.max(lastEventSeq, Number(result.nextSeq) || 0); setConnected(true, "Live");
    } catch { setConnected(false, "Reconnecting…"); } finally { polling = false; }
  }
  function renderTyping() { const names = [...typingPeers.entries()].filter(([key]) => !key.endsWith(":timer")).map(([, value]) => value); $("#typingIndicator").textContent = names.length ? `${names.slice(0, 2).join(", ")}${names.length > 2 ? ` and ${names.length - 2} others` : names.length === 1 ? " is" : " are"} typing…` : ""; }
  function sendTyping(typing) { if (localTyping === typing) return; localTyping = typing; api("/api/typing", { method: "POST", body: JSON.stringify({ channel: state.active, typing, guestId: state.guest.id, guestName: name() }) }).catch(() => {}); }
  async function sendMessage(value) {
    const content = value.trim(); if (!content || !state.connected) return;
    const input = $("#messageInput"); input.value = ""; $("#charCount").textContent = "0"; input.style.height = "auto";
    const channel = state.active, tempId = `pending-${crypto.randomUUID()}`, pending = { id: tempId, user: name(), emoji: state.profile?.emoji || "✦", text: content, createdAt: new Date().toISOString(), reactions: {}, pending: true };
    mergeMessages(channel, [pending]); if (state.active === channel) renderMessages({ scrollToBottom: true });
    try { const result = await api("/api/messages", { method: "POST", body: JSON.stringify({ channel, text: content, guestId: state.guest.id, guestName: name() }) }); state.messages[channel] = (state.messages[channel] || []).filter(item => item.id !== tempId); mergeMessages(channel, [result.message]); if (state.active === channel) renderMessages({ scrollToBottom: true }); }
    catch (error) { state.messages[channel] = (state.messages[channel] || []).filter(item => item.id !== tempId); if (state.active === channel) renderMessages(); input.value = content; toast(error.message); }
  }
  async function selectChannel(id) {
    if (!allRooms().some(item => item.id === id)) return;
    if (state.voiceRoom && state.voiceRoom !== id) await leaveVoice(true);
    state.active = id; save(); setView("chat"); renderRoomList(); renderMessages(); await loadChannel(id);
  }
  function modal(title, subtitle, body) { $("#modalRoot").innerHTML = `<div class="modal-backdrop"><section class="modal"><button class="modal-close" data-close>×</button><small>ORBIT</small><h2>${esc(title)}</h2><p>${esc(subtitle)}</p>${body}</section></div>`; $("[data-close]").addEventListener("click", closeModal); $(".modal-backdrop").addEventListener("click", e => { if (e.target.classList.contains("modal-backdrop")) closeModal(); }); }
  function closeModal() { $("#modalRoot").innerHTML = ""; }
  function createRoomMenu() {
    modal("Make a place for your people.", "Create an open room or a private party.", `<div class="modal-actions"><button id="makeRoom" class="modal-choice"><b>✳ Community room</b><small>Anyone can find and join.</small></button><button id="makeParty" class="modal-choice"><b>✦ Invite-only party</b><small>Only people with your invite can enter.</small></button></div>`);
    $("#makeRoom").onclick = () => roomForm(false); $("#makeParty").onclick = () => roomForm(true);
  }
  function roomForm(isParty) {
    modal(isParty ? "Start a party." : "Start a community room.", "Give people a good reason to join the conversation.", `<form id="roomForm"><label>Name<input id="roomName" required minlength="2" maxlength="42" placeholder="${isParty ? "Friday night crew" : "Book lovers unite"}"></label><label>Conversation starter<input id="roomTopic" maxlength="100" placeholder="What should people talk about?"></label><button class="submit-button">Create ${isParty ? "party" : "room"} →</button></form>`);
    $("#roomForm").onsubmit = async event => {
      event.preventDefault(); const button = event.currentTarget.querySelector("button"); button.disabled = true;
      try {
        const result = await api(isParty ? "/api/parties" : "/api/rooms", { method: "POST", body: JSON.stringify({ name: $("#roomName").value.trim(), topic: $("#roomTopic").value.trim(), owner: name(), guestId: state.guest.id }) });
        if (isParty) state.parties.unshift(result.room); else state.rooms.unshift(result.room);
        state.active = result.room.id; save(); await loadChannel(state.active); closeModal(); renderMessages();
        if (isParty) inviteCreated(result.room, result.inviteCode); else toast("Your room is open to everyone.");
      } catch (error) { toast(error.message); button.disabled = false; }
    };
  }
  function packInvite(data) { return btoa(unescape(encodeURIComponent(JSON.stringify(data)))).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, ""); }
  function inviteCreated(item, code) {
    const link = `${appOrigin}${location.pathname}?invite=${packInvite({ id: item.id, inviteCode: code, name: item.name, topic: item.topic })}`;
    modal(`Invite someone to ${item.name}.`, "Anyone with this invite can join your private party.", `<div class="invite-box"><input id="inviteLink" readonly value="${esc(link)}"><button id="copyInvite" class="submit-button">Copy invite</button></div><button id="doneInvite" class="subtle-button">Done</button>`);
    $("#copyInvite").onclick = async () => { try { await navigator.clipboard.writeText(link); toast("Invite copied."); } catch { $("#inviteLink").select(); document.execCommand("copy"); toast("Invite copied."); } };
    $("#doneInvite").onclick = closeModal;
  }
  async function processInvite() {
    const encoded = new URLSearchParams(location.search).get("invite"); if (!encoded) return;
    try {
      const data = JSON.parse(decodeURIComponent(escape(atob(encoded.replace(/-/g, "+").replace(/_/g, "/")))));
      const result = await api("/api/parties/join", { method: "POST", body: JSON.stringify({ id: data.id, inviteCode: data.inviteCode, guestId: state.guest.id }) });
      state.parties = (state.parties || []).filter(item => item.id !== result.room.id); state.parties.unshift(result.room); state.active = result.room.id; save(); history.replaceState({}, "", location.pathname); toast(`You joined ${result.room.name}.`);
    } catch (error) { history.replaceState({}, "", location.pathname); toast(error.message); }
  }
  function inviteGeneral() {
    const link = `${appOrigin}${location.pathname}`;
    modal("Invite someone to Orbit.", "Send this link so a friend can join the conversation.", `<div class="invite-box"><input id="inviteLink" readonly value="${esc(link)}"><button id="copyInvite" class="submit-button">Copy link</button></div>`);
    $("#copyInvite").onclick = async () => { try { await navigator.clipboard.writeText(link); toast("Invite copied."); } catch { $("#inviteLink").select(); document.execCommand("copy"); toast("Invite copied."); } };
  }
  function authModal(mode = "login") {
    const register = mode === "register";
    modal(register ? "Create your account." : "Welcome back.", register ? "Your account follows you on this server." : "Sign in to your Orbit account.", `<div class="auth-tabs"><button id="toLogin" class="${register ? "" : "active"}">Sign in</button><button id="toRegister" class="${register ? "active" : ""}">Create account</button></div><form id="authForm">${register ? `<label>Display name<input id="authName" required minlength="2" maxlength="32" autocomplete="nickname"></label>` : ""}<label>Email<input id="authEmail" type="email" required autocomplete="email" autocapitalize="none" spellcheck="false"></label><label>Password<input id="authPassword" type="password" required minlength="${register ? "8" : "1"}" maxlength="128" autocomplete="${register ? "new-password" : "current-password"}"></label><p id="authError" class="auth-error" role="alert"></p><button class="submit-button">${register ? "Create account" : "Sign in"}</button></form>${state.profile ? `<button id="logout" class="subtle-button">Sign out</button>` : ""}<button id="guestMode" class="subtle-button">Continue as ${esc(state.guest.name)}</button>`);
    $("#toLogin").onclick = () => authModal("login"); $("#toRegister").onclick = () => authModal("register");
    $("#authForm").onsubmit = async e => {
      e.preventDefault(); const button = e.currentTarget.querySelector(".submit-button"); button.disabled = true; button.textContent = register ? "Creating account…" : "Signing in…";
      try {
        const endpoint = register ? "/api/register" : "/api/login";
        const result = await api(endpoint, { method: "POST", body: JSON.stringify({ name: register ? $("#authName").value.trim() : undefined, email: $("#authEmail").value.trim(), password: $("#authPassword").value, guestId: state.guest.id }) });
        state.profile = result.user; closeModal(); connectLive(); updateIdentity(); toast(`Welcome, ${result.user.name}.`);
      } catch (error) { $("#authError").textContent = error.message; button.disabled = false; button.textContent = register ? "Create account" : "Sign in"; }
    };
    $("#guestMode").onclick = () => { state.profile = null; updateIdentity(); closeModal(); };
    if ($("#logout")) $("#logout").onclick = async () => { const button = $("#logout"); button.disabled = true; try { await api("/api/logout", { method: "POST", body: "{}" }); state.profile = null; connectLive(); updateIdentity(); closeModal(); } catch (error) { toast(error.message); button.disabled = false; } };
  }
  function updateIdentity() { $("#identityHint").textContent = state.profile ? `Signed in as ${state.profile.name}. Say something kind.` : `Chatting as ${state.guest.name}. Your name is saved in this browser.`; $("#profileButton").textContent = state.profile ? state.profile.name[0].toUpperCase() : "G"; $("#topProfile").innerHTML = state.profile ? esc(state.profile.name[0].toUpperCase()) : '<svg aria-hidden="true" viewBox="0 0 24 24"><circle cx="12" cy="8" r="3.5"/><path d="M4.5 20a7.5 7.5 0 0 1 15 0"/></svg>'; }
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
    if (!allRooms().some(item => item.id === id)) return;
    if (state.voiceRoom && state.voiceRoom !== id) await leaveVoice(true);
    state.active = id; save(); renderMessages(); await loadChannel(id); setView("voice"); renderVoiceRooms();
  }
  function setView(view) {
    ["chat", "people", "voice"].forEach(name => $(`#${name}View`).classList.toggle("hidden", name !== view));
    $$('[data-view]').forEach(button => button.classList.toggle("active", button.dataset.view === view));
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
    $("#mobileVoice").classList.toggle("joined", self); renderVoiceRooms();
  }
  function voiceSocketUrl() {
    const base = new URL(API_BASE || location.origin);
    const url = new URL("/api/voice/audio", base); url.protocol = base.protocol === "https:" ? "wss:" : "ws:";
    url.searchParams.set("room", state.voiceRoom); url.searchParams.set("peerId", state.peerId); url.searchParams.set("guestId", state.guest.id); return url.href;
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
    const input = event.inputBuffer.getChannelData(0), step = audioContext.sampleRate / 16000, count = Math.floor(input.length / step);
    if (!count) return;
    const packet = new ArrayBuffer(4 + count * 2), view = new DataView(packet); view.setUint32(0, 16000, true);
    for (let i = 0; i < count; i++) { const sample = input[Math.floor(i * step)]; view.setInt16(4 + i * 2, Math.max(-1, Math.min(1, sample)) * 32767, true); }
    relaySocket.send(packet);
  }
  function connectVoiceAudio() {
    relaySocket = new WebSocket(voiceSocketUrl()); relaySocket.binaryType = "arraybuffer";
    relaySocket.onopen = () => { state.voiceError = ""; renderVoice(); };
    relaySocket.onmessage = event => receiveAudio(event.data);
    relaySocket.onerror = () => { if (state.voiceRoom) { state.voiceError = "Voice audio could not connect. Check this server’s network access."; renderVoice(); } };
    relaySocket.onclose = () => { if (state.voiceRoom) { state.voiceError = "Voice audio disconnected. Leave and rejoin voice."; renderVoice(); } };
    micSource = audioContext.createMediaStreamSource(mic); micProcessor = audioContext.createScriptProcessor(2048, 1, 1);
    outputGain = audioContext.createGain(); outputGain.gain.value = state.deafened ? 0 : 1; outputGain.connect(audioContext.destination);
    micProcessor.onaudioprocess = sendAudio; micSource.connect(micProcessor); micProcessor.connect(audioContext.destination);
  }
  async function joinVoice() {
    if (usePolling) return joinVoiceWebRTC();
    if (state.voiceRoom) return leaveVoice(); if (!state.connected) return toast("Wait for chat to reconnect before joining voice.");
    state.joiningVoice = true; state.voiceError = ""; renderVoice();
    try {
      if (!navigator.mediaDevices?.getUserMedia) throw new Error("Microphone access needs HTTPS or localhost.");
      audioContext = new AudioContext({ sampleRate: 16000 }); await audioContext.resume();
      mic = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true } });
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
    for (const track of mic.getTracks()) pc.addTrack(track, mic);
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
      mic = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true } });
      const result = await api("/api/voice/join", { method: "POST", body: JSON.stringify({ room: state.active, peerId: state.peerId, guestId: state.guest.id, guestName: name() }) });
      state.voiceRoom = state.active; state.joiningVoice = false; state.voiceMembers = result.participants || []; renderVoice();
      lastVoiceHeartbeat = Date.now(); blockedVoicePeers.clear(); await connectToVoiceMembers(state.voiceMembers);
    } catch (error) { state.joiningVoice = false; mic?.getTracks().forEach(track => track.stop()); mic = null; for (const pc of voicePeers.values()) pc.close(); voicePeers.clear(); state.voiceError = error.message; renderVoice(); toast(error.message); }
  }
  function showRules() { modal("A small promise to each other.", "Orbit works best when everyone gets to be a person here.", `<ul class="rules"><li>Be curious before you judge. People arrive with different stories.</li><li>Make room for quieter voices. A thoughtful reply goes a long way.</li><li>Keep personal information personal. Share only what feels right to you.</li><li>If someone asks you to stop, let the conversation breathe.</li></ul>`); }
  function search() {
    modal("Find a conversation.", "Search the rooms and parties you can access.", `<input id="searchInput" class="search-input" placeholder="Try music, travel, makers…" autocomplete="off"><div id="searchResults" class="search-results"></div>`);
    const update = () => { const term = $("#searchInput").value.toLowerCase(); $("#searchResults").innerHTML = allRooms().filter(item => item.name.toLowerCase().includes(term) || (item.topic || "").toLowerCase().includes(term)).map(item => `<button data-search-room="${esc(item.id)}">${esc(item.emoji || "✦")} ${esc(item.name)}<small>${esc(item.topic || "")}</small></button>`).join("") || `<p class="empty-state">No matching room yet.</p>`; };
    $("#searchInput").oninput = update; $("#searchInput").focus(); update();
  }
  function bind() {
    document.addEventListener("click", event => {
      const channel = event.target.closest("[data-channel]"); if (channel) selectChannel(channel.dataset.channel);
      const voiceRoom = event.target.closest("[data-voice-room]"); if (voiceRoom) selectVoiceRoom(voiceRoom.dataset.voiceRoom);
      const searchRoom = event.target.closest("[data-search-room]"); if (searchRoom) { const id = searchRoom.dataset.searchRoom; closeModal(); selectChannel(id); }
      const track = event.target.closest("[data-track]"); if (track) playBuiltin(track.dataset.track);
      const react = event.target.closest("[data-react]"); if (react) api("/api/reactions", { method: "POST", body: JSON.stringify({ channel: state.active, messageId: react.dataset.react, emoji: react.dataset.emoji, guestId: state.guest.id, guestName: name() }) }).catch(error => toast(error.message));
      const reply = event.target.closest("[data-reply]"); if (reply) { const item = (state.messages[state.active] || [])[Number(reply.dataset.reply)]; $("#messageInput").value = `@${item?.user || "Guest"} `; $("#messageInput").focus(); }
    });
    $("#createSpace").onclick = $("#railCreate").onclick = createRoomMenu; $("#searchOpen").onclick = search; $("#inviteButton").onclick = $("#peopleInvite").onclick = inviteGeneral;
    $("#followButton").onclick = toggleFollow;
    $("#helpButton").onclick = showRules; $("#profileButton").onclick = $("#topProfile").onclick = () => authModal();
    $("#messageForm").onsubmit = e => { e.preventDefault(); sendMessage($("#messageInput").value); };
    $("#messageInput").oninput = e => { $("#charCount").textContent = e.currentTarget.value.length; e.currentTarget.style.height = "auto"; e.currentTarget.style.height = `${Math.min(e.currentTarget.scrollHeight, 130)}px`; clearTimeout(typingStopTimer); if (e.currentTarget.value.trim()) { if (!localTyping) { clearTimeout(typingTimer); typingTimer = setTimeout(() => sendTyping(true), 180); } typingStopTimer = setTimeout(() => sendTyping(false), 1600); } else { clearTimeout(typingTimer); sendTyping(false); } };
    $("#messageInput").onkeydown = e => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); clearTimeout(typingTimer); clearTimeout(typingStopTimer); sendTyping(false); sendMessage(e.currentTarget.value); } };
    $("#emojiButton").onclick = () => { $("#messageInput").value += "👋"; $("#messageInput").dispatchEvent(new Event("input")); $("#messageInput").focus(); };
    $("#musicForm").onsubmit = shareMusic; $("#memberSearch").oninput = e => renderMembers(e.target.value.toLowerCase());
    $("#voiceToggle").onclick = $("#voiceTabJoin").onclick = joinVoice; $("#voiceMute").onclick = $("#voiceTabMute").onclick = () => { state.muted = !state.muted; setVoiceDevice(); }; $("#voiceDeafen").onclick = $("#voiceTabDeafen").onclick = () => { state.deafened = !state.deafened; setVoiceDevice(); }; $("#mobileVoice").onclick = () => { if (state.voiceRoom) { joinVoice(); return; } state.voiceMobileOpen = !state.voiceMobileOpen; renderVoice(); };
    $$("[data-view]").forEach(button => button.onclick = () => setView(button.dataset.view));
    document.addEventListener("keydown", e => { if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") { e.preventDefault(); search(); } if (e.key === "Escape") closeModal(); });
    window.addEventListener("pagehide", () => { if (state.voiceRoom) navigator.sendBeacon(`${API_BASE}/api/voice/leave`, new Blob([JSON.stringify({ room: state.voiceRoom, peerId: state.peerId, guestId: state.guest.id })], { type: "application/json" })); relaySocket?.close(); micProcessor?.disconnect(); micSource?.disconnect(); mic?.getTracks().forEach(track => track.stop()); audioContext?.close(); state.stream?.close(); });
  }
  async function start() {
    setConnected(false, "Connecting…"); save();
    try { const me = await api("/api/me"); state.profile = me.user; await processInvite(); await bootstrap(); updateIdentity(); connectLive(); }
    catch (error) { setConnected(false, "Offline"); $("#messages").innerHTML = `<div class="offline-card"><span>↻</span><h2>Chat is reconnecting.</h2><p>${esc(error.message)} The chat service at this address is unavailable.</p><button id="retry">Try again</button></div>`; $("#retry").onclick = start; clearTimeout(reconnectTimer); reconnectTimer = setTimeout(start, 4000); }
  }
  bind(); renderMessages(); updateIdentity(); start();
})();
