'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

function loadPage(script, responses) {
  const elements = new Map();
  class Element extends EventTarget {
    constructor() {
      super();
      this.hidden = false;
      this.value = '';
      this.fields = {};
      this.elements = { allow_get: {}, require_nonce: {} };
      this.classList = { add() {}, remove() {}, toggle() {} };
      this.resetCount = 0;
    }
    reset() { this.resetCount++; }
    scrollIntoView() {}
  }
  const document = {
    querySelector(selector) {
      if (selector.startsWith('[data-check=')) return null;
      if (!elements.has(selector)) elements.set(selector, new Element());
      return elements.get(selector);
    },
    querySelectorAll() { return []; }
  };
  class FakeFormData {
    constructor(element) { this.fields = element.fields; }
    get(key) { return this.fields[key] ?? null; }
    has(key) { return Object.hasOwn(this.fields, key); }
  }
  const fetch = async (url, options = {}) => {
    const body = responses[`${options.method || 'GET'} ${url}`];
    if (!body) return new Promise(() => {});
    return { ok: true, status: 200, json: async () => body, text: async () => JSON.stringify(body) };
  };
  const source = fs.readFileSync(path.join(__dirname, '..', 'public', script, 'app.js'), 'utf8');
  vm.runInNewContext(source, {
    document, FormData: FakeFormData, fetch, URL, performance,
    window: { location: { origin: 'https://example.test' }, addEventListener() {} },
    setTimeout, clearTimeout
  });
  return document;
}

async function submit(document, selector, fields) {
  const form = document.querySelector(selector);
  form.fields = fields;
  const event = new Event('submit', { cancelable: true });
  form.dispatchEvent(event);
  assert.equal(event.currentTarget, null);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(form.resetCount, 1);
}

test('admin forms complete after asynchronous requests', async () => {
  const document = loadPage('admin', {
    'POST /api/v1/admin/login': { token: 'test-token' },
    'POST /api/v1/admin/devices': { device_id: 'sensor', device_key: 'test-key' },
    'POST /api/v1/admin/users': { id: 2 },
    'POST /api/v1/admin/users/2/devices': { ok: true }
  });
  await submit(document, '#login-form', { email: 'admin@example.test', password: 'test-password' });
  assert.equal(document.querySelector('#login-view').hidden, true);
  assert.equal(document.querySelector('#app-view').hidden, false);

  await submit(document, '#device-form', { device_id: 'sensor', name: 'Sensor', interval_sec: '60' });
  assert.equal(document.querySelector('#device-form-message').textContent, 'Dispositivo criado.');
  assert.equal(document.querySelector('#device-form').elements.allow_get.checked, true);
  assert.equal(document.querySelector('#device-form').elements.require_nonce.checked, true);
  assert.equal(document.querySelector('#new-key-panel').hidden, false);

  await submit(document, '#user-form', { email: 'user@example.test', password: 'test-password' });
  assert.equal(document.querySelector('#user-form-message').textContent, 'Usuário criado (ID 2).');
  await submit(document, '#link-form', { user_id: '2', device_id: 'sensor' });
  assert.equal(document.querySelector('#link-form-message').textContent, 'Dispositivo vinculado.');
});

test('tester login opens after an asynchronous response', async () => {
  const document = loadPage('tester', {
    'POST https://example.test/api/v1/admin/login': { token: 'test-token' },
    'GET https://example.test/api/v1/health': { status: 'ok', db: 'ok' }
  });
  await submit(document, '#admin-login', { email: 'admin@example.test', password: 'test-password' });
  assert.equal(document.querySelector('#admin-gate').hidden, true);
  assert.equal(document.querySelector('#tester-content').hidden, false);
  assert.equal(document.querySelector('#admin-message').textContent, '');
});
