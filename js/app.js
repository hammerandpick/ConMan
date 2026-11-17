"use strict";

const welcome = document.querySelector("#welcome");
const connection = document.querySelector("#connection");
const roomMenu = document.querySelector("#room-menu");
const entryError = document.querySelector("#entry-error");
const connectionError = document.querySelector("#connection-error");
const connectionStatus = document.querySelector("#connection-status");
const participantList = document.querySelector("#participant-list");
const mediaGrid = document.querySelector("#media-grid");
const mainTablePlaceholder = document.querySelector("#main-table-placeholder");
const mainTableImage = document.querySelector("#main-table-image");
const audioPlayback = document.querySelector("#audio-playback");
const toggleAudioButton = document.querySelector("#toggle-audio");
const toggleVideoButton = document.querySelector("#toggle-video");
const roomQr = document.querySelector("#room-qr");
const inviteLink = document.querySelector("#invite-link");
const inviteWarning = document.querySelector("#invite-warning");
const roomCodeInput = document.querySelector("#room-code");
const roomCodeDisplay = document.querySelector("#room-code-display");
const messages = document.querySelector("#messages");
const messageInput = document.querySelector("#message-input");
const sendButton = document.querySelector("#send-message");
const serverStatus = document.querySelector("#server-status");
const serverButton = document.querySelector("#toggle-server");

const peerConnections = new Map();
const localTracks = { audio: null, video: null };
const localMediaPending = new Set();
const remoteMuted = new Set();
const mediaTiles = new Map();
let roomCode = "";
let token = "";
let memberId = "";
let memberOrder = 0;
let pollCursor = 0;
let polling = false;
let members = new Map();
let serverId = null;
let localMediaStream = null;
let roomEpoch = 0;

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
    roomEpoch++;
    roomCode = result.room;
    token = result.token;
    memberId = result.memberId;
    memberOrder = result.memberOrder;
    pollCursor = result.cursor;
    serverId = result.serverId || null;
    members = new Map([[memberId, { id: memberId, order: memberOrder }]]);
    messages.replaceChildren();
    peerConnections.clear();
    remoteMuted.clear();
    mediaTiles.clear();
    mediaGrid.replaceChildren();
    audioPlayback.replaceChildren();
    roomCodeDisplay.textContent = roomCode;
    renderRoomInvite();
    document.querySelector("#room-title").textContent = "Waiting for devices";
    welcome.hidden = true;
    connection.hidden = false;
    document.querySelector(".shell").classList.add("has-room");
    renderMediaTiles();
    renderParticipants();
    updateServerControls();
    updateMediaControls();
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
        const details = document.createElement("div");
        const label = document.createElement("span");
        const status = document.createElement("span");
        const muteButton = document.createElement("button");
        const isCurrentMember = member.id === memberId;
        const isServer = member.id === serverId;
        const peer = peerConnections.get(member.id);
        const connected = peer && peer.channel && peer.channel.readyState === "open";

        details.className = "participant-details";
        label.textContent = isCurrentMember ? `You · Device ${member.order}` : participantLabel(member.id);
        const memberStatus = isCurrentMember ? (memberOrder === 1 ? "Room owner" : "You") : (connected ? "Connected" : "Connecting");
        status.textContent = isServer ? `${memberStatus} · Server` : memberStatus;
        status.className = `participant-status${connected ? " is-connected" : ""}`;
        details.append(label, status);
        muteButton.type = "button";
        muteButton.className = "button button-quiet participant-mute";
        if (isCurrentMember) {
            const microphoneOn = localTracks.audio !== null;
            muteButton.textContent = microphoneOn ? "Mute mic" : "Enable mic";
            muteButton.setAttribute("aria-label", microphoneOn ? "Mute your microphone" : "Enable your microphone");
            muteButton.setAttribute("aria-pressed", String(microphoneOn));
            muteButton.disabled = localMediaPending.has("audio");
            muteButton.addEventListener("click", () => toggleLocalMedia("audio"));
        } else {
            const isMuted = remoteMuted.has(member.id);
            muteButton.textContent = isMuted ? "Unmute" : "Mute";
            muteButton.setAttribute("aria-label", `${isMuted ? "Unmute" : "Mute"} audio from ${participantLabel(member.id)}`);
            muteButton.setAttribute("aria-pressed", String(isMuted));
            muteButton.addEventListener("click", () => toggleRemoteAudio(member.id));
        }
        item.append(details, muteButton);
        participantList.append(item);
    }
}

