/*
 * haus-anflug-card  –  Kamerafahrt beim Oeffnen: Erdkugel im All -> durch die Wolken -> Landung auf dem Haus.
 *
 * Echte Satellitenbilder (Esri World Imagery), Koordinaten aus Home Assistant (zone.home) oder aus der Konfiguration.
 * Antippen = ueberspringen.
 *
 * Zwei Arten der Nutzung:
 *  1. Eigene Ansicht: nach der Landung erscheinen Titel und Knoepfe; mit "ziel" geht es nach "warten" Sekunden automatisch weiter.
 *       type: custom:haus-anflug-card
 *       titel: Zuhause
 *       untertitel: Robert-Koch-Str. 11
 *       temperatur: sensor.aussenfuhler_temperature     (optional)
 *       ziel: /grundriss-eg/eg                           (optional)
 *       warten: 3                                        (optional, Sekunden nach der Landung)
 *       nav: [{ label: Haus, path: /grundriss-eg/eg }, …] (optional, Knoepfe nach der Landung)
 *  2. Als Vorspann vor einer anderen Karte ("card"): der Flug liegt darueber und blendet nach der Landung in die Karte ueber.
 *       type: custom:haus-anflug-card
 *       einmal: true            (Standard: nur einmal je Browser-Sitzung, danach sofort die Karte)
 *       card: { type: custom:raum-rundumblick-card, … }
 *
 * Weitere Angaben (optional): lat, lon, zoom (Endzoom, Standard 19.6), dauer (Sekunden, Standard 11), height, kacheln (Kachel-URL mit {z} {x} {y}).
 */
const HAC_VERSION = '1.0.1';
// 1.0.1 (18.10.2026): Flug auch bei "Bewegung reduzieren" (Android: Animationen entfernen) – vorher startete die Karte gleich auf dem Haus.
const TILE_URL = 'https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}';
const Z0 = 1.3;            // Start: ganze Erdkugel
const GLOBUS_BIS = 6.2;    // ab hier flache Karte statt Kugel (unter der Wolkendecke)
const REGION_Z = 6;        // scharfe Kacheln rund ums Haus fuer die grosse Kugel
const WOLKEN = [{ z: 7.0, s: 1.0, dx: 0.13, dy: 0.31 }, { z: 7.9, s: 0.75, dx: 0.57, dy: 0.08 }, { z: 8.9, s: 1.3, dx: 0.81, dy: 0.66 }];

const clamp = (x, a, b) => Math.max(a, Math.min(b, x));
const sstep = (a, b, x) => { const t = clamp((x - a) / (b - a), 0, 1); return t * t * (3 - 2 * t); };
const lerp = (a, b, t) => a + (b - a) * t;

const VS = 'attribute vec2 p; varying vec2 v; void main(){ v = p; gl_Position = vec4(p, 0.0, 1.0); }';
// Erdkugel (orthografisch), Textur in Web-Mercator: weltweit grob + Region ums Haus scharf
const FS = `precision highp float;
varying vec2 v;
uniform vec2 res; uniform float R; uniform vec2 c;
uniform sampler2D gT; uniform sampler2D rT; uniform vec4 rB; uniform float nacht;
void main(){
  vec2 p = v * res * 0.5;
  float r = length(p) / R;
  float edge = clamp((1.0 - r) * R, 0.0, 1.0);
  float g = exp(-max(r - 1.0, 0.0) * 9.0) * (1.0 - edge);
  vec3 glow = vec3(0.35, 0.62, 1.0) * g * 0.85 * (1.0 - 0.5 * nacht);
  if (r >= 1.0) { gl_FragColor = vec4(glow, g * 0.85); return; }
  float x = p.x / R, y = p.y / R, zz = sqrt(max(0.0, 1.0 - x * x - y * y));
  float sl = sin(c.x), cl = cos(c.x);
  float lat = asin(clamp(zz * sl + y * cl, -1.0, 1.0));
  float lon = c.y + atan(x, zz * cl - y * sl);
  lat = clamp(lat, -1.4844, 1.4844);
  vec2 m = vec2(fract(lon / 6.28318530718 + 0.5), 0.5 - log(tan(0.785398163 + lat * 0.5)) / 6.28318530718);
  vec3 col = texture2D(gT, m).rgb;
  vec2 q = (m - rB.xy) / (rB.zw - rB.xy);
  float w = sstep_(q);
  if (w > 0.0) col = mix(col, texture2D(rT, clamp(q, 0.0, 1.0)).rgb, w);
  vec3 n = vec3(x, y, zz);
  float d = clamp(dot(n, normalize(vec3(-0.45, 0.5, 0.75))), 0.0, 1.0);
  col *= mix(0.22 + 0.95 * d, 0.55, nacht);
  col = mix(col, col * vec3(0.45, 0.55, 0.85), nacht * 0.6);
  col += vec3(0.30, 0.55, 1.0) * pow(1.0 - zz, 3.0) * 0.55;
  gl_FragColor = vec4(col * edge + glow, max(edge, g * 0.85));
}`.replace('uniform float nacht;', 'uniform float nacht;\nfloat sstep_(vec2 q){ vec2 a = smoothstep(0.0, 0.08, q) * smoothstep(1.0, 0.92, q); return a.x * a.y; }');

