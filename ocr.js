// On-device recognition of the crew-portal monthly calendar (screenshot or image-only PDF).
// Layout-aware: find the 7-column grid, the coloured bars in each cell, then OCR one short
// line at a time with a restricted character set. Output uses the Fridge View line format
// ("KE331Z ICN 08:20 - PEK 09:45", "LO JFK", "T_DO", "T_STBY ICN 09:00 - ICN 19:00") so the
// app's existing parser and Show Up rules handle the rest. Everything stays in the browser.

const TESS = 'https://cdn.jsdelivr.net/npm/tesseract.js@5.1.1/dist/tesseract.min.js';
const MONTH = ['January','February','March','April','May','June','July','August','September','October','November','December'];
const MON3 = MONTH.map(m => m.slice(0, 3));
const p2 = n => String(n).padStart(2, '0');

let tessLoad = null;
function loadTesseract() {
  return tessLoad ||= new Promise((ok, no) => {
    if (window.Tesseract) return ok(window.Tesseract);
    const s = document.createElement('script'); s.src = TESS;
    s.onload = () => ok(window.Tesseract); s.onerror = () => no(new Error('OCR 엔진을 불러오지 못했습니다 (인터넷 연결 확인)'));
    document.head.appendChild(s);
  });
}

// ---------------------------------------------------------------- pixels
function toCanvas(img) {
  // work at a calendar width of ~1200 px
  const scale = Math.min(3, Math.max(0.6, 1200 / img.width));
  const c = document.createElement('canvas');
  c.width = Math.round(img.width * scale); c.height = Math.round(img.height * scale);
  const g = c.getContext('2d', { willReadFrequently: true });
  g.fillStyle = '#fff'; g.fillRect(0, 0, c.width, c.height);
  g.imageSmoothingQuality = 'high'; g.drawImage(img, 0, 0, c.width, c.height);
  return c;
}
function pixels(c) {
  const { data } = c.getContext('2d').getImageData(0, 0, c.width, c.height);
  const W = c.width, H = c.height;
  const at = (x, y) => { const i = 4 * (y * W + x); return [data[i], data[i + 1], data[i + 2]]; };
  return { W, H, data, at };
}
const sat = ([r, g, b]) => Math.max(r, g, b) - Math.min(r, g, b);
const lum = ([r, g, b]) => 0.299 * r + 0.587 * g + 0.114 * b;
const isBar = p => sat(p) > 70 || (sat(p) < 8 && lum(p) > 196 && lum(p) < 216);   // coloured bars + grey STBY bar
const isGrid = p => sat(p) < 8 && lum(p) >= 220 && lum(p) <= 244;                   // light grey cell borders

// ---------------------------------------------------------------- layout
function findLayout(P) {
  const { W, H, at } = P;
  // calendar top rule: the longest dark horizontal line
  let rule = null;
  for (let y = 0; y < H; y++) {
    let run = 0, best = 0, end = 0;
    for (let x = 0; x < W; x++) { if (lum(at(x, y)) < 110) { run++; if (run > best) { best = run; end = x; } } else run = 0; }
    if (best > W * 0.6 && (!rule || best > rule.len + 4)) rule = { y, len: best, x0: end - best + 1, x1: end };
    if (rule && y > rule.y + 6) break;
  }
  if (!rule) throw new Error('달력 머리선(연·월 아래 굵은 선)을 찾지 못했습니다');
  const { x0, x1 } = rule, colW = (x1 - x0) / 7;
  // horizontal grid lines: light grey continuously across the whole calendar width
  // (borders of the detail boxes inside cells stop at each column edge, so they fail this test)
  const lines = [];
  for (let y = rule.y + 4; y < H; y++) {
    let n = 0, g = 0;
    for (let x = x0 + 2; x < x1 - 2; x++) { n++; if (isGrid(at(x, y))) g++; }
    if (g / n > 0.9) { if (lines.length && y - lines[lines.length - 1].y1 <= 2) lines[lines.length - 1].y1 = y; else lines.push({ y0: y, y1: y }); }
  }
  // rows are the gaps between consecutive grid lines that are tall enough to be a week
  // week borders are 2-4 px thick; 1 px lines are borders of boxes inside cells
  const thick = lines.filter(l => l.y1 - l.y0 >= 1);
  const rows = [];
  for (let i = 0; i + 1 < thick.length; i++) {
    const top = thick[i].y1 + 1, bot = thick[i + 1].y0 - 1;
    if (bot - top > colW * 0.4) rows.push({ top, bot });
  }
  return { rule, x0, x1, colW, rows, lines };
}

