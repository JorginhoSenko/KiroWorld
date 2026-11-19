/* 基洛世界地图台 · KiroWorld Atlas
 * 交互式架空地理编辑器：真实地球底图 + 可编辑陆块 + 经纬度定位造岛。
 */

// ── palette ────────────────────────────────────────────────────────
const C = {
  sea: '#b9d3dc',
  seaDeep: '#a3c2d0',
  grid: 'rgba(44, 90, 110, .22)',
  gridMajor: 'rgba(44, 90, 110, .38)',
  gridText: 'rgba(34, 60, 78, .62)',
  land: '#e8dfc9',
  landEdge: '#7d6f57',
  landUser: '#ebc88f',
  landUserEdge: '#b8791f',
  landSel: '#f6e3c0',
  landSelEdge: '#c4762e',
  label: 'rgba(34, 48, 60, .55)',
  labelSea: 'rgba(255, 255, 255, .62)',
  crosshair: 'rgba(196, 118, 46, .9)',
  vertex: '#c4762e',
  vertexFill: '#fffdf8',
  preview: '#2c6e68',
};

const LABELS = [
  { lon: -150, lat: 5, text: '太平洋', kind: 'sea', min: 0 },
  { lon: -32, lat: 12, text: '大西洋', kind: 'sea', min: 0 },
  { lon: 78, lat: -22, text: '印度洋', kind: 'sea', min: 0 },
  { lon: 0, lat: 78, text: '北冰洋', kind: 'sea', min: 0 },
  { lon: 20, lat: -68, text: '南冰洋', kind: 'sea', min: 0 },
  { lon: 95, lat: 48, text: '亚洲', kind: 'land', min: 0 },
  { lon: 15, lat: 52, text: '欧洲', kind: 'land', min: 0 },
  { lon: 20, lat: 6, text: '非洲', kind: 'land', min: 0 },
  { lon: -102, lat: 46, text: '北美洲', kind: 'land', min: 0 },
  { lon: -60, lat: -16, text: '南美洲', kind: 'land', min: 0 },
  { lon: 134, lat: -25, text: '大洋洲', kind: 'land', min: 0 },
  { lon: 8, lat: -78, text: '南极洲', kind: 'land', min: 0 },
  { lon: -42, lat: 73, text: '格陵兰', kind: 'land', min: 3 },
];

// ── state ──────────────────────────────────────────────────────────
const state = {
  view: { lon: 0, lat: 12, scale: 2 },
  tool: 'select',
  features: [],          // {id, name, source, visible, locked, dirty, rings}
  selection: new Set(),
  showBase: true,
  showGrid: true,
  showLabels: true,
  hover: null,           // {lon, lat} in degrees
  dirty: false,
  draft: null,           // in-progress drawing
  dragging: null,        // {mode, ...}
};

const els = {};
const $ = (id) => document.getElementById(id);

// ── geometry helpers ───────────────────────────────────────────────
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));

function project(lon, lat) {
  return [
    (lon - state.view.lon) * state.view.scale + els.canvas.clientWidth / 2,
    (state.view.lat - lat) * state.view.scale + els.canvas.clientHeight / 2,
  ];
}
function unproject(x, y) {
  return [
    state.view.lon + (x - els.canvas.clientWidth / 2) / state.view.scale,
    state.view.lat - (y - els.canvas.clientHeight / 2) / state.view.scale,
  ];
}

function pointInRing(lon, lat, ring) {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, yi] = ring[i];
    const [xj, yj] = ring[j];
    if ((yi > lat) !== (yj > lat) &&
        lon < (xj - xi) * (lat - yi) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

function featureAt(lon, lat) {
  // topmost first: user features are appended after base ones
  for (let i = state.features.length - 1; i >= 0; i--) {
    const f = state.features[i];
    if (!f.visible) continue;
    if (f.source === 'base' && !state.showBase) continue;
    for (const ring of f.rings) {
      if (pointInRing(lon, lat, ring)) return f;
    }
  }
  return null;
}

function featureBBox(f) {
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const ring of f.rings) {
    for (const [x, y] of ring) {
      if (x < x0) x0 = x;
      if (y < y0) y0 = y;
      if (x > x1) x1 = x;
      if (y > y1) y1 = y;
    }
  }
  return [x0, y0, x1, y1];
}

function featureArea(f) {
  // rough spherical-ish area in km², good enough for the inspector
  let a = 0;
  for (const ring of f.rings) {
    for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
      const [xi, yi] = ring[j];
      const [xj, yj] = ring[i];
      a += (xj - xi) * (2 + Math.sin(yi * Math.PI / 180) + Math.sin(yj * Math.PI / 180));
    }
  }
  return Math.abs(a * 6371 * 6371 * Math.PI / 360);
}

function vertexAt(x, y, radiusPx = 9) {
  const [lon, lat] = unproject(x, y);
  const tol = radiusPx / state.view.scale;
  for (const id of state.selection) {
    const f = state.features.find((it) => it.id === id);
    if (!f) continue;
    for (let r = 0; r < f.rings.length; r++) {
      const ring = f.rings[r];
      for (let i = 0; i < ring.length; i++) {
        const [vx, vy] = ring[i];
        if (Math.abs(vx - lon) <= tol && Math.abs(vy - lat) <= tol) {
          return { id, ring: r, index: i };
        }
      }
    }
  }
  return null;
}

function islandRing(lon, lat, radiusKm, rough, phase, k1, k2) {
  const n = 20;
  const dLat = radiusKm / 110.574;
  const dLon = radiusKm / (110.574 * Math.max(0.15, Math.cos(lat * Math.PI / 180)));
  const ring = [];
  for (let i = 0; i < n; i++) {
    const t = (i / n) * Math.PI * 2;
    const wobble = 1 + rough * (
      0.55 * Math.sin(k1 * t + phase) +
      0.35 * Math.sin(k2 * t + phase * 1.7) +
      0.18 * Math.sin((k2 + 3) * t + phase * 0.6)
    );
    ring.push([lon + Math.cos(t) * dLon * wobble, lat + Math.sin(t) * dLat * wobble]);
  }
  ring.push([...ring[0]]);
  return ring;
}

