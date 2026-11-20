/* Fuel — a personal calorie & macro tracker.
 * Everything is stored on this device (localStorage). Use Settings → Backup to export/import.
 * Barcode lookups: your own food library first, then Open Food Facts (free, open database).
 * Label photos: read by Claude via your own Anthropic API key (optional).
 */
'use strict';

/* ================= helpers ================= */
const $ = s => document.querySelector(s);
const $$ = s => [...document.querySelectorAll(s)];
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const pad = n => String(n).padStart(2, '0');
const ymd = d => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const parseYmd = s => { const [y, m, d] = s.split('-').map(Number); return new Date(y, m - 1, d); };
const addDays = (s, n) => { const d = parseYmd(s); d.setDate(d.getDate() + n); return ymd(d); };
const num = v => { const n = parseFloat(v); return isFinite(n) ? n : 0; };
const numOrNull = v => (v === '' || v == null || !isFinite(parseFloat(v))) ? null : parseFloat(v);
const r0 = n => Math.round(Number(n) || 0);
const r1 = n => Math.round((Number(n) || 0) * 10) / 10;
const fmt = n => r0(n).toLocaleString('en-AU');
const uid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
const KJ = 4.184;
const MEALS = ['Breakfast', 'Lunch', 'Dinner', 'Snacks'];
const DEFAULT_SETTINGS = { targets: { kcal: 2350, p: 150, c: 280, f: 70 }, apiKey: '', model: 'claude-haiku-5-5', theme: 'bento' };
const OFF = 'https://world.openfoodfacts.org';

function defaultMeal() {
  const h = new Date().getHours();
  return h < 11 ? 'Breakfast' : h < 15 ? 'Lunch' : h < 20 ? 'Dinner' : 'Snacks';
}

/* ================= storage ================= */
const Store = {
  get(k, fb = null) { try { const v = localStorage.getItem('fuel:' + k); return v == null ? fb : JSON.parse(v); } catch { return fb; } },
  set(k, v) {
    try { localStorage.setItem('fuel:' + k, JSON.stringify(v)); return true; }
    catch (e) { toast('Storage is full — export a backup in Settings'); return false; }
  },
  keys() { const out = []; try { for (let i = 0; i < localStorage.length; i++) { const k = localStorage.key(i); if (k.startsWith('fuel:')) out.push(k.slice(5)); } } catch {} return out; }
};
// Ask the browser not to clear our data under storage pressure.
try { navigator.storage && navigator.storage.persist && navigator.storage.persist(); } catch {}

const state = {
  date: ymd(new Date()),
  tab: 'today',
  settings: { ...DEFAULT_SETTINGS, ...Store.get('settings', {}), targets: { ...DEFAULT_SETTINGS.targets, ...(Store.get('settings', {}).targets || {}) } },
  foods: Store.get('foods', {}),
  day: null
};
const loadDay = d => Store.get('day:' + d, { entries: [], weight: null });
const saveDay = () => Store.set('day:' + state.date, state.day);
const saveFoods = () => Store.set('foods', state.foods);
const saveSettings = () => Store.set('settings', state.settings);
state.day = loadDay(state.date);

function updateDay(fn) { state.day = fn({ entries: [...state.day.entries], weight: state.day.weight }); saveDay(); render(); }

/* ================= food model =================
 * food = { key, code, name, brand, servingG, servingLabel, per100:{kcal,p,c,f}|null, perServe:{...}|null, source, uses, lastUsed }
 */
const hasM = m => m && [m.kcal, m.p, m.c, m.f].some(v => v != null && v !== 0);
const scale = (m, k) => ({ kcal: num(m.kcal) * k, p: num(m.p) * k, c: num(m.c) * k, f: num(m.f) * k });

function canServes(f) { return hasM(f.perServe) || (hasM(f.per100) && f.servingG); }
function canGrams(f) { return hasM(f.per100) || (hasM(f.perServe) && f.servingG); }
function macrosFor(f, mode, amt) {
  amt = num(amt);
  if (mode === 'serves') {
    if (hasM(f.perServe)) return scale(f.perServe, amt);
    return scale(f.per100, (f.servingG * amt) / 100);
  }
  if (hasM(f.per100)) return scale(f.per100, amt / 100);
  return scale(f.perServe, amt / f.servingG);
}
const unitOf = f => /\d\s*m\s*l\b/i.test(f.servingLabel || '') ? 'mL' : 'g';
function amountLabel(f, mode, amt) {
  if (mode === 'grams') return `${r1(amt)} ${unitOf(f)}`;
  const n = r1(amt);
  const g = f.servingG ? ` (${r0(f.servingG * amt)} ${unitOf(f)})` : '';
  return `${n} serve${n === 1 ? '' : 's'}${g}`;
}
function upsertFood(f) {
  const key = f.key || (f.code ? f.code : 'u-' + uid());
  const prev = state.foods[key] || {};
  state.foods[key] = { uses: 0, ...prev, ...f, key, updated: Date.now() };
  saveFoods();
  return state.foods[key];
}
function touchFood(key) {
  const f = state.foods[key]; if (!f) return;
  f.uses = (f.uses || 0) + 1; f.lastUsed = Date.now(); saveFoods();
}

/* ================= recipes =================
 * A recipe is saved as a normal food (source:'recipe') so it can be logged like anything else.
 * draft = { key?, name, servings, cookedG, ingredients:[{id,name,foodKey,amount,kcal,p,c,f}] }
 */
function recipeTotals(r) { return (r.ingredients || []).reduce((t, e) => (t.kcal += num(e.kcal), t.p += num(e.p), t.c += num(e.c), t.f += num(e.f), t), { kcal: 0, p: 0, c: 0, f: 0 }); }
function recipeToFood(r) {
  const t = recipeTotals(r), sv = Math.max(0.5, num(r.servings) || 1), cooked = numOrNull(r.cookedG);
  return {
    key: r.key, name: r.name, brand: '', code: '', source: 'recipe',
    ingredients: r.ingredients, servings: sv, cookedG: cooked,
    servingG: cooked ? cooked / sv : null,
    servingLabel: cooked ? `1 of ${sv} serves (${r0(cooked / sv)} g)` : `1 of ${sv} serves`,
    perServe: scale(t, 1 / sv), per100: cooked ? scale(t, 100 / cooked) : null
  };
}
const saveRecipeDraft = () => Store.set('recipeDraft', sheet.recipe);

/* ================= Open Food Facts ================= */
function offToFood(p, code) {
  const n = p.nutriments || {};
  const pick = (suffix) => {
    let kcal = numOrNull(n['energy-kcal' + suffix]);
    if (kcal == null) { const kj = numOrNull(n['energy-kj' + suffix] ?? n['energy' + suffix]); if (kj != null) kcal = kj / KJ; }
    const m = { kcal, p: numOrNull(n['proteins' + suffix]), c: numOrNull(n['carbohydrates' + suffix]), f: numOrNull(n['fat' + suffix]) };
    return hasM(m) ? { kcal: num(m.kcal), p: num(m.p), c: num(m.c), f: num(m.f) } : null;
  };
  const name = p.product_name_en || p.product_name || p.generic_name || '';
  if (!name && !n['energy-kcal_100g'] && !n['energy_100g']) return null;
  return {
    code: String(code || p.code || ''),
    key: String(code || p.code || ''),
    name: name || 'Unnamed product',
    brand: (p.brands || '').split(',')[0].trim(),
    servingG: numOrNull(p.serving_quantity) || null,
    servingLabel: p.serving_size || '',
    per100: pick('_100g'),
    perServe: pick('_serving'),
    source: 'off'
  };
}
async function offLookup(code) {
  const fields = 'code,product_name,product_name_en,generic_name,brands,serving_size,serving_quantity,nutriments';
  const r = await fetch(`${OFF}/api/v2/product/${encodeURIComponent(code)}.json?fields=${fields}`);
  if (r.status === 404) return null;
  if (!r.ok) throw new Error('Open Food Facts is not responding (' + r.status + ')');
  const j = await r.json();
  if (j.status !== 1 || !j.product) return null;
  const f = offToFood(j.product, code);
  return f && (hasM(f.per100) || hasM(f.perServe)) ? f : null;
}
async function offSearch(q, auOnly) {
  const params = new URLSearchParams({ search_terms: q, search_simple: '1', action: 'process', json: '1', page_size: '25',
    fields: 'code,product_name,product_name_en,brands,serving_size,serving_quantity,nutriments' });
  if (auOnly) { params.set('tagtype_0', 'countries'); params.set('tag_contains_0', 'contains'); params.set('tag_0', 'australia'); }
  const r = await fetch(`${OFF}/cgi/search.pl?${params}`);
  if (!r.ok) throw new Error('Search failed (' + r.status + ') — Open Food Facts limits searches to about 10 a minute.');
  const j = await r.json();
  return (j.products || []).map(p => offToFood(p, p.code)).filter(f => f && (hasM(f.per100) || hasM(f.perServe)));
}

/* ================= Claude (optional, your own API key) ================= */
async function askClaude(content, maxTokens = 1200) {
  const key = state.settings.apiKey;
  if (!key) throw new Error('Add your Claude API key in Settings to use this.');
  const r = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-api-key': key,
      'anthropic-version': '2023-06-01',
      'anthropic-dangerous-direct-browser-access': 'true'
    },
    body: JSON.stringify({ model: state.settings.model || DEFAULT_SETTINGS.model, max_tokens: maxTokens, messages: [{ role: 'user', content }] })
  });
  if (!r.ok) {
    let msg = r.status === 401 ? 'Your Claude API key was rejected — check it in Settings.' : 'Claude API error ' + r.status;
    try { const j = await r.json(); if (j.error && j.error.message && r.status !== 401) msg += ': ' + j.error.message; } catch {}
    throw new Error(msg);
  }
  const j = await r.json();
  const text = (j.content || []).map(b => b.text || '').join('');
  const m = text.match(/\{[\s\S]*\}/);
  if (!m) throw new Error("Couldn't understand the reply — try again.");
  return JSON.parse(m[0]);
}
const LABEL_PROMPT = `This photo shows a packaged food's nutrition information panel (most likely Australian) and possibly the front of the pack.
Extract the values. Australian panels list Energy in kJ: convert to kcal by dividing by 4.184, unless a kcal/Cal figure is printed.
Use total carbohydrate (not sugars) and total fat. For drinks, treat "per 100 mL" as per100.
Respond with ONLY this JSON, no prose:
{"name":"product name if visible, else a short description","brand":"brand if visible, else empty","servingG":number of grams (or mL) per serve or null,"servingLabel":"serving size as printed, e.g. 1 bar (40 g)","perServe":{"kcal":0,"p":0,"c":0,"f":0} or null,"per100":{"kcal":0,"p":0,"c":0,"f":0} or null,"readable":true}
If the panel is not readable, set "readable":false. Round to 1 decimal place.`;

