/* ═══════════════════════════════════════════════
   Auth Module (Login, Registro, Perfil)
   ═══════════════════════════════════════════════ */

// ── Toggle Login/Register ──
document.getElementById('showRegister').addEventListener('click', (e) => {
    e.preventDefault();
    document.getElementById('loginForm').classList.add('hidden');
    document.getElementById('registerForm').classList.remove('hidden');
    document.getElementById('authError').classList.add('hidden');
});

document.getElementById('showLogin').addEventListener('click', (e) => {
    e.preventDefault();
    document.getElementById('registerForm').classList.add('hidden');
    document.getElementById('loginForm').classList.remove('hidden');
    document.getElementById('authError').classList.add('hidden');
});

// ── Login ──
document.getElementById('loginForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    const errEl = document.getElementById('authError');
    errEl.classList.add('hidden');

    const login = document.getElementById('loginUser').value.trim();
    const senha = document.getElementById('loginSenha').value;

    if (!login || !senha) {
        errEl.textContent = 'Preencha todos os campos';
        errEl.classList.remove('hidden');
        return;
    }

    try {
        const user = await fetch('/api/login', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            credentials: 'same-origin',
            body: JSON.stringify({ login, senha })
        });
        const data = await user.json();

        if (!user.ok) {
            errEl.textContent = data.erro || 'Erro ao fazer login';
            errEl.classList.remove('hidden');
            return;
        }

        showApp(data);
        showToast(`Bem-vindo, ${data.nome}! 🦉`, 'success');
    } catch (err) {
        errEl.textContent = 'Erro de conexão com o servidor';
        errEl.classList.remove('hidden');
    }
});

// ── Registro ──
document.getElementById('registerForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    const errEl = document.getElementById('authError');
    errEl.classList.add('hidden');

    const username = document.getElementById('regUsername').value.trim();
    const senha = document.getElementById('regSenha').value;

    if (!username || !senha) {
        errEl.textContent = 'Preencha todos os campos';
        errEl.classList.remove('hidden');
        return;
    }

    try {
        const res = await fetch('/api/registro', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            credentials: 'same-origin',
            body: JSON.stringify({ username, senha })
        });
        const data = await res.json();

        if (!res.ok) {
            errEl.textContent = data.erro || 'Erro ao criar conta';
            errEl.classList.remove('hidden');
            return;
        }

        showApp(data);
        showToast(`Conta criada! Bem-vindo, ${data.nome}! 🎉`, 'success');
    } catch (err) {
        errEl.textContent = 'Erro de conexão com o servidor';
        errEl.classList.remove('hidden');
    }
});