class HausAnflugCard extends HTMLElement {
  constructor() {
    super();
    this.attachShadow({ mode: 'open' });
    this._tiles = new Map(); this._queue = []; this._busy = 0;
    this._t = 0; this._phase = 'idle';
  }

  setConfig(config) {
    this._config = Object.assign({ dauer: 11, zoom: 19.6, warten: 3, einmal: true }, config || {});
    this._overlay = !!this._config.card;
    this._build();
    if (this._overlay) this._makeChild();
  }

  set hass(hass) {
    const first = !this._hass; this._hass = hass;
    if (this._child) this._child.hass = hass;
    this._info();
    if (first && this.isConnected) this._start();
  }

  getCardSize() { return 8; }

  connectedCallback() {
    if (!this._onWin) { this._onWin = () => { this._fit(); this._resize(); }; window.addEventListener('resize', this._onWin); }
    if (!this._ro && this._fly) { this._ro = new ResizeObserver(() => this._resize()); this._ro.observe(this._fly); }
    this._fit(); if (!this._fitT) this._fitT = setInterval(() => this._fit(), 1500);
    this._resize();
    if (!this._hass) return;
    if (this._phase === 'idle') this._start();
    else if (!this._overlay) this._restart();                 // eigene Ansicht: bei jedem Oeffnen neu anfliegen
    else if (this._phase !== 'fertig') this._startLoop();
  }

  disconnectedCallback() {
    if (this._onWin) { window.removeEventListener('resize', this._onWin); this._onWin = null; }
    if (this._ro) { this._ro.disconnect(); this._ro = null; }
    if (this._fitT) { clearInterval(this._fitT); this._fitT = null; }
    clearTimeout(this._navT);
    this._stopLoop();
  }

  // Ohne feste Hoehe: bis zum unteren Bildschirmrand (wie die Rundumblick-Karte)
  _fit() {
    if (this._overlay || !this._wrap || this._config.height || !this.isConnected) return;
    const h = Math.max(280, Math.round(window.innerHeight - this._wrap.getBoundingClientRect().top));
    if (h !== this._fitH) { this._fitH = h; this._wrap.style.height = h + 'px'; this._resize(); }
  }

