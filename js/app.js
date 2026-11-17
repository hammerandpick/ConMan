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
const jsonDataForm = document.querySelector("#json-data-form");
const jsonDataInput = document.querySelector("#json-data-input");
const jsonDataOutput = document.querySelector("#json-data-output");
const jsonDataError = document.querySelector("#json-data-error");
const jsonDataStatus = document.querySelector("#json-data-status");
const savedJsonHistory = document.querySelector("#saved-json-history");
const savedJsonList = document.querySelector("#saved-json-list");
const importJsonFile = document.querySelector("#import-json-file");

const ROOM_AUTOSAVE_PREFIX = "conman:room-autosave:";
const MAX_ROOM_DATA_BYTES = 64 * 1024;
const MAX_DATA_CHANNEL_MESSAGE_BYTES = 64 * 1024;
const DATA_BATCH_TARGET_BYTES = 48 * 1024;
const ROOM_AUTOSAVE_INTERVAL = 5 * 60 * 1000;
const DATA_COORDINATOR_HEARTBEAT_INTERVAL = 5 * 1000;
const DATA_COORDINATOR_TIMEOUT = 30 * 1000;

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
let dataCoordinatorId = null;
let coordinatorLastHeartbeatAt = 0;
let lastCoordinatorHeartbeatSentAt = 0;
let coordinatorHeartbeatTimer = null;
let coordinatorHealthTimer = null;
let coordinatorFailoverPending = false;
let nextCoordinatorFailoverAttemptAt = 0;
let localMediaStream = null;
let roomEpoch = 0;
let mergedRoomData = [];
let roomAutosaveTimer = null;

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
    if (roomCode && Array.isArray(result.legacyData)) {
        try {
            const accepted = mergeRoomData(result.legacyData);
            if (accepted > 0 && memberId === getDataCoordinatorId()) broadcastRoomDataState();
        } catch (error) {
            showError(jsonDataError, `Could not migrate data from the old server-stored room data: ${error.message}`);
        }
    }
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
    dataCoordinatorId = result.dataCoordinatorId || serverId || memberId;
    coordinatorLastHeartbeatAt = Date.now();
    members = new Map([[memberId, { id: memberId, order: memberOrder }]]);
    clearError(jsonDataError);
    jsonDataStatus.textContent = "";
    try {
        mergedRoomData = loadLocalRoomData(roomCode);
    } catch (error) {
        mergedRoomData = [];
        showError(jsonDataError, `Could not restore data saved on this device: ${error.message}`);
    }
    if (Array.isArray(result.legacyData)) {
        try {
            mergeRoomData(result.legacyData);
        } catch (error) {
            showError(jsonDataError, `Could not migrate data from the old server-stored room data: ${error.message}`);
        }
    }
    messages.replaceChildren();
    renderRoomData(mergedRoomData);
    jsonDataInput.value = "";
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
    startRoomAutosave();
    startCoordinatorMonitoring();
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
    const dataCoordinatorId = getDataCoordinatorId();
    const coordinatorDescription = dataCoordinatorId
        ? `${participantLabel(dataCoordinatorId)} merges shared JSON data${dataCoordinatorId !== (serverId || getLowestOrderMemberId()) ? " after automatic failover" : ""}.`
        : "No device is currently available to merge shared JSON data.";
    if (!serverId) {
        serverStatus.textContent = `No Server is selected. Chat is sent directly; ${coordinatorDescription}`;
    } else if (serverId === memberId) {
        serverStatus.textContent = `This device is the Server and relays chat; ${coordinatorDescription}`;
    } else {
        serverStatus.textContent = `${participantLabel(serverId)} is the Server and relays chat; ${coordinatorDescription}`;
    }
    serverButton.textContent = serverId === memberId ? "Stop being Server" : "Make this device the Server";
    serverButton.disabled = serverId !== null && serverId !== memberId;
}

function getLowestOrderMemberId() {
    let lowestOrderMember = null;
    for (const member of members.values()) {
        if (!lowestOrderMember || member.order < lowestOrderMember.order) lowestOrderMember = member;
    }
    return lowestOrderMember ? lowestOrderMember.id : null;
}