function updateServerControls() {
    if (!serverId) {
        serverStatus.textContent = "No Server is selected. Chat is sent directly between devices.";
    } else if (serverId === memberId) {
        serverStatus.textContent = "This device is the Server and relays chat to the other devices.";
    } else {
        serverStatus.textContent = `${participantLabel(serverId)} is the Server and relays chat.`;
    }
    serverButton.textContent = serverId === memberId ? "Stop being Server" : "Make this device the Server";
    serverButton.disabled = serverId !== null && serverId !== memberId;
}

async function setServerRole() {
    const enabled = serverId !== memberId;
    serverButton.disabled = true;
    try {
        const result = await api("server", {
            method: "POST",
            query: `&room=${encodeURIComponent(roomCode)}`,
            body: { enabled }
        });
        serverId = result.serverId || null;
        updateServerControls();
        renderParticipants();
        updateConnectionStatus();
    } catch (error) {
        showConnectionError(error);
    } finally {
        updateServerControls();
    }
}

function updateMediaControls() {
    const controls = [
        { button: toggleAudioButton, kind: "audio", label: "microphone" },
        { button: toggleVideoButton, kind: "video", label: "camera" }
    ];
    for (const { button, kind, label } of controls) {
        const active = localTracks[kind] !== null;
        button.textContent = active ? `Turn ${label} off` : `Enable ${label}`;
        button.setAttribute("aria-pressed", String(active));
        button.disabled = localMediaPending.has(kind);
    }
}

function desiredMediaDirection(kind) {
    return localTracks[kind] ? "sendrecv" : "recvonly";
}

function updateMediaTile(id, stream) {
    let tile = mediaTiles.get(id);
    const videoTrack = stream && stream.getVideoTracks().find(track => track.readyState === "live" && track.enabled && !track.muted);
    if (!videoTrack) {
        if (tile) {
            tile.figure.remove();
            mediaTiles.delete(id);
        }
        return false;
    }
    if (!tile) {
        const figure = document.createElement("figure");
        const video = document.createElement("video");
        const caption = document.createElement("figcaption");
        figure.className = "video-tile";
        video.autoplay = true;
        video.playsInline = true;
        video.muted = true;
        caption.className = "video-tile-caption";
        figure.append(video, caption);
        mediaGrid.append(figure);
        tile = { figure, video, caption };
        mediaTiles.set(id, tile);
    }
    if (tile.video.srcObject !== stream) tile.video.srcObject = stream;
    tile.caption.textContent = id === memberId ? "You" : participantLabel(id);
    return true;
}

function renderMediaTiles() {
    let hasVideo = false;
    for (const member of members.values()) {
        const isLocal = member.id === memberId;
        const peer = peerConnections.get(member.id);
        const stream = isLocal ? localMediaStream : peer ? peer.remoteStream : null;

        if (!isLocal && peer) {
            if (!peer.audioElement) {
                peer.audioElement = document.createElement("audio");
                peer.audioElement.autoplay = true;
                peer.audioElement.muted = true;
                audioPlayback.append(peer.audioElement);
            }
            peer.audioElement.muted = remoteMuted.has(member.id);
            if (peer.audioElement.srcObject !== stream) {
                peer.audioElement.srcObject = stream;
                if (!peer.audioElement.muted && stream && stream.getAudioTracks().length > 0) {
                    peer.audioElement.play().catch(showConnectionError);
                }
            }
        }
        hasVideo = updateMediaTile(member.id, stream) || hasVideo;
    }

    for (const [id, tile] of mediaTiles) {
        if (!members.has(id)) {
            tile.figure.remove();
            mediaTiles.delete(id);
        }
    }
    mainTablePlaceholder.hidden = hasVideo || !mainTableImage.hidden;
}

