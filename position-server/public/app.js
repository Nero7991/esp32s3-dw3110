/**
 * UWB Position Tracking - 3D Dashboard
 */
import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';

// ── Constants ────────────────────────────────────────────────────────────────

const ANCHOR_COLOR = 0x007aff;
const TAG_PALETTE = [0x34c759, 0xff9f0a, 0xaf52de, 0xff453a, 0x5ac8fa, 0xffcc00];
const LOG_MAX = 200;
const STALE_MS = 5000;

// ── State ────────────────────────────────────────────────────────────────────

let scene, camera, renderer, controls;

// Devices: id -> { mac, name, position:{x,y,z}, group (THREE.Group) }
const anchors = new Map();
// Tags: id -> { mac, position, group, colorIdx, distances: Map(anchorId -> {distanceCm, ring, ts}) }
const tags = new Map();

let anchorConfigs = []; // from /api/anchors (for names + default positions)
let nextTagColor = 0;

// WebSocket
let ws = null;

// Log
let logEntries = [];
let logVisible = false;
let logUnread = 0;

// ── Initialization ───────────────────────────────────────────────────────────

document.addEventListener('DOMContentLoaded', async () => {
  try {
    const resp = await fetch('/api/anchors');
    anchorConfigs = await resp.json();
  } catch (e) {
    console.error('Failed to load anchor configs:', e);
  }

  initScene();
  initEventListeners();
  connectWebSocket();
  animate();
});

// ── Three.js Scene ───────────────────────────────────────────────────────────

function initScene() {
  const vp = document.getElementById('viewport');
  const w = vp.clientWidth;
  const h = vp.clientHeight;

  scene = new THREE.Scene();
  scene.background = new THREE.Color(0xf5f5f7);

  camera = new THREE.PerspectiveCamera(50, w / h, 0.1, 500);
  camera.position.set(8, 12, 16);

  renderer = new THREE.WebGLRenderer({ antialias: true });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
  renderer.setSize(w, h);
  vp.appendChild(renderer.domElement);

  controls = new OrbitControls(camera, renderer.domElement);
  controls.enableDamping = true;
  controls.dampingFactor = 0.06;
  controls.target.set(5, 0, 4);
  controls.update();

  // Lighting
  scene.add(new THREE.AmbientLight(0xffffff, 0.65));
  const sun = new THREE.DirectionalLight(0xffffff, 0.7);
  sun.position.set(15, 25, 10);
  scene.add(sun);

  // Ground grid
  const grid = new THREE.GridHelper(30, 30, 0xc7c7cc, 0xe5e5ea);
  scene.add(grid);

  // Axis labels
  const xLabel = makeTextSprite('X (m)');
  xLabel.position.set(16, 0.15, 0);
  scene.add(xLabel);

  const yLabel = makeTextSprite('Y (m)');
  yLabel.position.set(0, 0.15, 16);
  scene.add(yLabel);

  // Small axes indicator at origin
  scene.add(new THREE.AxesHelper(0.8));
}

function animate() {
  requestAnimationFrame(animate);
  controls.update();

  // Fade stale distance rings and tag positions
  const now = Date.now();
  for (const [, tag] of tags) {
    if (tag.distances) {
      for (const [, d] of tag.distances) {
        if (d.ring) d.ring.visible = (now - d.ts) < STALE_MS;
      }
    }
    if (tag.group && tag.lastUpdate && (now - tag.lastUpdate) > STALE_MS) {
      tag.group.visible = false;
    }
  }

  renderer.render(scene, camera);
}

function onResize() {
  const vp = document.getElementById('viewport');
  const w = vp.clientWidth;
  const h = vp.clientHeight;
  camera.aspect = w / h;
  camera.updateProjectionMatrix();
  renderer.setSize(w, h);
}

// ── Text Sprites ─────────────────────────────────────────────────────────────

function makeTextSprite(text, color) {
  const canvas = document.createElement('canvas');
  const ctx = canvas.getContext('2d');
  canvas.width = 128;
  canvas.height = 32;
  ctx.fillStyle = color ? `#${color.toString(16).padStart(6, '0')}` : '#86868b';
  ctx.font = '20px -apple-system, sans-serif';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText(text, 64, 16);

  const tex = new THREE.CanvasTexture(canvas);
  tex.minFilter = THREE.LinearFilter;
  const mat = new THREE.SpriteMaterial({ map: tex, transparent: true });
  const sprite = new THREE.Sprite(mat);
  sprite.scale.set(2, 0.5, 1);
  return sprite;
}

