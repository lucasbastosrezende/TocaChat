/* ═══════════════════════════════════════════════
   Dashboard Module
   ═══════════════════════════════════════════════ */

window.addEventListener('pageChange', (e) => {
    if (e.detail.page === 'dashboard') loadDashboard();
});

async function loadDashboard() {
    // Set date
    const now = new Date();
    const dateStr = now.toLocaleDateString('pt-BR', {
        weekday: 'long', day: 'numeric', month: 'long', year: 'numeric'
    });
    document.getElementById('dashboardDate').textContent =
        dateStr.charAt(0).toUpperCase() + dateStr.slice(1);

    try {
        const [data, meta] = await Promise.all([
            api('/api/dashboard'),
            api('/api/metas')
        ]);

        // Stats
        document.getElementById('statHoras').textContent = `${data.horas_hoje}h`;
        document.getElementById('statQuestoes').textContent = data.questoes_hoje;
        document.getElementById('statCards').textContent = data.cards_revisar;
        document.getElementById('statMaterias').textContent = data.total_materias;

        // Streak
        document.getElementById('streakCount').textContent = data.streak;

        // Progress bars
        const horasPct = Math.min((data.horas_hoje / meta.horas_meta) * 100, 100);
        const questoesPct = Math.min((data.questoes_hoje / meta.questoes_meta) * 100, 100);
        document.getElementById('progressHoras').style.width = `${horasPct}%`;
        document.getElementById('progressQuestoes').style.width = `${questoesPct}%`;

        // Weekly chart
        renderWeekChart(data.horas_semana);

        // Today's events
        renderTodayEvents(data.eventos_hoje);

    } catch (err) {
        console.error('Dashboard error:', err);
    }
}

function renderWeekChart(horasSemana) {
    const container = document.getElementById('weekChart');
    const maxVal = Math.max(...horasSemana.map(h => h.horas), 1);

    container.innerHTML = horasSemana.map(item => {
        const pct = (item.horas / maxVal) * 100;
        const dia = new Date(item.data + 'T00:00:00');
        const label = dia.toLocaleDateString('pt-BR', { weekday: 'short' });
        return `
            <div class="chart-bar-wrapper">
                <span class="chart-bar-value">${item.horas}h</span>
                <div class="chart-bar" style="height: ${Math.max(pct, 3)}%"></div>
                <span class="chart-bar-label">${label}</span>
            </div>
        `;
    }).join('');
}

function renderTodayEvents(eventos) {
    const container = document.getElementById('eventosHoje');

    if (!eventos || eventos.length === 0) {
        container.innerHTML = '<p class="empty-state">Nenhum evento para hoje 📅</p>';
        return;
    }

    container.innerHTML = eventos.map(e => `
        <div class="event-item ${e.concluido ? 'concluido' : ''}" style="border-left-color: ${e.cor}">
            <span class="event-time">${e.hora_inicio || '—'}</span>
            <span class="event-title">${e.titulo}</span>
        </div>
    `).join('');
}