async function readLabel(dataUrl) {
  const [meta, data] = dataUrl.split(',');
  const media = (meta.match(/data:(.*?);/) || [])[1] || 'image/jpeg';
  const v = await askClaude([{ type: 'image', source: { type: 'base64', media_type: media, data } }, { type: 'text', text: LABEL_PROMPT }]);
  if (v.readable === false) throw new Error("Couldn't read the panel — try a closer, sharper photo with less glare.");
  const fix = m => m && hasM(m) ? { kcal: num(m.kcal), p: num(m.p), c: num(m.c), f: num(m.f) } : null;
  return { name: v.name || '', brand: v.brand || '', servingG: numOrNull(v.servingG), servingLabel: v.servingLabel || '', perServe: fix(v.perServe), per100: fix(v.per100) };
}
async function describeMeal(text, photo) {
  const content = [];
  if (photo) {
    const [meta, data] = photo.split(',');
    content.push({ type: 'image', source: { type: 'base64', media_type: (meta.match(/data:(.*?);/) || [])[1] || 'image/jpeg', data } });
  }
  content.push({ type: 'text', text: (photo
    ? `This is a photo of a meal a user in Australia is about to eat. Identify each separate food or drink you can see and estimate its portion from visual cues (a standard dinner plate is about 27 cm across; a fork about 19 cm). Account for visible oils, sauces and dressings. Use the user's notes below to correct or add detail — they override what you guess from the photo.`
    : `Estimate calories and macros for the food below, for a user in Australia. Split it into separate items. Use typical Australian serving sizes, and real product values when a brand is named. If no amount is given assume one typical serving.`) + `
Put your estimated amount in each item's name (e.g. "Rice, white, about 1 cup (180 g)").
Respond with ONLY JSON: {"items":[{"name":"short name with amount","kcal":0,"p":0,"c":0,"f":0}]} (p, c, f in grams, whole numbers). If the photo shows no food, respond {"items":[]}.

${photo ? 'Notes from the user' : 'Food'}: ${text || '(none)'}` });
  const v = await askClaude(content);
  if (photo && !(v.items || []).length) throw new Error("Couldn't spot any food in that photo — try again from a bit higher up, with the whole plate in view.");
  return (v.items || []).map(x => ({ name: String(x.name || 'Food'), kcal: num(x.kcal), p: num(x.p), c: num(x.c), f: num(x.f) }));
}

/* ================= images & barcodes ================= */
function fileToCanvas(file, maxSide = 1600) {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => {
      const k = Math.min(1, maxSide / Math.max(img.naturalWidth, img.naturalHeight));
      const c = document.createElement('canvas');
      c.width = Math.round(img.naturalWidth * k); c.height = Math.round(img.naturalHeight * k);
      c.getContext('2d').drawImage(img, 0, 0, c.width, c.height);
      URL.revokeObjectURL(url); resolve(c);
    };
    img.onerror = () => { URL.revokeObjectURL(url); reject(new Error("Couldn't open that image")); };
    img.src = url;
  });
}
const FORMATS_NATIVE = ['ean_13', 'ean_8', 'upc_a', 'upc_e'];
let zxLive = null, zxHard = null;
function zxReader(hard) {
  if (!window.ZXing) return null;
  if (hard ? zxHard : zxLive) return hard ? zxHard : zxLive;
  const r = new ZXing.MultiFormatReader();
  const hints = new Map();
  hints.set(ZXing.DecodeHintType.POSSIBLE_FORMATS, [ZXing.BarcodeFormat.EAN_13, ZXing.BarcodeFormat.EAN_8, ZXing.BarcodeFormat.UPC_A, ZXing.BarcodeFormat.UPC_E]);
  if (hard) hints.set(ZXing.DecodeHintType.TRY_HARDER, true);
  r.setHints(hints);
  return hard ? (zxHard = r) : (zxLive = r);
}
function zxDecode(canvas, hard) {
  const r = zxReader(hard); if (!r) return null;
  try {
    const src = new ZXing.HTMLCanvasElementLuminanceSource(canvas);
    return r.decode(new ZXing.BinaryBitmap(new ZXing.HybridBinarizer(src))).getText();
  } catch { return null; } finally { try { r.reset(); } catch {} }
}
let nativeDetector;
async function getNativeDetector() {
  if (nativeDetector !== undefined) return nativeDetector;
  nativeDetector = null;
  try {
    if ('BarcodeDetector' in window) {
      const supported = await BarcodeDetector.getSupportedFormats();
      const want = FORMATS_NATIVE.filter(f => supported.includes(f));
      if (want.length) nativeDetector = new BarcodeDetector({ formats: want });
    }
  } catch { nativeDetector = null; }
  return nativeDetector;
}
async function decodeStill(canvas) {
  const det = await getNativeDetector();
  if (det) { try { const r = await det.detect(canvas); if (r.length) return r[0].rawValue; } catch {} }
  return zxDecode(canvas, true);
}

const Scanner = {
  stream: null, timer: null, busy: false, onCode: null,
  async open(onCode) {
    this.onCode = onCode;
    $('#scanner').classList.remove('hidden');
    $('#manualCode').value = '';
    const msg = $('#scanMsg'); msg.textContent = 'Starting camera…';
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
      msg.textContent = 'This browser can’t open the camera here. Type the barcode number below.'; return;
    }
    try {
      this.stream = await navigator.mediaDevices.getUserMedia({ audio: false, video: { facingMode: { ideal: 'environment' }, width: { ideal: 1920 }, height: { ideal: 1080 } } });
    } catch (e) {
      msg.textContent = e && e.name === 'NotAllowedError'
        ? 'Camera permission was blocked. Allow camera access for this site in your browser settings, or type the number below.'
        : 'Couldn’t start the camera. Type the barcode number below instead.';
      return;
    }
    if ($('#scanner').classList.contains('hidden')) { this.stop(); return; }
    const v = $('#scanVideo'); v.srcObject = this.stream;
    try { await v.play(); } catch {}
    try { const t = this.stream.getVideoTracks()[0]; const caps = t.getCapabilities ? t.getCapabilities() : {}; if (caps.focusMode && caps.focusMode.includes('continuous')) await t.applyConstraints({ advanced: [{ focusMode: 'continuous' }] }); } catch {}
    msg.textContent = 'Line the barcode up inside the box';
    const det = await getNativeDetector();
    const work = document.createElement('canvas');
    const tick = async () => {
      if (!this.stream || this.busy) return;
      if (!v.videoWidth) return;
      this.busy = true;
      try {
        let code = null;
        if (det) { const r = await det.detect(v); if (r.length) code = r[0].rawValue; }
        else {
          // decode a horizontal band across the middle of the frame
          const vw = v.videoWidth, vh = v.videoHeight, bh = Math.round(vh * 0.4), sy = Math.round((vh - bh) / 2);
          const k = Math.min(1, 1000 / vw);
          work.width = Math.round(vw * k); work.height = Math.round(bh * k);
          work.getContext('2d', { willReadFrequently: true }).drawImage(v, 0, sy, vw, bh, 0, 0, work.width, work.height);
          code = zxDecode(work, false);
        }
        if (code) this.found(code);
      } catch {} finally { this.busy = false; }
    };
    this.timer = setInterval(tick, 180);
  },
  found(code) {
    try { navigator.vibrate && navigator.vibrate(60); } catch {}
    const cb = this.onCode; this.close(); cb && cb(code);
  },
  stop() {
    clearInterval(this.timer); this.timer = null;
    if (this.stream) { this.stream.getTracks().forEach(t => t.stop()); this.stream = null; }
    const v = $('#scanVideo'); if (v) v.srcObject = null;
  },
  close() { this.stop(); $('#scanner').classList.add('hidden'); }
};

/* ================= main rendering ================= */
let toastT;
function toast(msg) { const t = $('#toast'); t.textContent = msg; t.classList.add('show'); clearTimeout(toastT); toastT = setTimeout(() => t.classList.remove('show'), 2600); }
const totals = es => es.reduce((t, e) => (t.kcal += num(e.kcal), t.p += num(e.p), t.c += num(e.c), t.f += num(e.f), t), { kcal: 0, p: 0, c: 0, f: 0 });
function dateLabel(d) {
  const today = ymd(new Date());
  if (d === today) return 'Today';
  if (d === addDays(today, -1)) return 'Yesterday';
  if (d === addDays(today, 1)) return 'Tomorrow';
  return parseYmd(d).toLocaleDateString('en-AU', { weekday: 'short', day: 'numeric', month: 'short' });
}
const shortDate = d => parseYmd(d).toLocaleDateString('en-AU', { day: 'numeric', month: 'short' });

function render() {
  applyTheme();
  const T = theme();
  $('#hdr').style.display = state.tab === 'today' ? 'none' : '';
  $('#pageTitle').textContent = T.tabs[state.tab];
  $('#datenav').innerHTML = state.tab === 'week' ?
    `<button data-action="prev" aria-label="Previous week">‹</button><button class="lbl" data-action="today">${esc(dateLabel(state.date))}</button><button data-action="next" aria-label="Next week">›</button>` : '';
  $('#tabs').innerHTML = ['today', 'week', 'foods', 'settings']
    .map(k => `<button data-action="tab" data-tab="${k}" class="${state.tab === k ? 'on' : ''}">${esc(T.tabs[k])}</button>`).join('');
  $('#fabs').style.display = state.tab === 'today' ? '' : 'none';
  $('#fabScan').textContent = T.scan; $('#fabAdd').textContent = T.add;
  const m = $('#main');
  m.innerHTML = state.tab === 'today' ? renderToday() : state.tab === 'week' ? renderWeek() : state.tab === 'foods' ? renderFoodsTab() : renderSettings();
}