// Choose week borders when the number of weeks is known: first and last candidate lines are the
// calendar's top and bottom; pick the interior lines with the largest total thickness (week borders
// are thicker than the borders of boxes inside cells) such that every week is tall enough.
function chooseRows(lines, nRows, colW) {
  if (lines.length < nRows + 1) return null;
  const first = lines[0], last = lines[lines.length - 1], mid = lines.slice(1, -1);
  const need = nRows - 1, minH = colW * 0.4;
  let best = null;
  const pick = (start, chosen) => {
    if (chosen.length === need) {
      const seq = [first, ...chosen, last];
      for (let i = 0; i + 1 < seq.length; i++) if (seq[i + 1].y0 - seq[i].y1 < minH) return;
      const score = chosen.reduce((s, l) => s + (l.y1 - l.y0 + 1), 0);
      if (!best || score > best.score) best = { score, seq };
      return;
    }
    for (let i = start; i < mid.length; i++) pick(i + 1, [...chosen, mid[i]]);
  };
  if (mid.length > 18) return null;
  pick(0, []);
  if (!best) return null;
  const rows = [];
  for (let i = 0; i + 1 < best.seq.length; i++) rows.push({ top: best.seq[i].y1 + 1, bot: best.seq[i + 1].y0 - 1 });
  return rows;
}

function findBars(P, L, r, c) {
  const { at } = P, { x0, colW } = L, { top, bot } = L.rows[r];
  const cx0 = Math.round(x0 + c * colW + colW * 0.08), cx1 = Math.round(x0 + (c + 1) * colW - colW * 0.08);
  const bars = [];
  for (let y = top; y <= bot; y++) {
    let n = 0, b = 0;
    for (let x = cx0; x < cx1; x += 2) { n++; if (isBar(at(x, y))) b++; }
    const on = b / n > 0.55;
    const last = bars[bars.length - 1];
    if (on) { if (last && y - last.y1 <= 1) last.y1 = y; else bars.push({ y0: y, y1: y }); }
  }
  // exact horizontal extent + colour of each bar
  return bars.filter(b => b.y1 - b.y0 >= colW * 0.06).map(b => {
    const ym = Math.round((b.y0 + b.y1) / 2);
    let bx0 = cx0, bx1 = cx1;
    while (bx0 > x0 + c * colW && isBar(at(bx0 - 1, ym))) bx0--;
    while (bx1 < x0 + (c + 1) * colW && isBar(at(bx1 + 1, ym))) bx1++;
    // average colour of the bar's inner area (edges are anti-aliased), nearest of the portal palette
    let r = 0, g = 0, bl = 0, n = 0;
    const iy0 = b.y0 + Math.ceil((b.y1 - b.y0) * 0.2), iy1 = b.y1 - Math.ceil((b.y1 - b.y0) * 0.2);
    for (let y = iy0; y <= iy1; y++) for (let x = Math.round(bx0 + (bx1 - bx0) * 0.05); x < bx0 + (bx1 - bx0) * 0.95; x++) {
      const q = at(x, y); if (!isBar(q)) continue;   // skip text pixels
      r += q[0]; g += q[1]; bl += q[2]; n++;
    }
    const avg = n ? [r / n, g / n, bl / n] : at(Math.round((bx0 + bx1) / 2), Math.round((b.y0 + b.y1) / 2));
    const PALETTE = { blue: [0, 130, 238], light: [87, 187, 235], olive: [175, 192, 11], grey: [208, 208, 208] };
    let kind = 'blue', bd = 1e9;
    for (const [k, c] of Object.entries(PALETTE)) { const d = Math.hypot(avg[0] - c[0], avg[1] - c[1], avg[2] - c[2]); if (d < bd) { bd = d; kind = k; } }
    return { ...b, x0: bx0, x1: bx1, kind, colorDist: Math.round(bd) };
  });
}

