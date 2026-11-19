'use strict';

(() => {
  let adminToken = '';
  let appToken = '';
  let lastIngestUrl = '';
  let lastReading = null;
  let lastDeviceRequestAt = 0;
  let commandIds = [];
  const $ = (selector) => document.querySelector(selector);

  function baseUrl() {
    const url = new URL($('#base-url').value.trim());
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) {
      throw new Error('Informe uma URL HTTP(S) válida, sem usuário ou senha.');
    }
    return url.toString().replace(/\/+$/, '');
  }

  function deviceHeaders() {
    const id = $('#device-id').value.trim();
    const key = $('#device-key').value.trim();
    if (!id || !key) throw new Error('Preencha o Device ID e a API Key.');
    return { 'X-Device-Id': id, 'X-Device-Key': key };
  }

  async function call(path, options = {}) {
    const started = performance.now();
    let response, body;
    try {
      response = await fetch(`${baseUrl()}${path}`, options);
      const text = await response.text();
      try { body = text ? JSON.parse(text) : null; } catch { body = { response: text }; }
    } catch (error) {
      body = { error: error.message || 'Falha de rede.' };
      response = { status: 0, ok: false };
    }
    const elapsed = Math.round(performance.now() - started);
    $('#response-meta').textContent = `HTTP ${response.status} · ${elapsed} ms`;
    $('#response-meta').className = `response-meta ${response.ok ? 'good' : 'bad'}`;
    const displayBody = body && typeof body === 'object' ? { ...body } : body;
    if (displayBody && typeof displayBody === 'object') {
      for (const secret of ['token', 'device_key', 'key', 'password']) {
        if (secret in displayBody) displayBody[secret] = '[redacted]';
      }
    }
    $('#response-json').textContent = JSON.stringify(displayBody, null, 2);
    return { ok: response.ok, status: response.status, body };
  }

  function setCheck(name, passed) {
    const item = document.querySelector(`[data-check="${name}"]`);
    if (!item) return;
    item.classList.toggle('pass', Boolean(passed));
    item.classList.toggle('fail', !passed);
    item.querySelector('.check-icon').textContent = passed ? '✓' : '×';
  }

  function generatedReading() {
    lastReading = {
      temp: Number((18 + Math.random() * 14).toFixed(1)),
      hum: Number((35 + Math.random() * 45).toFixed(1)),
      bat: Number((60 + Math.random() * 40).toFixed(1))
    };
    return lastReading;
  }

  async function adminLogin(event) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    $('#admin-message').textContent = 'Validando acesso…';
    try {
      const result = await call('/admin/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: form.get('email'), password: form.get('password') })
      });
      if (!result.ok || !result.body?.token) throw new Error(result.body?.error || 'Não foi possível entrar.');
      adminToken = result.body.token;
      event.currentTarget.reset();
      $('#admin-gate').hidden = true;
      $('#tester-content').hidden = false;
      $('#base-url').value = `${window.location.origin}/api/v1`;
      $('#admin-message').textContent = '';
      checkHealth();
    } catch (error) {
      $('#admin-message').textContent = error.message;
      $('#admin-message').className = 'message error';
    }
  }

  $('#admin-login').addEventListener('submit', adminLogin);
  $('#logout').addEventListener('click', () => {
    adminToken = '';
    appToken = '';
    $('#tester-content').hidden = true;
    $('#admin-gate').hidden = false;
  });

  async function checkHealth() {
    const result = await call('/health');
    setCheck('server', result.ok && result.body?.status === 'ok');
    setCheck('db', result.ok && result.body?.db === 'ok');
    return result;
  }

  async function deviceCall(path, options = {}) {
    const elapsed = Date.now() - lastDeviceRequestAt;
    if (elapsed < 1050) await new Promise((resolve) => setTimeout(resolve, 1050 - elapsed));
    const headers = { ...deviceHeaders(), ...(options.headers || {}) };
    const result = await call(path, { ...options, headers });
    lastDeviceRequestAt = Date.now();
    return result;
  }

  async function ingestGet(reuse = false) {
    if (!reuse || !lastIngestUrl) {
      const reading = generatedReading();
      const params = new URLSearchParams({
        ...Object.fromEntries(Object.entries(reading).map(([key, value]) => [key, String(value)])),
        ts: String(Math.floor(Date.now() / 1000)),
        nonce: crypto.randomUUID().replace(/-/g, '')
      });
      lastIngestUrl = `/device/ingest?${params}`;
    }
    const result = await deviceCall(lastIngestUrl);
    setCheck('get', result.ok);
    return result;
  }

  async function ingestPost() {
    const result = await deviceCall('/device/telemetry', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(generatedReading())
    });
    setCheck('post', result.ok);
    return result;
  }

  async function appLogin(register = false) {
    const email = $('#app-email').value.trim();
    const password = $('#app-password').value;
    if (!email || !password) throw new Error('Preencha o e-mail e a senha do app.');
    const result = await call(register ? '/auth/register' : '/auth/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email, password })
    });
    if (register) {
      $('#app-message').textContent = result.ok ? 'Conta criada. Agora entre no app.' : (result.body?.error || 'Falha ao criar conta.');
      $('#app-message').className = `message ${result.ok ? 'success' : 'error'}`;
      return result;
    }
    if (!result.ok || !result.body?.token) {
      appToken = '';
      $('#app-message').textContent = result.body?.error || 'Falha no login.';
      $('#app-message').className = 'message error';
      return result;
    }
    appToken = result.body.token;
    $('#app-message').textContent = 'Login realizado. Carregando dispositivos vinculados…';
    $('#app-message').className = 'message success';
    return loadAppDevices();
  }

  async function appCall(path, options = {}) {
    if (!appToken) throw new Error('Entre no app antes de consultar os dados.');
    return call(path, {
      ...options,
      headers: { Authorization: `Bearer ${appToken}`, ...(options.headers || {}) }
    });
  }

  async function loadAppDevices() {
    const result = await appCall('/devices');
    const select = $('#app-device');
    if (!result.ok) {
      $('#app-message').textContent = result.body?.error || 'Não foi possível listar dispositivos.';
      return result;
    }
    select.innerHTML = result.body.devices.length
      ? result.body.devices.map((device) => `<option value="${encodeURIComponent(device.device_id)}">${escapeHtml(device.name)} · ${escapeHtml(device.device_id)}</option>`).join('')
      : '<option value="">Nenhum dispositivo vinculado</option>';
    $('#app-message').textContent = result.body.devices.length
      ? `${result.body.devices.length} dispositivo(s) disponível(is).`
      : 'Esta conta ainda não tem dispositivos vinculados.';
    $('#app-message').className = `message ${result.body.devices.length ? 'success' : ''}`;
    return result;
  }

  function selectedDevice() {
    const value = $('#app-device').value;
    if (!value) throw new Error('Selecione um dispositivo vinculado à conta.');
    return decodeURIComponent(value);
  }

  function escapeHtml(value) {
    return String(value ?? '').replace(/[&<>"']/g, (char) => ({
      '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
    })[char]);
  }

  document.querySelectorAll('[data-action]').forEach((button) => {
    button.addEventListener('click', async () => {
      try {
        let result;
        switch (button.dataset.action) {
          case 'health': result = await checkHealth(); break;
          case 'ping':
            result = await deviceCall('/device/ping');
            setCheck('device', result.ok);
            break;
          case 'config': result = await deviceCall('/device/config'); break;
          case 'commands':
            result = await deviceCall('/device/commands');
            if (result.ok && Array.isArray(result.body?.commands)) {
              commandIds = result.body.commands.map((command) => command.id);
              if (commandIds.length) $('#command-id').value = commandIds[0];
            }
            break;
          case 'get-ingest': result = await ingestGet(false); break;
          case 'post-ingest': result = await ingestPost(); break;
          case 'replay': result = await ingestGet(true); break;
          default: return;
        }
      } catch (error) {
        $('#response-meta').textContent = 'Não enviado';
        $('#response-meta').className = 'response-meta bad';
        $('#response-json').textContent = JSON.stringify({ error: error.message }, null, 2);
      }
    });
  });

  $('#ack-get').addEventListener('click', async () => {
    try {
      const id = Number($('#command-id').value);
      if (!Number.isInteger(id) || id < 1) throw new Error('Informe um ID de comando válido.');
      await deviceCall(`/device/commands/ack?id=${id}&status=done`);
    } catch (error) { $('#response-json').textContent = JSON.stringify({ error: error.message }, null, 2); }
  });

  $('#ack-post').addEventListener('click', async () => {
    try {
      const id = Number($('#command-id').value);
      if (!Number.isInteger(id) || id < 1) throw new Error('Informe um ID de comando válido.');
      await deviceCall(`/device/commands/${id}/ack`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ status: 'done' })
      });
    } catch (error) { $('#response-json').textContent = JSON.stringify({ error: error.message }, null, 2); }
  });

  $('#app-login').addEventListener('click', () => appLogin().catch(showAppError));
  $('#app-register').addEventListener('click', () => appLogin(true).catch(showAppError));
  $('#app-devices').addEventListener('click', () => loadAppDevices().catch(showAppError));
  $('#app-details').addEventListener('click', async () => {
    try {
      await appCall(`/devices/${encodeURIComponent(selectedDevice())}`);
    } catch (error) { showAppError(error); }
  });
  $('#app-latest').addEventListener('click', async () => {
    try {
      const result = await appCall(`/devices/${encodeURIComponent(selectedDevice())}/telemetry/latest`);
      const payload = result.body?.reading?.payload;
      const matchesLastReading = Boolean(payload && lastReading &&
        Object.keys(lastReading).every((key) => Number(payload[key]) === Number(lastReading[key])));
      setCheck('app', result.ok && matchesLastReading);
    } catch (error) { showAppError(error); }
  });
  $('#app-history').addEventListener('click', async () => {
    try {
      const result = await appCall(`/devices/${encodeURIComponent(selectedDevice())}/telemetry?limit=20&page=1`);
      const matchesLastReading = Boolean(lastReading && result.body?.items?.some((item) => {
        const payload = item.payload;
        return Object.keys(lastReading).every((key) => Number(payload?.[key]) === Number(lastReading[key]));
      }));
      setCheck('app', result.ok && matchesLastReading);
    } catch (error) { showAppError(error); }
  });
  $('#app-command').addEventListener('click', async () => {
    try {
      await appCall(`/devices/${encodeURIComponent(selectedDevice())}/commands`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ command: 'tester:status' })
      });
    } catch (error) { showAppError(error); }
  });

  function showAppError(error) {
    $('#app-message').textContent = error.message;
    $('#app-message').className = 'message error';
    $('#response-meta').textContent = 'Não enviado';
    $('#response-meta').className = 'response-meta bad';
    $('#response-json').textContent = JSON.stringify({ error: error.message }, null, 2);
  }

  $('#base-url').value = `${window.location.origin}/api/v1`;
})();
