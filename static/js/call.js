// ============================================================================
//  TocaChat WebRTC — Native RTCPeerConnection (Mesh) + TURN
//  Refactored: proper Ring → Accept → Connect flow
// ============================================================================

// ── Core state ──────────────────────────────────────────────────────────────
let activeCalls = {};           // participantId → RTCPeerConnection
let localStream = null;
let isJoined = false;

let isInCall = false;
window.isInCall = false;
let isCameraOn = false;
window.isCameraOn = false;
let isMuted = false;

// "Calling" (ringing) state — caller is waiting for the callee to accept
let isRinging = false;          // true while CALLER is in the lobby
let ringTimeout = null;         // auto-cancel after 30 s

let callSourceId = null;
window.callSourceId = null;

// ── In-call badge set ────────────────────────────────────────────────────────
const usersInCall = new Set();
window.usersInCall = usersInCall;

let rtcConfigCache = null;
let callRetryInterval = null;

// ── Ringtone ─────────────────────────────────────────────────────────────────
let ringtoneCtx = null;
let ringtoneInterval = null;
let incomingCallTimeout = null;

// ============================================================================
//  Signaling — low-level HTTP POST wrapper
// ============================================================================
async function sendCallSignal(destId, tipo, dados, convId = null) {
    const cid = convId || window.callSourceId;
    if (!cid) return;
    try {
        await api('/api/calls/signal', {
            method: 'POST',
            body: { conversa_id: cid, destinatario_id: destId, tipo, dados }
        });
    } catch (e) {
        console.error('[Call] Signal send error:', e);
    }
}

// ============================================================================
//  Incoming signal dispatcher
//  Signals: ring, ring_accept, ring_decline, ring_cancel,
//           join, leave, decline, state, in_call, call_ended
// ============================================================================
window.handleIncomingSignal = async function (sinal) {
    let { remetente_id, tipo, dados, conversa_id } = sinal;
    dados = dados || {};
    console.log('[Call] Sinal recebido:', tipo, 'de', remetente_id, 'conv', conversa_id);

    // Resolve conversation object
    let callConv = (window.conversas || []).find(c => c.id == conversa_id);
    if (!callConv) {
        try {
            const fetched = await api(`/api/conversas/${conversa_id}`);
            if (fetched) {
                if (!window.conversas) window.conversas = [];
                if (!window.conversas.find(c => c.id == conversa_id)) window.conversas.push(fetched);
                callConv = fetched;
            }
        } catch (e) {
            console.warn('[Call] Conversa não encontrada:', conversa_id);
            return;
        }
    }
    if (!callConv) return;

    const caller = callConv.membros?.find(m => String(m.id) === String(remetente_id));
    const callerFallback = { id: remetente_id, nome: dados.callerName || 'Usuário', foto: dados.callerPhoto || null };
    const resolvedCaller = caller || callerFallback;

    // ── Ringing signals (pre-call handshake) ─────────────────────────────
    if (tipo === 'ring') {
        // Someone is calling us
        markParticipantInCall(remetente_id, true);
        if (!isInCall && !isRinging) {
            window._pendingIncomingCallData = { callConv, caller: resolvedCaller, dados };
            showIncomingCallAlert(callConv, resolvedCaller, dados);
        }
        return;
    }

    if (tipo === 'ring_accept') {
        // Callee accepted our ring — transition caller from lobby → actual call
        if (isRinging) {
            _cancelRingTimeout();
            dismissCallingOverlay();
            await _enterCall();
        }
        return;
    }

    if (tipo === 'ring_decline') {
        // Callee declined
        if (isRinging) {
            _cancelRingTimeout();
            dismissCallingOverlay();
            isRinging = false;
            markParticipantInCall(currentUser.id, false);
            showToast(`${resolvedCaller.nome} recusou a chamada.`, 'info');
        }
        return;
    }

    if (tipo === 'ring_cancel') {
        // Caller cancelled before we answered
        dismissIncomingCall();
        markParticipantInCall(remetente_id, false);
        return;
    }

    // ── In-call signals ───────────────────────────────────────────────────
    if (tipo === 'join') {
        // Legacy / multi-party join (kept for compatibility)
        markParticipantInCall(remetente_id, true);
        if (!isInCall && !isRinging) {
            window._pendingIncomingCallData = { callConv, caller: resolvedCaller, dados };
            showIncomingCallAlert(callConv, resolvedCaller, dados);
        }
        return;
    }

    if (tipo === 'leave') {
        markParticipantInCall(remetente_id, false);
        dismissIncomingCall();
        if (isInCall) removeRemoteParticipant(remetente_id);
        return;
    }

    if (tipo === 'decline') {
        markParticipantInCall(remetente_id, false);
        showToast(`${resolvedCaller.nome} recusou a chamada.`, 'info');
        return;
    }

    if (tipo === 'state') {
        updateRemoteParticipantState(remetente_id, dados);
        return;
    }

    if (tipo === 'in_call') {
        markParticipantInCall(dados.userId, true);
        return;
    }

    if (tipo === 'call_ended') {
        markParticipantInCall(dados.userId, false);
        return;
    }

    if (tipo === 'webrtc_offer') {
        await handleWebrtcOffer(remetente_id, dados.sdp);
        return;
    }

    if (tipo === 'webrtc_answer') {
        await handleWebrtcAnswer(remetente_id, dados.sdp);
        return;
    }

    if (tipo === 'webrtc_ice') {
        await handleWebrtcIce(remetente_id, dados.candidate);
        return;
    }
};

