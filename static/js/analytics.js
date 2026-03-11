/* ═══════════════════════════════════════════════
   Analytics Module
   ═══════════════════════════════════════════════ */

window.addEventListener('pageChange', (e) => {
    if (e.detail.page === 'analytics') loadAnalytics();
});

async function loadAnalytics() {
    try {
        const data = await api('/api/analytics');
        renderMonthChart(data.horas_mes);
        renderMateriaChart(data.horas_materia);
        renderAcertosChart(data.acertos_materia);
    } catch (err) {
        console.error('Analytics error:', err);
    }
}

function renderMonthChart(horasMes) {
    const container = document.getElementById('monthChart');
    const maxVal = Math.max(...horasMes.map(h => h.horas), 1);

    container.innerHTML = horasMes.map(item => {
        const pct = (item.horas / maxVal) * 100;
        const d = new Date(item.data + 'T00:00:00');
        const label = d.getDate();

        return `
            <div class="chart-bar-wrapper">
                ${item.horas > 0 ? `<span class="chart-bar-value">${item.horas}</span>` : ''}
                <div class="chart-bar" style="height: ${Math.max(pct, 2)}%" title="${item.data}: ${item.horas}h"></div>
                <span class="chart-bar-label">${label}</span>
            </div>
        `;
    }).join('');
}

function renderMateriaChart(horasMateria) {
    const container = document.getElementById('materiaChart');
    const maxVal = Math.max(...horasMateria.map(h => h.horas), 1);

    if (horasMateria.length === 0) {
        container.innerHTML = '<p class="empty-state">Sem dados ainda. Estude usando o Pomodoro!</p>';
        return;
    }

    container.innerHTML = '';
    container.style.flexDirection = 'column';
    container.style.justifyContent = 'flex-start';
    container.style.gap = '8px';
    container.style.alignItems = 'stretch';

    container.innerHTML = horasMateria.map(item => {
        const pct = (item.horas / maxVal) * 100;
        return `
            <div class="bar-horizontal">
                <span class="bar-h-label">${item.nome}</span>
                <div class="bar-h-track">
                    <div class="bar-h-fill" style="width:${Math.max(pct, 3)}%;background:${item.cor || 'var(--accent-primary)'}">
                        ${item.horas.toFixed(1)}h
                    </div>
                </div>
            </div>
        `;
    }).join('');
}

function renderAcertosChart(acertosMateria) {
    const container = document.getElementById('acertosChart');

    if (acertosMateria.length === 0 || acertosMateria.every(a => a.total === 0)) {
        container.innerHTML = '<p class="empty-state">Sem questões respondidas ainda</p>';
        return;
    }

    container.innerHTML = '';
    container.style.flexDirection = 'column';
    container.style.justifyContent = 'flex-start';
    container.style.gap = '8px';
    container.style.alignItems = 'stretch';

    container.innerHTML = acertosMateria.filter(a => a.total > 0).map(item => {
        const pct = Math.round((item.acertos / item.total) * 100);
        const cor = pct >= 70 ? 'var(--success)' : pct >= 50 ? 'var(--warning)' : 'var(--danger)';
        return `
            <div class="bar-horizontal">
                <span class="bar-h-label">${item.nome}</span>
                <div class="bar-h-track">
                    <div class="bar-h-fill" style="width:${Math.max(pct, 5)}%;background:${cor}">
                        ${pct}% (${item.acertos}/${item.total})
                    </div>
                </div>
            </div>
        `;
    }).join('');
}