function makeIsland(lon, lat, radiusKm, rough = 0.35, name = '新岛屿', shape = null) {
  const s = shape || {
    phase: Math.random() * Math.PI * 2,
    k1: 2 + Math.floor(Math.random() * 2),
    k2: 5 + Math.floor(Math.random() * 3),
  };
  return {
    id: `user-${Date.now().toString(36)}-${Math.floor(Math.random() * 1e4)}`,
    name,
    source: 'user',
    visible: true,
    locked: false,
    dirty: true,
    rings: [islandRing(lon, lat, radiusKm, rough, s.phase, s.k1, s.k2)],
  };
}

// ── formatting ─────────────────────────────────────────────────────
function fmtLon(v) {
  const hemi = v < 0 ? 'W' : 'E';
  return `${Math.abs(v).toFixed(3)}°${hemi}`;
}
function fmtLat(v) {
  const hemi = v < 0 ? 'S' : 'N';
  return `${Math.abs(v).toFixed(3)}°${hemi}`;
}
function parseCoord(text, kind) {
  if (text == null) return null;
  const s = String(text).trim().replace(/[，]/g, ',');
  if (!s) return null;
  const m = s.match(/^(-?\d+(?:\.\d+)?)\s*°?\s*([NSEW])?$/i);
  if (m) {
    let v = parseFloat(m[1]);
    const h = (m[2] || '').toUpperCase();
    if (h === 'S' || h === 'W') v = -Math.abs(v);
    if (h === 'N' || h === 'E') v = Math.abs(v);
    return kind === 'lon' ? clamp(v, -180, 180) : clamp(v, -90, 90);
  }
  const plain = parseFloat(s);
  if (Number.isFinite(plain)) {
    return kind === 'lon' ? clamp(plain, -180, 180) : clamp(plain, -90, 90);
  }
  return null;
}

// ── rendering ──────────────────────────────────────────────────────
function resize() {
  const wrap = els.mapWrap;
  const dpr = window.devicePixelRatio || 1;
  const w = wrap.clientWidth;
  const h = wrap.clientHeight;
  els.canvas.width = Math.round(w * dpr);
  els.canvas.height = Math.round(h * dpr);
  els.canvas.style.width = `${w}px`;
  els.canvas.style.height = `${h}px`;
  render();
}

function graticuleStep() {
  const candidates = [45, 30, 15, 10, 5, 2, 1, 0.5, 0.25, 0.1, 0.05];
  for (const s of candidates) {
    if (s * state.view.scale >= 64) return s;
  }
  return 0.05;
}

function render() {
  const canvas = els.canvas;
  const ctx = canvas.getContext('2d');
  const dpr = window.devicePixelRatio || 1;
  const w = canvas.clientWidth;
  const h = canvas.clientHeight;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

  // sea
  const g = ctx.createLinearGradient(0, 0, 0, h);
  g.addColorStop(0, C.seaDeep);
  g.addColorStop(1, C.sea);
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, w, h);

  const [lonMin, latMax] = unproject(0, 0);
  const [lonMax, latMin] = unproject(w, h);

  // land
  for (const f of state.features) {
    if (!f.visible) continue;
    if (f.source === 'base' && !state.showBase) continue;
    const bb = featureBBox(f);
    if (bb[2] < lonMin || bb[0] > lonMax || bb[3] < latMin || bb[1] > latMax) continue;
    const isUser = f.source === 'user';
    const selected = state.selection.has(f.id);
    ctx.beginPath();
    for (const ring of f.rings) {
      let started = false;
      for (const [lon, lat] of ring) {
        const [x, y] = project(lon, lat);
        if (!started) { ctx.moveTo(x, y); started = true; }
        else ctx.lineTo(x, y);
      }
      if (started) ctx.closePath();
    }
    ctx.fillStyle = selected ? C.landSel : (isUser ? C.landUser : C.land);
    ctx.fill('evenodd');
    ctx.lineWidth = selected ? 1.6 : 0.85;
    ctx.strokeStyle = selected ? C.landSelEdge : (isUser ? C.landUserEdge : C.landEdge);
    ctx.stroke();
  }

  // graticule
  if (state.showGrid) {
    const step = graticuleStep();
    const majorEvery = step >= 30 ? 1 : (step >= 10 ? 2 : (step >= 5 ? 3 : 5));
    ctx.lineWidth = 1;
    ctx.font = '10px "Segoe UI", sans-serif';
    ctx.textAlign = 'left';
    ctx.textBaseline = 'top';
    let i = 0;
    for (let lon = Math.ceil(lonMin / step) * step; lon <= lonMax; lon += step) {
      const [x] = project(lon, 0);
      const major = Math.round(lon / step) % majorEvery === 0;
      ctx.strokeStyle = major ? C.gridMajor : C.grid;
      ctx.beginPath();
      ctx.moveTo(x, 0);
      ctx.lineTo(x, h);
      ctx.stroke();
      if (major) {
        ctx.fillStyle = C.gridText;
        ctx.fillText(`${degLabel(lon, 'lon')}`, x + 3, 4);
      }
      i++;
    }
    const latStart = Math.max(-90, Math.ceil(latMin / step) * step);
    const latEnd = Math.min(90, latMax);
    for (let lat = latStart; lat <= latEnd + 1e-9; lat += step) {
      const [, y] = project(0, lat);
      const major = Math.round(lat / step) % majorEvery === 0;
      ctx.strokeStyle = major ? C.gridMajor : C.grid;
      ctx.beginPath();
      ctx.moveTo(0, y);
      ctx.lineTo(w, y);
      ctx.stroke();
      if (major && y > 16) {
        ctx.fillStyle = C.gridText;
        ctx.fillText(`${degLabel(lat, 'lat')}`, 6, y + 3);
      }
    }
    // equator / prime meridian emphasis
    ctx.strokeStyle = 'rgba(44, 90, 110, .55)';
    ctx.lineWidth = 1.4;
    const [, yEq] = project(0, 0);
    if (yEq > -1 && yEq < h + 1) {
      ctx.beginPath(); ctx.moveTo(0, yEq); ctx.lineTo(w, yEq); ctx.stroke();
    }
    const [xPm] = project(0, 0);
    if (xPm > -1 && xPm < w + 1) {
      ctx.beginPath(); ctx.moveTo(xPm, 0); ctx.lineTo(xPm, h); ctx.stroke();
    }
  }

  // labels
  if (state.showLabels) {
    const zoomK = state.view.scale;
    for (const L of LABELS) {
      if (zoomK < L.min) continue;
      const [x, y] = project(L.lon, L.lat);
      if (x < -40 || x > w + 40 || y < -20 || y > h + 20) continue;
      ctx.font = `${L.kind === 'sea' ? 'italic ' : ''}${L.kind === 'sea' ? 13 : 15}px Georgia, "Songti SC", serif`;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillStyle = L.kind === 'sea' ? C.labelSea : C.label;
      if (L.kind === 'sea') {
        ctx.fillStyle = 'rgba(255,255,255,.75)';
      }
      ctx.fillText(L.text, x, y);
    }
  }

  // draft overlay
  if (state.draft) renderDraft(ctx, w, h);

  // vertex handles for selection
  for (const id of state.selection) {
    const f = state.features.find((it) => it.id === id);
    if (!f || !f.visible) continue;
    for (const ring of f.rings) {
      for (const [lon, lat] of ring) {
        const [x, y] = project(lon, lat);
        if (x < -20 || x > w + 20 || y < -20 || y > h + 20) continue;
        ctx.beginPath();
        ctx.rect(x - 3.5, y - 3.5, 7, 7);
        ctx.fillStyle = C.vertexFill;
        ctx.fill();
        ctx.lineWidth = 1.4;
        ctx.strokeStyle = C.vertex;
        ctx.stroke();
      }
    }
  }

  // crosshair
  if (state.hover) {
    const [x, y] = project(state.hover.lon, state.hover.lat);
    ctx.strokeStyle = C.crosshair;
    ctx.lineWidth = 1;
    ctx.setLineDash([4, 4]);
    ctx.beginPath();
    ctx.moveTo(x - 16, y); ctx.lineTo(x - 5, y);
    ctx.moveTo(x + 5, y); ctx.lineTo(x + 16, y);
    ctx.moveTo(x, y - 16); ctx.lineTo(x, y - 5);
    ctx.moveTo(x, y + 5); ctx.lineTo(x, y + 16);
    ctx.stroke();
    ctx.setLineDash([]);
    ctx.beginPath();
    ctx.arc(x, y, 14, 0, Math.PI * 2);
    ctx.strokeStyle = 'rgba(196, 118, 46, .38)';
    ctx.stroke();
  }
}