// ============================================================================
//  Remote participant state update
// ============================================================================
function updateRemoteParticipantState(participantId, state) {
    const videoNode = document.getElementById(`video-${participantId}`);
    const avatarNode = document.getElementById(`avatar-${participantId}`);
    if (!videoNode || !avatarNode || state.isCameraOn === undefined) return;

    if (state.isCameraOn) {
        videoNode.classList.remove('hidden');
        avatarNode.classList.add('hidden');
    } else {
        videoNode.classList.add('hidden');
        avatarNode.classList.remove('hidden');
    }
}

function broadcastStateChange() {
    if (!isInCall || !window.conversaAtual) return;
    const others = window.conversaAtual.membros.filter(m => m.id !== currentUser.id);
    for (const m of others) {
        sendCallSignal(m.id, 'state', { isMuted, isCameraOn }, callSourceId);
    }
}

// ============================================================================
//  In-call badge (participant list indicator)
// ============================================================================
const CALL_BADGE_SVG = '<path d="M22 16.92v3a2 2 0 0 1-2.18 2 19.79 19.79 0 0 1-8.63-3.07 19.5 19.5 0 0 1-6-6 19.79 19.79 0 0 1-3.07-8.67A2 2 0 0 1 4.11 2h3a2 2 0 0 1 2 1.72c.127.96.361 1.903.7 2.81a2 2 0 0 1-.45 2.11L8.09 9.91a16 16 0 0 0 6 6l1.27-1.27a2 2 0 0 1 2.11-.45c.907.339 1.85.573 2.81.7A2 2 0 0 1 22 16.92z"/>';

function markParticipantInCall(userId, isActive) {
    if (userId == null) return;
    const id = String(userId);
    if (isActive) usersInCall.add(id);
    else usersInCall.delete(id);
    _applyCallBadge(id, isActive);
    if (!isActive && typeof window.renderParticipantsSidebar === 'function' && window.conversaAtual) {
        window.renderParticipantsSidebar(window.conversaAtual);
        reapplyCallBadges();
    }
}

function _applyCallBadge(userId, isActive) {
    const list = document.getElementById('participantsList');
    const el = list
        ? list.querySelector(`[data-member-id="${userId}"]`)
        : document.querySelector(`[data-member-id="${userId}"], [data-user-id="${userId}"], #member-${userId}`);
    if (!el) return;

    const badgeId = `call-badge-${userId}`;
    if (isActive) {
        el.classList.add('member-in-call');
        const parent = el.parentElement;
        if (parent && el !== parent.firstElementChild) parent.insertBefore(el, parent.firstElementChild);
        if (!document.getElementById(badgeId)) {
            const badge = document.createElement('span');
            badge.className = 'call-status-badge';
            badge.id = badgeId;
            badge.innerHTML = `<svg width="11" height="11" viewBox="0 0 24 24" fill="currentColor">${CALL_BADGE_SVG}</svg> Em chamada`;
            const nameEl = el.querySelector('.participant-name') || el.querySelector('.member-name') || el.querySelector('.participant-info');
            if (nameEl) nameEl.insertAdjacentElement('afterend', badge);
            else el.appendChild(badge);
        }
    } else {
        el.classList.remove('member-in-call');
        const badge = document.getElementById(badgeId);
        if (badge) badge.remove();
    }
}

function reapplyCallBadges() {
    usersInCall.forEach(userId => _applyCallBadge(userId, true));
}
window.reapplyCallBadges = reapplyCallBadges;
window.reapplyParticipantsInCall = reapplyCallBadges;

// ============================================================================
//  Native WebRTC helpers (signaling via /api/calls/signal)
// ============================================================================
async function getWebrtcConfig() {
    if (rtcConfigCache) return rtcConfigCache;
    try {
        const res = await api('/api/webrtc/config');
        if (res?.rtc) rtcConfigCache = res.rtc;
    } catch (e) {
        console.warn('[WebRTC] Falha ao buscar configuração ICE no servidor', e);
    }
    return rtcConfigCache || {
        iceServers: [
            { urls: 'stun:stun.l.google.com:19302' },
            { urls: 'stun:stun1.l.google.com:19302' }
        ]
    };
}

