from flask import Flask, request, jsonify, send_from_directory, session, g  # type: ignore
from flask_cors import CORS  # type: ignore
from flask_socketio import SocketIO, emit, join_room, leave_room  # type: ignore
from werkzeug.middleware.proxy_fix import ProxyFix # type: ignore
from database import get_db, init_db  # type: ignore
from datetime import datetime, timedelta, timezone
from functools import wraps
import bcrypt  # type: ignore
import uuid
import os
import json
import traceback
from typing import Any, Dict, List, Set, Tuple
from PIL import Image as PILImage  # type: ignore


app = Flask(__name__, static_folder='static', template_folder='templates')
app.wsgi_app = ProxyFix(app.wsgi_app, x_for=1, x_proto=1, x_host=1, x_prefix=1)
app.secret_key = os.urandom(32)
UPLOAD_DIR = os.path.join(os.path.dirname(os.path.abspath(__file__)), 'static', 'uploads')
app.config['UPLOAD_DIR'] = UPLOAD_DIR
app.config['MAX_CONTENT_LENGTH'] = 500 * 1024 * 1024  # 500MB for HD videos
CORS(app, supports_credentials=True, origins=["https://tocachat.duckdns.org:8080", "http://localhost:8080", "http://127.0.0.1:8080"])
socketio = SocketIO(app, cors_allowed_origins="*", supports_credentials=True, async_mode='threading')

os.makedirs(UPLOAD_DIR, exist_ok=True)

ALLOWED_EXTENSIONS = {'jpg', 'jpeg', 'png', 'webp', 'gif', 'mp4', 'webm'}

init_db()

# ── Dynamic DB Connection Management ──
def get_db_g():
    if 'db' not in g:
        g.db = get_db()
    return g.db

@app.teardown_appcontext
def close_db(e=None):
    db = g.pop('db', None)
    if db is not None:
        db.close()
@app.errorhandler(500)
def handle_500(e):
    app.logger.error(f"ERROR 500: {e}\n{traceback.format_exc()}")
    return jsonify({'erro': 'Erro interno no servidor'}), 500

# Globals for memory state (e.g. tracking active callers without DB I/O)
# user_id -> {'conversa_id': X, 'last_ping': timestamp}
ACTIVE_CALLS: Dict[int, Dict[str, Any]] = {}

@app.route('/sw.js')
def serve_sw():
    return send_from_directory(os.path.dirname(os.path.abspath(__file__)), 'sw.js')


# ══════════════════════════════════════════════
#  Helpers
# ══════════════════════════════════════════════
def allowed_file(filename):
    return '.' in filename and filename.rsplit('.', 1)[1].lower() in ALLOWED_EXTENSIONS


def compress_image(filepath, max_size=1280, quality=80):
    """Returns original filepath immediately to ensure maximum quality as requested."""
    return filepath

# Fuso horário do Amazonas (Manaus, UTC-4)
MANAUS_TZ = timezone(timedelta(hours=-4), 'America/Manaus')

def agora_manaus():
    return datetime.now(MANAUS_TZ).replace(tzinfo=None)


def login_required(f):
    @wraps(f)
    def decorated(*args, **kwargs):
        if 'usuario_id' not in session:
            return jsonify({'erro': 'Não autenticado'}), 401
        return f(*args, **kwargs)
    return decorated


def get_user_id():
    return session.get('usuario_id')


def build_reactions_map(db, message_ids, current_user_id):
    if not message_ids:
        return {}

    placeholders = ','.join(['?'] * len(message_ids))
    rows = db.execute(f'''
        SELECT mensagem_id, emoji, usuario_id
        FROM mensagem_reacoes
        WHERE mensagem_id IN ({placeholders})
    ''', tuple(message_ids)).fetchall()

    reaction_users: Dict[Tuple[int, str], Set[int]] = {}
    for row in rows:
        key = (row['mensagem_id'], row['emoji'])
        reaction_users.setdefault(key, set()).add(row['usuario_id'])

    reactions_map: Dict[int, List[Dict[str, Any]]] = {}
    for (mensagem_id, emoji), users in reaction_users.items():
        reactions_map.setdefault(mensagem_id, []).append({
            'emoji': emoji,
            'total': len(users),
            'reagiu': current_user_id in users
        })

    for mensagem_id in reactions_map:
        reactions_map[mensagem_id].sort(key=lambda item: (-item['total'], item['emoji']))

    return reactions_map


def attach_reactions(db, messages, current_user_id):
    if not messages:
        return messages

    message_ids = [msg['id'] for msg in messages]
    reactions_map = build_reactions_map(db, message_ids, current_user_id)

    for msg in messages:
        msg['reacoes'] = reactions_map.get(msg['id'], [])

    return messages


# ══════════════════════════════════════════════
#  Servir Frontend (SPA)
# ══════════════════════════════════════════════
# ── Cache headers for uploaded assets ──
@app.after_request
def add_cache_headers(response):
    if request.path.startswith('/static/uploads/'):
        response.headers['Cache-Control'] = 'public, max-age=2592000, immutable'  # 30 days
    return response


@app.route('/')
def index():
    return send_from_directory('templates', 'index.html')


# ══════════════════════════════════════════════
#  WebRTC runtime config
# ══════════════════════════════════════════════
@app.route('/api/webrtc/config', methods=['GET'])
def webrtc_config():
    """
    Runtime ICE/TURN config for the browser.

    Why: static JS cannot read env vars; 4G/CGNAT scenarios often need TURN.
    """
    # ICE servers (STUN + optional TURN)
    ice_servers: List[Dict[str, Any]] = [
        {'urls': 'stun:stun.l.google.com:19302'},
        {'urls': 'stun:stun1.l.google.com:19302'},
    ]

    # TURN_URLS supports comma-separated values (turn:..., turns:...)
    turn_urls_raw = os.getenv('TURN_URLS', '').strip()
    turn_username = os.getenv('TURN_USERNAME', '').strip()
    turn_credential = os.getenv('TURN_CREDENTIAL', '').strip()

    if turn_urls_raw and turn_username and turn_credential:
        turn_urls = [u.strip() for u in turn_urls_raw.split(',') if u.strip()]
        if turn_urls:
            ice_servers.append({
                'urls': turn_urls if len(turn_urls) > 1 else turn_urls[0],
                'username': turn_username,
                'credential': turn_credential
            })

    # NOTE: keep policy "all" so STUN is tried first, TURN used when needed (4G/CGNAT)
    return jsonify({
        'rtc': {
            'iceServers': ice_servers,
            'iceTransportPolicy': os.getenv('ICE_TRANSPORT_POLICY', 'all').strip() or 'all'
        }
    })


# ══════════════════════════════════════════════
#  AUTH — Registro / Login / Logout
# ══════════════════════════════════════════════
@app.route('/api/registro', methods=['POST'])
def registrar():
    data = request.json
    username = data.get('username', '').strip().lower()
    senha = data.get('senha', '')

    if not username or not senha:
        return jsonify({'erro': 'Usuário e senha são obrigatórios'}), 400

    if len(senha) < 4:
        return jsonify({'erro': 'Senha deve ter no mínimo 4 caracteres'}), 400

    senha_hash = bcrypt.hashpw(senha.encode('utf-8'), bcrypt.gensalt()).decode('utf-8')

    db = get_db_g()
    try:
        cursor = db.execute(
            'INSERT INTO usuarios (username, email, senha_hash, nome) VALUES (?, ?, ?, ?)',
            (username, f'{username}@local', senha_hash, username)
        )
        db.commit()
        user_id = cursor.lastrowid
        session['usuario_id'] = user_id
        user = db.execute('SELECT id, username, nome, bio, foto FROM usuarios WHERE id = ?', (user_id,)).fetchone()
        return jsonify(dict(user)), 201
    except Exception as e:
        if 'UNIQUE' in str(e):
            return jsonify({'erro': 'Usuário já existe'}), 409
        return jsonify({'erro': str(e)}), 500


@app.route('/api/login', methods=['POST'])
def login():
    data = request.json
    username = data.get('login', '').strip().lower()
    senha = data.get('senha', '')

    db = get_db_g()
    user = db.execute(
        'SELECT * FROM usuarios WHERE username = ?', (username,)
    ).fetchone()

    if not user or not bcrypt.checkpw(senha.encode('utf-8'), user['senha_hash'].encode('utf-8')):
        return jsonify({'erro': 'Usuário ou senha incorretos'}), 401

    session['usuario_id'] = user['id']
    return jsonify({
        'id': user['id'], 'username': user['username'],
        'nome': user['nome'], 'bio': user['bio'], 'foto': user['foto'],
        'wallpaper': user['wallpaper']
    })


@app.route('/api/logout', methods=['POST'])
def logout():
    session.clear()
    return jsonify({'ok': True})


@app.route('/api/me', methods=['GET'])
def me():
    uid = get_user_id()
    if not uid:
        return jsonify({'autenticado': False}), 401
    db = get_db_g()
    user = db.execute('SELECT id, username, nome, bio, foto, wallpaper FROM usuarios WHERE id = ?', (uid,)).fetchone()
    if not user:
        session.clear()
        return jsonify({'autenticado': False}), 401
    return jsonify({**dict(user), 'autenticado': True})