function roundNice(v) {
  if (Math.abs(v - Math.round(v)) < 1e-6) return String(Math.round(v));
  return String(Number(v.toFixed(2)));
}

function degLabel(v, kind) {
  const n = Number(roundNice(v));
  if (n === 0) return kind === 'lon' ? '0°' : '0°';
  const sign = n > 0 ? '+' : '−';
  return `${sign}${Math.abs(n)}°`;
}

function renderDraft(ctx, w, h) {
  const d = state.draft;
  if (d.type === 'island' || d.type === 'island-live') {
    const [cx, cy] = project(d.lon, d.lat);
    const rx = Math.abs(d.rx);
    const ry = Math.abs(d.ry);
    ctx.beginPath();
    ctx.arc(cx, cy, Math.max(rx, ry), 0, Math.PI * 2);
    ctx.strokeStyle = C.preview;
    ctx.lineWidth = 1.4;
    ctx.setLineDash([6, 5]);
    ctx.stroke();
    ctx.setLineDash([]);
    // compass ticks
    for (let k = 0; k < 4; k++) {
      const t = k * Math.PI / 2;
      ctx.beginPath();
      ctx.moveTo(cx + Math.cos(t) * (Math.max(rx, ry) - 6), cy + Math.sin(t) * (Math.max(rx, ry) - 6));
      ctx.lineTo(cx + Math.cos(t) * (Math.max(rx, ry) + 6), cy + Math.sin(t) * (Math.max(rx, ry) + 6));
      ctx.stroke();
    }
    // radius label
    const km = pxToKm(Math.max(rx, ry), d.lat);
    ctx.font = '12px "Segoe UI", sans-serif';
    ctx.fillStyle = 'rgba(34,48,60,.88)';
    const label = `半径 ${km.toFixed(1)} km`;
    const tw = ctx.measureText(label).width;
    const bx = cx + Math.max(rx, ry) + 10;
    const by = cy - 10;
    ctx.fillStyle = 'rgba(251,247,238,.92)';
    ctx.fillRect(bx, by, tw + 12, 22);
    ctx.strokeStyle = C.preview;
    ctx.strokeRect(bx, by, tw + 12, 22);
    ctx.fillStyle = 'rgba(34,48,60,.9)';
    ctx.fillText(label, bx + 6, by + 15);
    // faint preview polygon
    const ring = islandRing(d.lon, d.lat, km, d.rough ?? 0.35,
      d.shape.phase, d.shape.k1, d.shape.k2);
    ctx.beginPath();
    ring.forEach(([lon, lat], i) => {
      const [x, y] = project(lon, lat);
      if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
    });
    ctx.closePath();
    ctx.fillStyle = 'rgba(235, 200, 143, .55)';
    ctx.fill();
    ctx.strokeStyle = C.landUserEdge;
    ctx.lineWidth = 1.2;
    ctx.stroke();
  }

  if (d.type === 'draw') {
    const pts = d.points || [];
    if (pts.length) {
      ctx.beginPath();
      pts.forEach(([lon, lat], i) => {
        const [x, y] = project(lon, lat);
        if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
      });
      if (d.cursor) {
        const [x, y] = project(d.cursor[0], d.cursor[1]);
        ctx.lineTo(x, y);
      }
      ctx.strokeStyle = C.preview;
      ctx.lineWidth = 1.6;
      ctx.setLineDash([5, 4]);
      ctx.stroke();
      ctx.setLineDash([]);
      for (const [lon, lat] of pts) {
        const [x, y] = project(lon, lat);
        ctx.beginPath();
        ctx.arc(x, y, 3.2, 0, Math.PI * 2);
        ctx.fillStyle = C.vertexFill;
        ctx.fill();
        ctx.strokeStyle = C.preview;
        ctx.lineWidth = 1.3;
        ctx.stroke();
      }
    }
  }

  if (d.type === 'move-feature') {
    ctx.fillStyle = 'rgba(44,110,104,.08)';
  }
}

function pxToKm(px, lat) {
  const deg = px / state.view.scale;
  return deg * 110.574 * Math.max(0.2, Math.cos(lat * Math.PI / 180));
}