async function ensurePeerConnection(remoteId) {
    const key = String(remoteId);
    if (activeCalls[key]) return activeCalls[key];

    const rtcConfig = await getWebrtcConfig();
    const pc = new RTCPeerConnection(rtcConfig);
    activeCalls[key] = pc;

    if (localStream) {
        localStream.getTracks().forEach(track => pc.addTrack(track, localStream));
    }

    pc.ontrack = (event) => {
        const [remoteStream] = event.streams;
        if (!remoteStream) return;
        console.log('[WebRTC] Stream recebida de', key,
            '— audio:', remoteStream.getAudioTracks().length,
            'video:', remoteStream.getVideoTracks().length);
        renderRemoteParticipant(key, remoteStream);
    };

    pc.onicecandidate = (event) => {
        if (!event.candidate) return;
        sendCallSignal(remoteId, 'webrtc_ice', { candidate: event.candidate }, callSourceId);
    };

    pc.onconnectionstatechange = () => {
        if (pc.connectionState === 'failed') {
            console.warn('[WebRTC] Conexão falhou com', key);
            removeRemoteParticipant(key);
        }
        if (pc.connectionState === 'closed' || pc.connectionState === 'disconnected') {
            removeRemoteParticipant(key);
        }
    };

    return pc;
}

async function createAndSendOffer(remoteId) {
    const pc = await ensurePeerConnection(remoteId);
    const offer = await pc.createOffer();
    await pc.setLocalDescription(offer);
    await sendCallSignal(remoteId, 'webrtc_offer', { sdp: offer }, callSourceId);
}

async function handleWebrtcOffer(remoteId, sdp) {
    if (!isInCall) return;
    const pc = await ensurePeerConnection(remoteId);
    await pc.setRemoteDescription(new RTCSessionDescription(sdp));
    const answer = await pc.createAnswer();
    await pc.setLocalDescription(answer);
    await sendCallSignal(remoteId, 'webrtc_answer', { sdp: answer }, callSourceId);
}

async function handleWebrtcAnswer(remoteId, sdp) {
    const pc = activeCalls[String(remoteId)];
    if (!pc) return;
    await pc.setRemoteDescription(new RTCSessionDescription(sdp));
}

async function handleWebrtcIce(remoteId, candidate) {
    const pc = activeCalls[String(remoteId)] || await ensurePeerConnection(remoteId);
    try {
        await pc.addIceCandidate(new RTCIceCandidate(candidate));
    } catch (e) {
        console.warn('[WebRTC] Falha ao adicionar ICE candidate', e);
    }
}

// ============================================================================
//  Media
// ============================================================================
async function getLocalMedia() {
    if (typeof populateMicrophones === 'function') populateMicrophones();

    try {
        localStream = await navigator.mediaDevices.getUserMedia({
            audio: true,
            video: isCameraOn
        });

        const localVid = document.getElementById('localVideo');
        if (localVid) { localVid.srcObject = localStream; localVid.muted = true; }

        if (isMuted) localStream.getAudioTracks().forEach(t => t.enabled = false);

        updateLocalVideo();

        return true;
    } catch (err) {
        console.error('[WebRTC] Falha ao capturar media:', err);
        if (isCameraOn) {
            isCameraOn = false;
            window.isCameraOn = false;
            return getLocalMedia();
        }
        return false;
    }
}

// ============================================================================
//  Call UI helpers
// ============================================================================
function showCallUI() {
    document.getElementById('chatMessages').classList.add('hidden');
    document.getElementById('chatInputArea').classList.add('hidden');
    const inlineView = document.getElementById('callInlineView');
    if (inlineView) inlineView.classList.remove('hidden');
    const grid = document.getElementById('remoteVideosGrid');
    if (grid) grid.innerHTML = '';
    updateControlsUI();
}

function hideCallUI() {
    const inlineView = document.getElementById('callInlineView');
    if (inlineView) inlineView.classList.add('hidden');
    document.getElementById('chatMessages').classList.remove('hidden');
    document.getElementById('chatInputArea').classList.remove('hidden');
    const grid = document.getElementById('remoteVideosGrid');
    if (grid) grid.innerHTML = '';
}

function showCallView() {
    if (!isInCall) return;
    document.getElementById('chatMessages').classList.add('hidden');
    document.getElementById('chatInputArea').classList.add('hidden');
    document.getElementById('subtopicsBar').classList.add('hidden');
    document.getElementById('callActiveBar').classList.add('hidden');
    const inlineView = document.getElementById('callInlineView');
    if (inlineView) inlineView.classList.remove('hidden');
}

function hideCallView() {
    if (!isInCall) return;
    const inlineView = document.getElementById('callInlineView');
    if (inlineView) inlineView.classList.add('hidden');
    document.getElementById('chatMessages').classList.remove('hidden');
    document.getElementById('chatInputArea').classList.remove('hidden');
    if (window.conversaAtual && window.conversaAtual.tipo === 'grupo') {
        document.getElementById('subtopicsBar').classList.remove('hidden');
    }
    document.getElementById('callActiveBar').classList.remove('hidden');
    setTimeout(() => {
        const msgs = document.getElementById('chatMessages');
        if (msgs) msgs.scrollTop = msgs.scrollHeight;
    }, 100);
}