/* ================= themes ================= */
const THEMES = {
  bento: {
    label: 'Bento', sub: 'Japanese · onigiri',
    today: '今日', yesterday: '昨日', tomorrow: '明日',
    left: '残り · left today', cheer: 'がんばって!', over: 'オーバー! Over by', done: 'ぴったり! Right on target',
    box: ['お弁当', "Today's bento"],
    meals: { Breakfast: ['朝ごはん', 'Breakfast'], Lunch: ['昼ごはん', 'Lunch'], Dinner: ['晩ごはん', 'Dinner'], Snacks: ['おやつ', 'Snacks'] },
    macros: { p: ['たんぱく質', 'PROTEIN'], c: ['炭水化物', 'CARBS'], f: ['脂質', 'FAT'] },
    scan: 'スキャン Scan', add: '+ Add food', addMeal: m => `Add ${m.toLowerCase()}`,
    items: n => `${n} items`, of: (a, b) => `${a} of ${b}`,
    tabs: { today: 'Day', week: 'Week', foods: 'My foods', settings: 'Settings' }
  },
  menazka: {
    label: 'Menażka', sub: 'Polish · pierogi',
    today: 'Dziś', yesterday: 'Wczoraj', tomorrow: 'Jutro',
    left: 'Zostało · left today', cheer: 'Dasz radę!', over: 'Ojej! Over by', done: 'Idealnie! Right on target',
    box: ['Menażka', "Today's lunch box"],
    meals: { Breakfast: ['Śniadanie', 'Breakfast'], Lunch: ['Obiad', 'Lunch'], Dinner: ['Kolacja', 'Dinner'], Snacks: ['Przekąski', 'Snacks'] },
    macros: { p: ['Białko', 'PROTEIN'], c: ['Węglowodany', 'CARBS'], f: ['Tłuszcz', 'FAT'] },
    scan: 'Skanuj', add: '+ Dodaj', addMeal: m => ({ Breakfast: 'Dodaj śniadanie', Lunch: 'Dodaj obiad', Dinner: 'Dodaj kolację', Snacks: 'Dodaj przekąskę' }[m]),
    items: n => `${n} ${n === 1 ? 'produkt' : (n % 10 >= 2 && n % 10 <= 4 && (n % 100 < 10 || n % 100 >= 20)) ? 'produkty' : 'produktów'}`, of: (a, b) => `${a} z ${b}`,
    tabs: { today: 'Dzień', week: 'Tydzień', foods: 'Produkty', settings: 'Ustawienia' }
  }
};
const theme = () => THEMES[state.settings.theme] || THEMES.bento;
function applyTheme() { document.documentElement.dataset.theme = THEMES[state.settings.theme] ? state.settings.theme : 'bento'; }

/* ---------- mascots (original characters) ---------- */
function onigiriSvg(mood) {
  const face = mood === 'over'
    ? `<path d="M34 44 h8 M54 44 h8" stroke="#1F2A24" stroke-width="3.5" stroke-linecap="round"/><path d="M42 55 Q48 51 54 55" fill="none" stroke="#1F2A24" stroke-width="2.5" stroke-linecap="round"/><path d="M72 30 q4 7 0 10 q-4 -3 0 -10z" fill="#7FB7E8" stroke="#1F2A24" stroke-width="1.5"/>`
    : `<circle cx="38" cy="44" r="4" fill="#1F2A24"/><circle cx="58" cy="44" r="4" fill="#1F2A24"/><circle cx="39.5" cy="42.5" r="1.3" fill="#fff"/><circle cx="59.5" cy="42.5" r="1.3" fill="#fff"/><path d="M43 52 Q48 57 53 52" fill="none" stroke="#1F2A24" stroke-width="2.5" stroke-linecap="round"/>`;
  return `<svg class="mascot" width="92" height="96" viewBox="0 0 96 100" role="img" aria-label="Onigiri mascot">
    <path d="M48 8 C56 8 60 14 66 24 L86 60 C92 72 86 86 72 86 L24 86 C10 86 4 72 10 60 L30 24 C36 14 40 8 48 8 Z" fill="#fff" stroke="#1F2A24" stroke-width="3.5" stroke-linejoin="round"/>
    <rect x="30" y="62" width="36" height="24" rx="3" fill="#1F2A24"/>
    <ellipse cx="31" cy="52" rx="5" ry="3" fill="#F4A7B9"/><ellipse cx="65" cy="52" rx="5" ry="3" fill="#F4A7B9"/>${face}</svg>`;
}
function pierogiSvg(mood) {
  const face = mood === 'over'
    ? `<path d="M46 66 h8 M70 66 h8" stroke="#1E1B18" stroke-width="3.5" stroke-linecap="round"/><path d="M56 78 Q62 74 68 78" fill="none" stroke="#1E1B18" stroke-width="2.5" stroke-linecap="round"/><path d="M92 52 q4 7 0 10 q-4 -3 0 -10z" fill="#7FB7E8" stroke="#1E1B18" stroke-width="1.5"/>`
    : `<circle cx="50" cy="66" r="4" fill="#1E1B18"/><circle cx="74" cy="66" r="4" fill="#1E1B18"/><circle cx="51.5" cy="64.5" r="1.3" fill="#fff"/><circle cx="75.5" cy="64.5" r="1.3" fill="#fff"/><path d="M56 75 Q62 81 68 75" fill="none" stroke="#1E1B18" stroke-width="2.5" stroke-linecap="round"/>`;
  return `<svg class="mascot" width="104" height="100" viewBox="0 0 124 112" role="img" aria-label="Pierogi mascot in a flower crown">
    <path d="M24 34 C14 52 10 76 8 104" fill="none" stroke="#2A5DB0" stroke-width="4" stroke-linecap="round"/>
    <path d="M100 34 C110 52 114 76 116 104" fill="none" stroke="#B0102A" stroke-width="4" stroke-linecap="round"/>
    <path d="M14 92 Q14 30 62 30 Q110 30 110 92" fill="none" stroke="#E2BE78" stroke-width="12" stroke-linecap="round" stroke-dasharray="0.1 10"/>
    <path d="M14 92 Q14 30 62 30 Q110 30 110 92 Z" fill="#F7E3B5"/>
    <path d="M14 92 Q14 30 62 30 Q110 30 110 92 Z" fill="none" stroke="#1E1B18" stroke-width="3.5" stroke-linejoin="round"/>
    <path d="M24 88 Q24 42 62 42 Q100 42 100 88" fill="none" stroke="#D9AE62" stroke-width="2" stroke-dasharray="3 5" stroke-linecap="round"/>
    <ellipse cx="41" cy="75" rx="5" ry="3" fill="#F4A7B9"/><ellipse cx="83" cy="75" rx="5" ry="3" fill="#F4A7B9"/>${face}
    <g stroke="#1E1B18" stroke-width="1.2"><circle cx="26" cy="38" r="6.5" fill="#2A5DB0"/><circle cx="38" cy="28" r="7" fill="#F2B705"/><circle cx="52" cy="22" r="7" fill="#E85D9A"/><circle cx="62" cy="20" r="8" fill="#B0102A"/><circle cx="72" cy="22" r="7" fill="#F2B705"/><circle cx="86" cy="28" r="7" fill="#2A5DB0"/><circle cx="98" cy="38" r="6.5" fill="#E85D9A"/></g>
    <circle cx="62" cy="20" r="2.8" fill="#F2B705"/><circle cx="38" cy="28" r="2.2" fill="#B0102A"/><circle cx="86" cy="28" r="2.2" fill="#fff"/><circle cx="52" cy="22" r="2" fill="#fff"/><circle cx="72" cy="22" r="2" fill="#B0102A"/>
    <ellipse cx="45" cy="16" rx="5" ry="2.2" fill="#2E7D32" transform="rotate(-25 45 16)"/><ellipse cx="79" cy="16" rx="5" ry="2.2" fill="#2E7D32" transform="rotate(25 79 16)"/></svg>`;
}
function folkFlower(colors, center, size = 34) {
  const [a, b] = colors;
  const petals = [0, 72, 144, 216, 288].map((r, i) => `<ellipse cx="0" cy="-8" rx="4.5" ry="7" fill="${i % 2 ? b : a}" transform="rotate(${r})"/>`).join('');
  return `<svg width="${size}" height="${size}" viewBox="-17 -17 34 34" aria-hidden="true">${petals}<circle r="4" fill="${center}"/></svg>`;
}

/* ---------- day screen ---------- */
function bigDateWord(d) {
  const T = theme(), today = ymd(new Date());
  if (d === today) return T.today;
  if (d === addDays(today, -1)) return T.yesterday;
  if (d === addDays(today, 1)) return T.tomorrow;
  if (state.settings.theme === 'menazka') { const w = parseYmd(d).toLocaleDateString('pl-PL', { weekday: 'long' }); return w.charAt(0).toUpperCase() + w.slice(1); }
  return parseYmd(d).toLocaleDateString('ja-JP', { weekday: 'short' }) + '曜日';
}
function subDate(d) {
  if (state.settings.theme === 'menazka') return parseYmd(d).toLocaleDateString('pl-PL', { weekday: 'long', day: 'numeric', month: 'long' });
  return `${dateLabel(d) === 'Today' || dateLabel(d) === 'Yesterday' || dateLabel(d) === 'Tomorrow' ? dateLabel(d) + ' · ' : ''}${parseYmd(d).toLocaleDateString('en-AU', { weekday: 'short', day: 'numeric', month: 'short' })}`;
}
function powerBar(key, val, target) {
  const T = theme(), pct = target ? Math.min(100, (val / target) * 100) : 0, over = key !== 'p' && val > target * 1.02;
  return `<div class="pbar-row"><div class="pbar-lbl">${esc(T.macros[key][0])}<small>${T.macros[key][1]}</small></div>
    <div class="pbar ${key}${over ? ' over' : ''}" role="meter" aria-label="${T.macros[key][1]}" aria-valuenow="${r0(val)}" aria-valuemin="0" aria-valuemax="${r0(target)}"><i style="width:${pct}%"></i></div>
    <div class="pbar-val">${r0(val)}/${r0(target)}</div></div>`;
}
function mealSummary(meal) {
  const es = state.day.entries.filter(e => e.meal === meal);
  const t = totals(es);
  return { es, kcal: t.kcal, title: !es.length ? '' : es.length === 1 ? es[0].name : theme().items(es.length) };
}
function compartment(meal, cls) {
  const T = theme(), s = mealSummary(meal), [jp, en] = T.meals[meal];
  if (!s.es.length) return `<button class="comp empty ${cls}" data-action="open-meal" data-meal="${meal}" aria-label="${esc(T.addMeal(meal))}">
      <span class="comp-lbl">${esc(jp)} <small>${en}</small></span><span class="comp-plus">+</span><span class="comp-add">${esc(T.addMeal(meal))}</span></button>`;
  return `<button class="comp ${cls}" data-action="open-meal" data-meal="${meal}">
      <span class="comp-lbl">${esc(jp)} <small>${en}</small></span><span class="comp-name">${esc(s.title)}</span><span class="comp-kcal">${fmt(s.kcal)}</span></button>`;
}
function tier(meal, flower) {
  const T = theme(), s = mealSummary(meal), [pl, en] = T.meals[meal];
  if (!s.es.length) return `<button class="tier empty" data-action="open-meal" data-meal="${meal}"><span class="tier-plus">+</span>
      <span class="tier-txt"><span class="comp-lbl">${esc(pl)} · ${en}</span><span class="comp-name">${esc(T.addMeal(meal))}</span></span></button>`;
  return `<button class="tier" data-action="open-meal" data-meal="${meal}">${flower}
      <span class="tier-txt"><span class="comp-lbl">${esc(pl)} · ${en}</span><span class="comp-name">${esc(s.title)}</span></span><span class="comp-kcal">${fmt(s.kcal)}</span></button>`;
}
const RICE = `<svg class="garnish" width="26" height="26" viewBox="0 0 26 26" aria-hidden="true"><circle cx="13" cy="14" r="10" fill="#C8243B"/><circle cx="9" cy="10" r="2.5" fill="#E8687D"/><path d="M13 4 Q16 0 20 2" fill="none" stroke="#4E7A3A" stroke-width="2" stroke-linecap="round"/></svg>`;
const BARAN = `<svg class="baran" width="100%" height="16" viewBox="0 0 160 16" preserveAspectRatio="none" aria-hidden="true"><polygon points="0,0 160,0 160,6 152,16 144,5 136,15 128,4 120,14 112,5 104,16 96,4 88,15 80,5 72,14 64,4 56,16 48,5 40,15 32,4 24,14 16,5 8,16 0,6" fill="#3E9B4F"/></svg>`;
const CHOPSTICKS = `<svg width="118" height="28" viewBox="0 0 118 28" aria-hidden="true"><ellipse cx="96" cy="21" rx="12" ry="5" fill="#9E2B25"/><rect x="2" y="9" width="110" height="5" rx="2.5" fill="#C99A6B" transform="rotate(-4 57 11)"/><rect x="2" y="15" width="110" height="5" rx="2.5" fill="#B9875A" transform="rotate(-2 57 17)"/><rect x="2" y="9" width="22" height="5" rx="2.5" fill="#3B2A22" transform="rotate(-4 57 11)"/><rect x="2" y="15" width="22" height="5" rx="2.5" fill="#3B2A22" transform="rotate(-2 57 17)"/></svg>`;