# ══════════════════════════════════════════════
#  PERFIL — Editar + Upload de Foto
# ══════════════════════════════════════════════
@app.route('/api/perfil', methods=['PUT'])
@login_required
def atualizar_perfil():
    data = request.json
    uid = get_user_id()
    db = get_db_g()
    db.execute(
        'UPDATE usuarios SET nome=?, bio=?, atualizado_em=? WHERE id=?',
        (data.get('nome', ''), data.get('bio', ''), agora_manaus().isoformat(), uid)
    )
    db.commit()
    user = db.execute('SELECT id, username, nome, bio, foto, wallpaper FROM usuarios WHERE id = ?', (uid,)).fetchone()
    return jsonify(dict(user))


@app.route('/api/upload-foto', methods=['POST'])
@login_required
def upload_foto():
    if 'foto' not in request.files:
        return jsonify({'erro': 'Nenhum arquivo enviado'}), 400

    file = request.files['foto']
    if not file or not allowed_file(file.filename):
        return jsonify({'erro': 'Formato não suportado: ' + ', '.join(ALLOWED_EXTENSIONS).upper()}), 400

    ext = file.filename.rsplit('.', 1)[1].lower()
    filename = f"{uuid.uuid4().hex}.{ext}"
    filepath = os.path.join(UPLOAD_DIR, filename)
    file.save(filepath)

    uid = get_user_id()
    db = get_db_g()
    tipo = request.form.get('tipo', 'avatar')  # 'avatar' or 'wallpaper'
    conversa_id = request.form.get('conversa_id')
    
    # If it's a group wallpaper/photo, verify membership/permissions
    if tipo == 'wallpaper' and conversa_id:
        is_member = db.execute('SELECT 1 FROM conversa_membros WHERE conversa_id = ? AND usuario_id = ?', (conversa_id, uid)).fetchone()
        if not is_member:
            return jsonify({'erro': 'Não autorizado'}), 403
    
    col = 'wallpaper' if tipo == 'wallpaper' else 'foto'

    # Server-side compression (avatar: 256px, wallpaper: 1280px)
    max_sz = 256 if tipo == 'avatar' else 1280
    qual = 80 if tipo == 'avatar' else 75
    filepath = compress_image(filepath, max_size=max_sz, quality=qual)
    filename = os.path.basename(filepath)

    
    # Remove old photo/wallpaper
    old = db.execute(f'SELECT {col} FROM usuarios WHERE id = ?', (uid,)).fetchone()
    if old and old[col]:
        old_path = os.path.join(UPLOAD_DIR, os.path.basename(old[col]))
        if os.path.exists(old_path):
            os.remove(old_path)

    foto_url = f"/static/uploads/{filename}"
    if tipo == 'wallpaper':
        db.execute('UPDATE usuarios SET wallpaper=?, atualizado_em=? WHERE id=?',
                   (foto_url, agora_manaus().isoformat(), uid))
    else:
        db.execute('UPDATE usuarios SET foto=?, atualizado_em=? WHERE id=?',
                   (foto_url, agora_manaus().isoformat(), uid))
    
    db.commit()
    return jsonify({'foto': foto_url, 'tipo': tipo})


@app.route('/api/stickers', methods=['GET'])
@login_required
def listar_stickers():
    # Buscamos tanto no diretório default quanto na raiz de stickers para customizados
    sticker_root = os.path.join(app.static_folder, 'stickers')
    default_dir = os.path.join(sticker_root, 'default')
    
    files = []
    # Figurinhas do sistema
    if os.path.exists(default_dir):
        files.extend([f"/static/stickers/default/{f}" for f in os.listdir(default_dir) if allowed_file(f)])
    
    # Figurinhas customizadas (na raiz de stickers)
    if os.path.exists(sticker_root):
        files.extend([f"/static/stickers/{f}" for f in os.listdir(sticker_root) if allowed_file(f) and os.path.isfile(os.path.join(sticker_root, f))])
        
    return jsonify(files)


@app.route('/api/wallpaper-global', methods=['GET'])
@login_required
def get_wallpaper_global():
    db = get_db_g()
    row = db.execute("SELECT valor FROM configuracoes_globais WHERE chave = 'active_wallpaper'").fetchone()
    active_wallpaper = row['valor'] if row else None
    
    # Get all available wallpapers in static/images
    image_dir = os.path.join(app.static_folder, 'images')
    available = []
    if os.path.exists(image_dir):
        available = [f"/static/images/{f}" for f in os.listdir(image_dir) if allowed_file(f)]
        
    return jsonify({
        'active_wallpaper': active_wallpaper,
        'available': available
    })

@app.route('/api/upload-wallpaper-global', methods=['POST'])
@login_required
def upload_wallpaper_global():
    if 'wallpaper' not in request.files:
        return jsonify({'erro': 'Nenhum arquivo enviado'}), 400

    file = request.files['wallpaper']
    if not file or not allowed_file(file.filename):
        return jsonify({'erro': 'Formato não suportado: ' + ', '.join(ALLOWED_EXTENSIONS).upper()}), 400

    image_dir = os.path.join(app.static_folder, 'images')
    os.makedirs(image_dir, exist_ok=True)
    
    ext = file.filename.rsplit('.', 1)[1].lower()
    filename = f"custom_{uuid.uuid4().hex}.{ext}"
    filepath = os.path.join(image_dir, filename)
    file.save(filepath)

    # Compress only if it's an image (skip for videos/gifs)
    is_video = ext in {'mp4', 'webm', 'gif'}
    if not is_video:
        filepath = compress_image(filepath, max_size=1920, quality=80)
    
    filename = os.path.basename(filepath)
    wallpaper_url = f"/static/images/{filename}"
    
    db = get_db_g()
    db.execute("INSERT OR REPLACE INTO configuracoes_globais (chave, valor) VALUES ('active_wallpaper', ?)", (wallpaper_url,))
    db.commit()

    # Emit to all users via socket
    socketio.emit('global_wallpaper_updated', {'url': wallpaper_url})
    
    return jsonify({'url': wallpaper_url})

@app.route('/api/set-wallpaper-global', methods=['POST'])
@login_required
def set_wallpaper_global():
    data = request.json
    url = data.get('url')
    if not url or not url.startswith('/static/images/'):
        return jsonify({'erro': 'URL inválida'}), 400
        
    db = get_db_g()
    db.execute("INSERT OR REPLACE INTO configuracoes_globais (chave, valor) VALUES ('active_wallpaper', ?)", (url,))
    db.commit()

    # Emit to all users
    socketio.emit('global_wallpaper_updated', {'url': url})
    
    return jsonify({'sucesso': True})


@app.route('/api/upload-sticker', methods=['POST'])
@login_required
def upload_sticker():
    if 'sticker' not in request.files:
        return jsonify({'erro': 'Nenhum arquivo enviado'}), 400

    file = request.files['sticker']
    if not file or not allowed_file(file.filename):
        return jsonify({'erro': 'Formato não suportado: ' + ', '.join(ALLOWED_EXTENSIONS).upper()}), 400

    # Salvamos stickers na pasta de stickers para organização
    sticker_dir = os.path.join(app.static_folder, 'stickers')
    os.makedirs(sticker_dir, exist_ok=True)
    
    ext = file.filename.rsplit('.', 1)[1].lower()
    filename = f"custom_{uuid.uuid4().hex}.{ext}"
    filepath = os.path.join(sticker_dir, filename)
    file.save(filepath)

    # Stickers não precisam de compressão pesada, mas vamos garantir tamanho razoável
    filepath = compress_image(filepath, max_size=512, quality=85)
    filename = os.path.basename(filepath)

    sticker_url = f"/static/stickers/{filename}"
    return jsonify({'url': sticker_url})


@app.route('/api/usuarios', methods=['GET'])
@login_required
def listar_usuarios():
    db = get_db_g()
    users = db.execute(
        "SELECT id, username, COALESCE(NULLIF(nome, ''), username) AS nome, bio, foto, wallpaper FROM usuarios ORDER BY nome"
    ).fetchall()
    return jsonify([dict(u) for u in users])


# ══════════════════════════════════════════════
#  CHAT — Conversas
# ══════════════════════════════════════════════
@app.route('/api/conversas', methods=['GET'])
@login_required
def listar_conversas():
    uid = get_user_id()
    db = get_db_g()
    # Note: Using a single JOIN on the latest message set is faster than correlated subqueries for many chats
    conversas_query = '''
        SELECT c.*, lm.conteudo as ultima_msg, lm.criado_em as ultima_msg_em,
               (SELECT COUNT(*) FROM mensagens m2 WHERE m2.conversa_id = c.id) as total_msgs
        FROM conversas c
        LEFT JOIN (
            SELECT m.conversa_id, m.conteudo, m.criado_em
            FROM mensagens m
            WHERE m.id IN (SELECT MAX(id) FROM mensagens GROUP BY conversa_id)
        ) lm ON c.id = lm.conversa_id
        WHERE c.id IN (
            SELECT conversa_id FROM conversa_membros WHERE usuario_id = ?
        )
        ORDER BY COALESCE(ultima_msg_em, c.criado_em) DESC
    '''
    conversas = db.execute(conversas_query, (uid,)).fetchall()

    if not conversas:
        return jsonify([])

    result = []
    for c in conversas:
        conv: Dict[str, Any] = dict(c)
        # Lightweight payload for list: não incluir todos os membros aqui
        # para evitar payload gigante e dados redundantes no sidebar.

        # For direct chats, show the other person's name
        if c['tipo'] == 'direto':
            # Derivar apenas nome/foto/wallpaper do outro participante em uma query leve
            other = db.execute('''
                SELECT COALESCE(NULLIF(u.nome, ''), u.username) AS nome, u.foto, u.wallpaper
                FROM conversa_membros cm 
                JOIN usuarios u ON cm.usuario_id = u.id
                WHERE cm.conversa_id = ? AND cm.usuario_id != ?
                LIMIT 1
            ''', (c['id'], uid)).fetchone()
            if other:
                conv['display_nome'] = other['nome']
                conv['display_foto'] = other['foto'] or ''
                # Fallback para o wallpaper do perfil se a conversa em si não tiver um
                wp = conv.get('wallpaper')
                if not wp or wp == '':
                    conv['wallpaper'] = other['wallpaper'] or ''
            else:
                # Fallback se for um chat "consigo mesmo" ou estado inconsistente
                conv['display_nome'] = 'Minhas Anotações'
                conv['display_foto'] = ''
        else:
            conv['display_nome'] = c['nome'] or 'Grupo'
            conv['display_foto'] = c['foto'] or ''

        result.append(conv)

    return jsonify(result)