function updateControlsUI() {
    const btnMute = document.getElementById('btnMuteMic');
    const btnCam  = document.getElementById('btnToggleCamera');

    if (btnMute) {
        btnMute.classList.toggle('off', isMuted);
        btnMute.innerHTML = isMuted
            ? `<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><line x1="1" y1="1" x2="23" y2="23"/><path d="M9 9v3a3 3 0 0 0 5.12 2.12M15 9.34V4a3 3 0 0 0-5.94-.6"/><path d="M17 16.95A7 7 0 0 1 5 12v-2m14 0v2a7 7 0 0 1-.11 1.23"/><line x1="12" y1="19" x2="12" y2="23"/><line x1="8" y1="23" x2="16" y2="23"/></svg>`
            : `<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 1a3 3 0 0 0-3 3v8a3 3 0 0 0 6 0V4a3 3 0 0 0-3-3z"/><path d="M19 10v2a7 7 0 0 1-14 0v-2"/><line x1="12" y1="19" x2="12" y2="23"/><line x1="8" y1="23" x2="16" y2="23"/></svg>`;
    }

    if (btnCam) {
        btnCam.classList.toggle('off', !isCameraOn);
        btnCam.innerHTML = isCameraOn
            ? `<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M23 7l-7 5 7 5V7z"/><rect x="1" y="5" width="15" height="14" rx="2" ry="2"/></svg>`
            : `<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M16.5 7.5l6.5-4v17l-6.5-4"/><path d="M2 5h11a2 2 0 0 1 2 2v10a2 2 0 0 1-2 2H2z"/><line x1="1" y1="1" x2="23" y2="23"/></svg>`;
    }
}

function updateLocalVideo() {
    const vid    = document.getElementById('localVideo');
    const avatar = document.getElementById('localVideoAvatar');
    if (!vid || !avatar) return;

    if (isCameraOn) {
        vid.classList.remove('hidden');
        avatar.classList.add('hidden');
    } else {
        vid.classList.add('hidden');
        avatar.classList.remove('hidden');
        avatar.innerHTML = getAvatarHtml(currentUser.id, currentUser.nome, currentUser.foto);
    }
}

function updateCallStatusText(text) {
    const el = document.getElementById('callStatus');
    if (el) el.textContent = text;
}

// ============================================================================
//  Grid / remote participant rendering
// ============================================================================
function updateGridLayout() {
    const grid = document.getElementById('remoteVideosGrid');
    if (!grid) return;
    const count = grid.children.length;
    grid.className = 'call-participants-grid';
    if (count === 1) grid.classList.add('grid-1');
    else if (count === 2) grid.classList.add('grid-2');
    else if (count > 2) grid.classList.add('grid-n');
}

function renderRemoteParticipant(participantId, stream, metadata = null) {
    const grid = document.getElementById('remoteVideosGrid');
    if (!grid) return;

    let container = document.getElementById(`participant-${participantId}`);
    if (!container) {
        container = document.createElement('div');
        container.className = 'remote-participant';
        container.id = `participant-${participantId}`;

        let fallbackName = 'Usuário';
        let fallbackPhoto = null;
        if (window.conversaAtual) {
            const member = window.conversaAtual.membros.find(m => String(m.id) === String(participantId));
            if (member) {
                fallbackName = member.nome;
                fallbackPhoto = member.foto;
            }
        }

        container.innerHTML = `
            <video autoplay playsinline id="video-${participantId}"></video>
            <div class="remote-avatar" id="avatar-${participantId}">
                ${getAvatarHtml(participantId, fallbackName, fallbackPhoto)}
            </div>
            <div class="remote-label">${fallbackName}</div>
        `;
        grid.appendChild(container);
    }

    const videoNode  = document.getElementById(`video-${participantId}`);
    const avatarNode = document.getElementById(`avatar-${participantId}`);

    if (videoNode && stream) {
        videoNode.srcObject = stream;
        videoNode.muted = false;

        videoNode.onloadedmetadata = () => {
            const p = videoNode.play();
            if (p) p.catch(() => document.addEventListener('click', () => videoNode.play(), { once: true }));
        };

        videoNode.classList.remove('hidden');
        if (avatarNode) avatarNode.classList.add('hidden');

        if (metadata && metadata.isCameraOn === false) {
            videoNode.classList.add('hidden');
            if (avatarNode) avatarNode.classList.remove('hidden');
        }

        stream.getVideoTracks().forEach(track => {
            track.onmute   = () => { videoNode.classList.add('hidden');    if (avatarNode) avatarNode.classList.remove('hidden'); };
            track.onunmute = () => { videoNode.classList.remove('hidden'); if (avatarNode) avatarNode.classList.add('hidden'); };
        });
    }

    updateGridLayout();
}

function removeRemoteParticipant(participantId) {
    const key = String(participantId);
    const container = document.getElementById(`participant-${participantId}`);
    if (container) { container.remove(); updateGridLayout(); }
    if (activeCalls[key]) delete activeCalls[key];
}

