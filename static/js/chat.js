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
const MAX_RENDERED_MESSAGES = 50; // PERF FIX: limita DOM a 50 mensagens visíveis por conversa (virtual scroll simples)

// ── Helpers & Utilities (Global Scope) ──
const isEmojiOnly = (str) => {
    const testStr = (str || '').trim();
    if (!testStr) return false;
    const emojiRegex = /^[\u{1f300}-\u{1f5ff}\u{1f900}-\u{1f9ff}\u{1f600}-\u{1f64f}\u{1f680}-\u{1f6ff}\u{2600}-\u{26ff}\u{2700}-\u{27bf}\u{1f1e6}-\u{1f1ff}\u{1f191}-\u{1f251}\u{1f004}\u{1f0cf}\u{1f170}-\u{1f171}\u{1f17e}-\u{1f17f}\u{1f18e}\u{3030}\u{2b50}\u{2b55}\u{2934}-\u{2935}\u{2b05}-\u{2b07}\u{2b1b}-\u{2b1c}\u{3297}\u{3299}\u{303d}\u{00a9}\u{00ae}\u{2122}\u{23f3}\u{24c2}\u{23e9}-\u{23ef}\u{25b6}\u{23f8}-\u{23fa}\u{200d}\ufe0f]+$/gu;
    const match = testStr.match(emojiRegex);
    if(!match) return false;
    const emojiCount = Array.from(testStr).length;
    return emojiCount >= 1 && emojiCount <= 3;
};

window.applyWallpaper = function(url, isGlobal = true) {
    const bgVideo = document.getElementById('bgVideoWallpaper');
    const isVideo = url && (url.toLowerCase().endsWith('.mp4') || url.toLowerCase().endsWith('.webm'));

    if (isGlobal) {
        if (isVideo) {
            document.documentElement.style.setProperty('--active-chat-wallpaper', 'none');
            if (bgVideo) {
                bgVideo.src = url;
                bgVideo.classList.remove('hidden');
                bgVideo.classList.add('active');
                bgVideo.play().catch(e => console.warn('Autoplay video wallpaper blocked', e));
            }
        } else {
            document.documentElement.style.setProperty('--active-chat-wallpaper', url ? `url('${url}')` : 'none');
            if (bgVideo) {
                bgVideo.classList.add('hidden');
                bgVideo.classList.remove('active');
                bgVideo.pause();
                bgVideo.src = '';
            }
        }
    }
    return isVideo;
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
        
        
        const container = document.getElementById('chatMessages');
        const wasAtBottom = container.scrollHeight - container.scrollTop <= container.clientHeight + 100;
        if (wasAtBottom) container.scrollTop = container.scrollHeight;
        if (window.lucide) lucide.createIcons();
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
        // Trigger a light sync immediately to fetch the new pinned content
        performSync().then(() => {
            renderPinnedMessageBar();
        });
    }
});

socket.on('subtopic_reordered', (data) => {
    if (conversaAtual && data.conversa_id === conversaAtual.id) {
        loadSubtopicos();
    }
});