@app.route('/api/conversas/<int:id>', methods=['GET'])
@login_required
def obter_conversa(id):
    """Retorna uma única conversa com membros (para sinal de chamada quando ainda não está em window.conversas)."""
    uid = get_user_id()
    db = get_db_g()
    conv = db.execute(
        'SELECT c.* FROM conversas c JOIN conversa_membros cm ON c.id = cm.conversa_id WHERE c.id = ? AND cm.usuario_id = ?',
        (id, uid)
    ).fetchone()
    if not conv:
        return jsonify({'erro': 'Conversa não encontrada'}), 404
    conv: Dict[str, Any] = dict(conv)
    membros_raw = db.execute('''
        SELECT u.id, u.username, COALESCE(NULLIF(u.nome, ''), u.username) AS nome, u.foto, u.wallpaper, u.bio
        FROM conversa_membros cm JOIN usuarios u ON cm.usuario_id = u.id
        WHERE cm.conversa_id = ?
    ''', (id,)).fetchall()
    conv['membros'] = [dict(m) for m in membros_raw]
    if conv['tipo'] == 'direto':
        other = [m for m in conv['membros'] if m['id'] != uid]
        if other:
            conv['display_nome'] = other[0]['nome']
            conv['display_foto'] = other[0]['foto'] or ''
            # Fallback para wallpaper
            if not conv.get('wallpaper'):
                conv['wallpaper'] = other[0]['wallpaper'] or ''
        else:
            conv['display_nome'] = 'Minhas Anotações'
            conv['display_foto'] = ''
    else:
        conv['display_nome'] = conv.get('nome') or 'Grupo'
        conv['display_foto'] = conv.get('foto') or ''
    return jsonify(conv)


@app.route('/api/conversas/direto', methods=['POST'])
@login_required
def criar_conversa_direta():
    uid = get_user_id()
    data = request.json
    outro_id = data.get('usuario_id')

    if not outro_id or int(outro_id) == uid:
        return jsonify({'erro': 'Usuário inválido'}), 400

    db = get_db_g()
    # Check if direct conversation already exists
    existing = db.execute('''
        SELECT c.id FROM conversas c
        JOIN conversa_membros cm1 ON c.id = cm1.conversa_id AND cm1.usuario_id = ?
        JOIN conversa_membros cm2 ON c.id = cm2.conversa_id AND cm2.usuario_id = ?
        WHERE c.tipo = 'direto'
    ''', (uid, outro_id)).fetchone()

    if existing:
        return jsonify({'id': existing['id'], 'existente': True})

    agora = agora_manaus().isoformat()
    cursor = db.execute(
        "INSERT INTO conversas (tipo, criado_por, criado_em, atualizado_em) VALUES ('direto', ?, ?, ?)", 
        (uid, agora, agora)
    )
    conv_id = cursor.lastrowid
    db.execute('INSERT INTO conversa_membros (conversa_id, usuario_id) VALUES (?, ?)', (conv_id, uid))
    db.execute('INSERT INTO conversa_membros (conversa_id, usuario_id) VALUES (?, ?)', (conv_id, outro_id))
    db.commit()
    return jsonify({'id': conv_id}), 201


@app.route('/api/conversas/grupo', methods=['POST'])
@login_required
def criar_grupo():
    uid = get_user_id()
    data = request.json
    nome = data.get('nome', 'Novo Grupo').strip()
    membros_ids = data.get('membros', [])

    db = get_db_g()
    agora = agora_manaus().isoformat()
    cursor = db.execute(
        "INSERT INTO conversas (tipo, nome, criado_por, criado_em, atualizado_em) VALUES ('grupo', ?, ?, ?, ?)",
        (nome, uid, agora, agora)
    )
    conv_id = cursor.lastrowid
    db.execute('INSERT INTO conversa_membros (conversa_id, usuario_id) VALUES (?, ?)', (conv_id, uid))
    for mid in membros_ids:
        if int(mid) != uid:
            db.execute('INSERT OR IGNORE INTO conversa_membros (conversa_id, usuario_id) VALUES (?, ?)',
                       (conv_id, int(mid)))
    db.commit()
    return jsonify({'id': conv_id}), 201


@app.route('/api/conversas/<int:id>', methods=['PUT'])
@login_required
def editar_conversa(id):
    data = request.json
    db = get_db_g()
    db.execute(
        'UPDATE conversas SET nome=?, descricao=?, wallpaper=?, atualizado_em=? WHERE id=?',
        (data.get('nome', ''), data.get('descricao', ''), data.get('wallpaper', ''), agora_manaus().isoformat(), id)
    )
    db.commit()
    conv = db.execute('SELECT * FROM conversas WHERE id = ?', (id,)).fetchone()
    return jsonify(dict(conv))


@app.route('/api/conversas/<int:id>/foto', methods=['POST'])
@login_required
def upload_foto_grupo(id):
    if 'foto' not in request.files:
        return jsonify({'erro': 'Nenhum arquivo enviado'}), 400

    file = request.files['foto']
    if not file or not allowed_file(file.filename):
        return jsonify({'erro': 'Formato não suportado'}), 400

    ext = file.filename.rsplit('.', 1)[1].lower()
    filename = f"grupo_{uuid.uuid4().hex}.{ext}"
    filepath = os.path.join(UPLOAD_DIR, filename)
    file.save(filepath)

    # Compress group photo (256px max)
    filepath = compress_image(filepath, max_size=256, quality=80)
    filename = os.path.basename(filepath)

    db = get_db_g()
    uid = get_user_id()
    
    # Security: Verify membership
    is_member = db.execute('SELECT 1 FROM conversa_membros WHERE conversa_id = ? AND usuario_id = ?', (id, uid)).fetchone()
    if not is_member:
        return jsonify({'erro': 'Não autorizado'}), 403

    old = db.execute('SELECT foto FROM conversas WHERE id = ?', (id,)).fetchone()
    if old and old['foto']:
        old_path = os.path.join(UPLOAD_DIR, os.path.basename(old['foto']))
        if os.path.exists(old_path):
            os.remove(old_path)

    foto_url = f"/static/uploads/{filename}"
    db.execute('UPDATE conversas SET foto=? WHERE id=?', (foto_url, id))
    db.commit()
    return jsonify({'foto': foto_url})


@app.route('/api/conversas/<int:id>/wallpaper', methods=['POST'])
@login_required
def upload_wallpaper_grupo(id):
    if 'wallpaper' not in request.files:
        return jsonify({'erro': 'Nenhum arquivo enviado'}), 400

    file = request.files['wallpaper']
    if not file or not allowed_file(file.filename):
        return jsonify({'erro': 'Formato não suportado: ' + ', '.join(ALLOWED_EXTENSIONS).upper()}), 400

    ext = file.filename.rsplit('.', 1)[1].lower()
    filename = f"group_wall_{uuid.uuid4().hex}.{ext}"
    filepath = os.path.join(UPLOAD_DIR, filename)
    file.save(filepath)

    # Compress group wallpaper (1280px max)
    filepath = compress_image(filepath, max_size=1280, quality=75)
    filename = os.path.basename(filepath)

    db = get_db_g()
    uid = get_user_id()
    
    # Security: Verify membership
    is_member = db.execute('SELECT 1 FROM conversa_membros WHERE conversa_id = ? AND usuario_id = ?', (id, uid)).fetchone()
    if not is_member:
        return jsonify({'erro': 'Não autorizado'}), 403

    old = db.execute('SELECT wallpaper FROM conversas WHERE id = ?', (id,)).fetchone()
    if old and old['wallpaper']:
        old_path = os.path.join(UPLOAD_DIR, os.path.basename(old['wallpaper']))
        if os.path.exists(old_path):
            try: os.remove(old_path)
            except: pass

    wall_url = f"/static/uploads/{filename}"
    db.execute('UPDATE conversas SET wallpaper=? WHERE id=?', (wall_url, id))
    db.commit()
    return jsonify({'wallpaper': wall_url})