// ── feature store ──────────────────────────────────────────────────
function markDirty() {
  state.dirty = true;
  els.statusSave.textContent = '未保存改动';
  els.statusSave.className = 'dirty';
  scheduleAutosave();
  scheduleListRefresh();
  updateCounts();
}

let listRefreshTimer = null;
function scheduleListRefresh() {
  clearTimeout(listRefreshTimer);
  listRefreshTimer = setTimeout(refreshList, 160);
}

function addFeature(f) {
  state.features.push(f);
  state.selection = new Set([f.id]);
  markDirty();
  render();
  updateInspector();
}

function removeFeature(id) {
  const i = state.features.findIndex((f) => f.id === id);
  if (i < 0) return;
  state.features.splice(i, 1);
  state.selection.delete(id);
  markDirty();
  render();
  updateInspector();
}

function selectedFeature() {
  const id = [...state.selection][0];
  return state.features.find((f) => f.id === id) || null;
}

// ── tools / pointer input ──────────────────────────────────────────
function setTool(name) {
  state.tool = name;
  state.draft = null;
  document.querySelectorAll('.tool[data-tool]').forEach((b) => {
    b.classList.toggle('is-active', b.dataset.tool === name);
  });
  els.mapWrap.dataset.tool = name;
  els.drawHint.hidden = true;
  if (name === 'draw') {
    els.drawHint.hidden = false;
    els.drawHint.textContent = '手绘陆地：依次点击顶点，回车 / 双击 / 点击起点闭合，Esc 取消';
  }
  if (name === 'island') {
    els.drawHint.hidden = false;
    els.drawHint.textContent = '圆规造岛：在图上按下并拖出半径，松开即生成';
  }
  els.statusTool.textContent = {
    select: '选择', hand: '平移', island: '造岛', draw: '手绘', erase: '擦除',
  }[name] || name;
  render();
}

function pointerPos(e) {
  const r = els.canvas.getBoundingClientRect();
  return [e.clientX - r.left, e.clientY - r.top];
}

function capturePointer(e) {
  try { els.canvas.setPointerCapture(e.pointerId); } catch { /* synthetic or already-released pointer */ }
}

function onPointerDown(e) {
  if (e.button === 1 || state.spaceDown || state.tool === 'hand') {
    state.dragging = {
      mode: 'pan',
      x: e.clientX, y: e.clientY,
      lon: state.view.lon, lat: state.view.lat,
    };
    els.canvas.classList.add('is-panning');
    capturePointer(e);
    return;
  }
  if (e.button !== 0) return;
  const [x, y] = pointerPos(e);
  const [lon, lat] = unproject(x, y);

  if (state.tool === 'island') {
    state.draft = {
      type: 'island',
      lon, lat, rx: 0, ry: 0,
      rough: Number($('islandRough').value) || 0.35,
      shape: {
        phase: Math.random() * Math.PI * 2,
        k1: 2 + Math.floor(Math.random() * 2),
        k2: 5 + Math.floor(Math.random() * 3),
      },
    };
    state.dragging = { mode: 'island' };
    capturePointer(e);
    render();
    return;
  }

  if (state.tool === 'draw') {
    const pts = state.draft?.type === 'draw' ? state.draft.points : [];
    if (pts.length >= 3) {
      const [fx, fy] = project(pts[0][0], pts[0][1]);
      if (Math.hypot(fx - x, fy - y) < 10) {
        commitDraw(pts);
        return;
      }
    }
    pts.push([lon, lat]);
    state.draft = { type: 'draw', points: pts, cursor: [lon, lat] };
    render();
    return;
  }

  if (state.tool === 'erase') {
    const f = featureAt(lon, lat);
    if (f) {
      removeFeature(f.id);
      els.statusSave.textContent = `已删除「${f.name}」`;
    }
    return;
  }

  // select tool
  const v = vertexAt(x, y);
  if (v) {
    state.selection = new Set([v.id]);
    state.dragging = { mode: 'vertex', ...v };
    capturePointer(e);
    updateInspector();
    render();
    return;
  }

  const f = featureAt(lon, lat);
  if (f) {
    const already = state.selection.has(f.id);
    state.selection = new Set([f.id]);
    if (already && !f.locked) {
      state.dragging = {
        mode: 'move',
        id: f.id,
        startLon: lon,
        startLat: lat,
        orig: f.rings.map((ring) => ring.map((p) => [...p])),
      };
      capturePointer(e);
    }
    updateInspector();
    render();
  } else {
    state.selection.clear();
    updateInspector();
    render();
  }
}

function onPointerMove(e) {
  const [x, y] = pointerPos(e);
  state.lastX = x;
  state.lastY = y;
  const [lon, lat] = unproject(x, y);
  state.hover = { lon, lat };

  // live readout
  els.coordChip.hidden = false;
  els.coordChip.textContent = `${fmtLon(lon)}   ${fmtLat(lat)}`;
  els.coordChip.style.left = `${x}px`;
  els.coordChip.style.top = `${y}px`;
  els.statusCoords.textContent = `${fmtLon(lon)}  ${fmtLat(lat)}`;

  const drag = state.dragging;
  if (drag) {
    if (drag.mode === 'pan') {
      const dx = e.clientX - drag.x;
      const dy = e.clientY - drag.y;
      state.view.lon = drag.lon - dx / state.view.scale;
      state.view.lat = drag.lat + dy / state.view.scale;
      state.view.lon = clamp(state.view.lon, -360, 360);
      state.view.lat = clamp(state.view.lat, -90, 90);
    } else if (drag.mode === 'island') {
      const cx = (state.draft.lon - state.view.lon) * state.view.scale + els.canvas.clientWidth / 2;
      const cy = (state.view.lat - state.draft.lat) * state.view.scale + els.canvas.clientHeight / 2;
      state.draft.rx = x - cx;
      state.draft.ry = y - cy;
    } else if (drag.mode === 'vertex') {
      const f = state.features.find((it) => it.id === drag.id);
      if (f && !f.locked) {
        const ring = f.rings[drag.ring];
        ring[drag.index] = [lon, lat];
        // keep ring closed
        if (drag.index === 0 && ring.length > 1) ring[ring.length - 1] = [lon, lat];
        if (drag.index === ring.length - 1 && ring.length > 1) ring[0] = [lon, lat];
        f.dirty = true;
        markDirty();
      }
    } else if (drag.mode === 'move') {
      const f = state.features.find((it) => it.id === drag.id);
      if (f && !f.locked) {
        const dLon = lon - drag.startLon;
        const dLat = lat - drag.startLat;
        f.rings = drag.orig.map((ring) => ring.map(([px, py]) => [px + dLon, py + dLat]));
        f.dirty = true;
        markDirty();
      }
    }
    render();
    return;
  }

  if (state.draft?.type === 'draw') {
    state.draft.cursor = [lon, lat];
    render();
    return;
  }

  render();
}