  _build() {
    const h = this._config.height || 'calc(100vh - var(--header-height, 56px))';
    this.shadowRoot.innerHTML = `
      <style>
        :host { display: block; position: relative; }
        .wrap { position: relative; width: 100%; height: ${this._overlay ? 'auto' : h}; min-height: 280px; overflow: hidden;
                border-radius: var(--ha-card-border-radius, 12px); background: #03050a; }
        .fly { position: absolute; inset: 0; background: #03050a; overflow: hidden; z-index: 5; touch-action: none; user-select: none;
               -webkit-user-select: none; transition: opacity .9s ease; cursor: pointer; }
        .fly.weg { opacity: 0; pointer-events: none; }
        canvas { position: absolute; inset: 0; width: 100%; height: 100%; display: block; }
        .sterne { transition: opacity .4s; }
        .karte { opacity: 0; }
        .wolken { pointer-events: none; }
        .vign { position: absolute; inset: 0; pointer-events: none;
                background: radial-gradient(ellipse at center, rgba(0,0,0,0) 55%, rgba(0,0,0,.45) 100%); }
        .info::before { content: ''; position: absolute; left: -10%; right: -10%; top: -60px; bottom: -14vh; z-index: -1;
                        background: linear-gradient(to bottom, rgba(0,0,0,0), rgba(0,0,0,.55)); }
        .titel { position: absolute; left: 0; right: 0; top: 18%; text-align: center; color: #fff; pointer-events: none; opacity: 0;
                 font: 300 clamp(28px, 6vw, 72px)/1.1 'Segoe UI', Roboto, sans-serif; letter-spacing: .45em; text-indent: .45em;
                 text-shadow: 0 0 24px rgba(120,170,255,.55); transition: opacity 1.2s ease, letter-spacing 2.4s ease; }
        .titel.an { opacity: .95; letter-spacing: .32em; }
        .pin { position: absolute; left: 50%; top: 50%; width: 0; height: 0; pointer-events: none; opacity: 0; transition: opacity .8s; }
        .pin.an { opacity: 1; }
        .pin i { position: absolute; left: -9px; top: -9px; width: 18px; height: 18px; border-radius: 50%; background: #ffd56b;
                 box-shadow: 0 0 18px 6px rgba(255,213,107,.7); }
        .pin b { position: absolute; left: -40px; top: -40px; width: 80px; height: 80px; border-radius: 50%; border: 2px solid rgba(255,213,107,.85);
                 animation: puls 2.2s ease-out infinite; }
        .pin b + b { animation-delay: 1.1s; }
        @keyframes puls { from { transform: scale(.25); opacity: 1; } to { transform: scale(2.4); opacity: 0; } }
        .info { position: absolute; z-index: 2; left: 0; right: 0; bottom: 9%; display: flex; flex-direction: column; align-items: center; gap: 14px;
                pointer-events: none; opacity: 0; transform: translateY(14px); transition: opacity .9s ease, transform .9s ease; }
        .info.an { opacity: 1; transform: none; }
        .info .h { color: #fff; font: 300 clamp(26px, 4.5vw, 54px)/1.1 'Segoe UI', Roboto, sans-serif; letter-spacing: .28em; text-indent: .28em;
                   text-shadow: 0 2px 18px rgba(0,0,0,.8); }
        .info .u { color: rgba(255,255,255,.85); font: 500 clamp(13px, 1.6vw, 17px) 'Segoe UI', Roboto, sans-serif; letter-spacing: .12em;
                   text-shadow: 0 1px 8px rgba(0,0,0,.9); }
        .knoepfe { display: flex; flex-wrap: wrap; justify-content: center; gap: 10px; pointer-events: auto; }
        .nav { padding: 9px 18px; border-radius: 18px; background: rgba(10,12,16,.55); border: 1px solid rgba(255,255,255,.3); color: #fff;
               font: 600 14px 'Segoe UI', Roboto, sans-serif; cursor: pointer; backdrop-filter: blur(6px); -webkit-backdrop-filter: blur(6px);
               -webkit-tap-highlight-color: transparent; }
        .nav.haupt { background: rgba(255,213,107,.2); border-color: #ffd56b; }
        .skip { position: absolute; right: 14px; bottom: 12px; padding: 6px 12px; border-radius: 14px; background: rgba(10,12,16,.45);
                border: 1px solid rgba(255,255,255,.2); color: rgba(255,255,255,.8); font: 600 12px 'Segoe UI', Roboto, sans-serif; }
        .quelle { position: absolute; left: 10px; bottom: 8px; color: rgba(255,255,255,.55); font: 10px 'Segoe UI', Roboto, sans-serif; pointer-events: none; }
        .msg { position: absolute; left: 0; right: 0; bottom: 30%; text-align: center; color: rgba(255,255,255,.6); font: 13px 'Segoe UI', Roboto, sans-serif;
               pointer-events: none; letter-spacing: .1em; }
      </style>
      <div class="wrap">
        <div class="kind"></div>
        <div class="fly">
          <canvas class="sterne"></canvas><canvas class="globus"></canvas><canvas class="karte"></canvas><canvas class="wolken"></canvas>
          <div class="vign"></div>
          <div class="pin"><b></b><b></b><i></i></div>
          <div class="titel"></div>
          <div class="info"><div class="h"></div><div class="u"></div><div class="knoepfe"></div></div>
          <div class="msg"></div>
          <div class="skip">Überspringen</div>
          <div class="quelle">Satellitenbild © Esri, Maxar, Earthstar Geographics</div>
        </div>
      </div>`;
    const $ = (s) => this.shadowRoot.querySelector(s);
    this._wrap = $('.wrap'); this._fly = $('.fly'); this._kind = $('.kind');
    this._cS = $('.sterne'); this._cG = $('.globus'); this._cK = $('.karte'); this._cW = $('.wolken');
    this._titel = $('.titel'); this._pin = $('.pin'); this._infoEl = $('.info'); this._msg = $('.msg'); this._skip = $('.skip');
    this._titel.textContent = (this._config.titel || 'Zuhause').toUpperCase();
    $('.info .h').textContent = (this._config.titel || 'Zuhause').toUpperCase();
    const box = $('.knoepfe');
    for (const n of this._config.nav || []) {
      const b = document.createElement('div'); b.className = 'nav' + (n.path === this._config.ziel ? ' haupt' : ''); b.textContent = n.label || '';
      b.addEventListener('click', (e) => { e.stopPropagation(); if (n.path) this._go(n.path); else this._restart(); });
      box.appendChild(b);
    }
    if (!this._overlay) {
      const b = document.createElement('div'); b.className = 'nav'; b.textContent = '↻ Nochmal';
      b.addEventListener('click', (e) => { e.stopPropagation(); this._restart(); });
      box.appendChild(b);
    }
    this._fly.addEventListener('click', () => this._skipNow());
    this._ctxK = this._cK.getContext('2d'); this._ctxW = this._cW.getContext('2d');
    this._initGl();
  }