@app.route('/api/conversas/<int:id>/membros', methods=['POST'])
@login_required
def adicionar_membro(id):
    data = request.json
    db = get_db_g()
    uid = get_user_id()
    
    # Security: Verify the person adding IS a member
    is_member = db.execute('SELECT 1 FROM conversa_membros WHERE conversa_id = ? AND usuario_id = ?', (id, uid)).fetchone()
    if not is_member:
        return jsonify({'erro': 'Não autorizado'}), 403

    try:
        db.execute('INSERT INTO conversa_membros (conversa_id, usuario_id) VALUES (?, ?)',
                   (id, data['usuario_id']))
        db.commit()
    except Exception:
        pass
    return jsonify({'ok': True})


@app.route('/api/conversas/<int:id>', methods=['DELETE'])
@login_required
def deletar_conversa(id):
    db = get_db_g()
    uid = get_user_id()
    
    # Security: Only creator or admins (if roles exists, else creator) can delete
    conv_info = db.execute('SELECT criado_por FROM conversas WHERE id = ?', (id,)).fetchone()
    if not conv_info:
        return jsonify({'erro': 'Conversa não encontrada'}), 404
        
    if conv_info['criado_por'] != uid:
        return jsonify({'erro': 'Apenas o criador pode excluir a conversa'}), 403

    # Pega todas as mensagens da conversa que têm arquivos upados para apagar do disco
    msgs = db.execute('SELECT media_url FROM mensagens WHERE conversa_id = ? AND media_url != ""', (id,)).fetchall()
    for msg in msgs:
        if msg['media_url'].startswith('/static/uploads/'):
            filename = msg['media_url'].split('/')[-1]
            filepath = os.path.join(UPLOAD_DIR, filename)
            if os.path.exists(filepath):
                try: os.remove(filepath)
                except: pass

    # Se a conversa tiver foto de grupo salva fisicamente, exclui também
    conv = db.execute('SELECT foto FROM conversas WHERE id = ?', (id,)).fetchone()
    if conv and conv['foto'] and conv['foto'].startswith('/static/uploads/'):
        filename = conv['foto'].split('/')[-1]
        filepath = os.path.join(UPLOAD_DIR, filename)
        if os.path.exists(filepath):
            try: os.remove(filepath)
            except: pass

    # Apaga a conversa do banco. CASCADE vai cuidar das mensagens e membros.
    db.execute('DELETE FROM conversas WHERE id = ?', (id,))
    db.commit()
    return jsonify({'ok': True})


@app.route('/api/conversas/<int:id>/sair', methods=['POST'])
@login_required
def sair_grupo(id):
    uid = get_user_id()
    db = get_db_g()
    db.execute('DELETE FROM conversa_membros WHERE conversa_id = ? AND usuario_id = ?', (id, uid))
    db.commit()
    return jsonify({'ok': True})


# ── Mensagens ──
@app.route('/api/conversas/<int:id>/mensagens', methods=['GET'])
@login_required
def listar_mensagens(id):
    db = get_db_g()
    uid = get_user_id()
    
    # Security: Verify membership
    is_member = db.execute('SELECT 1 FROM conversa_membros WHERE conversa_id = ? AND usuario_id = ?', (id, uid)).fetchone()
    if not is_member:
        return jsonify({'erro': 'Não autorizado'}), 403

    after_id = request.args.get('after_id', type=int)
    subtopico_id = request.args.get('subtopico_id', type=int)

    query = '''
        SELECT m.*, COALESCE(NULLIF(u.nome, ''), u.username) as autor_nome, u.foto as autor_foto, u.username as autor_username,
        r.media_url as reply_media, r.conteudo as reply_content, COALESCE(NULLIF(ru.nome, ''), ru.username) as reply_author
        FROM mensagens m 
        JOIN usuarios u ON m.usuario_id = u.id
        LEFT JOIN mensagens r ON m.reply_to_id = r.id
        LEFT JOIN usuarios ru ON r.usuario_id = ru.id
        WHERE m.conversa_id = ?
    '''
    params = [id]

    if after_id:
        query += ' AND m.id > ?'
        params.append(after_id)
    else:
        query += ' AND m.excluido_em IS NULL'

    if subtopico_id:
        query += ' AND m.subtopico_id = ?'
        params.append(subtopico_id)
    else:
        query += ' AND m.subtopico_id IS NULL'

    if after_id:
        query += ' ORDER BY m.criado_em ASC'
        msgs = db.execute(query, params).fetchall()
    else:
        query += ' ORDER BY m.criado_em DESC LIMIT 50'
        msgs = db.execute(query, params).fetchall()
        msgs = list(reversed(msgs))

    result = attach_reactions(db, [dict(m) for m in msgs], get_user_id())
    return jsonify(result)


@app.route('/api/conversas/<int:id>/mensagens', methods=['POST'])
@login_required
def enviar_mensagem(id):
    uid = get_user_id()
    data = request.json
    conteudo = data.get('conteudo', '').strip()
    subtopico_id = data.get('subtopico_id')
    media_url = data.get('media_url', '')
    reply_to_id = data.get('reply_to_id')
    if not conteudo and not media_url:
        return jsonify({'erro': 'Mensagem vazia'}), 400

    db = get_db_g()
    
    # User MUST be a member of the conversation to send a message
    is_member = db.execute('SELECT 1 FROM conversa_membros WHERE conversa_id = ? AND usuario_id = ?', (id, uid)).fetchone()
    if not is_member:
        return jsonify({'erro': 'Você não é membro desta conversa'}), 403
            
    cursor = db.execute(
        'INSERT INTO mensagens (conversa_id, usuario_id, conteudo, subtopico_id, media_url, reply_to_id, criado_em) VALUES (?, ?, ?, ?, ?, ?, ?)',
        (id, uid, conteudo, subtopico_id, media_url, reply_to_id, agora_manaus().isoformat())
    )
    db.commit()
    msg = db.execute('''
        SELECT m.*, COALESCE(NULLIF(u.nome, ''), u.username) as autor_nome, u.foto as autor_foto, u.username as autor_username,
        r.media_url as reply_media, r.conteudo as reply_content, COALESCE(NULLIF(ru.nome, ''), ru.username) as reply_author
        FROM mensagens m 
        JOIN usuarios u ON m.usuario_id = u.id
        LEFT JOIN mensagens r ON m.reply_to_id = r.id
        LEFT JOIN usuarios ru ON r.usuario_id = ru.id
        WHERE m.id = ?
    ''', (cursor.lastrowid,)).fetchone()
    msg_dict = dict(msg)
    msg_dict['reacoes'] = []
    # Notify socket room
    socketio.emit('new_message', msg_dict, room=f"conv_{id}")
    return jsonify(msg_dict), 201


@app.route('/api/conversas/<int:id>/mensagens/busca', methods=['GET'])
@login_required
def buscar_mensagens(id):
    uid = get_user_id()
    db = get_db_g()

    termo = request.args.get('q', '').strip()
    if len(termo) < 2:
        return jsonify({'erro': 'Informe ao menos 2 caracteres para busca'}), 400

    limite = request.args.get('limite', '50')
    try:
        limite_int = min(max(int(limite), 1), 100)
    except ValueError:
        return jsonify({'erro': 'Parâmetro limite inválido'}), 400

    subtopico_id = request.args.get('subtopico_id', '').strip()

    is_member = db.execute(
        'SELECT 1 FROM conversa_membros WHERE conversa_id = ? AND usuario_id = ?',
        (id, uid)
    ).fetchone()
    if not is_member:
        return jsonify({'erro': 'Você não é membro desta conversa'}), 403

    like_termo = f"%{termo}%"
    if subtopico_id:
        query = '''
            SELECT m.*, COALESCE(NULLIF(u.nome, ''), u.username) as autor_nome, u.foto as autor_foto, u.username as autor_username,
                   r.conteudo as reply_content, COALESCE(NULLIF(ru.nome, ''), ru.username) as reply_author
            FROM mensagens m
            JOIN usuarios u ON m.usuario_id = u.id
            LEFT JOIN mensagens r ON m.reply_to_id = r.id
            LEFT JOIN usuarios ru ON r.usuario_id = ru.id
            WHERE m.conversa_id = ? AND m.subtopico_id = ? AND m.excluido_em IS NULL AND m.conteudo LIKE ?
            ORDER BY m.criado_em DESC
            LIMIT ?
        '''
        params = (id, int(subtopico_id), like_termo, limite_int)
    else:
        query = '''
            SELECT m.*, COALESCE(NULLIF(u.nome, ''), u.username) as autor_nome, u.foto as autor_foto, u.username as autor_username,
                   r.conteudo as reply_content, COALESCE(NULLIF(ru.nome, ''), ru.username) as reply_author
            FROM mensagens m
            JOIN usuarios u ON m.usuario_id = u.id
            LEFT JOIN mensagens r ON m.reply_to_id = r.id
            LEFT JOIN usuarios ru ON r.usuario_id = ru.id
            WHERE m.conversa_id = ? AND m.subtopico_id IS NULL AND m.excluido_em IS NULL AND m.conteudo LIKE ?
            ORDER BY m.criado_em DESC
            LIMIT ?
        '''
        params = (id, like_termo, limite_int)

    msgs = [dict(m) for m in db.execute(query, params).fetchall()]
    msgs.reverse()
    msgs = attach_reactions(db, msgs, uid)
    return jsonify(msgs)


