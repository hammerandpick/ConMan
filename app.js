"use strict";

const welcome = document.querySelector("#welcome");
const connection = document.querySelector("#connection");
const roomMenu = document.querySelector("#room-menu");
const entryError = document.querySelector("#entry-error");
const connectionError = document.querySelector("#connection-error");
const connectionStatus = document.querySelector("#connection-status");
const participantList = document.querySelector("#participant-list");
const roomQr = document.querySelector("#room-qr");
const inviteLink = document.querySelector("#invite-link");
const inviteWarning = document.querySelector("#invite-warning");
const roomCodeInput = document.querySelector("#room-code");
const roomCodeDisplay = document.querySelector("#room-code-display");
const messages = document.querySelector("#messages");
const messageInput = document.querySelector("#message-input");
const sendButton = document.querySelector("#send-message");

const peerConnections = new Map();
let roomCode = "";
let token = "";
let memberId = "";
let memberOrder = 0;
let pollCursor = 0;
let polling = false;
let members = new Map();

function showError(element, message) {
    element.textContent = message;
    element.hidden = false;
}

function clearError(element) {
    element.textContent = "";
    element.hidden = true;
}

async function api(action, options = {}) {
    const headers = { Accept: "application/json" };
    if (token) headers.Authorization = `Bearer ${token}`;
    if (options.body) headers["Content-Type"] = "application/json";
    const response = await fetch(`api.php?action=${encodeURIComponent(action)}${options.query || ""}`, {
        method: options.method || "GET",
        headers,
        body: options.body ? JSON.stringify(options.body) : undefined,
        cache: "no-store"
    });
    const result = await response.json();
    if (!response.ok) {
        const error = new Error(result.error || "The server could not complete that request.");
        error.status = response.status;
        throw error;
    }
    return result;
}

async function createRoom() {
    clearError(entryError);
    try {
        const result = await api("create", { method: "POST", body: {} });
        enterRoom(result);
    } catch (error) {
        showError(entryError, error.message);
    }
}

async function joinRoom(event) {
    event.preventDefault();
    clearError(entryError);
    const code = roomCodeInput.value.trim().toUpperCase();
    if (!/^[A-HJ-NP-Z2-9]{8}$/.test(code)) {
        showError(entryError, "Enter the 8-character room code.");
        return;
    }
    try {
        const result = await api("join", { method: "POST", body: { room: code } });
        enterRoom(result);
    } catch (error) {
        showError(entryError, error.message);
    }
}

function enterRoom(result) {
    roomCode = result.room;
    token = result.token;
    memberId = result.memberId;
    memberOrder = result.memberOrder;
    pollCursor = result.cursor;
    members = new Map([[memberId, { id: memberId, order: memberOrder }]]);
    messages.replaceChildren();
    peerConnections.clear();
    roomCodeDisplay.textContent = roomCode;
    renderRoomInvite();
    document.querySelector("#room-title").textContent = "Waiting for devices";
    welcome.hidden = true;
    connection.hidden = false;
    renderParticipants();
    updateConnectionStatus();
    polling = true;
    pollLoop();
}

function renderRoomInvite() {
    const url = new URL(window.location.href);
    url.search = "";
    url.hash = "";
    url.searchParams.set("room", roomCode);
    inviteLink.href = url.href;
    inviteLink.textContent = url.href;
    clearError(inviteWarning);

    try {
        window.renderRoomQr(roomQr, url.href);
        roomQr.setAttribute("aria-label", `QR code to join room ${roomCode}`);
    } catch (error) {
        showError(inviteWarning, error.message);
    }

    const hostname = window.location.hostname.toLowerCase();
    const isLoopback = hostname === "localhost" || hostname === "::1" || hostname === "[::1]" || hostname.startsWith("127.");
    if (isLoopback) {
        showError(inviteWarning, "This address uses localhost and cannot be reached from your phone. Open ConMan using a network-accessible address before scanning.");
    } else if (window.location.protocol !== "https:") {
        showError(inviteWarning, "Use HTTPS on mobile browsers to ensure WebRTC and future audio/video features are available.");
    }
}

function participantLabel(id) {
    const member = members.get(id);
    return member ? `Device ${member.order}` : "Another device";
}

function renderParticipants() {
    participantList.replaceChildren();
    for (const member of members.values()) {
        const item = document.createElement("li");
        const label = document.createElement("span");
        const status = document.createElement("span");
        const isCurrentMember = member.id === memberId;
        const peer = peerConnections.get(member.id);
        const connected = peer && peer.channel && peer.channel.readyState === "open";

        label.textContent = isCurrentMember ? `You · Device ${member.order}` : participantLabel(member.id);
        status.textContent = isCurrentMember ? (memberOrder === 1 ? "Room owner" : "You") : (connected ? "Connected" : "Connecting");
        status.className = `participant-status${connected ? " is-connected" : ""}`;
        item.append(label, status);
        participantList.append(item);
    }
}