  async _makeChild() {
    const cfg = this._config.card;
    try {
      const helpers = window.loadCardHelpers ? await window.loadCardHelpers() : null;
      const el = helpers ? helpers.createCardElement(cfg) : document.createElement(cfg.type.replace(/^custom:/, ''));
      if (!helpers && el.setConfig) el.setConfig(cfg);
      if (this._hass) el.hass = this._hass;
      this._child = el; this._kind.appendChild(el);
    } catch (e) { console.error('haus-anflug-card', e); }
  }

  _info() {
    const c = this._config, h = this._hass; if (!h || !this._infoEl) return;
    const teile = [];
    if (c.untertitel) teile.push(c.untertitel);
    const st = c.temperatur && h.states[c.temperatur];
    if (st && !isNaN(parseFloat(st.state))) teile.push(parseFloat(st.state).toFixed(1).replace('.', ',') + ' °C');
    teile.push(new Date().toLocaleTimeString('de-DE', { hour: '2-digit', minute: '2-digit' }) + ' Uhr');
    this.shadowRoot.querySelector('.info .u').textContent = teile.join('   ·   ');
    const sun = h.states['sun.sun'];
    this._nacht = sun && sun.state === 'below_horizon' ? 1 : 0;
  }

  // ---------- Ablauf ----------
  _start() {
    if (this._phase !== 'idle') return;
    const c = this._config, h = this._hass;
    this._lat = +(c.lat != null ? c.lat : (h.config && h.config.latitude)); this._lon = +(c.lon != null ? c.lon : (h.config && h.config.longitude));
    if (!isFinite(this._lat) || !isFinite(this._lon)) { this._msg.textContent = 'Keine Koordinaten (lat/lon) gefunden.'; return; }
    if (this._overlay && c.einmal) {
      let schon = false;
      try { schon = sessionStorage.getItem('haus-anflug-gesehen') === '1'; sessionStorage.setItem('haus-anflug-gesehen', '1'); } catch (_) { /* egal */ }
      if (schon) { this._finish(true); return; }
    }
    // Hauskoordinaten in Weltkoordinaten (0..1, Web-Mercator)
    const s = Math.sin(this._lat * Math.PI / 180);
    this._hx = this._lon / 360 + 0.5; this._hy = 0.5 - Math.log((1 + s) / (1 - s)) / (4 * Math.PI);
    this._phase = 'laden'; this._t = this._t || 0; this._landT = null;
    this._fly.classList.remove('weg'); this._fly.style.display = '';
    this._msg.textContent = 'Lädt …';
    this._info(); this._resize(); this._stars();
    this._clouds = this._cloudTex();
    this._planTiles();
    this._loadGlobe().then(() => { if (this._phase === 'laden') { this._phase = 'flug'; this._msg.textContent = ''; } });
    this._startLoop();
  }

  _restart() {
    clearTimeout(this._navT); this._stopLoop();
    this._phase = 'idle'; this._t = 0; this._landed = false;
    this._infoEl.classList.remove('an'); this._pin.classList.remove('an'); this._titel.classList.remove('an'); this._skip.style.display = '';
    this._start();
  }