@app.route('/api/mensagens/<int:msg_id>/reacoes', methods=['POST'])
@login_required
def reagir_mensagem(msg_id):
    uid = get_user_id()
    db = get_db_g()
    data = request.json or {}
    emoji = (data.get('emoji') or '').strip()

    if not emoji:
        return jsonify({'erro': 'Emoji é obrigatório'}), 400

    if len(emoji) > 16:
        return jsonify({'erro': 'Emoji inválido'}), 400

    msg = db.execute('SELECT id, conversa_id FROM mensagens WHERE id = ? AND excluido_em IS NULL', (msg_id,)).fetchone()
    if not msg:
        return jsonify({'erro': 'Mensagem não encontrada'}), 404

    is_member = db.execute(
        'SELECT 1 FROM conversa_membros WHERE conversa_id = ? AND usuario_id = ?',
        (msg['conversa_id'], uid)
    ).fetchone()
    if not is_member:
        return jsonify({'erro': 'Você não é membro desta conversa'}), 403

    existing = db.execute(
        'SELECT id FROM mensagem_reacoes WHERE mensagem_id = ? AND usuario_id = ? AND emoji = ?',
        (msg_id, uid, emoji)
    ).fetchone()

    if existing:
        db.execute('DELETE FROM mensagem_reacoes WHERE id = ?', (existing['id'],))
        action = 'removed'
    else:
        db.execute(
            'INSERT INTO mensagem_reacoes (mensagem_id, usuario_id, emoji, criado_em) VALUES (?, ?, ?, ?)',
            (msg_id, uid, emoji, agora_manaus().isoformat())
        )
        action = 'added'

    db.commit()
    reacoes = build_reactions_map(db, [msg_id], uid).get(msg_id, [])
    payload = {
        'mensagem_id': msg_id,
        'conversa_id': msg['conversa_id'],
        'reacoes': reacoes,
        'action': action,
        'emoji': emoji
    }
    socketio.emit('message_reaction_updated', payload, room=f"conv_{msg['conversa_id']}")
    return jsonify(payload)


@app.route('/api/chat/sync', methods=['GET'])
@login_required
def chat_sync():
    uid = get_user_id()
    db = get_db_g()
    after_id = request.args.get('after_id', 0)
    conversa_id = request.args.get('conversa_id')
    subtopico_id = request.args.get('subtopico_id')

    # 1. Fetch Conversations (Optimized)
    conversas_raw = db.execute('''
        SELECT c.*, 
            (SELECT m2.conteudo FROM mensagens m2 WHERE m2.conversa_id = c.id 
             ORDER BY m2.criado_em DESC LIMIT 1) as ultima_msg,
            (SELECT m3.criado_em FROM mensagens m3 WHERE m3.conversa_id = c.id 
             ORDER BY m3.criado_em DESC LIMIT 1) as ultima_msg_em,
            pm.conteudo as pinned_content, pm.media_url as pinned_media_url, COALESCE(NULLIF(u_pm.nome, ''), u_pm.username) as pinned_author
        FROM conversas c
        LEFT JOIN mensagens pm ON c.pinned_message_id = pm.id
        LEFT JOIN usuarios u_pm ON pm.usuario_id = u_pm.id
        WHERE c.id IN (
            SELECT conversa_id FROM conversa_membros WHERE usuario_id = ?
        )
        ORDER BY COALESCE(ultima_msg_em, c.criado_em) DESC
    ''', (uid,)).fetchall()

    conversas = []
    if conversas_raw:
        conv_ids = [c['id'] for c in conversas_raw]
        placeholders = ','.join(['?'] * len(conv_ids))
        membros_raw = db.execute(f'''
            SELECT cm.conversa_id, u.id, u.username, COALESCE(NULLIF(u.nome, ''), u.username) AS nome, u.foto, u.wallpaper, u.bio
            FROM conversa_membros cm 
            JOIN usuarios u ON cm.usuario_id = u.id
            WHERE cm.conversa_id IN ({placeholders})
        ''', conv_ids).fetchall()

        membros_by_conv = {}
        for m in membros_raw:
            cid = m['conversa_id']
            membros_by_conv.setdefault(cid, []).append(dict(m))

        for c in conversas_raw:
            conv: Dict[str, Any] = dict(c)
            m = membros_by_conv.get(c['id'], [])
            conv['membros'] = m
            if c['tipo'] == 'direto':
                others = [u for u in m if u['id'] != uid]
                if others:
                    other = others[0]
                    conv['display_nome'] = other['nome']
                    conv['display_foto'] = other['foto'] or ''
                    # Fallback para wallpaper
                    wp = conv.get('wallpaper')
                    if not wp or wp == '':
                        conv['wallpaper'] = other['wallpaper'] or ''
                else:
                    conv['display_nome'] = 'Minhas Anotações'
                    conv['display_foto'] = ''
            else:
                conv['display_nome'] = c['nome'] or 'Grupo'
                conv['display_foto'] = c['foto'] or ''
            
            # Context-aware pin for the active conversation
            if conversa_id and int(conversa_id) == c['id']:
                if subtopico_id:
                    # Overwrite pinned info with subtopic's pin
                    pin = db.execute('''
                        SELECT pm.id, pm.conteudo as pinned_content, pm.media_url as pinned_media_url, COALESCE(NULLIF(u_pm.nome, ''), u_pm.username) as pinned_author
                        FROM grupo_subtopicos gs
                        JOIN mensagens pm ON gs.pinned_message_id = pm.id
                        JOIN usuarios u_pm ON pm.usuario_id = u_pm.id
                        WHERE gs.id = ?
                    ''', (int(subtopico_id),)).fetchone()
                    if pin:
                        conv['pinned_message_id'] = pin['id']
                        conv['pinned_content'] = pin['pinned_content']
                        conv['pinned_author'] = pin['pinned_author']
                        conv['pinned_media_url'] = pin['pinned_media_url']
                    else:
                        conv['pinned_message_id'] = None
                        conv['pinned_content'] = None
                        conv['pinned_author'] = None
                else:
                    # We already have the 'General' pin from the main query join
                    pass

            conversas.append(conv)

    # 2. Fetch Messages (Incremental)
    mensagens = []
    if conversa_id:
        query = '''
            SELECT m.*, COALESCE(NULLIF(u.nome, ''), u.username) as autor_nome, u.foto as autor_foto,
                   r.conteudo as reply_content, COALESCE(NULLIF(ru.nome, ''), ru.username) as reply_author
            FROM mensagens m 
            JOIN usuarios u ON m.usuario_id = u.id
            LEFT JOIN mensagens r ON m.reply_to_id = r.id
            LEFT JOIN usuarios ru ON r.usuario_id = ru.id
            WHERE m.conversa_id = ? AND m.id > ?
        '''
        params = [int(conversa_id), int(after_id)]
        if subtopico_id:
            query += ' AND m.subtopico_id = ?'
            params.append(int(subtopico_id))
        else:
            query += ' AND m.subtopico_id IS NULL'
        
        query += ' AND m.excluido_em IS NULL ORDER BY m.criado_em ASC'
        mensagens = [dict(m) for m in db.execute(query, params).fetchall()]
        mensagens = attach_reactions(db, mensagens, uid)

    # 3. Handle Active Call Status
    # Update current user's call status via memory dict
    active_call_id = request.args.get('active_call_id')
    has_video = request.args.get('has_video', '0') == '1'
    now = agora_manaus()
    
    if active_call_id and active_call_id.isdigit():
        ACTIVE_CALLS[uid] = {
            'conversa_id': int(active_call_id),
            'has_video': has_video,
            'last_ping': now
        }
    else:
        ACTIVE_CALLS.pop(uid, None)
            
    # Cleanup idle callers (> 15s) and build response list for current conversa
    callers = []
    idle_threshold = now - timedelta(seconds=15)
    for u_id, data in list(ACTIVE_CALLS.items()):
        if isinstance(data.get('last_ping'), datetime) and data['last_ping'] < idle_threshold:
            ACTIVE_CALLS.pop(u_id, None)
        elif conversa_id and data['conversa_id'] == int(conversa_id):
            callers.append({'user_id': int(u_id), 'has_video': data.get('has_video', False)})

    # 4. Fetch Call Signals (WebRTC)
    sinais_raw = db.execute('''
        SELECT id, remetente_id, tipo, dados, conversa_id 
        FROM sinais_call 
        WHERE destinatario_id = ?
    ''', (uid,)).fetchall()
    
    sinais = []
    if sinais_raw:
        sinais = [dict(s) for s in sinais_raw]
        sinal_ids = [s['id'] for s in sinais]
        placeholders_sig = ','.join(['?'] * len(sinal_ids))
        db.execute(f'DELETE FROM sinais_call WHERE id IN ({placeholders_sig})', sinal_ids)
        db.commit()
        # Parse dados from JSON string to object for the frontend
        for s in sinais:
            try:
                s['dados'] = json.loads(s['dados'])
            except:
                pass

    # 5. Fetch Deleted Messages (Recently)
    # Use 5 minutes threshold for better reliability
    threshold = (agora_manaus() - timedelta(minutes=5)).isoformat()
    apagadas_raw = db.execute('''
        SELECT mensagem_id FROM mensagens_apagadas 
        WHERE conversa_id = ? AND apagado_em > ?
    ''', (conversa_id, threshold)).fetchall() if conversa_id else []
    
    deleted_ids = [row['mensagem_id'] for row in apagadas_raw]

    return jsonify({
        'conversas': conversas,
        'mensagens': mensagens,
        'sinais': sinais,
        'active_callers': callers,
        'deleted_ids': deleted_ids
    })