// ── Editar Perfil ──
document.getElementById('btnEditProfile').addEventListener('click', (e) => {
    e.preventDefault();
    if (!currentUser) return;

    openModal('Editar Perfil', `
        <div style="text-align:center;margin-bottom:1.5rem">
            <div class="profile-wallpaper-container">
                <img src="${currentUser.wallpaper || ''}" class="profile-wallpaper-img" id="modalWallpaper" onerror="this.style.display='none'" onload="this.style.display='block'">
                <div class="profile-avatar-lg" id="modalAvatar">
                    ${getAvatarHtml(currentUser.id, currentUser.nome, currentUser.foto)}
                </div>
            </div>
            
            <div class="profile-settings-modern">
                <!-- Avatar Section -->
                <div class="setting-row-modern">
                    <div class="setting-icon-box">
                        <svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="lucide lucide-camera"><path d="M14.5 4h-5L7 7H4a2 2 0 0 0-2 2v9a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2V9a2 2 0 0 0-2-2h-3l-2.5-3z"/><circle cx="12" cy="13" r="3"/></svg>
                    </div>
                    <div class="setting-content-box">
                        <h4>Foto de Perfil</h4>
                        <div class="setting-actions-modern">
                            <label class="btn btn-sm btn-secondary" style="cursor:pointer" title="Subir arquivo do computador">
                                📁 Arquivo
                                <input type="file" id="fotoInput" accept="image/jpeg,image/png,image/webp,image/gif" style="display:none">
                            </label>
                            <button class="btn btn-sm btn-secondary" id="btnPerfilGif" title="Procurar GIF">🎬 Buscar GIF</button>
                        </div>
                    </div>
                </div>

                <!-- Wallpaper Section -->
                <div class="setting-row-modern">
                    <div class="setting-icon-box">
                        <svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="lucide lucide-image"><rect width="18" height="18" x="3" y="3" rx="2" ry="2"/><circle cx="9" cy="9" r="2"/><path d="m21 15-3.086-3.086a2 2 0 0 0-2.828 0L6 21"/></svg>
                    </div>
                    <div class="setting-content-box">
                        <h4>Fundo do Perfil</h4>
                        <div class="setting-actions-modern">
                            <label class="btn btn-sm btn-secondary" style="cursor:pointer" title="Subir fundo do computador">
                                📁 Arquivo
                                <input type="file" id="wallpaperInput" accept="image/jpeg,image/png,image/webp,image/gif" style="display:none">
                            </label>
                            <button class="btn btn-sm btn-secondary" id="btnWallpaperGif" title="Procurar GIF de fundo">🎬 Buscar GIF</button>
                        </div>
                    </div>
                </div>
            </div>
            
            <div id="profileGifPanel" class="hidden" style="margin-top: 1rem; text-align: left; background: var(--bg-surface); padding: 10px; border-radius: var(--radius-md); border: 1px solid rgba(255,255,255,0.05);">
                <input type="text" class="input" id="profileGifSearch" placeholder="Pesquisar Tenor GIF..." autocomplete="off" style="margin-bottom: 0.5rem">
                <div id="profileGifResults" style="display: grid; grid-template-columns: repeat(3, 1fr); gap: 0.25rem; max-height: 200px; overflow-y: auto;">
                </div>
            </div>
        </div>
        
        <div class="form-group">
            <label class="form-label">Nome</label>
            <input type="text" class="input" id="editNome" value="${currentUser.nome}">
        </div>
        <div class="form-group">
            <label class="form-label">Bio</label>
            <textarea class="textarea" id="editBio" style="min-height:60px" placeholder="Conte algo sobre você...">${currentUser.bio || ''}</textarea>
        </div>
        <p style="font-size:0.8rem;color:var(--text-muted)">@${currentUser.username}</p>
    `, `
        <button class="btn btn-ghost" onclick="closeModal()">Cancelar</button>
        <button class="btn btn-primary" onclick="salvarPerfil()">Salvar</button>
    `);

    let currentGifRenderer = renderProfileGifs;
    
    setTimeout(() => {
        // 1) File Upload (Avatar)
        const input = document.getElementById('fotoInput');
        if (input) {
            input.addEventListener('change', async () => {
                let file = input.files[0];
                if (!file) return;
                // Compress avatar: 256x256, quality 80%
                file = await compressImage(file, 256, 256, 0.8);
                const form = new FormData();
                form.append('foto', file);
                form.append('tipo', 'avatar');
                try {
                    const res = await fetch('/api/upload-foto', {
                        method: 'POST', credentials: 'same-origin', body: form
                    });
                    const data = await res.json();
                    if (res.ok) {
                        setAvatarPreview(data.foto);
                        showToast('Foto atualizada! 📷', 'success');
                    }
                } catch (err) {
                    showToast('Erro ao enviar foto', 'error');
                }
            });
        }

        // 1b) File Upload (Wallpaper)
        const wallInput = document.getElementById('wallpaperInput');
        if (wallInput) {
            wallInput.addEventListener('change', async () => {
                let file = wallInput.files[0];
                if (!file) return;
                // Compress wallpaper: 1280px max, quality 75%
                file = await compressImage(file, 1280, 1280, 0.75);
                const form = new FormData();
                form.append('foto', file);
                form.append('tipo', 'wallpaper');
                try {
                    const res = await fetch('/api/upload-foto', {
                        method: 'POST', credentials: 'same-origin', body: form
                    });
                    const data = await res.json();
                    if (res.ok) {
                        setWallpaperPreview(data.foto);
                        showToast('Wallpaper atualizado! 🌆', 'success');
                    }
                } catch (err) {
                    showToast('Erro ao enviar wallpaper', 'error');
                }
            });
        }
        
        // 2) GIF panel toggle (Avatar)
        const btnGif = document.getElementById('btnPerfilGif');
        const searchInput = document.getElementById('profileGifSearch');
        let profileSearchTimeout = null;
        
        if (btnGif) {
            btnGif.addEventListener('click', () => {
                const panel = document.getElementById('profileGifPanel');
                panel.classList.toggle('hidden');
                if (!panel.classList.contains('hidden')) {
                    searchInput.value = '';
                    currentGifRenderer = renderProfileGifs;
                    appFetchTenorTrending(currentGifRenderer);
                    searchInput.focus();
                }
            });
        }

        // 2b) GIF panel toggle (Wallpaper)
        const btnWallGif = document.getElementById('btnWallpaperGif');
        if (btnWallGif) {
            btnWallGif.addEventListener('click', () => {
                const panel = document.getElementById('profileGifPanel');
                panel.classList.toggle('hidden');
                if (!panel.classList.contains('hidden')) {
                    searchInput.value = '';
                    currentGifRenderer = renderWallpaperGifs;
                    appFetchTenorTrending(currentGifRenderer);
                    searchInput.focus();
                }
            });
        }
        
        if (searchInput) {
            searchInput.addEventListener('input', (e) => {
                const q = e.target.value.trim();
                clearTimeout(profileSearchTimeout);
                if (!q) {
                    appFetchTenorTrending((gifs) => currentGifRenderer(gifs));
                    return;
                }
                profileSearchTimeout = setTimeout(() => {
                    appFetchTenorSearch(q, (gifs) => currentGifRenderer(gifs));
                }, 500);
            });
        }
    }, 100);
});