function renderToday() {
  const T = theme(), G = state.settings.targets, t = totals(state.day.entries), left = G.kcal - t.kcal;
  const mood = left < -50 ? 'over' : 'happy';
  const msg = left < -50 ? `${T.over} ${fmt(-left)}` : Math.abs(left) <= 50 && t.kcal > 0 ? T.done : `${T.cheer} ${T.of(fmt(t.kcal), fmt(G.kcal))}`;
  const isPl = state.settings.theme === 'menazka';
  let h = `<div class="dayhead"><div><span class="bigword">${esc(bigDateWord(state.date))}</span> <span class="subdate">${esc(subDate(state.date))}</span></div>
    <div class="daynav"><button data-action="prev" aria-label="Previous day">‹</button><button data-action="today" aria-label="Go to today">•</button><button data-action="next" aria-label="Next day">›</button></div></div>
  <div class="hero">${isPl ? pierogiSvg(mood) : onigiriSvg(mood)}
    <div class="bubble"><div class="bub-lbl">${esc(T.left)}</div><div class="bub-num">${left < 0 ? '−' : ''}${fmt(Math.abs(left))}<span> kcal</span></div><div class="bub-msg">${esc(msg)}</div></div></div>
  <div class="card pbars">${powerBar('p', t.p, G.p)}${powerBar('c', t.c, G.c)}${powerBar('f', t.f, G.f)}</div>
  <div class="boxhead"><div><b>${esc(T.box[0])}</b> <span class="subdate">${esc(T.box[1])}</span></div>${isPl ? '' : CHOPSTICKS}</div>`;
  if (isPl) {
    h += `<div class="menazka"><svg class="handle" width="200" height="34" viewBox="0 0 200 34" aria-hidden="true"><path d="M10 34 C10 6 40 4 100 4 C160 4 190 6 190 34" fill="none" stroke="#7D8793" stroke-width="7" stroke-linecap="round"/><path d="M10 34 C10 6 40 4 100 4 C160 4 190 6 190 34" fill="none" stroke="#C3CAD2" stroke-width="2.5" stroke-linecap="round"/><rect x="70" y="-2" width="60" height="12" rx="6" fill="#3B2A22"/></svg>
      <div class="rod l"></div><div class="rod r"></div><div class="tiers">
      ${tier('Breakfast', folkFlower(['#B0102A', '#E85D9A'], '#F2B705'))}
      ${tier('Lunch', folkFlower(['#2A5DB0', '#2A5DB0'], '#FFFFFF'))}
      ${tier('Dinner', folkFlower(['#2E7D32', '#F2B705'], '#B0102A'))}
      ${tier('Snacks', folkFlower(['#F2B705', '#B0102A'], '#2E7D32'))}</div></div>`;
  } else {
    h += `<div class="bento"><div class="bento-in">
      <div class="bcol">${compartment('Breakfast', 'rice').replace('<span class="comp-lbl">', RICE + '<span class="comp-lbl">')}${compartment('Lunch', 'greens').replace('<span class="comp-lbl">', BARAN + '<span class="comp-lbl">')}</div>
      <div class="bcol">${compartment('Dinner', 'main')}${compartment('Snacks', 'tamago')}</div></div></div>`;
  }
  h += `<div class="card weight"><b style="flex:1">Morning weight</b><input id="weightIn" type="number" inputmode="decimal" step="0.1" placeholder="kg" value="${state.day.weight ?? ''}"></div>`;
  return h;
}

function renderWeek() {
  const end = state.date, start = addDays(end, -6), T = state.settings.targets, days = [];
  for (let d = start; d <= end; d = addDays(d, 1)) {
    const v = Store.get('day:' + d); const t = v ? totals(v.entries || []) : null;
    days.push({ d, t: t && t.kcal > 0 ? t : null, w: v && v.weight ? num(v.weight) : null });
  }
  const logged = days.filter(x => x.t), ws = days.filter(x => x.w);
  const avg = k => logged.length ? logged.reduce((s, x) => s + x.t[k], 0) / logged.length : 0;
  const avgW = ws.length ? ws.reduce((s, x) => s + x.w, 0) / ws.length : null;
  const max = Math.max(T.kcal * 1.25, ...logged.map(x => x.t.kcal));
  const W = 320, H = 150, bw = 30, gap = (W - 7 * bw) / 8, y = v => H - 20 - (v / max) * (H - 30);
  let bars = '';
  days.forEach((x, i) => {
    const bx = gap + i * (bw + gap);
    if (x.t) bars += `<rect x="${bx}" y="${y(x.t.kcal)}" width="${bw}" height="${H - 20 - y(x.t.kcal)}" rx="5" fill="${x.t.kcal > T.kcal * 1.05 ? 'var(--over)' : 'var(--c)'}"/>`;
    bars += `<text x="${bx + bw / 2}" y="${H - 5}" font-size="11" text-anchor="middle" fill="var(--mute)">${parseYmd(x.d).toLocaleDateString('en-AU', { weekday: 'narrow' })}</text>`;
  });
  const ty = y(T.kcal);
  bars += `<line x1="0" x2="${W}" y1="${ty}" y2="${ty}" stroke="var(--mute)" stroke-dasharray="4 4"/><text x="${W}" y="${ty - 4}" font-size="10" text-anchor="end" fill="var(--mute)">target ${fmt(T.kcal)}</text>`;
  let h = `<div class="stats"><div class="stat"><b>${logged.length ? fmt(avg('kcal')) : '–'}</b><span>avg kcal</span></div>
    <div class="stat"><b>${logged.length ? r0(avg('p')) + 'g' : '–'}</b><span>avg protein</span></div>
    <div class="stat"><b>${avgW ? avgW.toFixed(1) : '–'}</b><span>avg weight kg</span></div></div>
    <div class="card"><div class="note" style="margin-bottom:6px">${shortDate(start)} – ${shortDate(end)} · ${logged.length}/7 days logged</div>
    <svg viewBox="0 0 ${W} ${H}" width="100%" role="img" aria-label="Daily calories">${bars}</svg></div>
    <div class="card"><table><thead><tr><th>Day</th><th>kcal</th><th>P</th><th>C</th><th>F</th><th>kg</th></tr></thead><tbody>`;
  days.forEach(x => {
    h += `<tr><td>${parseYmd(x.d).toLocaleDateString('en-AU', { weekday: 'short', day: 'numeric' })}</td><td>${x.t ? fmt(x.t.kcal) : '–'}</td><td>${x.t ? r0(x.t.p) : '–'}</td><td>${x.t ? r0(x.t.c) : '–'}</td><td>${x.t ? r0(x.t.f) : '–'}</td><td>${x.w ? x.w.toFixed(1) : '–'}</td></tr>`;
  });
  h += `</tbody>${logged.length ? `<tfoot><tr><td>Avg</td><td>${fmt(avg('kcal'))}</td><td>${r0(avg('p'))}</td><td>${r0(avg('c'))}</td><td>${r0(avg('f'))}</td><td>${avgW ? avgW.toFixed(1) : '–'}</td></tr></tfoot>` : ''}</table></div>`;
  const summary = `Week ${shortDate(start)}–${shortDate(end)} (${logged.length}/7 days logged)\n` +
    `Avg calories: ${logged.length ? fmt(avg('kcal')) : '–'} kcal (target ${fmt(T.kcal)})\n` +
    `Avg protein: ${logged.length ? r0(avg('p')) : '–'} g (target ${T.p}) · carbs ${r0(avg('c'))} g · fat ${r0(avg('f'))} g\n` +
    `Weight: ${ws.length ? (ws.length > 1 ? `${ws[0].w.toFixed(1)} → ${ws[ws.length - 1].w.toFixed(1)} kg, avg ${avgW.toFixed(1)} kg` : `${ws[0].w.toFixed(1)} kg`) : 'not logged'}`;
  state.weekSummary = summary;
  h += `<div class="card"><b>Weekly summary</b><pre style="white-space:pre-wrap;font:13px/1.5 ui-monospace,Menlo,monospace;margin:8px 0 10px">${esc(summary)}</pre>
    <button class="btn" data-action="copy-summary">Copy summary</button><div id="copyFallback"></div></div>`;
  return h;
}

function foodSub(f) {
  const base = hasM(f.perServe) ? `${fmt(f.perServe.kcal)} kcal / serve` : hasM(f.per100) ? `${fmt(f.per100.kcal)} kcal / 100g` : '';
  return [f.source === 'recipe' ? '🍲 Recipe' : f.brand, base, f.code ? '▥' : ''].filter(Boolean).join(' · ');
}
function sortedFoods(filter) {
  const q = (filter || '').toLowerCase().trim();
  return Object.values(state.foods)
    .filter(f => !q || (f.name + ' ' + (f.brand || '') + ' ' + (f.code || '')).toLowerCase().includes(q))
    .sort((a, b) => (b.lastUsed || 0) - (a.lastUsed || 0) || (b.uses || 0) - (a.uses || 0) || a.name.localeCompare(b.name));
}
function renderFoodsTab() {
  const list = sortedFoods(state.foodsFilter);
  let h = `<div class="card"><b>My foods</b> <span class="pill">${Object.keys(state.foods).length}</span>
    <p class="note">Everything you scan, photograph or save lands here. Scanned barcodes are recognised instantly next time, even offline.</p>
    <button class="btn ghost" data-action="new-recipe" style="margin-bottom:10px">🍲 New recipe</button>
    <input id="foodsTabFilter" placeholder="Search my foods" value="${esc(state.foodsFilter || '')}">`;
  if (!list.length) h += `<p class="note">${Object.keys(state.foods).length ? 'No matches.' : 'Nothing yet — scan something!'}</p>`;
  list.slice(0, 200).forEach(f => {
    h += `<div class="entry"><div class="nm"><div>${esc(f.name)}</div><div class="mac">${esc(foodSub(f))}</div></div>
      <button class="icon" data-action="edit-food" data-key="${esc(f.key)}" aria-label="Edit">✎</button>
      <button class="icon" data-action="del-food" data-key="${esc(f.key)}" aria-label="Delete">✕</button></div>`;
  });
  return h + `</div>`;
}