# ══════════════════════════════════════════════
#  API — Chamadas (WebRTC Signaling)
# ══════════════════════════════════════════════
@app.route('/api/calls/signal', methods=['POST'])
@login_required
def send_signal():
    uid = get_user_id()
    data = request.json
    destinatario_id = data.get('destinatario_id')
    conversa_id = data.get('conversa_id')
    tipo = data.get('tipo')
    dados = data.get('dados')

    if not destinatario_id or not tipo or dados is None:
        return jsonify({'erro': 'Dados incompletos'}), 400

    # Signal via SocketIO
    socketio.emit('call_signal', {
        'remetente_id': uid,
        'tipo': tipo,
        'dados': dados,
        'conversa_id': conversa_id
    }, room=f"user_{destinatario_id}")

    return jsonify({'ok': True})


@app.route('/api/conversas/mensagens/<int:msg_id>', methods=['DELETE'])
@login_required
def deletar_mensagem(msg_id):
    uid = get_user_id()
    db = get_db_g()
    msg = db.execute('SELECT conversa_id, usuario_id, media_url FROM mensagens WHERE id = ?', (msg_id,)).fetchone()
    if not msg:
        return jsonify({'erro': 'Mensagem não encontrada'}), 404
    
    if msg['usuario_id'] != uid:
        return jsonify({'erro': 'Você só pode apagar suas próprias mensagens'}), 403
    
    # Se a mensagem tiver uma mídia que foi enviada pro servidor (uploads), exclua o arquivo físico
    if msg and msg['media_url'] and msg['media_url'].startswith('/static/uploads/'):
        filename = msg['media_url'].split('/')[-1]
        filepath = os.path.join(UPLOAD_DIR, filename)
        if os.path.exists(filepath):
            try:
                os.remove(filepath)
            except Exception as e:
                print(f"Erro ao excluir arquivo de mídia: {e}")

    # Log deletion for sync using SAME timestamp format as threshold
    db.execute('INSERT INTO mensagens_apagadas (mensagem_id, conversa_id, apagado_em) VALUES (?, ?, ?)', 
               (msg_id, msg['conversa_id'], agora_manaus().isoformat()))
    
    # Soft delete: mark as excluded instead of deleting
    db.execute('UPDATE mensagens SET excluido_em = ? WHERE id = ?', (agora_manaus().isoformat(), msg_id))
    db.commit()

    socketio.emit('message_deleted', {'id': msg_id}, room=f"conv_{msg['conversa_id']}")

    return jsonify({'status': 'ok'}), 200


@app.route('/api/conversas/mensagens/<int:msg_id>/restaurar', methods=['POST'])
@login_required
def restaurar_mensagem(msg_id):
    uid = get_user_id()
    db = get_db_g()
    msg = db.execute('SELECT conversa_id, usuario_id FROM mensagens WHERE id = ?', (msg_id,)).fetchone()
    if not msg:
        return jsonify({'erro': 'Mensagem não encontrada'}), 404
    
    if msg['usuario_id'] != uid:
        return jsonify({'erro': 'Você só pode restaurar suas próprias mensagens'}), 403
    
    db.execute('UPDATE mensagens SET excluido_em = NULL WHERE id = ?', (msg_id,))
    # Remove from sync log so clients can see it again
    db.execute('DELETE FROM mensagens_apagadas WHERE mensagem_id = ?', (msg_id,))
    db.commit()

    # Fetch full message to notify clients
    res_msg = db.execute('''
        SELECT m.*, COALESCE(NULLIF(u.nome, ''), u.username) as autor_nome, u.foto as autor_foto, u.username as autor_username,
        r.media_url as reply_media, r.conteudo as reply_content, COALESCE(NULLIF(ru.nome, ''), ru.username) as reply_author
        FROM mensagens m 
        JOIN usuarios u ON m.usuario_id = u.id
        LEFT JOIN mensagens r ON m.reply_to_id = r.id
        LEFT JOIN usuarios ru ON r.usuario_id = ru.id
        WHERE m.id = ?
    ''', (msg_id,)).fetchone()
    
    msg_dict = dict(res_msg)
    msg_dict['reacoes'] = []
    socketio.emit('new_message', msg_dict, room=f"conv_{msg['conversa_id']}")
    
    return jsonify({'status': 'ok', 'mensagem': msg_dict}), 200


@app.route('/api/conversas/<int:id>/lixeira', methods=['GET'])
@login_required
def lixeira_mensagens(id):
    uid = get_user_id()
    db = get_db_g()
    msgs = db.execute('''
        SELECT m.*, COALESCE(NULLIF(u.nome, ''), u.username) as autor_nome, u.foto as autor_foto, u.username as autor_username
        FROM mensagens m 
        JOIN usuarios u ON m.usuario_id = u.id
        WHERE m.conversa_id = ? AND m.usuario_id = ? AND m.excluido_em IS NOT NULL
        ORDER BY m.excluido_em DESC
    ''', (id, uid)).fetchall()
    return jsonify([dict(m) for m in msgs])


@app.route('/api/conversas/<int:id>/pin', methods=['POST'])
@login_required
def fixar_mensagem(id):
    data = request.json
    msg_id = data.get('mensagem_id')
    subtopico_id = data.get('subtopico_id') # Explicit context for unpinning Geral vs Subtopic
    db = get_db_g()
    
    if msg_id:
        # Fetch message to find its subtopic
        msg = db.execute('SELECT subtopico_id FROM mensagens WHERE id = ? AND conversa_id = ?', (msg_id, id)).fetchone()
        if not msg:
            return jsonify({'erro': 'Mensagem não encontrada nesta conversa'}), 404
        
        target_subtopic = msg['subtopico_id']
        if target_subtopic:
            db.execute('UPDATE grupo_subtopicos SET pinned_message_id = ? WHERE id = ?', (msg_id, target_subtopic))
        else:
            db.execute('UPDATE conversas SET pinned_message_id = ? WHERE id = ?', (msg_id, id))
    else:
        # Unpinning requires knowing which context to clear
        if subtopico_id:
            db.execute('UPDATE grupo_subtopicos SET pinned_message_id = NULL WHERE id = ?', (subtopico_id,))
        else:
            db.execute('UPDATE conversas SET pinned_message_id = NULL WHERE id = ?', (id,))

    db.commit()
    socketio.emit('pinned_update', {'conversa_id': id, 'subtopico_id': subtopico_id}, room=f"conv_{id}")
    return jsonify({'ok': True})


@app.route('/api/conversas/<int:id>/media', methods=['POST'])
@login_required
def upload_media_chat(id):
    if 'media' not in request.files:
        return jsonify({'erro': 'Nenhum arquivo enviado'}), 400

    file = request.files['media']
    if not file or not file.filename:
        return jsonify({'erro': 'Arquivo inválido'}), 400

    ext = file.filename.rsplit('.', 1)[1].lower() if '.' in file.filename else ''
    allowed = {'jpg', 'jpeg', 'png', 'webp', 'gif', 'mp4', 'webm', 'mov'}
    if ext not in allowed:
        return jsonify({'erro': 'Formato não suportado: ' + ', '.join(allowed).upper()}), 400

    filename = f"chat_{uuid.uuid4().hex}.{ext}"
    filepath = os.path.join(UPLOAD_DIR, filename)
    file.save(filepath)

    # Compress chat images (1920px max), skips videos and GIFs
    if ext not in ('mp4', 'webm', 'mov'):
        filepath = compress_image(filepath, max_size=1920, quality=80)
        filename = os.path.basename(filepath)

    media_url = f"/static/uploads/{filename}"
    return jsonify({'media_url': media_url})


# ══════════════════════════════════════════════
#  API — Subtópicos de Grupo
# ══════════════════════════════════════════════
@app.route('/api/conversas/<int:id>/subtopicos', methods=['GET'])
@login_required
def listar_subtopicos(id):
    db = get_db_g()
    subs = db.execute(
        'SELECT * FROM grupo_subtopicos WHERE conversa_id = ? ORDER BY ordem, nome', (id,)
    ).fetchall()
    return jsonify([dict(s) for s in subs])


@app.route('/api/conversas/<int:id>/subtopicos', methods=['POST'])
@login_required
def criar_subtopico(id):
    uid = get_user_id()
    data = request.json
    nome = data.get('nome', '').strip()
    if not nome:
        return jsonify({'erro': 'Nome obrigatório'}), 400

    db = get_db_g()
    cursor = db.execute(
        'INSERT INTO grupo_subtopicos (conversa_id, nome, descricao, cor, ordem, criado_por, criado_em) VALUES (?, ?, ?, ?, ?, ?, ?)',
        (id, nome, data.get('descricao', ''), data.get('cor', '#6366f1'), data.get('ordem', 0), uid, agora_manaus().isoformat())
    )
    db.commit()
    sub = db.execute('SELECT * FROM grupo_subtopicos WHERE id = ?', (cursor.lastrowid,)).fetchone()
    return jsonify(dict(sub)), 201