function onPointerUp(e) {
  const drag = state.dragging;
  state.dragging = null;
  els.canvas.classList.remove('is-panning');
  if (!drag) return;

  if (drag.mode === 'island' && state.draft) {
    const d = state.draft;
    const km = pxToKm(Math.max(Math.abs(d.rx), Math.abs(d.ry)), d.lat);
    state.draft = null;
    if (km >= 1.5) {
      const name = ($('islandName')?.value || '').trim() || `岛屿 ${state.features.filter((f) => f.source === 'user').length + 1}`;
      const f = makeIsland(d.lon, d.lat, km, d.rough ?? 0.35, name, d.shape);
      addFeature(f);
      els.statusSave.textContent = `已造岛「${f.name}」 · 半径 ${km.toFixed(1)} km`;
      if ($('islandName')) $('islandName').value = '';
    }
    render();
    return;
  }

  if (drag.mode === 'vertex' || drag.mode === 'move') {
    updateInspector();
    render();
  }
}

function onDblClick(e) {
  if (state.tool === 'draw' && state.draft?.type === 'draw') {
    commitDraw(state.draft.points);
    return;
  }
  if (state.tool !== 'select') return;
  const [x, y] = pointerPos(e);
  const [lon, lat] = unproject(x, y);
  const v = vertexAt(x, y);
  if (v) return; // let the vertex be
  const f = selectedFeature();
  if (!f) return;
  // insert vertex on nearest edge of the feature
  let best = null;
  for (let r = 0; r < f.rings.length; r++) {
    const ring = f.rings[r];
    for (let i = 0; i < ring.length - 1; i++) {
      const [ax, ay] = ring[i];
      const [bx, by] = ring[i + 1];
      const t = projectPointSegment(lon, lat, ax, ay, bx, by);
      if (!best || t.dist < best.dist) best = { ...t, ring: r, index: i + 1 };
    }
  }
  if (best) {
    f.rings[best.ring].splice(best.index, 0, [best.x, best.y]);
    f.dirty = true;
    markDirty();
    render();
    updateInspector();
  }
}

function projectPointSegment(px, py, ax, ay, bx, by) {
  const dx = bx - ax;
  const dy = by - ay;
  const len2 = dx * dx + dy * dy;
  let t = len2 ? ((px - ax) * dx + (py - ay) * dy) / len2 : 0;
  t = clamp(t, 0, 1);
  const x = ax + t * dx;
  const y = ay + t * dy;
  return { x, y, dist: Math.hypot(px - x, py - y) };
}

function onWheel(e) {
  e.preventDefault();
  const [x, y] = pointerPos(e);
  const before = unproject(x, y);
  const factor = Math.exp(-e.deltaY * 0.0016);
  const minScale = els.canvas.clientWidth / 400;
  const maxScale = 900;
  state.view.scale = clamp(state.view.scale * factor, minScale, maxScale);
  const after = unproject(x, y);
  state.view.lon += before[0] - after[0];
  state.view.lat += before[1] - after[1];
  els.statusZoom.textContent = `缩放 ${state.view.scale.toFixed(2)} px/°`;
  render();
}

function commitDraw(points) {
  if (!points || points.length < 3) {
    state.draft = null;
    render();
    return;
  }
  const ring = points.map((p) => [...p]);
  ring.push([...ring[0]]);
  const f = {
    id: `user-${Date.now().toString(36)}-${Math.floor(Math.random() * 1e4)}`,
    name: ($('islandName')?.value || '').trim() || `手绘陆地 ${state.features.filter((x) => x.source === 'user').length + 1}`,
    source: 'user',
    visible: true,
    locked: false,
    dirty: true,
    rings: [ring],
  };
  state.draft = null;
  addFeature(f);
  els.statusSave.textContent = `已绘制「${f.name}」 · ${ring.length - 1} 个顶点`;
}

function deleteSelectedVerticesOrFeature() {
  const x = state.lastX ?? -1;
  const y = state.lastY ?? -1;
  const v = (x >= 0) ? vertexAt(x, y) : null;
  if (v) {
    const f = state.features.find((it) => it.id === v.id);
    const ring = f.rings[v.ring];
    if (ring.length > 4) {
      ring.splice(v.index, 1);
      if (v.index === 0) ring[ring.length - 1] = [...ring[0]];
      f.dirty = true;
      markDirty();
      render();
      updateInspector();
      return;
    }
  }
  for (const id of [...state.selection]) removeFeature(id);
  render();
}

// ── UI: inspector & list ───────────────────────────────────────────
function updateInspector() {
  const f = selectedFeature();
  const multi = state.selection.size > 1;
  $('selEmpty').hidden = !!f || multi;
  $('selBody').hidden = !f;
  if (!f) {
    if (multi) {
      $('selEmpty').hidden = false;
      $('selEmpty').textContent = `已选中 ${state.selection.size} 个陆块。`;
    }
    return;
  }
  $('selName').value = f.name;
  const [x0, y0, x1, y1] = featureBBox(f);
  const area = featureArea(f);
  const pts = f.rings.reduce((n, r) => n + r.length, 0);
  $('selMeta').textContent =
    `id: ${f.id}\n` +
    `来源: ${f.source === 'base' ? '原始地球底图' : '自定义'}\n` +
    `顶点: ${pts}   环: ${f.rings.length}\n` +
    `范围: ${fmtLon(x0)} ~ ${fmtLon(x1)}\n` +
    `       ${fmtLat(y0)} ~ ${fmtLat(y1)}\n` +
    `面积: ≈ ${area >= 10000 ? (area / 10000).toFixed(1) + ' 万 km²' : area.toFixed(0) + ' km²'}`;
}