  _dur() { return this._config.dauer; }

  // Flugbahn: Zoomstufe ueber der Zeit (langsam anfangen, zuegig durch die Wolken, sanft landen)
  _zoomAt(t) {
    const u = clamp(t / this._dur(), 0, 1);
    const e = u < 0.5 ? 4 * u * u * u : 1 - Math.pow(-2 * u + 2, 3) / 2;
    return lerp(Z0, this._config.zoom, e);
  }

  _skipNow() {
    if (this._phase === 'fertig') return;
    if (this._overlay) { this._finish(false); return; }
    if (this._phase === 'flug' || this._phase === 'laden') { this._t = this._dur(); this._phase = 'flug'; }
  }

  _land() {
    if (this._landed) return; this._landed = true;
    this._pin.classList.add('an'); this._skip.style.display = 'none';
    if (this._overlay) { this._landT = setTimeout(() => this._finish(false), 1300); return; }
    this._infoEl.classList.add('an');
    if (this._config.ziel) this._navT = setTimeout(() => this._go(this._config.ziel), (this._config.warten || 0) * 1000 + 600);
  }

  _finish(sofort) {
    clearTimeout(this._landT);
    this._phase = 'fertig';
    this._fly.classList.add('weg');
    setTimeout(() => { this._stopLoop(); this._fly.style.display = 'none'; this._freeGl(); }, sofort ? 0 : 950);
  }

  _go(path) {
    clearTimeout(this._navT);
    history.pushState(null, '', path);
    window.dispatchEvent(new CustomEvent('location-changed', { detail: { replace: false } }));
  }

  _startLoop() {
    if (this._raf || this._manual) return;
    let last = performance.now();
    const loop = (now) => { const dt = Math.min(0.1, (now - last) / 1000); last = now; this._tick(dt); this._raf = requestAnimationFrame(loop); };
    this._raf = requestAnimationFrame(loop);
  }

  _stopLoop() { if (this._raf) cancelAnimationFrame(this._raf); this._raf = null; }

  _tick(dt) {
    if (this._phase === 'flug') {
      // Zeitlupe, solange die Kacheln der naechsten Sekunde noch nicht da sind
      const zn = this._zoomAt(this._t + 1.0), L = this._level(zn);
      const ok = zn < GLOBUS_BIS - 0.6 || this._readyLevel(L) > 0.85;
      this._t = Math.min(this._dur(), this._t + dt * (ok ? 1 : 0.15));
      if (this._t >= this._dur()) this._land();
    }
    this._render();
  }

  // ---------- Zeichnen ----------
  _resize() {
    if (!this._fly) return;
    const r = this._fly.getBoundingClientRect(); if (!r.width || !r.height) return;
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    this._W = r.width; this._H = r.height; this._dpr = dpr;
    const set = (c, f) => { const w = Math.round(r.width * f), h = Math.round(r.height * f); if (c.width !== w || c.height !== h) { c.width = w; c.height = h; } };
    set(this._cG, dpr); set(this._cK, dpr); set(this._cS, dpr); set(this._cW, 0.5);
    if (this._phase !== 'idle') { this._stars(); this._render(); }
  }

  _stars() {
    const c = this._cS, x = c.getContext('2d'), w = c.width, h = c.height;
    const g = x.createRadialGradient(w * 0.5, h * 0.55, 0, w * 0.5, h * 0.55, Math.max(w, h) * 0.75);
    g.addColorStop(0, '#0b1426'); g.addColorStop(1, '#020308');
    x.fillStyle = g; x.fillRect(0, 0, w, h);
    let s = 7; const rnd = () => ((s = (s * 16807) % 2147483647) / 2147483647);
    for (let i = 0; i < (w * h) / 2600; i++) {
      const a = rnd(), rr = rnd() < 0.04 ? 1.6 : 0.4 + rnd() * 0.8;
      x.fillStyle = `rgba(${200 + a * 55 | 0},${210 + a * 45 | 0},255,${0.25 + a * 0.75})`;
      x.beginPath(); x.arc(rnd() * w, rnd() * h, rr * this._dpr, 0, 6.2832); x.fill();
    }
  }