@app.route('/api/subtopicos/<int:id>', methods=['PUT'])
@login_required
def editar_subtopico(id):
    data = request.json
    db = get_db_g()
    uid = get_user_id()
    
    # Security: Verify membership of the parent conversation
    sub_info = db.execute('SELECT conversa_id FROM grupo_subtopicos WHERE id = ?', (id,)).fetchone()
    if not sub_info:
        return jsonify({'erro': 'Subtópico não encontrado'}), 404
        
    is_member = db.execute('SELECT 1 FROM conversa_membros WHERE conversa_id = ? AND usuario_id = ?', 
                           (sub_info['conversa_id'], uid)).fetchone()
    if not is_member:
        return jsonify({'erro': 'Não autorizado'}), 403

    db.execute(
        'UPDATE grupo_subtopicos SET nome=?, descricao=?, cor=? WHERE id=?',
        (data.get('nome', ''), data.get('descricao', ''), data.get('cor', '#6366f1'), id)
    )
    db.commit()
    sub = db.execute('SELECT * FROM grupo_subtopicos WHERE id = ?', (id,)).fetchone()
    return jsonify(dict(sub))


@app.route('/api/subtopicos/<int:id>', methods=['DELETE'])
@login_required
def deletar_subtopico(id):
    db = get_db_g()
    uid = get_user_id()
    
    # Security: Verify membership of the parent conversation
    sub_info = db.execute('SELECT conversa_id FROM grupo_subtopicos WHERE id = ?', (id,)).fetchone()
    if not sub_info:
        return jsonify({'erro': 'Subtópico não encontrado'}), 404
        
    is_member = db.execute('SELECT 1 FROM conversa_membros WHERE conversa_id = ? AND usuario_id = ?', 
                           (sub_info['conversa_id'], uid)).fetchone()
    if not is_member:
        return jsonify({'erro': 'Não autorizado'}), 403

    db.execute('DELETE FROM grupo_subtopicos WHERE id = ?', (id,))
    db.commit()
    return jsonify({'ok': True})


@app.route('/api/conversas/<int:id>/subtopicos/reordenar', methods=['PUT'])
@login_required
def reordenar_subtopicos(id):
    db = get_db_g()
    # Verifica se o usuário tem permissão (é membro da conversa)
    uid = get_user_id()
    is_member = db.execute('SELECT 1 FROM conversa_membros WHERE conversa_id = ? AND usuario_id = ?', (id, uid)).fetchone()
    if not is_member:
        return jsonify({'erro': 'Não autorizado'}), 403

    nova_ordem = request.json.get('ordem', [])
    for idx, sub_id in enumerate(nova_ordem):
        db.execute('UPDATE grupo_subtopicos SET ordem = ? WHERE id = ? AND conversa_id = ?', (idx, sub_id, id))
    db.commit()
    socketio.emit('subtopic_reordered', {'conversa_id': id}, room=f"conv_{id}")
    return jsonify({'ok': True})




# ══════════════════════════════════════════════
#  API — Agenda (user-scoped)
# ══════════════════════════════════════════════
@app.route('/api/agenda', methods=['GET'])
@login_required
def listar_eventos():
    uid = get_user_id()
    db = get_db_g()
    mes = request.args.get('mes')
    ano = request.args.get('ano')
    if mes and ano:
        eventos = db.execute(
            """SELECT * FROM agenda_eventos WHERE usuario_id = ?
               AND strftime('%m', data)=? AND strftime('%Y', data)=?
               ORDER BY data, hora_inicio""",
            (uid, mes.zfill(2), ano)
        ).fetchall()
    else:
        eventos = db.execute(
            'SELECT * FROM agenda_eventos WHERE usuario_id = ? ORDER BY data DESC, hora_inicio',
            (uid,)
        ).fetchall()
    return jsonify([dict(e) for e in eventos])


@app.route('/api/agenda', methods=['POST'])
@login_required
def criar_evento():
    uid = get_user_id()
    data = request.json
    db = get_db_g()
    cursor = db.execute(
        '''INSERT INTO agenda_eventos (usuario_id, materia_id, titulo, descricao, data, hora_inicio, hora_fim, cor)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?)''',
        (uid, data.get('materia_id'), data['titulo'], data.get('descricao', ''),
         data['data'], data.get('hora_inicio'), data.get('hora_fim'),
         data.get('cor', '#6366f1'))
    )
    db.commit()
    evento = db.execute('SELECT * FROM agenda_eventos WHERE id = ?', (cursor.lastrowid,)).fetchone()
    return jsonify(dict(evento)), 201


@app.route('/api/agenda/<int:id>', methods=['PUT'])
@login_required
def atualizar_evento(id):
    data = request.json
    db = get_db_g()
    db.execute(
        '''UPDATE agenda_eventos SET materia_id=?, titulo=?, descricao=?, data=?,
           hora_inicio=?, hora_fim=?, concluido=?, cor=? WHERE id=?''',
        (data.get('materia_id'), data['titulo'], data.get('descricao', ''),
         data['data'], data.get('hora_inicio'), data.get('hora_fim'),
         data.get('concluido', 0), data.get('cor', '#6366f1'), id)
    )
    db.commit()
    evento = db.execute('SELECT * FROM agenda_eventos WHERE id = ?', (id,)).fetchone()
    return jsonify(dict(evento))


@app.route('/api/agenda/<int:id>', methods=['DELETE'])
@login_required
def deletar_evento(id):
    db = get_db_g()
    db.execute('DELETE FROM agenda_eventos WHERE id = ?', (id,))
    db.commit()
    return jsonify({'ok': True})


@app.route('/api/agenda/<int:id>/concluir', methods=['POST'])
@login_required
def concluir_evento(id):
    db = get_db_g()
    db.execute('UPDATE agenda_eventos SET concluido = 1 WHERE id = ?', (id,))
    db.commit()
    return jsonify({'ok': True})


# ══════════════════════════════════════════════
#  API — Sessões de Estudo (user-scoped)
# ══════════════════════════════════════════════
@app.route('/api/sessoes', methods=['GET'])
@login_required
def listar_sessoes():
    uid = get_user_id()
    db = get_db_g()
    data_filtro = request.args.get('data')
    if data_filtro:
        sessoes = db.execute(
            'SELECT * FROM sessoes_estudo WHERE usuario_id = ? AND data = ? ORDER BY criado_em DESC',
            (uid, data_filtro)
        ).fetchall()
    else:
        sessoes = db.execute(
            'SELECT * FROM sessoes_estudo WHERE usuario_id = ? ORDER BY criado_em DESC LIMIT 100',
            (uid,)
        ).fetchall()
    return jsonify([dict(s) for s in sessoes])


@app.route('/api/sessoes', methods=['POST'])
@login_required
def registrar_sessao():
    uid = get_user_id()
    data = request.json
    db = get_db_g()
    cursor = db.execute(
        'INSERT INTO sessoes_estudo (usuario_id, materia_id, duracao_minutos, tipo, data) VALUES (?, ?, ?, ?, ?)',
        (uid, data.get('materia_id'), data['duracao_minutos'],
         data.get('tipo', 'pomodoro'), data.get('data', agora_manaus().strftime('%Y-%m-%d')))
    )
    db.commit()
    sessao = db.execute('SELECT * FROM sessoes_estudo WHERE id = ?', (cursor.lastrowid,)).fetchone()
    return jsonify(dict(sessao)), 201


# ══════════════════════════════════════════════
#  API — Simulados (user-scoped)
# ══════════════════════════════════════════════
@app.route('/api/simulados', methods=['GET'])
@login_required
def listar_simulados():
    uid = get_user_id()
    db = get_db_g()
    simulados = db.execute(
        'SELECT * FROM simulados WHERE usuario_id = ? ORDER BY criado_em DESC', (uid,)
    ).fetchall()
    result = []
    for s in simulados:
        respostas = db.execute(
            'SELECT COUNT(*) as total, SUM(correto) as acertos FROM respostas WHERE simulado_id = ?',
            (s['id'],)
        ).fetchone()
        result.append({**dict(s), 'total_questoes': respostas['total'] or 0,
                       'acertos': respostas['acertos'] or 0})
    return jsonify(result)


@app.route('/api/simulados', methods=['POST'])
@login_required
def criar_simulado():
    uid = get_user_id()
    data = request.json
    db = get_db_g()
    cursor = db.execute(
        'INSERT INTO simulados (usuario_id, titulo, tempo_limite_minutos) VALUES (?, ?, ?)',
        (uid, data['titulo'], data.get('tempo_limite_minutos'))
    )
    db.commit()
    simulado = db.execute('SELECT * FROM simulados WHERE id = ?', (cursor.lastrowid,)).fetchone()
    return jsonify(dict(simulado)), 201


@app.route('/api/simulados/<int:id>/responder', methods=['POST'])
@login_required
def responder_simulado(id):
    data = request.json
    respostas = data.get('respostas', [])
    db = get_db_g()
    for r in respostas:
        questao = db.execute('SELECT resposta_correta FROM questoes WHERE id = ?', (r['questao_id'],)).fetchone()
        correto = 1 if questao and questao['resposta_correta'] == r['resposta_dada'] else 0
        db.execute(
            'INSERT INTO respostas (simulado_id, questao_id, resposta_dada, correto) VALUES (?, ?, ?, ?)',
            (id, r['questao_id'], r['resposta_dada'], correto)
        )
    db.commit()
    return jsonify({'ok': True})