function refreshList() {
  const q = ($('featureFilter').value || '').trim().toLowerCase();
  const list = $('featureList');
  list.innerHTML = '';
  const matched = state.features.filter((f) => {
    if (!q) return true;
    return f.name.toLowerCase().includes(q) || f.id.toLowerCase().includes(q);
  });
  // user features first, then base
  matched.sort((a, b) => {
    if (a.source !== b.source) return a.source === 'user' ? -1 : 1;
    return a.name.localeCompare(b.name, 'zh');
  });
  const cap = 220;
  const shown = matched.slice(0, cap);
  for (const f of shown) {
    const li = document.createElement('li');
    li.className = state.selection.has(f.id) ? 'is-selected' : '';
    li.dataset.id = f.id;
    li.innerHTML =
      `<span class="dots ${f.source === 'user' ? 'user' : ''}"></span>` +
      `<span class="name"></span>` +
      `<span class="badge ${f.source === 'user' ? 'user' : 'base'}">${f.source === 'user' ? '自定义' : '底图'}</span>`;
    li.querySelector('.name').textContent = f.name;
    li.addEventListener('click', () => {
      state.selection = new Set([f.id]);
      updateInspector();
      refreshList();
      render();
    });
    li.addEventListener('dblclick', () => zoomToFeature(f));
    list.appendChild(li);
  }
  if (matched.length > cap) {
    const more = document.createElement('li');
    more.className = 'more';
    more.textContent = `还有 ${matched.length - cap} 个，请用筛选缩小范围`;
    list.appendChild(more);
  }
  if (!matched.length) {
    const more = document.createElement('li');
    more.className = 'more';
    more.textContent = '没有匹配的陆块';
    list.appendChild(more);
  }
}

function updateCounts() {
  const total = state.features.length;
  const user = state.features.filter((f) => f.source === 'user').length;
  const sel = state.selection.size;
  els.statusCounts.textContent = `陆块 ${total} · 自定义 ${user}${sel ? ` · 选中 ${sel}` : ''}`;
}

function zoomToFeature(f) {
  const [x0, y0, x1, y1] = featureBBox(f);
  const w = els.canvas.clientWidth;
  const h = els.canvas.clientHeight;
  const pad = 1.25;
  const sx = w / Math.max(0.2, (x1 - x0) * pad);
  const sy = h / Math.max(0.2, (y1 - y0) * pad);
  state.view.lon = (x0 + x1) / 2;
  state.view.lat = (y0 + y1) / 2;
  state.view.scale = clamp(Math.min(sx, sy), els.canvas.clientWidth / 400, 900);
  els.statusZoom.textContent = `缩放 ${state.view.scale.toFixed(2)} px/°`;
  render();
}

function zoomFit() {
  const w = els.canvas.clientWidth;
  const h = els.canvas.clientHeight;
  state.view.lon = 0;
  state.view.lat = 8;
  state.view.scale = Math.min(w / 360, h / 190) * 0.96;
  els.statusZoom.textContent = `缩放 ${state.view.scale.toFixed(2)} px/°`;
  render();
}

// ── IO: project save / load / export ───────────────────────────────
function projectPayload() {
  const baseDeletions = [];
  const baseOverrides = {};
  const userFeatures = [];
  const original = window.__baseLandIds || new Set();

  for (const f of state.features) {
    if (f.source === 'user') {
      userFeatures.push(featureToJSON(f));
    } else if (f.dirty || !f.visible) {
      baseOverrides[f.id] = featureToJSON(f);
    }
  }
  for (const id of original) {
    if (!state.features.some((f) => f.id === id)) baseDeletions.push(id);
  }
  return {
    version: 1,
    app: 'kiroworld-atlas',
    name: els.projectName.value || '未命名世界',
    savedAt: new Date().toISOString(),
    view: { ...state.view },
    showBase: state.showBase,
    showGrid: state.showGrid,
    showLabels: state.showLabels,
    baseDeletions,
    baseOverrides,
    userFeatures,
  };
}

function featureToJSON(f) {
  return {
    id: f.id,
    name: f.name,
    source: f.source,
    visible: f.visible,
    locked: f.locked,
    rings: f.rings,
  };
}

function featureFromJSON(j) {
  return {
    id: j.id,
    name: j.name || j.id,
    source: j.source || 'user',
    visible: j.visible !== false,
    locked: !!j.locked,
    dirty: j.source === 'user',
    rings: j.rings,
  };
}

function saveProjectFile() {
  const payload = projectPayload();
  downloadJSON(payload, `${safeName(payload.name)}.kiroworld.json`);
  state.dirty = false;
  els.statusSave.textContent = '已保存';
  els.statusSave.className = 'saved';
}

function loadProjectPayload(payload) {
  if (!payload || payload.app !== 'kiroworld-atlas') {
    alert('这不是有效的 KiroWorld 项目文件。');
    return;
  }
  applyBaseThenUser(payload);
  els.projectName.value = payload.name || '未命名世界';
  if (payload.view) {
    state.view = {
      lon: payload.view.lon ?? 0,
      lat: payload.view.lat ?? 12,
      scale: payload.view.scale ?? 2,
    };
  }
  state.showBase = payload.showBase !== false;
  state.showGrid = payload.showGrid !== false;
  state.showLabels = payload.showLabels !== false;
  syncToggles();
  state.selection.clear();
  state.dirty = false;
  els.statusSave.textContent = `已打开「${els.projectName.value}」`;
  els.statusSave.className = 'saved';
  updateInspector();
  refreshList();
  updateCounts();
  render();
}

function applyBaseThenUser(payload) {
  const deletions = new Set(payload.baseDeletions || []);
  const overrides = payload.baseOverrides || {};
  const base = (window.__baseLand || []).map((f) => featureFromJSON(f))
    .filter((f) => !deletions.has(f.id))
    .map((f) => {
      const o = overrides[f.id];
      if (o) {
        return {
          ...f,
          name: o.name ?? f.name,
          visible: o.visible !== false,
          locked: !!o.locked,
          rings: o.rings ?? f.rings,
          dirty: true,
        };
      }
      return f;
    });
  const user = (payload.userFeatures || []).map(featureFromJSON);
  state.features = [...base, ...user];
}