  _render() {
    if (!this._W || this._phase === 'idle') return;
    const z = this._zoomAt(this._t), nacht = this._nacht || 0;
    // Titel im All, verschwindet beim Abstieg
    this._titel.classList.toggle('an', this._phase === 'flug' && z < 3.6);
    const kA = sstep(GLOBUS_BIS - 0.9, GLOBUS_BIS, z);
    this._cS.style.opacity = String(1 - sstep(3.5, 5.5, z));
    this._cG.style.opacity = String(1 - kA);
    this._cK.style.opacity = String(kA);
    this._cK.style.filter = nacht ? 'brightness(.5) saturate(.65) hue-rotate(12deg)' : '';
    if (kA < 1) this._drawGlobe(z, nacht);
    if (kA > 0) this._drawMap(z);
    this._drawClouds(z, nacht);
  }

  _drawGlobe(z, nacht) {
    const gl = this._gl; if (!gl || !this._gTex) return;
    const lat = this._lat * Math.PI / 180, lon = this._lon * Math.PI / 180;
    // Kugel dreht sich von Westen her aufs Haus zu
    const k = sstep(Z0, 4.3, z);
    const cLat = lerp(18 * Math.PI / 180, lat, k), cLon = lon - (1 - k) * 2.3;
    // Kugelradius so, dass der Massstab in der Mitte zur flachen Karte passt
    const R = 256 * Math.pow(2, z) / (2 * Math.PI * Math.cos(cLat)) * this._dpr;
    gl.viewport(0, 0, this._cG.width, this._cG.height);
    gl.clearColor(0, 0, 0, 0); gl.clear(gl.COLOR_BUFFER_BIT);
    const p = this._prog; gl.useProgram(p.pr);
    gl.uniform2f(p.u.res, this._cG.width, this._cG.height); gl.uniform1f(p.u.R, R);
    gl.uniform2f(p.u.c, cLat, cLon); gl.uniform1f(p.u.nacht, nacht);
    gl.uniform4f(p.u.rB, this._rB[0], this._rB[1], this._rB[2], this._rB[3]);
    gl.activeTexture(gl.TEXTURE0); gl.bindTexture(gl.TEXTURE_2D, this._gTex); gl.uniform1i(p.u.gT, 0);
    gl.activeTexture(gl.TEXTURE1); gl.bindTexture(gl.TEXTURE_2D, this._rTex); gl.uniform1i(p.u.rT, 1);
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
  }

  _level(z) { return clamp(Math.floor(z + 0.15), REGION_Z, 19); }

  _drawMap(z) {
    const x = this._ctxK, W = this._cK.width, H = this._cK.height, d = this._dpr;
    x.fillStyle = '#1b2230'; x.fillRect(0, 0, W, H);
    const L = this._level(z);
    // grobe Stufen zuerst, feinere darueber – Luecken zeigen so die naechstgroebere Kachel
    for (let l = Math.max(REGION_Z, L - 4); l <= L; l++) {
      const n = Math.pow(2, l), s = Math.pow(2, z - l) * 256 * d;
      const cx = this._hx * n, cy = this._hy * n;
      const x0 = Math.floor(cx - W / 2 / s), x1 = Math.floor(cx + W / 2 / s), y0 = Math.floor(cy - H / 2 / s), y1 = Math.floor(cy + H / 2 / s);
      for (let ty = y0; ty <= y1; ty++) for (let tx = x0; tx <= x1; tx++) {
        const t = this._tiles.get(l + '/' + tx + '/' + ty);
        if (!t || !t.img) { if (l === L) this._want(l, tx, ty, 0); continue; }
        const px = (tx - cx) * s + W / 2, py = (ty - cy) * s + H / 2;
        x.drawImage(t.img, Math.floor(px), Math.floor(py), Math.ceil(s) + 1, Math.ceil(s) + 1);
      }
    }
  }