socket.on('global_wallpaper_updated', (data) => {
    if (data.url) {
        applyWallpaper(data.url, true);
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
            <div class="chat-item ${isActive ? 'active' : ''}" onclick="abrirConversa(${c.id})" onmouseenter="prefetchMensagens(${c.id})" ontouchstart="prefetchMensagens(${c.id})" ${c.wallpaper ? `style="--chat-wallpaper: url('${c.wallpaper}')"` : ''}>
                <div class="chat-item-avatar">
                    ${c.display_foto
                        ? `<img src="${c.display_foto}" alt="" loading="lazy" style="aspect-ratio:1/1;object-fit:cover">`
                        : (isGroup ? `<div class="participant-avatar-fallback"><i data-lucide="users"></i></div>` : `<video autoplay loop muted playsinline class="default-avatar-vid"><source src="/static/images/logo3.mp4" type="video/mp4"></video>`)}
                </div>
                <div class="chat-item-info">
                    <div class="chat-item-name">${c.display_nome}</div>
                    <div class="chat-item-preview">${preview}</div>
                </div>
                <div style="display: flex; align-items: center; gap: 0.25rem;">
                    ${unread > 0 ? `<span class="chat-unread-badge">${unread > 99 ? '99+' : unread}</span>` : ''}
                    ${c.ultima_msg_em ? `<span class="chat-item-time">${formatTime(c.ultima_msg_em)}</span>` : ''}
                    ${!isGroup ? `<button class="btn btn-sm btn-ghost" style="padding: 0.2rem; color: var(--danger)" onclick="event.stopPropagation(); excluirChat(${c.id}, '${c.display_nome.replace("'", "\\'")}')" title="Excluir conversa"><i data-lucide="trash-2"></i></button>` : ''}
                </div>
            </div>`;
    }).join('');
    if (window.lucide) lucide.createIcons();
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
    
    // Aplica o wallpaper da conversa (se houver) ou o global
    if (conv.wallpaper) {
        applyWallpaper(conv.wallpaper, true);
    } else {
        // Fallback: buscar o wallpaper global se a conversa não tiver um próprio
        api('/api/wallpaper-global').then(data => {
            if (data.active_wallpaper && conversaAtual && conversaAtual.id === conv.id) {
                applyWallpaper(data.active_wallpaper, true);
            }
        });
    }

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
        : (conv.tipo === 'grupo' ? `<div class="participant-avatar-fallback"><i data-lucide="users"></i></div>` : `<video autoplay loop muted playsinline class="default-avatar-vid"><source src="/static/images/logo3.mp4" type="video/mp4"></video>`);
    
    if (isDirect && otherUser) {
        avatarEl.style.cursor = 'pointer';
        avatarEl.onclick = () => abrirPerfil(otherUser.id);
    } else {
        avatarEl.style.cursor = 'default';
        avatarEl.onclick = null;
    }

    // Show call buttons (handlers are managed in call.js)
    document.getElementById('btnCallAudio').classList.remove('hidden');
    document.getElementById('btnCallVideo').classList.remove('hidden');

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
    
    await Promise.all(promises);
    if (window.lucide) lucide.createIcons();
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
        btnAudio.innerHTML = `<i data-lucide="phone"></i> Entrar${countText}`;
    } else {
        btnAudio.classList.remove('pulse-call-btn');
        btnAudio.innerHTML = `<i data-lucide="phone"></i>`;
    }
    if (window.lucide) lucide.createIcons();
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
                        : `<video autoplay loop muted playsinline class="default-avatar-vid"><source src="/static/images/logo3.mp4" type="video/mp4"></video>`}
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
    let html = `<button class="sub-tab ${subtopicAtual === null ? 'active' : ''}" onclick="selectSubtopic(null)" draggable="false"><i data-lucide="message-square" style="width:14px;height:14px"></i> Geral</button>`;
    
    subtopicos.forEach(s => {
        const isActive = subtopicAtual && subtopicAtual.id === s.id ? 'active' : '';
        // Add draggable="true" and data-id attributes for drag and drop
        html += `<button class="sub-tab draggable-subtopic ${isActive}" data-id="${s.id}" onclick="selectSubtopic(${s.id})" draggable="true" style="border-left:3px solid ${s.cor}">${s.nome}</button>`;
    });
    
    html += `<button class="sub-tab sub-tab-add" onclick="abrirCriarSubtopico()" draggable="false"><i data-lucide="plus"></i></button>`;
    container.innerHTML = html;
    
    if (window.lucide) lucide.createIcons();
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
            actions.innerHTML = `<button class="btn btn-sm btn-ghost" onclick="apagarMensagem(${msg.id})" title="Apagar mensagem"><i data-lucide="trash-2"></i></button>`;
            if (window.lucide) lucide.createIcons();
            return optimistic;
        }
    }

    const bubble = document.createElement('div');
    bubble.className = `msg-bubble ${isMine ? 'msg-mine' : 'msg-other'}`;
    if (msg.id) bubble.dataset.msgId = msg.id;
    if (isOptimistic) bubble.classList.add('msg-sending');

    const isSticker = msg.media_url && msg.media_url.includes('/stickers/');
    if (isSticker) bubble.classList.add('msg-sticker');

    let mediaHtml = '';
    if (msg.media_url) {
        const ext = msg.media_url.split('.').pop().toLowerCase();
        if (['mp4','webm','mov'].includes(ext)) {
            mediaHtml = `<video src="${msg.media_url}" controls class="msg-media" style="width:100%;max-height:300px;border-radius:8px;margin:0.25rem 0;aspect-ratio:16/9;object-fit:cover" preload="metadata"></video>`;
        } else {
            mediaHtml = `<img src="${msg.media_url}" class="msg-media" loading="lazy" style="${isSticker ? 'width:auto;max-width:180px;height:auto;aspect-ratio:auto;object-fit:contain;background:none' : 'width:100%;min-height:100px;max-height:300px;object-fit:cover'};border-radius:8px;margin:0.25rem 0;cursor:pointer" onclick="window.open('${msg.media_url}','_blank')">`;
        }
    }

    let replyHtml = '';
    if (msg.reply_to_id) {
        let replyText = msg.reply_content || '';
        if (!replyText && msg.reply_media) {
            const rExt = msg.reply_media.split('.').pop().toLowerCase();
            replyText = ['mp4','webm','mov'].includes(rExt) ? '🎬 Vídeo' : '🖼️ Mídia';
        }
        
        if (replyText || msg.reply_media) {
            replyHtml = `
                <div class="msg-reply-context" onclick="jumpToMessage(${msg.reply_to_id})">
                    <span class="reply-context-author">${msg.reply_author || 'Usuário'}</span>
                    <div class="reply-context-text">${escapeHtml(replyText)}</div>
                </div>
            `;
        }
    }

    const authorName = (msg.autor_nome || 'Usuário').replace(/'/g, "\\'");
    const contentPreview = (msg.conteudo || '').replace(/'/g, "\\'").replace(/\n/g, " ");

    bubble.innerHTML = `
        <div class="msg-actions">
            ${msg.id ? `
                <button class="btn btn-sm btn-ghost" onclick="setReplyMode(${msg.id}, '${authorName}', '${contentPreview}')" title="Responder"><i data-lucide="reply"></i></button>
                <button class="btn btn-sm btn-ghost" onclick="fixarMensagem(${msg.id})" title="Fixar"><i data-lucide="pin"></i></button>
                ${isMine ? `<button class="btn btn-sm btn-ghost" onclick="apagarMensagem(${msg.id})" title="Apagar mensagem"><i data-lucide="trash-2"></i></button>` : ''}
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

async function loadMensagens() {
    if (!conversaAtual) return;
    try {
        let endpoint = `/api/conversas/${conversaAtual.id}/mensagens`;
        const params = [];
        if (lastMsgId) params.push(`after_id=${lastMsgId}`);
        if (subtopicAtual) params.push(`subtopico_id=${subtopicAtual.id}`);
        if (params.length) endpoint += '?' + params.join('&');

        const msgs = await api(endpoint);
        const container = document.getElementById('chatMessages');
        const convId = conversaAtual.id;
        const cacheEntry = getMessageCacheEntry(convId);

        if (!lastMsgId) {
            container.innerHTML = '';
            if (msgs.length === 0) {
                const label = subtopicAtual ? `"${subtopicAtual.nome}"` : 'esta conversa';
                container.innerHTML = `<p class="empty-state" style="padding:2rem">Nenhuma mensagem em ${label}. Diga oi! 👋</p>`;
            }
            // Reset cache on first page load
            cacheEntry.messages = [];
        }

        if (msgs.length > 0 && container.querySelector('.empty-state')) {
            container.innerHTML = '';
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
                    cacheEntry.messages.push(msg);
                }
                lastMsgId = msg.id;
            });

            cacheEntry.lastMsgId = lastMsgId;
            cacheEntry.lastFetchedAt = Date.now();
            messageCache[convId] = cacheEntry;

            container.appendChild(fragment);
            if (window.lucide) lucide.createIcons();
            container.scrollTop = container.scrollHeight;
            trimMessageDom(container);
        }
    } catch (err) {
        console.error('Messages error:', err);
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
                    <button class="btn btn-sm btn-ghost" onclick="setReplyMode(${res.id}, '${currentUserEscaped}', '${conteudoEscaped}')" title="Responder">↩️</button>
                    <button class="btn btn-sm btn-ghost" onclick="apagarMensagem(${res.id})" title="Apagar mensagem">🗑️</button>
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
    
    // Modern grid with smooth transitions and larger emojis
    container.style.display = 'grid';
    container.style.gridTemplateColumns = 'repeat(auto-fill, minmax(40px, 1fr))';
    container.style.gap = '8px';
    container.style.padding = '12px';
    
    container.innerHTML = commonEmojis.map(emojiChar => {
        return `
            <div class="emoji-item" onclick="selectEmoji('${emojiChar}')" 
                 style="cursor: pointer; height: 40px; border-radius: 10px; transition: all 0.2s cubic-bezier(0.4, 0, 0.2, 1); display: flex; align-items: center; justify-content: center; font-size: 1.4rem; user-select: none;"
                 onmouseenter="this.style.background='var(--primary-light)'; this.style.transform='scale(1.15)';" 
                 onmouseleave="this.style.background='transparent'; this.style.transform='scale(1)';">
                ${emojiChar}
            </div>
        `;
    }).join('');
}
window.renderEmojiPicker = renderEmojiPicker;
window.selectEmoji = selectEmoji;

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
window.selectGif = selectGif;

function selectGif(url) {
    document.getElementById('gifPanel').classList.add('hidden');
    pendingMedia.push({ url, name: 'GIF', isVideo: false, uploading: false });
    enviarMensagem();
}

// ══════════════════════════════════════════════
//  Stickers Integration
// ══════════════════════════════════════════════
document.getElementById('btnStickerChat')?.addEventListener('click', () => {
    const panel = document.getElementById('stickerPanel');
    const gifPanel = document.getElementById('gifPanel');
    const emojiPanel = document.getElementById('emojiPanel');
    
    if (!gifPanel.classList.contains('hidden')) gifPanel.classList.add('hidden');
    if (!emojiPanel.classList.contains('hidden')) emojiPanel.classList.add('hidden');
    
    panel.classList.toggle('hidden');
    if (!panel.classList.contains('hidden')) {
        loadStickers();
    }
});

async function loadStickers() {
    const container = document.getElementById('stickerResults');
    if (!container) return;
    container.innerHTML = '<div style="grid-column:1/-1;text-align:center;padding:1rem;color:var(--text-muted)">Carregando...</div>';
    
    try {
        const stickers = await api('/api/stickers');
        if (stickers.length === 0) {
            container.innerHTML = '<div style="grid-column:1/-1;text-align:center;padding:1rem;color:var(--text-muted)">Nenhuma figurinha disponível</div>';
            return;
        }
        
        container.innerHTML = stickers.map(url => `
            <div class="sticker-item" onclick="selectSticker('${url}')" style="cursor:pointer;padding:0.25rem;border-radius:var(--radius-sm);transition:all 0.2s">
                <img src="${url}" style="width:100%;height:auto;display:block" loading="lazy">
            </div>
        `).join('');
    } catch (err) {
        container.innerHTML = '<div style="grid-column:1/-1;text-align:center;padding:1rem;color:var(--danger)">Erro ao carregar figurinhas</div>';
    }
}

async function importarStickerDesdeArquivo(input) {
    const file = input.files[0];
    if (!file) return;
    
    // Mostramos feedback visual
    showToast('Processando figurinha...', 'info');
    
    const formData = new FormData();
    formData.append('sticker', file);
    
    try {
        const data = await api('/api/upload-sticker', {
            method: 'POST',
            body: formData
        });
        
        showToast('Figurinha adicionada! ✨', 'success');
        loadStickers(); // Recarrega a lista
    } catch (err) {
        console.error('Erro ao importar figurinha:', err);
        showToast('Erro de conexão ao subir figurinha', 'error');
    } finally {
        input.value = ''; // Reseta o input
    }
}
window.importarStickerDesdeArquivo = importarStickerDesdeArquivo;

function selectSticker(url) {
    document.getElementById('stickerPanel').classList.add('hidden');
    pendingMedia.push({ url, name: 'Sticker', isVideo: false, uploading: false });
    enviarMensagem();
}
window.selectSticker = selectSticker;

document.getElementById('btnConfigWallpaper')?.addEventListener('click', async () => {
    try {
        const data = await api('/api/wallpaper-global');
        const activeUrl = data.active_wallpaper;
        const available = data.available || [];

        openModal('Papéis de Parede Shared', `
            <div class="wallpaper-manager">
                <!-- Zona de Upload Moderna -->
                <div class="upload-zone" id="wallpaperUploadZone" onclick="document.getElementById('inputUploadWallpaper').click()">
                    <div class="upload-zone-content">
                        <div class="upload-zone-icon">
                            <i data-lucide="upload-cloud"></i>
                        </div>
                        <h3>Upload Novo Wallpaper</h3>
                        <p style="color: var(--text-muted); font-size: 0.9rem;">Arraste e solte ou clique para selecionar</p>
                        <input type="file" id="inputUploadWallpaper" accept="image/*,video/mp4,video/webm" style="display: none">
                    </div>
                </div>

                <div class="form-group">
                    <label class="form-label" style="display: flex; justify-content: space-between; align-items: center">
                        Wallpapers Disponíveis
                        <span style="font-size: 0.8rem; opacity: 0.6;">${available.length} itens</span>
                    </label>
                    <div class="wallpaper-grid-modern" id="globalWallpaperGrid">
                        ${available.map(url => {
                            const isVid = url.toLowerCase().endsWith('.mp4') || url.toLowerCase().endsWith('.webm');
                            return `
                            <div class="wallpaper-card ${url === activeUrl ? 'active' : ''} ${isVid ? 'is-video' : ''}" 
                                 onclick="window.setGlobalWallpaper('${url}')">
                                ${isVid 
                                    ? `<video src="${url}" muted loop playsinline onmouseenter="this.play()" onmouseleave="this.pause(); this.currentTime=0"></video>` 
                                    : `<img src="${url}" alt="Wallpaper" loading="lazy">`
                                }
                                <div class="wallpaper-card-overlay"></div>
                            </div>`;
                        }).join('')}
                    </div>
                </div>
            </div>
        `, `<button class="btn btn-ghost" onclick="closeModal()">Fechar</button>`);

        if (window.lucide) lucide.createIcons();
        setupWallpaperUploadHandlers();

    } catch (err) {
        console.error('Falha ao abrir seletor de wallpaper', err);
    }
});

// Listener para o botão de wallpaper no HEADER da conversa
document.getElementById('btnChatWallpaper')?.addEventListener('click', () => {
    if (!conversaAtual) return;
    initWallpaperLibrary(async (url) => {
        try {
            // Se for grupo, usa o endpoint de editar grupo. Se for direto, precisamos de uma forma de salvar.
            // O endpoint /api/conversas/<id> (PUT) serve para ambos.
            await api(`/api/conversas/${conversaAtual.id}`, {
                method: 'PUT',
                body: { 
                    nome: conversaAtual.nome, 
                    descricao: conversaAtual.descricao, 
                    wallpaper: url 
                }
            });
            conversaAtual.wallpaper = url;
            applyWallpaper(url, true);
            showToast('Papel de parede da conversa atualizado! ✨', 'success');
            loadConversas(); // Atualiza o mini-wallpaper no sidebar
        } catch (err) {
            showToast('Erro ao salvar papel de parede', 'error');
        }
    });
});

function setupWallpaperUploadHandlers() {
    const zone = document.getElementById('wallpaperUploadZone');
    const input = document.getElementById('inputUploadWallpaper');

    if (!zone || !input) return;

    ['dragenter', 'dragover', 'dragleave', 'drop'].forEach(evt => {
        zone.addEventListener(evt, (e) => {
            e.preventDefault();
            e.stopPropagation();
        });
    });

    ['dragenter', 'dragover'].forEach(evt => {
        zone.addEventListener(evt, () => zone.classList.add('dragover'));
    });

    ['dragleave', 'drop'].forEach(evt => {
        zone.addEventListener(evt, () => zone.classList.remove('dragover'));
    });

    zone.addEventListener('drop', (e) => {
        const files = e.dataTransfer.files;
        if (files.length) {
            input.files = files;
            window.uploadGlobalWallpaper();
        }
    });

    input.addEventListener('change', () => {
        if (input.files.length) {
            window.uploadGlobalWallpaper();
        }
    });
}

window.uploadGlobalWallpaper = async function() {
    const input = document.getElementById('inputUploadWallpaper');
    if (!input.files || !input.files[0]) {
        showToast('Selecione uma imagem', 'warning');
        return;
    }
    
    const file = input.files[0];
    const formData = new FormData();
    formData.append('wallpaper', file);
    
    try {
        showToast('Subindo wallpaper...', 'info');
        const res = await api('/api/upload-wallpaper-global', {
            method: 'POST',
            body: formData
        });
        showToast('Wallpaper atualizado para todos! 🌟', 'success');
        closeModal();
        if (res.url) {
            applyWallpaper(res.url, true);
        }
    } catch (err) {
        showToast('Erro ao subir wallpaper', 'error');
    }
};

window.setGlobalWallpaper = async function(url) {
    try {
        await api('/api/set-wallpaper-global', {
            method: 'POST',
            body: { url }
        });
        showToast('Wallpaper global alterado! ✨', 'success');
        applyWallpaper(url, true);
        closeModal();
    } catch (err) {
        showToast('Erro ao definir wallpaper', 'error');
    }
};

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

            if (conversaAtual) {
                const refreshed = conversas.find(c => c.id === conversaAtual.id);
                if (refreshed) {
                    conversaAtual = refreshed;
                    window.conversaAtual = conversaAtual;
                    renderPinnedMessageBar();
                }
            }
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
document.getElementById('btnNovoChatDireto')?.addEventListener('click', async () => {
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
});

async function criarChatDireto(userId) {
    try {
        const res = await api('/api/conversas/direto', { method:'POST', body:{ usuario_id: userId }});
        closeModal(); await loadConversas(); abrirConversa(res.id);
    } catch(err) { showToast('Erro ao criar conversa','error'); }
}

// ── New Group ──
document.getElementById('btnNovoGrupo')?.addEventListener('click', async () => {
    try {
        const usuarios = await api('/api/usuarios');
        const others = usuarios.filter(u => u.id !== currentUser.id);
        
        const cards = others.map(u => `
            <div class="selection-card" onclick="toggleSelectionCard(this)" data-user-name="${u.nome.toLowerCase()}" data-user-username="${u.username?.toLowerCase() || ''}">
                <input type="checkbox" value="${u.id}" class="grupo-membro-check">
                <div class="card-avatar">
                    ${u.foto ? `<img src="${u.foto}" alt="">` : `<span>${u.nome.charAt(0).toUpperCase()}</span>`}
                </div>
                <div class="card-info">
                    <span class="card-name">${u.nome}</span>
                    <span class="card-username">@${u.username || 'user'}</span>
                </div>
            </div>`).join('');

        openModal('Novo Grupo', `
            <div class="member-selection-container">
                <div class="form-group">
                    <label class="form-label">Nome do Grupo</label>
                    <input type="text" class="input" id="grupoNome" placeholder="Ex: Grupo de Estudos">
                </div>
                <div class="form-group">
                    <label class="form-label">Membros</label>
                    <div class="member-search-container">
                        <input type="text" class="input" placeholder="🔍 Buscar membros..." 
                               onkeyup="filterGroupMembers(this.value)">
                    </div>
                </div>
                <div class="member-selection-grid" id="memberSelectionGrid">
                    ${cards || '<p class="empty-state">Nenhum outro usuário disponível</p>'}
                </div>
            </div>
        `, `<button class="btn btn-ghost" onclick="closeModal()">Cancelar</button><button class="btn btn-primary" onclick="criarGrupo()">Criar Grupo</button>`);
    } catch(err) { 
        console.error(err);
        showToast('Erro ao carregar usuários','error'); 
    }
});

window.toggleSelectionCard = function(el) {
    const cb = el.querySelector('.grupo-membro-check');
    cb.checked = !cb.checked;
    el.classList.toggle('selected', cb.checked);
};

window.filterGroupMembers = function(query) {
    const q = query.toLowerCase();
    const cards = document.querySelectorAll('.selection-card');
    cards.forEach(card => {
        const name = card.getAttribute('data-user-name');
        const username = card.getAttribute('data-user-username');
        if (name.includes(q) || username.includes(q)) {
            card.style.display = 'flex';
        } else {
            card.style.display = 'none';
        }
    });
};

async function criarGrupo() {
    const nome = document.getElementById('grupoNome').value.trim();
    if (!nome) { showToast('Dê um nome ao grupo','error'); return; }
    const membros = Array.from(document.querySelectorAll('.grupo-membro-check:checked')).map(cb => parseInt(cb.value));
    try {
        const res = await api('/api/conversas/grupo', { method:'POST', body:{nome,membros}});
        closeModal(); showToast('Grupo criado! 👥','success'); await loadConversas(); abrirConversa(res.id);
    } catch(err) { showToast('Erro ao criar grupo','error'); }
}

// ── Edit Group ──
document.getElementById('btnEditGrupo')?.addEventListener('click', async () => {
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
            <button class="btn btn-sm btn-ghost" onclick="editarSubtopico(${s.id})" style="padding:0.2rem 0.4rem">✏️</button>
        </div>`).join('');

    openModal('Editar Grupo', `
        <div style="text-align:center;margin-bottom:1.5rem">
            <div class="profile-avatar-lg" id="grupoAvatarEdit" style="margin: 0 auto 1rem;">
                ${conversaAtual.foto ? `<img src="${conversaAtual.foto}" alt="">` : `<span>👥</span>`}
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
                        🖼️ Imagem/GIF
                        <input type="file" id="grupoWallInput" accept="image/jpeg,image/png,image/webp,image/gif" style="display:none">
                    </label>
                    <button class="btn btn-sm btn-secondary" id="btnGrupoWallGif" style="flex: 1; justify-content: center;">🎬 Buscar GIF</button>
                    ${conversaAtual.wallpaper ? `<button class="btn btn-sm btn-ghost" onclick="removerGrupoWall()" style="color:var(--danger)">🗑️</button>` : ''}
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
        <div class="form-group" style="padding: 1rem; background: rgba(255,255,255,0.02); border-radius: var(--radius-md); border: 1px solid rgba(255,255,255,0.05);">
            <label class="form-label">Adicionar Novo Membro</label>
            <div style="display:flex; gap:0.5rem">
                <select class="input" id="newMemberSelect" style="flex:1">
                    <option value="">Selecione um usuário...</option>
                    ${availableUsers.map(u => `<option value="${u.id}">${u.nome} (@${u.username})</option>`).join('')}
                </select>
                <button class="btn btn-primary" onclick="window._adicionarMembroGrupo()">Adicionar</button>
            </div>
        </div>
        ` : ''}

        <div class="form-group"><label class="form-label">Subtópicos (${subtopicos.length})</label>
            <div style="display:flex;flex-direction:column;gap:0.4rem">${subsList||'<p style="font-size:0.85rem;color:var(--text-muted)">Nenhum subtópico</p>'}</div>
            <button class="btn btn-sm btn-secondary" onclick="closeModal();abrirCriarSubtopico();" style="margin-top:0.5rem">+ Novo Subtópico</button>
        </div>
        
        <div style="margin-top:2rem; padding-top:1rem; border-top:1px solid rgba(255,255,255,0.1); text-align:center;">
            <button class="btn btn-ghost" style="color:var(--danger)" onclick="excluirGrupoInteiro()">🗑️ Excluir Grupo</button>
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
          // Handler para a biblioteca shared no grupo
        document.getElementById('btnGrupoWallLibrary')?.addEventListener('click', () => {
            initWallpaperLibrary((url) => {
                const preview = document.getElementById('grupoWallPreview');
                if (preview) {
                    preview.innerHTML = `<img src="${url}" style="width: 100%; height: 100%; object-fit: cover;">`;
                }
                // Guardamos temporariamente no window ou em algum lugar para o salvarGrupo ler
                window._pendingGroupWallpaper = url;
                showToast('Wallpaper selecionado da biblioteca! 🎨', 'info');
            });
        });
    }, 100);
});

