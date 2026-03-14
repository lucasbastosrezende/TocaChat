/* ═══════════════════════════════════════════════
   Chat Module (Direct + Group + Subtopics + Media)
   ═══════════════════════════════════════════════ */

let conversas = []; window.conversas = conversas;
let conversaAtual = null; window.conversaAtual = conversaAtual;
let chatPollInterval = null;
let lastMsgId = 0;
let subtopicos = [];
let subtopicAtual = null; // null = "Geral"
let replyState = null; // { id, author, text }

// PERF FIX: cache de mensagens com limite de tamanho e TTL para evitar vazamento de memória
// In-memory cache por conversa para mensagens (SWR-style)
// Estrutura: { [conversaId]: { messages: [], lastFetchedAt: number, lastMsgId: number } }
const messageCache = {}; // PERF FIX: escopo único global, controlado pelos helpers abaixo
const MESSAGE_CACHE_TTL = 60000; // PERF FIX: TTL aumentado para 60s para reduzir re-fetching sem crescer demais
const MESSAGE_CACHE_MAX_CONVS = 20; // PERF FIX: máximo de conversas em cache (evita crescimento infinito)
const MAX_RENDERED_MESSAGES = 13; // RENDERING LIMIT: Initial load limited to 13 messages per user request

// ── Helpers & Utilities (Global Scope) ──
function scrollToBottom(force = false) {
    const container = document.getElementById('chatMessages');
    if (!container) return;
    if (force) {
        container.scrollTop = container.scrollHeight;
    } else {
        const wasAtBottom = container.scrollHeight - container.scrollTop <= container.clientHeight + 200;
        if (wasAtBottom) container.scrollTop = container.scrollHeight;
    }
}
window.scrollToBottom = scrollToBottom;

const isEmojiOnly = (str) => {
    const testStr = (str || '').trim();
    if (!testStr) return false;
    const emojiRegex = /^[\u{1f300}-\u{1f5ff}\u{1f900}-\u{1f9ff}\u{1f600}-\u{1f64f}\u{1f680}-\u{1f6ff}\u{2600}-\u{26ff}\u{2700}-\u{27bf}\u{1f1e6}-\u{1f1ff}\u{1f191}-\u{1f251}\u{1f004}\u{1f0cf}\u{1f170}-\u{1f171}\u{1f17e}-\u{1f17f}\u{1f18e}\u{3030}\u{2b50}\u{2b55}\u{2934}-\u{2935}\u{2b05}-\u{2b07}\u{2b1b}-\u{2b1c}\u{3297}\u{3299}\u{303d}\u{00a9}\u{00ae}\u{2122}\u{23f3}\u{24c2}\u{23e9}-\u{23ef}\u{25b6}\u{23f8}-\u{23fa}\u{200d}\ufe0f]+$/gu;
    const match = testStr.match(emojiRegex);
    if(!match) return false;
    const emojiCount = Array.from(testStr).length;
    return emojiCount >= 1 && emojiCount <= 3;
};

// ── SocketIO Init ──
const socket = io();
window.socket = socket;

function joinUserRoom() {
    if (socket.connected && typeof currentUser !== 'undefined' && currentUser) {
        socket.emit('join', { user_id: currentUser.id });
        if (conversaAtual) socket.emit('join_conv', { conversa_id: conversaAtual.id });
    }
}
window.joinUserRoom = joinUserRoom;

socket.on('connect', () => {
    console.log('[Socket] Conectado ao servidor');
    joinUserRoom();
});

socket.on('new_message', (msg) => {
    console.log('[Socket] Nova mensagem recebida:', msg);
    if (!conversaAtual || msg.conversa_id !== conversaAtual.id) {
        incrementUnread(msg.conversa_id);
        const conv = conversas.find(c => c.id === msg.conversa_id);
        notifyNewMessageFromConv({ 
            id: msg.conversa_id, 
            display_nome: conv ? conv.display_nome : msg.autor_nome, 
            ultima_msg: msg.conteudo 
        });
        return;
    }
    
    // Check if subtopic match
    if (msg.subtopico_id == (subtopicAtual ? subtopicAtual.id : null)) {
        renderSingleMessage(msg);
        if (msg.id > lastMsgId) lastMsgId = msg.id;
        // Atualiza cache em memória para troca instantânea entre conversas
        const cacheEntry = messageCache[msg.conversa_id] || { messages: [], lastFetchedAt: 0, lastMsgId: 0 };
        cacheEntry.messages.push(msg);
        cacheEntry.lastMsgId = msg.id;
        cacheEntry.lastFetchedAt = Date.now();
        messageCache[msg.conversa_id] = cacheEntry;
        
        scrollToBottom();
        const container = document.getElementById('chatMessages');
        trimMessageDom(container);
    }
});

socket.on('message_deleted', (data) => {
    const bubble = document.querySelector(`.msg-bubble[data-msg-id="${data.id}"]`);
    if (bubble) {
        bubble.style.opacity = '0';
        bubble.style.transform = 'scale(0.8)';
        setTimeout(() => bubble.remove(), 350);
    }
});

socket.on('pinned_update', (data) => {
    if (conversaAtual && data.conversa_id === conversaAtual.id) {
        loadConversas().then(() => {
            const refreshed = conversas.find(c => c.id === conversaAtual.id);
            if (refreshed) {
                conversaAtual = refreshed;
                window.conversaAtual = conversaAtual;
                renderPinnedMessageBar();
            }
        });
    }
});

socket.on('call_signal', (sinal) => {
    if (typeof handleIncomingSignal === 'function') {
        handleIncomingSignal(sinal);
    }
});

window.addEventListener('pageChange', (e) => {
    if (e.detail.page === 'chat') {
        // Just make sure we are polling
        startSyncPolling();
    }
    // We NO LONGER stop polling when leaving the chat page 
    // to ensure call signals are processed globally.
});

// Also start polling as soon as possible if we have a user
if (typeof currentUser !== 'undefined' && currentUser) {
    startSyncPolling();
}

// ── Load Conversations ──
async function loadConversas() {
    try {
        conversas = await api('/api/conversas');
        renderConversasList();
    } catch (err) {
        console.error('Chat error:', err);
    }
}