function exportGeoJSON() {
  const features = state.features
    .filter((f) => f.visible && (f.source === 'user' || state.showBase))
    .map((f) => ({
      type: 'Feature',
      id: f.id,
      properties: {
        id: f.id,
        name: f.name,
        source: f.source,
      },
      geometry: {
        type: 'Polygon',
        coordinates: f.rings,
      },
    }));
  downloadJSON({ type: 'FeatureCollection', features }, `${safeName(els.projectName.value)}.geojson`);
}

function exportPNG() {
  const scale = 2;
  const w = els.canvas.clientWidth;
  const h = els.canvas.clientHeight;
  const off = document.createElement('canvas');
  off.width = w * scale;
  off.height = h * scale;
  const ctx = off.getContext('2d');
  ctx.scale(scale, scale);
  // temporarily render into offscreen by swapping canvas ref is messy;
  // simplest: draw the current canvas scaled up.
  ctx.imageSmoothingEnabled = true;
  ctx.drawImage(els.canvas, 0, 0, w, h);
  off.toBlob((blob) => {
    downloadBlob(blob, `${safeName(els.projectName.value)}.png`);
  }, 'image/png');
}

function exportSVG() {
  const w = els.canvas.clientWidth;
  const h = els.canvas.clientHeight;
  const parts = [];
  parts.push(`<?xml version="1.0" encoding="UTF-8"?>`);
  parts.push(`<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}">`);
  parts.push(`<rect width="${w}" height="${h}" fill="${C.sea}"/>`);
  for (const f of state.features) {
    if (!f.visible) continue;
    if (f.source === 'base' && !state.showBase) continue;
    const isUser = f.source === 'user';
    const d = f.rings.map((ring) => {
      return ring.map(([lon, lat], i) => {
        const [x, y] = project(lon, lat);
        return `${i === 0 ? 'M' : 'L'}${x.toFixed(2)},${y.toFixed(2)}`;
      }).join('') + 'Z';
    }).join(' ');
    parts.push(
      `<path d="${d}" fill="${isUser ? C.landUser : C.land}" fill-rule="evenodd" ` +
      `stroke="${isUser ? C.landUserEdge : C.landEdge}" stroke-width="${isUser ? 1.1 : 0.85}"/>`
    );
  }
  if (state.showGrid) {
    const step = graticuleStep();
    for (let lon = Math.ceil(unproject(0, 0)[0] / step) * step; lon <= unproject(w, h)[0]; lon += step) {
      const [x] = project(lon, 0);
      parts.push(`<line x1="${x.toFixed(1)}" y1="0" x2="${x.toFixed(1)}" y2="${h}" stroke="${C.grid}" stroke-width="1"/>`);
    }
    for (let lat = Math.ceil(unproject(0, h)[1] / step) * step; lat <= unproject(w, 0)[1]; lat += step) {
      const [, y] = project(0, lat);
      parts.push(`<line x1="0" y1="${y.toFixed(1)}" x2="${w}" y2="${y.toFixed(1)}" stroke="${C.grid}" stroke-width="1"/>`);
    }
  }
  parts.push(`</svg>`);
  downloadBlob(new Blob([parts.join('\n')], { type: 'image/svg+xml' }), `${safeName(els.projectName.value)}.svg`);
}