// ============================================================================
//  ▶  startCall() — CALLER entry point
//     Shows a "Chamando…" overlay, sends ring signal, waits for accept.
// ============================================================================
async function startCall() {
    if (isInCall || isRinging) return;

    callSourceId = window.conversaAtual?.id ?? null;
    window.callSourceId = callSourceId;
    if (!callSourceId) {
        showToast('Erro: conversa não identificada.', 'error');
        return;
    }

    const conv = window.conversaAtual;
    if (!conv) return;

    const others = conv.membros.filter(m => m.id !== currentUser.id);
    if (others.length === 0) {
        showToast('Não há outros membros nesta conversa.', 'info');
        return;
    }

    // Mark as ringing
    isRinging = true;
    markParticipantInCall(currentUser.id, true);

    // Pré-aquecer mídia e ICE em background
    getLocalMedia(); // non-blocking pre-warm
    getWebrtcConfig();

    // Show the "Chamando..." overlay
    const targetName = others.length === 1 ? others[0].nome : `${others.length} pessoas`;
    const targetPhoto = others.length === 1 ? others[0].foto : null;
    showCallingOverlay(targetName, targetPhoto, () => cancelCall());

    // Send 'ring' signal to every other member
    others.forEach(m => {
        sendCallSignal(m.id, 'ring', {
            callerName: currentUser.nome,
            callerPhoto: currentUser.foto || null,
            convName: conv.nome || null,
            convTipo: conv.tipo
        }, callSourceId);
    });

    // Auto-cancel after 30 s (no answer)
    ringTimeout = setTimeout(() => {
        if (isRinging) cancelCall();
    }, 30000);
}

// ── Cancel ring (before answer) ───────────────────────────────────────────
async function cancelCall() {
    if (!isRinging) return;
    _cancelRingTimeout();
    isRinging = false;

    dismissCallingOverlay();
    markParticipantInCall(currentUser.id, false);

    // Notify others that the ring was cancelled
    if (window.conversaAtual) {
        const others = window.conversaAtual.membros.filter(m => m.id !== currentUser.id);
        for (const m of others) {
            await sendCallSignal(m.id, 'ring_cancel', {}, callSourceId);
        }
    }

    callSourceId = null;
    window.callSourceId = null;

    // Kill any pre-warmed media
    if (localStream && !isInCall) {
        localStream.getTracks().forEach(t => t.stop());
        localStream = null;
    }
}

function _cancelRingTimeout() {
    if (ringTimeout) { clearTimeout(ringTimeout); ringTimeout = null; }
}


// ============================================================================
//  ▶  _enterCall() — shared by CALLER (after ring_accept) and CALLEE (after accept button)
// ============================================================================
async function _enterCall() {
    if (isInCall) return;

    isInCall = true;
    window.isInCall = true;
    isRinging = false;
    isMuted = false;
    isCameraOn = false; window.isCameraOn = false;

    showCallUI();
    updateCallStatusText('Conectando dispositivos...');

    // Inicializa mídia local e ICE/TURN
    const [hasMedia] = await Promise.all([
        getLocalMedia(),
        getWebrtcConfig()
    ]);

    if (!hasMedia || !localStream) {
        showToast('Não foi possível acessar câmera/microfone.', 'error');
        endCall(false);
        return;
    }

    updateCallStatusText('Conectando ao servidor de chamadas...');
    updateCallStatusText('Na chamada');
    isJoined = true;

    markParticipantInCall(currentUser.id, true);

    // Notify others that we are now in the call
    const conv = window.conversaAtual;
    if (conv) {
        const others = conv.membros.filter(m => m.id !== currentUser.id);
        others.forEach(m => {
            sendCallSignal(m.id, 'in_call', { userId: currentUser.id }, callSourceId);
        });

        // Tenta conexões mesh com todos os participantes
        const attemptCallToOthers = async () => {
            for (const m of others) {
                const key = String(m.id);
                if (activeCalls[key]) continue;

                console.log(`[WebRTC] Iniciando oferta para ${m.nome} (${key})`);
                await createAndSendOffer(key);
                sendCallSignal(m.id, 'state', { isMuted, isCameraOn }, callSourceId);
            }
        };

        const tryConnect = () => {
            if (!isInCall || !localStream || !window.conversaAtual) return;
            attemptCallToOthers();
        };

        tryConnect();
        if (callRetryInterval) clearInterval(callRetryInterval);
        callRetryInterval = setInterval(tryConnect, 4000);
    }

    if (window.performSync) window.performSync();
}

// ============================================================================
//  ▶  joinCall() — CALLEE entry point (called when they click Accept)
//     Also used as legacy join for backward compat.
// ============================================================================
async function joinCall() {
    if (isInCall) return;

    // If this is the callee accepting, tell the caller
    if (window._pendingIncomingCallData) {
        const { callConv, caller } = window._pendingIncomingCallData;
        window._pendingIncomingCallData = null;
        callSourceId = callConv.id;
        window.callSourceId = callSourceId;

        // Let caller know we accepted (they will call _enterCall on their side)
        await sendCallSignal(caller.id, 'ring_accept', {}, callSourceId);

        // Also ensure we are in the right conversation context
        if (!window.conversaAtual || window.conversaAtual.id !== callConv.id) {
            if (typeof abrirConversa === 'function') await abrirConversa(callConv.id);
        }
    } else {
        // Direct join (e.g. joining an already-active call)
        callSourceId = window.conversaAtual?.id ?? null;
        window.callSourceId = callSourceId;
        if (!callSourceId) {
            showToast('Erro: conversa não identificada.', 'error');
            return;
        }
    }

    await _enterCall();
}