function toggleRemoteAudio(id) {
    if (remoteMuted.has(id)) {
        remoteMuted.delete(id);
    } else {
        remoteMuted.add(id);
    }
    const peer = peerConnections.get(id);
    if (peer && peer.audioElement) {
        peer.audioElement.muted = remoteMuted.has(id);
        if (!peer.audioElement.muted && peer.audioElement.srcObject) {
            peer.audioElement.play().catch(showConnectionError);
        }
    }
    renderParticipants();
}

async function syncPeerMedia(peer) {
    await Promise.all(["audio", "video"].map(async kind => {
        const transceiver = peer.transceivers[kind];
        await transceiver.sender.replaceTrack(localTracks[kind]);
        transceiver.direction = desiredMediaDirection(kind);
    }));
}

async function replaceLocalTrack(kind, nextTrack, epoch = roomEpoch) {
    const currentTrack = localTracks[kind];
    const activePeers = [...peerConnections.values()].filter(peer => peer.transceivers);
    try {
        await Promise.all(activePeers.map(peer => peer.transceivers[kind].sender.replaceTrack(nextTrack)));
    } catch (error) {
        await Promise.all(activePeers.map(async peer => {
            try {
                await peer.transceivers[kind].sender.replaceTrack(currentTrack);
            } catch (rollbackError) {
                console.error("Could not restore a peer's previous media track.", rollbackError);
            }
        }));
        throw error;
    }
    if (epoch !== roomEpoch || !roomCode) {
        if (nextTrack) nextTrack.stop();
        return false;
    }

    if (currentTrack && localMediaStream) localMediaStream.removeTrack(currentTrack);
    localTracks[kind] = nextTrack;
    if (nextTrack) {
        if (!localMediaStream) localMediaStream = new MediaStream();
        localMediaStream.addTrack(nextTrack);
    }
    if (currentTrack) currentTrack.stop();
    const renegotiations = [];
    for (const [id, peer] of peerConnections) {
        const transceiver = peer.transceivers && peer.transceivers[kind];
        if (!transceiver) continue;
        const direction = desiredMediaDirection(kind);
        if (transceiver.direction === direction) continue;
        transceiver.direction = direction;
        if (peer.connection.localDescription || peer.connection.remoteDescription) {
            renegotiations.push(requestPeerNegotiation(id, peer));
        }
    }
    await Promise.all(renegotiations);
    renderMediaTiles();
    updateMediaControls();
    renderParticipants();
    return true;
}

async function toggleLocalMedia(kind) {
    if (localMediaPending.has(kind)) return;
    const epoch = roomEpoch;
    localMediaPending.add(kind);
    updateMediaControls();
    renderParticipants();
    try {
        if (localTracks[kind]) {
            await replaceLocalTrack(kind, null, epoch);
            return;
        }
        if (!window.isSecureContext || !navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
            throw new Error("Camera and microphone access requires HTTPS. Open ConMan over HTTPS and grant browser permission.");
        }
        const stream = await navigator.mediaDevices.getUserMedia({
            audio: kind === "audio",
            video: kind === "video"
        });
        if (epoch !== roomEpoch || !roomCode) {
            stream.getTracks().forEach(track => track.stop());
            return;
        }
        const track = stream.getTracks().find(candidate => candidate.kind === kind);
        for (const unusedTrack of stream.getTracks()) {
            if (unusedTrack !== track) unusedTrack.stop();
        }
        if (!track) throw new Error(`The browser did not provide a ${kind} track.`);
        try {
            await replaceLocalTrack(kind, track, epoch);
        } catch (error) {
            track.stop();
            throw error;
        }
        track.addEventListener("ended", () => {
            if (localTracks[kind] === track) {
                replaceLocalTrack(kind, null, epoch).catch(showConnectionError);
            }
        }, { once: true });
    } catch (error) {
        showConnectionError(error);
    } finally {
        localMediaPending.delete(kind);
        updateMediaControls();
        renderParticipants();
    }
}