function safeName(s) {
  return (s || '未命名世界').replace(/[\\/:*?"<>|]/g, '_').slice(0, 60);
}
function downloadJSON(obj, filename) {
  downloadBlob(new Blob([JSON.stringify(obj, null, 2)], { type: 'application/json' }), filename);
}
function downloadBlob(blob, filename) {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = filename;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 2000);
}

// ── autosave ───────────────────────────────────────────────────────
let autosaveTimer = null;
function scheduleAutosave() {
  clearTimeout(autosaveTimer);
  autosaveTimer = setTimeout(() => {
    try {
      localStorage.setItem('kiroworld-atlas-autosave', JSON.stringify(projectPayload()));
    } catch { /* quota; ignore */ }
  }, 800);
}

function tryRestoreAutosave() {
  try {
    const raw = localStorage.getItem('kiroworld-atlas-autosave');
    if (!raw) return false;
    const payload = JSON.parse(raw);
    if (!payload || payload.app !== 'kiroworld-atlas') return false;
    loadProjectPayload(payload);
    els.statusSave.textContent = '已恢复上次自动存档';
    els.statusSave.className = 'saved';
    return true;
  } catch {
    return false;
  }
}

// ── keyboard & buttons ─────────────────────────────────────────────
function syncToggles() {
  $('toggleBase').classList.toggle('is-on', state.showBase);
  $('toggleGrid').classList.toggle('is-on', state.showGrid);
  $('toggleLabels').classList.toggle('is-on', state.showLabels);
}

function bindUI() {
  document.querySelectorAll('.tool[data-tool]').forEach((b) => {
    b.addEventListener('click', () => setTool(b.dataset.tool));
  });

  document.querySelectorAll('[data-action]').forEach((b) => {
    b.addEventListener('click', () => handleAction(b.dataset.action));
  });

  $('featureFilter').addEventListener('input', refreshList);
  $('selName').addEventListener('input', () => {
    const f = selectedFeature();
    if (!f) return;
    f.name = $('selName').value || f.name;
    f.dirty = true;
    markDirty();
    updateInspector();
  });

  $('toggleBase').addEventListener('click', () => {
    state.showBase = !state.showBase;
    syncToggles();
    render();
  });
  $('toggleGrid').addEventListener('click', () => {
    state.showGrid = !state.showGrid;
    syncToggles();
    render();
  });
  $('toggleLabels').addEventListener('click', () => {
    state.showLabels = !state.showLabels;
    syncToggles();
    render();
  });

  els.canvas.addEventListener('pointerdown', onPointerDown);
  els.canvas.addEventListener('pointermove', onPointerMove);
  els.canvas.addEventListener('pointerup', onPointerUp);
  els.canvas.addEventListener('pointercancel', onPointerUp);
  els.canvas.addEventListener('dblclick', onDblClick);
  els.canvas.addEventListener('wheel', onWheel, { passive: false });
  els.canvas.addEventListener('contextmenu', (e) => {
    e.preventDefault();
    const [x, y] = pointerPos(e);
    const v = vertexAt(x, y);
    if (v) {
      const f = state.features.find((it) => it.id === v.id);
      const ring = f.rings[v.ring];
      if (ring.length > 4) {
        ring.splice(v.index, 1);
        if (v.index === 0) ring[ring.length - 1] = [...ring[0]];
        f.dirty = true;
        markDirty();
        render();
      }
    }
  });

  window.addEventListener('keydown', (e) => {
    const t = e.target;
    if (t && typeof t.matches === 'function' && t.matches('input, textarea')) {
      if (e.key === 'Enter' && (t.id === 'goLon' || t.id === 'goLat')) {
        handleAction('go-to');
      }
      return;
    }
    if (e.code === 'Space') {
      state.spaceDown = true;
      els.canvas.classList.add('is-panning');
      e.preventDefault();
      return;
    }
    const k = e.key.toLowerCase();
    if (k === 'v') setTool('select');
    else if (k === 'h') setTool('hand');
    else if (k === 'i') setTool('island');
    else if (k === 'd') setTool('draw');
    else if (k === 'e') setTool('erase');
    else if (e.key === 'Escape') {
      state.draft = null;
      render();
    } else if (e.key === 'Enter' && state.draft?.type === 'draw') {
      commitDraw(state.draft.points);
    } else if (e.key === 'Delete' || e.key === 'Backspace') {
      e.preventDefault();
      deleteSelectedVerticesOrFeature();
    }
  });
  window.addEventListener('keyup', (e) => {
    if (e.code === 'Space') {
      state.spaceDown = false;
      if (!state.dragging) els.canvas.classList.remove('is-panning');
    }
  });

  window.addEventListener('resize', resize);
}

function handleAction(name) {
  switch (name) {
    case 'new': {
      if (state.dirty && !confirm('当前有未保存改动，确定清空并回到原始地球？')) return;
      applyBaseThenUser({ baseDeletions: [], baseOverrides: {}, userFeatures: [] });
      state.selection.clear();
      state.dirty = false;
      els.projectName.value = '未命名世界';
      els.statusSave.textContent = '已新建';
      els.statusSave.className = 'saved';
      zoomFit();
      updateInspector();
      refreshList();
      updateCounts();
      break;
    }
    case 'save':
    case 'export-project':
      saveProjectFile();
      break;
    case 'load':
      $('fileInput').value = '';
      $('fileInput').click();
      break;
    case 'export-geojson':
      exportGeoJSON();
      break;
    case 'export-png':
      exportPNG();
      break;
    case 'export-svg':
      exportSVG();
      break;
    case 'zoom-fit':
      zoomFit();
      break;
    case 'go-to': {
      const lon = parseCoord($('goLon').value, 'lon');
      const lat = parseCoord($('goLat').value, 'lat');
      if (lon == null || lat == null) {
        alert('请填写有效的经纬度，例如 -150 与 -20，或 150°W 与 20°S。');
        return;
      }
      state.view.lon = lon;
      state.view.lat = lat;
      state.view.scale = Math.max(state.view.scale, 18);
      els.statusZoom.textContent = `缩放 ${state.view.scale.toFixed(2)} px/°`;
      render();
      break;
    }
    case 'go-place':
    case 'island-preview': {
      let lon = parseCoord($('goLon').value, 'lon');
      let lat = parseCoord($('goLat').value, 'lat');
      if (lon == null || lat == null) {
        lon = state.view.lon;
        lat = state.view.lat;
      }
      const km = Number($('islandRadius').value) || 120;
      const rough = Number($('islandRough').value) || 0.35;
      const name = ($('islandName').value || '').trim() || `岛屿 ${state.features.filter((f) => f.source === 'user').length + 1}`;
      const f = makeIsland(lon, lat, km, rough, name);
      addFeature(f);
      state.view.lon = lon;
      state.view.lat = lat;
      state.view.scale = Math.max(state.view.scale, 18);
      $('islandName').value = '';
      els.statusSave.textContent = `已在 ${fmtLon(lon)} ${fmtLat(lat)} 造岛「${f.name}」`;
      render();
      break;
    }
    case 'sel-zoom': {
      const f = selectedFeature();
      if (f) zoomToFeature(f);
      break;
    }
    case 'sel-toggle': {
      const f = selectedFeature();
      if (!f) return;
      f.visible = !f.visible;
      f.dirty = true;
      markDirty();
      render();
      break;
    }
    case 'sel-del': {
      for (const id of [...state.selection]) removeFeature(id);
      render();
      break;
    }
  }
}

// ── boot ───────────────────────────────────────────────────────────
async function boot() {
  els.canvas = $('map');
  els.mapWrap = $('mapWrap');
  els.coordChip = $('coordChip');
  els.drawHint = $('drawHint');
  els.statusTool = $('statusTool');
  els.statusCoords = $('statusCoords');
  els.statusZoom = $('statusZoom');
  els.statusCounts = $('statusCounts');
  els.statusSave = $('statusSave');
  els.projectName = $('projectName');

  bindUI();
  syncToggles();
  resize();
  zoomFit();

  els.statusSave.textContent = '正在载入底图…';
  let land;
  try {
    const res = await fetch('data/land.geojson');
    land = await res.json();
  } catch (err) {
    els.statusSave.textContent = '底图载入失败';
    console.error(err);
    alert('无法载入 data/land.geojson。请确认通过本地服务器访问本页（而不是直接双击打开 HTML）。');
    return;
  }

  window.__baseLand = land.features.map((f) => ({
    id: f.properties.id || f.id,
    name: f.properties.name || f.id,
    source: 'base',
    visible: true,
    locked: false,
    dirty: false,
    rings: f.geometry.coordinates,
  }));
  window.__baseLandIds = new Set(window.__baseLand.map((f) => f.id));

  if (!tryRestoreAutosave()) {
    state.features = window.__baseLand.map((f) => ({ ...f }));
    els.statusSave.textContent = '就绪 · 未保存';
    els.statusSave.className = '';
    refreshList();
    updateCounts();
    render();
  }

  $('fileInput').addEventListener('change', async (e) => {
    const file = e.target.files?.[0];
    if (!file) return;
    try {
      const payload = JSON.parse(await file.text());
      loadProjectPayload(payload);
    } catch {
      alert('文件解析失败，请确认是本工具导出的 .kiroworld.json。');
    }
  });

  els.statusZoom.textContent = `缩放 ${state.view.scale.toFixed(2)} px/°`;
  updateCounts();
  render();
}

boot();