function renderSettings() {
  const T = state.settings.targets, fromMacros = T.p * 4 + T.c * 4 + T.f * 9;
  const used = (() => { let n = 0; try { for (const k of Store.keys()) n += (localStorage.getItem('fuel:' + k) || '').length; } catch {} return n; })();
  const themeCard = `<div class="card"><b>Theme</b><div class="themes">${Object.entries(THEMES).map(([k, t]) =>
    `<button class="theme-opt ${state.settings.theme === k ? 'on' : ''}" data-action="set-theme" data-theme-key="${k}">${k === 'menazka' ? pierogiSvg('happy') : onigiriSvg('happy')}<b>${t.label}</b><span class="note">${t.sub}</span></button>`).join('')}</div></div>`;
  return themeCard + `<div class="card"><b>Daily targets</b><p class="note">Protein & carbs = 4 kcal/g, fat = 9 kcal/g.</p>
    <label class="f">Calories (kcal)<input id="tK" type="number" inputmode="numeric" value="${T.kcal}"></label>
    <div class="row"><label class="f">Protein g<input id="tP" type="number" inputmode="numeric" value="${T.p}"></label><label class="f">Carbs g<input id="tC" type="number" inputmode="numeric" value="${T.c}"></label><label class="f">Fat g<input id="tF" type="number" inputmode="numeric" value="${T.f}"></label></div>
    <p class="note">Your macros add up to ${fmt(fromMacros)} kcal.</p>
    <div class="row"><button class="btn ghost" data-action="fit-carbs">Fit carbs to calories</button><button class="btn" data-action="save-targets">Save</button></div></div>

    <div class="card"><b>Label reading (Claude)</b>
    <p class="note">Optional. With your own Anthropic API key, Fuel can read nutrition labels from a photo and estimate meals you describe. Each label costs roughly a cent or less. The key is stored only on this phone.</p>
    <label class="f">API key<input id="apiKey" type="password" autocomplete="off" placeholder="sk-ant-…" value="${esc(state.settings.apiKey)}"></label>
    <label class="f">Model<input id="apiModel" value="${esc(state.settings.model)}"></label>
    <div class="row"><button class="btn ghost" data-action="test-key">Test</button><button class="btn" data-action="save-key">Save</button></div>
    <p class="note" style="margin-bottom:0">Get a key at console.anthropic.com → API keys, and set a monthly spend limit there.</p></div>

    <div class="card"><b>Backup</b><p class="note">Your log and food library live on this phone (${(used / 1024).toFixed(0)} KB used). Export a backup now and then — it's also how you move to a new phone.</p>
    <button class="btn" data-action="export">Export backup</button><button class="btn ghost" data-action="import">Import backup</button><div id="exportFallback"></div></div>

    <div class="card"><b>Install</b><p class="note" style="margin-bottom:0">iPhone: Safari → Share → <i>Add to Home Screen</i>. Android: Chrome menu → <i>Install app</i>. Food data from <a href="https://world.openfoodfacts.org" target="_blank" rel="noopener">Open Food Facts</a> (ODbL).</p></div>`;
}

/* ================= add-food sheet ================= */
let sheet = { open: false, view: 'tabs', tab: 'foods', meal: defaultMeal(), filter: '', results: [], busy: false, error: '', food: null, mode: 'serves', amt: 1, draft: null, photo: null, code: null, describeText: '', describeRes: [], auOnly: true, q: '' };

function openSheet(opts = {}) {
  sheet = { ...sheet, open: true, view: 'tabs', error: '', busy: false, fromFoodsTab: false, picking: false, mealPhoto: null, ...opts };
  if (!opts.meal) sheet.meal = sheet.meal || defaultMeal();
  $('#sheet').classList.remove('hidden');
  renderSheet();
}
function closeSheet() { sheet.open = false; $('#sheet').classList.add('hidden'); if (state.tab === 'foods') render(); }
function setView(view, extra = {}) { sheet = { ...sheet, view, error: '', ...extra }; renderSheet(); $('#sheetPanel').scrollTop = 0; }

const mealSeg = () => `<div class="seg">${MEALS.map(m => `<button data-action="meal" data-meal="${m}" class="${sheet.meal === m ? 'on' : ''}">${m}</button>`).join('')}</div>`;
const addLabel = () => sheet.picking ? 'Add to recipe' : `Add to ${sheet.meal.toLowerCase()}`;
const errHtml = () => sheet.error ? `<p class="warn">${esc(sheet.error)}</p>` : '';