function updateConnectionStatus() {
    const otherMembers = [...members.keys()].filter(id => id !== memberId);
    const connected = otherMembers.filter(id => {
        const peer = peerConnections.get(id);
        return peer && peer.channel && peer.channel.readyState === "open";
    }).length;

    if (otherMembers.length === 0) {
        connectionStatus.textContent = "Share this code with up to 5 other devices.";
        connectionStatus.classList.remove("is-connected");
        document.querySelector("#room-title").textContent = "Waiting for devices";
    } else {
        connectionStatus.textContent = connected === otherMembers.length
            ? `Direct connections ready with ${connected} ${connected === 1 ? "device" : "devices"}.`
            : `Connected to ${connected} of ${otherMembers.length} devices. Establishing connections…`;
        connectionStatus.classList.toggle("is-connected", connected === otherMembers.length);
        document.querySelector("#room-title").textContent = connected === otherMembers.length ? "Connected" : "Connecting";
    }

    const anyOpenChannel = [...peerConnections.values()].some(peer => peer.channel && peer.channel.readyState === "open");
    messageInput.disabled = !anyOpenChannel;
    sendButton.disabled = !anyOpenChannel;
    renderParticipants();
}

function createPeer(member) {
    const peer = {
        connection: new RTCPeerConnection({
            iceServers: [{ urls: "stun:stun.l.google.com:19302" }]
        }),
        channel: null,
        pendingCandidates: []
    };
    peerConnections.set(member.id, peer);

    peer.connection.onicecandidate = event => {
        if (event.candidate) {
            sendSignal(member.id, "candidate", event.candidate.toJSON()).catch(showConnectionError);
        }
    };
    peer.connection.onconnectionstatechange = () => {
        if (peer.connection.connectionState === "failed") {
            showConnectionError(new Error(`Could not connect to ${participantLabel(member.id)}. This network may require a TURN relay.`));
        }
        updateConnectionStatus();
    };
    peer.connection.ondatachannel = event => setupDataChannel(member.id, event.channel);
    return peer;
}

function ensurePeer(member) {
    let peer = peerConnections.get(member.id);
    if (!peer) {
        peer = createPeer(member);
        if (memberOrder < member.order) {
            const channel = peer.connection.createDataChannel("messages");
            setupDataChannel(member.id, channel);
            startOffer(member.id, peer).catch(showConnectionError);
        }
    }
    return peer;
}

function setupDataChannel(id, channel) {
    const peer = peerConnections.get(id);
    if (!peer || peer.channel === channel) return;
    peer.channel = channel;
    channel.onopen = updateConnectionStatus;
    channel.onclose = updateConnectionStatus;
    channel.onmessage = event => {
        try {
            const message = JSON.parse(event.data);
            if (typeof message.text === "string" && message.text.length <= 4000) {
                appendMessage(message.text, false, participantLabel(id));
            }
        } catch {
            showConnectionError(new Error("Received an invalid message from another device."));
        }
    };
    updateConnectionStatus();
}

async function startOffer(id, peer) {
    const offer = await peer.connection.createOffer();
    await peer.connection.setLocalDescription(offer);
    await sendSignal(id, "offer", { sdp: offer.sdp });
}

async function sendSignal(to, type, payload) {
    await api("signal", {
        method: "POST",
        query: `&room=${encodeURIComponent(roomCode)}`,
        body: { to, type, payload }
    });
}

async function handleSignal(signal) {
    const member = members.get(signal.from);
    if (!member) return;
    const peer = ensurePeer(member);

    if (signal.type === "offer" && member.order < memberOrder) {
        await peer.connection.setRemoteDescription({ type: "offer", sdp: signal.payload.sdp });
        await flushCandidates(peer);
        const answer = await peer.connection.createAnswer();
        await peer.connection.setLocalDescription(answer);
        await sendSignal(member.id, "answer", { sdp: answer.sdp });
    } else if (signal.type === "answer" && member.order > memberOrder) {
        await peer.connection.setRemoteDescription({ type: "answer", sdp: signal.payload.sdp });
        await flushCandidates(peer);
    } else if (signal.type === "candidate") {
        if (peer.connection.remoteDescription) {
            await peer.connection.addIceCandidate(signal.payload);
        } else {
            peer.pendingCandidates.push(signal.payload);
        }
    }
}

async function flushCandidates(peer) {
    while (peer.pendingCandidates.length) {
        await peer.connection.addIceCandidate(peer.pendingCandidates.shift());
    }
}

function reconcileMembers(roster) {
    const nextMembers = new Map(roster.map(member => [member.id, member]));
    for (const [id, peer] of peerConnections) {
        if (!nextMembers.has(id)) {
            peer.connection.close();
            peerConnections.delete(id);
        }
    }
    members = nextMembers;
    for (const member of members.values()) {
        if (member.id !== memberId) ensurePeer(member);
    }
    updateConnectionStatus();
}