// crop a region to a clean black-on-white canvas, scaled up for OCR.
// Works for any colours: background = the most common colour in the region,
// ink = distance from that background (white text on blue, dark text on white or grey).
function crop(P, x0, y0, x1, y1, opt = {}) {
  const { at } = P, S = opt.S ?? 4, pad = 10, blur = opt.blur ?? 1, bin = opt.bin ?? 0;
  x0 = Math.round(x0); y0 = Math.round(y0); x1 = Math.round(x1); y1 = Math.round(y1);
  const w = Math.max(1, x1 - x0), h = Math.max(1, y1 - y0);
  const counts = new Map();
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) { const k = at(x0 + x, y0 + y).map(v => v >> 3).join(','); counts.set(k, (counts.get(k) || 0) + 1); }
  const bg = [...counts.entries()].sort((a, b) => b[1] - a[1])[0][0].split(',').map(v => (+v << 3) + 4);
  const dist = p => Math.hypot(p[0] - bg[0], p[1] - bg[1], p[2] - bg[2]);
  let maxD = 1;
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) maxD = Math.max(maxD, dist(at(x0 + x, y0 + y)));
  const c = document.createElement('canvas'); c.width = w * S + pad * 2; c.height = h * S + pad * 2;
  const g = c.getContext('2d'); g.fillStyle = '#fff'; g.fillRect(0, 0, c.width, c.height);
  const img = g.getImageData(0, 0, c.width, c.height), d = img.data;
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const k = Math.min(1, dist(at(x0 + x, y0 + y)) / (maxD * 0.75));
    const v = bin ? (k > bin ? 0 : 255) : Math.round(255 * (1 - k));
    for (let sy = 0; sy < S; sy++) for (let sx = 0; sx < S; sx++) {
      const i = 4 * ((pad + y * S + sy) * c.width + pad + x * S + sx); d[i] = d[i + 1] = d[i + 2] = v;
    }
  }
  g.putImageData(img, 0, 0);
  const c2 = document.createElement('canvas'); c2.width = c.width; c2.height = c.height;
  const g2 = c2.getContext('2d'); g2.fillStyle = '#fff'; g2.fillRect(0, 0, c2.width, c2.height); if (blur) g2.filter = `blur(${blur}px)`; g2.drawImage(c, 0, 0);
  return c2;
}

// ---------------------------------------------------------------- text normalisation
const fixTime = s => s.replace(/[Oo]/g, '0').replace(/[Il|]/g, '1').replace(/S/g, '5').replace(/B/g, '8').replace(/Z/g, '2');
function parseDetail(raw) {
  const t = raw.toUpperCase().replace(/[—–_~]/g, '-').replace(/\s+/g, ' ').trim();
  // airports at the start: "ICN -PEK" / "ICN AKL" / "JFK"
  const head = t.replace(/[^A-Z0-9 :-]/g, '').match(/^([A-Z0-9]{3})\s*-?\s*([A-Z0-9]{3}(?![0-9:]))?/);
  const toApt = x => x && x.replace(/0/g, 'O').replace(/1/g, 'I').replace(/5/g, 'S').replace(/8/g, 'B');
  const apts = head ? [toApt(head[1]), toApt(head[2])].filter(a => a && /^[A-Z]{3}$/.test(a)) : [];
  // times: everything after the airports; 4 digits without a colon count too ("2359")
  const rest = head ? t.replace(/[^A-Z0-9 :-]/g, '').slice(head[0].length) : t;
  const r2 = rest.replace(/[OD]/g, '0').replace(/[Il|]/g, '1').replace(/S/g, '5').replace(/B/g, '8').replace(/Z/g, '2');
  const times = [...r2.matchAll(/(\d{1,2})\s*[:.]?\s*(\d{2})(?!\d)/g)]
    .map(m => `${m[1].padStart(2, '0').slice(-2)}:${m[2]}`).filter(x => /^([01]\d|2[0-3]):[0-5]\d$/.test(x));
  const dash = r2.indexOf('-'), firstT = r2.search(/\d/);
  const colons = (rest.match(/:/g) || []).length;
  return { text: t, apts, times, colons, timeAfterDashOnly: times.length === 1 && dash >= 0 && firstT > dash };
}
const cleanCode = s => s.toUpperCase().replace(/\s+/g, '').replace(/[^A-Z0-9_]/g, '');
function fixFlightNo(s) {
  // two letter airline + digits (+ optional suffix letter)
  const m = s.match(/^([A-Z0-9]{2})([0-9OIlSBZ]{2,4})([A-Z]?)$/);
  return m ? m[1].replace(/0/g, 'O').replace(/1/g, 'I') + fixTime(m[2]) + m[3] : s;
}