function renderSheet() {
  const s = sheet; let h = '';
  if (s.view === 'tabs') {
    h += s.picking
      ? `<h2><button class="back" data-action="to-recipe">‹ Recipe</button><span>Add ingredient</span><button class="icon" data-action="close" aria-label="Close">✕</button></h2>`
      : `<h2>Add food <button class="icon" data-action="close" aria-label="Close">✕</button></h2>${mealSeg()}`;
    h += `
      <div class="seg">${[['foods', 'My foods'], ['search', 'Search'], ['quick', 'Quick add']].map(([k, l]) => `<button data-action="stab" data-stab="${k}" class="${s.tab === k ? 'on' : ''}">${l}</button>`).join('')}</div>`;
    if (s.tab === 'foods') {
      h += `<div class="row" style="margin-bottom:10px"><button class="btn" data-action="scan">▥ Scan</button><button class="btn ghost" data-action="label-photo">📷 Label</button><button class="btn ghost" data-action="meal-photo">📸 Meal</button></div>
        ${s.picking ? '' : `<button class="link" data-action="new-recipe" style="margin:-2px 0 6px">🍲 Create a recipe</button>`}
        <input id="sheetFilter" placeholder="Search my foods" value="${esc(s.filter)}">`;
      const list = sortedFoods(s.filter);
      if (!list.length) h += `<p class="note">${Object.keys(state.foods).length ? 'No matches — try the Search tab.' : 'Your library is empty. Scan a barcode or photograph a label to start it.'}</p>`;
      list.slice(0, 60).forEach(f => { h += `<button class="item" data-action="pick-food" data-key="${esc(f.key)}"><div class="nm"><div>${esc(f.name)}</div><div class="mac">${esc(foodSub(f))}</div></div><span class="chev">›</span></button>`; });
    } else if (s.tab === 'search') {
      h += `<form id="searchForm" class="row" style="margin-bottom:6px"><input id="searchQ" placeholder="e.g. Chobani Fit vanilla" value="${esc(s.q)}" style="flex:3"><button class="btn" style="flex:1" ${s.busy ? 'disabled' : ''}>${s.busy ? '<span class="spin"></span>' : 'Search'}</button></form>
        <label class="note" style="display:flex;gap:8px;align-items:center;margin-bottom:8px"><input type="checkbox" id="auOnly" ${s.auOnly ? 'checked' : ''} style="width:18px;height:18px"> Australian products only</label>${errHtml()}`;
      if (!s.busy && s.searched && !s.results.length && !s.error) h += `<p class="note">No results. Try fewer words, untick “Australian only”, or scan/photograph it instead.</p>`;
      s.results.forEach((f, i) => { h += `<button class="item" data-action="pick-result" data-i="${i}"><div class="nm"><div>${esc(f.name)}</div><div class="mac">${esc(foodSub(f))}</div></div><span class="chev">›</span></button>`; });
      h += `<p class="note">Results from Open Food Facts, a free crowd-sourced database. Check the numbers against the pack.</p>`;
    } else {
      h += `<b>Quick add</b><div class="row" style="margin-top:8px"><label class="f">Name<input id="qName" placeholder="e.g. Coffee"></label></div>
        <div class="row"><label class="f">kcal<input id="qK" type="number" inputmode="decimal"></label><label class="f">Protein g<input id="qP" type="number" inputmode="decimal"></label><label class="f">Carbs g<input id="qC" type="number" inputmode="decimal"></label><label class="f">Fat g<input id="qF" type="number" inputmode="decimal"></label></div>
        <button class="btn" data-action="quick-add">${addLabel()}</button>
        <button class="btn ghost" data-action="new-food">Create a reusable food…</button>`;
      h += `<div style="margin-top:18px" id="aiEst"><b>✨ Snap or describe a meal</b>`;
      if (!state.settings.apiKey) h += `<p class="note">Add a Claude API key in Settings to estimate meals from a photo or a description.</p>`;
      else {
        h += s.mealPhoto
          ? `<div style="position:relative;margin-top:8px"><img class="photo" src="${s.mealPhoto}" alt="Your meal photo"><button class="icon" data-action="meal-photo-clear" aria-label="Remove photo" style="position:absolute;top:6px;right:6px;background:var(--card);border:2px solid var(--ink)">✕</button></div>`
          : `<button class="btn ghost" data-action="meal-photo" style="margin-top:8px">📸 Take a photo of your meal</button>`;
        h += `<textarea id="descText" style="margin-top:8px" placeholder="${s.mealPhoto ? 'Optional details, e.g. about 200 g chicken, cooked in olive oil' : 'Or describe it, e.g. chicken burrito bowl from Guzman y Gomez with guac'}">${esc(s.describeText)}</textarea>
          <button class="btn" data-action="describe" style="margin-top:8px" ${s.busy ? 'disabled' : ''}>${s.busy ? '<span class="spin"></span>' + (s.mealPhoto ? 'Looking at your meal…' : 'Estimating…') : s.describeRes.length ? 'Estimate again' : 'Estimate'}</button>${errHtml()}`;
        if (s.describeRes.length) {
          s.describeRes.forEach((r, i) => {
            h += `<div class="card" style="padding:10px;margin:10px 0 0" data-dr="${i}"><div style="display:flex;gap:8px;align-items:center;margin-bottom:6px"><input type="checkbox" class="drk" checked style="width:20px;height:20px;flex:none"><input class="drn" value="${esc(r.name)}"></div>
              <div class="row"><input class="drkc" type="number" inputmode="decimal" value="${r0(r.kcal)}" aria-label="kcal"><input class="drp" type="number" inputmode="decimal" value="${r0(r.p)}" aria-label="protein"><input class="drc" type="number" inputmode="decimal" value="${r0(r.c)}" aria-label="carbs"><input class="drf" type="number" inputmode="decimal" value="${r0(r.f)}" aria-label="fat"></div>
              <div class="note row" style="text-align:center"><span>kcal</span><span>P g</span><span>C g</span><span>F g</span></div></div>`;
          });
          h += `<button class="btn" data-action="describe-add" style="margin-top:10px">${addLabel()}</button>`;
        }
      }
      h += `</div>`;
    }
  } else if (s.view === 'busy') {
    h += `<h2>${esc(s.busyTitle || 'Working…')}<button class="icon" data-action="close" aria-label="Close">✕</button></h2>${s.photo ? `<img class="photo" src="${s.photo}" alt="">` : ''}<p><span class="spin"></span>${esc(s.busyMsg || '')}</p>`;
  } else if (s.view === 'notfound') {
    h += `<h2><button class="back" data-action="back">‹ Back</button><button class="icon" data-action="close" aria-label="Close">✕</button></h2>
      <p><b>Barcode ${esc(s.code)} isn't in the database yet.</b></p>
      <p class="note">Snap the nutrition panel and Fuel will save it to your foods under this barcode — next time it'll pop up instantly.</p>${errHtml()}
      <button class="big-btn" data-action="label-photo"><span>📷</span>Photograph the nutrition label</button>
      <button class="btn ghost" data-action="new-food" style="margin-top:10px">Type it in instead</button>`;
  } else if (s.view === 'food') {
    const f = s.food;
    const modes = [canServes(f) ? 'serves' : null, canGrams(f) ? 'grams' : null].filter(Boolean);
    if (!modes.includes(s.mode)) s.mode = modes[0];
    const m = macrosFor(f, s.mode, s.amt);
    h += `<h2><button class="back" data-action="back">‹ Back</button><button class="icon" data-action="close" aria-label="Close">✕</button></h2>
      <div style="font-size:18px;font-weight:700">${esc(f.name)}</div><div class="note">${esc([f.brand, f.servingLabel && 'Serve: ' + f.servingLabel, f.code && '▥ ' + f.code].filter(Boolean).join(' · '))}</div>
      ${s.picking ? '<div style="height:12px"></div>' : mealSeg().replace('margin-bottom:12px', 'margin:12px 0')}
      <div class="row" style="align-items:center">
        ${modes.length > 1 ? `<div class="seg" style="margin:0;flex:1.2">${modes.map(k => `<button data-action="amode" data-mode="${k}" class="${s.mode === k ? 'on' : ''}">${k === 'serves' ? 'Serves' : unitOf(f) === 'mL' ? 'mL' : 'Grams'}</button>`).join('')}</div>` : `<div class="note">${s.mode === 'serves' ? 'Serves' : 'Grams'}</div>`}
        <input id="amt" type="number" inputmode="decimal" step="${s.mode === 'serves' ? '0.5' : '5'}" value="${esc(s.amt)}" style="flex:1">
      </div>
      <div class="macgrid" id="macgrid">${macGrid(m)}</div>
      <button class="btn" data-action="log-food">${addLabel()}</button>
      ${f.source === 'recipe' ? `<button class="btn ghost" data-action="edit-recipe" data-key="${esc(f.key)}">Edit recipe</button>` : `<button class="btn ghost" data-action="edit-current">Numbers wrong? Edit this food</button>`}
      ${f.source === 'off' ? `<p class="note">From Open Food Facts. Saved to My foods when you add it.</p>` : ''}`;
  } else if (s.view === 'meal') {
    const T = theme(), [a, en] = T.meals[s.meal], es = state.day.entries.filter(e => e.meal === s.meal), t = totals(es);
    h += `<h2><span>${esc(a)} <span class="note">${en} · ${esc(dateLabel(state.date))}</span></span><button class="icon" data-action="close" aria-label="Close">✕</button></h2>`;
    if (!es.length) h += `<p class="note">Nothing logged yet.</p><button class="btn ghost" data-action="copy-yday" data-meal="${s.meal}">Copy ${s.meal.toLowerCase()} from yesterday</button>`;
    es.forEach(e => {
      h += `<div class="entry"><div class="nm"><div>${esc(e.name)}</div><div class="mac">${e.amount ? esc(e.amount) + ' · ' : ''}P ${r0(e.p)} · C ${r0(e.c)} · F ${r0(e.f)}</div></div>
        <div class="kc">${fmt(e.kcal)}</div><button class="icon" data-action="del" data-id="${esc(e.id)}" aria-label="Delete">✕</button></div>`;
    });
    if (es.length) h += `<div class="macgrid">${macGrid(t)}</div>`;
    h += `<div class="row" style="margin-top:10px"><button class="btn" data-action="scan">▥ Scan</button><button class="btn ghost" data-action="meal-photo">📸 Snap</button><button class="btn ghost" data-action="meal-add">+ Add</button></div>`;
  } else if (s.view === 'recipe') {
    const r = s.recipe, ing = r.ingredients || [];
    h += `<h2><span>${r.key ? 'Edit recipe' : 'New recipe'}</span><button class="icon" data-action="close" aria-label="Close">✕</button></h2>${errHtml()}
      <label class="f">Recipe name<input id="rName" value="${esc(r.name)}" placeholder="e.g. Slow-cooker chicken burrito bowls"></label>
      <div class="row"><label class="f">Makes how many serves?<input id="rServ" type="number" inputmode="decimal" step="1" value="${esc(r.servings)}"></label>
      <label class="f">Total cooked weight (g)<input id="rCooked" type="number" inputmode="decimal" value="${esc(r.cookedG ?? '')}" placeholder="optional"></label></div>
      <p class="note" style="margin-top:-4px">Weigh the whole pot after cooking (minus the pot) to log any portion by grams — handy when serves aren't equal.</p>
      <div style="display:flex;justify-content:space-between;align-items:baseline;margin-top:6px"><b>Ingredients</b><span class="note" id="rTotal">${recipeTotalLine(r)}</span></div>`;
    if (!ing.length) h += `<p class="note">No ingredients yet. Add them from your foods, by scanning, searching or typing them in.</p>`;
    ing.forEach(e => {
      h += `<div class="entry"><div class="nm"><div>${esc(e.name)}</div><div class="mac">${e.amount ? esc(e.amount) + ' · ' : ''}P ${r0(e.p)} · C ${r0(e.c)} · F ${r0(e.f)}</div></div>
        <div class="kc">${fmt(e.kcal)}</div><button class="icon" data-action="rm-ing" data-id="${esc(e.id)}" aria-label="Remove">✕</button></div>`;
    });
    h += `<button class="btn ghost" data-action="add-ing" style="margin-top:8px">+ Add ingredient</button>
      <div class="note" style="margin-top:14px"><b>Per serve</b></div><div class="macgrid" id="rgrid">${macGrid(recipeToFood(r).perServe)}</div>
      <button class="btn" data-action="save-recipe">Save recipe</button>`;
  } else if (s.view === 'edit') {
    const d = s.draft, M = (o, k) => o && o[k] != null ? r1(o[k]) : '';
    h += `<h2><button class="back" data-action="back">‹ Back</button><span>${d.key && state.foods[d.key] ? 'Edit food' : 'New food'}</span><button class="icon" data-action="close" aria-label="Close">✕</button></h2>
      ${s.photo ? `<img class="photo" src="${s.photo}" alt="Label photo">` : ''}
      ${d.fromLabel ? `<p class="note" style="margin-top:0">✨ Read from your photo — check against the label before saving.</p>` : ''}${errHtml()}
      <label class="f">Name<input id="eName" value="${esc(d.name)}"></label>
      <div class="row"><label class="f">Brand<input id="eBrand" value="${esc(d.brand)}"></label><label class="f">Barcode<input id="eCode" inputmode="numeric" value="${esc(d.code || '')}" placeholder="optional"></label></div>
      <div class="row"><label class="f">Serving size (g or mL)<input id="eServG" type="number" inputmode="decimal" value="${esc(d.servingG ?? '')}"></label><label class="f">Energy unit<select id="eUnit"><option value="kcal">kcal / Cal</option><option value="kj">kJ</option></select></label></div>
      <div class="note" style="margin:2px 0 6px"><b>Per serve</b></div>
      <div class="row"><label class="f">Energy<input id="sK" type="number" inputmode="decimal" value="${M(d.perServe, 'kcal')}"></label><label class="f">Protein g<input id="sP" type="number" inputmode="decimal" value="${M(d.perServe, 'p')}"></label><label class="f">Carbs g<input id="sC" type="number" inputmode="decimal" value="${M(d.perServe, 'c')}"></label><label class="f">Fat g<input id="sF" type="number" inputmode="decimal" value="${M(d.perServe, 'f')}"></label></div>
      <div class="note" style="margin:2px 0 6px"><b>Per 100 g / 100 mL</b> (optional, lets you log by weight)</div>
      <div class="row"><label class="f">Energy<input id="hK" type="number" inputmode="decimal" value="${M(d.per100, 'kcal')}"></label><label class="f">Protein g<input id="hP" type="number" inputmode="decimal" value="${M(d.per100, 'p')}"></label><label class="f">Carbs g<input id="hC" type="number" inputmode="decimal" value="${M(d.per100, 'c')}"></label><label class="f">Fat g<input id="hF" type="number" inputmode="decimal" value="${M(d.per100, 'f')}"></label></div>
      <button class="btn" data-action="save-food">Save food</button>
      ${state.settings.apiKey && !s.photo ? `<button class="btn ghost" data-action="label-photo">📷 Fill in from a label photo</button>` : ''}
      <p class="note">Australian labels show energy in kJ — pick “kJ” above and type the number as printed; it's converted for you.</p>`;
  }
  $('#sheetPanel').innerHTML = h;
}
function recipeTotalLine(r) { const t = recipeTotals(r); return `Whole recipe: ${fmt(t.kcal)} kcal · P ${r0(t.p)} · C ${r0(t.c)} · F ${r0(t.f)}`; }
function openRecipe(draft) {
  if (!sheet.open) openSheet();
  setView('recipe', { recipe: draft, picking: false });
}
function addIngredients(items) {
  sheet.recipe = { ...sheet.recipe, ingredients: [...(sheet.recipe.ingredients || []), ...items.map(it => ({ id: uid(), ...it }))] };
  saveRecipeDraft();
  setView('recipe', { picking: false });
  toast(items.length > 1 ? `Added ${items.length} ingredients` : 'Ingredient added');
}
function macGrid(m) {
  return `<div><b>${fmt(m.kcal)}</b><span>kcal</span></div><div><b>${r0(m.p)}g</b><span>protein</span></div><div><b>${r0(m.c)}g</b><span>carbs</span></div><div><b>${r0(m.f)}g</b><span>fat</span></div>`;
}
function showFood(food, from) {
  // recipe ingredients are usually weighed, so prefer grams there
  const mode = sheet.picking ? (canGrams(food) ? 'grams' : 'serves') : (canServes(food) ? 'serves' : 'grams');
  setView('food', { food, mode, amt: mode === 'serves' ? 1 : 100, backTo: from || 'tabs' });
}
function editFood(food, extra = {}) {
  setView('edit', { draft: JSON.parse(JSON.stringify(food)), backTo: sheet.view === 'food' ? 'food' : (extra.backTo || 'tabs'), ...extra });
}

