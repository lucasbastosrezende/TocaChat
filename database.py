import sqlite3
import os
from datetime import datetime

DB_PATH = os.path.join(os.path.dirname(os.path.abspath(__file__)), 'toca.db')


def get_db():
    """Retorna uma conexão com o banco de dados SQLite."""
    conn = sqlite3.connect(DB_PATH)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA journal_mode=WAL")
    conn.execute("PRAGMA foreign_keys=ON")
    return conn


def init_db():
    """Cria todas as tabelas do banco de dados."""
    conn = get_db()
    cursor = conn.cursor()

    # ══════════════════════════════════════════
    #  AUTENTICAÇÃO & PERFIS
    # ══════════════════════════════════════════

    cursor.execute('''
        CREATE TABLE IF NOT EXISTS usuarios (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            username TEXT NOT NULL UNIQUE,
            email TEXT NOT NULL UNIQUE,
            senha_hash TEXT NOT NULL,
            nome TEXT NOT NULL,
            bio TEXT DEFAULT '',
            foto TEXT DEFAULT '',
            criado_em TEXT DEFAULT (datetime('now')),
            atualizado_em TEXT DEFAULT (datetime('now'))
        )
    ''')

    # ══════════════════════════════════════════
    #  CHAT & MENSAGENS
    # ══════════════════════════════════════════

    cursor.execute('''
        CREATE TABLE IF NOT EXISTS conversas (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            tipo TEXT DEFAULT 'direto',
            nome TEXT DEFAULT '',
            descricao TEXT DEFAULT '',
            foto TEXT DEFAULT '',
            criado_por INTEGER,
            pinned_message_id INTEGER,
            criado_em TEXT DEFAULT (datetime('now')),
            atualizado_em TEXT DEFAULT (datetime('now')),
            FOREIGN KEY (criado_por) REFERENCES usuarios(id) ON DELETE SET NULL,
            FOREIGN KEY (pinned_message_id) REFERENCES mensagens(id) ON DELETE SET NULL
        )
    ''')

    cursor.execute('''
        CREATE TABLE IF NOT EXISTS conversa_membros (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            conversa_id INTEGER NOT NULL,
            usuario_id INTEGER NOT NULL,
            adicionado_em TEXT DEFAULT (datetime('now')),
            FOREIGN KEY (conversa_id) REFERENCES conversas(id) ON DELETE CASCADE,
            FOREIGN KEY (usuario_id) REFERENCES usuarios(id) ON DELETE CASCADE,
            UNIQUE(conversa_id, usuario_id)
        )
    ''')

    cursor.execute('''
        CREATE TABLE IF NOT EXISTS mensagens (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            conversa_id INTEGER NOT NULL,
            usuario_id INTEGER NOT NULL,
            conteudo TEXT NOT NULL DEFAULT '',
            subtopico_id INTEGER,
            media_url TEXT DEFAULT '',
            reply_to_id INTEGER,
            criado_em TEXT DEFAULT (datetime('now')),
            excluido_em TEXT DEFAULT NULL,
            FOREIGN KEY (conversa_id) REFERENCES conversas(id) ON DELETE CASCADE,
            FOREIGN KEY (usuario_id) REFERENCES usuarios(id) ON DELETE CASCADE,
            FOREIGN KEY (reply_to_id) REFERENCES mensagens(id) ON DELETE SET NULL,
            FOREIGN KEY (subtopico_id) REFERENCES grupo_subtopicos(id) ON DELETE SET NULL
        )
    ''')

    cursor.execute('''
        CREATE TABLE IF NOT EXISTS grupo_subtopicos (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            conversa_id INTEGER NOT NULL,
            nome TEXT NOT NULL,
            descricao TEXT DEFAULT '',
            cor TEXT DEFAULT '#6366f1',
            ordem INTEGER DEFAULT 0,
            criado_por INTEGER,
            pinned_message_id INTEGER,
            criado_em TEXT DEFAULT (datetime('now')),
            FOREIGN KEY (conversa_id) REFERENCES conversas(id) ON DELETE CASCADE,
            FOREIGN KEY (criado_por) REFERENCES usuarios(id) ON DELETE SET NULL,
            FOREIGN KEY (pinned_message_id) REFERENCES mensagens(id) ON DELETE SET NULL
        )
    ''')

    cursor.execute('''
        CREATE TABLE IF NOT EXISTS sinais_call (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            conversa_id INTEGER NOT NULL,
            remetente_id INTEGER NOT NULL,
            destinatario_id INTEGER NOT NULL,
            tipo TEXT NOT NULL,
            dados TEXT NOT NULL,
            criado_em TEXT DEFAULT (datetime('now')),
            FOREIGN KEY (conversa_id) REFERENCES conversas(id) ON DELETE CASCADE,
            FOREIGN KEY (remetente_id) REFERENCES usuarios(id) ON DELETE CASCADE,
            FOREIGN KEY (destinatario_id) REFERENCES usuarios(id) ON DELETE CASCADE
        )
    ''')

    # ── Safe column migrations (never lose data) ──
    migrations = [
        ('mensagens', 'subtopico_id', 'INTEGER'),
        ('mensagens', 'media_url', "TEXT DEFAULT ''"),
        ('mensagens', 'reply_to_id', 'INTEGER'),
        ('usuarios', 'wallpaper', "TEXT DEFAULT ''"),
        ('conversas', 'wallpaper', "TEXT DEFAULT ''"),
        ('conversas', 'pinned_message_id', 'INTEGER'),
        ('grupo_subtopicos', 'pinned_message_id', 'INTEGER'),
        ('mensagens', 'excluido_em', 'TEXT DEFAULT NULL'),
    ]
    for table, col, col_type in migrations:
        try:
            cursor.execute(f'ALTER TABLE {table} ADD COLUMN {col} {col_type}')
        except Exception:
            pass  # column already exists

    # ── Performance Indexes ──
    cursor.execute('CREATE INDEX IF NOT EXISTS idx_mensagens_conversa_sub ON mensagens(conversa_id, subtopico_id)')
    cursor.execute('CREATE INDEX IF NOT EXISTS idx_mensagens_conversa_criado ON mensagens(conversa_id, criado_em)')
    # Composite index optimized for "WHERE conversa_id = ? AND id > ?" queries
    cursor.execute('CREATE INDEX IF NOT EXISTS idx_mensagens_conversa_id ON mensagens(conversa_id, id)')
    cursor.execute('CREATE INDEX IF NOT EXISTS idx_conversa_membros_usuario ON conversa_membros(usuario_id, conversa_id)')
    cursor.execute('CREATE INDEX IF NOT EXISTS idx_usuarios_username ON usuarios(username)')
    cursor.execute('CREATE INDEX IF NOT EXISTS idx_mensagens_reply ON mensagens(reply_to_id)')

    cursor.execute('CREATE INDEX IF NOT EXISTS idx_mensagens_criado ON mensagens(criado_em)')
    cursor.execute('CREATE INDEX IF NOT EXISTS idx_sinais_destinatario ON sinais_call(destinatario_id)')

    cursor.execute('''
            CREATE TABLE IF NOT EXISTS mensagens_apagadas (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                mensagem_id INTEGER,
                conversa_id INTEGER,
                apagado_em TEXT DEFAULT (datetime('now'))
            )
        ''')

    conn.commit()
    conn.close()
    print("Banco de dados inicializado com sucesso!")


if __name__ == '__main__':
    init_db()