  _drawClouds(z, nacht) {
    const x = this._ctxW, W = this._cW.width, H = this._cW.height;
    x.clearRect(0, 0, W, H);
    if (!this._clouds) return;
    const t = this._t;
    for (const w of WOLKEN) {
      // Ebene in "Hoehe" w.z: scheinbare Groesse waechst, je naeher die Kamera kommt; beim Durchfliegen ausblenden
      const a = sstep(w.z - 3.3, w.z - 2.1, z) * (1 - sstep(w.z - 0.45, w.z - 0.05, z));
      if (a <= 0.01) continue;
      const sc = (4.5 / (Math.pow(2, w.z - z) - 1)) * w.s * (W / 900);
      x.save(); x.globalAlpha = a * (nacht ? 0.55 : 0.95);
      x.translate(W / 2, H / 2); x.scale(sc, sc); x.rotate(w.dx * 2);
      const T = this._clouds.width;
      const ox = T * (w.dx + t * 0.004), oy = T * (w.dy + t * 0.002), r = Math.hypot(W, H) / sc / 2 + T;
      x.translate(-ox, -oy); x.fillStyle = this._cloudPat; x.fillRect(ox - r, oy - r, 2 * r, 2 * r);
      x.restore();
    }
    // Dunst genau beim Wechsel Kugel -> Karte
    const f = Math.exp(-Math.pow((z - (GLOBUS_BIS - 0.4)) / 0.55, 2)) * 0.6;
    if (f > 0.01) { x.fillStyle = nacht ? `rgba(40,50,70,${f})` : `rgba(232,238,245,${f})`; x.fillRect(0, 0, W, H); }
  }

  // Kachelbare Wolkentextur (Wert-Rauschen, mehrere Oktaven)
  _cloudTex() {
    if (this._clouds) return this._clouds;
    const N = 384, c = document.createElement('canvas'); c.width = c.height = N;
    const x = c.getContext('2d'), img = x.createImageData(N, N);
    let s = 11; const rnd = () => ((s = (s * 16807) % 2147483647) / 2147483647);
    const grids = [3, 6, 12, 24, 48, 96].map((g) => ({ g, v: Array.from({ length: g * g }, rnd) }));
    const val = (G, u, v) => {
      const g = G.g, X = u * g, Y = v * g, i = Math.floor(X), j = Math.floor(Y), fx = X - i, fy = Y - j;
      const at = (a, b) => G.v[((b % g + g) % g) * g + ((a % g + g) % g)];
      const sx = fx * fx * (3 - 2 * fx), sy = fy * fy * (3 - 2 * fy);
      return lerp(lerp(at(i, j), at(i + 1, j), sx), lerp(at(i, j + 1), at(i + 1, j + 1), sx), sy);
    };
    for (let j = 0; j < N; j++) for (let i = 0; i < N; i++) {
      let n = 0, amp = 0.5, sum = 0;
      for (const G of grids) { n += val(G, i / N, j / N) * amp; sum += amp; amp *= 0.5; }
      n /= sum;
      const a = sstep(0.44, 0.74, n), sh = 196 + 59 * sstep(0.5, 0.8, n), k = (j * N + i) * 4;
      img.data[k] = sh; img.data[k + 1] = sh + 3; img.data[k + 2] = Math.min(255, sh + 10); img.data[k + 3] = a * 255;
    }
    x.putImageData(img, 0, 0);
    this._cloudPat = this._ctxW.createPattern(c, 'repeat');
    return c;
  }

  // ---------- Kacheln ----------
  _url(z, x, y) { return (this._config.kacheln || TILE_URL).replace('{z}', z).replace('{x}', x).replace('{y}', y); }

  _want(z, x, y, prio) {
    const n = Math.pow(2, z); x = ((x % n) + n) % n; if (y < 0 || y >= n) return null;
    const key = z + '/' + x + '/' + y;
    let t = this._tiles.get(key);
    if (!t) { t = { key, z, x, y, prio, img: null, done: false }; this._tiles.set(key, t); this._queue.push(t); this._pump(); }
    return t;
  }

  _pump() {
    while (this._busy < 8 && this._queue.length) {
      this._queue.sort((a, b) => a.prio - b.prio);
      const t = this._queue.shift(); this._busy++;
      const img = new Image(); img.crossOrigin = 'anonymous';
      img.onload = () => { t.img = img; t.done = true; this._busy--; this._pump(); if (t.cb) t.cb(); };
      img.onerror = () => { t.done = true; this._busy--; this._pump(); if (t.cb) t.cb(); };
      img.src = this._url(t.z, t.x, t.y);
    }
  }

  // Alle Kacheln entlang der Flugbahn vormerken, in der Reihenfolge, in der sie gebraucht werden
  _planTiles() {
    const W = this._W || 1280, H = this._H || 800;
    this._plan = {};
    for (let L = REGION_Z; L <= 19; L++) {
      const n = Math.pow(2, L), s = Math.pow(2, Math.max(L - 0.15, REGION_Z) - L) * 256, cx = this._hx * n, cy = this._hy * n;
      const list = [];
      for (let ty = Math.floor(cy - H / 2 / s); ty <= Math.floor(cy + H / 2 / s); ty++)
        for (let tx = Math.floor(cx - W / 2 / s); tx <= Math.floor(cx + W / 2 / s); tx++) { const t = this._want(L, tx, ty, L); if (t) list.push(t); }
      this._plan[L] = list;
    }
  }