function stopLocalMedia() {
    for (const kind of ["audio", "video"]) {
        const track = localTracks[kind];
        localTracks[kind] = null;
        if (track) {
            if (localMediaStream) localMediaStream.removeTrack(track);
            track.stop();
        }
    }
    localMediaStream = null;
    updateMediaControls();
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

    const anyOpenChannel = serverId && serverId !== memberId
        ? Boolean(peerConnections.get(serverId) && peerConnections.get(serverId).channel && peerConnections.get(serverId).channel.readyState === "open")
        : [...peerConnections.values()].some(peer => peer.channel && peer.channel.readyState === "open");
    messageInput.disabled = !anyOpenChannel;
    sendButton.disabled = !anyOpenChannel;
    renderParticipants();
}

function createPeer(member) {
    const connection = new RTCPeerConnection({
        iceServers: [{ urls: "stun:stun.l.google.com:19302" }]
    });
    const peer = {
        connection,
        transceivers: null,
        channel: null,
        pendingCandidates: [],
        remoteStream: null,
        audioElement: null,
        offerPending: false,
        offerInProgress: false
    };
    if (memberOrder < member.order) {
        peer.transceivers = {
            audio: connection.addTransceiver("audio", { direction: desiredMediaDirection("audio") }),
            video: connection.addTransceiver("video", { direction: desiredMediaDirection("video") })
        };
    }
    peerConnections.set(member.id, peer);
    remoteMuted.add(member.id);
    peer.connection.ontrack = event => {
        if (event.streams.length > 0) {
            peer.remoteStream = event.streams[0];
        } else {
            if (!peer.remoteStream) peer.remoteStream = new MediaStream();
            if (!peer.remoteStream.getTracks().includes(event.track)) peer.remoteStream.addTrack(event.track);
        }
        event.track.addEventListener("mute", renderMediaTiles);
        event.track.addEventListener("unmute", renderMediaTiles);
        event.track.addEventListener("ended", renderMediaTiles);
        renderMediaTiles();
    };

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
            if (message.type !== "chat" && !serverId && typeof message.text === "string") {
                appendMessage(message.text, false, participantLabel(id));
                return;
            }
            if (message.type !== "chat" || typeof message.text !== "string" || message.text.length > 4000) {
                throw new Error("Received an invalid chat message.");
            }
            const senderId = message.senderId;
            if (!members.has(senderId)) {
                throw new Error("Received a chat message from an unknown device.");
            }
            if (serverId === memberId) {
                if (senderId !== id) throw new Error("A device sent a chat message for another device.");
                appendMessage(message.text, false, participantLabel(senderId));
                relayChatMessage(senderId, message.text, id);
                return;
            }
            if (serverId && id !== serverId) return;
            if (!serverId && senderId !== id) throw new Error("A device sent a chat message for another device.");
            appendMessage(message.text, senderId === memberId, senderId === memberId ? "You" : participantLabel(senderId));
        } catch {
            showConnectionError(new Error("Received an invalid message from another device."));
        }
    };
    updateConnectionStatus();
}

function adoptRemoteTransceivers(peer) {
    const transceivers = peer.connection.getTransceivers();
    const audio = transceivers.find(transceiver => transceiver.mid !== null && transceiver.receiver.track.kind === "audio");
    const video = transceivers.find(transceiver => transceiver.mid !== null && transceiver.receiver.track.kind === "video");
    if (!audio || !video) {
        throw new Error("The browser did not negotiate the room's audio and video channels.");
    }
    peer.transceivers = { audio, video };
}

async function startOffer(id, peer) {
    peer.offerPending = true;
    await createPendingOffer(id, peer);
}

async function requestPeerNegotiation(id, peer) {
    if (memberOrder < members.get(id).order) {
        peer.offerPending = true;
        await createPendingOffer(id, peer);
        return;
    }
    await sendSignal(id, "renegotiate", {});
}