async function setServerRole() {
    const previousCoordinatorId = getDataCoordinatorId();
    const enabled = serverId !== memberId;
    serverButton.disabled = true;
    try {
        const result = await api("server", {
            method: "POST",
            query: `&room=${encodeURIComponent(roomCode)}`,
            body: { enabled }
        });
        serverId = result.serverId || null;
        updateDataCoordinator(result.dataCoordinatorId || serverId || getLowestOrderMemberId());
        updateServerControls();
        renderParticipants();
        updateConnectionStatus();
        if (getDataCoordinatorId() !== previousCoordinatorId) {
            coordinatorLastHeartbeatAt = Date.now();
            synchronizeRoomData();
        }
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
    channel.onopen = () => {
        updateConnectionStatus();
        synchronizeRoomDataWithPeer(id);
    };
    channel.onclose = updateConnectionStatus;
    channel.onmessage = event => {
        try {
            const message = JSON.parse(event.data);
            if (message.type !== "chat" && !serverId && typeof message.text === "string") {
                appendMessage(message.text, false, participantLabel(id));
                return;
            }
            if (message.type !== "chat") {
                handleRoomDataChannelMessage(id, message);
                return;
            }
            if (typeof message.text !== "string" || message.text.length > 4000) {
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
    if (channel.readyState === "open") synchronizeRoomDataWithPeer(id);
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

function getDataCoordinatorId() {
    if (dataCoordinatorId) return dataCoordinatorId;
    if (serverId && members.has(serverId)) return serverId;
    return getLowestOrderMemberId();
}

function updateDataCoordinator(coordinatorId) {
    const nextCoordinatorId = typeof coordinatorId === "string" ? coordinatorId : null;
    if (dataCoordinatorId !== nextCoordinatorId) {
        dataCoordinatorId = nextCoordinatorId;
        coordinatorLastHeartbeatAt = Date.now();
        lastCoordinatorHeartbeatSentAt = 0;
        coordinatorFailoverPending = false;
        nextCoordinatorFailoverAttemptAt = 0;
    }
}

function startCoordinatorMonitoring() {
    stopCoordinatorMonitoring();
    broadcastCoordinatorHeartbeat();
    coordinatorHeartbeatTimer = setInterval(broadcastCoordinatorHeartbeat, DATA_COORDINATOR_HEARTBEAT_INTERVAL);
    coordinatorHealthTimer = setInterval(checkCoordinatorHealth, 1000);
}

function stopCoordinatorMonitoring() {
    if (coordinatorHeartbeatTimer !== null) {
        clearInterval(coordinatorHeartbeatTimer);
        coordinatorHeartbeatTimer = null;
    }
    if (coordinatorHealthTimer !== null) {
        clearInterval(coordinatorHealthTimer);
        coordinatorHealthTimer = null;
    }
}

function broadcastCoordinatorHeartbeat() {
    if (getDataCoordinatorId() !== memberId) return;
    const now = Date.now();
    if (now - lastCoordinatorHeartbeatSentAt < DATA_COORDINATOR_HEARTBEAT_INTERVAL) return;
    lastCoordinatorHeartbeatSentAt = now;
    coordinatorLastHeartbeatAt = now;
    for (const id of members.keys()) {
        if (id === memberId) continue;
        const peer = peerConnections.get(id);
        if (!peer || !peer.channel || peer.channel.readyState !== "open") continue;
        try {
            sendRoomDataMessage(id, { type: "room-data-heartbeat", senderId: memberId });
        } catch (error) {
            showConnectionError(error);
        }
    }
}

function checkCoordinatorHealth() {
    const coordinatorId = getDataCoordinatorId();
    if (!coordinatorId || coordinatorId === memberId) return;
    if (!coordinatorLastHeartbeatAt) coordinatorLastHeartbeatAt = Date.now();
    if (Date.now() - coordinatorLastHeartbeatAt < DATA_COORDINATOR_TIMEOUT
        || coordinatorFailoverPending || Date.now() < nextCoordinatorFailoverAttemptAt) return;

    coordinatorFailoverPending = true;
    api("coordinator-failover", {
        method: "POST",
        query: `&room=${encodeURIComponent(roomCode)}`,
        body: { coordinatorId }
    }).then(result => {
        const previousCoordinatorId = getDataCoordinatorId();
        updateDataCoordinator(result.dataCoordinatorId || null);
        if (getDataCoordinatorId() === previousCoordinatorId) {
            coordinatorLastHeartbeatAt = Date.now();
            nextCoordinatorFailoverAttemptAt = Date.now() + 5000;
        }
        updateServerControls();
        if (getDataCoordinatorId() !== previousCoordinatorId) synchronizeRoomData();
    }).catch(error => {
        nextCoordinatorFailoverAttemptAt = Date.now() + 5000;
        showConnectionError(error);
    }).finally(() => {
        coordinatorFailoverPending = false;
    });
}

async function pollLoop() {
    const currentRoom = roomCode;
    while (polling && roomCode === currentRoom) {
        try {
            const result = await api("events", {
                query: `&room=${encodeURIComponent(currentRoom)}&after=${pollCursor}`
            });
            if (!polling || roomCode !== currentRoom) return;
            const previousCoordinatorId = getDataCoordinatorId();
            serverId = result.serverId || null;
            updateDataCoordinator(result.dataCoordinatorId || null);
            reconcileMembers(result.members);
            if (getDataCoordinatorId() !== previousCoordinatorId) synchronizeRoomData();
            for (const event of result.events) {
                try {
                    await handleSignal(event);
                } catch (error) {
                    showConnectionError(error);
                }
            }
            pollCursor = result.cursor;
            broadcastCoordinatorHeartbeat();
            checkCoordinatorHealth();
        } catch (error) {
            if (polling && roomCode === currentRoom) {
                setStatus(error.message);
                if (error.status === 403) {
                    saveRoomDataLocally(false);
                    polling = false;
                    stopRoomAutosave();
                    stopCoordinatorMonitoring();
                    roomEpoch++;
                    closePeerConnections();
                    stopLocalMedia();
                    members.clear();
                    roomCodeInput.value = currentRoom;
                    roomCode = "";
                    token = "";
                    memberId = "";
                    memberOrder = 0;
                    serverId = null;
                    dataCoordinatorId = null;
                    connection.hidden = true;
                    welcome.hidden = false;
                    document.querySelector(".shell").classList.remove("has-room");
                    renderParticipants();
                    clearError(connectionError);
                    showError(entryError, "This device was removed after 5 minutes of inactivity. Rejoin using the room code.");
                    return;
                }
                if (error.status === 404 || error.status === 410) {
                    polling = false;
                    stopRoomAutosave();
                    stopCoordinatorMonitoring();
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

function renderRoomData(data) {
    const formattedData = JSON.stringify(data, null, 2);
    if (formattedData !== jsonDataOutput.textContent) {
        jsonDataOutput.textContent = formattedData;
    }
}

const SAVED_DATA_KEY = "conman:saved-data";
const LEGACY_ROOM_DATA_PREFIX = "conman:merged-data:";

function getMergedDataForExport() {
    return JSON.stringify(JSON.parse(jsonDataOutput.textContent), null, 2);
}

function getSerializedByteLength(value) {
    return new Blob([JSON.stringify(value)]).size;
}

function validateMergedData(data) {
    if (!Array.isArray(data)) {
        throw new Error("The imported JSON must be an array of merged data records.");
    }
    for (const record of data) {
        if (!record || typeof record !== "object" || Array.isArray(record)
            || typeof record.key !== "string" || !/^[A-Za-z0-9._:-]{1,128}$/.test(record.key)
            || typeof record.timestamp !== "number" || !Number.isFinite(record.timestamp) || record.timestamp < 0
            || !Object.prototype.hasOwnProperty.call(record, "value")) {
            throw new Error("Each record must have a valid key, non-negative numeric timestamp, and value.");
        }
    }
    if (getSerializedByteLength(data) > MAX_ROOM_DATA_BYTES) {
        throw new Error("Merged room data cannot exceed 64 KiB.");
    }
    return data;
}

function validateSavedSnapshot(snapshot) {
    if (!snapshot || typeof snapshot !== "object" || Array.isArray(snapshot)
        || typeof snapshot.room !== "string"
        || typeof snapshot.savedAt !== "number" || !Number.isFinite(snapshot.savedAt) || snapshot.savedAt < 0) {
        throw new Error("Saved browser data has an invalid snapshot format.");
    }
    return {
        room: snapshot.room,
        savedAt: snapshot.savedAt,
        data: validateMergedData(snapshot.data),
        legacyKey: typeof snapshot.legacyKey === "string" ? snapshot.legacyKey : null,
        autoKey: typeof snapshot.autoKey === "string" ? snapshot.autoKey : null
    };
}

function latestRecordTimestamp(data) {
    return data.reduce((latest, record) => latest === null || record.timestamp > latest ? record.timestamp : latest, null);
}

function readSavedSnapshots() {
    const storedSnapshots = localStorage.getItem(SAVED_DATA_KEY);
    const snapshots = storedSnapshots === null ? [] : JSON.parse(storedSnapshots);
    if (!Array.isArray(snapshots)) {
        throw new Error("Saved browser data has an invalid snapshot list.");
    }
    const validatedSnapshots = snapshots.map(validateSavedSnapshot);
    const knownLegacyKeys = new Set(validatedSnapshots.map(snapshot => snapshot.legacyKey).filter(Boolean));
    const knownAutoKeys = new Set(validatedSnapshots.map(snapshot => snapshot.autoKey).filter(Boolean));
    const legacySnapshots = [];
    const autoSnapshots = [];

    for (let index = 0; index < localStorage.length; index++) {
        const key = localStorage.key(index);
        if (!key) continue;
        if (key.startsWith(LEGACY_ROOM_DATA_PREFIX) && !knownLegacyKeys.has(key)) {
            const data = validateMergedData(JSON.parse(localStorage.getItem(key)));
            legacySnapshots.push({
                room: key.slice(LEGACY_ROOM_DATA_PREFIX.length),
                savedAt: latestRecordTimestamp(data) ?? 0,
                data,
                legacyKey: key
            });
        } else if (key.startsWith(ROOM_AUTOSAVE_PREFIX) && !knownAutoKeys.has(key)) {
            const autosave = JSON.parse(localStorage.getItem(key));
            if (!autosave || typeof autosave !== "object"
                || typeof autosave.savedAt !== "number" || !Number.isFinite(autosave.savedAt) || autosave.savedAt < 0) {
                throw new Error("An automatic browser save has an invalid snapshot format.");
            }
            autoSnapshots.push({
                room: key.slice(ROOM_AUTOSAVE_PREFIX.length),
                savedAt: autosave.savedAt,
                data: validateMergedData(autosave.data),
                autoKey: key
            });
        }
    }

    return [...validatedSnapshots, ...legacySnapshots, ...autoSnapshots].sort((a, b) => b.savedAt - a.savedAt);
}

function loadLocalRoomData(code) {
    const autosave = localStorage.getItem(`${ROOM_AUTOSAVE_PREFIX}${code}`);
    if (autosave !== null) {
        const snapshot = JSON.parse(autosave);
        if (!snapshot || typeof snapshot !== "object"
            || typeof snapshot.savedAt !== "number" || !Number.isFinite(snapshot.savedAt) || snapshot.savedAt < 0) {
            throw new Error("The automatic save has an invalid snapshot format.");
        }
        return validateMergedData(snapshot.data);
    }

    const existing = readSavedSnapshots().find(snapshot => snapshot.room === code);
    return existing ? existing.data : [];
}

function renderSavedSnapshots(snapshots) {
    savedJsonList.replaceChildren();
    savedJsonHistory.hidden = false;
    if (snapshots.length === 0) {
        const emptyItem = document.createElement("li");
        emptyItem.textContent = "No saved data is available in this browser.";
        savedJsonList.append(emptyItem);
        return;
    }

    for (const snapshot of snapshots) {
        const item = document.createElement("li");
        const heading = document.createElement("div");
        heading.className = "saved-json-heading";
        const summary = document.createElement("span");
        const timestamp = snapshot.legacyKey ? latestRecordTimestamp(snapshot.data) : snapshot.savedAt;
        const date = timestamp === null ? null : new Date(timestamp);
        const dateText = !date || Number.isNaN(date.getTime()) ? "date unavailable" : date.toLocaleString();
        const dateLabel = snapshot.autoKey
            ? `Auto-saved ${dateText}`
            : snapshot.legacyKey ? `Latest update ${dateText}` : `Saved ${dateText}`;
        summary.textContent = `Room ${snapshot.room || "unknown"} · ${dateLabel} · ${snapshot.data.length} ${snapshot.data.length === 1 ? "record" : "records"}`;

        const importButton = document.createElement("button");
        importButton.className = "button button-secondary";
        importButton.type = "button";
        importButton.textContent = "Import to this room";
        importButton.addEventListener("click", () => importMergedDataText(JSON.stringify(snapshot.data)));
        heading.append(summary, importButton);

        const details = document.createElement("details");
        const detailsSummary = document.createElement("summary");
        detailsSummary.textContent = "View saved records";
        const preview = document.createElement("pre");
        preview.className = "saved-json-preview";
        preview.textContent = JSON.stringify(snapshot.data, null, 2);
        details.append(detailsSummary, preview);
        item.append(heading, details);
        savedJsonList.append(item);
    }
}

function saveRoomDataLocally(showStatus) {
    if (!roomCode) return;
    try {
        localStorage.setItem(`${ROOM_AUTOSAVE_PREFIX}${roomCode}`, JSON.stringify({
            savedAt: Date.now(),
            data: mergedRoomData
        }));
        if (showStatus) jsonDataStatus.textContent = "Room data was automatically saved on this device.";
    } catch (error) {
        showError(jsonDataError, `Automatic local save failed: ${error.message}`);
    }
}

function startRoomAutosave() {
    stopRoomAutosave();
    saveRoomDataLocally(false);
    roomAutosaveTimer = setInterval(() => saveRoomDataLocally(true), ROOM_AUTOSAVE_INTERVAL);
}

function stopRoomAutosave() {
    if (roomAutosaveTimer !== null) {
        clearInterval(roomAutosaveTimer);
        roomAutosaveTimer = null;
    }
}

function mergeRoomData(updates) {
    validateMergedData(updates);
    const byKey = new Map(mergedRoomData.map(record => [record.key, record]));
    let accepted = 0;
    for (const update of updates) {
        const existing = byKey.get(update.key);
        if (existing && update.timestamp <= existing.timestamp) continue;
        byKey.set(update.key, { key: update.key, timestamp: update.timestamp, value: update.value });
        accepted++;
    }
    const merged = [...byKey.values()];
    if (getSerializedByteLength(merged) > MAX_ROOM_DATA_BYTES) {
        throw new Error("Merged room data cannot exceed 64 KiB.");
    }
    if (accepted > 0) {
        mergedRoomData = merged;
        renderRoomData(mergedRoomData);
        saveRoomDataLocally(false);
    }
    return accepted;
}

function splitDataRecords(records, messageType, fieldName) {
    const batches = [];
    let batch = [];
    for (const record of records) {
        const nextBatch = [...batch, record];
        const message = { type: messageType, senderId: memberId, [fieldName]: nextBatch };
        if (getSerializedByteLength(message) > DATA_BATCH_TARGET_BYTES && batch.length > 0) {
            batches.push(batch);
            batch = [record];
        } else {
            batch = nextBatch;
        }
        const singleMessage = { type: messageType, senderId: memberId, [fieldName]: batch };
        if (getSerializedByteLength(singleMessage) > MAX_DATA_CHANNEL_MESSAGE_BYTES) {
            throw new Error("A JSON data record is too large to send to the other devices.");
        }
    }
    if (batch.length > 0 || batches.length === 0) batches.push(batch);
    return batches;
}

function sendRoomDataMessage(id, message) {
    const peer = peerConnections.get(id);
    if (!peer || !peer.channel || peer.channel.readyState !== "open") {
        throw new Error(`${participantLabel(id)} is not connected for data sharing.`);
    }
    const serialized = JSON.stringify(message);
    if (new Blob([serialized]).size > MAX_DATA_CHANNEL_MESSAGE_BYTES) {
        throw new Error("The JSON data message is too large to send.");
    }
    peer.channel.send(serialized);
}

function sendRoomDataState(id) {
    const batches = splitDataRecords(mergedRoomData, "room-data-state", "records");
    for (const records of batches) {
        sendRoomDataMessage(id, { type: "room-data-state", senderId: memberId, records });
    }
}

function sendRoomDataUpdates(id, updates) {
    const batches = splitDataRecords(updates, "room-data-update", "updates");
    for (const batch of batches) {
        sendRoomDataMessage(id, { type: "room-data-update", senderId: memberId, updates: batch });
    }
}

function synchronizeRoomDataWithPeer(id) {
    const coordinatorId = getDataCoordinatorId();
    if (!coordinatorId || (memberId !== coordinatorId && id !== coordinatorId)) return;
    try {
        sendRoomDataMessage(id, { type: "room-data-sync-request", senderId: memberId });
        sendRoomDataState(id);
    } catch (error) {
        showConnectionError(error);
    }
}

function synchronizeRoomData() {
    const coordinatorId = getDataCoordinatorId();
    if (!coordinatorId) return;
    for (const id of members.keys()) {
        if (id === memberId || (memberId !== coordinatorId && id !== coordinatorId)) continue;
        const peer = peerConnections.get(id);
        if (!peer || !peer.channel || peer.channel.readyState !== "open") continue;
        try {
            sendRoomDataMessage(id, { type: "room-data-sync-request", senderId: memberId });
            sendRoomDataState(id);
        } catch (error) {
            showConnectionError(error);
        }
    }
}

function broadcastRoomDataState() {
    for (const id of members.keys()) {
        if (id === memberId) continue;
        const peer = peerConnections.get(id);
        if (!peer || !peer.channel || peer.channel.readyState !== "open") continue;
        try {
            sendRoomDataState(id);
        } catch (error) {
            showConnectionError(error);
        }
    }
}

function handleRoomDataChannelMessage(id, message) {
    if (!members.has(id) || message.senderId !== id) {
        throw new Error("Received JSON data from an unknown device.");
    }
    const coordinatorId = getDataCoordinatorId();
    if (message.type === "room-data-heartbeat") {
        if (id === coordinatorId) coordinatorLastHeartbeatAt = Date.now();
    } else if (message.type === "room-data-sync-request") {
        if (memberId === coordinatorId || id === coordinatorId) sendRoomDataState(id);
    } else if (message.type === "room-data-state") {
        const records = validateMergedData(message.records);
        if (memberId === coordinatorId) {
            if (mergeRoomData(records) > 0) broadcastRoomDataState();
            else sendRoomDataState(id);
        } else if (id === coordinatorId) {
            mergeRoomData(records);
        } else {
            throw new Error("Received merged JSON data from a non-coordinator device.");
        }
    } else if (message.type === "room-data-update") {
        if (memberId !== coordinatorId) throw new Error("A JSON update was sent to a non-coordinator device.");
        const accepted = mergeRoomData(message.updates);
        if (accepted > 0) broadcastRoomDataState();
        sendRoomDataMessage(id, { type: "room-data-ack", senderId: memberId, accepted });
    } else if (message.type === "room-data-ack") {
        if (id !== coordinatorId || !Number.isInteger(message.accepted) || message.accepted < 0) {
            throw new Error("Received an invalid JSON data acknowledgement.");
        }
        jsonDataStatus.textContent = "The coordinator processed this data batch; the merged room data is shown above.";
    } else {
        throw new Error("Received an unknown data-sharing message.");
    }
}

function importMergedData(data) {
    const records = validateMergedData(data);
    if (records.length === 0) {
        jsonDataStatus.textContent = "No records to import; room data was not changed.";
        return;
    }
    const coordinatorId = getDataCoordinatorId();
    if (!coordinatorId) throw new Error("There is no available device to merge room data.");
    if (coordinatorId === memberId) {
        const accepted = mergeRoomData(records);
        if (accepted > 0) broadcastRoomDataState();
        jsonDataStatus.textContent = accepted > 0
            ? `Merged ${accepted} new or newer ${accepted === 1 ? "record" : "records"} on this device.`
            : "No imported records were newer than the room data.";
        return;
    }
    sendRoomDataUpdates(coordinatorId, records);
    jsonDataStatus.textContent = `Sent ${records.length} ${records.length === 1 ? "record" : "records"} to ${participantLabel(coordinatorId)} for merging.`;
}

async function importMergedDataText(text) {
    clearError(jsonDataError);
    jsonDataStatus.textContent = "";
    try {
        await importMergedData(JSON.parse(text));
    } catch (error) {
        showError(jsonDataError, error.message);
    }
}

function saveMergedDataToLocalStorage() {
    clearError(jsonDataError);
    jsonDataStatus.textContent = "";
    try {
        const snapshots = readSavedSnapshots().filter(snapshot => !snapshot.autoKey);
        const legacyKeys = snapshots.map(snapshot => snapshot.legacyKey).filter(Boolean);
        snapshots.push({
            room: roomCode,
            savedAt: Date.now(),
            data: JSON.parse(getMergedDataForExport())
        });
        snapshots.sort((a, b) => b.savedAt - a.savedAt);
        localStorage.setItem(SAVED_DATA_KEY, JSON.stringify(snapshots));
        for (const key of legacyKeys) localStorage.removeItem(key);
        renderSavedSnapshots(readSavedSnapshots());
        jsonDataStatus.textContent = "Merged room data saved in this browser.";
    } catch (error) {
        showError(jsonDataError, `Could not save data in browser storage: ${error.message}`);
    }
}

async function loadMergedDataFromLocalStorage() {
    clearError(jsonDataError);
    jsonDataStatus.textContent = "";
    try {
        const snapshots = readSavedSnapshots();
        renderSavedSnapshots(snapshots);
        jsonDataStatus.textContent = `Showing ${snapshots.length} saved ${snapshots.length === 1 ? "snapshot" : "snapshots"}, newest first.`;
    } catch (error) {
        showError(jsonDataError, `Could not read browser storage: ${error.message}`);
    }
}

async function exportMergedDataToFile() {
    clearError(jsonDataError);
    jsonDataStatus.textContent = "";
    const content = getMergedDataForExport();
    const fileName = `conman-${roomCode}-merged-data.json`;
    try {
        if (typeof window.showSaveFilePicker === "function") {
            const fileHandle = await window.showSaveFilePicker({
                suggestedName: fileName,
                types: [{ description: "JSON file", accept: { "application/json": [".json"] } }]
            });
            const writable = await fileHandle.createWritable();
            await writable.write(content);
            await writable.close();
        } else {
            const fileUrl = URL.createObjectURL(new Blob([content], { type: "application/json" }));
            const link = document.createElement("a");
            link.href = fileUrl;
            link.download = fileName;
            link.click();
            setTimeout(() => URL.revokeObjectURL(fileUrl), 1000);
        }
        jsonDataStatus.textContent = "Merged room data exported to a JSON file.";
    } catch (error) {
        showError(jsonDataError, `Could not export the JSON file: ${error.message}`);
    }
}

async function handleMergedDataFileImport() {
    const file = importJsonFile.files[0];
    importJsonFile.value = "";
    if (!file) return;
    try {
        await importMergedDataText(await file.text());
    } catch (error) {
        showError(jsonDataError, `Could not read the selected file: ${error.message}`);
    }
}

async function sendJsonData(event) {
    event.preventDefault();
    clearError(jsonDataError);
    let updates;
    try {
        const parsed = JSON.parse(jsonDataInput.value);
        updates = Array.isArray(parsed) ? parsed : [parsed];
    } catch {
        showError(jsonDataError, "Enter valid JSON.");
        return;
    }
    try {
        importMergedData(updates);
        jsonDataInput.value = "";
    } catch (error) {
        showError(jsonDataError, error.message);
    }
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
    saveRoomDataLocally(false);
    stopRoomAutosave();
    stopCoordinatorMonitoring();
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
    dataCoordinatorId = null;
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
jsonDataForm.addEventListener("submit", sendJsonData);
document.querySelector("#open-room-menu").addEventListener("click", () => roomMenu.showModal());
document.querySelector("#close-room-menu").addEventListener("click", () => roomMenu.close());
document.querySelector("#leave-room").addEventListener("click", leaveRoom);
document.querySelector("#save-json-local").addEventListener("click", saveMergedDataToLocalStorage);
document.querySelector("#load-json-local").addEventListener("click", loadMergedDataFromLocalStorage);
document.querySelector("#export-json-file").addEventListener("click", exportMergedDataToFile);
document.querySelector("#import-json-file-button").addEventListener("click", () => importJsonFile.click());
importJsonFile.addEventListener("change", handleMergedDataFileImport);
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
