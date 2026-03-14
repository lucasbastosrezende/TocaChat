/* ═══════════════════════════════════════════════
   TocaDoConhecimento — App Core (SPA Router + Utilities)
   ═══════════════════════════════════════════════ */

const API = '';
let currentUser = null;

// ── Utility: Fetch wrapper ──
async function api(endpoint, options = {}) {
    try {
        const fetchOpts = {
            headers: { 'Content-Type': 'application/json', ...options.headers },
            credentials: 'same-origin',
            ...options
        };
        if (options.body && !(options.body instanceof FormData)) {
            fetchOpts.body = JSON.stringify(options.body);
        } else if (options.body instanceof FormData) {
            delete fetchOpts.headers['Content-Type'];
            fetchOpts.body = options.body;
        }
        const res = await fetch(`${API}${endpoint}`, fetchOpts);
        if (res.status === 401) {
            showAuthScreen();
            throw new Error('Não autenticado');
        }
        if (!res.ok) {
            const err = await res.json().catch(() => ({}));
            throw new Error(err.erro || `Erro ${res.status}`);
        }
        return await res.json();
    } catch (err) {
        if (err.message !== 'Não autenticado') {
            console.error(`API Error [${endpoint}]:`, err);
            showToast(err.message || 'Erro ao conectar com o servidor', 'error');
        }
        throw err;
    }
}

// ── Toast Notifications ──
function showToast(message, type = 'info') {
    const container = document.getElementById('toastContainer');
    const toast = document.createElement('div');
    toast.className = `toast toast-${type}`;
    toast.textContent = message;
    container.appendChild(toast);
    setTimeout(() => toast.remove(), 3000);
}

// ── Modal System ──
function openModal(title, bodyHTML, footerHTML = '') {
    const overlay = document.getElementById('modalOverlay');
    document.getElementById('modalTitle').textContent = title;
    document.getElementById('modalBody').innerHTML = bodyHTML;
    document.getElementById('modalFooter').innerHTML = footerHTML;
    overlay.classList.remove('hidden');
}

function closeModal() {
    document.getElementById('modalOverlay').classList.add('hidden');
}

document.getElementById('modalClose').addEventListener('click', closeModal);
document.getElementById('modalOverlay').addEventListener('click', (e) => {
    if (e.target === e.currentTarget) closeModal();
});


// ── Auth Screen Control ──
function showAuthScreen() {
    // FIX: Para o polling ao deslogar/expirar sessão para não ficar em loop de 401
    if (typeof stopSyncPolling === 'function') stopSyncPolling();
    document.getElementById('authScreen').classList.remove('hidden');
    document.getElementById('appWrapper').classList.add('hidden');
    currentUser = null;
}


function showApp(user) {
    currentUser = user;
    document.getElementById('authScreen').classList.add('hidden');
    const appWrapper = document.getElementById('appWrapper');
    appWrapper.classList.remove('hidden');
    if (typeof joinUserRoom === 'function') joinUserRoom();
    updateProfileUI(user);
    // FIX: Removido startSyncPolling() daqui — navigateTo('chat') abaixo já
    // dispara o evento pageChange que inicia o polling via chat.js.
    // Chamá-lo duas vezes criava dois intervalos paralelos (requests duplicados).
    navigateTo('chat');
}

function updateProfileUI(user) {
    // Como agora não temos o sidebar antigo, podemos atualizar 
    // outros elementos globais se necessário futuramente.
}

// ── SPA Router ──
function navigateTo(page) {
    document.querySelectorAll('.page').forEach(p => p.classList.remove('active'));
    document.querySelectorAll('.nav-btn').forEach(b => b.classList.remove('active'));
    
    const target = document.getElementById(`page-${page}`);
    if (target) {
        target.classList.add('active');
        const navBtn = document.getElementById(`nav-${page}`);
        if (navBtn) navBtn.classList.add('active');
        window.dispatchEvent(new CustomEvent('pageChange', { detail: { page } }));
    }
}

// ── Logout ──
document.querySelectorAll('[id^="btnLogout"]').forEach(btn => {
    btn.addEventListener('click', async () => {
        try {
            await api('/api/logout', { method: 'POST' });
        } catch(e) {}
        showAuthScreen();
        showToast('Sessão encerrada 👋', 'info');
    });
});

