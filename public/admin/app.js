'use strict';

(() => {
  const api = '/api/v1';
  let token = '';
  let deviceRows = [];
  let dashboardStats = null;
  let toastTimer;
  const $ = (selector) => document.querySelector(selector);
  const escapeHtml = (value) => String(value ?? '').replace(/[&<>"']/g, (char) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
  })[char]);

  async function request(path, options = {}) {
    const headers = { ...(options.headers || {}) };
    if (token) headers.Authorization = `Bearer ${token}`;
    if (options.body) headers['Content-Type'] = 'application/json';
    const response = await fetch(`${api}${path}`, { ...options, headers });
    const data = response.status === 204 ? null : await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(data?.error || `Falha HTTP ${response.status}`);
    return data;
  }

  function showToast(message) {
    const toast = $('#toast');
    toast.textContent = message;
    toast.classList.add('show');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => toast.classList.remove('show'), 3200);
  }

  function showApp() {
    $('#login-view').hidden = true;
    $('#app-view').hidden = false;
    openView('dashboard');
  }

  $('#login-form').addEventListener('submit', async (event) => {
    event.preventDefault();
    const formElement = event.currentTarget;
    const message = $('#login-message');
    message.textContent = 'Validando acesso…';
    message.className = 'form-message';
    const form = new FormData(formElement);
    try {
      const result = await request('/admin/login', {
        method: 'POST',
        body: JSON.stringify({ email: form.get('email'), password: form.get('password') })
      });
      token = result.token;
      formElement.reset();
      showApp();
    } catch (error) {
      message.textContent = error.message;
      message.classList.add('error');
    }
  });

  $('#logout-button').addEventListener('click', () => {
    token = '';
    $('#app-view').hidden = true;
    $('#login-view').hidden = false;
  });

  document.querySelectorAll('.nav-link').forEach((button) => {
    button.addEventListener('click', () => openView(button.dataset.view));
  });
  document.querySelectorAll('[data-open-view]').forEach((button) => {
    button.addEventListener('click', (event) => {
      event.preventDefault();
      openView(button.dataset.openView);
    });
  });
  $('#refresh-button').addEventListener('click', () => loadCurrentView());

  function openView(name) {
    document.querySelectorAll('.view-panel').forEach((view) => { view.hidden = view.id !== `view-${name}`; });
    document.querySelectorAll('.nav-link').forEach((button) => button.classList.toggle('active', button.dataset.view === name));
    const title = { dashboard: 'Visão geral', devices: 'Dispositivos', users: 'Usuários', logs: 'Auditoria' }[name];
    $('#page-title').textContent = title;
    $('#current-section').textContent = title.toUpperCase();
    loadCurrentView(name);
  }

  function loadCurrentView(name) {
    const current = name || document.querySelector('.nav-link.active')?.dataset.view || 'dashboard';
    if (current === 'dashboard') return loadDashboard();
    if (current === 'devices') return loadDevices();
    if (current === 'users') return loadUsers();
    if (current === 'logs') return loadAudit();
  }

  async function loadDashboard() {
    try {
      const [stats, health] = await Promise.all([request('/admin/stats'), request('/health')]);
      dashboardStats = stats;
      $('#metric-total').textContent = stats.devices.total;
      $('#metric-online').textContent = stats.devices.online;
      $('#metric-offline').textContent = `${stats.devices.offline} offline`;
      $('#metric-readings').textContent = stats.readings_24h.toLocaleString('pt-BR');
      $('#api-health').textContent = health.status === 'ok' ? 'Operacional' : 'Indisponível';
      $('#db-health').textContent = health.db === 'ok' ? 'Conectado' : 'Indisponível';
      $('#api-health').className = `health-value ${health.status === 'ok' ? 'ok' : 'bad'}`;
      $('#db-health').className = `health-value ${health.db === 'ok' ? 'ok' : 'bad'}`;
      $('#server-status').classList.toggle('online', health.status === 'ok');
      $('#server-status').innerHTML = `<i></i> ${health.status === 'ok' ? 'API operacional' : 'API indisponível'}`;
      drawChart(stats.recent_telemetry || []);
    } catch (error) {
      $('#server-status').classList.remove('online');
      $('#server-status').textContent = 'Falha ao carregar';
      showToast(error.message);
    }
  }

  function drawChart(rows) {
    const canvas = $('#telemetry-chart');
    const context = canvas.getContext('2d');
    const ratio = window.devicePixelRatio || 1;
    const width = canvas.clientWidth;
    const height = 210;
    canvas.width = width * ratio;
    canvas.height = height * ratio;
    context.scale(ratio, ratio);
    context.clearRect(0, 0, width, height);
    const points = rows.slice().reverse().map((row) => {
      const value = typeof row.payload === 'string' ? JSON.parse(row.payload) : row.payload;
      const number = Number(value?.temp);
      return Number.isFinite(number) ? number : null;
    });
    const valid = points.filter((value) => value !== null);
    $('#chart-empty').hidden = valid.length > 0;
    if (valid.length === 0) return;
    const min = Math.min(...valid);
    const max = Math.max(...valid);
    const span = max - min || 1;
    const left = 14, right = width - 14, top = 18, bottom = height - 23;
    context.strokeStyle = '#e8edf4';
    context.lineWidth = 1;
    for (let line = 0; line < 4; line++) {
      const y = top + (bottom - top) * line / 3;
      context.beginPath(); context.moveTo(left, y); context.lineTo(right, y); context.stroke();
    }
    context.strokeStyle = '#009c3b';
    context.lineWidth = 2.5;
    context.lineJoin = 'round';
    context.beginPath();
    let plotted = 0;
    let lastPoint;
    points.forEach((value, index) => {
      if (value === null) return;
      const x = left + (right - left) * index / Math.max(points.length - 1, 1);
      const y = bottom - (value - min) / span * (bottom - top);
      if (plotted === 0) context.moveTo(x, y); else context.lineTo(x, y);
      lastPoint = { x, y };
      plotted++;
    });
    context.stroke();
    if (plotted === 1) {
      context.fillStyle = '#009c3b';
      context.beginPath();
      context.arc(lastPoint.x, lastPoint.y, 4, 0, Math.PI * 2);
      context.fill();
    }
    context.fillStyle = '#002776';
    context.font = '11px Inter, Arial, sans-serif';
    context.fillText(`${max.toFixed(1)}°`, 4, top + 4);
    context.fillText(`${min.toFixed(1)}°`, 4, bottom);
  }

  async function loadDevices() {
    try {
      const { devices } = await request('/admin/devices');
      deviceRows = devices;
      $('#devices-table').innerHTML = devices.length ? devices.map((device) => `
        <tr>
          <td><span class="row-title">${escapeHtml(device.name)}</span><span class="row-subtitle">${escapeHtml(device.device_id)}</span></td>
          <td><span class="badge ${device.status === 'active' ? (device.online ? 'good' : 'off') : 'off'}">${device.status === 'active' ? (device.online ? 'Online' : 'Offline') : 'Desativado'}</span></td>
          <td>${device.last_seen_at ? new Date(device.last_seen_at).toLocaleString('pt-BR') : 'Sem conexão'}</td>
          <td>GET ${device.allow_get ? 'ativo' : 'inativo'} · Nonce ${device.require_nonce ? 'obrigatório' : 'opcional'} · ${device.interval_sec}s</td>
          <td>
            <button class="table-action" data-action="rotate" data-id="${escapeHtml(device.device_id)}">Rotacionar chave</button>
            <button class="table-action" data-action="edit" data-id="${escapeHtml(device.device_id)}">Editar</button>
            <button class="table-action danger" data-action="revoke" data-id="${escapeHtml(device.device_id)}">Revogar chave</button>
            <button class="table-action danger" data-action="deactivate" data-id="${escapeHtml(device.device_id)}">Desativar</button>
          </td>
        </tr>`).join('') : '<tr><td class="empty-row" colspan="5">Nenhum dispositivo cadastrado.</td></tr>';
    } catch (error) { showToast(error.message); }
  }

  $('#devices-table').addEventListener('click', async (event) => {
    const button = event.target.closest('[data-action]');
    if (!button) return;
    const device = deviceRows.find((row) => row.device_id === button.dataset.id);
    if (!device) return;
    try {
      if (button.dataset.action === 'rotate') {
        const result = await request(`/admin/devices/${encodeURIComponent(device.device_id)}/rotate-key`, { method: 'POST' });
        showKey(result.device_id, result.device_key);
      } else if (button.dataset.action === 'revoke') {
        if (!confirm(`Revogar a chave e bloquear ${device.name}?`)) return;
        await request(`/admin/devices/${encodeURIComponent(device.device_id)}/revoke-key`, { method: 'POST' });
        showToast('Chave revogada e dispositivo bloqueado.');
        loadDevices();
      } else if (button.dataset.action === 'deactivate') {
        if (!confirm(`Desativar ${device.name}?`)) return;
        await request(`/admin/devices/${encodeURIComponent(device.device_id)}`, { method: 'DELETE' });
        showToast('Dispositivo desativado.');
        loadDevices();
      } else if (button.dataset.action === 'edit') {
        const name = prompt('Nome do dispositivo:', device.name);
        if (name === null) return;
        const interval = prompt('Intervalo de envio em segundos:', device.interval_sec);
        if (interval === null) return;
        await request(`/admin/devices/${encodeURIComponent(device.device_id)}`, {
          method: 'PUT',
          body: JSON.stringify({
            name,
            interval_sec: Number(interval),
            allow_get: confirm('Permitir ingestão via GET?'),
            require_nonce: confirm('Exigir timestamp e nonce?'),
            status: device.status
          })
        });
        showToast('Configurações atualizadas.');
        loadDevices();
      }
    } catch (error) { showToast(error.message); }
  });

  function showKey(deviceId, key) {
    const panel = $('#new-key-panel');
    panel.innerHTML = `<strong>Chave de ${escapeHtml(deviceId)} — copie agora</strong><code>${escapeHtml(key)}</code><p>Esta chave é exibida uma única vez. Atualize o firmware do dispositivo antes de fechar esta página.</p>`;
    panel.hidden = false;
    panel.scrollIntoView({ behavior: 'smooth', block: 'center' });
  }

  $('#device-form').addEventListener('submit', async (event) => {
    event.preventDefault();
    const formElement = event.currentTarget;
    const form = new FormData(formElement);
    const payload = {
      device_id: form.get('device_id'),
      name: form.get('name'),
      interval_sec: Number(form.get('interval_sec')),
      allow_get: form.has('allow_get'),
      require_nonce: form.has('require_nonce')
    };
    if (form.get('user_id')) payload.user_id = Number(form.get('user_id'));
    try {
      const result = await request('/admin/devices', { method: 'POST', body: JSON.stringify(payload) });
      showKey(result.device_id, result.device_key);
      formElement.reset();
      formElement.elements.allow_get.checked = true;
      formElement.elements.require_nonce.checked = true;
      $('#device-form-message').textContent = 'Dispositivo criado.';
      $('#device-form-message').className = 'form-message success';
      loadDevices();
    } catch (error) {
      $('#device-form-message').textContent = error.message;
      $('#device-form-message').className = 'form-message error';
    }
  });

  async function loadUsers() {
    try {
      const { users } = await request('/admin/users');
      $('#users-table').innerHTML = users.length ? users.map((user) => `
        <tr><td><span class="row-title">${escapeHtml(user.email)}</span></td><td>${user.id}</td>
        <td>${escapeHtml(user.device_ids || 'Nenhum')}</td>
        <td><span class="badge ${user.status === 'active' ? 'good' : 'off'}">${user.status === 'active' ? 'Ativo' : 'Inativo'}</span></td>
        <td><button class="table-action danger" data-user-id="${user.id}">${user.status === 'active' ? 'Desativar' : 'Desativado'}</button></td></tr>`).join('') : '<tr><td class="empty-row" colspan="5">Nenhum usuário cadastrado.</td></tr>';
    } catch (error) { showToast(error.message); }
  }

  $('#user-form').addEventListener('submit', async (event) => {
    event.preventDefault();
    const formElement = event.currentTarget;
    const form = new FormData(formElement);
    try {
      const result = await request('/admin/users', {
        method: 'POST',
        body: JSON.stringify({ email: form.get('email'), password: form.get('password') })
      });
      formElement.reset();
      $('#user-form-message').textContent = `Usuário criado (ID ${result.id}).`;
      $('#user-form-message').className = 'form-message success';
      loadUsers();
    } catch (error) {
      $('#user-form-message').textContent = error.message;
      $('#user-form-message').className = 'form-message error';
    }
  });

  $('#users-table').addEventListener('click', async (event) => {
    const button = event.target.closest('[data-user-id]');
    if (!button || !confirm('Desativar este usuário?')) return;
    try {
      await request(`/admin/users/${button.dataset.userId}`, { method: 'DELETE' });
      showToast('Usuário desativado.');
      loadUsers();
    } catch (error) { showToast(error.message); }
  });

  $('#link-form').addEventListener('submit', async (event) => {
    event.preventDefault();
    const formElement = event.currentTarget;
    const form = new FormData(formElement);
    try {
      await request(`/admin/users/${form.get('user_id')}/devices`, {
        method: 'POST', body: JSON.stringify({ device_id: form.get('device_id') })
      });
      $('#link-form-message').textContent = 'Dispositivo vinculado.';
      $('#link-form-message').className = 'form-message success';
      formElement.reset();
      loadUsers();
    } catch (error) {
      $('#link-form-message').textContent = error.message;
      $('#link-form-message').className = 'form-message error';
    }
  });

  async function loadAudit() {
    try {
      const { logs } = await request('/admin/audit');
      $('#audit-table').innerHTML = logs.length ? logs.map((log) => `
        <tr><td>${new Date(log.created_at).toLocaleString('pt-BR')}</td><td>${escapeHtml(log.actor_email || 'Sistema')}</td>
        <td><span class="row-title">${escapeHtml(log.action)}</span></td><td>${escapeHtml(log.target_type)} · ${escapeHtml(log.target_id || '')}</td></tr>`).join('') : '<tr><td class="empty-row" colspan="4">Nenhuma ação administrativa registrada.</td></tr>';
    } catch (error) { showToast(error.message); }
  }

  window.addEventListener('resize', () => {
    if (token && dashboardStats && !$('#view-dashboard').hidden) drawChart(dashboardStats.recent_telemetry || []);
  });
})();