// ============================================================================
//  ▶  endCall()
// ============================================================================
async function endCall(sendSignal = true) {
    _cancelRingTimeout();
    if (isRinging) { await cancelCall(); return; }

    markParticipantInCall(currentUser.id, false);

    if (sendSignal && isInCall && window.conversaAtual) {
        const others = window.conversaAtual.membros.filter(m => m.id !== currentUser.id);
        for (const m of others) {
            await sendCallSignal(m.id, 'call_ended', { userId: currentUser.id }, callSourceId);
            await sendCallSignal(m.id, 'leave', {}, callSourceId);
        }
    }

    // Cleanup
    if (callRetryInterval) { clearInterval(callRetryInterval); callRetryInterval = null; }

    if (localStream) { localStream.getTracks().forEach(t => t.stop()); localStream = null; }
    Object.values(activeCalls).forEach(pc => pc.close());
    activeCalls = {};

    isInCall = false;
    window.isInCall = false;
    callSourceId = null;
    window.callSourceId = null;
    isJoined = false;

    hideCallUI();
    if (window.performSync) window.performSync();
}

// ============================================================================
//  Audio / Camera controls
// ============================================================================
function toggleMute() {
    isMuted = !isMuted;
    if (localStream) localStream.getAudioTracks().forEach(t => t.enabled = !isMuted);
    updateControlsUI();
    updateLocalVideo();
    broadcastStateChange();
}

async function toggleCamera() {
    isCameraOn = !isCameraOn;
    window.isCameraOn = isCameraOn;

    const btnCam = document.getElementById('btnToggleCamera');
    if (btnCam) btnCam.classList.add('loading');

    try {
        if (localStream) localStream.getVideoTracks().forEach(t => { t.stop(); localStream.removeTrack(t); });

        if (isCameraOn) {
            const newStream = await navigator.mediaDevices.getUserMedia({ video: true });
            const videoTrack = newStream.getVideoTracks()[0];

            if (localStream) {
                localStream.addTrack(videoTrack);
            } else {
                localStream = await navigator.mediaDevices.getUserMedia({ audio: true, video: true });
            }

            Object.values(activeCalls).forEach(pc => {
                const sender = pc.getSenders().find(s => s.track?.kind === 'video');
                if (sender) sender.replaceTrack(videoTrack).catch(e => console.error(e));
                else if (pc.signalingState !== 'closed') pc.addTrack(videoTrack, localStream);
            });

            const localVid = document.getElementById('localVideo');
            if (localVid) localVid.srcObject = localStream;
        }

        updateControlsUI();
        updateLocalVideo();
        broadcastStateChange();
    } catch (e) {
        console.error('[WebRTC] Camera erro:', e);
        showToast('Erro ao alternar câmera', 'error');
        isCameraOn = false; window.isCameraOn = false;
        updateControlsUI();
        updateLocalVideo();
    } finally {
        if (btnCam) btnCam.classList.remove('loading');
        if (window.performSync) window.performSync();
    }
}

// ============================================================================
//  Device selection
// ============================================================================
async function populateMicrophones() {
    const menuList = document.getElementById('micDeviceList');
    if (!menuList) return;
    try {
        const devices = await navigator.mediaDevices.enumerateDevices();
        const audioInputs = devices.filter(d => d.kind === 'audioinput');
        menuList.innerHTML = '';
        audioInputs.forEach((device, index) => {
            const label = device.label || `Microfone ${index + 1}`;
            const div = document.createElement('div');
            div.className = 'device-item';
            div.textContent = label;
            div.onclick = () => switchMicrophone(device.deviceId, label);
            menuList.appendChild(div);
        });
        if (audioInputs.length === 0) {
            menuList.innerHTML = '<div class="device-item" style="color:var(--text-muted);cursor:default;">Nenhum microfone encontrado</div>';
        }
    } catch (e) {
        menuList.innerHTML = '<div class="device-item" style="color:var(--text-muted);cursor:default;">Erro ao ler microfones</div>';
    }
}

async function switchMicrophone(deviceId, label) {
    document.getElementById('micDeviceMenu').classList.add('hidden');
    try {
        if (localStream) {
            const audioStream = await navigator.mediaDevices.getUserMedia({ audio: { deviceId: { exact: deviceId } } });
            const newAudioTrack = audioStream.getAudioTracks()[0];
            localStream.getAudioTracks().forEach(t => { t.stop(); localStream.removeTrack(t); });
            localStream.addTrack(newAudioTrack);
            if (isMuted) newAudioTrack.enabled = false;
            Object.values(activeCalls).forEach(pc => {
                const sender = pc.getSenders().find(s => s.track?.kind === 'audio');
                if (sender) sender.replaceTrack(newAudioTrack).catch(e => console.warn(e));
            });
        }
        showToast(`Microfone: ${label}`, 'success');
    } catch (e) {
        console.error('[WebRTC] Switch Mic Error:', e);
        showToast('Erro ao trocar microfone', 'error');
    }
}