function makeLabel(text, hexColor) {
  const canvas = document.createElement('canvas');
  const ctx = canvas.getContext('2d');
  canvas.width = 256;
  canvas.height = 48;
  ctx.fillStyle = hexColor || '#1d1d1f';
  ctx.font = 'bold 22px -apple-system, sans-serif';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText(text, 128, 24);

  const tex = new THREE.CanvasTexture(canvas);
  tex.minFilter = THREE.LinearFilter;
  const mat = new THREE.SpriteMaterial({ map: tex, transparent: true });
  const sprite = new THREE.Sprite(mat);
  sprite.scale.set(1.8, 0.35, 1);
  return sprite;
}

// ── Coordinate Mapping ───────────────────────────────────────────────────────
// UWB: x = east, y = north, z = height
// Three.js: x = right, y = up, z = towards viewer
// Mapping: uwb.x -> three.x,  uwb.y -> three.z,  uwb.z -> three.y

function uwbToThree(x, y, z) {
  return new THREE.Vector3(x, z || 0, y);
}

// ── 3D Anchor Management ────────────────────────────────────────────────────

function addAnchor3D(id, position) {
  const a = anchors.get(id);
  if (!a) return;
  if (a.group) {
    updateAnchor3DPos(id, position);
    return;
  }

  const group = new THREE.Group();

  // Body
  const cubeGeom = new THREE.BoxGeometry(0.3, 0.3, 0.3);
  const cubeMat = new THREE.MeshPhongMaterial({ color: ANCHOR_COLOR });
  group.add(new THREE.Mesh(cubeGeom, cubeMat));

  // Pole to ground
  if (position.z > 0.05) {
    const poleGeom = new THREE.CylinderGeometry(0.02, 0.02, position.z, 8);
    const poleMat = new THREE.MeshBasicMaterial({ color: 0xaeaeb2 });
    const pole = new THREE.Mesh(poleGeom, poleMat);
    pole.position.y = -position.z / 2;
    group.add(pole);
  }

  // Label
  const label = makeLabel(`A${id}`);
  label.position.y = 0.55;
  group.add(label);

  group.position.copy(uwbToThree(position.x, position.y, position.z));
  scene.add(group);
  a.group = group;
}

function updateAnchor3DPos(id, position) {
  const a = anchors.get(id);
  if (!a || !a.group) return;
  a.group.position.copy(uwbToThree(position.x, position.y, position.z));

  // Move any distance rings that reference this anchor
  for (const [, tag] of tags) {
    if (!tag.distances) continue;
    const d = tag.distances.get(id);
    if (d && d.ring) {
      d.ring.position.set(position.x, 0.02, position.y);
    }
  }
}

function removeAnchor3D(id) {
  const a = anchors.get(id);
  if (a && a.group) {
    scene.remove(a.group);
    a.group = null;
  }
  // Clean up distance rings
  for (const [, tag] of tags) {
    if (!tag.distances) continue;
    const d = tag.distances.get(id);
    if (d && d.ring) {
      scene.remove(d.ring);
      tag.distances.delete(id);
    }
  }
}

// ── 3D Tag Management ────────────────────────────────────────────────────────

function updateTag3D(id, position) {
  const tag = tags.get(id);
  if (!tag) return;

  if (!tag.group) {
    const color = TAG_PALETTE[tag.colorIdx % TAG_PALETTE.length];
    const group = new THREE.Group();

    const sphereGeom = new THREE.SphereGeometry(0.15, 20, 20);
    const sphereMat = new THREE.MeshPhongMaterial({ color });
    group.add(new THREE.Mesh(sphereGeom, sphereMat));

    const hexColor = '#' + color.toString(16).padStart(6, '0');
    const label = makeLabel(`T${id}`, hexColor);
    label.position.y = 0.45;
    group.add(label);

    scene.add(group);
    tag.group = group;
  }

  tag.group.position.copy(uwbToThree(position.x, position.y, position.z));
  tag.group.visible = true;
  tag.position = position;
  tag.lastUpdate = Date.now();
}

function removeTag3D(id) {
  const tag = tags.get(id);
  if (!tag) return;
  if (tag.group) {
    scene.remove(tag.group);
    tag.group = null;
  }
  if (tag.distances) {
    for (const [, d] of tag.distances) {
      if (d.ring) scene.remove(d.ring);
    }
    tag.distances.clear();
  }
}

// ── Distance Ring Visualization ──────────────────────────────────────────────