function renderProfileGifs(gifs) {
    _renderCategoryGifs(gifs, 'avatar');
}

function renderWallpaperGifs(gifs) {
    _renderCategoryGifs(gifs, 'wallpaper');
}

function _renderCategoryGifs(gifs, tipo) {
    const container = document.getElementById('profileGifResults');
    if (!gifs || !gifs.length) {
        container.innerHTML = '<p class="empty-state" style="grid-column: 1/-1">Nenhum GIF encontrado</p>';
        return;
    }
    
    // Global handler for selecting a GIF
    window._selectProfileGif = async (url, type) => {
        document.getElementById('profileGifPanel').classList.add('hidden');
        showToast('Baixando GIF...', 'info');
        try {
            const proxyRes = await fetch(url);
            const blob = await proxyRes.blob();
            const filename = type === 'wallpaper' ? 'wallpaper.gif' : 'avatar.gif';
            const file = new File([blob], filename, { type: "image/gif" });
            
            const form = new FormData();
            form.append('foto', file);
            form.append('tipo', type);
            
            const data = await api('/api/upload-foto', { method: 'POST', body: form });
            if (type === 'wallpaper') {
                setWallpaperPreview(data.foto);
                showToast('Wallpaper GIF atualizado! 🎉', 'success');
            } else {
                setAvatarPreview(data.foto);
                showToast('Avatar GIF atualizado! 🎉', 'success');
            }
        } catch(err) {
            showToast('Erro ao processar GIF', 'error');
        }
    };
    
    container.innerHTML = gifs.map(g => {
        const tinyUrl = g.media[0].tinygif.url;
        const fullUrl = g.media[0].gif.url;
        return `
        <div style="cursor: pointer; border-radius: var(--radius-sm); overflow: hidden; border: 1px solid rgba(255,255,255,0.05);" 
             onclick="window._selectProfileGif('${fullUrl}', '${tipo}')">
            <img src="${tinyUrl}" style="width: 100%; height: 60px; object-fit: cover; display: block;" alt="GIF">
        </div>
        `;
    }).join('');
}

function setAvatarPreview(url) {
    if (!currentUser) return;
    currentUser.foto = url;
    const modalAvatar = document.getElementById('modalAvatar');
    if (modalAvatar) {
        modalAvatar.innerHTML = `<img src="${url}" alt="foto">`;
    }
    updateProfileUI(currentUser);
}

function setWallpaperPreview(url) {
    if (!currentUser) return;
    currentUser.wallpaper = url;
    const wallImg = document.getElementById('modalWallpaper');
    if (wallImg) {
        wallImg.src = url;
        wallImg.style.display = 'block';
    }
    updateProfileUI(currentUser);
}

async function salvarPerfil() {
    const nome = document.getElementById('editNome').value.trim();
    const bio = document.getElementById('editBio').value.trim();

    if (!nome) { showToast('Nome não pode ser vazio', 'error'); return; }

    try {
        const user = await api('/api/perfil', {
            method: 'PUT',
            body: { nome, bio }
        });
        currentUser = { ...currentUser, ...user };
        updateProfileUI(currentUser);
        closeModal();
        showToast('Perfil atualizado! ✅', 'success');
    } catch (err) {
        showToast('Erro ao salvar perfil', 'error');
    }
}
window.salvarPerfil = salvarPerfil;