// ============================================================================
//  Ringtone (callee side)
// ============================================================================
function playRingtone() {
    try {
        if (!ringtoneCtx) {
            const AudioContext = window.AudioContext || window.webkitAudioContext;
            ringtoneCtx = new AudioContext();
        }
        if (ringtoneCtx.state === 'suspended') ringtoneCtx.resume();

        const osc  = ringtoneCtx.createOscillator();
        const gain = ringtoneCtx.createGain();
        osc.connect(gain);
        gain.connect(ringtoneCtx.destination);
        osc.type = 'sine';

        let time = ringtoneCtx.currentTime;
        for (let i = 0; i < 10; i++) {
            osc.frequency.setValueAtTime(440, time);
            osc.frequency.setValueAtTime(480, time + 0.1);
            gain.gain.setValueAtTime(0, time);
            gain.gain.linearRampToValueAtTime(0.5, time + 0.1);
            gain.gain.setValueAtTime(0.5, time + 1.0);
            gain.gain.linearRampToValueAtTime(0, time + 1.1);
            time += 5.0;
        }
        osc.start();
        ringtoneInterval = osc;
    } catch (e) { /* audio policy */ }
}

function stopRingtone() {
    if (ringtoneInterval) { try { ringtoneInterval.stop(); } catch (e) { } ringtoneInterval = null; }
    if (ringtoneCtx)      { try { ringtoneCtx.close();    } catch (e) { } ringtoneCtx = null; }
}

// ============================================================================
//  "Chamando…" overlay (CALLER side)
// ============================================================================
function showCallingOverlay(targetName, targetPhoto, onCancel) {
    dismissCallingOverlay(); // safety

    const overlay = document.createElement('div');
    overlay.id = 'callingOverlay';
    overlay.className = 'incoming-call-overlay'; // reuse same styles

    const photoHtml = targetPhoto
        ? `<img src="${targetPhoto}" alt="${targetName}" class="incoming-call-avatar-img">`
        : `<video autoplay loop muted playsinline class="default-avatar-vid" style="width:100%;height:100%;object-fit:cover;border-radius:50%;"><source src="/static/images/logo3.mp4" type="video/mp4"></video>`;

    overlay.innerHTML = `
        <div class="incoming-call-backdrop"></div>
        <div class="incoming-call-card">
            <div class="incoming-call-ring-effect"></div>
            <div class="incoming-call-avatar">${photoHtml}</div>
            <div class="incoming-call-info">
                <h3 class="incoming-call-name">${targetName}</h3>
                <p class="incoming-call-subtitle">Chamando…</p>
                <p class="incoming-call-type" id="callingDots">📞 ●○○</p>
            </div>
            <div class="incoming-call-actions">
                <button class="incoming-call-btn incoming-call-decline" id="btnCancelCall" title="Cancelar">
                    <svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                        <line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/>
                    </svg>
                </button>
            </div>
        </div>
    `;

    document.body.appendChild(overlay);
    requestAnimationFrame(() => overlay.classList.add('visible'));

    document.getElementById('btnCancelCall').onclick = () => {
        if (onCancel) onCancel();
    };

    // Animated dots: ●○○ → ○●○ → ○○●
    let dotStep = 0;
    const dotsEl = document.getElementById('callingDots');
    const patterns = ['📞 ●○○', '📞 ○●○', '📞 ○○●'];
    const dotTimer = setInterval(() => {
        if (!dotsEl || !dotsEl.isConnected) { clearInterval(dotTimer); return; }
        dotStep = (dotStep + 1) % patterns.length;
        dotsEl.textContent = patterns[dotStep];
    }, 600);
    overlay._dotTimer = dotTimer;
}

function dismissCallingOverlay() {
    const overlay = document.getElementById('callingOverlay');
    if (overlay) {
        if (overlay._dotTimer) clearInterval(overlay._dotTimer);
        overlay.classList.remove('visible');
        setTimeout(() => overlay.remove(), 300);
    }
}