@app.route('/api/simulados/<int:id>', methods=['DELETE'])
@login_required
def deletar_simulado(id):
    db = get_db_g()
    db.execute('DELETE FROM respostas WHERE simulado_id = ?', (id,))
    db.execute('DELETE FROM simulados WHERE id = ?', (id,))
    db.commit()
    return jsonify({'ok': True})


# ══════════════════════════════════════════════
#  API — Dashboard / Analytics (user-scoped)
# ══════════════════════════════════════════════
@app.route('/api/dashboard', methods=['GET'])
@login_required
def dashboard():
    uid = get_user_id()
    db = get_db_g()
    hoje = agora_manaus().strftime('%Y-%m-%d')

    horas_hoje = db.execute(
        'SELECT COALESCE(SUM(duracao_minutos), 0) as total FROM sessoes_estudo WHERE usuario_id = ? AND data = ?',
        (uid, hoje)
    ).fetchone()['total'] / 60

    questoes_hoje = db.execute(
        """SELECT COUNT(*) as total, COALESCE(SUM(correto), 0) as acertos FROM respostas r
           JOIN simulados s ON r.simulado_id = s.id
           WHERE s.usuario_id = ? AND date(r.respondido_em) = ?""",
        (uid, hoje)
    ).fetchone()

    total_materias = db.execute(
        'SELECT COUNT(*) as total FROM materias WHERE usuario_id = ?', (uid,)
    ).fetchone()['total']

    cards_revisar = db.execute(
        '''SELECT COUNT(*) as total FROM flashcards f JOIN materias m ON f.materia_id = m.id
           WHERE m.usuario_id = ? AND f.proxima_revisao <= ?''',
        (uid, agora_manaus().isoformat())
    ).fetchone()['total']

    eventos_hoje = db.execute(
        'SELECT * FROM agenda_eventos WHERE usuario_id = ? AND data = ? ORDER BY hora_inicio',
        (uid, hoje)
    ).fetchall()

    # Optimized Streak Calculation (single query for recent activity)
    # We fetch dates of study sessions in descending order and count consecutive days from today/yesterday
    recent_sessions = db.execute('''
        SELECT DISTINCT data FROM sessoes_estudo 
        WHERE usuario_id = ? AND data <= ?
        ORDER BY data DESC LIMIT 400
    ''', (uid, hoje)).fetchall()

    streak = 0
    if recent_sessions:
        last_date = agora_manaus().date()
        # If no session today, check if streak continued until yesterday
        if recent_sessions[0]['data'] != hoje:
            yesterday = (agora_manaus() - timedelta(days=1)).strftime('%Y-%m-%d')
            if recent_sessions[0]['data'] == yesterday:
                last_date = (agora_manaus() - timedelta(days=1)).date()
            else:
                last_date = None # Streak broken
        
        if last_date:
            for sess in recent_sessions:
                sess_date = datetime.strptime(sess['data'], '%Y-%m-%d').date()
                if sess_date == last_date:
                    streak += 1
                    last_date -= timedelta(days=1)
                else:
                    break

    # Optimized: single query for the whole week
    data_inicio_semana = (agora_manaus() - timedelta(days=6)).strftime('%Y-%m-%d')
    horas_semana_raw = db.execute('''
        SELECT data, COALESCE(SUM(duracao_minutos), 0)/60.0 as horas
        FROM sessoes_estudo
        WHERE usuario_id = ? AND data >= ?
        GROUP BY data
    ''', (uid, data_inicio_semana)).fetchall()
    horas_map = {row['data']: round(row['horas'], 1) for row in horas_semana_raw}
    horas_semana = []
    for i in range(6, -1, -1):
        d = (agora_manaus() - timedelta(days=i)).strftime('%Y-%m-%d')
        horas_semana.append({'data': d, 'horas': horas_map.get(d, 0)})

    return jsonify({
        'horas_hoje': round(horas_hoje, 1),
        'questoes_hoje': questoes_hoje['total'] or 0,
        'acertos_hoje': questoes_hoje['acertos'] or 0,
        'total_materias': total_materias,
        'cards_revisar': cards_revisar,
        'eventos_hoje': [dict(e) for e in eventos_hoje],
        'streak': streak,
        'horas_semana': horas_semana
    })


@app.route('/api/analytics', methods=['GET'])
@login_required
def analytics():
    uid = get_user_id()
    db = get_db_g()

    horas_materia = db.execute('''
        SELECT m.nome, m.cor, COALESCE(SUM(s.duracao_minutos), 0)/60.0 as horas
        FROM materias m LEFT JOIN sessoes_estudo s ON m.id = s.materia_id
        WHERE m.usuario_id = ? GROUP BY m.id ORDER BY horas DESC
    ''', (uid,)).fetchall()

    acertos_materia = db.execute('''
        SELECT m.nome, m.cor, COUNT(r.id) as total, COALESCE(SUM(r.correto), 0) as acertos
        FROM materias m
        LEFT JOIN questoes q ON m.id = q.materia_id
        LEFT JOIN respostas r ON q.id = r.questao_id
        WHERE m.usuario_id = ? GROUP BY m.id ORDER BY m.nome
    ''', (uid,)).fetchall()

    # Optimized: single query for the whole month
    data_inicio_mes = (agora_manaus() - timedelta(days=29)).strftime('%Y-%m-%d')
    horas_mes_raw = db.execute('''
        SELECT data, COALESCE(SUM(duracao_minutos), 0)/60.0 as horas
        FROM sessoes_estudo
        WHERE usuario_id = ? AND data >= ?
        GROUP BY data
    ''', (uid, data_inicio_mes)).fetchall()
    horas_mes_map = {row['data']: round(row['horas'], 1) for row in horas_mes_raw}
    horas_mes = []
    for i in range(29, -1, -1):
        d = (agora_manaus() - timedelta(days=i)).strftime('%Y-%m-%d')
        horas_mes.append({'data': d, 'horas': horas_mes_map.get(d, 0)})

    return jsonify({
        'horas_materia': [dict(h) for h in horas_materia],
        'acertos_materia': [dict(a) for a in acertos_materia],
        'horas_mes': horas_mes
    })


# ══════════════════════════════════════════════
#  API — Metas (user-scoped)
# ══════════════════════════════════════════════
@app.route('/api/metas', methods=['GET'])
@login_required
def obter_meta():
    uid = get_user_id()
    db = get_db_g()
    hoje = agora_manaus().strftime('%Y-%m-%d')
    meta = db.execute('SELECT * FROM metas WHERE usuario_id = ? AND data = ?', (uid, hoje)).fetchone()
    if not meta:
        db.execute(
            'INSERT INTO metas (usuario_id, data, horas_meta, questoes_meta) VALUES (?, ?, 4.0, 30)',
            (uid, hoje)
        )
        db.commit()
        meta = db.execute('SELECT * FROM metas WHERE usuario_id = ? AND data = ?', (uid, hoje)).fetchone()
    return jsonify(dict(meta))


@app.route('/api/metas', methods=['PUT'])
@login_required
def atualizar_meta():
    uid = get_user_id()
    data = request.json
    db = get_db_g()
    hoje = agora_manaus().strftime('%Y-%m-%d')
    db.execute(
        'UPDATE metas SET horas_meta=?, questoes_meta=? WHERE usuario_id=? AND data=?',
        (data.get('horas_meta', 4.0), data.get('questoes_meta', 30), uid, hoje)
    )
    db.commit()
    return jsonify({'ok': True})


# ══════════════════════════════════════════════
#  SocketIO Events
# ══════════════════════════════════════════════
@socketio.on('join')
def on_join(data):
    user_id = session.get('usuario_id')
    if not user_id: return
    # Join user-specific room for signals
    join_room(f"user_{user_id}")
    
    db = get_db()
    # Join conversation rooms
    conv_id = data.get('conversa_id')
    if conv_id:
        # Security: Verify user is a member of this conversation
        is_member = db.execute('SELECT 1 FROM conversa_membros WHERE conversa_id = ? AND usuario_id = ?', 
                               (conv_id, user_id)).fetchone()
        if is_member:
            join_room(f"conv_{conv_id}")
    db.close()

@socketio.on('join_conv')
def on_join_conv(data):
    user_id = session.get('usuario_id')
    if not user_id: return
    
    conv_id = data.get('conversa_id')
    if conv_id:
        db = get_db() # Needs a fresh connection if outside app context or use current_app
        is_member = db.execute('SELECT 1 FROM conversa_membros WHERE conversa_id = ? AND usuario_id = ?', 
                               (conv_id, user_id)).fetchone()
        db.close()
        if is_member:
            join_room(f"conv_{conv_id}")

@socketio.on('leave_conv')
def on_leave_conv(data):
    conv_id = data.get('conversa_id')
    if conv_id:
        leave_room(f"conv_{conv_id}")

# ══════════════════════════════════════════════
#  Iniciar o servidor
# ══════════════════════════════════════════════
if __name__ == '__main__':
    print("TocaDoConhecimento rodando em http://localhost:3000 (com WebSockets)")
    socketio.run(app, host='0.0.0.0', port=3000, debug=False)
