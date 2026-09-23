'use strict';
/*
 * STOCK 웹 대시보드 (조회 전용)
 * - config.json 에 적힌 GitHub 저장소의 data 브랜치에서 암호화된 snapshot.json 을 받습니다.
 * - 비밀번호 -> PBKDF2-SHA256 -> AES-256-GCM 키 (Web Crypto). 비밀번호는 어디에도 보내지 않습니다.
 * - 화면에 넣는 모든 글자는 textContent 로만 넣습니다.
 */
(() => {
  const FORMAT = 'stock-web-v1';
  const POLL_MS = 120000;
  const REMEMBER_DAYS = 30;
  const SVG = 'http://www.w3.org/2000/svg';
  const enc = new TextEncoder();

  const S = {
    cfg: null, key: null, salt: null, iv: null, data: null, lastFetch: 0,
    tab: 'home', perfMarket: 'KR', paperPick: '', logDate: null, logFilter: 'all', logQuery: '', tradeQuery: '',
    tradeLimit: 60, busy: false, width: 0,
    pick: null,          // 'KR:005930' - 고른 종목
    sub: 'chart',        // 차트 아래 탭: chart | rule | trade | data
  };

  // ------------------------------------------------------------------ DOM 도우미
  const $ = (sel, root = document) => root.querySelector(sel);
  // 자식 붙이기. null·undefined·false 는 '없음' 이므로 건너뜁니다.
  //
  // DOM 의 append() 는 null 을 **문자열 "null" 로 바꿔서** 넣습니다.
  // '조건이 맞을 때만 칩을 붙인다' 같은 코드(`cond ? chip(..) : null`)가
  // 아주 흔한데, 그 null 이 그대로 append 되면 화면에 '대한항공null' 이
  // 찍힙니다. 실제로 순위표와 매도규칙 탭에서 그렇게 나왔습니다.
  // 붙이는 곳은 전부 이 함수를 거치게 해서 한 군데서 막습니다.
  function put(node, ...children) {
    for (const child of children.flat()) {
      if (child === null || child === undefined || child === false) continue;
      node.append(child instanceof Node ? child : document.createTextNode(String(child)));
    }
    return node;
  }
  function el(tag, props = {}, ...children) {
    const node = document.createElement(tag);
    for (const [k, v] of Object.entries(props || {})) {
      if (v === null || v === undefined || v === false) continue;
      if (k === 'class') node.className = v;
      else if (k === 'text') node.textContent = v;
      else if (k === 'style') node.style.cssText = v;          // CSP: style 속성 대신 CSSOM
      else if (k.startsWith('on')) node.addEventListener(k.slice(2).toLowerCase(), v);
      else node.setAttribute(k, v === true ? '' : v);
    }
    return put(node, ...children);
  }
  function svg(tag, attrs = {}, text) {
    const node = document.createElementNS(SVG, tag);
    for (const [k, v] of Object.entries(attrs)) {
      if (v === null || v === undefined) continue;
      if (k === 'style') node.style.cssText = v; else node.setAttribute(k, v);
    }
    if (text !== undefined) node.textContent = text;
    return node;
  }
  const css = (name) => getComputedStyle(document.documentElement).getPropertyValue(name).trim();

  // ------------------------------------------------------------------ 숫자 표시
  const isNum = (v) => typeof v === 'number' && Number.isFinite(v);
  const sign = (v) => (isNum(v) && v > 0 ? '+' : '');
  const cls = (v) => (isNum(v) ? (v > 0 ? 'up' : v < 0 ? 'down' : '') : '');
  const krw = (v) => (isNum(v) ? `${Math.round(v).toLocaleString('ko-KR')}원` : '—');
  const krwS = (v) => (isNum(v) ? `${sign(v)}${Math.round(v).toLocaleString('ko-KR')}원` : '—');
  const usd = (v, d = 2) => (isNum(v) ? `${v < 0 ? '-' : ''}$${Math.abs(v).toLocaleString('en-US', { minimumFractionDigits: d, maximumFractionDigits: d })}` : '—');
  const usdS = (v) => (isNum(v) ? `${sign(v)}${usd(v)}` : '—');
  const pct = (v, d = 2) => (isNum(v) ? `${sign(v)}${v.toFixed(d)}%` : '—');
  const price = (v, market) => (market === 'US' ? usd(v) : isNum(v) ? Math.round(v).toLocaleString('ko-KR') : '—');
  // step 을 주면 눈금 간격에 맞춰 소수 자리를 정합니다(148만·148만 처럼 겹쳐 보이지 않게).
  function compact(v, currency, step = 0) {
    if (!isNum(v)) return '';
    if (currency === 'USD') return `${v < 0 ? '-' : ''}$${Math.abs(v) >= 1000 ? (Math.abs(v) / 1000).toFixed(1) + 'K' : Math.abs(v).toFixed(Math.abs(v) < 10 ? 2 : 0)}`;
    const a = Math.abs(v);
    const s = v < 0 ? '-' : '';
    const digits = (unit) => (step > 0 && step < unit ? Math.min(2, Math.max(0, Math.ceil(Math.log10(unit / step)))) : 0);
    if (a >= 1e8) return `${s}${(a / 1e8).toFixed(step ? digits(1e8) : a >= 1e9 ? 0 : 1)}억`;
    if (a >= 1e4) return `${s}${(a / 1e4).toLocaleString('ko-KR', { maximumFractionDigits: digits(1e4) })}만`;
    return `${s}${Math.round(a).toLocaleString('ko-KR')}`;
  }
  const money = (v, currency, signed = false) => (currency === 'USD' ? (signed ? usdS(v) : usd(v)) : signed ? krwS(v) : krw(v));
  function kstNow() {
    const parts = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Seoul', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false }).formatToParts(new Date());
    const get = (t) => parts.find((p) => p.type === t).value;
    return { date: `${get('year')}-${get('month')}-${get('day')}`, hm: `${get('hour') === '24' ? '00' : get('hour')}:${get('minute')}` };
  }
  function ago(iso) {
    const t = Date.parse(iso);
    if (!Number.isFinite(t)) return { text: '시각 모름', minutes: Infinity };
    const minutes = Math.max(0, Math.round((Date.now() - t) / 60000));
    const text = minutes < 1 ? '방금' : minutes < 60 ? `${minutes}분 전` : minutes < 1440 ? `${Math.floor(minutes / 60)}시간 전` : `${Math.floor(minutes / 1440)}일 전`;
    return { text, minutes };
  }

  // ------------------------------------------------------------------ 암호
  const b64 = (text) => Uint8Array.from(atob(text), (c) => c.charCodeAt(0));
  async function deriveKey(password, envelope) {
    const kdf = envelope.kdf || {};
    if (kdf.name !== 'PBKDF2' || kdf.hash !== 'SHA-256' || !(kdf.iterations >= 100000)) throw new Error('FORMAT');
    const base = await crypto.subtle.importKey('raw', enc.encode(password), 'PBKDF2', false, ['deriveKey']);
    return crypto.subtle.deriveKey({ name: 'PBKDF2', hash: 'SHA-256', salt: b64(kdf.salt), iterations: kdf.iterations },
      base, { name: 'AES-GCM', length: 256 }, false, ['decrypt']);
  }
  async function decrypt(envelope, key) {
    if (!envelope || envelope.format !== FORMAT) throw new Error('FORMAT');
    let plain;
    try {
      plain = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: b64(envelope.iv), additionalData: enc.encode(FORMAT) }, key, b64(envelope.data));
    } catch (e) {
      throw new Error('KEY');
    }
    if (typeof DecompressionStream === 'undefined') throw new Error('BROWSER');
    try {
      const stream = new Blob([plain]).stream().pipeThrough(new DecompressionStream('gzip'));
      return JSON.parse(await new Response(stream).text());
    } catch (e) { throw new Error('DATA'); }
  }

  // ------------------------------------------------------------------ 기억 (IndexedDB, 키는 꺼낼 수 없는 형태)
  function idb() {
    return new Promise((resolve, reject) => {
      if (!('indexedDB' in window)) return reject(new Error('no idb'));
      const req = indexedDB.open('stock-web', 1);
      req.onupgradeneeded = () => req.result.createObjectStore('keys');
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  }
  async function idbDo(mode, fn) {
    try {
      const db = await idb();
      return await new Promise((resolve, reject) => {
        const tx = db.transaction('keys', mode);
        const req = fn(tx.objectStore('keys'));
        tx.oncomplete = () => resolve(req && req.result);
        tx.onerror = () => reject(tx.error);
      });
    } catch (e) {
      return undefined;
    }
  }
  const remember = (value) => idbDo('readwrite', (st) => st.put(value, 'view'));
  const recall = () => idbDo('readonly', (st) => st.get('view'));
  const forget = () => idbDo('readwrite', (st) => st.delete('view'));

  // ------------------------------------------------------------------ 자료 받기
  async function loadConfig() {
    const r = await fetch('config.json', { cache: 'no-cache' });
    if (!r.ok) throw new Error('CONFIG');
    const cfg = await r.json();
    const ok = (v) => typeof v === 'string' && /^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/.test(v);
    if (!ok(cfg.owner) || !ok(cfg.repo) || !ok(cfg.branch) || !/^[A-Za-z0-9._-]+$/.test(cfg.path)) throw new Error('CONFIG');
    return cfg;
  }
  async function fetchEnvelope() {
    const { owner, repo, branch, path } = S.cfg;
    const api = `https://api.github.com/repos/${owner}/${repo}/contents/${path}?ref=${encodeURIComponent(branch)}`;
    let notFound = false;
    try {
      const r = await fetch(api, { cache: 'no-cache', headers: { Accept: 'application/vnd.github.raw+json' } });
      if (r.ok) return await r.json();
      notFound = r.status === 404;
    } catch (e) { /* 아래 예비 주소로 */ }
    const raw = `https://raw.githubusercontent.com/${owner}/${repo}/${encodeURIComponent(branch)}/${path}?t=${Date.now()}`;
    const r = await fetch(raw, { cache: 'no-store' });
    if (r.ok) return r.json();
    throw new Error(notFound || r.status === 404 ? 'NODATA' : 'NETWORK');
  }
  const errorText = (e) => ({
    DATA: '비밀번호 확인은 완료됐지만 게시 자료가 손상되었습니다. PC 프로그램에서 자료를 다시 발행해주세요.',
    KEY: '비밀번호가 틀렸습니다.',
    NODATA: '아직 올라온 자료가 없습니다. PC 프로그램의 웹 대시보드 설정에서 [지금 발행]을 눌러주세요.',
    NETWORK: '자료를 받지 못했습니다. 인터넷 연결을 확인하고 잠시 뒤 다시 시도하세요.',
    CONFIG: '페이지 설정(config.json)을 읽지 못했습니다. PC 프로그램에서 [페이지 올리기]를 다시 눌러주세요.',
    FORMAT: '자료 형식이 이 페이지와 맞지 않습니다. PC 프로그램에서 [페이지 올리기]를 다시 눌러주세요.',
    BROWSER: '이 브라우저는 압축 해제를 지원하지 않습니다. 최신 Chrome·Safari·Edge 로 열어주세요.',
  }[e && e.message] || '열지 못했습니다. 잠시 뒤 다시 시도하세요.');

  // ------------------------------------------------------------------ 로그인·잠금
  function showLogin(message = '') {
    S.key = null; S.data = null; S.iv = null;
    $('#app').hidden = true;
    $('#login').hidden = false;
    $('#cells').replaceChildren();
    $('#rowhead').replaceChildren();
    $('#login-message').textContent = message;
    $('#password').value = '';
    setTimeout(() => $('#password').focus(), 50);
  }
  async function onLogin(event) {
    event.preventDefault();
    const button = $('#login-button');
    const message = $('#login-message');
    const password = $('#password').value;
    if (!password) return;
    button.disabled = true;
    message.style.color = 'var(--ink-2)';
    message.textContent = '여는 중입니다… (처음에는 몇 초 걸립니다)';
    try {
      S.cfg = S.cfg || await loadConfig();
      const envelope = await fetchEnvelope();
      const key = await deriveKey(password, envelope);
      const data = await decrypt(envelope, key);
      S.key = key; S.salt = envelope.kdf.salt;
      if ($('#remember').checked) {
        await remember({ key, salt: S.salt, expires: Date.now() + REMEMBER_DAYS * 86400000 });
      } else {
        await forget();
      }
      $('#password').value = '';
      accept(envelope, data);
    } catch (e) {
      message.style.color = '';
      message.textContent = errorText(e);
    } finally {
      button.disabled = false;
    }
  }
  function accept(envelope, data) {
    S.iv = envelope.iv; S.data = data; S.lastFetch = Date.now();
    $('#login').hidden = true;
    $('#app').hidden = false;
    render();
  }
  async function lock() {
    await forget();
    showLogin('잠갔습니다.');
  }
  async function refresh(force = false) {
    if (!S.key || S.busy) return;
    S.busy = true;
    $('#stamp').classList.add('loading');
    try {
      const envelope = await fetchEnvelope();
      S.lastFetch = Date.now();
      if (envelope.kdf && envelope.kdf.salt !== S.salt) {
        await forget();
        showLogin('확인용 비밀번호가 바뀌었습니다. 새 비밀번호를 입력하세요.');
        return;
      }
      if (envelope.iv !== S.iv || force) {
        const data = await decrypt(envelope, S.key);
        S.iv = envelope.iv; S.data = data;
        render(true);
      } else {
        updateStamp();
      }
    } catch (e) {
      if (e.message === 'KEY') { await forget(); showLogin('비밀번호가 바뀌었습니다. 다시 입력하세요.'); return; }
      $('#stamp-text').textContent = '갱신 실패 · 다시 시도';
    } finally {
      S.busy = false;
      $('#stamp').classList.remove('loading');
    }
  }

  // ------------------------------------------------------------------ 공통 표시
  function updateStamp() {
    const d = S.data;
    if (!d) return;
    const { text, minutes } = ago(d.generated_at);
    const interval = Math.max(1, Math.round((d.interval_sec || 300) / 60));
    const staleAt = interval * 3;
    const stamp = $('#stamp');
    stamp.classList.toggle('stale', minutes > staleAt && minutes <= 60);
    stamp.classList.toggle('dead', minutes > 60);
    const hm = (d.generated_at || '').slice(11, 16);
    $('#stamp-text').textContent = `${hm} · ${text}`;
    const banner = $('#stale');
    if (minutes > staleAt) {
      banner.hidden = false;
      banner.textContent = `마지막 자료가 ${text} 것입니다. PC 프로그램이 꺼져 있거나 인터넷·업로드가 멈췄을 수 있습니다. (평소 ${interval}분마다 갱신)`;
    } else {
      banner.hidden = true;
    }
  }
  function card(title, sub, ...body) {
    return el('article', { class: 'card' }, el('div', { class: 'card-head' }, el('h2', { text: title }), sub ? el('span', { class: 'sub', text: sub }) : null), ...body);
  }
  // 진입 방식 이름에서 지지선만 뽑습니다. 어느 선을 보고 있는지가 핵심입니다.
  //   '5분봉 반등·지지 (60일선)' -> '60일선'   '20일선 회복' -> '20일선'
  //   '5분봉 반등·지지'          -> '10일선'   (기본 지지선)
  function supportChip(mode) {
    const found = /(\d+)일선/.exec(String(mode || ''));
    if (found) return `${found[1]}일선`;
    return String(mode || '').includes('5분봉') ? '10일선' : '5일선';
  }
  const empty = (text = '없음') => el('div', { class: 'empty', text });
  function tile(label, value, sub, tone = '') {
    return el('div', { class: 'tile' }, el('div', { class: 'label', text: label }), el('div', { class: `value num ${tone}`, text: value, title: value }),
      sub ? el('div', { class: 'delta muted', text: sub }) : null);
  }
  function missing(name) {
    return card(name, null, empty('이 자료를 만들지 못했습니다. 다음 갱신 때 다시 시도합니다.'));
  }

  // ------------------------------------------------------------------ 툴팁
  const tip = $('#tooltip');
  function showTip(event, strong, sub) {
    tip.replaceChildren();
    put(tip, el('strong', { class: 'num', text: strong }), sub ? el('span', { text: sub }) : null);
    tip.hidden = false;
    const x = event.clientX, y = event.clientY;
    const w = tip.offsetWidth, h = tip.offsetHeight;
    tip.style.left = `${Math.min(window.innerWidth - w - 8, Math.max(8, x + 12))}px`;
    tip.style.top = `${y - h - 12 < 8 ? y + 16 : y - h - 12}px`;
  }
  const hideTip = () => { tip.hidden = true; };

  // ------------------------------------------------------------------ 차트
  function niceTicks(min, max, count = 4) {
    if (min === max) { min -= 1; max += 1; }
    const span = max - min;
    const step0 = span / count;
    const mag = Math.pow(10, Math.floor(Math.log10(step0)));
    const step = [1, 2, 2.5, 5, 10].map((m) => m * mag).find((s) => s >= step0) || mag * 10;
    const lo = Math.floor(min / step) * step;
    const hi = Math.ceil(max / step) * step;
    const ticks = [];
    for (let v = lo; v <= hi + step / 2; v += step) ticks.push(Math.abs(v) < step / 1e6 ? 0 : v);
    return ticks;
  }
  function chartWidth(host) {
    return Math.max(280, Math.floor(host.clientWidth || (S.width - 64) || 600));
  }
  function lineChart(host, points, { currency, height = 200, area = true, zero = false, kind = 'series', label = '' } = {}) {
    host.replaceChildren();
    const pts = points.filter((p) => isNum(p.y));
    if (pts.length < 2) { host.append(empty('그래프를 그릴 자료가 아직 부족합니다')); return; }
    const W = chartWidth(host), H = height, L = 52, R = 14, T = 10, B = 24;
    const ys = pts.map((p) => p.y);
    let min = Math.min(...ys), max = Math.max(...ys);
    if (zero) { min = Math.min(0, min); max = Math.max(0, max); }
    const ticks = niceTicks(min, max);
    min = ticks[0]; max = ticks[ticks.length - 1];
    const x = (i) => L + (i * (W - L - R)) / (pts.length - 1);
    const y = (v) => T + ((max - v) * (H - T - B)) / (max - min || 1);
    const root = svg('svg', { viewBox: `0 0 ${W} ${H}`, role: 'img', 'aria-label': label });
    for (const t of ticks) {
      root.append(svg('line', { x1: L, x2: W - R, y1: y(t), y2: y(t), class: t === 0 && zero ? 'axis-line' : 'grid-line' }));
      root.append(svg('text', { x: L - 8, y: y(t) + 4, 'text-anchor': 'end' },
        compact(t, currency, ticks.length > 1 ? Math.abs(ticks[1] - ticks[0]) : 0)));
    }
    const idx = [0, Math.floor((pts.length - 1) / 2), pts.length - 1];
    [...new Set(idx)].forEach((i, n) => root.append(svg('text', { x: x(i), y: H - 6, 'text-anchor': n === 0 ? 'start' : n === 2 ? 'end' : 'middle' }, String(pts[i].x).slice(5))));
    const d = pts.map((p, i) => `${i ? 'L' : 'M'}${x(i).toFixed(1)},${y(p.y).toFixed(1)}`).join('');
    if (area) {
      const base = zero ? y(0) : H - B;
      root.append(svg('path', { d: `${d}L${x(pts.length - 1).toFixed(1)},${base}L${L},${base}Z`, class: kind === 'dd' ? 'dd-area' : 'area' }));
    }
    root.append(svg('path', { d, class: kind === 'dd' ? 'dd-line' : 'series' }));
    const last = pts.length - 1;
    root.append(svg('circle', { cx: x(last), cy: y(pts[last].y), r: 4, class: 'end-dot', fill: kind === 'dd' ? css('--down') : css('--accent') }));
    const cross = svg('line', { x1: 0, x2: 0, y1: T, y2: H - B, class: 'cross', visibility: 'hidden' });
    const dot = svg('circle', { r: 4, class: 'end-dot', fill: kind === 'dd' ? css('--down') : css('--accent'), visibility: 'hidden' });
    const hit = svg('rect', { x: L, y: 0, width: W - L - R, height: H, class: 'hit' });
    root.append(cross, dot, hit);
    const move = (ev) => {
      const box = root.getBoundingClientRect();
      const px = ((ev.clientX - box.left) * W) / box.width;
      const i = Math.max(0, Math.min(last, Math.round(((px - L) * last) / (W - L - R))));
      cross.setAttribute('x1', x(i)); cross.setAttribute('x2', x(i)); cross.setAttribute('visibility', 'visible');
      dot.setAttribute('cx', x(i)); dot.setAttribute('cy', y(pts[i].y)); dot.setAttribute('visibility', 'visible');
      showTip(ev, money(pts[i].y, currency, zero), `${pts[i].x}${label ? ' · ' + label : ''}`);
    };
    hit.addEventListener('pointermove', move);
    hit.addEventListener('pointerdown', move);
    hit.addEventListener('pointerleave', () => { cross.setAttribute('visibility', 'hidden'); dot.setAttribute('visibility', 'hidden'); hideTip(); });
    host.append(root);
  }
  // 일봉 캔들 + 거래량 + 이동평균. bars = [[날짜, 시, 고, 저, 종, 거래량], ...]
  function candleChart(host, bars, { market = 'KR', avg = null, height = 260, label = '' } = {}) {
    host.replaceChildren();
    let rows = (bars || []).filter((b) => isNum(b[4]) && b[4] > 0);
    if (rows.length < 5) { host.append(empty('일봉이 아직 쌓이지 않았습니다. 채점이 한 번 돌면 보입니다.')); return; }
    // 좁은 화면에서는 봉이 너무 얇아져 최근 것만 보여 줍니다(이동평균은 잘린 구간부터 계산).
    if (window.innerWidth < 720 && rows.length > 70) rows = rows.slice(-70);
    const W = chartWidth(host), H = height, L = 8, R = 56, T = 8, GAP = 8;
    const volH = Math.round((H - T - 18) * 0.22);
    const priceH = H - T - 18 - volH - GAP;
    const highs = rows.map((b) => b[2]).filter(isNum);
    const lows = rows.map((b) => b[3]).filter(isNum);
    // 눈금은 보기 좋은 값으로 만들되 위아래를 눈금까지 늘리지 않습니다.
    // 늘리면 캔들이 화면 가운데 작게 뭉쳐 보입니다.
    const lo = Math.min(...lows, ...(isNum(avg) ? [avg] : []));
    const hi = Math.max(...highs, ...(isNum(avg) ? [avg] : []));
    const pad = Math.max((hi - lo) * 0.04, hi * 0.001);
    const min = lo - pad, max = hi + pad;
    const ticks = niceTicks(lo, hi, 4).filter((t) => t >= min && t <= max);
    const maxVol = Math.max(...rows.map((b) => (isNum(b[5]) ? b[5] : 0)), 1);
    const span = W - L - R;
    const step = span / rows.length;
    const bodyW = Math.max(1, Math.min(9, step * 0.68));
    const cx = (i) => L + step * (i + 0.5);
    const py = (v) => T + ((max - v) * priceH) / (max - min || 1);
    const vy = (v) => T + priceH + GAP + volH - (v / maxVol) * volH;
    const root = svg('svg', { viewBox: `0 0 ${W} ${H}`, role: 'img', 'aria-label': label || '일봉 차트' });
    const lastClose = rows[rows.length - 1][4];
    const axisText = (v) => (market === 'US' ? v.toFixed(2) : Math.round(v).toLocaleString('ko-KR'));
    for (const t of ticks) {
      root.append(svg('line', { x1: L, x2: W - R, y1: py(t), y2: py(t), class: 'grid-line' }));
      // 현재가 표시와 겹치는 눈금 글씨는 생략합니다.
      if (Math.abs(py(t) - py(lastClose)) > 11) root.append(svg('text', { x: W - R + 6, y: py(t) + 4 }, axisText(t)));
    }
    const mean = (i, n) => {
      if (i + 1 < n) return null;
      let sum = 0;
      for (let k = i - n + 1; k <= i; k++) sum += rows[k][4];
      return sum / n;
    };
    for (const [n, klass] of [[5, 'ma5'], [20, 'ma20'], [60, 'ma60']]) {
      const pts = [];
      for (let i = 0; i < rows.length; i++) { const v = mean(i, n); if (v !== null) pts.push(`${cx(i).toFixed(1)},${py(v).toFixed(1)}`); }
      if (pts.length > 1) root.append(svg('polyline', { points: pts.join(' '), class: klass }));
    }
    rows.forEach((b, i) => {
      const [, o, h, l, c, v] = b;
      const up = isNum(o) ? c >= o : true;
      const klass = up ? 'candle-up' : 'candle-down';
      if (isNum(h) && isNum(l)) root.append(svg('line', { x1: cx(i), x2: cx(i), y1: py(h), y2: py(l), class: `wick ${klass}` }));
      const top = isNum(o) ? py(Math.max(o, c)) : py(c);
      const bottom = isNum(o) ? py(Math.min(o, c)) : py(c);
      root.append(svg('rect', { x: cx(i) - bodyW / 2, y: top, width: bodyW, height: Math.max(1, bottom - top), class: klass }));
      if (isNum(v)) root.append(svg('rect', { x: cx(i) - bodyW / 2, y: vy(v), width: bodyW, height: Math.max(1, T + priceH + GAP + volH - vy(v)), class: klass, opacity: .5 }));
    });
    if (isNum(avg) && avg >= min && avg <= max) {
      root.append(svg('line', { x1: L, x2: W - R, y1: py(avg), y2: py(avg), class: 'avg-line' }));
      root.append(svg('text', { x: L + 2, y: py(avg) - 6, class: 'avg-tag' }, `평단 ${price(avg, market)}`));
    }
    const lastRow = rows[rows.length - 1];
    const upDay = rows.length > 1 && lastRow[4] >= rows[rows.length - 2][4];
    root.append(svg('rect', { x: W - R + 2, y: py(lastClose) - 8, width: R - 4, height: 16, rx: 3,
                              fill: upDay ? css('--up') : css('--down') }));
    root.append(svg('text', { x: W - R + 6, y: py(lastClose) + 4, class: 'last-tag', fill: '#fff' }, axisText(lastClose)));
    [0, rows.length - 1].forEach((i, n) => root.append(svg('text', { x: cx(i), y: H - 4, 'text-anchor': n === 0 ? 'start' : 'end' }, String(rows[i][0]).slice(2))));
    const cross = svg('line', { x1: 0, x2: 0, y1: T, y2: T + priceH + GAP + volH, class: 'cross', visibility: 'hidden' });
    const hit = svg('rect', { x: L, y: 0, width: span, height: H, class: 'hit' });
    root.append(cross, hit);
    const move = (ev) => {
      const box = root.getBoundingClientRect();
      const px = ((ev.clientX - box.left) * W) / box.width;
      const i = Math.max(0, Math.min(rows.length - 1, Math.floor((px - L) / step)));
      const [day, o, h, l, c, v] = rows[i];
      cross.setAttribute('x1', cx(i)); cross.setAttribute('x2', cx(i)); cross.setAttribute('visibility', 'visible');
      const prev = i > 0 ? rows[i - 1][4] : null;
      const chg = isNum(prev) && prev > 0 ? (c / prev - 1) * 100 : null;
      showTip(ev, `${price(c, market)} ${chg === null ? '' : pct(chg, 2)}`,
        `${day} · 시 ${price(o, market)} 고 ${price(h, market)} 저 ${price(l, market)}${isNum(v) ? ` · 거래량 ${Math.round(v).toLocaleString('ko-KR')}` : ''}`);
    };
    hit.addEventListener('pointermove', move);
    hit.addEventListener('pointerdown', move);
    hit.addEventListener('pointerleave', () => { cross.setAttribute('visibility', 'hidden'); hideTip(); });
    host.append(root);
    const swatch = (color, text) => el('span', {}, el('i', { class: 'line', style: `background:${color}` }), ' ', text);
    host.append(el('div', { class: 'legend' },
      swatch('#e8a33d', '5일선'), swatch(css('--accent'), '20일선'), swatch('#8a6fd6', '60일선'),
      el('span', { class: 'muted', text: `${rows.length}봉 · ${rows[0][0]} ~ ${lastRow[0]}` })));
  }

  // 조밀한 표. cols = [{key, label, right, lead, cell}]
  function dense(cols, rows, { onPick = null, selected = null, key = null } = {}) {
    return el('div', { class: 'table-wrap' }, el('table', { class: 'dense' },
      el('thead', {}, el('tr', {}, cols.map((c) => el('th', { class: `${c.right ? 'r' : ''}${c.lead ? ' lead' : ''}`, text: c.label })))),
      el('tbody', {}, rows.map((row) => {
        const id = key ? key(row) : null;
        return el('tr', {
          class: onPick ? 'pickable' : '', 'aria-selected': id && selected === id ? 'true' : null,
          onClick: onPick ? () => onPick(row) : null,
        }, cols.map((c) => {
          const value = c.cell(row);
          const node = el('td', { class: `${c.right ? 'r' : ''}${c.lead ? ' lead' : ''}${c.tone ? ' ' + (c.tone(row) || '') : ''}` });
          // 배열로 오는 칸(칩 + 이름 같은)에는 null 이 섞입니다. put 이 걸러 줍니다.
          put(node, Array.isArray(value) ? value : [value === null || value === undefined ? '—' : value]);
          return node;
        }));
      }))));
  }
  const chip = (text, kind = '') => (text ? el('span', { class: `chip ${kind}`, text }) : null);

  function hBars(host, rows, currency) {
    host.replaceChildren();
    const data = rows.filter((r) => isNum(r.value));
    if (!data.length) { host.append(empty('확인된 손익이 있는 매도가 없습니다')); return; }
    const W = chartWidth(host), rowH = 46, T = 4;
    const labelW = Math.min(150, Math.max(104, W * 0.3));
    const H = T + data.length * rowH;
    const lo = Math.min(0, ...data.map((r) => r.value));
    const hi = Math.max(0, ...data.map((r) => r.value));
    const padL = labelW + 8, padR = 70, padNeg = lo < 0 ? 70 : 0;
    const x = (v) => padL + padNeg + ((v - lo) * (W - padL - padR - padNeg)) / (hi - lo || 1);
    const root = svg('svg', { viewBox: `0 0 ${W} ${H}`, role: 'img', 'aria-label': '규칙별 손익' });
    root.append(svg('line', { x1: x(0), x2: x(0), y1: 0, y2: H, class: 'axis-line' }));
    data.forEach((r, i) => {
      const cy = T + i * rowH + rowH / 2;
      root.append(svg('text', { x: 0, y: cy - 3, class: 'label-ink' }, r.name.length > 12 ? r.name.slice(0, 11) + '…' : r.name));
      root.append(svg('text', { x: 0, y: cy + 13 }, r.sub));
      const x0 = x(0), x1 = x(r.value);
      const w = Math.max(2, Math.abs(x1 - x0));
      const left = Math.min(x0, x1);
      const bh = 16, r4 = Math.min(4, w / 2);
      // 0 기준선 쪽은 각지게, 끝은 둥글게
      const pathD = r.value >= 0
        ? `M${left},${cy - bh / 2}h${w - r4}a${r4},${r4} 0 0 1 ${r4},${r4}v${bh - 2 * r4}a${r4},${r4} 0 0 1 -${r4},${r4}h-${w - r4}z`
        : `M${left + w},${cy - bh / 2}h-${w - r4}a${r4},${r4} 0 0 0 -${r4},${r4}v${bh - 2 * r4}a${r4},${r4} 0 0 0 ${r4},${r4}h${w - r4}z`;
      root.append(svg('path', { d: pathD, class: r.value >= 0 ? 'bar-up' : 'bar-down' }));
      const tx = r.value >= 0 ? left + w + 6 : left - 6;
      const full = currency === 'USD' ? usdS(r.value) : `${sign(r.value)}${Math.round(r.value).toLocaleString('ko-KR')}`;
      root.append(svg('text', { x: tx, y: cy + 4, 'text-anchor': r.value >= 0 ? 'start' : 'end', class: 'value-ink' }, full.length <= 9 ? full : compact(r.value, currency)));
      const hit = svg('rect', { x: 0, y: cy - rowH / 2, width: W, height: rowH, class: 'hit' });
      hit.addEventListener('pointermove', (ev) => showTip(ev, money(r.value, currency, true), `${r.name} · ${r.sub}`));
      hit.addEventListener('pointerleave', hideTip);
      root.append(hit);
    });
    host.append(root);
  }
  function hexToRgb(hex) {
    const m = hex.replace('#', '').match(/^([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i);
    return m ? m.slice(1).map((h) => parseInt(h, 16)) : [128, 128, 128];
  }
  function divergingColor(value, maxAbs) {
    if (!isNum(value)) return css('--surface-2');
    const mid = hexToRgb(css('--mid'));
    const pole = hexToRgb(css(value >= 0 ? '--up' : '--down'));
    const t = maxAbs > 0 ? Math.min(1, Math.sqrt(Math.abs(value) / maxAbs)) : 0;
    const k = 0.15 + 0.85 * t;
    const mix = mid.map((c, i) => Math.round(c + (pole[i] - c) * (value === 0 ? 0 : k)));
    return `rgb(${mix.join(',')})`;
  }
  function inkOn(color) {
    const [r, g, b] = color.match(/\d+/g).map(Number);
    const lum = (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255;
    return lum > 0.6 ? '#0b0b0b' : '#ffffff';
  }
  function inkOnAny(color) {
    return inkOn(color.startsWith('#') ? `rgb(${hexToRgb(color).join(',')})` : color);
  }
  function heatGrid(host, cells, { cols, rows, rowLabels = [], colLabels = [], currency, cellH = 30, showValues = false }) {
    host.replaceChildren();
    const W = chartWidth(host), L = rowLabels.length ? 26 : 0, T = colLabels.length ? 16 : 0;
    const cw = (W - L) / cols;
    const H = T + rows * cellH;
    const maxAbs = Math.max(0, ...cells.filter((c) => isNum(c.value)).map((c) => Math.abs(c.value)));
    const root = svg('svg', { viewBox: `0 0 ${W} ${H}`, role: 'img', 'aria-label': '손익 달력' });
    rowLabels.forEach((t, r) => root.append(svg('text', { x: 0, y: T + r * cellH + cellH / 2 + 4 }, t)));
    colLabels.forEach((t, c) => { if (t) root.append(svg('text', { x: L + c * cw + 2, y: 11 }, t)); });
    for (const c of cells) {
      const fill = c.blank ? 'transparent' : divergingColor(c.value, maxAbs);
      const rect = svg('rect', { x: L + c.col * cw, y: T + c.row * cellH, width: Math.max(1, cw), height: cellH, rx: 4, class: 'cell', fill });
      root.append(rect);
      const ink = c.blank ? '' : `fill:${isNum(c.value) ? inkOnAny(fill) : css('--muted')}`;
      if (c.top) root.append(svg('text', { x: L + c.col * cw + 6, y: T + c.row * cellH + 14, style: ink + ';opacity:.8' }, c.top));
      if (!c.blank && showValues && isNum(c.value) && c.value !== 0) {
        const text = compact(c.value, currency);
        if (text.length * 7 + 8 < cw) root.append(svg('text', { x: L + c.col * cw + cw / 2, y: T + c.row * cellH + cellH - 9, 'text-anchor': 'middle', class: 'value-ink', style: ink }, text));
      }
      if (!c.blank) {
        rect.addEventListener('pointermove', (ev) => showTip(ev, isNum(c.value) ? money(c.value, currency, true) : '매도 없음', c.label));
        rect.addEventListener('pointerleave', hideTip);
      }
    }
    host.append(root);
  }
  function rampLegend(currency) {
    const steps = [-1, -0.5, 0, 0.5, 1].map((t) => divergingColor(t, 1));
    return el('div', { class: 'legend' }, '손실', el('span', { class: 'ramp' }, steps.map((c) => el('i', { style: `background:${c}` }))), '이익',
      el('span', { text: currency === 'USD' ? '(USD)' : '(원)' }));
  }

  // ------------------------------------------------------------------ 화면: 홈
  function statusPills(d) {
    const st = d.status || {};
    const pill = (label, on) => el('span', { class: `pill ${on ? 'on' : 'off'}` }, el('span', { class: 'dot' }), `${label} ${on ? '켜짐' : '꺼짐'}`);
    const kr = d.kr || {}, us = d.us || {};
    return el('div', { class: 'pills' },
      pill('국내 매매', st.kr_trading), pill('미국 매매', st.us_trading),
      el('span', { class: 'pill' }, `국내 국면 ${isNum(kr.regime) ? kr.regime : '?'}/3`),
      el('span', { class: 'pill' }, `미국 국면 ${isNum(us.regime) ? us.regime : '?'}/2`));
  }
  function itemList(rows, emptyText, limit = 8) {
    if (!rows || !rows.length) return empty(emptyText);
    const item = (r) => el('div', { class: 'item' },
      el('span', { class: `sev ${r.level}`, 'aria-label': r.level === 'urgent' ? '긴급' : r.level === 'buy' ? '매수 대기' : '확인', text: r.level === 'urgent' ? '!' : r.level === 'buy' ? '↑' : '?' }),
      el('div', {}, el('div', { class: 'title', text: `${r.name || r.symbol || r.market}` }), el('div', { class: 'detail', text: `${r.title} · ${r.detail}` })),
      el('span', { class: 'badge', text: r.market }));
    const list = el('div', { class: 'list' }, rows.slice(0, limit).map(item));
    if (rows.length <= limit) return list;
    return el('div', {}, list, el('details', {}, el('summary', { text: `${rows.length - limit}개 더 보기` }), el('div', { class: 'list' }, rows.slice(limit).map(item))));
  }
  // ------------------------------------------------------------------ 시장 지표
  const CHIP_KIND = { 지수: 'idx', 변동성: 'warn', 환율: 'fx', 원자재: '', Upbit: 'cash', Binance: 'cash' };
  function briefValue(row) {
    if (!isNum(row.price)) return '—';
    const digits = row.price >= 1000 ? 0 : 2;
    const body = row.price.toLocaleString('ko-KR', { minimumFractionDigits: digits, maximumFractionDigits: digits });
    return row.currency === 'USD' ? `$${body}` : row.currency === 'KRW' ? `${body}` : body;
  }
  function tickerBar(d) {
    const rows = ((d.brief || {}).items || []).filter((r) => isNum(r.price));
    if (!rows.length) return null;
    return el('div', { class: 'ticker', role: 'list', 'aria-label': '시장 지표' },
      rows.map((r) => el('div', { class: `tk ${r.stale ? 'old' : ''}`, role: 'listitem', title: `${r.as_of || ''}${r.stale ? ' · 갱신 실패, 직전 값' : ''}` },
        el('b', { text: r.label }),
        el('span', { class: 'v', text: briefValue(r) }),
        el('span', { class: `c ${cls(r.change)}`, text: pct(r.change, 2) }))));
  }
  function briefCard(d) {
    const brief = d.brief || {};
    const rows = brief.items || [];
    if (!rows.length) return null;
    const stale = rows.filter((r) => r.stale).length;
    return card('시장 지표', `${brief.updated_at ? brief.updated_at.slice(5, 16) : '—'} 기준${stale ? ` · ${stale}건 갱신 실패` : ''}`,
      dense([
        { label: '지표', lead: true, cell: (r) => [chip(r.chip, CHIP_KIND[r.chip] ?? ''), ' ', r.label] },
        { label: '현재가', right: true, cell: (r) => briefValue(r) },
        { label: '일간', right: true, tone: (r) => cls(r.change), cell: (r) => pct(r.change, 2) },
        { label: '기준', right: true, cell: (r) => (r.as_of ? r.as_of.slice(5) : '—') },
      ], rows));
  }

  // ------------------------------------------------------------------ 고른 종목 상세 (차트 + 아래 탭)
  const SUBTABS = [['chart', '차트'], ['rule', '규칙'], ['trade', '체결'], ['data', '자료']];
  function pickPanel(d, tabMarket) {
    // 다른 시장 탭으로 옮기면 상세는 닫습니다(국내 탭에 미국 종목이 남아 있지 않도록).
    if (!S.pick || !S.pick.startsWith(`${tabMarket}:`)) return null;
    const [market, symbol] = S.pick.split(':');
    const entry = (d.bars || {})[S.pick] || null;
    const hold = ((market === 'US' ? (d.us || {}).holdings : (d.kr || {}).holdings) || []).find((h) => h.symbol === symbol) || null;
    const watch = (d.watchlist || []).find((w) => w.symbol === symbol) || null;
    const rank = (d.ranks || []).find((r) => r.symbol === symbol) || null;
    const cand = ((d.us || {}).candidates || []).find((c) => c.symbol === symbol) || null;
    const name = (hold && hold.name) || (entry && entry.name) || (watch && watch.name) || symbol;
    const body = el('div');
    const panel = el('div', { class: 'card' },
      el('div', { class: 'pick-head' },
        el('h2', {}, chip(market === 'US' ? 'US' : 'KR', 'idx'), ' ', `${name}`,
          market === 'KR' && name !== symbol ? el('span', { class: 'muted', text: ` ${symbol}` }) : null),
        el('button', { class: 'close', type: 'button', 'aria-label': '닫기', text: '✕', onClick: () => { S.pick = null; render(true); } })),
      el('div', { class: 'subtabs', role: 'group' }, SUBTABS.map(([id, label]) =>
        el('button', { type: 'button', 'aria-pressed': String(S.sub === id), text: label, onClick: () => { S.sub = id; render(true); } }))),
      body);
    const rate = hold ? (market === 'US' ? (isNum(hold.rate) ? hold.rate * 100 : null) : hold.pl_rate) : null;
    if (S.sub === 'chart') {
      const host = el('div', { class: 'chart' });
      body.append(host);
      queueMicrotask(() => candleChart(host, entry ? entry.bars : [], { market, avg: hold ? hold.avg : null, label: `${name} 일봉` }));
    } else if (S.sub === 'rule') {
      if (!hold) put(body, empty('보유 중인 종목이 아닙니다. 매도 규칙은 보유할 때만 계산합니다.'));
      else if (market === 'KR') {
        put(body, el('dl', { class: 'kv' },
          el('dt', { text: '경로' }), el('dd', { text: { core: '모멘텀', watch: '눌림목', manual: '직접 매수' }[hold.source] || '—' }),
          el('dt', { text: '수익률' }), el('dd', { class: cls(rate), text: pct(rate) })),
          hold.source === 'manual' ? el('div', { class: 'meter-text', text: '직접 매수 · 봇이 팔지 않습니다' }) : exitMeter(hold.exit),
          hold.target ? el('div', { class: 'meter-text' }, el('span', { text: `위쪽: ${hold.target.label} ${price(hold.target.price)}` }), el('span', { class: 'num', text: pct(hold.target.gap, 1) })) : null);
      } else {
        put(body, el('dl', { class: 'kv' },
          el('dt', { text: '구분' }), el('dd', { text: hold.bot ? (hold.kind || '모멘텀') : '수동 보유' }),
          el('dt', { text: '수익률' }), el('dd', { class: cls(rate), text: pct(rate) }),
          isNum(hold.score) ? el('dt', { text: '점수' }) : null,
          isNum(hold.score) ? el('dd', { text: `${isNum(hold.entry) ? hold.entry + ' → ' : ''}${hold.score}` }) : null),
          hold.bot && isNum(hold.stop_gap) ? exitMeter({ label: hold.stop_label || '손절선', price: isNum(hold.price) ? hold.price * (1 + hold.stop_gap / 100) : null, gap: hold.stop_gap }, 'US') : null,
          hold.rules && hold.rules.length ? el('div', { class: 'rules' }, hold.rules.map((r) => el('span', { class: `rule ${r.state === 'hit' ? 'hit' : r.state === 'near' ? 'near' : ''}`, text: `${r.kind} · ${r.text}` }))) : null);
      }
    } else if (S.sub === 'trade') {
      const perf = (d.performance || {})[market] || {};
      const mine = (perf.trades || []).filter((t) => t.symbol === symbol);
      body.append(mine.length ? dense([
        { label: '일시', lead: true, cell: (t) => String(t.datetime || '').slice(5, 16) },
        { label: '구분', cell: (t) => el('span', { class: t.side === 'BUY' ? 'up' : 'down', text: t.side === 'BUY' ? '매수' : '매도' }) },
        { label: '수량', right: true, cell: (t) => (isNum(t.qty) ? String(+t.qty.toFixed(6)) : '—') },
        { label: '단가', right: true, cell: (t) => price(t.price, market) },
        { label: '손익', right: true, tone: (t) => cls(t.realized), cell: (t) => (isNum(t.realized) ? money(t.realized, perf.currency, true) : '') },
        { label: '사유', cell: (t) => t.tag || '' },
      ], mine.slice(0, 40)) : empty('이 종목의 체결 기록이 없습니다'));
    } else {
      const facts = [];
      const push = (k, v) => { if (v !== null && v !== undefined && v !== '') facts.push(el('dt', { text: k }), el('dd', { text: v })); };
      if (hold) {
        push('현재가', price(hold.price, market)); push('평단', price(hold.avg, market));
        push('수량', isNum(hold.qty) ? String(hold.qty) : null);
        push('평가손익', money(market === 'US' ? hold.pnl : hold.pl, market === 'US' ? 'USD' : 'KRW', true));
      }
      if (watch) {
        push('관찰 방식', watch.mode); push('점수', watch.score); push('진입선', price(watch.entry));
        push('전일종가', price(watch.prev_close)); push('고점대비', pct(watch.drop, 1));
        push('거래량', isNum(watch.vol) ? `${watch.vol.toFixed(2)}배` : null);
        push('수급', watch.supply); push('재무', watch.fund);
      }
      if (rank) { push('모멘텀 점수', rank.score); push('RSI', isNum(rank.rsi) ? rank.rsi.toFixed(0) : null); push('거래량비', isNum(rank.udv) ? rank.udv.toFixed(2) : null); }
      if (cand) { push('미국 점수', cand.score); push('RSI', isNum(cand.rsi) ? cand.rsi.toFixed(0) : null); push('roc_skip', pct(cand.roc_skip, 1)); push('거래량', isNum(cand.vol) ? `${cand.vol.toFixed(2)}배` : null); }
      body.append(facts.length ? el('dl', { class: 'kv' }, facts) : empty('올라온 자료가 없습니다'));
    }
    return panel;
  }
  function pickRow(market) {
    return (row) => {
      const id = `${market}:${row.symbol}`;
      S.pick = S.pick === id ? null : id;
      render(true);
      if (S.pick && window.innerWidth < 1040) requestAnimationFrame(() => {
        const node = $('.split > .side'), view = $('#view');
        if (node && view) view.scrollTop += node.getBoundingClientRect().top - view.getBoundingClientRect().top - 22;
      });
    };
  }
  const splitWith = (side, ...main) => el('div', { class: 'split' }, el('div', { class: 'main grid' }, main), side ? el('div', { class: 'side' }, side) : null);

  function renderHome(d) {
    const out = [];
    const kr = d.kr || {}, us = d.us || {};
    const sum = kr.summary;
    const hero = card('총자산', '국내 계좌 · 예수금 포함',
      el('div', { class: 'hero num', text: sum ? krw(sum.total) : '—' }),
      sum ? el('div', { class: 'hero-sub' },
        el('span', { class: cls(sum.pl), text: `평가손익 ${krwS(sum.pl)} (${pct(sum.pl_rate)})` }), ' · ',
        el('span', { class: cls(sum.day), text: `오늘 ${krwS(sum.day)} (${pct(sum.day_rate)})` })) : empty('보유 조회 전입니다'),
      isNum(us.value) ? el('div', { class: 'muted', style: 'margin-top:6px' }, `미국 ${usd(us.value)} · 손익 `, el('span', { class: cls(us.pnl), text: usdS(us.pnl) })) : null,
      el('div', { style: 'margin-top:12px' }, statusPills(d)),
      d.status && d.status.us_status ? el('div', { class: 'muted', style: 'font-size:13px;margin-top:8px', text: `미국 상태: ${d.status.us_status}` }) : null);
    out.push(hero);
    if (d.errors && d.errors.length) out.push(el('div', { class: 'banner', text: `일부 자료를 만들지 못했습니다: ${d.errors.join(', ')}` }));
    (d.health || []).forEach((h) => out.push(el('div', { class: 'banner', text: `[점검] ${h.message}` })));
    const t = d.today;
    if (!t) { out.push(missing('오늘 할 일')); return out; }
    const now = kstNow();
    const sameDay = (d.generated_at || '').slice(0, 10) === now.date;
    const plan = (t.schedule || []).map((p) => ({ ...p, done: sameDay ? p.time <= now.hm : p.done }));
    const next = plan.find((p) => !p.done);
    out.push(el('div', { class: 'grid two' },
      card('지금 확인', `${(t.urgent || []).length}건`, itemList(t.urgent, '확인할 것이 없습니다')),
      card('매수 대기', `${(t.waiting || []).length}종목`, itemList(t.waiting, '대기 종목이 없습니다'))));
    out.push(card('매수 안 한 이유', `${(t.skipped || []).length}종목 · 조건까지 갔는데 막힌 것만`,
      itemList(t.skipped, '오늘 막힌 종목이 없습니다', 12)));
    const brief = briefCard(d);
    if (brief) out.push(brief);
    out.push(card('오늘 일정', next ? `다음: ${next.time} ${next.title}` : '오늘 일정 끝',
      el('div', { class: 'timeline' }, plan.map((p) => el('div', { class: p.done ? 'done' : p === next ? 'next' : '' },
        el('span', { class: 'num', text: p.time }), el('span', { text: p.title }))))));
    return out;
  }

  // ------------------------------------------------------------------ 화면: 국내
  function exitMeter(exit, market) {
    if (!exit) return null;
    const gap = exit.gap;
    const closeness = Math.max(0, Math.min(1, 1 - Math.abs(gap) / 12));
    const state = Math.abs(gap) < 1 ? 'hot' : Math.abs(gap) < 3 ? 'near' : '';
    return el('div', { class: 'meter' },
      el('div', { class: `meter-bar ${state}`, role: 'meter', 'aria-valuemin': 0, 'aria-valuemax': 100, 'aria-valuenow': Math.round(closeness * 100), 'aria-label': '매도선까지 거리' },
        el('span', { style: `width:${(closeness * 100).toFixed(0)}%` })),
      el('div', { class: 'meter-text' }, el('span', { text: `${exit.label} ${price(exit.price, market)}` }), el('span', { class: 'num', text: `${pct(gap, 1)}` })));
  }
  function renderKR(d) {
    const kr = d.kr;
    if (!kr) return [missing('국내 계좌')];
    const out = [];
    const s = kr.summary;
    out.push(el('div', { class: 'tiles' },
      tile('총자산', s ? krw(s.total) : '—', s ? `주식 ${compact(s.eval)} · 현금 ${compact(s.cash)}` : ''),
      tile('평가손익', s ? krwS(s.pl) : '—', s ? pct(s.pl_rate) : '', s ? cls(s.pl) : ''),
      tile('오늘 손익', s ? krwS(s.day) : '—', s ? pct(s.day_rate) : '', s ? cls(s.day) : ''),
      tile('봇 운용 손익', kr.bot ? krwS(kr.bot.pl) : '—', kr.bot ? `${pct(kr.bot.pl_rate)} · 운용 ${compact(kr.bot.cost)}` : '봇 보유 없음', kr.bot ? cls(kr.bot.pl) : '')));
    const chartHost = el('div', { class: 'chart' });
    out.push(card('계좌 자산 추이', '매일 마지막 값', chartHost));
    queueMicrotask(() => lineChart(chartHost, (kr.equity || []).map((p) => ({ x: p.date, y: p.value })), { currency: 'KRW', label: '계좌 자산' }));
    const pick = pickRow('KR');
    const KR_LABEL = { core: '모멘텀', watch: '눌림목', manual: '직접' };
    const holds = kr.holdings || [];
    out.push(card('보유 종목', `${holds.length}종목 · 종목을 누르면 일봉이 열립니다`,
      holds.length ? dense([
        { label: '종목', lead: true, cell: (h) => [chip(KR_LABEL[h.source], h.source === 'watch' ? 'cash' : h.source === 'core' ? 'idx' : ''), ' ',
          el('span', { class: 'sym', text: h.name || h.symbol }), h.half ? ' ½' : ''] },
        { label: '현재가', right: true, cell: (h) => price(h.price) },
        { label: '일간', right: true, tone: (h) => cls(h.day_rate), cell: (h) => pct(h.day_rate, 1) },
        { label: '평단', right: true, cell: (h) => price(h.avg) },
        { label: '수량', right: true, cell: (h) => h.qty },
        { label: '평가손익', right: true, tone: (h) => cls(h.pl), cell: (h) => krwS(h.pl) },
        { label: '수익률', right: true, tone: (h) => cls(h.pl_rate), cell: (h) => pct(h.pl_rate) },
        { label: '매도선까지', right: true, cell: (h) => (h.source === 'manual' ? '봇 미관리' : h.exit ? `${h.exit.label} ${pct(h.exit.gap, 1)}` : '—') },
      ], holds, { onPick: pick, selected: S.pick, key: (h) => `KR:${h.symbol}` }) : empty('보유 종목이 없습니다')));
    const watch = d.watchlist || [];
    out.push(card('눌림목 관찰목록', `${watch.length}종목 · 전일 종가 기준`, watch.length ? dense([
      // 지지선이 무엇인지가 핵심입니다. 진입 방식 이름에서 선 이름만 뽑습니다.
      // (예: '5분봉 반등·지지 (60일선)' -> '60일선', '20일선 회복' -> '20일선')
      { label: '종목', lead: true, cell: (w) => [chip(supportChip(w.mode), 'idx'), ' ', el('span', { class: 'sym', text: w.name || w.symbol })] },
      { label: '점수', right: true, cell: (w) => w.score },
      { label: '진입선', right: true, cell: (w) => price(w.entry) },
      { label: '전일종가', right: true, cell: (w) => price(w.prev_close) },
      { label: '진입선까지', right: true, cell: (w) => pct(isNum(w.entry) && isNum(w.prev_close) && w.prev_close > 0 ? (w.entry / w.prev_close - 1) * 100 : null, 1) },
      { label: '고점대비', right: true, tone: (w) => cls(w.drop), cell: (w) => pct(w.drop, 1) },
      { label: '거래량', right: true, cell: (w) => (isNum(w.vol) ? `${w.vol.toFixed(1)}배` : '—') },
    ], watch, { onPick: pick, selected: S.pick, key: (w) => `KR:${w.symbol}` }) : empty('관찰 종목이 없습니다')));
    const ranks = d.ranks || [];
    if (ranks.length) {
      out.push(card('모멘텀 순위', `오늘 채점 상위 ${ranks.length}`, el('details', {}, el('summary', { text: '펼치기' }), dense([
        { label: '#', right: true, cell: (r) => ranks.indexOf(r) + 1 },
        { label: '종목', lead: true, cell: (r) => [el('span', { class: 'sym', text: r.name || r.symbol }), r.rsi_div ? chip('RSI 약세', 'warn') : null] },
        { label: '점수', right: true, cell: (r) => r.score },
        { label: '종가', right: true, cell: (r) => price(r.close) },
        { label: '1일', right: true, tone: (r) => cls(r.change), cell: (r) => pct(r.change, 1) },
        { label: 'RSI', right: true, cell: (r) => (isNum(r.rsi) ? r.rsi.toFixed(0) : '—') },
        { label: '거래량비', right: true, cell: (r) => (isNum(r.udv) ? r.udv.toFixed(2) : '—') },
      ], ranks, { onPick: pick, selected: S.pick, key: (r) => `KR:${r.symbol}` }))));
    }
    return [splitWith(pickPanel(d, 'KR'), ...out)];
  }

  // ------------------------------------------------------------------ 화면: 미국
  function renderUS(d) {
    const us = d.us;
    if (!us) return [missing('미국 계좌')];
    const out = [];
    out.push(el('div', { class: 'tiles' },
      tile('평가금액', usd(us.value), us.updated_at ? `계좌 조회 ${ago(us.updated_at).text}` : ''),
      tile('평가손익', usdS(us.pnl), '', cls(us.pnl)),
      tile('오늘 손익', usdS(us.day_pnl), '', cls(us.day_pnl)),
      tile('매수 가능', usd(us.buying_power), `국면 ${isNum(us.regime) ? us.regime : '?'}/2 · 채점 ${(us.scan_date || '—').slice(5)}`)));
    if (us.status) out.push(el('div', { class: 'card muted', style: 'font-size:14px', text: `미국 자동매매 상태: ${us.status}` }));
    const chartHost = el('div', { class: 'chart' });
    out.push(card('미국 계좌 추이', 'USD · 뉴욕 날짜 기준', chartHost));
    queueMicrotask(() => lineChart(chartHost, (us.history || []).map((p) => ({ x: p.date, y: p.value })), { currency: 'USD', label: '미국 평가금액' }));
    const pick = pickRow('US');
    const holds = us.holdings || [];
    out.push(card('보유 종목', `${holds.length}종목 · 종목을 누르면 일봉이 열립니다`, holds.length ? dense([
      { label: '티커', lead: true, cell: (h) => [chip(h.bot ? (h.kind || '모멘텀') : '수동', h.bot ? 'idx' : ''), ' ', el('span', { class: 'sym', text: h.symbol })] },
      { label: '종목', cell: (h) => h.name || '' },
      { label: '현재가', right: true, cell: (h) => usd(h.price) },
      { label: '평단', right: true, cell: (h) => usd(h.avg) },
      { label: '수량', right: true, cell: (h) => (isNum(h.qty) ? String(+h.qty.toFixed(4)) : '—') },
      { label: '손익', right: true, tone: (h) => cls(h.pnl), cell: (h) => usdS(h.pnl) },
      { label: '수익률', right: true, tone: (h) => cls(h.rate), cell: (h) => pct(isNum(h.rate) ? h.rate * 100 : null) },
      { label: '점수', right: true, cell: (h) => (isNum(h.score) ? `${isNum(h.entry) ? h.entry + '→' : ''}${h.score}` : '—') },
      { label: '손절까지', right: true, cell: (h) => (h.bot && isNum(h.stop_gap) ? pct(h.stop_gap, 1) : '봇 미관리') },
    ], holds, { onPick: pick, selected: S.pick, key: (h) => `US:${h.symbol}` }) : empty('보유 종목이 없습니다')));
    const cand = us.candidates || [];
    out.push(card('모멘텀 매수 후보', `15점 이상 · RSI·roc_skip·거래량 조건 통과 ${cand.length}종목`, cand.length ? dense([
      { label: '티커', lead: true, cell: (c) => el('span', { class: 'sym', text: c.symbol }) },
      { label: '종목', cell: (c) => c.name || '' },
      { label: '점수', right: true, cell: (c) => c.score },
      { label: '종가', right: true, cell: (c) => usd(c.close) },
      { label: 'RSI', right: true, cell: (c) => (isNum(c.rsi) ? c.rsi.toFixed(0) : '—') },
      { label: 'roc_skip', right: true, tone: (c) => cls(c.roc_skip), cell: (c) => pct(c.roc_skip, 1) },
      { label: '거래량', right: true, cell: (c) => (isNum(c.vol) ? `${c.vol.toFixed(1)}배` : '—') },
    ], cand, { onPick: pick, selected: S.pick, key: (c) => `US:${c.symbol}` }) : empty('조건을 통과한 후보가 없습니다')));
    return [splitWith(pickPanel(d, 'US'), ...out)];
  }

  // ------------------------------------------------------------------ 화면: 성과
  function renderPerf(d) {
    const perf = d.performance && d.performance[S.perfMarket];
    const seg = el('div', { class: 'controls' }, el('div', { class: 'seg', role: 'group', 'aria-label': '시장' },
      [['KR', '국내 KRW'], ['US', '미국 USD']].map(([k, label]) => el('button', { type: 'button', 'aria-pressed': String(S.perfMarket === k), text: label, onClick: () => { S.perfMarket = k; S.tradeLimit = 60; render(); } }))));
    if (!perf) return [seg, missing('성과')];
    const cur = perf.currency;
    const total = perf.total || {};
    const curve = perf.curve || {};
    const out = [seg];
    const spent = perf.costs || {};
    out.push(el('div', { class: 'tiles' },
      tile('실현손익', total.known ? money(total.total, cur, true) : '—',
        isNum(spent.total) && spent.total > 0 ? `수수료·세금 ${money(spent.total, cur)} 차감` : `원가 미확인 ${total.unknown || 0}건 제외`,
        cls(total.total)),
      tile('승률', isNum(total.win_rate) ? `${total.win_rate.toFixed(0)}%` : '—', `매도 ${total.count || 0}건 · 매수 ${perf.buys || 0}건`),
      tile('평균 손익', isNum(total.avg) ? money(total.avg, cur, true) : '—', isNum(total.profit_factor) ? `이익/손실 비율 ${total.profit_factor.toFixed(2)}` : '', cls(total.avg)),
      tile('최대 낙폭', isNum(curve.max_drawdown) && curve.max_drawdown < 0 ? money(curve.max_drawdown, cur, true) : '없음',
        curve.peak_date && curve.trough_date ? `${String(curve.peak_date).slice(5)} → ${String(curve.trough_date).slice(5)}` : '누적 실현손익 기준', curve.max_drawdown < 0 ? 'down' : '')));

    if (spent.before) out.push(el('div', { class: 'banner', text: `손익은 매수·매도 수수료와 증권거래세를 뺀 값입니다. 비용 반영 전 매도 ${spent.before}건은 세전 그대로입니다.` }));
    const barsHost = el('div', { class: 'chart' });
    const tags = (perf.by_tag || []).slice().sort((a, b) => (b.total || 0) - (a.total || 0));
    out.push(card('매도 규칙별 손익', '막대 = 실현손익 합계', barsHost));
    queueMicrotask(() => hBars(barsHost, tags.map((g) => ({ name: g.name, value: g.known ? g.total : null, sub: `${g.count}건 · 승률 ${isNum(g.win_rate) ? g.win_rate.toFixed(0) + '%' : '—'}` })), cur));

    // 매수 규칙별 · 매수일 거래량별: 팔린 매수분을 선입선출로 이어 붙여 집계한 값
    const entrySub = (g) => `${g.count}건 · 승률 ${isNum(g.win_rate) ? g.win_rate.toFixed(0) + '%' : '—'}`
      + (isNum(g.avg_pct) ? ` · 수익률 ${g.avg_pct >= 0 ? '+' : ''}${g.avg_pct.toFixed(1)}%` : '')
      + (isNum(g.hold) ? ` · ${g.hold.toFixed(0)}일 보유` : '');
    [['by_rule', '매수 규칙별 손익', '어떤 매수가 돈을 벌었는지'],
     ['by_volume', '매수일 거래량별 손익', '하루 전체 거래량 / 20일 평균']].forEach(([key, title, note]) => {
      const rows = (perf[key] || []).slice().sort((a, b) => (b.total || 0) - (a.total || 0));
      if (!rows.length) return;
      const skipped = rows.reduce((n, g) => n + (g.known ? 0 : g.count || 0), 0);
      const host = el('div', { class: 'chart' });
      out.push(card(title, skipped ? `${note} · 원가 미확인 ${skipped}건 제외` : note, host));
      queueMicrotask(() => hBars(host, rows.map((g) => ({ name: g.name, value: g.known ? g.total : null, sub: entrySub(g) })), cur));
    });

    const monthHost = el('div', { class: 'chart' });
    const dayHost = el('div', { class: 'chart' });
    out.push(el('div', { class: 'grid two' }, card('월별 실현손익', '최근 12개월', monthHost, rampLegend(cur)), card('일별 실현손익', '최근 12주 · 평일', dayHost, rampLegend(cur))));
    queueMicrotask(() => {
      const monthly = perf.monthly || {};
      const now = kstNow().date;
      let y = Number(now.slice(0, 4)), m = Number(now.slice(5, 7));
      const months = [];
      for (let i = 0; i < 12; i++) { months.unshift(`${y}-${String(m).padStart(2, '0')}`); m -= 1; if (m === 0) { m = 12; y -= 1; } }
      heatGrid(monthHost, months.map((key, i) => ({
        row: Math.floor(i / 4), col: i % 4, top: `${Number(key.slice(5))}월`,
        value: key in monthly ? monthly[key] : null, label: `${key}${key in monthly ? '' : ' · 매도 없음'}`,
      })), { cols: 4, rows: 3, currency: cur, cellH: 52, showValues: true });

      const daily = perf.daily || {};
      const base = Date.UTC(Number(now.slice(0, 4)), Number(now.slice(5, 7)) - 1, Number(now.slice(8, 10)));
      const DAY = 86400000;
      const monday = base - ((new Date(base).getUTCDay() + 6) % 7) * DAY;
      const iso = (t) => new Date(t).toISOString().slice(0, 10);
      const dcells = [];
      const colLabels = [];
      for (let w = 0; w < 12; w++) {
        const weekStart = monday - (11 - w) * 7 * DAY;
        const ws = iso(weekStart);
        colLabels.push(w % 3 === 0 ? `${Number(ws.slice(5, 7))}/${Number(ws.slice(8, 10))}` : '');
        for (let r = 0; r < 5; r++) {
          const day = iso(weekStart + r * DAY);
          dcells.push({ row: r, col: w, blank: day > now, value: day in daily ? daily[day] : null, label: `${day}${day in daily ? '' : ' · 매도 없음'}` });
        }
      }
      heatGrid(dayHost, dcells, { cols: 12, rows: 5, rowLabels: ['월', '화', '수', '목', '금'], colLabels, currency: cur, cellH: 26 });
    });

    const cumHost = el('div', { class: 'chart' });
    const ddHost = el('div', { class: 'chart' });
    out.push(el('div', { class: 'grid two' },
      card('누적 실현손익', '매도가 확인된 날 기준', cumHost),
      card('최대 낙폭 곡선', '누적 고점 대비 줄어든 금액', ddHost)));
    queueMicrotask(() => {
      lineChart(cumHost, (curve.points || []).map(([x, y]) => ({ x, y })), { currency: cur, zero: true, label: '누적 실현손익' });
      lineChart(ddHost, (curve.underwater || []).map(([x, y]) => ({ x, y })), { currency: cur, zero: true, kind: 'dd', label: '고점 대비' });
    });

    const trades = perf.trades || [];
    const search = el('input', { class: 'search', type: 'search', placeholder: '종목·사유 검색', value: S.tradeQuery, 'aria-label': '체결 검색' });
    const body = el('tbody');
    const more = el('button', { type: 'button', class: 'small-button', text: '더 보기' });
    const fill = () => {
      const q = S.tradeQuery.trim().toLowerCase();
      const rows = trades.filter((t) => !q || [t.name, t.symbol, t.tag, t.reason, t.source].join(' ').toLowerCase().includes(q));
      body.replaceChildren(...rows.slice(0, S.tradeLimit).map((t) => el('tr', {},
        el('td', { class: 'num', text: String(t.datetime || '').slice(5, 16) }),
        el('td', { text: t.name || t.symbol }),
        el('td', { class: t.side === 'BUY' ? 'up' : 'down', text: t.side === 'BUY' ? '매수' : '매도' }),
        el('td', { class: 'r', text: isNum(t.qty) ? String(+t.qty.toFixed(6)) : '—' }),
        el('td', { class: 'r', text: price(t.price, S.perfMarket) }),
        el('td', { class: `r ${cls(t.realized)}`, text: isNum(t.realized) ? money(t.realized, cur, true) : '' }),
        el('td', { class: 'wrap' }, el('b', { text: t.tag || '' }), t.reason ? ` · ${t.reason}` : ''))));
      more.hidden = rows.length <= S.tradeLimit;
    };
    search.addEventListener('input', () => { S.tradeQuery = search.value; S.tradeLimit = 60; fill(); });
    more.addEventListener('click', () => { S.tradeLimit += 100; fill(); });
    fill();
    out.push(card('체결 내역', `최근 ${trades.length}건`, el('div', { class: 'controls', style: 'margin-bottom:8px' }, search),
      el('div', { class: 'table-wrap' }, el('table', {}, el('thead', {}, el('tr', {}, ['일시', '종목', '구분', '수량', '가격', '실현손익', '사유'].map((h, i) => el('th', { class: i >= 3 && i <= 5 ? 'r' : '', text: h })))), body)), more));
    return out;
  }

  // ------------------------------------------------------------------ 화면: 가상투자
  function renderPaper(d) {
    const p = d.paper;
    if (!p || !(p.accounts || []).length) return [missing('가상투자')];
    const accts = p.accounts;
    const out = [];
    const pick = accts.find((a) => a.key === S.paperPick) || accts[0];
    const fm = (a, v, signed) => money(v, a.currency, signed);

    out.push(card('자본금별 수익률', `${p.started || ''} 시작 · 같은 규칙 · 종가 기준`,
      dense([
        { label: '계좌', lead: true, cell: (a) => a.label },
        { label: '수익률', right: true, tone: (a) => cls(a.pl_rate), cell: (a) => pct(a.pl_rate) },
        { label: '손익', right: true, tone: (a) => cls(a.pl), cell: (a) => fm(a, a.pl, true) },
        { label: '자산', right: true, cell: (a) => fm(a, a.value) },
        { label: '현금', right: true, cell: (a) => (isNum(a.cash_rate) ? `${a.cash_rate.toFixed(0)}%` : '—') },
        { label: '종목', right: true, cell: (a) => `${a.count}` },
        { label: '매매', right: true, cell: (a) => `${a.trades}건` },
      ], accts, { onPick: (a) => { S.paperPick = a.key; render(true); }, selected: pick.key, key: (a) => a.key })));

    const gap = accts.length >= 2
      ? accts.reduce((m, a) => Math.max(m, a.pl_rate), -Infinity) - accts.reduce((m, a) => Math.min(m, a.pl_rate), Infinity)
      : 0;
    out.push(el('div', { class: 'tiles' },
      tile('가장 높은 수익률', pct(Math.max(...accts.map((a) => a.pl_rate))),
        accts.slice().sort((a, b) => b.pl_rate - a.pl_rate)[0].label),
      tile('가장 낮은 수익률', pct(Math.min(...accts.map((a) => a.pl_rate))),
        accts.slice().sort((a, b) => a.pl_rate - b.pl_rate)[0].label),
      tile('자본금 차이', `${gap.toFixed(2)}%p`, '가장 높은 쪽 - 낮은 쪽'),
      tile('시작일', p.started || '—', accts[0].day ? `최근 ${accts[0].day}` : '')));

    const host = el('div', { class: 'chart' });
    out.push(card(`${pick.label} 자산 추이`, '종가 기준 · 하루 1점', host));
    queueMicrotask(() => lineChart(host, (pick.equity || []).map(([date, v]) => [date, v]),
      { currency: pick.currency, height: 180, label: pick.label }));

    out.push(card(`${pick.label} 보유`, `${pick.count}종목 · 현금 ${fm(pick, pick.cash)}`,
      (pick.holdings || []).length ? dense([
        { label: '종목', lead: true, cell: (h) => [chip(h.source === 'watch' ? '눌림목' : '모멘텀', h.source === 'watch' ? 'watch' : 'core'), el('span', { class: 'sym', text: h.name || h.symbol })] },
        { label: '수량', right: true, cell: (h) => (h.qty >= 1 ? h.qty.toLocaleString('ko-KR', { maximumFractionDigits: 4 }) : h.qty.toFixed(4)) },
        { label: '현재가', right: true, cell: (h) => price(h.price, pick.market) },
        { label: '평단', right: true, cell: (h) => price(h.avg, pick.market) },
        { label: '평가금액', right: true, cell: (h) => compact(h.value, pick.currency) },
        { label: '수익률', right: true, tone: (h) => cls(h.pl_rate), cell: (h) => pct(h.pl_rate) },
        { label: '비중', right: true, cell: (h) => (pick.value > 0 ? `${(h.value / pick.value * 100).toFixed(1)}%` : '—') },
      ], pick.holdings) : empty('아직 담은 종목이 없습니다')));

    out.push(card(`${pick.label} 매수 안 한 이유`, `${(pick.skipped || []).length}건`,
      (pick.skipped || []).length ? dense([
        { label: '종목', lead: true, cell: (r) => r.name || r.symbol || '—' },
        { label: '단계', cell: (r) => r.stage || '' },
        { label: '이유', cell: (r) => r.why || '' },
      ], pick.skipped) : empty('막힌 종목이 없습니다')));

    out.push(card('읽는 법', null, el('div', { class: 'note' },
      el('p', { text: '신호는 네 계좌가 똑같습니다. 관찰목록도 점수도 같은 날 같은 종목이 오릅니다.' }),
      el('p', { text: '갈리는 곳은 1주 단위, 한 종목 비중 상한, 한 칸 최소 금액, 예수금입니다. 88만원짜리 1주는 1,000만원 계좌의 한 칸에 안 들어가고 1억 계좌에는 들어갑니다.' }),
      el('p', { class: 'muted', text: '하루 1회 종가로만 판정하는 근사입니다. 장중 손절·장중 익절은 다음 날 종가에 걸리고, 눌림목은 그날 일봉의 고가·거래량으로 판정해 진입선 가격에 체결한 것으로 봅니다. VI·유의종목은 통과로 봅니다.' }))));
    return out;
  }

  // ------------------------------------------------------------------ 화면: 로그
  const LOG_FILTERS = [
    ['all', '전체', () => true],
    ['trade', '매매', (s) => /매수|매도|익절|손절|체결|주문/.test(s)],
    ['exit', '손절·익절', (s) => /손절|익절|트레일링|모멘텀약화/.test(s)],
    ['warn', '경고·오류', (s) => /실패|오류|중단|보류|경고|안전 정지|예외|불가|한도/.test(s)],
    ['us', '미국', (s) => /\[미국/.test(s)],
    ['sys', '시스템', (s) => /\[(시스템|재시작|코드 변경|설정|토큰|웹 대시보드|캘린더|파일)/.test(s)],
  ];
  function lineClass(s) {
    if (/실패|오류|안전 정지|예외/.test(s)) return 'warn';
    if (/\[(신규매수|눌림목매수|추가매수|눌림목돌파매수)|매수\]|BUY/.test(s)) return 'buy';
    if (/(손절|익절|매도)\]|SELL|전량 매도|절반 1주 매도/.test(s)) return 'sell';
    if (/^\S+ \S+ \[(시스템|재시작|코드 변경|설정)/.test(s)) return 'sys';
    return '';
  }
  function renderLogs(d) {
    const logs = d.logs || [];
    if (!logs.length) return [missing('실행 로그')];
    if (!logs.some((l) => l.date === S.logDate)) S.logDate = logs[0].date;
    const current = logs.find((l) => l.date === S.logDate);
    const select = el('select', { 'aria-label': '날짜' }, logs.map((l) => el('option', { value: l.date, text: l.date, selected: l.date === S.logDate })));
    const search = el('input', { class: 'search', type: 'search', placeholder: '검색 (종목명·문구)', value: S.logQuery, 'aria-label': '로그 검색' });
    const chips = el('div', { class: 'chips', role: 'group', 'aria-label': '로그 종류' });
    const box = el('div', { class: 'log', tabindex: '0' });
    const count = el('span', { class: 'muted', style: 'font-size:13px' });
    const draw = (scroll) => {
      const filter = (LOG_FILTERS.find((f) => f[0] === S.logFilter) || LOG_FILTERS[0])[2];
      const q = S.logQuery.trim();
      const lines = current.lines.filter((line) => filter(line) && (!q || line.toLowerCase().includes(q.toLowerCase())));
      box.replaceChildren(...lines.map((line) => {
        const row = el('div', { class: lineClass(line) });
        const m = line.match(/^(\d{4}-\d{2}-\d{2} )?(\d{2}:\d{2}:\d{2})(.*)$/);
        const text = m ? m[3] : line;
        if (m) row.append(el('span', { class: 't', text: m[2] }));
        if (q) {
          const lower = text.toLowerCase(), ql = q.toLowerCase();
          let pos = 0, hit;
          while ((hit = lower.indexOf(ql, pos)) !== -1) {
            row.append(text.slice(pos, hit), el('mark', { text: text.slice(hit, hit + q.length) }));
            pos = hit + q.length;
          }
          row.append(text.slice(pos));
        } else {
          row.append(text);
        }
        return row;
      }));
      if (!lines.length) box.append(el('div', { class: 'empty', text: '맞는 줄이 없습니다' }));
      count.textContent = `${lines.length.toLocaleString()}줄${current.truncated ? ' · 앞부분 생략' : ''}`;
      chips.querySelectorAll('button').forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.key === S.logFilter)));
      if (scroll) requestAnimationFrame(() => { box.scrollTop = box.scrollHeight; });
    };
    LOG_FILTERS.forEach(([key, label]) => chips.append(el('button', { type: 'button', 'data-key': key, text: label, onClick: () => { S.logFilter = key; draw(true); } })));
    select.addEventListener('change', () => { S.logDate = select.value; render(); });
    let timer;
    search.addEventListener('input', () => { clearTimeout(timer); timer = setTimeout(() => { S.logQuery = search.value; draw(true); }, 200); });
    const bottom = el('button', { type: 'button', class: 'small-button', text: '맨 아래로', onClick: () => { box.scrollTop = box.scrollHeight; } });
    draw(true);
    return [el('div', { class: 'controls' }, select, search), el('div', { class: 'controls' }, chips), el('div', { class: 'controls' }, count, el('span', { style: 'margin-left:auto' }, bottom)), box];
  }

  // ------------------------------------------------------------------ 시트 머리글 (열 글자 · 행 번호)
  const COL_LETTERS = (() => {
    const out = [];
    for (let i = 0; i < 26; i++) out.push(String.fromCharCode(65 + i));
    for (let i = 0; i < 26; i++) for (let j = 0; j < 26; j++) out.push(String.fromCharCode(65 + i) + String.fromCharCode(65 + j));
    return out;
  })();
  // 틀고정: 가로로 넘치는 표만 자체 스크롤 상자로 바꿉니다.
  //
  // 표 상자에 overflow 를 걸면 그 상자가 스크롤 컨테이너가 되어(한 축만
  // auto 로 둬도 나머지 축이 따라옵니다) 안쪽 sticky 가 시트가 아니라
  // 그 상자에 붙습니다. 그러면 열 이름줄이 아무 데도 고정되지 않습니다.
  // 그래서 넘치지 않는 표는 상자를 만들지 않고 시트 스크롤에 직접
  // 붙이고, 넘치는 표만 .wide 로 바꿔 상자 안에서 고정합니다.
  function markWideTables() {
    for (const wrap of $('#cells').querySelectorAll('.table-wrap')) {
      const table = wrap.firstElementChild;
      if (!table) continue;
      // .wide 가 붙어 있으면 이미 잘린 상태라 폭을 그대로 믿을 수 없습니다.
      // 표 자체 폭과 상자 폭을 비교하므로 클래스를 떼지 않고도 잽니다.
      const over = Math.round(table.scrollWidth) > Math.round(wrap.clientWidth) + 1;
      wrap.classList.toggle('wide', over);
      // 잘라낼 높이는 시트에 실제로 보이는 높이에서 잽니다. 화면 크기로
      // 계산하면 리본이 숨는 좁은 화면에서 어긋납니다.
      wrap.style.maxHeight = over ? Math.max(220, ($('#view').clientHeight || 600) - 64) + 'px' : '';
    }
  }

  function fillHeads() {
    const cells = $('#cells'), view = $('#view');
    if (!cells) return;
    markWideTables();
    const unit = (name, fallback) => parseFloat(css(name)) || fallback;
    const colW = unit('--col-w', 92), cellH = unit('--cell-h', 22);
    const cols = Math.min(COL_LETTERS.length, Math.max(1, Math.floor((cells.clientWidth || view.clientWidth || 900) / colW)));
    const head = $('#colhead');
    if (head.childElementCount !== cols + 1) {
      head.replaceChildren(
        ...COL_LETTERS.slice(0, cols).map((c, i) => el('span', { class: i === 0 ? 'on' : '', text: c })),
        el('span', { class: 'tail', text: COL_LETTERS[cols] || '' }));
    }
    const tall = Math.max(cells.scrollHeight || 0, cells.clientHeight || 0, view.clientHeight || 0);
    const need = Math.min(600, Math.ceil(tall / cellH) + 1);
    const gut = $('#rowhead');
    if (gut.childElementCount !== need) {
      const frag = document.createDocumentFragment();
      for (let i = 1; i <= need; i++) frag.append(el('span', { text: String(i) }));
      gut.replaceChildren(frag);
    }
  }

  // ------------------------------------------------------------------ 수식 입력줄 글자
  const SHEETS = {
    home: ['A1', '=STOCK.BRIEF(오늘)', '홈'],
    kr: ['A1', '=HOLDINGS("국내")', '국내'],
    us: ['A1', '=HOLDINGS("미국")', '미국'],
    perf: ['A1', '=SUMMARY(성과,세후)', '성과'],
    paper: ['A1', '=PAPER.COMPARE(자본금)', '가상'],
    logs: ['A1', '=LOG.TEXT(오늘)', '로그'],
  };
  function setFormulaBar() {
    const [name, formula, sheet] = SHEETS[S.tab] || SHEETS.home;
    $('#namebox').textContent = name;
    $('#formula').textContent = formula;
    $('#doc-title').textContent = 'stock_brief.xlsx';
    const n = S.data && S.data.generated_at ? (S.data.generated_at || '').slice(0, 10) : '';
    $('#status-left').textContent = n ? `준비   ${sheet} · ${n}` : '준비';
  }

  // ------------------------------------------------------------------ 렌더
  function render(keepScroll = false) {
    if (!S.data) return;
    const view = $('#view');
    const cells = $('#cells');
    const y = view.scrollTop;
    const logBox = cells.querySelector('.log');
    const logScroll = logBox ? logBox.scrollTop : null;
    const logAtBottom = logBox ? logBox.scrollTop + logBox.clientHeight >= logBox.scrollHeight - 30 : true;
    S.width = cells.clientWidth || window.innerWidth;
    document.querySelectorAll('.sheet-tabs button').forEach((b) => (b.dataset.tab === S.tab ? b.setAttribute('aria-current', 'page') : b.removeAttribute('aria-current')));
    const parts = { home: renderHome, kr: renderKR, us: renderUS, perf: renderPerf, paper: renderPaper, logs: renderLogs }[S.tab](S.data);
    const ticker = S.tab === 'home' ? null : tickerBar(S.data);   // 홈에는 전체 표가 있어 줄은 생략
    cells.replaceChildren(...(ticker ? [ticker] : []), ...parts);
    setFormulaBar();
    updateStamp();
    hideTip();
    requestAnimationFrame(fillHeads);
    if (keepScroll) {
      view.scrollTop = y;
      const box = cells.querySelector('.log');
      if (box && logScroll !== null && !logAtBottom) requestAnimationFrame(() => { box.scrollTop = logScroll; });
    }
  }

  // ------------------------------------------------------------------ 시작
  function applyTheme(theme) {
    if (theme === 'light' || theme === 'dark') document.documentElement.dataset.theme = theme;
    else delete document.documentElement.dataset.theme;
  }
  async function start() {
    try { applyTheme(localStorage.getItem('theme')); } catch (e) { /* 저장소 없음 */ }
    $('#login-form').addEventListener('submit', onLogin);
    $('#lock').addEventListener('click', lock);
    $('#stamp').addEventListener('click', () => refresh(true));
    $('#theme').addEventListener('click', () => {
      const dark = document.documentElement.dataset.theme ? document.documentElement.dataset.theme === 'dark' : matchMedia('(prefers-color-scheme: dark)').matches;
      const next = dark ? 'light' : 'dark';
      applyTheme(next);
      try { localStorage.setItem('theme', next); } catch (e) { /* 무시 */ }
      render(true);
    });
    document.querySelectorAll('.sheet-tabs button').forEach((b) => b.addEventListener('click', () => {
      S.tab = b.dataset.tab; render(); $('#view').scrollTop = 0;
    }));
    let resizeTimer, lastW = window.innerWidth;
    window.addEventListener('resize', () => {
      clearTimeout(resizeTimer);
      resizeTimer = setTimeout(() => {
        if (Math.abs(window.innerWidth - lastW) > 40) { lastW = window.innerWidth; render(true); } else fillHeads();
      }, 200);
    });
    document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible' && Date.now() - S.lastFetch > 60000) refresh(); });
    setInterval(() => {
      if (document.visibilityState !== 'visible' || !S.key) return;
      if (Date.now() - S.lastFetch >= POLL_MS) refresh(); else updateStamp();
    }, 30000);

    if (!window.crypto || !crypto.subtle) { showLogin('이 브라우저는 암호 기능(Web Crypto)을 지원하지 않습니다. https 주소로 열었는지 확인하세요.'); return; }
    try {
      S.cfg = await loadConfig();
    } catch (e) {
      showLogin(errorText(e)); return;
    }
    const saved = await recall();
    if (saved && saved.key && saved.expires > Date.now()) {
      try {
        const envelope = await fetchEnvelope();
        if (envelope.kdf && envelope.kdf.salt === saved.salt) {
          const data = await decrypt(envelope, saved.key);
          S.key = saved.key; S.salt = saved.salt;
          accept(envelope, data);
          return;
        }
        await forget();
        showLogin('확인용 비밀번호가 바뀌었습니다. 새 비밀번호를 입력하세요.');
        return;
      } catch (e) {
        if (e.message === 'KEY') await forget();
        showLogin(e.message === 'KEY' ? '비밀번호가 바뀌었습니다. 다시 입력하세요.' : errorText(e));
        return;
      }
    } else if (saved) {
      await forget();
    }
    showLogin();
  }
  start();
})();