function renderConversasList() {
    const container = document.getElementById('chatList');
    if (!container) return;
    if (conversas.length === 0) {
        container.innerHTML = '<p class="empty-state">Nenhuma conversa. Inicie um chat! 💬</p>';
        return;
    }

    container.innerHTML = conversas.map(c => {
        const isActive = conversaAtual && conversaAtual.id === c.id;
        const preview = c.ultima_msg ? c.ultima_msg.substring(0, 40) + (c.ultima_msg.length > 40 ? '...' : '') : 'Sem mensagens';
        const isGroup = c.tipo === 'grupo';
        const initial = c.display_nome ? c.display_nome.charAt(0).toUpperCase() : '?';
        const unread = (typeof unreadCounts !== 'undefined' ? unreadCounts[c.id] : 0) || 0;
        return `
            <div class="chat-item ${isActive ? 'active' : ''}" onclick="abrirConversa(${c.id})" onmouseenter="prefetchMensagens(${c.id})" ontouchstart="prefetchMensagens(${c.id})" ${c.display_wallpaper ? `style="--chat-wallpaper: url('${c.display_wallpaper}')"` : ''}>
                <div class="chat-item-avatar">
                    ${c.display_foto
                        ? `<img src="${c.display_foto}" alt="" loading="lazy" style="aspect-ratio:1/1;object-fit:cover">`
                        : (isGroup ? `<svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="lucide lucide-users" style="opacity: 0.7;"><path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M22 21v-2a4 4 0 0 0-3-3.87"/><circle cx="19" cy="4" r="3"/></svg>` : `<video autoplay loop muted playsinline class="default-avatar-vid"><source src="/static/images/logo3.mp4" type="video/mp4"></video>`)}
                </div>
                <div class="chat-item-info">
                    <div class="chat-item-name">${c.display_nome}</div>
                    <div class="chat-item-preview">${preview}</div>
                </div>
                <div style="display: flex; align-items: center; gap: 0.25rem;">
                    ${unread > 0 ? `<span class="chat-unread-badge">${unread > 99 ? '99+' : unread}</span>` : ''}
                    ${c.ultima_msg_em ? `<span class="chat-item-time">${formatTime(c.ultima_msg_em)}</span>` : ''}
                    ${!isGroup ? `<button class="btn btn-sm btn-ghost" style="padding: 0.2rem; color: var(--danger)" onclick="event.stopPropagation(); excluirChat(${c.id}, '${c.display_nome.replace("'", "\\'")}')" title="Excluir conversa"><svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="lucide lucide-trash-2"><path d="M3 6h18"/><path d="M19 6v14c0 1-1 2-2 2H7c-1 0-2-1-2-2V6"/><path d="M8 6V4c0-1 1-2 2-2h4c1 0 2 1 2 2v2"/><line x1="10" x2="10" y1="11" y2="17"/><line x1="14" x2="14" y1="11" y2="17"/></svg></button>` : ''}
                </div>
            </div>`;
    }).join('');
}

// Prefetch de mensagens ao passar o mouse / tocar em uma conversa
async function prefetchMensagens(conversaId) {
    if (!conversaId) return;
    const entry = messageCache[conversaId];
    const now = Date.now();
    if (entry && entry.lastFetchedAt && (now - entry.lastFetchedAt) < MESSAGE_CACHE_TTL) return;
    // Evita prefetch redundante da conversa já aberta (loadMensagens já cobre)
    if (conversaAtual && conversaAtual.id === conversaId) return;

    try {
        const msgs = await api(`/api/conversas/${conversaId}/mensagens`);
        const cacheEntry = getMessageCacheEntry(conversaId);
        cacheEntry.messages = msgs || [];
        cacheEntry.lastMsgId = msgs.length ? msgs[msgs.length - 1].id : 0;
        cacheEntry.lastFetchedAt = Date.now();
        messageCache[conversaId] = cacheEntry;
    } catch (err) {
        console.warn('[Chat] Prefetch de mensagens falhou', err);
    }
}
window.prefetchMensagens = prefetchMensagens;


// ── Open Conversation ──
async function abrirConversa(id) {
    const lightweight = conversas.find(c => c.id === id);
    if (!lightweight) return;
    
    if (conversaAtual) socket.emit('leave_conv', { conversa_id: conversaAtual.id });
    
    // Buscar detalhes completos (membros, descrição, etc.) em endpoint dedicado,
    // mantendo payload de /api/conversas enxuto.
    let conv = lightweight;
    try {
        const full = await api(`/api/conversas/${id}`);
        // Garante que campos como display_nome/display_foto permaneçam
        conv = { ...lightweight, ...full };
    } catch (e) {
        console.warn('[Chat] Falha ao carregar detalhes da conversa, usando dados básicos.', e);
    }

    conversaAtual = conv;
    window.conversaAtual = conversaAtual;
    socket.emit('join_conv', { conversa_id: id });
    lastMsgId = 0;
    subtopicAtual = null;
    subtopicos = [];
    document.getElementById('chatMessages').innerHTML = ''; // Clear for new conversation

    document.querySelector('.chat-placeholder').classList.add('hidden');
    document.getElementById('chatHeader').classList.remove('hidden');
    document.getElementById('chatMessages').classList.remove('hidden');
    document.getElementById('chatInputArea').classList.remove('hidden');

    const subBar = document.getElementById('subtopicsBar');
    const isDirect = conv.tipo === 'direto';
    const otherUser = isDirect && conv.membros ? conv.membros.find(m => m.id !== currentUser.id) : null;
    
    document.getElementById('chatNome').textContent = conv.display_nome;
    if (isDirect && otherUser) {
        document.getElementById('chatNome').style.cursor = 'pointer';
        document.getElementById('chatNome').onclick = () => abrirPerfil(otherUser.id);
    } else {
        document.getElementById('chatNome').style.cursor = 'default';
        document.getElementById('chatNome').onclick = null;
    }

    const avatarEl = document.getElementById('chatAvatar');
    avatarEl.innerHTML = conv.display_foto
        ? `<img src="${conv.display_foto}" alt="">`
        : (conv.tipo === 'grupo' ? `<span>👥</span>` : `<video autoplay loop muted playsinline class="default-avatar-vid"><source src="/static/images/Criação_de_Animação_Abstrata_Anime.mp4" type="video/mp4"></video>`);
    
    if (isDirect && otherUser) {
        avatarEl.style.cursor = 'pointer';
        avatarEl.onclick = () => abrirPerfil(otherUser.id);
    } else {
        avatarEl.style.cursor = 'default';
        avatarEl.onclick = null;
    }

    // Show unified call button
    document.getElementById('btnCallAudio').classList.remove('hidden');
    document.getElementById('btnCallAudio').onclick = () => {
        if (typeof startCall === 'function') startCall();
    };
    document.getElementById('btnCallVideo').classList.add('hidden'); // Hidden — camera toggles inside call

    const subtitle = conv.tipo === 'grupo'
        ? `${(conv.membros ? conv.membros.length : 0)} membros${conv.descricao ? ' • ' + conv.descricao : ''}`
        : `@${otherUser?.username || ''}`;
    document.getElementById('chatSubtitle').textContent = subtitle;

    const editBtn = document.getElementById('btnEditGrupo');
    editBtn.classList.toggle('hidden', conv.tipo !== 'grupo');

    // SWR-style: se houver cache, renderiza imediatamente e busca delta em background
    const hadCache = renderMessagesFromCache(id);
    if (!hadCache) {
        showMessagesSkeleton();
    }

    // Parallel load data for faster opening (mensagens + subtópicos)
    const promises = [
        loadMensagens().finally(() => {
            if (!hadCache) hideMessagesSkeleton();
        })
    ];
    if (conv.tipo === 'grupo') {
        promises.push(loadSubtopicos());
        subBar.classList.remove('hidden');
    } else {
        subBar.classList.add('hidden');
    }

    renderParticipantsSidebar(conv);
    renderConversasList();
    renderPinnedMessageBar();
    
    // Apply background
    applyActiveChatWallpaper(conv.display_wallpaper);
    
    await Promise.all(promises);
    document.getElementById('chatInput').focus();
}

let currentActiveCallers = [];

function updateActiveCallersUI(callers) {
    if (!conversaAtual) return;
    
    // callers can be objects {user_id, has_video} or plain ids (backwards compat)
    const callersArray = (callers || []).map(c => typeof c === 'object' ? c : { user_id: c, has_video: false });
    const callerIds = callersArray.map(c => c.user_id);
    
    // Check full array (including has_video) instead of just IDs to allow camera toggle re-renders
    if (JSON.stringify(window._activeCallersData || []) === JSON.stringify(callersArray)) return;
    
    currentActiveCallers = callerIds;
    window._activeCallersData = callersArray; // store full data for sidebar
    
    renderParticipantsSidebar(conversaAtual);
    
    const btnAudio = document.getElementById('btnCallAudio');
    if (!btnAudio) return;

    const isInCallLocal = window.isInCall || false;
    
    if (currentActiveCallers.length > 0 && !currentActiveCallers.includes(currentUser.id) && !isInCallLocal) {
        btnAudio.classList.add('pulse-call-btn');
        const countText = currentActiveCallers.length > 1 ? ` (${currentActiveCallers.length})` : '';
        btnAudio.innerHTML = `📞 Entrar${countText}`;
    } else {
        btnAudio.classList.remove('pulse-call-btn');
        btnAudio.innerHTML = '📞';
    }
}

function renderParticipantsSidebar(conv) {
    const layout = document.querySelector('.chat-layout');
    const sidebar = document.getElementById('chatParticipants');
    const list = document.getElementById('participantsList');
    
    if (!sidebar || !list || !layout) return;

    sidebar.classList.remove('hidden');
    layout.classList.remove('no-participants');

    const inCallSet = (window.usersInCall && window.usersInCall.has) ? window.usersInCall : new Set();
    const isInCallMember = (id) => currentActiveCallers.includes(id) || inCallSet.has(String(id));

    const sortedMembers = [...conv.membros].sort((a, b) => {
        const aActive = isInCallMember(a.id);
        const bActive = isInCallMember(b.id);
        if (aActive && !bActive) return -1;
        if (!aActive && bActive) return 1;
        return a.nome.localeCompare(b.nome);
    });

    list.innerHTML = sortedMembers.map(m => {
        const isMe = m.id === currentUser.id;
        const isActive = isInCallMember(m.id);
        const callerData = (window._activeCallersData || []).find(c => c.user_id === m.id);
        const hasVideo = callerData?.has_video || false;
        
        let statusText = isMe ? 'Você' : '';
        if (isActive) {
            statusText = hasVideo ? '📹 Câmera Ligada' : '📞 Na Chamada';
        }

        const initial = m.nome.charAt(0).toUpperCase();

        return `
            <div class="participant-item ${isActive ? 'participant-active-call' : ''}" data-member-id="${m.id}" onclick="abrirPerfil(${m.id})" ${m.wallpaper ? `style="--wallpaper: url('${m.wallpaper}')"` : ''}>
                <div class="participant-avatar">
                    ${m.foto 
                        ? `<img src="${m.foto}" alt="${m.nome}" loading="lazy" style="aspect-ratio:1/1;object-fit:cover">` 
                        : `<video autoplay loop muted playsinline class="default-avatar-vid"><source src="/static/images/Criação_de_Animação_Abstrata_Anime.mp4" type="video/mp4"></video>`}
                </div>
                <div class="participant-info">
                    <span class="participant-name">${m.nome}</span>
                    <span class="participant-status">${statusText}</span>
                </div>
            </div>
`;
    }).join('');

    if (typeof window.reapplyParticipantsInCall === 'function') {
        window.reapplyParticipantsInCall();
    }
}

// ── Subtopics ──
async function loadSubtopicos() {
    if (!conversaAtual || conversaAtual.tipo !== 'grupo') return;
    try {
        subtopicos = await api(`/api/conversas/${conversaAtual.id}/subtopicos`);
        renderSubtopicsTabs();
    } catch (err) { console.error('Subtopics error:', err); }
}

function renderSubtopicsTabs() {
    const container = document.getElementById('subtopicsTabs');
    // "Geral" is always first and NOT draggable.
    let html = `<button class="sub-tab ${subtopicAtual === null ? 'active' : ''}" onclick="selectSubtopic(null)" draggable="false" style="display: flex; align-items: center; gap: 0.4rem;">
        <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="lucide lucide-message-square"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/></svg>
        Geral
    </button>`;
    
    subtopicos.forEach(s => {
        const isActive = subtopicAtual && subtopicAtual.id === s.id ? 'active' : '';
        // Add draggable="true" and data-id attributes for drag and drop
        html += `<button class="sub-tab draggable-subtopic ${isActive}" data-id="${s.id}" onclick="selectSubtopic(${s.id})" draggable="true" style="border-left:3px solid ${s.cor}">${s.nome}</button>`;
    });
    
    html += `<button class="sub-tab sub-tab-add" onclick="abrirCriarSubtopico()" draggable="false">＋</button>`;
    container.innerHTML = html;
    
    setupSubtopicDragAndDrop();
}

function setupSubtopicDragAndDrop() {
    const container = document.getElementById('subtopicsTabs');
    const draggables = container.querySelectorAll('.draggable-subtopic');
    
    draggables.forEach(draggable => {
        draggable.addEventListener('dragstart', () => {
            draggable.classList.add('dragging');
        });
        
        draggable.addEventListener('dragend', async () => {
            draggable.classList.remove('dragging');
            
            // Gather the new order of IDs immediately after dropping
            const currentOrder = Array.from(container.querySelectorAll('.draggable-subtopic')).map(el => parseInt(el.getAttribute('data-id')));
            
            try {
                await api(`/api/conversas/${conversaAtual.id}/subtopicos/reordenar`, {
                    method: 'PUT',
                    body: { ordem: currentOrder }
                });
            } catch (err) {
                console.error('Failed to save subtopic order', err);
                showToast('Erro ao reordenar subtópicos', 'error');
            }
        });
    });

    // The container acts as the drop zone
    container.addEventListener('dragover', e => {
        e.preventDefault(); // Necessary to allow dropping
        
        const afterElement = getDragAfterElement(container, e.clientX);
        const dragging = container.querySelector('.dragging');
        if (!dragging) return;
        
        const btnAdd = container.querySelector('.sub-tab-add');
        
        if (afterElement == null || afterElement === btnAdd) {
            container.insertBefore(dragging, btnAdd);
        } else {
            container.insertBefore(dragging, afterElement);
        }
    });
}

function getDragAfterElement(container, x) {
    const draggableElements = [...container.querySelectorAll('.draggable-subtopic:not(.dragging)')];
    
    return draggableElements.reduce((closest, child) => {
        const box = child.getBoundingClientRect();
        const offset = x - box.left - box.width / 2;
        if (offset < 0 && offset > closest.offset) {
            return { offset: offset, element: child };
        } else {
            return closest;
        }
    }, { offset: Number.NEGATIVE_INFINITY }).element;
}

async function selectSubtopic(id) {
    subtopicAtual = id === null ? null : subtopicos.find(s => s.id === id) || null;
    lastMsgId = 0;
    document.getElementById('chatMessages').innerHTML = ''; // Clear for new topic
    renderSubtopicsTabs();
    await loadMensagens();
}

function abrirCriarSubtopico() {
    openModal('Novo Subtópico', `
        <div class="form-group">
            <label class="form-label">Nome</label>
            <input type="text" class="input" id="subNome" placeholder="Ex: Direito Constitucional">
        </div>
        <div class="form-group">
            <label class="form-label">Descrição (opcional)</label>
            <input type="text" class="input" id="subDesc" placeholder="Sobre o que é esse tópico?">
        </div>
        <div class="form-group">
            <label class="form-label">Cor</label>
            <div style="display:flex;gap:0.5rem;flex-wrap:wrap">
                ${['#6366f1','#8b5cf6','#ec4899','#ef4444','#f59e0b','#22c55e','#3b82f6','#06b6d4'].map(c =>
                    `<label style="cursor:pointer"><input type="radio" name="subCor" value="${c}" ${c==='#6366f1'?'checked':''} style="display:none"><span class="color-dot" style="display:block;width:28px;height:28px;border-radius:50%;background:${c};border:2px solid transparent;transition:0.15s"></span></label>`
                ).join('')}
            </div>
        </div>
    `, `
        <button class="btn btn-ghost" onclick="closeModal()">Cancelar</button>
        <button class="btn btn-primary" onclick="criarSubtopico()">Criar</button>
    `);
    setTimeout(() => {
        document.querySelectorAll('input[name="subCor"]').forEach(r => {
            r.addEventListener('change', () => { document.querySelectorAll('.color-dot').forEach(d => d.style.borderColor='transparent'); r.nextElementSibling.style.borderColor='white'; });
            if(r.checked) r.nextElementSibling.style.borderColor='white';
        });
    }, 50);
}

async function criarSubtopico() {
    const nome = document.getElementById('subNome').value.trim();
    if (!nome) { showToast('Nome obrigatório','error'); return; }
    const cor = document.querySelector('input[name="subCor"]:checked')?.value || '#6366f1';
    const descricao = document.getElementById('subDesc').value.trim();
    try {
        const sub = await api(`/api/conversas/${conversaAtual.id}/subtopicos`, { method:'POST', body:{nome,descricao,cor} });
        closeModal();
        showToast(`Subtópico "${nome}" criado! 📌`,'success');
        await loadSubtopicos();
        selectSubtopic(sub.id);
    } catch(err) { showToast('Erro ao criar subtópico','error'); }
}

async function editarSubtopico(id) {
    const sub = subtopicos.find(s => s.id === id);
    if (!sub) return;
    openModal('Editar Subtópico', `
        <div class="form-group"><label class="form-label">Nome</label><input type="text" class="input" id="editSubNome" value="${sub.nome}"></div>
        <div class="form-group"><label class="form-label">Descrição</label><input type="text" class="input" id="editSubDesc" value="${sub.descricao||''}"></div>
        <div class="form-group"><label class="form-label">Cor</label>
            <div style="display:flex;gap:0.5rem;flex-wrap:wrap">
                ${['#6366f1','#8b5cf6','#ec4899','#ef4444','#f59e0b','#22c55e','#3b82f6','#06b6d4'].map(c =>
                    `<label style="cursor:pointer"><input type="radio" name="editSubCor" value="${c}" ${c===sub.cor?'checked':''} style="display:none"><span class="color-dot" style="display:block;width:28px;height:28px;border-radius:50%;background:${c};border:2px solid transparent;transition:0.15s"></span></label>`
                ).join('')}
            </div>
        </div>
    `, `
        <button class="btn btn-danger" onclick="deletarSubtopico(${id})" style="margin-right:auto">Excluir</button>
        <button class="btn btn-ghost" onclick="closeModal()">Cancelar</button>
        <button class="btn btn-primary" onclick="salvarSubtopico(${id})">Salvar</button>
    `);
    setTimeout(() => {
        document.querySelectorAll('input[name="editSubCor"]').forEach(r => {
            r.addEventListener('change', () => { document.querySelectorAll('.color-dot').forEach(d => d.style.borderColor='transparent'); r.nextElementSibling.style.borderColor='white'; });
            if(r.checked) r.nextElementSibling.style.borderColor='white';
        });
    }, 50);
}

async function salvarSubtopico(id) {
    try {
        await api(`/api/subtopicos/${id}`, { method:'PUT', body:{
            nome: document.getElementById('editSubNome').value.trim(),
            descricao: document.getElementById('editSubDesc').value.trim(),
            cor: document.querySelector('input[name="editSubCor"]:checked')?.value || '#6366f1'
        }});
        closeModal(); showToast('Subtópico atualizado! ✅','success'); await loadSubtopicos();
    } catch(err) { showToast('Erro ao salvar','error'); }
}

async function deletarSubtopico(id) {
    if (!confirm('Excluir este subtópico?')) return;
    try {
        await api(`/api/subtopicos/${id}`, { method:'DELETE' });
        closeModal(); showToast('Subtópico excluído','info');
        subtopicAtual = null; await loadSubtopicos(); lastMsgId = 0; await loadMensagens();
    } catch(err) { showToast('Erro ao excluir','error'); }
}


// ── Message Cache Helpers (SWR-style) ──
function getMessageCacheEntry(conversaId) {
    // PERF FIX: aplica política LRU simples + TTL sempre que acessa a entrada
    const now = Date.now();

    // Limpa entradas expiradas e aplica limite máximo de conversas em cache
    const keys = Object.keys(messageCache);
    if (keys.length > 0) {
        // Remove entradas expiradas
        for (const key of keys) {
            const entry = messageCache[key];
            if (entry && entry.lastFetchedAt && (now - entry.lastFetchedAt) > MESSAGE_CACHE_TTL) {
                delete messageCache[key];
            }
        }
        // Recalcula após remoção por TTL
        const remainingKeys = Object.keys(messageCache);
        if (remainingKeys.length > MESSAGE_CACHE_MAX_CONVS) {
            // PERF FIX: remove as conversas menos recentes (LRU simples usando lastFetchedAt)
            remainingKeys
                .sort((a, b) => (messageCache[a].lastFetchedAt || 0) - (messageCache[b].lastFetchedAt || 0))
                .slice(0, remainingKeys.length - MESSAGE_CACHE_MAX_CONVS)
                .forEach(k => delete messageCache[k]);
        }
    }

    if (!messageCache[conversaId]) {
        messageCache[conversaId] = { messages: [], lastFetchedAt: 0, lastMsgId: 0 };
    }
    return messageCache[conversaId];
}

function renderMessagesFromCache(conversaId) {
    const entry = messageCache[conversaId];
    if (!entry || !entry.messages || entry.messages.length === 0) return false;
    const container = document.getElementById('chatMessages');
    if (!container) return false;
    container.innerHTML = '';
    entry.messages.forEach(msg => renderSingleMessage(msg, false));
    lastMsgId = entry.lastMsgId || (entry.messages[entry.messages.length - 1] && entry.messages[entry.messages.length - 1].id) || 0;
    setTimeout(() => scrollToBottom(true), 10);
    return true;
}

function showMessagesSkeleton() {
    const container = document.getElementById('chatMessages');
    if (!container) return;
    const rows = Array.from({ length: 8 }).map((_, i) => `
        <div class="skeleton-row ${i % 3 === 0 ? 'sent' : 'received'}">
            <div class="skeleton-avatar pulse"></div>
            <div class="skeleton-bubble pulse" style="width:${120 + (i * 37) % 180}px"></div>
        </div>
    `).join('');
    container.innerHTML = `<div class="message-skeleton">${rows}</div>`;
}

function hideMessagesSkeleton() {
    const sk = document.querySelector('.message-skeleton');
    if (sk && sk.parentElement) {
        sk.parentElement.removeChild(sk);
    }
}

function trimMessageDom(container) {
    if (!container) return;
    const bubbles = Array.from(container.querySelectorAll('.msg-bubble'));
    const excess = bubbles.length - MAX_RENDERED_MESSAGES;
    if (excess <= 0) return;
    for (let i = 0; i < excess; i++) {
        const b = bubbles[i];
        if (b && b.parentElement) b.parentElement.removeChild(b);
    }
}

// ── Messages (id-based dedup, no more duplicates)
// ── Render Single Message ──
function renderSingleMessage(msg, isOptimistic = false, returnOnly = false) {
    const container = document.getElementById('chatMessages');
    const isMine = msg.usuario_id === currentUser.id;
    
    // De-duplication check: if msg.id is already in DOM, don't add
    if (!isOptimistic && msg.id && document.querySelector(`.msg-bubble[data-msg-id="${msg.id}"]`)) {
        return;
    }

    // Optimistic Adoption: if we have a "sending" bubble that matches this new real message, just update it
    if (!isOptimistic && isMine) {
        const optimistic = Array.from(document.querySelectorAll('.msg-bubble.msg-sending'))
            .find(el => el.querySelector('.msg-content').textContent === msg.conteudo);
        
        if (optimistic) {
            optimistic.classList.remove('msg-sending');
            optimistic.dataset.msgId = msg.id;
            optimistic.querySelector('.msg-time').textContent = formatTime(msg.criado_em);
            const actions = optimistic.querySelector('.msg-actions');
            actions.innerHTML = `<button class="btn btn-sm btn-ghost" onclick="apagarMensagem(${msg.id})" title="Apagar mensagem"><svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="lucide lucide-trash-2"><path d="M3 6h18"/><path d="M19 6v14c0 1-1 2-2 2H7c-1 0-2-1-2-2V6"/><path d="M8 6V4c0-1 1-2 2-2h4c1 0 2 1 2 2v2"/><line x1="10" x2="10" y1="11" y2="17"/><line x1="14" x2="14" y1="11" y2="17"/></svg></button>`;
            return optimistic;
        }
    }

    const bubble = document.createElement('div');
    bubble.className = `msg-bubble ${isMine ? 'msg-mine' : 'msg-other'}`;
    if (msg.id) bubble.dataset.msgId = msg.id;
    if (isOptimistic) bubble.classList.add('msg-sending');

    const isSticker = msg.media_url && msg.media_url.includes('/static/stickers/');
    if (isSticker) bubble.classList.add('msg-sticker');

    let mediaHtml = '';
    if (msg.media_url) {
        const ext = msg.media_url.split('.').pop().toLowerCase();
        if (['mp4','webm','mov'].includes(ext)) {
            mediaHtml = `<video src="${msg.media_url}" onloadedmetadata="scrollToBottom()" controls class="msg-media" style="width:100%;max-height:300px;border-radius:8px;margin:0.25rem 0;aspect-ratio:16/9;object-fit:cover" preload="metadata"></video>`;
        } else if (isSticker) {
            mediaHtml = `<img src="${msg.media_url}" onload="scrollToBottom()" class="msg-sticker-img" loading="lazy" style="cursor:pointer" onclick="abrirLightbox('${msg.media_url}')">`;
        } else {
            mediaHtml = `<img src="${msg.media_url}" onload="scrollToBottom()" class="msg-media" loading="lazy" style="width:100%;min-height:100px;max-height:300px;border-radius:8px;margin:0.25rem 0;cursor:pointer;object-fit:cover" onclick="abrirLightbox('${msg.media_url}')">`;
        }
    }

    let replyHtml = '';
    if (msg.reply_to_id && msg.reply_content) {
        replyHtml = `
            <div class="msg-reply-context" onclick="jumpToMessage(${msg.reply_to_id})">
                <span class="reply-context-author">${msg.reply_author || 'Usuário'}</span>
                <div class="reply-context-text">${escapeHtml(msg.reply_content)}</div>
            </div>
        `;
    }

    const authorName = (msg.autor_nome || 'Usuário').replace(/'/g, "\\'");
    const contentPreview = (msg.conteudo || '').replace(/'/g, "\\'").replace(/\n/g, " ");

    bubble.innerHTML = `
        <div class="msg-actions">
            ${msg.id ? `
                <button class="btn btn-sm btn-ghost" onclick="setReplyMode(${msg.id}, '${authorName}', '${contentPreview}')" title="Responder">
                    <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="lucide lucide-reply"><polyline points="9 17 4 12 9 7"/><path d="M20 18v-2a4 4 0 0 0-4-4H4"/></svg>
                </button>
                <button class="btn btn-sm btn-ghost" onclick="fixarMensagem(${msg.id})" title="Fixar">
                    <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="lucide lucide-pin"><line x1="12" y1="17" x2="12" y2="22"/><path d="M5 17h14v-1.76a2 2 0 0 0-1.11-1.79l-1.78-.9A2 2 0 0 1 15 10.76V6a3 3 0 0 0-3-3 3 3 0 0 0-3 3v4.76a2 2 0 0 1-1.11 1.79l-1.78.9A2 2 0 0 0 5 15.24Z"/></svg>
                </button>
                ${isMine ? `<button class="btn btn-sm btn-ghost" onclick="apagarMensagem(${msg.id})" title="Apagar mensagem">
                    <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="lucide lucide-trash-2"><path d="M3 6h18"/><path d="M19 6v14c0 1-1 2-2 2H7c-1 0-2-1-2-2V6"/><path d="M8 6V4c0-1 1-2 2-2h4c1 0 2 1 2 2v2"/><line x1="10" x2="10" y1="11" y2="17"/><line x1="14" x2="14" y1="11" y2="17"/></svg>
                </button>` : ''}
            ` : ''}
        </div>
        ${!isMine ? `<div class="msg-author">
            ${msg.autor_foto ? `<img src="${msg.autor_foto}" class="msg-avatar" loading="lazy" style="aspect-ratio:1/1;object-fit:cover">` : ''}
            <span class="msg-name">${msg.autor_nome}</span>
        </div>` : ''}
        ${replyHtml}
        ${mediaHtml}
        ${msg.conteudo ? (() => {
            const rawContent = linkify(escapeHtml(msg.conteudo));
            const shouldBeLarge = isEmojiOnly(msg.conteudo);
            return `<div class="msg-content ${shouldBeLarge ? 'msg-emoji-only' : ''}">${rawContent}</div>`;
        })() : ''}
        <div class="msg-time">${formatTime(msg.criado_em || new Date().toISOString())}${isOptimistic ? ' ⏳' : ''}</div>
    `;
    
    if (returnOnly) return bubble;
    container.appendChild(bubble);
    return bubble;
}

async function loadMensagens(beforeId = null) {
    if (!conversaAtual) return;
    try {
        let endpoint = `/api/conversas/${conversaAtual.id}/mensagens`;
        const params = [];
        if (beforeId) {
            params.push(`before_id=${beforeId}`);
        } else if (lastMsgId) {
            params.push(`after_id=${lastMsgId}`);
        }
        
        if (subtopicAtual) params.push(`subtopico_id=${subtopicAtual.id}`);
        if (params.length) endpoint += '?' + params.join('&');

        const msgs = await api(endpoint);
        const container = document.getElementById('chatMessages');
        const convId = conversaAtual.id;
        const cacheEntry = getMessageCacheEntry(convId);

        if (!lastMsgId && !beforeId) {
            container.innerHTML = '';
            if (msgs.length === 0) {
                const label = subtopicAtual ? `"${subtopicAtual.nome}"` : 'esta conversa';
                container.innerHTML = `<p class="empty-state" style="padding:2rem">Nenhuma mensagem em ${label}. Diga oi! 👋</p>`;
            }
            // Reset cache on first page load
            cacheEntry.messages = [];
        }

        if (msgs.length > 0) {
            if (container.querySelector('.empty-state')) {
                container.innerHTML = '';
            }

            const fragment = document.createDocumentFragment();
            const existingIds = new Set(cacheEntry.messages.map(m => m.id));

            msgs.forEach(msg => {
                const bubble = renderSingleMessage(msg, false, true); // true = return element only
                if (bubble) fragment.appendChild(bubble);
                if (!existingIds.has(msg.id)) {
                    if (beforeId) {
                        cacheEntry.messages.unshift(msg);
                    } else {
                        cacheEntry.messages.push(msg);
                    }
                }
                if (!beforeId) lastMsgId = msg.id;
            });

            if (!beforeId) {
                cacheEntry.lastMsgId = lastMsgId;
            }
            cacheEntry.lastFetchedAt = Date.now();
            messageCache[convId] = cacheEntry;

            if (beforeId) {
                const oldHeight = container.scrollHeight;
                container.prepend(fragment);
                const newHeight = container.scrollHeight;
                container.scrollTop = (newHeight - oldHeight); // Keep scroll position relative to content
            } else {
                container.appendChild(fragment);
                scrollToBottom(!lastMsgId); // Force if first load
            }
        } else if (!lastMsgId && !beforeId) {
            scrollToBottom(true);
        }
    } catch (err) {
        console.error('Messages error:', err);
    }
}

let loadingOlder = false;
async function loadOlderMessages() {
    if (loadingOlder || !conversaAtual) return;
    
    // Find oldest message in DOM or cache
    const container = document.getElementById('chatMessages');
    const oldestBubble = container.querySelector('.msg-bubble');
    if (!oldestBubble) return;
    
    const oldestId = parseInt(oldestBubble.dataset.msgId);
    if (!oldestId) return;

    loadingOlder = true;
    try {
        await loadMensagens(oldestId);
    } finally {
        loadingOlder = false;
    }
}

function escapeHtml(text) {
    const div = document.createElement('div');
    div.textContent = text;
    return div.innerHTML;
}

function linkify(text) {
    const urlPattern = /(\b(https?|ftp|file):\/\/[-A-Z0-9+&@#\/%?=~_|!:,.;]*[-A-Z0-9+&@#\/%=~_|])/ig;
    return text.replace(urlPattern, '<a href="$1" target="_blank" rel="noopener noreferrer">$1</a>');
}

async function apagarMensagem(msgId) {
    try {
        await api(`/api/conversas/mensagens/${msgId}`, { method: 'DELETE' });
        const bubble = document.querySelector(`.msg-bubble[data-msg-id="${msgId}"]`);
        if (bubble) bubble.remove();
    } catch(err) {
        showToast('Erro ao apagar mensagem', 'error');
    }
}

// ══════════════════════════════════════════════
//  Send Message (text + media)
// ══════════════════════════════════════════════
let pendingMedia = [];

document.getElementById('btnEnviarMsg').addEventListener('click', enviarMensagem);
document.getElementById('chatInput').addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); enviarMensagem(); }
});
document.getElementById('chatInput').addEventListener('paste', (e) => {
    const items = (e.clipboardData || window.event.clipboardData).items;
    if (!items) return;
    for (let i = 0; i < items.length; i++) {
        if (items[i].kind === 'file') {
            const file = items[i].getAsFile();
            if (file) {
                e.preventDefault();
                handleChatFileUpload(file);
            }
        }
    }
});

document.getElementById('btnMediaChat').addEventListener('click', () => {
    document.getElementById('chatMediaInput').click();
});

document.getElementById('chatMediaInput').addEventListener('change', async (e) => {
    const files = e.target.files;
    for (let i = 0; i < files.length; i++) {
        handleChatFileUpload(files[i]);
    }
    e.target.value = '';
});

// Drag & Drop
const chatMain = document.getElementById('chatMain');
if (chatMain) {
    chatMain.addEventListener('dragover', (e) => {
        e.preventDefault();
        chatMain.classList.add('drag-over');
    });
    chatMain.addEventListener('dragleave', () => {
        chatMain.classList.remove('drag-over');
    });
    chatMain.addEventListener('drop', (e) => {
        e.preventDefault();
        chatMain.classList.remove('drag-over');
        const files = e.dataTransfer.files;
        for (let i = 0; i < files.length; i++) {
            handleChatFileUpload(files[i]);
        }
    });
}

async function handleChatFileUpload(file) {
    if (!conversaAtual) return;

    const ext = file.name.split('.').pop().toLowerCase();
    const allowed = ['jpg','jpeg','png','webp','gif','mp4','webm','mov'];
    const isVideo = ['mp4','webm','mov'].includes(ext);

    if (!allowed.includes(ext)) {
        showToast('Formato não suportado: ' + file.name, 'error');
        return;
    }

    // WhatsApp Sticker simple import detection
    const isPotentialSticker = ext === 'webp' || (['jpg','jpeg','png'].includes(ext) && file.size < 500000);
    if (isPotentialSticker) {
        if (confirm(`Deseja importar "${file.name}" como uma FIGURINHA?\n\n(A figurinha será salva na sua coleção e enviada sem balão de texto)`)) {
            const form = new FormData();
            form.append('sticker', file);
            showToast('Importando figurinha...', 'info');
            try {
                const res = await fetch('/api/stickers/import', { method:'POST', credentials:'same-origin', body:form });
                const data = await res.json();
                if (res.ok) {
                    showToast('Figurinha importada e pronta! 🌟', 'success');
                    enviarSticker(data.url);
                    return; // Stop standard upload
                }
            } catch(err) { console.error('Auto-import failed', err); }
        }
    }

    // Temporary optimistic preview item
    const tempUrl = URL.createObjectURL(file);
    pendingMedia.push({ url: tempUrl, name: file.name, isVideo, uploading: true });
    renderMediaPreview();

    // Compress image before upload (1920px max, 80% quality)
    const fileToUpload = await compressImage(file, 1920, 1920, 0.8);

    const form = new FormData();
    form.append('media', fileToUpload);
    try {
        const res = await fetch(`/api/conversas/${conversaAtual.id}/media`, {
            method: 'POST', credentials: 'same-origin', body: form
        });
        const data = await res.json();
        
        // Find the temp item to update its URL
        const tempItemIndex = pendingMedia.findIndex(m => m.url === tempUrl);

        if (res.ok) {
            if (tempItemIndex !== -1) {
                pendingMedia[tempItemIndex].url = data.media_url;
                pendingMedia[tempItemIndex].uploading = false;
                renderMediaPreview();
            }
        } else {
            showToast(data.erro || 'Erro no upload', 'error');
            if (tempItemIndex !== -1) cancelMedia(tempItemIndex);
        }
    } catch (err) {
        showToast('Erro no upload', 'error');
        const tempItemIndex = pendingMedia.findIndex(m => m.url === tempUrl);
        if (tempItemIndex !== -1) cancelMedia(tempItemIndex);
    }
}

function cancelMedia(index) {
    if (typeof index === 'number') {
        pendingMedia.splice(index, 1);
    } else {
        pendingMedia = [];
    }
    renderMediaPreview();
}

function renderMediaPreview() {
    const preview = document.getElementById('mediaPreview');
    if (pendingMedia.length === 0) {
        preview.classList.add('hidden');
        preview.innerHTML = '';
        return;
    }
    preview.classList.remove('hidden');
    preview.innerHTML = pendingMedia.map((m, i) => {
        const loadingStr = m.uploading ? ' (Enviando...)' : '';
        if (m.isVideo) {
            return `<div class="media-preview-item"><span style="${m.uploading ? 'opacity:0.5' : ''}">🎥 ${m.name}${loadingStr}</span><button class="btn btn-sm btn-ghost" onclick="cancelMedia(${i})">✕</button></div>`;
        } else {
            return `<div class="media-preview-item"><img src="${m.url}" style="height:48px;border-radius:6px;${m.uploading ? 'opacity:0.5' : ''}"><span style="${m.uploading ? 'opacity:0.5' : ''}">${m.name}${loadingStr}</span><button class="btn btn-sm btn-ghost" onclick="cancelMedia(${i})">✕</button></div>`;
        }
    }).join('');
}

async function enviarMensagem() {
    closeAllPanels();
    if (!conversaAtual) return;
    const input = document.getElementById('chatInput');
    const conteudo = input.value.trim();
    
    // Prevent send if any media is still uploading
    if (pendingMedia.some(m => m.uploading)) {
        showToast('Aguarde o envio dos arquivos...', 'info');
        return;
    }

    if (!conteudo && pendingMedia.length === 0) return;

    const originalContent = conteudo;
    const mediaToSend = [...pendingMedia]; 

    input.value = '';
    cancelMedia();

    let messagesToSend = [];
    if (mediaToSend.length === 0) {
        messagesToSend.push({ conteudo: originalContent, media_url: '' });
    } else {
        mediaToSend.forEach((m, index) => {
            messagesToSend.push({
                conteudo: index === 0 ? originalContent : '',
                media_url: m.url
            });
        });
    }

    const currentReplyId = replyState ? replyState.id : null;
    const currentReplyText = replyState ? replyState.text : null;
    const currentReplyAuthor = replyState ? replyState.author : null;
    cancelReply();

    for (let i = 0; i < messagesToSend.length; i++) {
        const msgData = messagesToSend[i];

        // --- OPTIMISTIC UI ---
        const tempMsg = {
            usuario_id: currentUser.id,
            conteudo: msgData.conteudo,
            media_url: msgData.media_url,
            criado_em: new Date().toISOString(),
            autor_nome: currentUser.nome,
            autor_foto: currentUser.foto,
            reply_to_id: i === 0 ? currentReplyId : null,
            reply_content: i === 0 ? currentReplyText : null,
            reply_author: i === 0 ? currentReplyAuthor : null
        };
        const tempBubble = renderSingleMessage(tempMsg, true);
        
        const container = document.getElementById('chatMessages');
        container.scrollTop = container.scrollHeight;
        trimMessageDom(container);
        // ---------------------

        try {
            const body = { 
                conteudo: msgData.conteudo, 
                media_url: msgData.media_url,
                reply_to_id: i === 0 ? currentReplyId : null
            };
            if (subtopicAtual) body.subtopico_id = subtopicAtual.id;

            const res = await api(`/api/conversas/${conversaAtual.id}/mensagens`, {
                method: 'POST', body
            });
            
            if (tempBubble) {
                tempBubble.classList.remove('msg-sending');
                tempBubble.dataset.msgId = res.id;
                tempBubble.querySelector('.msg-time').textContent = formatTime(res.criado_em);
                
                // Se for uma resposta, garante que o contexto está visível
                if (res.reply_to_id && !tempBubble.querySelector('.msg-reply-context')) {
                    const replyHtml = `
                        <div class="msg-reply-context" onclick="jumpToMessage(${res.reply_to_id})">
                            <span class="reply-context-author">${res.reply_author || 'Usuário'}</span>
                            <div class="reply-context-text">${escapeHtml(res.reply_content)}</div>
                        </div>
                    `;
                    tempBubble.querySelector('.msg-content').insertAdjacentHTML('beforebegin', replyHtml);
                }

                const actions = tempBubble.querySelector('.msg-actions');
                const currentUserEscaped = (currentUser.nome || 'Você').replace(/'/g, "\\'");
                const conteudoEscaped = (msgData.conteudo || '').replace(/'/g, "\\'").replace(/\n/g, " ");

                actions.innerHTML = `
                    <button class="btn btn-sm btn-ghost" onclick="setReplyMode(${res.id}, '${currentUserEscaped}', '${conteudoEscaped}')" title="Responder">
                        <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="lucide lucide-reply"><polyline points="9 17 4 12 9 7"/><path d="M20 18v-2a4 4 0 0 0-4-4H4"/></svg>
                    </button>
                    <button class="btn btn-sm btn-ghost" onclick="apagarMensagem(${res.id})" title="Apagar mensagem">
                        <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="lucide lucide-trash-2"><path d="M3 6h18"/><path d="M19 6v14c0 1-1 2-2 2H7c-1 0-2-1-2-2V6"/><path d="M8 6V4c0-1 1-2 2-2h4c1 0 2 1 2 2v2"/><line x1="10" x2="10" y1="11" y2="17"/><line x1="14" x2="14" y1="11" y2="17"/></svg>
                    </button>
                `;
            }
            
            if (res.id > lastMsgId) lastMsgId = res.id;
            // Atualiza cache da conversa com a mensagem confirmada
            const cacheEntry = getMessageCacheEntry(conversaAtual.id);
            cacheEntry.messages.push(res);
            cacheEntry.lastMsgId = lastMsgId;
            cacheEntry.lastFetchedAt = Date.now();
            messageCache[conversaAtual.id] = cacheEntry;
        } catch (err) {
            if (tempBubble) tempBubble.remove();
            showToast('Erro ao enviar mensagem', 'error');
        }
    }
    loadConversas();
}

// ══════════════════════════════════════════════
//  Tenor Integration
// ══════════════════════════════════════════════
let searchTimeout = null;

document.getElementById('btnGifChat').addEventListener('click', () => {
    const panel = document.getElementById('gifPanel');
    const emojiPanel = document.getElementById('emojiPanel');
    if (!emojiPanel.classList.contains('hidden')) emojiPanel.classList.add('hidden');
    panel.classList.toggle('hidden');
    if (!panel.classList.contains('hidden')) {
        document.getElementById('gifSearchInput').value = '';
        appFetchTenorTrending(renderTenorResults);
        document.getElementById('gifSearchInput').focus();
    }
});

// ══════════════════════════════════════════════
//  Emoji Picker Integration
// ══════════════════════════════════════════════
const commonEmojis = [
    '😀', '😃', '😄', '😁', '😆', '😅', '🤣', '😂', '🙂', '🙃', 
    '😉', '😊', '😇', '🥰', '😍', '🤩', '😘', '😗', '☺️', '😚', 
    '😙', '🥲', '😋', '😛', '😜', '🤪', '😝', '🤑', '🤗', '🤭', 
    '🤫', '🤔', '🤐', '🤨', '😐', '😑', '😶', '😏', '😒', '🙄', 
    '😬', '🤥', '😌', 'زين', '😔', '😪', '🤤', '😴', '😷', '🤒', 
    '🤕', '🤢', '🤮', '🤧', '🥵', '🥶', '🥴', '😵', '🤯', '🤠', 
    '🥳', '😎', '🤓', '🧐', '😕', '😟', '🙁', '☹️', '😮', '😯', 
    '😲', '😳', '🥺', '😦', '😧', '😨', '😰', '😥', '😢', '😭', 
    '😱', '😖', '😣', '😞', '😓', '😩', '😫', '🥱', '😤', '😡', 
    '😠', '🤬', '😈', '👿', '💀', '☠️', '💩', '🤡', '👹', '👺', 
    '👻', '👽', '👾', '🤖', '😺', '😸', '😹', '😻', '😼', '😽', 
    '🙀', '😿', '😾', '💯', '❤️', '🔥', '👍', '👎', '🎉', '✨'
];

document.getElementById('btnEmojiChat')?.addEventListener('click', () => {
    const panel = document.getElementById('emojiPanel');
    const gifPanel = document.getElementById('gifPanel');
    if (!gifPanel.classList.contains('hidden')) gifPanel.classList.add('hidden');
    
    panel.classList.toggle('hidden');
    if (!panel.classList.contains('hidden')) {
        renderEmojiPicker();
    }
});

function renderEmojiPicker() {
    const container = document.getElementById('emojiResults');
    if (!container) return;
    
    container.innerHTML = commonEmojis.map(emojiChar => {
        return `
            <div onclick="selectEmoji('${emojiChar}')" style="cursor: pointer; padding: 0.2rem; border-radius: 8px; transition: background 0.2s; display: flex; align-items: center; justify-content: center; font-size: 1.5rem;"
                 onmouseover="this.style.background='rgba(255,255,255,0.1)'" onmouseout="this.style.background='transparent'">
                ${emojiChar}
            </div>
        `;
    }).join('');
}

function selectEmoji(emojiChar) {
    const input = document.getElementById('chatInput');
    const cursorPos = input.selectionStart;
    const textBefore = input.value.substring(0, cursorPos);
    const textAfter = input.value.substring(cursorPos);
    input.value = textBefore + emojiChar + textAfter;
    
    // Automatically hide picker when selected (optional, maybe keep it open for multiple?)
    // document.getElementById('emojiPanel').classList.add('hidden');
    
    input.focus();
    input.selectionStart = cursorPos + emojiChar.length;
    input.selectionEnd = cursorPos + emojiChar.length;
}

// ══════════════════════════════════════════════
//  Sticker Picker Integration
// ══════════════════════════════════════════════
document.getElementById('btnStickerChat')?.addEventListener('click', () => {
    const panel = document.getElementById('stickerPanel');
    const gidPanel = document.getElementById('gifPanel');
    const emoPanel = document.getElementById('emojiPanel');
    
    if (!gidPanel.classList.contains('hidden')) gidPanel.classList.add('hidden');
    if (!emoPanel.classList.contains('hidden')) emoPanel.classList.add('hidden');
    
    panel.classList.toggle('hidden');
    if (!panel.classList.contains('hidden')) {
        renderStickerPicker();
    }
});

async function renderStickerPicker() {
    const container = document.getElementById('stickerResults');
    if (!container) return;
    
    try {
        const stickers = await api('/api/stickers');
        if (!stickers || stickers.length === 0) {
            container.innerHTML = '<p style="grid-column: 1/-1; text-align: center; color: var(--text-muted); font-size: 0.8rem; padding: 1rem;">Nenhuma figurinha importada.</p>';
            return;
        }
        
        container.innerHTML = stickers.map(s => `
            <div class="sticker-item" onclick="enviarSticker('${s.url}')">
                <img src="${s.url}" loading="lazy" alt="sticker">
            </div>
        `).join('');
    } catch (err) {
        container.innerHTML = '<p style="grid-column: 1/-1; text-align: center; color: var(--danger); font-size: 0.8rem;">Erro ao carregar figurinhas.</p>';
    }
}

async function enviarSticker(url) {
    if (!conversaAtual) return;
    closeAllPanels();
    
    // Stickers bypass pendingMedia logic for instant send
    try {
        await api(`/api/conversas/${conversaAtual.id}/mensagens`, {
            method: 'POST',
            body: { conteudo: '', media_url: url }
        });
        // SocketIO will handle the real-time update
    } catch (err) {
        showToast('Erro ao enviar figurinha', 'error');
    }
}

window.importarStickerDesdeArquivo = async function(input) {
    const file = input.files[0];
    if (!file) return;
    
    const form = new FormData();
    form.append('sticker', file);
    
    showToast('Importando figurinha...', 'info');
    try {
        const res = await fetch('/api/stickers/import', {
            method: 'POST',
            credentials: 'same-origin',
            body: form
        });
        const data = await res.json();
        if (res.ok) {
            showToast('Figurinha importada! 🌟', 'success');
            renderStickerPicker();
        } else {
            showToast(data.erro || 'Erro na importação', 'error');
        }
    } catch (err) {
        showToast('Erro ao importar', 'error');
    }
    input.value = '';
};

document.getElementById('gifSearchInput').addEventListener('input', (e) => {
    const q = e.target.value.trim();
    clearTimeout(searchTimeout);
    if (!q) {
        appFetchTenorTrending(renderTenorResults);
        return;
    }
    searchTimeout = setTimeout(() => {
        appFetchTenorSearch(q, renderTenorResults);
    }, 500);
});

function renderTenorResults(gifs) {
    const container = document.getElementById('gifResults');
    if (!gifs || gifs.length === 0) {
        container.innerHTML = '<p style="text-align: center; color: var(--text-muted); padding: 1rem; width: 100%;">Nenhum GIF encontrado</p>';
        return;
    }

    container.innerHTML = gifs.map(g => {
        const tinyUrl = g.media[0].tinygif.url;
        const fullUrl = g.media[0].gif.url;
        return `
        <div style="cursor: pointer; border-radius: var(--radius-sm); overflow: hidden; margin-bottom: 0.5rem; break-inside: avoid; display: block; border: 1px solid rgba(255,255,255,0.05); aspect-ratio: 1/1;" onclick="selectGif('${fullUrl}')">
            <img src="${tinyUrl}" style="width: 100%; height: 100%; object-fit: cover; display: block;" loading="lazy" alt="GIF">
        </div>
        `;
    }).join('');
}

function selectGif(url) {
    closeAllPanels();
    // GIFs bypass standard file upload and go into pendingMedia array
    pendingMedia = [{ url: url, name: 'Tenor GIF', isVideo: false, uploading: false }];
    enviarMensagem();
}

// ══════════════════════════════════════════════
//  Unified Sync Polling
//  FIX: isSyncing flag evita requests concorrentes
//  FIX: Para completamente no 401 (sessão expirada)
//  FIX: startSyncPolling só inicia UM intervalo (stopSyncPolling antes)
// ══════════════════════════════════════════════
let syncInterval = null;
let isSyncing = false; // FIX: guard contra concorrência

async function startSyncPolling() {
    // Polling is now disabled in favor of SocketIO
    // But we still poll for conversation list and callers occasionally (less frequently)
    performSyncLoop();
}

async function performSyncLoop() {
    await performSync();
    // 5 second polling for non-critical state (conversations list, active callers)
    syncInterval = setTimeout(performSyncLoop, 5000); 
}

function stopSyncPolling() {
    if (syncInterval) {
        clearTimeout(syncInterval);
        syncInterval = null;
    }
}

async function performSync() {
    if (isSyncing) return;
    isSyncing = true;

    try {
        let url = `/api/chat/sync?after_id=${lastMsgId}`;
        if (conversaAtual) url += `&conversa_id=${conversaAtual.id}`;
        
        const data = await api(url);
        
        // 1. Update Conversations
        if (JSON.stringify(data.conversas) !== JSON.stringify(conversas)) {
            conversas = data.conversas;
            window.conversas = conversas;
            renderConversasList();
        }

        // 2. Active Callers
        if (data.active_callers !== undefined) {
            updateActiveCallersUI(data.active_callers);
        }
    } catch (err) {
        if (err.message === 'Não autenticado') stopSyncPolling();
    } finally {
        isSyncing = false;
    }
}

// Keep old names for compatibility
function startChatPolling() { startSyncPolling(); }
function stopChatPolling() { stopSyncPolling(); }


// ── New Direct Chat ──
async function abrirNovoChatDireto() {
    try {
        const usuarios = await api('/api/usuarios');
        const others = usuarios.filter(u => u.id !== currentUser.id);
        if (others.length === 0) { showToast('Nenhum outro usuário cadastrado ainda','info'); return; }
        const userList = others.map(u => `
            <div class="user-select-item" onclick="criarChatDireto(${u.id})" style="cursor:pointer">
                <div class="chat-item-avatar" style="width:36px;height:36px">
                    ${u.foto ? `<img src="${u.foto}" alt="">` : `<span>${u.nome.charAt(0)}</span>`}
                </div>
                <div>
                    <div style="font-weight:600">${u.nome}</div>
                    <div style="font-size:0.8rem;color:var(--text-muted)">@${u.username}</div>
                </div>
            </div>`).join('');
        openModal('Nova Conversa', `<p style="margin-bottom:1rem;color:var(--text-secondary)">Selecione um usuário:</p><div style="display:flex;flex-direction:column;gap:0.5rem">${userList}</div>`, '');
    } catch(err) { showToast('Erro ao carregar usuários','error'); }
}
document.getElementById('btnNovoChatDireto').addEventListener('click', abrirNovoChatDireto);

async function criarChatDireto(userId) {
    try {
        const res = await api('/api/conversas/direto', { method:'POST', body:{ usuario_id: userId }});
        closeModal(); await loadConversas(); abrirConversa(res.id);
    } catch(err) { showToast('Erro ao criar conversa','error'); }
}

// ── New Group ──
async function abrirCriarGrupo() {
    try {
        const usuarios = await api('/api/usuarios');
        const others = usuarios.filter(u => u.id !== currentUser.id);
        const checkboxes = others.map(u => `
            <label class="member-selection-item">
                <input type="checkbox" value="${u.id}" class="grupo-membro-check hidden-checkbox">
                <div class="member-selection-content">
                    <div class="chat-item-avatar" style="width:36px;height:36px">
                        ${u.foto ? `<img src="${u.foto}" alt="">` : `<span>${u.nome.charAt(0)}</span>`}
                    </div>
                    <div class="member-info">
                        <span class="member-name">${u.nome}</span>
                        <span class="member-username">@${u.username}</span>
                    </div>
                    <div class="selection-indicator">
                        <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round" class="lucide lucide-check"><path d="M20 6 9 17l-5-5"/></svg>
                    </div>
                </div>
            </label>`).join('');
        openModal('Novo Grupo', `
            <div class="form-group"><label class="form-label">Nome do Grupo</label><input type="text" class="input" id="grupoNome" placeholder="Ex: Grupo de Estudos"></div>
            <div class="form-group"><label class="form-label">Membros</label><div style="max-height:200px;overflow-y:auto">${checkboxes||'<p class="empty-state">Nenhum outro usuário</p>'}</div></div>
        `, `<button class="btn btn-ghost" onclick="closeModal()">Cancelar</button><button class="btn btn-primary" onclick="criarGrupo()">Criar Grupo</button>`);
    } catch(err) { showToast('Erro ao carregar usuários','error'); }
}
document.getElementById('btnNovoGrupo').addEventListener('click', abrirCriarGrupo);

async function criarGrupo() {
    const nome = document.getElementById('grupoNome').value.trim();
    if (!nome) { showToast('Dê um nome ao grupo','error'); return; }
    const membros = Array.from(document.querySelectorAll('.grupo-membro-check:checked')).map(cb => parseInt(cb.value));
    try {
        const res = await api('/api/conversas/grupo', { method:'POST', body:{nome,membros}});
        closeModal(); showToast('Grupo criado!', 'success'); await loadConversas(); abrirConversa(res.id);
    } catch(err) { showToast('Erro ao criar grupo','error'); }
}

// ── Edit Group ──
document.getElementById('btnEditGrupo').addEventListener('click', async () => {
    if (!conversaAtual || conversaAtual.tipo !== 'grupo') return;

    let availableUsers = [];
    try {
        const allUsers = await api('/api/usuarios');
        const memberIds = conversaAtual.membros.map(m => m.id);
        availableUsers = allUsers.filter(u => !memberIds.includes(u.id) && u.id !== currentUser.id);
    } catch(err) {
        console.error('Erro ao buscar usuários para add no grupo', err);
    }

    const subsList = subtopicos.map(s => `
        <div style="display:flex;align-items:center;gap:0.5rem;padding:0.4rem 0.6rem;background:var(--bg-input);border-radius:var(--radius-sm);border-left:3px solid ${s.cor}">
            <span style="flex:1">${s.nome}</span>
            <button class="btn btn-sm btn-ghost" onclick="editarSubtopico(${s.id})" style="padding:0.2rem 0.4rem">
                <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="lucide lucide-pencil"><path d="M17 3a2.85 2.83 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5Z"/><path d="m15 5 4 4"/></svg>
            </button>
        </div>`).join('');

    openModal('Editar Grupo', `
        <div style="text-align:center;margin-bottom:1.5rem">
            <div class="profile-avatar-lg" id="grupoAvatarEdit" style="margin: 0 auto 1rem;">
                ${conversaAtual.foto ? `<img src="${conversaAtual.foto}" alt="">` : `<span><svg xmlns="http://www.w3.org/2000/svg" width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="lucide lucide-users"><path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M22 21v-2a4 4 0 0 0-3-3.87"/><path d="M16 3.13a4 4 0 0 1 0 7.75"/></svg></span>`}
            </div>
            <div style="display: flex; gap: 0.5rem; justify-content: center;">
                <label class="btn btn-sm btn-secondary" style="cursor:pointer" title="Subir arquivo">
                    📷 Arquivo
                    <input type="file" id="grupoFotoInput" accept="image/jpeg,image/png,image/webp,image/gif" style="display:none">
                </label>
                <button class="btn btn-sm btn-secondary" id="btnGrupoGif" title="Procurar GIF">🎬 Buscar GIF</button>
            </div>
            
            <div id="grupoGifPanel" class="hidden" style="margin-top: 1rem; text-align: left; background: var(--bg-surface); padding: 1rem; border-radius: var(--radius-md); border: 1px solid rgba(255,255,255,0.05);">
                <input type="text" class="input" id="grupoGifSearch" placeholder="Pesquisar Tenor GIF..." autocomplete="off" style="margin-bottom: 0.5rem">
                <div id="grupoGifResults" style="display: grid; grid-template-columns: repeat(3, 1fr); gap: 0.25rem; max-height: 250px; overflow-y: auto;">
                </div>
            </div>
        </div>
        
        <div class="form-group"><label class="form-label">Nome do Grupo</label><input type="text" class="input" id="editGrupoNome" value="${conversaAtual.nome||''}"></div>
        <div class="form-group"><label class="form-label">Descrição</label><textarea class="textarea" id="editGrupoDesc" style="min-height:60px" placeholder="Descreva o grupo...">${conversaAtual.descricao||''}</textarea></div>
        
        <div class="form-group">
            <label class="form-label">Fundo do Card (Wallpaper)</label>
            <div style="display: flex; gap: 0.5rem; flex-direction: column;">
                <div class="profile-wallpaper-preview" id="grupoWallPreview" style="height: 60px; border-radius: 8px; overflow: hidden; background: #222; position: relative;">
                    ${conversaAtual.wallpaper ? `<img src="${conversaAtual.wallpaper}" style="width: 100%; height: 100%; object-fit: cover;">` : '<div style="width:100%; height:100%; display:flex; align-items:center; justify-content:center; opacity:0.3; font-size:0.8rem;">Sem fundo</div>'}
                </div>
                <div style="display: flex; gap: 0.5rem;">
                    <label class="btn btn-sm btn-secondary" style="cursor:pointer; flex: 1; justify-content: center;">
                        <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="lucide lucide-image" style="margin-right: 4px;"><rect width="18" height="18" x="3" y="3" rx="2" ry="2"/><circle cx="9" cy="9" r="2"/><path d="m21 15-3.086-3.086a2 2 0 0 0-2.828 0L6 21"/></svg>
                        Imagem/GIF
                        <input type="file" id="grupoWallInput" accept="image/jpeg,image/png,image/webp,image/gif" style="display:none">
                    </label>
                    <button class="btn btn-sm btn-secondary" id="btnGrupoWallGif" style="flex: 1; justify-content: center;">🎬 Buscar GIF</button>
                    ${conversaAtual.wallpaper ? `<button class="btn btn-sm btn-ghost" onclick="removerGrupoWall()" style="color:var(--danger)"><svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="lucide lucide-trash-2"><path d="M3 6h18"/><path d="M19 6v14c0 1-1 2-2 2H7c-1 0-2-1-2-2V6"/><path d="M8 6V4c0-1 1-2 2-2h4c1 0 2 1 2 2v2"/><line x1="10" x2="10" y1="11" y2="17"/><line x1="14" x2="14" y1="11" y2="17"/></svg></button>` : ''}
                </div>
            </div>
            
            <div id="grupoWallGifPanel" class="hidden" style="margin-top: 1rem; text-align: left; background: var(--bg-surface); padding: 1rem; border-radius: var(--radius-md); border: 1px solid rgba(255,255,255,0.05);">
                <input type="text" class="input" id="grupoWallGifSearch" placeholder="Pesquisar Tenor GIF..." autocomplete="off" style="margin-bottom: 0.5rem">
                <div id="grupoWallGifResults" style="display: grid; grid-template-columns: repeat(3, 1fr); gap: 0.25rem; max-height: 200px; overflow-y: auto;">
                </div>
            </div>
        </div>

        <div class="form-group"><label class="form-label">Membros (${conversaAtual.membros.length})</label>
            <div style="display:flex;flex-wrap:wrap;gap:0.5rem">${conversaAtual.membros.map(m => `<span style="display:inline-flex;align-items:center;gap:0.25rem;padding:0.25rem 0.75rem;background:var(--bg-input);border-radius:var(--radius-full);font-size:0.85rem">${m.nome}</span>`).join('')}</div>
        </div>

        ${availableUsers.length > 0 ? `
        <div class="form-group member-addition-modern">
            <label class="form-label">Adicionar Novo Membro</label>
            <div class="member-search-container">
                <input type="text" class="input search-input" id="newMemberSearch" placeholder="Pesquisar por nome ou @usuário..." oninput="window._filtrarMembrosAdicao(this.value)">
                <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="lucide lucide-search search-icon"><circle cx="11" cy="11" r="8"/><path d="m21 21-4.3-4.3"/></svg>
            </div>
            <div class="add-members-list" id="addMembersList">
                ${availableUsers.map(u => `
                <label class="member-selection-item add-item" data-search="${u.nome.toLowerCase()} @${u.username.toLowerCase()}">
                    <input type="checkbox" value="${u.id}" class="add-membro-check hidden-checkbox">
                    <div class="member-selection-content small">
                        <div class="chat-item-avatar" style="width:32px;height:32px">
                            ${u.foto ? `<img src="${u.foto}" alt="">` : `<span>${u.nome.charAt(0)}</span>`}
                        </div>
                        <div class="member-info">
                            <span class="member-name">${u.nome}</span>
                            <span class="member-username">@${u.username}</span>
                        </div>
                        <div class="selection-indicator">
                            <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round" class="lucide lucide-check"><path d="M20 6 9 17l-5-5"/></svg>
                        </div>
                    </div>
                </label>`).join('')}
            </div>
            <button class="btn btn-primary w-full mt-2" onclick="window._adicionarMembroGrupo()">Adicionar Selecionados</button>
        </div>
        ` : ''}

        <div class="form-group"><label class="form-label">Subtópicos (${subtopicos.length})</label>
            <div style="display:flex;flex-direction:column;gap:0.4rem">${subsList||'<p style="font-size:0.85rem;color:var(--text-muted)">Nenhum subtópico</p>'}</div>
            <button class="btn btn-sm btn-secondary" onclick="closeModal();abrirCriarSubtopico();" style="margin-top:0.5rem">+ Novo Subtópico</button>
        </div>
        
        <div style="margin-top:2rem; padding-top:1rem; border-top:1px solid rgba(255,255,255,0.1); text-align:center;">
            <button class="btn btn-ghost" style="color:var(--danger)" onclick="excluirGrupoInteiro()">
                <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="lucide lucide-trash-2" style="margin-right: 6px;"><path d="M3 6h18"/><path d="M19 6v14c0 1-1 2-2 2H7c-1 0-2-1-2-2V6"/><path d="M8 6V4c0-1 1-2 2-2h4c1 0 2 1 2 2v2"/><line x1="10" x2="10" y1="11" y2="17"/><line x1="14" x2="14" y1="11" y2="17"/></svg>
                Excluir Grupo
            </button>
        </div>
    `, `<button class="btn btn-ghost" onclick="closeModal()">Cancelar</button><button class="btn btn-primary" onclick="salvarGrupo()">Salvar</button>`);

    setTimeout(() => {
        const input = document.getElementById('grupoFotoInput');
        if (input) {
            input.addEventListener('change', async () => {
                const file = input.files[0];
                if (!file) return;
                const form = new FormData();
                form.append('foto', file);
                try {
                    const res = await fetch(`/api/conversas/${conversaAtual.id}/foto`, { method:'POST', credentials:'same-origin', body:form });
                    const data = await res.json();
                    if (res.ok) { setGrupoAvatar(data.foto); }
                } catch(err) { showToast('Erro ao enviar foto','error'); }
            });
        }
        
        const btnGif = document.getElementById('btnGrupoGif');
        const searchInput = document.getElementById('grupoGifSearch');
        let grupoSearchTimeout = null;
        
        if (btnGif) {
            btnGif.addEventListener('click', () => {
                const panel = document.getElementById('grupoGifPanel');
                panel.classList.toggle('hidden');
                if (!panel.classList.contains('hidden')) {
                    searchInput.value = '';
                    appFetchTenorTrending(renderGrupoGifs);
                    searchInput.focus();
                }
            });
        }
        
        if (searchInput) {
            searchInput.addEventListener('input', (e) => {
                const q = e.target.value.trim();
                clearTimeout(grupoSearchTimeout);
                if (!q) { appFetchTenorTrending(renderGrupoGifs); return; }
                grupoSearchTimeout = setTimeout(() => { appFetchTenorSearch(q, renderGrupoGifs); }, 500);
            });
        }

        // Logic for Wallpaper
        const wallInput = document.getElementById('grupoWallInput');
        if (wallInput) {
            wallInput.addEventListener('change', async () => {
                const file = wallInput.files[0];
                if (!file) return;
                const form = new FormData();
                form.append('wallpaper', file);
                try {
                    const res = await fetch(`/api/conversas/${conversaAtual.id}/wallpaper`, { method:'POST', credentials:'same-origin', body:form });
                    const data = await res.json();
                    if (res.ok) { setGrupoWallpaper(data.wallpaper); }
                } catch(err) { showToast('Erro ao enviar wallpaper','error'); }
            });
        }

        const btnWallGif = document.getElementById('btnGrupoWallGif');
        const wallSearchInput = document.getElementById('grupoWallGifSearch');
        if (btnWallGif) {
            btnWallGif.addEventListener('click', () => {
                const panel = document.getElementById('grupoWallGifPanel');
                panel.classList.toggle('hidden');
                if (!panel.classList.contains('hidden')) {
                    wallSearchInput.value = '';
                    appFetchTenorTrending(renderGrupoWallGifs);
                    wallSearchInput.focus();
                }
            });
        }
        if (wallSearchInput) {
            wallSearchInput.addEventListener('input', (e) => {
                const q = e.target.value.trim();
                clearTimeout(grupoSearchTimeout);
                if (!q) { appFetchTenorTrending(renderGrupoWallGifs); return; }
                grupoSearchTimeout = setTimeout(() => { appFetchTenorSearch(q, renderGrupoWallGifs); }, 500);
            });
        }
    }, 100);
});

window._adicionarMembroGrupo = async function() {
    if (!conversaAtual) return;
    const checked = Array.from(document.querySelectorAll('.add-membro-check:checked'));
    if (checked.length === 0) {
        showToast('Selecione pelo menos um usuário', 'error');
        return;
    }
    
    try {
        for (const cb of checked) {
            await api(`/api/conversas/${conversaAtual.id}/membros`, {
                method: 'POST',
                body: { usuario_id: parseInt(cb.value) }
            });
        }
        showToast(`${checked.length} membro(s) adicionado(s)!`, 'success');
        closeModal();
        await loadConversas();
        abrirConversa(conversaAtual.id);
    } catch(err) {
        showToast('Erro ao adicionar membro(s)', 'error');
    }
};

window._filtrarMembrosAdicao = function(query) {
    const q = query.toLowerCase();
    const items = document.querySelectorAll('.member-selection-item.add-item');
    items.forEach(item => {
        const text = item.getAttribute('data-search');
        if (text.includes(q)) {
            item.style.display = 'block';
        } else {
            item.style.display = 'none';
        }
    });
};

function renderGrupoWallGifs(gifs) {
    const container = document.getElementById('grupoWallGifResults');
    if (!gifs || !gifs.length) { container.innerHTML = '<p class="empty-state" style="grid-column:1/-1">Nenhum GIF encontrado</p>'; return; }
    
    window._tempSelectGrupoWallGif = async (url) => {
        document.getElementById('grupoWallGifPanel').classList.add('hidden');
        showToast('Baixando fundo...', 'info');
        try {
            const proxyRes = await fetch(url);
            const blob = await proxyRes.blob();
            const file = new File([blob], "wallpaper.gif", { type: "image/gif" });
            const form = new FormData();
            form.append('wallpaper', file);
            const upRes = await fetch(`/api/conversas/${conversaAtual.id}/wallpaper`, { method:'POST', body:form });
            const upData = await upRes.json();
            if (upRes.ok) { setGrupoWallpaper(upData.wallpaper); }
        } catch(err) { showToast('Erro no GIF', 'error'); }
    };
    
    container.innerHTML = gifs.map(g => {
        const tinyUrl = g.media[0].tinygif.url;
        const fullUrl = g.media[0].gif.url;
        return `
        <div style="cursor: pointer; border-radius: var(--radius-sm); overflow: hidden; border: 1px solid rgba(255,255,255,0.05);" onclick="window._tempSelectGrupoWallGif('${fullUrl}')">
            <img src="${tinyUrl}" style="width: 100%; height: 60px; object-fit: cover; display: block;" alt="GIF">
        </div>
        `;
    }).join('');
}

function setGrupoWallpaper(url) {
    if (!conversaAtual) return;
    conversaAtual.wallpaper = url;
    conversaAtual.display_wallpaper = url;
    applyActiveChatWallpaper(url);
    document.getElementById('grupoWallPreview').innerHTML = `<img src="${url}" style="width:100%; height:100%; object-fit:cover;">`;
    renderConversasList();
    showToast('Plano de fundo atualizado!', 'success');
}

function removerGrupoWall() {
    if (!conversaAtual) return;
    conversaAtual.wallpaper = '';
    conversaAtual.display_wallpaper = '';
    applyActiveChatWallpaper(null);
    document.getElementById('grupoWallPreview').innerHTML = '<div style="width:100%; height:100%; display:flex; align-items:center; justify-content:center; opacity:0.3; font-size:0.8rem;">Sem fundo</div>';
    renderConversasList();
    showToast('Fundo removido','info');
}

function renderGrupoGifs(gifs) {
    const container = document.getElementById('grupoGifResults');
    if (!gifs || !gifs.length) { container.innerHTML = '<p class="empty-state" style="grid-column:1/-1">Nenhum GIF encontrado</p>'; return; }
    
    window._tempSelectGrupoGif = async (url) => {
        document.getElementById('grupoGifPanel').classList.add('hidden');
        showToast('Baixando GIF pro grupo...', 'info');
        try {
            const proxyRes = await fetch(url);
            const blob = await proxyRes.blob();
            const file = new File([blob], "avatar.gif", { type: "image/gif" });
            const form = new FormData();
            form.append('foto', file);
            
            const upRes = await fetch(`/api/conversas/${conversaAtual.id}/foto`, { method:'POST', body:form });
            const upData = await upRes.json();
            if (upRes.ok) { setGrupoAvatar(upData.foto); }
        } catch(err) { showToast('Erro no GIF', 'error'); }
    };
    
    container.innerHTML = gifs.map(g => {
        const tinyUrl = g.media[0].tinygif.url;
        const fullUrl = g.media[0].gif.url;
        return `
        <div style="cursor: pointer; border-radius: var(--radius-sm); overflow: hidden; border: 1px solid rgba(255,255,255,0.05);" onclick="window._tempSelectGrupoGif('${fullUrl}')">
            <img src="${tinyUrl}" style="width: 100%; height: 60px; object-fit: cover; display: block;" alt="GIF">
        </div>
        `;
    }).join('');
}

function setGrupoAvatar(url) {
    if (!conversaAtual) return;
    conversaAtual.foto = url;
    conversaAtual.display_foto = url;
    document.getElementById('grupoAvatarEdit').innerHTML = `<img src="${url}" alt="">`;
    document.getElementById('chatAvatar').innerHTML = `<img src="${url}" alt="">`;
    renderConversasList();
    showToast('Foto do grupo atualizada!', 'success');
}

async function excluirChat(id, nome) {
    if (!confirm(`Tem certeza que deseja excluir a conversa com ${nome}?\nIsso apagará todas as mensagens para ambos os lados e não pode ser desfeito.`)) return;
    try {
        await api(`/api/conversas/${id}`, { method: 'DELETE' });
        showToast('Conversa excluída', 'success');
        if (conversaAtual && conversaAtual.id === id) {
            conversaAtual = null;
            window.conversaAtual = null;
            document.querySelector('.chat-placeholder').classList.remove('hidden');
            document.getElementById('chatHeader').classList.add('hidden');
            document.getElementById('chatMessages').classList.add('hidden');
            document.getElementById('chatInputArea').classList.add('hidden');
            document.getElementById('chatParticipants').classList.add('hidden');
            document.querySelector('.chat-layout').classList.add('no-participants');
        }
        await loadConversas();
    } catch(err) {
        showToast('Erro ao excluir', 'error');
    }
}

async function excluirGrupoInteiro() {
    if (!conversaAtual) return;
    if (!confirm(`ATENÇÃO: Você deseja realmente EXCLUIR este grupo para TODOS os membros?\n\nTodas as mensagens, mídia e membros serão deletados permanentemente.`)) return;
    try {
        await api(`/api/conversas/${conversaAtual.id}`, { method: 'DELETE' });
        showToast('Grupo excluído permanentemente', 'success');
        closeModal();
        conversaAtual = null;
        window.conversaAtual = null;
        document.querySelector('.chat-placeholder').classList.remove('hidden');
        document.getElementById('chatHeader').classList.add('hidden');
        document.getElementById('chatMessages').classList.add('hidden');
        document.getElementById('chatInputArea').classList.add('hidden');
        document.getElementById('chatParticipants').classList.add('hidden');
        document.querySelector('.chat-layout').classList.add('no-participants');
        await loadConversas();
    } catch(err) {
        showToast('Erro ao excluir grupo', 'error');
    }
}

async function salvarGrupo() {
    if (!conversaAtual) return;
    try {
        await api(`/api/conversas/${conversaAtual.id}`, { method:'PUT', body:{
            nome: document.getElementById('editGrupoNome').value.trim(),
            descricao: document.getElementById('editGrupoDesc').value.trim(),
            wallpaper: conversaAtual.wallpaper || ''
        }});
        closeModal(); showToast('Grupo atualizado! ✅','success');
        await loadConversas();
        const updated = conversas.find(c => c.id === conversaAtual.id);
        if (updated) abrirConversa(updated.id);
    } catch(err) { showToast('Erro ao salvar grupo','error'); }
}

// ── Mobile Back Button ──
document.getElementById('btnBackChat').addEventListener('click', () => {
    conversaAtual = null;
    window.conversaAtual = null;
    document.querySelector('.chat-placeholder').classList.remove('hidden');
    document.getElementById('chatHeader').classList.add('hidden');
    document.getElementById('chatMessages').classList.add('hidden');
    document.getElementById('chatInputArea').classList.add('hidden');
    document.getElementById('subtopicsBar').classList.add('hidden');
    document.getElementById('chatParticipants').classList.add('hidden');
    document.querySelector('.chat-layout').classList.add('no-participants');
    renderConversasList();
});

// ── Utility ──
async function abrirPerfil(userId) {
    if (!userId) return;
    try {
        let user = conversaAtual?.membros?.find(m => m.id === userId);
        
        if (!user || user.wallpaper === undefined || user.bio === undefined) {
            const allUsers = await api('/api/usuarios');
            user = allUsers.find(u => u.id === userId);
        }
        
        if (!user) {
            showToast('Usuário não encontrado', 'error');
            return;
        }

        const initial = user.nome.charAt(0).toUpperCase();

        openModal('Perfil do Usuário', `
            <div class="bio-card">
                <div class="bio-card-wallpaper">
                    ${user.wallpaper ? `<img src="${user.wallpaper}" alt="wallpaper">` : `<div style="width:100%;height:100%;background:linear-gradient(45deg, var(--primary), var(--secondary));opacity:0.6"></div>`}
                    <div class="bio-card-avatar">
                        ${user.foto ? `<img src="${user.foto}" alt="${user.nome}">` : `<video autoplay loop muted playsinline class="default-avatar-vid"><source src="/static/images/Criação_de_Animação_Abstrata_Anime.mp4" type="video/mp4"></video>`}
                    </div>
                </div>
                <div class="bio-card-name">${user.nome}</div>
                <div class="bio-card-username">@${user.username}</div>
                ${user.bio ? `<div class="bio-card-bio">${user.bio}</div>` : '<div class="bio-card-bio" style="font-style:italic;opacity:0.5">Sem biografia</div>'}
            </div>
        `, `
            <button class="btn btn-primary" onclick="closeModal()">Fechar</button>
        `);
    } catch (err) {
        console.error('Error opening profile:', err);
        showToast('Erro ao carregar perfil', 'error');
    }
}

// ── Helpers ──
function formatTime(dt) {
    if (!dt) return '';
    try {
        const d = new Date(dt.replace(' ','T'));
        const now = new Date();
        if (d.toDateString() === now.toDateString()) {
            return d.toLocaleTimeString('pt-BR', { hour:'2-digit', minute:'2-digit' });
        }
        return d.toLocaleDateString('pt-BR', { day:'2-digit', month:'2-digit' });
    } catch(e) { return dt; }
}

// ── Message Replies Logic ──
window.setReplyMode = function(id, author, text) {
    replyState = { id, author, text };
    const preview = document.getElementById('replyPreview');
    if (!preview) return;
    document.getElementById('replyPreviewAuthor').textContent = author;
    document.getElementById('replyPreviewText').textContent = text;
    preview.classList.remove('hidden');
    document.getElementById('chatInput').focus();
};

window.cancelReply = function() {
    replyState = null;
    const preview = document.getElementById('replyPreview');
    if (preview) preview.classList.add('hidden');
};

window.jumpToMessage = function(id) {
    const el = document.querySelector(`.msg-bubble[data-msg-id="${id}"]`);
    if (el) {
        el.scrollIntoView({ behavior: 'smooth', block: 'center' });
        el.style.backgroundColor = 'var(--accent-primary-glow)';
        setTimeout(() => {
            el.style.backgroundColor = '';
        }, 1500);
    } else {
        showToast('Mensagem original não carregada nesta sessão', 'info');
    }
};

const originalAbrirConversa = abrirConversa;
abrirConversa = async function(id) {
    cancelReply();
    return originalAbrirConversa(id);
};

// ── Pinned Messages Logic ──
async function fixarMensagem(msgId) {
    if (!conversaAtual) return;
    try {
        await api(`/api/conversas/${conversaAtual.id}/pin`, {
            method: 'POST',
            body: { mensagem_id: msgId }
        });
        showToast('Mensagem fixada!', 'success');
        // O sync cuidará de atualizar a UI para todos
    } catch (err) {
        showToast('Erro ao fixar mensagem', 'error');
    }
}

async function desafixarMensagem() {
    if (!conversaAtual) return;
    try {
        await api(`/api/conversas/${conversaAtual.id}/pin`, {
            method: 'POST',
            body: { 
                mensagem_id: null,
                subtopico_id: subtopicAtual ? subtopicAtual.id : null
            }
        });
        showToast('Mensagem desafixada', 'info');
    } catch (err) {
        showToast('Erro ao desafixar', 'error');
    }
}

function renderPinnedMessageBar() {
    const bar = document.getElementById('pinnedMessageBar');
    if (!conversaAtual || !bar) return;

    if (conversaAtual.pinned_message_id) {
        document.getElementById('pinnedMessageAuthor').textContent = conversaAtual.pinned_author || 'Usuário';
        document.getElementById('pinnedMessageText').textContent = conversaAtual.pinned_content || '...';
        bar.classList.remove('hidden');
    } else {
        bar.classList.add('hidden');
    }
}

function jumpToPinnedMessage() {
    if (!conversaAtual || !conversaAtual.pinned_message_id) return;
    jumpToMessage(conversaAtual.pinned_message_id);
}

// Ensure global access if needed from HTML onclick
window.fixarMensagem = fixarMensagem;
window.desafixarMensagem = desafixarMensagem;
window.jumpToPinnedMessage = jumpToPinnedMessage;

// Add event listener for desafixar button
document.getElementById('btnDesafixar')?.addEventListener('click', (e) => {
    e.stopPropagation();
    desafixarMensagem();
});


// ══════════════════════════════════════════════
//  NOTIFICATION SYSTEM
// ══════════════════════════════════════════════
let unreadCounts = {};           // conversa_id -> count
let notifPermissionAsked = false;
let notifSoundEnabled = true;

// Request browser notification permission early
function requestNotificationPermission() {
    if (notifPermissionAsked) return;
    notifPermissionAsked = true;
    if ('Notification' in window && Notification.permission === 'default') {
        Notification.requestPermission();
    }
}

// Call this on login/startup
setTimeout(requestNotificationPermission, 3000);

// Play notification sound
function playNotifSound() {
    if (!notifSoundEnabled) return;
    try {
        const ctx = new (window.AudioContext || window.webkitAudioContext)();
        const osc = ctx.createOscillator();
        const gain = ctx.createGain();
        osc.connect(gain);
        gain.connect(ctx.destination);
        osc.type = 'sine';
        osc.frequency.setValueAtTime(880, ctx.currentTime);
        osc.frequency.setValueAtTime(660, ctx.currentTime + 0.1);
        gain.gain.setValueAtTime(0.15, ctx.currentTime);
        gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + 0.4);
        osc.start(ctx.currentTime);
        osc.stop(ctx.currentTime + 0.4);
    } catch (e) {}
}

// Increment unread count for a conversation
function incrementUnread(convId) {
    unreadCounts[convId] = (unreadCounts[convId] || 0) + 1;
    renderConversasList();
}



// Clear unread when opening a conversation
const _originalAbrirConversa = window.abrirConversa || (typeof abrirConversa !== 'undefined' ? abrirConversa : null);
window._clearUnreadOnOpen = function(convId) {
    if (unreadCounts[convId]) {
        delete unreadCounts[convId];
        renderConversasList();
    }
};

// Hook into abrirConversa to clear unread (monkey-patch)
const _origOpen = abrirConversa;
window.abrirConversa = abrirConversa = async function(id) {
    window._clearUnreadOnOpen(id);
    return _origOpen(id);
};

// Notify about a new message in the CURRENT conversation
function notifyNewMessage(msg, conv) {
    if (!conv) return;
    if (document.hasFocus() && conversaAtual && conversaAtual.id === conv.id) return; // Already viewing, no need
    
    const authorName = msg.autor_nome || 'Alguém';
    const convName = conv.display_nome || conv.nome || 'Conversa';
    const preview = msg.conteudo ? msg.conteudo.substring(0, 60) : (msg.media_url ? '📎 Mídia' : 'Nova mensagem');
    
    // Toast
    showToast(`💬 ${authorName}: ${preview}`, 'info');
    
    // Sound
    playNotifSound();
    
    // Browser notification (if tab not focused)
    if (!document.hasFocus()) {
        sendBrowserNotification(authorName, preview, convName, conv.id);
    }
}

// Notify about a new message in ANOTHER conversation (from sync)
function notifyNewMessageFromConv(conv) {
    if (!conv) return;
    const convName = conv.display_nome || conv.nome || 'Conversa';
    const preview = conv.ultima_msg ? conv.ultima_msg.substring(0, 60) : 'Nova mensagem';
    
    // Toast
    showToast(`💬 ${convName}: ${preview}`, 'info');
    
    // Sound
    playNotifSound();
    
    // Browser notification
    if (!document.hasFocus()) {
        sendBrowserNotification(convName, preview, convName, conv.id);
    }
}

// Send native browser notification
function sendBrowserNotification(title, body, convName, convId) {
    if (!('Notification' in window)) return;
    if (Notification.permission !== 'granted') return;
    
    try {
        const notif = new Notification(`TocaChat — ${title}`, {
            body: body,
            icon: '/static/images/CeoB1UZHOtKIIrGi.jpg',
            badge: '/static/images/CeoB1UZHOtKIIrGi.jpg',
            tag: `toca-msg-${convId}`,
            renotify: true,
            silent: true
        });
        
        notif.onclick = () => {
            window.focus();
            if (typeof abrirConversa === 'function') abrirConversa(convId);
            notif.close();
        };
        
        // Auto-close after 5s
        setTimeout(() => notif.close(), 5000);
    } catch (e) {
        console.warn('[Notif] Browser notification failed:', e);
    }
}

// ══════════════════════════════════════════════
//  Wallpaper Placeholder Persistence
// ══════════════════════════════════════════════
//  Wallpaper Placeholder Persistence
// ══════════════════════════════════════════════
const WALLPAPER_STORAGE_KEY = 'chat_placeholder_wallpaper';
window.AVAILABLE_WALLPAPERS = [];

window.initPlaceholderWallpaper = async function() {
    try {
        // Refresh available list from server
        await window.fetchWallpapers();
        
        // Prioritize server-saved wallpaper if available
        const serverWall = (typeof currentUser !== 'undefined' && currentUser && currentUser.wallpaper_placeholder) 
                        ? currentUser.wallpaper_placeholder 
                        : null;
                        
        const saved = serverWall || localStorage.getItem(WALLPAPER_STORAGE_KEY);
        if (saved) {
            setPlaceholderWallpaper(saved, false);
            // Also apply to main area if no chat is open or as a fallback
            if (!conversaAtual) {
                applyActiveChatWallpaper(null);
            }
        }
    } catch (e) {
        console.error('[Wallpaper] Init failed:', e);
    }
};

window.fetchWallpapers = async function() {
    try {
        const walls = await api('/api/wallpapers');
        window.AVAILABLE_WALLPAPERS = Array.isArray(walls) ? walls : [];
    } catch (e) {
        console.error('[Wallpaper] Failed to fetch list:', e);
        if (!window.AVAILABLE_WALLPAPERS || window.AVAILABLE_WALLPAPERS.length === 0) {
            window.AVAILABLE_WALLPAPERS = [
                '/static/images/logo1.gif',
                '/static/images/logo2.gif',
                '/static/images/logo4.jpg',
                '/static/images/logo9.gif'
            ];
        }
    }
};

window.syncWallpaperToServer = async function(url) {
    if (typeof currentUser === 'undefined' || !currentUser) return;
    try {
        const updatedUser = await api('/api/perfil', {
            method: 'PUT',
            body: { wallpaper_placeholder: url }
        });
        if (updatedUser && updatedUser.wallpaper_placeholder !== undefined) {
             currentUser.wallpaper_placeholder = updatedUser.wallpaper_placeholder;
        }
    } catch (e) {
        console.error('[Wallpaper] Sync failed:', e);
    }
};

window.applyActiveChatWallpaper = function(url) {
    const main = document.getElementById('chatMain');
    if (!main) return;
    
    // If no specific conversation wallpaper, fallback to global placeholder wallpaper
    const finalUrl = url || (typeof currentUser !== 'undefined' && currentUser ? currentUser.wallpaper_placeholder : null) || localStorage.getItem(WALLPAPER_STORAGE_KEY);
    
    if (finalUrl) {
        main.style.setProperty('--active-chat-wallpaper', `url('${finalUrl}')`);
    } else {
        main.style.setProperty('--active-chat-wallpaper', 'none');
    }
};

window.setPlaceholderWallpaper = function(url, save = true) {
    const placeholder = document.querySelector('.chat-placeholder');
    if (!placeholder) {
        // If placeholder is not found, maybe it's not the right screen yet
        // but we should still save it to localStorage/server
        if (save) {
            localStorage.setItem(WALLPAPER_STORAGE_KEY, url);
            syncWallpaperToServer(url);
        }
        return;
    }
    
    if (url) {
        placeholder.style.backgroundImage = `url('${url}')`;
        if (save) {
            localStorage.setItem(WALLPAPER_STORAGE_KEY, url);
            syncWallpaperToServer(url);
            showToast('Wallpaper atualizado! 🎨', 'success');
            
            // If we are in an active chat without a specific wallpaper, update it too
            if (conversaAtual && !conversaAtual.wallpaper) {
                applyActiveChatWallpaper(url);
            }
        }
    } else {
        placeholder.style.backgroundImage = 'none';
        if (save) {
            localStorage.removeItem(WALLPAPER_STORAGE_KEY);
            syncWallpaperToServer('');
            showToast('Fundo removido', 'info');
        }
    }
};

window.abrirConfigWallpaper = async function() {
    showToast('Carregando galeria...', 'info');
    // Refresh list before opening
    await window.fetchWallpapers();
    
    const current = (typeof currentUser !== 'undefined' && currentUser && currentUser.wallpaper_placeholder) 
                   || localStorage.getItem(WALLPAPER_STORAGE_KEY);
    
    const gridHtml = `
        <div class="wallpaper-grid">
            <div class="wallpaper-item none-item ${!current ? 'active' : ''}" onclick="setPlaceholderWallpaper(''); closeModal();">
                <svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="lucide lucide-ban"><circle cx="12" cy="12" r="10"/><path d="m4.9 4.9 14.2 14.2"/></svg>
                <span>Nenhum</span>
            </div>
            
            <div class="wallpaper-item upload-item" onclick="document.getElementById('customWallInput').click()">
                <svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="lucide lucide-upload-cloud"><path d="M4 14.899A7 7 0 1 1 15.71 8h1.79a4.5 4.5 0 0 1 2.5 8.242"/><path d="M12 12V22"/><path d="m16 16-4-4-4 4"/></svg>
                <span>Subir seu Próprio</span>
                <input type="file" id="customWallInput" accept="image/*" style="display:none" onchange="window.handleCustomWallpaperUpload(this)">
            </div>

            ${window.AVAILABLE_WALLPAPERS.map(url => `
                <div class="wallpaper-item ${current === url ? 'active' : ''}" 
                     style="background-image: url('${url}')" 
                     onclick="setPlaceholderWallpaper('${url}'); closeModal();">
                </div>
            `).join('')}
        </div>
    `;
    
    openModal('Escolher Wallpaper', gridHtml, `
        <button class="btn btn-ghost" onclick="closeModal()" style="width:100%">Fechar</button>
    `);
};

window.handleCustomWallpaperUpload = async function(input) {
    const file = input.files[0];
    if (!file) return;
    
    showToast('Enviando wallpaper...', 'info');
    
    try {
        const form = new FormData();
        form.append('foto', file);
        form.append('tipo', 'wallpaper_placeholder');
        
        const res = await fetch('/api/upload-foto', {
            method: 'POST',
            credentials: 'same-origin',
            body: form
        });
        
        const data = await res.json();
        if (res.ok) {
            // Success! The background is set and synced
            setPlaceholderWallpaper(data.foto);
            closeModal();
            // Refresh list for others
            await fetchWallpapers();
        } else {
            showToast(data.erro || 'Erro no upload', 'error');
        }
    } catch (e) {
        showToast('Falha na conexão', 'error');
    }
};

// Auto-init and listener
document.addEventListener('DOMContentLoaded', () => {
    setTimeout(() => {
        const btn = document.getElementById('btnConfigWallpaper');
        if (btn) btn.addEventListener('click', abrirConfigWallpaper);
        
        const chatMessages = document.getElementById('chatMessages');
        if (chatMessages) {
            chatMessages.addEventListener('scroll', () => {
                if (chatMessages.scrollTop === 0) {
                    loadOlderMessages();
                }
            });
        }
        
        initPlaceholderWallpaper();
    }, 100);
});


// ══════════════════════════════════════════════
//  Internal Image Lightbox Logic
// ══════════════════════════════════════════════
let lightboxZoom = 1;
let lightboxPan = { x: 0, y: 0 };
let isDraggingLightbox = false;
let startDragPos = { x: 0, y: 0 };

window.abrirLightbox = function(url) {
    const overlay = document.getElementById('imageLightbox');
    const img = document.getElementById('lightboxImg');
    
    img.src = url;
    lightboxZoom = 1;
    lightboxPan = { x: 0, y: 0 };
    updateLightboxTransform();
    
    overlay.classList.remove('hidden');
    document.body.style.overflow = 'hidden'; // Stop scroll
};

window.fecharLightbox = function() {
    const overlay = document.getElementById('imageLightbox');
    overlay.classList.add('hidden');
    document.body.style.overflow = '';
};

function updateLightboxTransform() {
    const img = document.getElementById('lightboxImg');
    img.style.transform = `translate(${lightboxPan.x}px, ${lightboxPan.y}px) scale(${lightboxZoom})`;
}

// Event Listeners for Lightbox
document.addEventListener('DOMContentLoaded', () => {
    const overlay = document.getElementById('imageLightbox');
    const closeBtn = document.getElementById('btnCloseLightbox');
    const img = document.getElementById('lightboxImg');
    const content = document.getElementById('lightboxContent');
    
    if (!overlay) return;

    closeBtn.addEventListener('click', fecharLightbox);
    overlay.addEventListener('click', (e) => {
        if (e.target === overlay || e.target === content) fecharLightbox();
    });

    // Zoom Controls
    document.getElementById('btnZoomIn').onclick = () => { lightboxZoom += 0.2; updateLightboxTransform(); };
    document.getElementById('btnZoomOut').onclick = () => { if(lightboxZoom > 0.4) lightboxZoom -= 0.2; updateLightboxTransform(); };
    document.getElementById('btnResetZoom').onclick = () => { lightboxZoom = 1; lightboxPan = {x:0, y:0}; updateLightboxTransform(); };

    // Mouse Wheel Zoom
    overlay.addEventListener('wheel', (e) => {
        e.preventDefault();
        const delta = e.deltaY > 0 ? -0.1 : 0.1;
        const newZoom = lightboxZoom + delta;
        if (newZoom >= 0.2 && newZoom <= 5) {
            lightboxZoom = newZoom;
            updateLightboxTransform();
        }
    }, { passive: false });

    // Drag to Pan
    content.onmousedown = (e) => {
        isDraggingLightbox = true;
        startDragPos = { x: e.clientX - lightboxPan.x, y: e.clientY - lightboxPan.y };
        e.preventDefault();
    };

    window.addEventListener('mousemove', (e) => {
        if (!isDraggingLightbox || overlay.classList.contains('hidden')) return;
        lightboxPan.x = e.clientX - startDragPos.x;
        lightboxPan.y = e.clientY - startDragPos.y;
        updateLightboxTransform();
    });

    window.addEventListener('mouseup', () => {
        isDraggingLightbox = false;
    });

    // ESC to close
    window.addEventListener('keydown', (e) => {
        if (e.key === 'Escape' && !overlay.classList.contains('hidden')) {
            fecharLightbox();
        }
    });
});

function closeAllPanels() {
    const panels = ['gifPanel', 'emojiPanel', 'stickerPanel'];
    panels.forEach(id => {
        const el = document.getElementById(id);
        if (el) el.classList.add('hidden');
    });
}