/* ================= flows ================= */
async function handleCode(code) {
  code = String(code).replace(/\D/g, '');
  if (!code) return;
  if (!sheet.open) openSheet();
  // 1) your own library (also matches UPC-A vs EAN-13 with a leading 0)
  const alt = code.length === 12 ? '0' + code : code.length === 13 && code[0] === '0' ? code.slice(1) : null;
  const mine = state.foods[code] || (alt && state.foods[alt]);
  if (mine) { toast('Found in My foods'); showFood(mine, 'tabs'); return; }
  // 2) Open Food Facts
  setView('busy', { busyTitle: 'Looking it up', busyMsg: `Searching Open Food Facts for ${code}…`, photo: null, code });
  try {
    const f = await offLookup(code) || (alt ? await offLookup(alt) : null);
    if (!sheet.open) return;
    if (f) { f.code = code; f.key = code; showFood(f, 'tabs'); }
    else setView('notfound', { code, backTo: 'tabs' });
  } catch (e) {
    if (!sheet.open) return;
    setView('notfound', { code, backTo: 'tabs' });
    sheet.error = navigator.onLine === false ? "You're offline, so the database can't be checked — you can still photograph or type the label." : (e.message || 'Lookup failed');
    renderSheet();
  }
}

async function handleLabelFile(file) {
  if (!file) return;
  if (!sheet.open) openSheet();
  let canvas;
  try { canvas = await fileToCanvas(file, 1600); } catch (e) { toast(e.message); return; }
  const photo = canvas.toDataURL('image/jpeg', 0.85);
  const code = sheet.view === 'notfound' ? sheet.code : (sheet.view === 'edit' && sheet.draft && sheet.draft.code) || null;
  // bonus: if the photo also shows the barcode, grab it
  let foundCode = code;
  if (!foundCode) { try { foundCode = await decodeStill(canvas); } catch {} }
  const prevDraft = sheet.view === 'edit' ? sheet.draft : null;
  if (!state.settings.apiKey) {
    editFood({ ...(prevDraft || { name: '', brand: '' }), code: foundCode || '', source: 'label' }, { photo });
    sheet.error = 'Add a Claude API key in Settings to fill this in automatically — for now, copy the numbers from the photo.'; renderSheet();
    return;
  }
  setView('busy', { busyTitle: 'Reading the label', busyMsg: 'Claude is reading the nutrition panel…', photo });
  try {
    const v = await readLabel(photo);
    if (!sheet.open) return;
    const draft = { ...(prevDraft || {}), ...v, name: v.name || (prevDraft && prevDraft.name) || '', code: foundCode || '', source: 'label', fromLabel: true };
    if (foundCode) draft.key = foundCode;
    editFood(draft, { photo, backTo: 'tabs' });
  } catch (e) {
    if (!sheet.open) return;
    editFood({ ...(prevDraft || { name: '', brand: '' }), code: foundCode || '', source: 'label' }, { photo, backTo: 'tabs' });
    sheet.error = e.message; renderSheet();
  }
}

function readDraftFromForm() {
  const unit = $('#eUnit').value;
  const mac = (k, p, c, f) => {
    const m = { kcal: numOrNull($(k).value), p: numOrNull($(p).value), c: numOrNull($(c).value), f: numOrNull($(f).value) };
    if (![m.kcal, m.p, m.c, m.f].some(v => v != null)) return null;
    if (m.kcal == null) m.kcal = num(m.p) * 4 + num(m.c) * 4 + num(m.f) * 9;
    else if (unit === 'kj') m.kcal = m.kcal / KJ;
    return { kcal: r1(m.kcal), p: num(m.p), c: num(m.c), f: num(m.f) };
  };
  const code = $('#eCode').value.replace(/\D/g, '');
  return {
    ...sheet.draft,
    name: $('#eName').value.trim(), brand: $('#eBrand').value.trim(), code,
    servingG: numOrNull($('#eServG').value),
    perServe: mac('#sK', '#sP', '#sC', '#sF'), per100: mac('#hK', '#hP', '#hC', '#hF')
  };
}

function logFood() {
  const f = sheet.food, amt = num($('#amt').value);
  if (!amt) return toast('Enter an amount');
  if (sheet.mode === 'serves' && amt > 20 && !sheet.confirmBig) {
    sheet.confirmBig = true; setTimeout(() => { sheet.confirmBig = false; }, 4000);
    return toast(`${amt} serves? Switch to grams if you meant ${amt} g — or tap Add again to confirm.`);
  }
  sheet.confirmBig = false;
  const m = macrosFor(f, sheet.mode, amt);
  const saved = upsertFood(f); touchFood(saved.key);
  if (sheet.picking) {
    addIngredients([{ name: f.brand && !f.name.toLowerCase().includes(f.brand.toLowerCase()) ? `${f.name} (${f.brand})` : f.name,
      amount: amountLabel(f, sheet.mode, amt), foodKey: saved.key, kcal: r1(m.kcal), p: r1(m.p), c: r1(m.c), f: r1(m.f) }]);
    return;
  }
  const entry = { id: uid(), meal: sheet.meal, name: f.brand && !f.name.toLowerCase().includes(f.brand.toLowerCase()) ? `${f.name} (${f.brand})` : f.name,
    amount: amountLabel(f, sheet.mode, amt), foodKey: saved.key, kcal: r1(m.kcal), p: r1(m.p), c: r1(m.c), f: r1(m.f) };
  updateDay(d => ({ ...d, entries: [...d.entries, entry] }));
  closeSheet(); toast(`Added ${fmt(m.kcal)} kcal to ${sheet.meal.toLowerCase()}`);
}

async function runEstimate() {
  sheet.busy = true; sheet.error = ''; sheet.describeRes = []; renderSheet();
  try { sheet.describeRes = await describeMeal(sheet.describeText.trim(), sheet.mealPhoto); } catch (e) { sheet.error = e.message; }
  sheet.busy = false;
  if (sheet.open) { renderSheet(); const a = $('#aiEst'); if (a) a.scrollIntoView({ block: 'start' }); }
}
async function handleMealPhoto(file) {
  if (!file) return;
  if (!state.settings.apiKey) { toast('Add your Claude API key in Settings first'); return; }
  let canvas;
  try { canvas = await fileToCanvas(file, 1280); } catch (e) { toast(e.message); return; }
  if (!sheet.open) openSheet();
  sheet.mealPhoto = canvas.toDataURL('image/jpeg', 0.82);
  sheet.describeText = ''; sheet.view = 'tabs'; sheet.tab = 'quick';
  await runEstimate();
}

/* ================= events ================= */
function setDate(d) { state.date = d; state.day = loadDay(d); render(); }