async function pollLoop() {
    const currentRoom = roomCode;
    while (polling && roomCode === currentRoom) {
        try {
            const result = await api("events", {
                query: `&room=${encodeURIComponent(currentRoom)}&after=${pollCursor}`
            });
            if (!polling || roomCode !== currentRoom) return;
            reconcileMembers(result.members);
            for (const event of result.events) {
                try {
                    await handleSignal(event);
                } catch (error) {
                    showConnectionError(error);
                }
            }
            pollCursor = result.cursor;
        } catch (error) {
            if (polling && roomCode === currentRoom) {
                setStatus(error.message);
                if (error.status === 404 || error.status === 410) {
                    polling = false;
                    closePeerConnections();
                    members = new Map();
                    messageInput.disabled = true;
                    sendButton.disabled = true;
                    document.querySelector("#room-title").textContent = "Room closed";
                    renderParticipants();
                }
            }
        }
        await new Promise(resolve => setTimeout(resolve, 900));
    }
}

function setStatus(message) {
    connectionStatus.textContent = message;
    connectionStatus.classList.remove("is-connected");
}

function showConnectionError(error) {
    showError(connectionError, error instanceof Error ? error.message : "The connection could not be completed.");
}

function appendMessage(text, own, sender) {
    const bubble = document.createElement("div");
    bubble.className = `message${own ? " is-own" : ""}`;
    const label = document.createElement("span");
    label.className = "message-label";
    label.textContent = sender;
    const content = document.createElement("span");
    content.textContent = text;
    bubble.append(label, content);
    messages.append(bubble);
    messages.scrollTop = messages.scrollHeight;
}

function sendMessage(event) {
    event.preventDefault();
    const text = messageInput.value.trim();
    if (!text) return;
    const openChannels = [...peerConnections.values()]
        .map(peer => peer.channel)
        .filter(channel => channel && channel.readyState === "open");
    if (openChannels.length === 0) return;

    const payload = JSON.stringify({ text });
    let sent = 0;
    for (const channel of openChannels) {
        try {
            channel.send(payload);
            sent++;
        } catch {
            continue;
        }
    }
    if (sent > 0) {
        appendMessage(text, true, "You");
        messageInput.value = "";
        messageInput.focus();
    }
    if (sent === 0) {
        showConnectionError(new Error("Message could not be sent to any device."));
    } else if (sent < openChannels.length) {
        showConnectionError(new Error(`Message sent to ${sent} of ${openChannels.length} connected devices.`));
    }
}

function closePeerConnections() {
    for (const peer of peerConnections.values()) peer.connection.close();
    peerConnections.clear();
}

async function leaveRoom() {
    polling = false;
    if (roomMenu.open) roomMenu.close();
    closePeerConnections();
    let leaveError = "";
    try {
        await api("leave", { method: "POST", query: `&room=${encodeURIComponent(roomCode)}`, body: {} });
    } catch (error) {
        leaveError = error.message;
    }
    roomCode = "";
    token = "";
    memberId = "";
    memberOrder = 0;
    members.clear();
    welcome.hidden = false;
    connection.hidden = true;
    messageInput.disabled = true;
    sendButton.disabled = true;
    clearError(entryError);
    clearError(connectionError);
    if (leaveError) showError(entryError, `Left this device, but the server could not close the room: ${leaveError}`);
}

document.querySelector("#create-room").addEventListener("click", createRoom);
document.querySelector("#join-form").addEventListener("submit", joinRoom);
document.querySelector("#message-form").addEventListener("submit", sendMessage);
document.querySelector("#open-room-menu").addEventListener("click", () => roomMenu.showModal());
document.querySelector("#close-room-menu").addEventListener("click", () => roomMenu.close());
document.querySelector("#leave-room").addEventListener("click", leaveRoom);
document.querySelector("#copy-code").addEventListener("click", async event => {
    try {
        await navigator.clipboard.writeText(roomCode);
        event.currentTarget.textContent = "Copied";
        setTimeout(() => { event.currentTarget.textContent = "Copy code"; }, 1600);
    } catch {
        showConnectionError(new Error("Could not copy the code. Select and copy it manually."));
    }
});

document.querySelector("#copy-invite-link").addEventListener("click", async event => {
    try {
        await navigator.clipboard.writeText(inviteLink.href);
        event.currentTarget.textContent = "Link copied";
        setTimeout(() => { event.currentTarget.textContent = "Copy invite link"; }, 1600);
    } catch {
        showConnectionError(new Error("Could not copy the invite link. Open the link shown in the room panel manually."));
    }
});

document.querySelector("#room-code").addEventListener("input", event => {
    event.currentTarget.value = event.currentTarget.value.toUpperCase().replace(/[^A-Z2-9]/g, "");
});

const inviteCode = new URLSearchParams(window.location.search).get("room");
if (inviteCode && /^[A-HJ-NP-Z2-9]{8}$/i.test(inviteCode)) {
    roomCodeInput.value = inviteCode.toUpperCase();
    document.querySelector("#join-form").requestSubmit();
}