async function createPendingOffer(id, peer) {
    if (!peer.offerPending || peer.offerInProgress || peer.connection.signalingState !== "stable") return;
    peer.offerPending = false;
    peer.offerInProgress = true;
    try {
        await syncPeerMedia(peer);
        const offer = await peer.connection.createOffer();
        await peer.connection.setLocalDescription(offer);
        await sendSignal(id, "offer", { sdp: offer.sdp });
    } finally {
        peer.offerInProgress = false;
    }
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
        adoptRemoteTransceivers(peer);
        await syncPeerMedia(peer);
        await flushCandidates(peer);
        const answer = await peer.connection.createAnswer();
        await peer.connection.setLocalDescription(answer);
        await sendSignal(member.id, "answer", { sdp: answer.sdp });
    } else if (signal.type === "answer" && member.order > memberOrder) {
        await peer.connection.setRemoteDescription({ type: "answer", sdp: signal.payload.sdp });
        await flushCandidates(peer);
        await createPendingOffer(member.id, peer);
    } else if (signal.type === "renegotiate" && member.order > memberOrder) {
        peer.offerPending = true;
        await createPendingOffer(member.id, peer);
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
            if (peer.audioElement) {
                peer.audioElement.pause();
                peer.audioElement.srcObject = null;
                peer.audioElement.remove();
            }
            const tile = mediaTiles.get(id);
            if (tile) tile.figure.remove();
            mediaTiles.delete(id);
            remoteMuted.delete(id);
            peerConnections.delete(id);
        }
    }
    members = nextMembers;
    if (serverId && !members.has(serverId)) serverId = null;
    for (const member of members.values()) {
        if (member.id !== memberId) ensurePeer(member);
    }
    renderMediaTiles();
    updateServerControls();
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
            serverId = result.serverId || null;
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
                    roomEpoch++;
                    closePeerConnections();
                    members = new Map();
                    stopLocalMedia();
                    renderMediaTiles();
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
    const targetPeer = serverId && serverId !== memberId ? peerConnections.get(serverId) : null;
    const openChannels = targetPeer
        ? targetPeer.channel && targetPeer.channel.readyState === "open" ? [targetPeer.channel] : []
        : [...peerConnections.values()]
            .map(peer => peer.channel)
            .filter(channel => channel && channel.readyState === "open");
    if (openChannels.length === 0) return;

    const payload = JSON.stringify({ type: "chat", senderId: memberId, text });
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
    const expectedRecipients = serverId === memberId ? members.size - 1 : openChannels.length;
    if (sent === 0) {
        showConnectionError(new Error("Message could not be sent to any device."));
    } else if (sent < expectedRecipients) {
        showConnectionError(new Error(`Message sent to ${sent} of ${expectedRecipients} other devices.`));
    }
}

function relayChatMessage(senderId, text, excludedMemberId) {
    const recipients = [...members.keys()].filter(id => id !== memberId && id !== excludedMemberId);
    let sent = 0;
    const payload = JSON.stringify({ type: "chat", senderId, text });
    for (const id of recipients) {
        const channel = peerConnections.get(id)?.channel;
        if (!channel || channel.readyState !== "open") continue;
        try {
            channel.send(payload);
            sent++;
        } catch {
            continue;
        }
    }
    if (sent < recipients.length) {
        showConnectionError(new Error(`Chat relay reached ${sent} of ${recipients.length} other devices.`));
    }
}

function closePeerConnections() {
    for (const peer of peerConnections.values()) {
        peer.connection.close();
        if (peer.audioElement) {
            peer.audioElement.pause();
            peer.audioElement.srcObject = null;
            peer.audioElement.remove();
        }
    }
    peerConnections.clear();
    mediaTiles.clear();
    remoteMuted.clear();
    mediaGrid.replaceChildren();
    audioPlayback.replaceChildren();
    mainTablePlaceholder.hidden = false;
}

async function leaveRoom() {
    polling = false;
    roomEpoch++;
    if (roomMenu.open) roomMenu.close();
    closePeerConnections();
    stopLocalMedia();
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
    serverId = null;
    members.clear();
    welcome.hidden = false;
    connection.hidden = true;
    document.querySelector(".shell").classList.remove("has-room");
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
serverButton.addEventListener("click", setServerRole);
toggleAudioButton.addEventListener("click", () => toggleLocalMedia("audio"));
toggleVideoButton.addEventListener("click", () => toggleLocalMedia("video"));
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