function updateDistanceRing(tagId, anchorId, distanceCm) {
  const tag = tags.get(tagId);
  const anchor = anchors.get(anchorId);
  if (!tag || !anchor || !anchor.position) return;

  if (!tag.distances) tag.distances = new Map();
  const radiusM = distanceCm / 100;
  const color = TAG_PALETTE[tag.colorIdx % TAG_PALETTE.length];

  let d = tag.distances.get(anchorId);
  if (!d) {
    // Create a unit circle, scaled to the radius
    const segments = 64;
    const points = [];
    for (let i = 0; i <= segments; i++) {
      const angle = (i / segments) * Math.PI * 2;
      points.push(new THREE.Vector3(Math.cos(angle), 0, Math.sin(angle)));
    }
    const geom = new THREE.BufferGeometry().setFromPoints(points);
    const mat = new THREE.LineBasicMaterial({ color, transparent: true, opacity: 0.35 });
    const ring = new THREE.Line(geom, mat);
    ring.position.set(anchor.position.x, 0.02, anchor.position.y);
    ring.scale.set(radiusM, 1, radiusM);
    scene.add(ring);

    d = { ring, distanceCm, ts: Date.now() };
    tag.distances.set(anchorId, d);
  } else {
    d.ring.scale.set(radiusM, 1, radiusM);
    d.ring.position.set(anchor.position.x, 0.02, anchor.position.y);
    d.ring.visible = true;
    d.distanceCm = distanceCm;
    d.ts = Date.now();
  }
}

// ── WebSocket ────────────────────────────────────────────────────────────────

function connectWebSocket() {
  const protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
  ws = new WebSocket(`${protocol}//${location.host}/ws`);

  ws.onopen = () => {
    updateStatus(true);
    ws.send(JSON.stringify({ type: 'register', deviceType: 'dashboard', deviceId: 0, mac: '0x0000' }));
  };

  ws.onmessage = (ev) => {
    try { handleMessage(JSON.parse(ev.data)); }
    catch (e) { console.error('WS parse error:', e); }
  };

  ws.onclose = () => {
    updateStatus(false);
    setTimeout(connectWebSocket, 3000);
  };

  ws.onerror = (err) => console.error('WS error:', err);
}

function handleMessage(msg) {
  switch (msg.type) {
    case 'device_list':   handleDeviceList(msg); break;
    case 'device_update': handleDeviceUpdate(msg); break;
    case 'ranging_update': handleRangingUpdate(msg); break;
    case 'position':      handlePosition(msg); break;
    case 'current_rate':  setActiveRate(msg.rate); break;
    case 'passive_poll_status': handlePassivePollStatus(msg); break;
    case 'log_event':     appendLogEntry(msg); break;
  }
}

function handleDeviceList(msg) {
  // Full state sync on dashboard connect
  for (const [id] of anchors) removeAnchor3D(id);
  for (const [id] of tags) removeTag3D(id);
  anchors.clear();
  tags.clear();
  nextTagColor = 0;

  for (const dev of msg.devices) {
    if (dev.deviceType === 'anchor') {
      addConnectedAnchor(dev.deviceId, dev.mac);
    } else if (dev.deviceType === 'tag') {
      addConnectedTag(dev.deviceId, dev.mac);
    }
  }
}

function handleDeviceUpdate(msg) {
  if (msg.action === 'connected') {
    if (msg.deviceType === 'anchor') addConnectedAnchor(msg.deviceId, msg.mac);
    else addConnectedTag(msg.deviceId, msg.mac);
  } else {
    if (msg.deviceType === 'anchor') removeConnectedAnchor(msg.deviceId);
    else removeConnectedTag(msg.deviceId);
  }
}

function handleRangingUpdate(msg) {
  // Ensure tag exists
  if (!tags.has(msg.tagId)) addConnectedTag(msg.tagId, '0x????');
  updateDistanceRing(msg.tagId, msg.anchorId, msg.distanceCm);

  // Update tag's distance map for sidebar display
  const tag = tags.get(msg.tagId);
  if (tag && tag.distances) {
    const d = tag.distances.get(msg.anchorId);
    if (d) d.distanceCm = msg.distanceCm;
  }
  updateTagSidebar(msg.tagId);
}

function handlePosition(msg) {
  if (!tags.has(msg.tagId)) addConnectedTag(msg.tagId, '0x????');
  updateTag3D(msg.tagId, { x: msg.x, y: msg.y, z: msg.z });
  updateTagSidebar(msg.tagId);
}