  _readyLevel(L) { const l = this._plan && this._plan[L]; if (!l || !l.length) return 1; return l.filter((t) => t.done).length / l.length; }

  // Mosaik aus Kacheln fuer die Kugel (WebGL braucht ein Bild je Textur)
  _mosaic(z, x0, y0, n) {
    return new Promise((res) => {
      const c = document.createElement('canvas'); c.width = c.height = n * 256;
      const ctx = c.getContext('2d'); ctx.fillStyle = '#0d2238'; ctx.fillRect(0, 0, c.width, c.height);
      let left = n * n;
      for (let j = 0; j < n; j++) for (let i = 0; i < n; i++) {
        const t = this._want(z, x0 + i, y0 + j, -1);
        const fin = () => { if (t && t.img) ctx.drawImage(t.img, i * 256, j * 256); if (--left === 0) res(c); };
        if (!t || t.done) fin(); else { const prev = t.cb; t.cb = () => { if (prev) prev(); fin(); }; }
      }
    });
  }

  async _loadGlobe() {
    if (!this._gl) return;
    const n = Math.pow(2, REGION_Z), rx = Math.floor(this._hx * n) - 1, ry = Math.floor(this._hy * n) - 1;
    this._rB = [rx / n, ry / n, (rx + 4) / n, (ry + 4) / n];
    if (this._gTex) return;
    const [g, r] = await Promise.all([this._mosaic(2, 0, 0, 4), this._mosaic(REGION_Z, rx, ry, 4)]);
    if (!this._gl) return;
    this._gTex = this._texFrom(g, true); this._rTex = this._texFrom(r, false);
  }

  _initGl() {
    const gl = this._cG.getContext('webgl', { alpha: true, premultipliedAlpha: true, antialias: false });
    if (!gl) return;
    const sh = (type, src) => { const s = gl.createShader(type); gl.shaderSource(s, src); gl.compileShader(s);
      if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(s)); return s; };
    const pr = gl.createProgram();
    gl.attachShader(pr, sh(gl.VERTEX_SHADER, VS)); gl.attachShader(pr, sh(gl.FRAGMENT_SHADER, FS)); gl.linkProgram(pr);
    if (!gl.getProgramParameter(pr, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(pr));
    const u = {}; for (const k of ['res', 'R', 'c', 'gT', 'rT', 'rB', 'nacht']) u[k] = gl.getUniformLocation(pr, k);
    const buf = gl.createBuffer(); gl.bindBuffer(gl.ARRAY_BUFFER, buf);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]), gl.STATIC_DRAW);
    const loc = gl.getAttribLocation(pr, 'p'); gl.enableVertexAttribArray(loc); gl.vertexAttribPointer(loc, 2, gl.FLOAT, false, 0, 0);
    this._gl = gl; this._prog = { pr, u };
  }

  _texFrom(canvas, repeat) {
    const gl = this._gl, t = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, t);
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, canvas);
    gl.generateMipmap(gl.TEXTURE_2D);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR_MIPMAP_LINEAR); gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, repeat ? gl.REPEAT : gl.CLAMP_TO_EDGE); gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    return t;
  }

  // Im Vorspann-Modus nach dem Flug Speicher freigeben (der Rundumblick braucht ihn selbst)
  _freeGl() {
    const gl = this._gl; if (!gl) return;
    if (this._gTex) gl.deleteTexture(this._gTex); if (this._rTex) gl.deleteTexture(this._rTex);
    this._gTex = this._rTex = null; this._tiles.clear(); this._queue = [];
    if (this._overlay) { const ext = gl.getExtension('WEBGL_lose_context'); if (ext) ext.loseContext(); this._gl = null; }
  }
}

if (!customElements.get('haus-anflug-card')) {
  customElements.define('haus-anflug-card', HausAnflugCard);
  window.customCards = window.customCards || [];
  window.customCards.push({ type: 'haus-anflug-card', name: 'Haus-Anflug', description: 'Kamerafahrt von der Erdkugel durch die Wolken bis aufs Haus' });
  console.info('%c haus-anflug-card ' + HAC_VERSION, 'color:#ffd56b');
}