window._adicionarMembroGrupo = async function() {
    if (!conversaAtual) return;
    const select = document.getElementById('newMemberSelect');
    const userId = select.value;
    if (!userId) {
        showToast('Selecione um usuário', 'error');
        return;
    }
    try {
        await api(`/api/conversas/${conversaAtual.id}/membros`, {
            method: 'POST',
            body: { usuario_id: userId }
        });
        showToast('Membro adicionado!', 'success');
        closeModal();
        await loadConversas();
        // Re-open chat to refresh sidebar UI
        abrirConversa(conversaAtual.id);
    } catch(err) {
        showToast('Erro ao adicionar membro', 'error');
    }
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
    document.getElementById('grupoWallPreview').innerHTML = `<img src="${url}" style="width:100%; height:100%; object-fit:cover;">`;
    renderConversasList();
    showToast('Plano de fundo atualizado! 🏞️','success');
}

function removerGrupoWall() {
    if (!conversaAtual) return;
    conversaAtual.wallpaper = '';
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
    showToast('Foto do grupo atualizada! 🎉','success');
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
            renderPinnedMessageBar();
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
        renderPinnedMessageBar();
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
document.getElementById('btnBackChat')?.addEventListener('click', () => {
    conversaAtual = null;
    window.conversaAtual = null;
    document.querySelector('.chat-placeholder').classList.remove('hidden');
    document.getElementById('chatHeader').classList.add('hidden');
    document.getElementById('chatMessages').classList.add('hidden');
    document.getElementById('chatInputArea').classList.add('hidden');
    document.getElementById('subtopicsBar').classList.add('hidden');
    document.getElementById('chatParticipants').classList.add('hidden');
    document.querySelector('.chat-layout').classList.add('no-participants');
    renderPinnedMessageBar();
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
                        ${user.foto ? `<img src="${user.foto}" alt="${user.nome}">` : `<video autoplay loop muted playsinline class="default-avatar-vid"><source src="/static/images/logo3.mp4" type="video/mp4"></video>`}
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
        showToast('Mensagem fixada! 📌', 'success');
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
    if (!bar) return;

    if (!conversaAtual) {
        bar.classList.add('hidden');
        return;
    }

    if (conversaAtual.pinned_message_id) {
        document.getElementById('pinnedMessageAuthor').textContent = conversaAtual.pinned_author || 'Usuário';
        
        const textEl = document.getElementById('pinnedMessageText');
        const mediaUrl = conversaAtual.pinned_media_url;
        let content = conversaAtual.pinned_content || '';
        
        if (mediaUrl) {
            const isVideo = mediaUrl.match(/\.(mp4|webm|mov)$/i);
            const isGif = mediaUrl.match(/\.gif$/i);
            const label = isVideo ? '🎥 Vídeo' : (isGif ? '🖼️ GIF' : '📷 Foto');
            
            if (!content || content === '...') {
                content = label;
            } else {
                content = `${label} • ${content}`;
            }
        } else if (!content) {
            content = '...';
        }

        textEl.textContent = content;
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

// --- Lixeira ---
const btnLixeira = document.getElementById('btnLixeira');
if (btnLixeira) {
    btnLixeira.addEventListener('click', () => {
        if (!conversaAtual) return;
        openModal('Mensagens Excluídas', '<div id="lixeiraList" class="lixeira-list"></div>', '');
        loadLixeira();
    });
}

async function loadLixeira() {
    const list = document.getElementById('lixeiraList');
    list.innerHTML = '<p style="padding: 20px; text-align: center; color: var(--text-muted);">Carregando...</p>';

    try {
        const res = await fetch(`/api/conversas/${conversaAtual.id}/lixeira`);
        const msgs = await res.json();

        if (msgs.length === 0) {
            list.innerHTML = '<p style="padding: 20px; text-align: center; color: var(--text-muted);">Nenhuma mensagem excluída para restaurar.</p>';
            return;
        }

        list.innerHTML = '';
        msgs.forEach(msg => {
            const item = document.createElement('div');
            item.className = 'lixeira-item';
            
            const time = new Date(msg.excluido_em).toLocaleString('pt-BR');
            const content = msg.conteudo || (msg.media_url ? '[Mídia]' : '[Sem conteúdo]');

            item.innerHTML = `
                <div class="lixeira-content">
                    <div class="lixeira-text" title="${content}">${content}</div>
                    <div class="lixeira-meta">Excluída em: ${time}</div>
                </div>
                <button class="btn-restaurar" onclick="restaurarMensagem(${msg.id})">Restaurar</button>
            `;
            list.appendChild(item);
        });
    } catch (err) {
        console.error('Erro ao carregar lixeira:', err);
        list.innerHTML = '<p style="padding: 20px; text-align: center; color: var(--danger-color);">Erro ao carregar lixeira.</p>';
    }
}

async function restaurarMensagem(msgId) {
    if (!confirm('Deseja restaurar esta mensagem?')) return;

    try {
        const res = await fetch(`/api/conversas/mensagens/${msgId}/restaurar`, {
            method: 'POST'
        });
        const data = await res.json();

        if (res.ok) {
            alert('Mensagem restaurada com sucesso!');
            loadLixeira();
            // A mensagem aparecerá no chat via SocketIO (new_message)
        } else {
            alert('Erro: ' + (data.erro || 'Erro desconhecido'));
        }
    } catch (err) {
        alert('Erro ao restaurar mensagem');
        console.error(err);
    }
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
// Wallpaper system already handled at the top of the file

/**
 * Abre a Biblioteca de Wallpapers Shared e executa callback ao selecionar
 */
window.initWallpaperLibrary = async function(onSelect) {
    try {
        const data = await api('/api/wallpaper-global');
        const activeUrl = data.active_wallpaper;
        const available = data.available || [];

        openModal('Biblioteca de Wallpapers', `
            <div class="wallpaper-manager">
                <div class="form-group">
                    <label class="form-label" style="display: flex; justify-content: space-between; align-items: center">
                        Escolha um Fundo Premium
                        <span style="font-size: 0.8rem; opacity: 0.6;">${available.length} itens</span>
                    </label>
                    <div class="wallpaper-grid-modern" id="libraryWallpaperGrid">
                        ${available.map(url => {
                            const isVid = url.toLowerCase().endsWith('.mp4') || url.toLowerCase().endsWith('.webm');
                            return `
                            <div class="wallpaper-card ${url === activeUrl ? 'active' : ''} ${isVid ? 'is-video' : ''}" 
                                 onclick="window._selectFromLibrary('${url}')">
                                ${isVid 
                                    ? `<video src="${url}" muted loop playsinline onmouseenter="this.play()" onmouseleave="this.pause(); this.currentTime=0"></video>` 
                                    : `<img src="${url}" alt="Wallpaper" loading="lazy">`
                                }
                                <div class="wallpaper-card-overlay"></div>
                            </div>`;
                        }).join('')}
                    </div>
                </div>
                <p style="font-size: 0.8rem; color: var(--text-muted); text-align: center">Os itens acima são compartilhados por toda a comunidade. 🌟</p>
            </div>
        `, `<button class="btn btn-ghost" onclick="closeModal()">Fechar</button>`);

        window._selectFromLibrary = (url) => {
            if (onSelect) onSelect(url);
            closeModal();
        };

    } catch (err) {
        showToast('Erro ao carregar biblioteca', 'error');
    }
};

async function initGlobalWallpaper() {
    try {
        const data = await api('/api/wallpaper-global');
        if (data.active_wallpaper) {
            applyWallpaper(data.active_wallpaper, true);
        }
    } catch (err) {
        console.warn('Falha ao inicializar wallpaper global', err);
    }
}

// Inicializa o wallpaper global ao carregar o script
initGlobalWallpaper();
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

console.log('✅ Chat.js carregado com sucesso.');