// ── Format helpers ──
function formatDate(dateStr) {
    if (!dateStr) return '';
    const d = new Date(dateStr + 'T00:00:00');
    return d.toLocaleDateString('pt-BR', { day: '2-digit', month: 'short' });
}

function formatDateTime(dtStr) {
    if (!dtStr) return '';
    const d = new Date(dtStr);
    return d.toLocaleDateString('pt-BR', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' });
}

function formatTime(dtStr) {
    if (!dtStr) return '';
    const d = new Date(dtStr);
    return d.toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' });
}

// ── Image Compression Utility ──
// Compresses images client-side before upload using Canvas API.
// GIFs are returned unchanged (Canvas destroys animation).
// Returns a Promise<File> with the compressed image.
async function compressImage(file, maxWidth = 1280, maxHeight = 1280, quality = 0.8) {
    // Skip GIFs (can't compress without losing animation)
    if (file.type === 'image/gif') return file;
    // Skip non-images
    if (!file.type.startsWith('image/')) return file;
    // Skip files already under 200KB
    if (file.size < 200 * 1024) return file;

    return new Promise((resolve) => {
        const img = new Image();
        const url = URL.createObjectURL(file);
        img.onload = () => {
            URL.revokeObjectURL(url);
            let { width, height } = img;

            // Calculate new dimensions maintaining aspect ratio
            if (width > maxWidth || height > maxHeight) {
                const ratio = Math.min(maxWidth / width, maxHeight / height);
                width = Math.round(width * ratio);
                height = Math.round(height * ratio);
            }

            const canvas = document.createElement('canvas');
            canvas.width = width;
            canvas.height = height;
            const ctx = canvas.getContext('2d');
            ctx.drawImage(img, 0, 0, width, height);

            canvas.toBlob((blob) => {
                if (blob && blob.size < file.size) {
                    // Use compressed version
                    const compressed = new File([blob], file.name.replace(/\.\w+$/, '.webp'), { type: 'image/webp' });
                    console.log(`[Compress] ${(file.size/1024).toFixed(0)}KB → ${(compressed.size/1024).toFixed(0)}KB (${Math.round(compressed.size/file.size*100)}%)`);
                    resolve(compressed);
                } else {
                    // Original was smaller, keep it
                    resolve(file);
                }
            }, 'image/webp', quality);
        };
        img.onerror = () => {
            URL.revokeObjectURL(url);
            resolve(file); // Fallback to original on error
        };
        img.src = url;
    });
}

// ── Tenor GIF Global Core ──
const TENOR_API_KEY = 'LIVDSRZULELA';

async function appFetchTenorTrending(callback) {
    try {
        const res = await fetch(`https://api.tenor.com/v1/trending?key=${TENOR_API_KEY}&limit=20`);
        const data = await res.json();
        if(callback) callback(data.results);
    } catch(err) {
        console.error('Tenor trending error:', err);
    }
}

async function appFetchTenorSearch(query, callback) {
    try {
        const res = await fetch(`https://api.tenor.com/v1/search?key=${TENOR_API_KEY}&q=${encodeURIComponent(query)}&limit=20&locale=pt_BR`);
        const data = await res.json();
        if(callback) callback(data.results);
    } catch(err) {
        console.error('Tenor search error:', err);
    }
}

// ── Avatar Utility ──
function getAvatarHtml(id, nome, foto) {
    if (foto) {
        return `<img src="${foto}" alt="${nome}" loading="lazy" style="aspect-ratio:1/1;object-fit:cover">`;
    }
    // Fallback: Animated Abstract Video for users without photo
    return `<video autoplay loop muted playsinline class="default-avatar-vid"><source src="/static/images/logo3.mp4" type="video/mp4"></video>`;
}
window.getAvatarHtml = getAvatarHtml;

// ── Init ──
document.addEventListener('DOMContentLoaded', async () => {
    try {
        const user = await api('/api/me');
        if (user.autenticado) {
            showApp(user);
        } else {
            showAuthScreen();
        }
    } catch {
        showAuthScreen();
    }
});