// ============================================================================
//  Incoming call alert (CALLEE side)
// ============================================================================
function showIncomingCallAlert(callConv, callerMember, dados) {
    if (isInCall) return;
    dismissIncomingCall();

    const overlay = document.createElement('div');
    overlay.id = 'incomingCallOverlay';
    overlay.className = 'incoming-call-overlay';

    const callerPhoto = callerMember.foto
        ? `<img src="${callerMember.foto}" alt="${callerMember.nome}" class="incoming-call-avatar-img">`
        : `<video autoplay loop muted playsinline class="default-avatar-vid" style="width:100%;height:100%;object-fit:cover;border-radius:50%;"><source src="/static/images/logo3.mp4" type="video/mp4"></video>`;

    const subtitle = callConv.tipo === 'grupo' ? `em ${callConv.nome || 'Grupo'}` : 'Chamada direta';

    overlay.innerHTML = `
        <div class="incoming-call-backdrop" onclick="dismissIncomingCall()"></div>
        <div class="incoming-call-card">
            <div class="incoming-call-ring-effect"></div>
            <div class="incoming-call-avatar">${callerPhoto}</div>
            <div class="incoming-call-info">
                <h3 class="incoming-call-name">${callerMember.nome}</h3>
                <p class="incoming-call-subtitle">${subtitle}</p>
                <p class="incoming-call-type">📞 Chamada de vídeo/voz</p>
            </div>
            <div class="incoming-call-actions">
                <button class="incoming-call-btn incoming-call-accept" id="btnAcceptCall" title="Atender">
                    <svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M22 16.92v3a2 2 0 0 1-2.18 2 19.79 19.79 0 0 1-8.63-3.07 19.5 19.5 0 0 1-6-6 19.79 19.79 0 0 1-3.07-8.67A2 2 0 0 1 4.11 2h3a2 2 0 0 1 2 1.72c.127.96.361 1.903.7 2.81a2 2 0 0 1-.45 2.11L8.09 9.91a16 16 0 0 0 6 6l1.27-1.27a2 2 0 0 1 2.11-.45c.907.339 1.85.573 2.81.7A2 2 0 0 1 22 16.92z"/></svg>
                </button>
                <button class="incoming-call-btn incoming-call-decline" id="btnDeclineCall" title="Recusar">
                    <svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M10.68 13.31a16 16 0 0 0 3.41 2.6l1.27-1.27a2 2 0 0 1 2.11-.45c.907.339 1.85.573 2.81.7A2 2 0 0 1 22 16.92v3a2 2 0 0 1-2.18 2 19.79 19.79 0 0 1-8.63-3.07 19.5 19.5 0 0 1-6-6 19.79 19.79 0 0 1-3.07-8.67A2 2 0 0 1 4.11 2h3a2 2 0 0 1 2 1.72c.127.96.361 1.903.7 2.81a2 2 0 0 1-.45 2.11L8.09 9.91"/><line x1="1" y1="1" x2="23" y2="23"/></svg>
                </button>
            </div>
        </div>
    `;

    document.body.appendChild(overlay);
    playRingtone();
    requestAnimationFrame(() => overlay.classList.add('visible'));

    // Accept
    document.getElementById('btnAcceptCall').onclick = async () => {
        dismissIncomingCall();
        window._pendingIncomingCallData = { callConv, caller: callerMember, dados };
        window.callSourceId = callConv.id;
        if (!window.conversaAtual || window.conversaAtual.id !== callConv.id) {
            if (typeof abrirConversa === 'function') await abrirConversa(callConv.id);
        }
        await joinCall();
    };

    // Decline
    document.getElementById('btnDeclineCall').onclick = async () => {
        dismissIncomingCall();
        await sendCallSignal(callerMember.id, 'ring_decline', {}, callConv.id);
        markParticipantInCall(callerMember.id, false);
    };

    incomingCallTimeout = setTimeout(dismissIncomingCall, 30000);
}

function dismissIncomingCall() {
    stopRingtone();
    if (incomingCallTimeout) { clearTimeout(incomingCallTimeout); incomingCallTimeout = null; }
    const overlay = document.getElementById('incomingCallOverlay');
    if (overlay) {
        overlay.classList.remove('visible');
        setTimeout(() => overlay.remove(), 300);
    }
}

// ============================================================================
//  Event bindings
// ============================================================================
window.addEventListener('DOMContentLoaded', () => {

    // 📞 Audio call button — now calls startCall()
    const btnAudio = document.getElementById('btnCallAudio');
    if (btnAudio) btnAudio.addEventListener('click', () => {
        if (!isInCall && !isRinging) startCall();
        else if (isInCall) showCallView();
    });

    // 📹 Video call button
    const btnVideo = document.getElementById('btnCallVideo');
    if (btnVideo) btnVideo.addEventListener('click', () => {
        if (!isInCall && !isRinging) {
            isCameraOn = true; window.isCameraOn = true;
            startCall();
        } else if (isInCall) {
            toggleCamera();
        }
    });

    const btnMute = document.getElementById('btnMuteMic');
    if (btnMute) btnMute.addEventListener('click', toggleMute);

    const btnCam = document.getElementById('btnToggleCamera');
    if (btnCam) btnCam.addEventListener('click', toggleCamera);

    const btnEnd = document.getElementById('btnEndCall');
    if (btnEnd) btnEnd.addEventListener('click', () => endCall(true));

    const btnBack = document.getElementById('btnBackToMessages');
    if (btnBack) btnBack.addEventListener('click', hideCallView);

    // Microphone dropdown
    const btnMicOpts = document.getElementById('btnMicOptions');
    if (btnMicOpts) {
        btnMicOpts.addEventListener('click', e => {
            e.stopPropagation();
            const menu = document.getElementById('micDeviceMenu');
            if (menu) menu.classList.toggle('hidden');
        });
        document.addEventListener('click', e => {
            const menu = document.getElementById('micDeviceMenu');
            if (menu && !menu.classList.contains('hidden') && !e.target.closest('.mic-control-group')) {
                menu.classList.add('hidden');
            }
        });
    }
});