// ── Device Management ────────────────────────────────────────────────────────

function addConnectedAnchor(id, mac) {
  if (anchors.has(id)) return; // already present

  const cfg = anchorConfigs.find(a => a.id === id);
  const position = cfg
    ? { x: cfg.position.x, y: cfg.position.y, z: cfg.position.z }
    : { x: 0, y: 0, z: 0 };
  const name = cfg ? cfg.name : `Anchor ${id}`;

  anchors.set(id, { mac, name, position, group: null });
  addAnchor3D(id, position);
  renderAnchorsSidebar();
}

function removeConnectedAnchor(id) {
  removeAnchor3D(id);
  anchors.delete(id);
  renderAnchorsSidebar();
}

function addConnectedTag(id, mac) {
  if (tags.has(id)) return;

  tags.set(id, {
    mac,
    position: null,
    group: null,
    colorIdx: nextTagColor++,
    distances: new Map(),
    lastUpdate: null,
  });
  renderTagsSidebar();
}

function removeConnectedTag(id) {
  removeTag3D(id);
  tags.delete(id);
  renderTagsSidebar();
}

// ── Sidebar: Anchors ─────────────────────────────────────────────────────────

function renderAnchorsSidebar() {
  const container = document.getElementById('anchor-list');
  container.innerHTML = '';

  if (anchors.size === 0) {
    container.innerHTML = '<p class="empty-state">No anchors connected</p>';
    return;
  }

  for (const [id, anchor] of anchors) {
    const card = document.createElement('div');
    card.className = 'device-card';
    card.innerHTML = `
      <div class="device-header">
        <span class="device-dot"></span>
        <span class="device-name">${anchor.name}</span>
        <button class="btn-locate" data-id="${id}">Locate</button>
        <button class="btn-settings" data-id="${id}" data-type="anchor">&#9881;</button>
        <span class="device-mac">${anchor.mac}</span>
      </div>
      <div class="coord-row">
        <label>x<input type="number" step="0.1" value="${anchor.position.x}" data-axis="x"></label>
        <label>y<input type="number" step="0.1" value="${anchor.position.y}" data-axis="y"></label>
        <label>z<input type="number" step="0.1" value="${anchor.position.z}" data-axis="z"></label>
        <button class="btn-set">Set</button>
      </div>
    `;

    card.querySelector('.btn-locate').addEventListener('click', () => {
      if (ws && ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ type: 'locate_anchor', deviceId: id }));
      }
    });

    card.querySelector('.btn-settings').addEventListener('click', () => {
      openSettings(id, 'anchor', anchor);
    });

    card.querySelector('.btn-set').addEventListener('click', () => {
      const inputs = card.querySelectorAll('input');
      const pos = {
        x: parseFloat(inputs[0].value) || 0,
        y: parseFloat(inputs[1].value) || 0,
        z: parseFloat(inputs[2].value) || 0,
      };
      anchor.position = pos;
      addAnchor3D(id, pos);

      // Persist to server
      fetch(`/api/anchors/${id}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ position: pos }),
      }).catch(console.error);
    });

    container.appendChild(card);
  }
}

// ── Sidebar: Tags ────────────────────────────────────────────────────────────

function renderTagsSidebar() {
  const container = document.getElementById('tag-list');
  container.innerHTML = '';

  if (tags.size === 0) {
    container.innerHTML = '<p class="empty-state">No tags connected</p>';
    return;
  }

  for (const [id, tag] of tags) {
    const color = TAG_PALETTE[tag.colorIdx % TAG_PALETTE.length];
    const hex = '#' + color.toString(16).padStart(6, '0');

    const card = document.createElement('div');
    card.className = 'device-card';
    card.id = `tag-card-${id}`;
    card.innerHTML = `
      <div class="device-header">
        <span class="device-dot" style="background:${hex}"></span>
        <span class="device-name">Tag 0x${id.toString(16).padStart(4, '0').toUpperCase()}</span>
        <button class="btn-settings" data-id="${id}" data-type="tag">&#9881;</button>
        <span class="device-mac">${tag.mac}</span>
      </div>
      <div class="tag-info" id="tag-info-${id}">
        <span class="empty-state">Waiting for data...</span>
      </div>
    `;

    card.querySelector('.btn-settings').addEventListener('click', () => {
      openSettings(id, 'tag', tag);
    });
    container.appendChild(card);
  }
}

function updateTagSidebar(tagId) {
  const tag = tags.get(tagId);
  if (!tag) return;

  const el = document.getElementById(`tag-info-${tagId}`);
  if (!el) return;

  let html = '';

  if (tag.position) {
    html += `<div class="tag-position">(${tag.position.x.toFixed(2)}, ${tag.position.y.toFixed(2)}, ${tag.position.z.toFixed(2)}) m</div>`;
  }

  if (tag.distances && tag.distances.size > 0) {
    html += '<div class="tag-distances">';
    for (const [aid, d] of tag.distances) {
      const a = anchors.get(aid);
      const name = a ? `A${aid}` : `A${aid}`;
      html += `<span>${name}: ${(d.distanceCm / 100).toFixed(2)}m</span>`;
    }
    html += '</div>';
  }

  if (!html) html = '<span class="empty-state">Waiting for data...</span>';
  el.innerHTML = html;
}

// ── Log Panel ────────────────────────────────────────────────────────────────

function toggleLog() {
  logVisible = !logVisible;
  const panel = document.getElementById('log-panel');
  const btn = document.getElementById('log-toggle');
  panel.style.display = logVisible ? 'block' : 'none';
  btn.classList.toggle('active', logVisible);

  if (logVisible) {
    logUnread = 0;
    updateLogBadge();
    scrollLogToBottom();

    // Resize viewport since log panel appeared/disappeared
    onResize();
  } else {
    onResize();
  }
}

function clearLog() {
  logEntries = [];
  const container = document.getElementById('log-entries');
  container.innerHTML = '<div class="log-empty" id="log-empty">No events yet.</div>';
  logUnread = 0;
  updateLogBadge();
}

function updateLogBadge() {
  const badge = document.getElementById('log-badge');
  if (logUnread > 0 && !logVisible) {
    badge.textContent = logUnread > 99 ? '99+' : String(logUnread);
    badge.style.display = 'inline-block';
  } else {
    badge.style.display = 'none';
  }
}

function formatLogTime(iso) {
  const d = new Date(iso);
  return [d.getHours(), d.getMinutes(), d.getSeconds()]
    .map(n => String(n).padStart(2, '0')).join(':')
    + '.' + String(d.getMilliseconds()).padStart(3, '0');
}

function appendLogEntry(msg) {
  if (logEntries.length >= LOG_MAX) logEntries.shift();
  logEntries.push(msg);

  if (!logVisible) {
    logUnread++;
    updateLogBadge();
    return;
  }

  const empty = document.getElementById('log-empty');
  if (empty) empty.remove();

  const container = document.getElementById('log-entries');

  const row = document.createElement('div');
  row.className = 'log-entry';

  const timeEl = document.createElement('span');
  timeEl.className = 'log-time';
  timeEl.textContent = formatLogTime(msg.timestamp);

  const levelEl = document.createElement('span');
  levelEl.className = `log-level ${msg.level}`;
  levelEl.textContent = msg.level;

  const bodyEl = document.createElement('span');
  bodyEl.className = 'log-body';
  bodyEl.textContent = msg.event;
  if (msg.detail) {
    const detailEl = document.createElement('span');
    detailEl.className = 'log-detail';
    detailEl.textContent = msg.detail;
    bodyEl.appendChild(detailEl);
  }

  row.appendChild(timeEl);
  row.appendChild(levelEl);
  row.appendChild(bodyEl);

  while (container.children.length >= LOG_MAX) {
    container.removeChild(container.firstChild);
  }

  container.appendChild(row);
  scrollLogToBottom();
}

function scrollLogToBottom() {
  const container = document.getElementById('log-entries');
  container.scrollTop = container.scrollHeight;
}

// ── Connection Status ────────────────────────────────────────────────────────

function updateStatus(connected) {
  const dot = document.getElementById('ws-status');
  const text = document.getElementById('status-text');
  if (connected) {
    dot.classList.remove('disconnected');
    text.textContent = 'Connected';
  } else {
    dot.classList.add('disconnected');
    text.textContent = 'Disconnected';
  }
}

// ── Passive Tags ─────────────────────────────────────────────────────────────

let passiveTags = [];
let passivePollingRunning = false;

function handlePassivePollStatus(msg) {
  passiveTags = msg.tags || [];
  passivePollingRunning = msg.running;
  renderPassiveTagsSidebar();
}

function renderPassiveTagsSidebar() {
  const container = document.getElementById('passive-tag-list');
  const btn = document.getElementById('btn-toggle-polling');
  container.innerHTML = '';

  btn.textContent = passivePollingRunning ? 'Stop' : 'Start';

  if (passiveTags.length === 0) {
    container.innerHTML = '<p class="empty-state">No passive tags</p>';
    return;
  }

  for (const tag of passiveTags) {
    const card = document.createElement('div');
    card.className = 'device-card';
    const hex = '#ff453a';
    card.innerHTML = `
      <div class="device-header">
        <span class="device-dot" style="background:${hex}"></span>
        <span class="device-name">${tag.name || 'Tag ' + tag.id}</span>
        <button class="btn-locate" data-id="${tag.id}" style="color:#ff453a;border-color:#ff453a">Remove</button>
        <span class="device-mac">0x${tag.mac.toString(16).padStart(4, '0')}</span>
      </div>
    `;
    card.querySelector('.btn-locate').addEventListener('click', () => {
      if (ws && ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ type: 'remove_passive_tag', id: tag.id }));
      }
    });
    container.appendChild(card);
  }
}

function addPassiveTag() {
  const idStr = prompt('Passive tag device ID (hex, e.g. 0x0064):');
  if (!idStr) return;
  const id = parseInt(idStr, 16) || parseInt(idStr, 10);
  if (!id || id <= 0) return;
  const name = prompt('Tag name:', `Passive Tag ${id}`) || `Passive Tag ${id}`;

  if (ws && ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify({ type: 'add_passive_tag', id, mac: id, name }));
  }
}

function togglePassivePolling() {
  if (ws && ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify({ type: passivePollingRunning ? 'stop_passive_polling' : 'start_passive_polling' }));
  }
}

// ── Settings Modal ───────────────────────────────────────────────────────────

function openSettings(deviceId, deviceType, device) {
  const overlay = document.getElementById('settings-modal');
  const title = document.getElementById('settings-title');
  const body = document.getElementById('settings-body');

  const currentMode = deviceType === 'anchor' ? 0 : 1;
  const name = deviceType === 'anchor'
    ? (device.name || `Anchor ${deviceId}`)
    : `Tag 0x${deviceId.toString(16).padStart(4, '0').toUpperCase()}`;

  title.textContent = name;

  body.innerHTML = `
    <div class="setting-row">
      <span class="setting-label">Device ID</span>
      <span class="setting-value">0x${deviceId.toString(16).padStart(4, '0').toUpperCase()}</span>
    </div>
    <div class="setting-row">
      <span class="setting-label">MAC</span>
      <span class="setting-value">${device.mac}</span>
    </div>
    <div class="setting-row">
      <span class="setting-label">Mode</span>
      <select class="setting-select" id="settings-mode">
        <option value="0" ${currentMode === 0 ? 'selected' : ''}>Anchor</option>
        <option value="1" ${currentMode === 1 ? 'selected' : ''}>Active Tag</option>
        <option value="2">Passive Tag</option>
      </select>
    </div>
  `;

  document.getElementById('settings-mode').addEventListener('change', (e) => {
    const mode = parseInt(e.target.value);
    if (ws && ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({ type: 'set_device_mode', deviceId, mode }));
      closeSettings();
    }
  });

  overlay.classList.add('open');
}

function closeSettings() {
  document.getElementById('settings-modal').classList.remove('open');
}

// ── Rate Selector ────────────────────────────────────────────────────────────

function setActiveRate(rate) {
  const btns = document.querySelectorAll('.rate-btn');
  btns.forEach(btn => {
    btn.classList.toggle('active', btn.dataset.rate === rate);
  });
}

function onRateClick(e) {
  const btn = e.target.closest('.rate-btn');
  if (!btn || !ws || ws.readyState !== WebSocket.OPEN) return;

  const rate = btn.dataset.rate;
  ws.send(JSON.stringify({ type: 'set_tag_rate', rate }));
  setActiveRate(rate);
}

// ── Event Listeners ──────────────────────────────────────────────────────────

function initEventListeners() {
  window.addEventListener('resize', onResize);
  document.getElementById('log-toggle').addEventListener('click', toggleLog);
  document.getElementById('log-clear').addEventListener('click', clearLog);
  document.getElementById('rate-selector').addEventListener('click', onRateClick);
  document.getElementById('btn-add-passive').addEventListener('click', addPassiveTag);
  document.getElementById('btn-toggle-polling').addEventListener('click', togglePassivePolling);
  document.getElementById('settings-close').addEventListener('click', closeSettings);
  document.getElementById('settings-modal').addEventListener('click', (e) => {
    if (e.target.id === 'settings-modal') closeSettings();
  });
}