// ---------------------------------------------------------------- main
export async function recognizeCalendar(imageBlob, onProgress = () => {}) {
  const img = await createImageBitmap(imageBlob);
  const cv = toCanvas(img), P = pixels(cv);
  onProgress('달력 구조 찾는 중…');
  const L = findLayout(P);
  const T = await loadTesseract();
  onProgress('OCR 엔진 준비 중…');
  const worker = await T.createWorker('eng');
  const read = async (canvas, whitelist) => {
    await worker.setParameters({ tessedit_pageseg_mode: '7', tessedit_char_whitelist: whitelist, preserve_interword_spaces: '1' });
    const { data } = await worker.recognize(canvas);
    return { text: data.text.trim(), conf: data.confidence };
  };
  // read the same crop at three magnifications and take the majority answer
  const VARIANTS = [{ S: 3, blur: 0.6 }, { S: 4, blur: 1 }, { S: 5, blur: 1 }];
  const vote = async (mk, wl, clean, key = t => t) => {
    const got = [];
    for (const o of VARIANTS) { const r = await read(mk(o), wl); got.push({ text: clean(r.text), conf: r.conf }); }
    const tally = new Map();
    for (const g of got) { const k = key(g.text); const t = tally.get(k) || { n: 0, conf: 0, g }; t.n++; t.conf += g.conf; if (g.conf > t.g.conf) t.g = g; tally.set(k, t); }
    const best = [...tally.values()].sort((a, b) => b.n - a.n || b.conf - a.conf)[0];
    return { text: best.g.text, conf: best.conf / best.n, agree: best.n };
  };
  try {
    // title "2026.12" just above the rule, left side
    const tTop = Math.max(0, L.rule.y - Math.round(L.colW * 0.32));
    const title = await read(crop(P, L.x0, tTop, Math.round(L.x0 + L.colW * 1.4), L.rule.y - 3), '0123456789.');
    const tm = title.text.replace(/\s/g, '').match(/(20\d\d)\.?(\d{1,2})/);
    const year = tm ? +tm[1] : null, month = tm && +tm[2] >= 1 && +tm[2] <= 12 ? +tm[2] : null;
    if (year && month) {
      const first = new Date(Date.UTC(year, month - 1, 1)).getUTCDay(), nDays = new Date(Date.UTC(year, month, 0)).getUTCDate();
      const nRows = Math.ceil((first + nDays) / 7);
      const rows = chooseRows(L.lines, nRows, L.colW);
      if (!rows) throw new Error(`달력 ${nRows}주 칸을 정확히 찾지 못했습니다`);
      L.rows = rows;
    } else if (L.rows.length < 4 || L.rows.length > 6) throw new Error('달력 칸(주 단위 줄)을 찾지 못했습니다');
    const cells = [];
    for (let r = 0; r < L.rows.length; r++) for (let c = 0; c < 7; c++) cells.push({ r, c, bars: findBars(P, L, r, c) });
    const total = cells.reduce((n, x) => n + x.bars.length, 0);
    let done = 0;
    for (const cell of cells) {
      for (const b of cell.bars) {
        onProgress(`글자 읽는 중… ${++done}/${total}`);
        const codeR = await vote(o => crop(P, b.x0 + 2, b.y0, b.x1 - 2, b.y1 + 1, o), 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789_', cleanCode);
        b.code = codeR.text; b.codeConf = codeR.conf; b.codeAgree = codeR.agree;
        // detail line: the bordered box right under the bar
        const dh = Math.round((b.y1 - b.y0 + 1) * 1.55);
        const next = cell.bars.find(o => o.y0 > b.y1);
        const dy1 = Math.min(L.rows[cell.r].bot, next ? next.y0 - 2 : b.y1 + dh + 2, b.y1 + dh + 2);
        const detR = await vote(o => crop(P, b.x0 + 3, b.y1 + 2, b.x1 - 3, dy1, o), 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789:- ',
          t => t.toUpperCase().replace(/\s+/g, ' ').trim(), t => t.replace(/\s+/g, ''));
        b.detail = detR.text; b.detailConf = detR.conf; b.detailAgree = detR.agree;
      }
    }
    return { year, month, titleRaw: title.text, layout: { rows: L.rows, lines: L.lines, colW: Math.round(L.colW), ruleY: L.rule.y }, cells };
  } finally { await worker.terminate(); }
}

// ---------------------------------------------------------------- correction rules
// duty codes seen on the portal; OCR text is snapped to the nearest one when it is close
const KNOWN_CODES = ['T_DO', 'T_STBY', 'T_NDUTY', 'ATDO', 'STBY', 'DO', 'LO', 'ALV', 'ALM', 'AL', 'RESERVE', 'RSV', 'T_RSV', 'OFF', 'VAC', 'T_TRN', 'TRN', 'SIM', 'T_EDU', 'EDU', 'MED', 'SICK'];
const LOOKS = { '1': 'TIL', '7': 'TZ', '0': 'ODQ', '2': 'Z', '5': 'S', '8': 'B', '6': 'G' };
function codeDistance(a, b) {                       // edit distance, cheap for look-alike characters
  const m = a.length, n = b.length, D = Array.from({ length: m + 1 }, () => Array(n + 1).fill(0));
  const ins = ch => ch === '_' ? 0.4 : 1;
  for (let i = 1; i <= m; i++) D[i][0] = D[i - 1][0] + ins(a[i - 1]);
  for (let j = 1; j <= n; j++) D[0][j] = D[0][j - 1] + ins(b[j - 1]);
  for (let i = 1; i <= m; i++) for (let j = 1; j <= n; j++) {
    const x = a[i - 1], y = b[j - 1];
    const sub = x === y ? 0 : ((LOOKS[x] || '').includes(y) || (LOOKS[y] || '').includes(x)) ? 0.3 : 1;
    D[i][j] = Math.min(D[i - 1][j - 1] + sub, D[i - 1][j] + ins(x), D[i][j - 1] + ins(y));
  }
  return D[m][n];
}
function snapCode(raw) {
  if (!raw) return { code: '', sure: false };
  let best = null, bd = 9;
  for (const k of KNOWN_CODES) { const d = codeDistance(raw, k); if (d < bd) { bd = d; best = k; } }
  if (bd === 0) return { code: best, sure: true };
  if (bd <= 1.5) return { code: best, sure: bd <= 1, fixed: true };
  return { code: raw, sure: false };
}
// flight number: two-letter airline + digits (+ suffix letter). O/D/Q after the airline are zeros.
function flightCandidates(raw) {
  const m = raw.match(/^([A-Z]{2})([0-9ODQIlSBZG]{3,4})([A-Z]?)$/);
  if (!m) return null;
  const digits = m[2].replace(/[ODQ]/g, '0').replace(/[Il]/g, '1').replace(/S/g, '5').replace(/B/g, '8').replace(/G/g, '6');
  const plain = digits.replace(/Z/g, '2');
  const c = [m[1] + plain + m[3]];
  // the suffix Z is easily read as 2 or 7 in small screenshots
  if (!m[3] && plain.length === 4 && /[27Z]$/.test(digits)) c.push(m[1] + plain.slice(0, 3) + 'Z');
  if (m[3] === 'Z' && plain.length === 3) c.push(m[1] + plain + '2');
  return c;
}
const fnum = f => { const m = f.match(/^[A-Z]{2}0*(\d+)([A-Z]?)$/); return m ? { n: +m[1], s: m[2] } : null; };

let KNOWN_APTS = null;
export function setKnownAirports(list) { KNOWN_APTS = new Set(list); }

// cells -> Fridge-View-style lines (+ list of things a person must check)
export function cellsToLines(res, year, month) {
  const issues = [];
  const first = new Date(Date.UTC(year, month - 1, 1)).getUTCDay();          // 0 = Sunday column
  const nDays = new Date(Date.UTC(year, month, 0)).getUTCDate();
  const items = [];                                                          // in calendar order
  for (const cell of [...res.cells].sort((a, b) => a.r - b.r || a.c - b.c)) {
    const day = cell.r * 7 + cell.c - first + 1;
    if (day < 1 || day > nDays) continue;                                    // other month's cells
    for (const b of cell.bars) {
      const d = parseDetail(b.detail || '');
      const it = { day, raw: b.code, d, kind: b.kind, flags: [] };
      if (b.detail && b.detailConf < 55) it.flags.push('글자 흐림');
      if (b.kind !== 'light' && (b.codeAgree < 2 || (b.detail && b.detailAgree < 2))) it.flags.push('읽기 불확실');
      const cands = flightCandidates(b.code || '');
      if (b.kind === 'light') it.type = 'LO';
      else if (cands && d.apts.length >= 2) { it.type = 'FLT'; it.cands = cands; }
      else {
        it.type = 'CODE';
        const sc = snapCode(b.code || '');
        it.code = sc.code;
        if (!sc.sure) it.flags.push(sc.code ? '코드 확인' : '코드 못 읽음');
      }
      items.push(it);
    }
  }
  // resolve 2/Z: pick the reading that makes neighbouring sectors consecutive numbers (outbound/return)
  const flts = items.filter(i => i.type === 'FLT');
  flts.forEach((f, k) => {
    if (f.cands.length === 1) { f.no = f.cands[0]; return; }
    const nb = [flts[k - 1], flts[k + 1]].filter(Boolean);
    const score = c => {
      const a = fnum(c); let s = 0;
      for (const o of nb) for (const oc of o.cands) {
        const b = fnum(oc);
        if (a && b && a.s === b.s && Math.abs(a.n - b.n) === 1) s++;
        if (oc === c) s += 0.5;
      }
      return s;
    };
    const ranked = f.cands.map(c => [c, score(c)]).sort((x, y) => y[1] - x[1]);
    f.no = ranked[0][0];
    if (ranked[0][1] === ranked[1][1]) f.flags.push(`편명 확인 (${f.cands.join(' / ')})`);
  });
  // an overnight flight shows as two halves: departure-only on one day, arrival-only on the next.
  // Pair them: same route on consecutive days, one time each. That fixes which time is which
  // and gives both halves the same number. A single-time flight without its other half is flagged.
  const half = f => f.d.times.length === 1;
  flts.forEach((f, k) => {
    const g = flts[k + 1];
    if (g && half(f) && half(g) && g.day === f.day + 1 && g.d.apts[0] === f.d.apts[0] && g.d.apts[1] === f.d.apts[1]) {
      f.role = 'dep'; g.role = 'arr';
      if (g.cands.includes(f.no) || f.cands.includes(g.no)) { g.no = f.no; g.flags = g.flags.filter(x => !x.startsWith('편명')); }
    }
  });
  flts.forEach(f => { if (half(f) && !f.role) f.flags.push('출도착 확인'); });

  const byDay = {};
  for (const it of items) {
    const { d } = it; let line;
    if (it.type === 'LO') line = `LO ${d.apts[0] || '???'}`;
    else if (it.type === 'FLT') {
      const [dep, arr] = d.apts;
      if (dep === arr) it.flags.push('공항 확인');
      if (d.colons > d.times.length) it.flags.push('시간 확인');
      if (d.times.length >= 2) { const m = t => +t.slice(0, 2) * 60 + +t.slice(3);
        const span = (m(d.times[1]) - m(d.times[0]) + 1440) % 1440; if (span < 20) it.flags.push('시간 확인'); }
      if (d.times.length >= 2) line = `${it.no} ${dep} ${d.times[0]} - ${arr} ${d.times[1]}`;
      else if (d.times.length === 1 && (it.role ? it.role === 'arr' : d.timeAfterDashOnly)) line = `${it.no} ${dep} - ${arr} ${d.times[0]}`;
      else if (d.times.length === 1) line = `${it.no} ${dep} ${d.times[0]} - ${arr}`;
      else { line = `${it.no} ${dep} - ${arr}`; it.flags.push('시간 못 읽음'); }
    } else {
      const whole = d.times.length === 2 && d.times[0] === '00:00' && d.times[1] === '23:59';
      const ap = d.apts[0] || 'ICN';
      if (d.colons > d.times.length) it.flags.push('시간 확인');
      line = d.times.length === 2 && !whole ? `${it.code} ${ap} ${d.times[0]} - ${ap} ${d.times[1]}` : (it.code || '??');
    }
    if (KNOWN_APTS && it.type !== 'CODE') for (const ap of d.apts.slice(0, it.type === 'LO' ? 1 : 2)) if (!KNOWN_APTS.has(ap)) { it.flags.push(`공항 ${ap} 확인`); break; }
    if (/\?\?/.test(line) && !it.flags.length) it.flags.push('못 읽음');
    if (it.type === 'LO' && !d.apts.length) it.flags.push('공항 못 읽음');
    if (it.flags.length) issues.push({ day: it.day, line, why: it.flags.join(', ') });
    (byDay[it.day] ||= []).push(line);
  }
  const lines = [];
  for (let d = 1; d <= nDays; d++) if (byDay[d]) { lines.push(`${MON3[month - 1]} ${p2(d)}`); lines.push(...byDay[d]); }
  return { lines, issues, header: `${MONTH[month - 1]} ${year}` };
}

// exposed for tuning/tests
export const _internal = { toCanvas, pixels, findLayout, chooseRows, findBars, crop, loadTesseract };