document.addEventListener('click', async ev => {
  const el = ev.target.closest('[data-action]'); if (!el) return;
  const a = el.dataset.action;
  switch (a) {
    case 'prev': setDate(addDays(state.date, -1)); break;
    case 'next': setDate(addDays(state.date, 1)); break;
    case 'today': setDate(ymd(new Date())); break;
    case 'tab': state.tab = el.dataset.tab; render(); window.scrollTo(0, 0); break;
    case 'open-add': openSheet({ meal: el.dataset.meal || defaultMeal(), tab: 'foods' }); break;
    case 'close': closeSheet(); break;
    case 'back': setView(sheet.backTo === 'food' && sheet.food ? 'food' : 'tabs'); break;
    case 'meal': sheet.meal = el.dataset.meal; renderSheet(); break;
    case 'stab': sheet.tab = el.dataset.stab; sheet.error = ''; renderSheet(); break;
    case 'scan': Scanner.open(code => handleCode(code)); break;
    case 'scan-cancel': Scanner.close(); break;
    case 'label-photo': if (!sheet.open) openSheet(); $('#labelInput').value = ''; $('#labelInput').click(); break;
    case 'pick-food': { const f = state.foods[el.dataset.key]; if (f) showFood(f, 'tabs'); break; }
    case 'pick-result': { const f = sheet.results[+el.dataset.i]; if (f) showFood(state.foods[f.key] || f, 'tabs'); break; }
    case 'amode': {
      const f = sheet.food, prev = sheet.mode, amt = num($('#amt').value);
      sheet.mode = el.dataset.mode;
      sheet.amt = sheet.mode === 'grams' ? (f.servingG ? r0(f.servingG * (prev === 'serves' ? amt : 1)) : 100) : (f.servingG && prev === 'grams' ? r1(amt / f.servingG) : 1);
      renderSheet(); break;
    }
    case 'log-food': logFood(); break;
    case 'open-meal': openSheet({ meal: el.dataset.meal, view: 'meal' }); break;
    case 'meal-add': setView('tabs', { tab: 'foods' }); break;
    case 'set-theme': state.settings.theme = el.dataset.themeKey; saveSettings(); render(); break;
    case 'new-recipe': {
      const d = Store.get('recipeDraft');
      if (d && !d.key && (d.name || (d.ingredients || []).length)) { openRecipe(d); toast('Picking up your unsaved recipe'); }
      else { openRecipe({ name: '', servings: 4, cookedG: null, ingredients: [] }); }
      break;
    }
    case 'edit-recipe': { const f = state.foods[el.dataset.key]; if (f) openRecipe({ key: f.key, name: f.name, servings: f.servings, cookedG: f.cookedG, ingredients: [...(f.ingredients || [])] }); break; }
    case 'add-ing': setView('tabs', { picking: true, tab: 'foods', filter: '' }); break;
    case 'to-recipe': setView('recipe', { picking: false }); break;
    case 'rm-ing': sheet.recipe = { ...sheet.recipe, ingredients: sheet.recipe.ingredients.filter(e => e.id !== el.dataset.id) }; saveRecipeDraft(); renderSheet(); break;
    case 'save-recipe': {
      const r = sheet.recipe;
      if (!r.name.trim()) { sheet.error = 'Give the recipe a name.'; renderSheet(); return; }
      if (!(r.ingredients || []).length) { sheet.error = 'Add at least one ingredient.'; renderSheet(); return; }
      if (!(num(r.servings) > 0)) { sheet.error = 'Enter how many serves it makes.'; renderSheet(); return; }
      const saved = upsertFood({ ...recipeToFood(r), name: r.name.trim(), key: r.key || 'r-' + uid() });
      if (!r.key) Store.set('recipeDraft', null);
      toast('Recipe saved to My foods');
      if (state.tab === 'foods') render();
      showFood(saved, 'tabs'); break;
    }
    case 'edit-current': editFood(sheet.food, { backTo: 'food' }); break;
    case 'new-food': editFood({ name: '', brand: '', code: sheet.view === 'notfound' ? sheet.code : '', source: 'manual' }, { photo: null, backTo: 'tabs' }); break;
    case 'save-food': {
      const d = readDraftFromForm();
      if (!d.name) { sheet.error = 'Give it a name.'; renderSheet(); return; }
      if (!hasM(d.perServe) && !hasM(d.per100)) { sheet.error = 'Enter the values per serve or per 100 g.'; renderSheet(); return; }
      if (hasM(d.perServe) && !hasM(d.per100) && !d.servingG) { /* fine: serves only */ }
      if (d.key && d.code && d.key !== d.code && state.foods[d.key]) { delete state.foods[d.key]; d.key = d.code; }
      if (!d.key && d.code) d.key = d.code;
      delete d.fromLabel;
      if (d.source === 'off') d.source = 'off-edited';
      const saved = upsertFood(d);
      toast('Saved to My foods');
      if (state.tab === 'foods' && !sheet.food && sheet.backTo === 'tabs' && sheet.fromFoodsTab) { closeSheet(); render(); return; }
      showFood(saved, 'tabs'); break;
    }
    case 'quick-add': {
      const name = $('#qName').value.trim() || 'Quick add';
      const p = num($('#qP').value), c = num($('#qC').value), f = num($('#qF').value);
      const kcal = num($('#qK').value) || p * 4 + c * 4 + f * 9;
      if (!kcal) return toast('Enter calories or macros');
      if (sheet.picking) { addIngredients([{ name, kcal, p, c, f }]); break; }
      updateDay(d => ({ ...d, entries: [...d.entries, { id: uid(), meal: sheet.meal, name, kcal, p, c, f }] }));
      closeSheet(); toast('Added'); break;
    }
    case 'describe': {
      const t = $('#descText'); sheet.describeText = t ? t.value : '';
      if (!sheet.describeText.trim() && !sheet.mealPhoto) { sheet.error = 'Take a photo or describe what you ate first.'; renderSheet(); return; }
      await runEstimate(); break;
    }
    case 'meal-photo': if (!sheet.open) openSheet(); $('#mealPhotoInput').value = ''; $('#mealPhotoInput').click(); break;
    case 'meal-photo-clear': { const t = $('#descText'); sheet.describeText = t ? t.value : ''; sheet.mealPhoto = null; sheet.describeRes = []; renderSheet(); break; }
    case 'describe-add': {
      const items = $$('[data-dr]').filter(r => r.querySelector('.drk').checked).map(r => ({
        id: uid(), meal: sheet.meal, name: r.querySelector('.drn').value.trim() || 'Food',
        kcal: num(r.querySelector('.drkc').value), p: num(r.querySelector('.drp').value), c: num(r.querySelector('.drc').value), f: num(r.querySelector('.drf').value) }));
      if (!items.length) return toast('Nothing selected');
      if (sheet.picking) { sheet.describeText = ''; sheet.describeRes = []; sheet.mealPhoto = null; addIngredients(items.map(({ id, meal, ...rest }) => rest)); break; }
      updateDay(d => ({ ...d, entries: [...d.entries, ...items] }));
      sheet.describeText = ''; sheet.describeRes = []; sheet.mealPhoto = null; closeSheet(); toast(`Added ${items.length} item${items.length > 1 ? 's' : ''}`); break;
    }
    case 'del': updateDay(d => ({ ...d, entries: d.entries.filter(e => e.id !== el.dataset.id) })); if (sheet.open && sheet.view === 'meal') renderSheet(); break;
    case 'copy-yday': {
      const meal = el.dataset.meal, y = loadDay(addDays(state.date, -1));
      const es = (y.entries || []).filter(e => e.meal === meal);
      if (!es.length) return toast(`No ${meal.toLowerCase()} logged yesterday`);
      updateDay(d => ({ ...d, entries: [...d.entries, ...es.map(e => ({ ...e, id: uid() }))] }));
      toast(`Copied ${es.length} item${es.length > 1 ? 's' : ''}`); if (sheet.open && sheet.view === 'meal') renderSheet(); break;
    }
    case 'copy-summary': {
      const text = state.weekSummary || '';
      try { await navigator.clipboard.writeText(text); toast('Summary copied'); }
      catch { $('#copyFallback').innerHTML = `<textarea class="copybox" readonly>${esc(text)}</textarea>`; const t = $('#copyFallback textarea'); t.focus(); t.select(); }
      break;
    }
    case 'edit-food': { const f = state.foods[el.dataset.key]; if (f && f.source === 'recipe') { openRecipe({ key: f.key, name: f.name, servings: f.servings, cookedG: f.cookedG, ingredients: [...(f.ingredients || [])] }); break; } if (f) { openSheet(); editFood(f, { backTo: 'tabs', fromFoodsTab: true, food: null }); } break; }
    case 'del-food': {
      const f = state.foods[el.dataset.key]; if (!f) return;
      if (el.dataset.confirm !== '1') { el.dataset.confirm = '1'; el.textContent = 'Delete?'; el.style.width = 'auto'; el.style.color = 'var(--over)'; setTimeout(() => { if (el.isConnected) render(); }, 3000); return; }
      delete state.foods[f.key]; saveFoods(); render(); toast('Deleted'); break;
    }
    case 'fit-carbs': $('#tC').value = Math.max(0, r0((num($('#tK').value) - num($('#tP').value) * 4 - num($('#tF').value) * 9) / 4)); break;
    case 'save-targets':
      state.settings.targets = { kcal: r0($('#tK').value), p: r0($('#tP').value), c: r0($('#tC').value), f: r0($('#tF').value) };
      saveSettings(); render(); toast('Targets saved'); break;
    case 'save-key':
      state.settings.apiKey = $('#apiKey').value.trim(); state.settings.model = $('#apiModel').value.trim() || DEFAULT_SETTINGS.model;
      saveSettings(); toast(state.settings.apiKey ? 'Key saved on this phone' : 'Key removed'); break;
    case 'test-key': {
      state.settings.apiKey = $('#apiKey').value.trim(); state.settings.model = $('#apiModel').value.trim() || DEFAULT_SETTINGS.model;
      el.disabled = true; el.innerHTML = '<span class="spin"></span>Testing';
      try { await askClaude([{ type: 'text', text: 'Reply with only this JSON: {"ok":true}' }], 50); saveSettings(); toast('✓ Key works — saved'); }
      catch (e) { toast(e.message); }
      el.disabled = false; el.textContent = 'Test'; break;
    }
    case 'export': {
      const data = {}; for (const k of Store.keys()) data[k] = Store.get(k);
      if (data.settings) data.settings = { ...data.settings, apiKey: '' };
      const json = JSON.stringify({ app: 'fuel', version: 1, exported: new Date().toISOString(), data });
      const name = `fuel-backup-${ymd(new Date())}.json`;
      try {
        const file = new File([json], name, { type: 'application/json' });
        if (navigator.canShare && navigator.canShare({ files: [file] })) { await navigator.share({ files: [file], title: 'Fuel backup' }); break; }
      } catch (e) { if (e && e.name === 'AbortError') break; }
      const a2 = document.createElement('a'); a2.href = URL.createObjectURL(new Blob([json], { type: 'application/json' })); a2.download = name;
      document.body.appendChild(a2); a2.click(); a2.remove(); toast('Backup saved'); break;
    }
    case 'import': $('#importInput').value = ''; $('#importInput').click(); break;
  }
});

document.addEventListener('submit', async ev => {
  if (ev.target.id === 'manualCodeForm') {
    ev.preventDefault();
    const code = $('#manualCode').value.replace(/\D/g, '');
    if (code.length < 6) return toast('Type the numbers under the barcode');
    Scanner.close(); handleCode(code);
  }
  if (ev.target.id === 'searchForm') {
    ev.preventDefault();
    sheet.q = $('#searchQ').value.trim(); sheet.auOnly = $('#auOnly').checked;
    if (!sheet.q) return;
    if (/^\d{8,14}$/.test(sheet.q)) { handleCode(sheet.q); return; }
    sheet.busy = true; sheet.error = ''; sheet.results = []; renderSheet();
    try { sheet.results = await offSearch(sheet.q, sheet.auOnly); } catch (e) { sheet.error = navigator.onLine === false ? "You're offline." : e.message; }
    sheet.busy = false; sheet.searched = true; if (sheet.open) renderSheet();
  }
});

document.addEventListener('input', ev => {
  const t = ev.target;
  if (t.id === 'sheetFilter' || t.id === 'foodsTabFilter') {
    const pos = t.selectionStart;
    if (t.id === 'sheetFilter') { sheet.filter = t.value; renderSheet(); } else { state.foodsFilter = t.value; render(); }
    const n = $('#' + t.id); n.focus(); try { n.setSelectionRange(pos, pos); } catch {}
  }
  if (t.id === 'rName' || t.id === 'rServ' || t.id === 'rCooked') {
    const r = sheet.recipe;
    if (t.id === 'rName') r.name = t.value;
    if (t.id === 'rServ') r.servings = t.value;
    if (t.id === 'rCooked') r.cookedG = numOrNull(t.value);
    saveRecipeDraft();
    const g = $('#rgrid'); if (g) g.innerHTML = macGrid(recipeToFood(r).perServe);
  }
  if (t.id === 'amt') { sheet.amt = t.value; const g = $('#macgrid'); if (g) g.innerHTML = macGrid(macrosFor(sheet.food, sheet.mode, t.value)); }
});

document.addEventListener('change', async ev => {
  const t = ev.target;
  if (t.id === 'weightIn') {
    const w = t.value === '' ? null : r1(num(t.value));
    updateDay(d => ({ ...d, weight: w })); toast(w ? `Weight ${w} kg saved` : 'Weight cleared');
  }
  if (t.id === 'labelInput') handleLabelFile(t.files && t.files[0]);
  if (t.id === 'mealPhotoInput') handleMealPhoto(t.files && t.files[0]);
  if (t.id === 'importInput' && t.files && t.files[0]) {
    try {
      const j = JSON.parse(await t.files[0].text());
      if (j.app !== 'fuel' || !j.data) throw new Error('Not a Fuel backup');
      const key = state.settings.apiKey;
      for (const [k, v] of Object.entries(j.data)) {
        if (k === 'foods') Store.set('foods', { ...Store.get('foods', {}), ...v });
        else if (k === 'settings') Store.set('settings', { ...v, apiKey: key });
        else Store.set(k, v);
      }
      state.settings = { ...DEFAULT_SETTINGS, ...Store.get('settings', {}) }; state.foods = Store.get('foods', {}); state.day = loadDay(state.date);
      render(); toast('Backup imported');
    } catch (e) { toast("Couldn't import: " + e.message); }
  }
});

window.addEventListener('pagehide', () => Scanner.stop());
document.addEventListener('visibilitychange', () => { if (document.hidden && Scanner.stream) Scanner.close(); });

/* ================= start ================= */
render();
if ('serviceWorker' in navigator && location.protocol === 'https:') {
  navigator.serviceWorker.register('sw.js').catch(() => {});
}
