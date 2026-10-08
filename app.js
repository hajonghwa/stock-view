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
    assetMode: 'bot', assetPeriod: 'all',
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
  // [10-07] 숫자 표기 하나로 통일 (PC·텔레그램의 numfmt.py 와 같은 규칙).
  //   - 양수에 '+' 를 붙이지 않습니다. 방향은 색으로 보입니다(빨강 상승 · 파랑 하락, cls()).
  //   - 음수는 '−'(U+2212) 로 씁니다. 반올림해서 0 이 되면 부호를 붙이지 않습니다.
  //   - 차이는 'N%p 높음/낮음 (봇 기준)' 처럼 기준을 적습니다(gapText).
  // 화면에 나가는 숫자는 모두 아래 fmt* 를 거칩니다. 값이 없으면 '—'.
  const MINUS = '\u2212';            // '−' (U+2212). 일반 하이픈 '-' 과 헷갈리지 않게 코드로 적습니다.
  const NONE = '—';
  const isNum = (v) => typeof v === 'number' && Number.isFinite(v);
  const cls = (v) => (isNum(v) ? (v > 0 ? 'up' : v < 0 ? 'down' : '') : '');
  const neg = (v, text) => (v < 0 && /[1-9]/.test(text) ? MINUS : '');
  function fmtNum(v, d = 0, min = d) {
    if (!isNum(v)) return NONE;
    const text = Math.abs(v).toLocaleString('ko-KR', { minimumFractionDigits: min, maximumFractionDigits: d });
    return neg(v, text) + text;
  }
  const fmtWon = (v) => (isNum(v) ? `${fmtNum(v, 0)}원` : NONE);
  const fmtPct = (v, d = 2) => (isNum(v) ? `${fmtNum(v, d)}%` : NONE);
  const fmtPp = (v, d = 1) => (isNum(v) ? `${fmtNum(v, d)}%p` : NONE);
  function fmtUsd(v, d = 2) {
    if (!isNum(v)) return NONE;
    const text = Math.abs(v).toLocaleString('en-US', { minimumFractionDigits: d, maximumFractionDigits: d });
    return `${neg(v, text)}$${text}`;
  }
  const fmtMoney = (v, currency) => (currency === 'USD' ? fmtUsd(v) : fmtWon(v));
  const fmtPrice = (v, market) => (market === 'US' ? fmtUsd(v) : fmtNum(v, 0));
  const fmtQty = (v) => fmtNum(v, 6, 0);                       // 1 · 0.0612 · 0.3311 (소수 끝 0 없음)
  const fmtTimes = (v, d = 1) => (isNum(v) ? `${fmtNum(v, d)}배` : NONE);
  // 차이: gapText(-10.3) -> '10.3%p 낮음 (봇 기준)'. 같으면 '같음'.
  function gapText(diff, base = '봇 기준', d = 1) {
    if (!isNum(diff)) return NONE;
    const same = Math.abs(diff) < 0.5 * Math.pow(10, -d);
    const head = same ? '같음' : `${fmtNum(Math.abs(diff), d)}%p ${diff > 0 ? '높음' : '낮음'}`;
    return base ? `${head} (${base})` : head;
  }
  // 저장 사유의 단항 숫자 부호만 표시용으로 정리합니다. 날짜·12-1·전략 결합 '+'는 보존합니다.
  function tradeReasonText(value) {
    return String(value || '').replace(/(^|[\s·:：=(\[])\+(?=\d|\$\d)/g, '$1')
      .replace(/(^|[\s·:：=(\[])-(?=\d|\$\d)/g, '$1' + MINUS);
  }
  // 줄인 표기(축 눈금·작은 칸). step 을 주면 눈금 간격에 맞춰 소수 자리를 정합니다(148만·148만 처럼 겹쳐 보이지 않게).
  function fmtCompact(v, currency, step = 0) {
    if (!isNum(v)) return '';
    const a = Math.abs(v);
    if (currency === 'USD') {
      const body = a >= 1000 ? `${(a / 1000).toFixed(1)}K` : a.toFixed(a < 10 ? 2 : 0);
      return `${neg(v, body)}$${body}`;
    }
    const digits = (unit) => (step > 0 && step < unit ? Math.min(2, Math.max(0, Math.ceil(Math.log10(unit / step)))) : 0);
    let body;
    if (a >= 1e8) body = `${(a / 1e8).toFixed(step ? digits(1e8) : a >= 1e9 ? 0 : 1)}억`;
    else if (a >= 1e4) body = `${(a / 1e4).toLocaleString('ko-KR', { maximumFractionDigits: digits(1e4) })}만`;
    else body = Math.round(a).toLocaleString('ko-KR');
    return neg(v, body) + body;
  }
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
  // [10-07] 표 제목줄은 엑셀 행 한 칸 높이(틀고정 기준)라 두 줄이 되면 잘립니다.
  //   제목·부제목은 한 줄로 두고, 넘치면 부제목부터 말줄임(…)합니다(전체 글자는 title 로).
  //   휴대폰(≤560px)에서는 부제목을 제목줄 아래 따로 한 줄(.card-subline)로 보여 줘 잘리는 글자가 없습니다.
  function card(title, sub, ...body) {
    return el('article', { class: 'card' },
      el('div', { class: 'card-head' }, el('h2', { text: title, title }), sub ? el('span', { class: 'sub', text: sub, title: sub }) : null),
      sub ? el('div', { class: 'card-subline', text: sub }) : null,
      ...body);
  }
  // [10-07] 알림 띠. 'warn' = 노랑(국내 매매 꺼짐·점검), 'err' = 빨강(자료 오류).
  //   자료가 오래됐다는 안내(#stale)는 회색 띠로 따로 보입니다(style.css .stale-banner).
  function alertBox(level, title, ...lines) {
    return el('div', { class: `alert ${level}`, role: level === 'err' ? 'alert' : 'status' },
      el('span', { class: 'alert-icon', 'aria-hidden': 'true', text: '!' }),
      el('div', { class: 'alert-body' }, title ? el('div', { class: 'alert-title', text: title }) : null, ...lines));
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
        fmtCompact(t, currency, ticks.length > 1 ? Math.abs(ticks[1] - ticks[0]) : 0)));
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
      showTip(ev, fmtMoney(pts[i].y, currency), `${pts[i].x}${label ? ' · ' + label : ''}`);
    };
    hit.addEventListener('pointermove', move);
    hit.addEventListener('pointerdown', move);
    hit.addEventListener('pointerleave', () => { cross.setAttribute('visibility', 'hidden'); dot.setAttribute('visibility', 'hidden'); hideTip(); });
    host.append(root);
  }
  // Keep indicator indices attached to the same candle, including missing-price filtering.
  function chartWindow(bars, ma100 = [], hi60 = [], narrow = false) {
    let items = (bars || []).map((bar, i) => ({ bar, ma: (ma100 || [])[i], high: (hi60 || [])[i] }))
      .filter((p) => Array.isArray(p.bar) && isNum(p.bar[4]) && p.bar[4] > 0);
    if (narrow && items.length > 70) items = items.slice(-70);
    return { rows: items.map((p) => p.bar), ma100: items.map((p) => p.ma), hi60: items.map((p) => p.high) };
  }

  // 일봉 캔들 + 거래량 + PC가 보낸 매매선. bars = [[날짜, 시, 고, 저, 종, 거래량], ...]
  function candleChart(host, bars, { market = 'KR', avg = null, height = 260, label = '',
    ma100 = [], hi60 = [], levels = [], since = null, markers = [] } = {}) {
    host.replaceChildren();
    const view = chartWindow(bars, market === 'KR' ? ma100 : [], market === 'KR' ? hi60 : [], window.innerWidth < 720);
    const rows = view.rows;
    if (rows.length < 5) { host.append(empty('일봉이 아직 쌓이지 않았습니다. 채점이 한 번 돌면 보입니다.')); return; }
    // 좁은 화면에서는 봉이 너무 얇아져 최근 것만 보여 줍니다(이동평균은 잘린 구간부터 계산).
    const W = chartWidth(host), H = height, L = 8, R = 56, T = 8, GAP = 8;
    const volH = Math.round((H - T - 18) * 0.22);
    const priceH = H - T - 18 - volH - GAP;
    const highs = rows.map((b) => b[2]).filter(isNum);
    const lows = rows.map((b) => b[3]).filter(isNum);
    // 눈금은 보기 좋은 값으로 만들되 위아래를 눈금까지 늘리지 않습니다.
    // 늘리면 캔들이 화면 가운데 작게 뭉쳐 보입니다.
    const candleLo = Math.min(...lows, ...rows.map((b) => b[4]));
    const candleHi = Math.max(...highs, ...rows.map((b) => b[4]));
    const stopLevels = market === 'KR' ? (levels || []).filter((v) => v.key === 'stop' && isNum(v.price) && v.price > 0) : [];
    const stopsInRange = stopLevels.filter((v) => v.price >= candleLo * .75 && v.price <= candleHi * 1.25);
    const curveValues = [...view.ma100, ...view.hi60].filter((v) => isNum(v) && v > 0);
    const lo = Math.min(candleLo, ...curveValues, ...stopsInRange.map((v) => v.price), ...(isNum(avg) ? [avg] : []));
    const hi = Math.max(candleHi, ...curveValues, ...stopsInRange.map((v) => v.price), ...(isNum(avg) ? [avg] : []));
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
    const axisText = (v) => (market === 'US' ? fmtNum(v, 2) : fmtNum(v, 0));
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
    const curve = (values, klass, stepped) => {
      let path = '', previous = false;
      values.forEach((v, i) => {
        if (!isNum(v) || v <= 0) { previous = false; return; }
        const xx = cx(i).toFixed(1), yy = py(v).toFixed(1);
        path += previous ? (stepped ? `H${xx}V${yy}` : `L${xx},${yy}`) : `M${xx},${yy}`;
        previous = true;
      });
      if (path) root.append(svg('path', { d: path, class: klass }));
    };
    curve(view.ma100, 'ma100', false);
    curve(view.hi60, 'hi60', true);
    const levelTags = [];
    const stopLabels = svg('g', { class: 'stop-labels', 'pointer-events': 'none' });
    for (const level of stopLevels) {
      if (since && since > rows[rows.length - 1][0]) continue;
      const first = since ? rows.findIndex((b) => b[0] >= since) : 0;
      if (first < 0) continue;
      const text = `손절 ${fmtPrice(level.price, market)}`;
      if (!stopsInRange.includes(level)) {
        const last = rows[rows.length - 1][4], gap = (level.price / last - 1) * 100;
        levelTags.push(el('div', { class: 'offchart-level', text: `${text} ${gap < 0 ? '↓' : '↑'} 지금보다 ${fmtPct(Math.abs(gap), 1)} ${gap < 0 ? '아래' : '위'}` }));
        continue;
      }
      root.append(svg('line', { x1: cx(first), x2: W - R, y1: py(level.price), y2: py(level.price), class: 'stop-line' }));
      // Right-aligned inside the plot keeps the tag readable on phones.
      stopLabels.append(svg('text', { x: W - R - 24, y: Math.max(T + 12, Math.min(T + priceH - 3,
        py(level.price) + (Math.abs(py(level.price) - py(lastClose)) < 18 ? 15 : -5))),
        'text-anchor': 'end', class: 'stop-tag' }, text));
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
      root.append(svg('text', { x: L + 2, y: py(avg) - 6, class: 'avg-tag' }, `평단 ${fmtPrice(avg, market)}`));
    }
    const lastRow = rows[rows.length - 1];
    const upDay = rows.length > 1 && lastRow[4] >= rows[rows.length - 2][4];
    root.append(svg('rect', { x: W - R + 2, y: py(lastClose) - 8, width: R - 4, height: 16, rx: 3,
                              fill: upDay ? css('--up') : css('--down') }));
    root.append(svg('text', { x: W - R + 6, y: py(lastClose) + 4, class: 'last-tag', fill: '#fff' }, axisText(lastClose)));
    [0, rows.length - 1].forEach((i, n) => root.append(svg('text', { x: cx(i), y: H - 4, 'text-anchor': n === 0 ? 'start' : 'end' }, String(rows[i][0]).slice(2))));
    const cross = svg('line', { x1: 0, x2: 0, y1: T, y2: T + priceH + GAP + volH, class: 'cross', visibility: 'hidden' });
    const hit = svg('rect', { x: L, y: 0, width: span, height: H, class: 'hit' });
    // SVG draws in append order: keep labels above candles, without intercepting chart/marker taps.
    root.append(stopLabels, cross, hit);
    const move = (ev) => {
      const box = root.getBoundingClientRect();
      const px = ((ev.clientX - box.left) * W) / box.width;
      const i = Math.max(0, Math.min(rows.length - 1, Math.floor((px - L) / step)));
      const [day, o, h, l, c, v] = rows[i];
      cross.setAttribute('x1', cx(i)); cross.setAttribute('x2', cx(i)); cross.setAttribute('visibility', 'visible');
      const prev = i > 0 ? rows[i - 1][4] : null;
      const chg = isNum(prev) && prev > 0 ? (c / prev - 1) * 100 : null;
      showTip(ev, `${fmtPrice(c, market)} ${chg === null ? '' : fmtPct(chg, 2)}`,
        `${day} · 시 ${fmtPrice(o, market)} 고 ${fmtPrice(h, market)} 저 ${fmtPrice(l, market)}${isNum(v) ? ` · 거래량 ${fmtNum(v, 0)}` : ''}`
        + (isNum(view.ma100[i]) && view.ma100[i] > 0 ? ` · 100일선 ${fmtPrice(view.ma100[i], market)}원 (종가가 ${fmtPct(Math.abs((c / view.ma100[i] - 1) * 100), 1)} ${c >= view.ma100[i] ? '위' : '아래'})` : '')
        + (isNum(view.hi60[i]) ? ` · 신고가 기준 ${fmtPrice(view.hi60[i], market)}원` : ''));
    };
    hit.addEventListener('pointermove', move);
    hit.addEventListener('pointerdown', move);
    hit.addEventListener('pointerleave', () => { cross.setAttribute('visibility', 'hidden'); hideTip(); });
    const markerStacks = new Map();
    for (const marker of market === 'KR' ? (markers || []) : []) {
      const i = rows.findIndex((b) => b[0] === marker.date);
      if (i < 0 || !['BUY', 'SELL'].includes(marker.side)) continue;
      const buying = marker.side === 'BUY', stackKey = `${i}:${marker.side}`;
      const stack = markerStacks.get(stackKey) || 0;
      markerStacks.set(stackKey, stack + 1);
      const value = rows[i][buying ? 3 : 2];
      const yy = py(isNum(value) && value > 0 ? value : rows[i][4]) + (buying ? 11 + stack * 18 : -11 - stack * 18);
      const title = `${buying ? '매수' : '매도'} · ${String(marker.date).slice(5)} ${marker.time || ''} · ${fmtPrice(marker.price, market)}원 × ${fmtQty(marker.qty)}주`;
      const group = svg('g', { class: `trade-marker ${buying ? 'marker-buy' : 'marker-sell'}`, role: 'button', tabindex: '0', 'aria-label': title });
      const mark = buying ? `M${cx(i)},${yy - 5}l-5,9h10Z` : `M${cx(i)},${yy + 5}l-5,-9h10Z`;
      group.append(svg('path', { d: mark }), svg('rect', { x: cx(i) - 9, y: yy - 9, width: 18, height: 18, class: 'hit' }));
      const reason = tradeReasonText(marker.reason || marker.tag || '사유 기록 없음');
      const show = (ev) => { ev.stopPropagation(); showTip(ev, title, reason); };
      group.addEventListener('pointermove', show);
      group.addEventListener('pointerdown', show);
      group.addEventListener('pointerleave', hideTip);
      group.addEventListener('keydown', (ev) => {
        if (ev.key === 'Enter' || ev.key === ' ') {
          ev.preventDefault(); const box = group.getBoundingClientRect();
          showTip({ clientX: box.left, clientY: box.top }, title, reason);
        }
      });
      root.append(group);
    }
    host.append(root);
    put(host, ...levelTags);
    const swatch = (color, text) => el('span', {}, el('i', { class: 'line', style: `background:${color}` }), ' ', text);
    host.append(el('div', { class: 'legend' },
      swatch('#e8a33d', '5일선'), swatch(css('--accent'), '20일선'), swatch('#8a6fd6', '60일선'),
      view.ma100.some(isNum) ? swatch(css('--ma100'), '100일선') : null,
      view.hi60.some(isNum) ? swatch(css('--hi60'), '60일 신고가 기준') : null,
      stopLevels.length ? swatch(css('--down'), '손절선') : null,
      market === 'KR' && (markers || []).some((m) => rows.some((b) => b[0] === m.date)) ? el('span', {},
        el('span', { class: 'marker-buy', text: '▲ 매수' }), ' ', el('span', { class: 'marker-sell', text: '▼ 매도' })) : null,
      el('span', { class: 'muted', text: `${rows.length}봉 · ${rows[0][0]} ~ ${lastRow[0]}` })));
  }

  // Pure calculations: use actual recorded values; never adjust suspected cash flows.
  function comparePoints(points) {
    return (points || []).filter((p) => p && /^\d{4}-\d{2}-\d{2}$/.test(p.date)
      && isNum(p.bot) && p.bot > 0 && isNum(p.kospi) && p.kospi > 0).slice().sort((a, b) => a.date.localeCompare(b.date));
  }
  function rebase(points) {
    const data = comparePoints(points);
    if (!data.length) return [];
    const base = data[0];
    return data.map((p) => ({ date: p.date, bot: p.bot / base.bot * 100, kospi: p.kospi / base.kospi * 100 }));
  }
  function yearDrawdown(points) {
    let year = '', botPeak = 0, kospiPeak = 0;
    return comparePoints(points).map((p) => {
      const next = p.date.slice(0, 4);
      if (next !== year) { year = next; botPeak = p.bot; kospiPeak = p.kospi; }
      botPeak = Math.max(botPeak, p.bot); kospiPeak = Math.max(kospiPeak, p.kospi);
      return { date: p.date, bot: (p.bot / botPeak - 1) * 100, kospi: (p.kospi / kospiPeak - 1) * 100 };
    });
  }
  function flowSuspect(points) {
    const data = comparePoints(points);
    return data.filter((p, i) => i > 0 && Math.abs((p.bot / data[i - 1].bot - 1) * 100) > 10
      && Math.abs((p.kospi / data[i - 1].kospi - 1) * 100) <= 3).map((p) => p.date);
  }
  function yearlyCompare(points) {
    const data = comparePoints(points), dd = yearDrawdown(data), years = [...new Set(data.map((p) => p.date.slice(0, 4)))];
    return years.map((year) => {
      const part = data.filter((p) => p.date.startsWith(year)), end = part[part.length - 1];
      const start = data.findIndex((p) => p.date === part[0].date);
      const base = start > 0 ? data[start - 1] : part[0];
      const falls = dd.filter((p) => p.date.startsWith(year));
      const bot = (end.bot / base.bot - 1) * 100, kospi = (end.kospi / base.kospi - 1) * 100;
      return { year, bot, kospi, gap: bot - kospi, botDD: Math.min(...falls.map((p) => p.bot)),
        kospiDD: Math.min(...falls.map((p) => p.kospi)), first: part[0].date, last: end.date };
    });
  }
  function compareCutoff(end, period) {
    if (period === 'year') return `${end.slice(0, 4)}-01-01`;
    const date = new Date(`${end}T00:00:00Z`), day = date.getUTCDate();
    date.setUTCDate(1);
    date.setUTCMonth(date.getUTCMonth() - (period === '3m' ? 3 : 1));
    const lastDay = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + 1, 0)).getUTCDate();
    date.setUTCDate(Math.min(day, lastDay));
    return date.toISOString().slice(0, 10);
  }
  function compareWindow(points, period) {
    const data = comparePoints(points);
    if (!data.length || period === 'all') return data;
    const cutoff = compareCutoff(data[data.length - 1].date, period);
    return data.filter((p) => p.date >= cutoff);
  }
  function compareChart(host, points, suspected, drawdown = false) {
    host.replaceChildren();
    if (points.length < 2) { host.append(empty('그래프를 그릴 자료가 아직 부족합니다')); return; }
    const W = chartWidth(host), H = drawdown ? 90 : 200, L = 40, R = drawdown ? 12 : 49, T = 15, B = 23;
    const values = points.flatMap((p) => [p.bot, p.kospi]);
    const ticks = niceTicks(Math.min(...values, drawdown ? 0 : 100), Math.max(...values, drawdown ? 0 : 100), drawdown ? 2 : 4);
    const min = ticks[0], max = ticks[ticks.length - 1];
    const x = (i) => L + i * (W - L - R) / (points.length - 1);
    const y = (v) => T + (max - v) * (H - T - B) / (max - min || 1);
    const root = svg('svg', { viewBox: `0 0 ${W} ${H}`, role: 'img', 'aria-label': drawdown ? '그 해 안 최고 대비 하락' : '봇 vs 코스피 · 첫 기록 100' });
    for (const tick of ticks) {
      root.append(svg('line', { x1: L, x2: W - R, y1: y(tick), y2: y(tick), class: tick === (drawdown ? 0 : 100) ? 'axis-line' : 'grid-line' }));
      root.append(svg('text', { x: L - 5, y: y(tick) + 4, 'text-anchor': 'end' }, drawdown ? fmtPct(tick, 0) : fmtNum(tick, 0)));
    }
    if (drawdown) {
      const width = Math.max(1, Math.min(12, (W - L - R) / points.length * .7));
      points.forEach((p, i) => root.append(svg('rect', { x: x(i) - width / 2, y: y(0), width,
        height: Math.max(0, y(p.bot) - y(0)), class: 'bar-down' })));
    }
    for (const key of drawdown ? ['kospi'] : ['bot', 'kospi']) {
      const path = points.map((p, i) => `${i ? 'L' : 'M'}${x(i).toFixed(1)},${y(p[key]).toFixed(1)}`).join('');
      root.append(svg('path', { d: path, class: key === 'bot' ? 'series' : 'index-series' }));
      if (!drawdown) {
        const last = points[points.length - 1], difference = Math.abs(y(last.bot) - y(last.kospi));
        const shift = difference < 13 ? (key === 'bot' ? -7 : 7) : 0;
        root.append(svg('text', { x: W - R + 4, y: Math.max(T, Math.min(H - B, y(last[key]) + shift)) + 4,
          class: key === 'bot' ? 'bot-value' : 'index-value' }, fmtNum(last[key], 1)));
      }
    }
    if (!drawdown) points.forEach((p, i) => {
      if (!suspected.includes(p.date)) return;
      const show = (ev) => showTip(ev, p.date, '예산 변경·입출금 의심 — 확인 필요');
      const group = svg('g', { class: 'flow-flag', role: 'button', 'aria-label': '예산 변경·입출금 의심 — 확인 필요' });
      group.append(svg('text', { x: x(i), y: Math.max(12, y(p.bot) - 9), 'text-anchor': 'middle' }, '!'),
        svg('rect', { x: x(i) - 9, y: Math.max(0, y(p.bot) - 22), width: 18, height: 22, class: 'hit' }));
      group.addEventListener('pointerdown', show); group.addEventListener('pointermove', show); group.addEventListener('pointerleave', hideTip);
      root.append(group);
    });
    [0, points.length - 1].forEach((i, n) => root.append(svg('text', { x: x(i), y: H - 5, 'text-anchor': n === 0 ? 'start' : 'end' }, points[i].date.slice(5))));
    const cross = svg('line', { x1: 0, x2: 0, y1: T, y2: H - B, class: 'cross', visibility: 'hidden' });
    const hit = svg('rect', { x: L, y: 0, width: W - L - R, height: H, class: 'hit' });
    const move = (ev) => {
      const box = root.getBoundingClientRect(), px = (ev.clientX - box.left) * W / box.width;
      const i = Math.max(0, Math.min(points.length - 1, Math.round((px - L) * (points.length - 1) / (W - L - R)))), p = points[i];
      cross.setAttribute('x1', x(i)); cross.setAttribute('x2', x(i)); cross.setAttribute('visibility', 'visible');
      if (!drawdown && suspected.includes(p.date)) {
        showTip(ev, p.date, '예산 변경·입출금 의심 — 확인 필요');
      } else if (drawdown) {
        showTip(ev, p.date, `그 해 안 최고 대비 · 봇 ${fmtPct(Math.abs(p.bot), 1)} 하락 · 코스피 ${fmtPct(Math.abs(p.kospi), 1)} 하락`);
      } else {
        showTip(ev, `${p.date.slice(5)} · 봇 ${fmtNum(p.bot, 1)} (${fmtPct(p.bot - 100, 1)})`,
          `코스피 ${fmtNum(p.kospi, 1)} (${fmtPct(p.kospi - 100, 1)}) · 봇이 ${gapText(p.bot - p.kospi, '코스피 기준')}`);
      }
    };
    root.append(cross, hit);
    hit.addEventListener('pointerdown', move); hit.addEventListener('pointermove', move);
    hit.addEventListener('pointerleave', () => { cross.setAttribute('visibility', 'hidden'); hideTip(); });
    host.append(root);
    if (drawdown) {
      const worst = points.reduce((a, p) => p.bot < a.bot ? p : a);
      const indexWorst = points.reduce((a, p) => p.kospi < a.kospi ? p : a);
      put(host, el('div', { class: 'drawdown-caption', text: `보이는 기간 · 봇 ${fmtPct(Math.abs(worst.bot), 1)} 하락 (${worst.date.slice(5)}) · 코스피 ${fmtPct(Math.abs(indexWorst.kospi), 1)} 하락 (${indexWorst.date.slice(5)})` }));
    }
  }
  function assetCompareCard(kr) {
    const data = comparePoints(kr.vs_index), body = el('div', { class: 'asset-compare' });
    const article = card('봇 vs 코스피', '입출금 자동 보정 없음', body);
    const draw = () => {
      body.replaceChildren();
      const mode = el('div', { class: 'chips asset-controls', role: 'group', 'aria-label': '자산 차트 종류' });
      for (const [key, name] of [['bot', '봇 vs 코스피'], ['account', '계좌 총액']]) {
        put(mode, el('button', { type: 'button', text: name, 'aria-pressed': String(S.assetMode === key), onClick: () => { S.assetMode = key; draw(); } }));
      }
      put(body, mode);
      if (S.assetMode === 'account') {
        const host = el('div', { class: 'chart' });
        put(body, el('div', { class: 'chart-note', text: '입금·직접 산 종목 포함 · 봇 성과 아님' }), host);
        queueMicrotask(() => lineChart(host, (kr.equity || []).map((p) => ({ x: p.date, y: p.value })), { currency: 'KRW', label: '계좌 자산' }));
        return;
      }
      if (data.length < 2) { put(body, empty('그래프를 그릴 자료가 아직 부족합니다')); return; }
      const periods = el('div', { class: 'chips asset-controls', role: 'group', 'aria-label': '자산 차트 기간' });
      const isAvailable = (key) => compareWindow(data, key).length > 1 &&
        (key === 'year' || key === 'all' || data[0].date <= compareCutoff(data[data.length - 1].date, key));
      if (!isAvailable(S.assetPeriod)) S.assetPeriod = 'all';
      for (const [key, name] of [['1m', '1개월'], ['3m', '3개월'], ['year', '올해'], ['all', '전체']]) {
        const available = isAvailable(key);
        put(periods, el('button', { type: 'button', text: name, disabled: !available, 'aria-pressed': String(S.assetPeriod === key),
          onClick: () => { S.assetPeriod = key; draw(); } }));
      }
      const visible = compareWindow(data, S.assetPeriod), normalized = rebase(visible), last = normalized[normalized.length - 1];
      const falls = yearDrawdown(data).filter((p) => visible.some((v) => v.date === p.date));
      const host = el('div', { class: 'chart' }), ddHost = el('div', { class: 'chart' });
      put(body, periods, el('div', { class: 'compare-summary', text: `${visible[0].date.slice(5)} 이후 · 봇 ${fmtPct(last.bot - 100, 1)} · 코스피 ${fmtPct(last.kospi - 100, 1)} · 봇이 ${gapText(last.bot - last.kospi, '코스피 기준')}` }),
        host, el('div', { class: 'legend compare-legend' }, el('span', { class: 'bot-value', text: '━ 봇' }), el('span', { class: 'index-value', text: '━ 코스피' }),
          el('span', { class: 'muted', text: '기간 첫 기록 = 100' })),
        el('div', { class: 'chart-note', text: '그 해 안 최고 대비 하락 · 해가 바뀌면 최고값을 새로 계산' }), ddHost,
        el('div', { class: 'yearly-compare' }, dense([
          { label: '연도', lead: true, cell: (r) => r.year },
          { label: '봇 수익률', right: true, cell: (r) => fmtPct(r.bot, 1) },
          { label: '코스피', right: true, cell: (r) => fmtPct(r.kospi, 1) },
          { label: '차이', right: true, cell: (r) => gapText(r.gap, '') },
          { label: '봇 최대 하락', right: true, cell: (r) => `${fmtPct(Math.abs(r.botDD), 1)} 하락` },
          { label: '코스피 최대 하락', right: true, cell: (r) => `${fmtPct(Math.abs(r.kospiDD), 1)} 하락` },
        ], yearlyCompare(data))),
        el('div', { class: 'chart-note', text: `연도별 수익률·하락은 전체 기록 기준 · 첫해 ${data[0].date}부터 · 마지막 해 ${data[data.length - 1].date}까지` }));
      queueMicrotask(() => { compareChart(host, normalized, flowSuspect(data)); compareChart(ddHost, falls, [], true); });
    };
    draw();
    return article;
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
      const full = currency === 'USD' ? fmtUsd(r.value) : fmtNum(r.value, 0);
      root.append(svg('text', { x: tx, y: cy + 4, 'text-anchor': r.value >= 0 ? 'start' : 'end', class: 'value-ink' }, full.length <= 9 ? full : fmtCompact(r.value, currency)));
      const hit = svg('rect', { x: 0, y: cy - rowH / 2, width: W, height: rowH, class: 'hit' });
      hit.addEventListener('pointermove', (ev) => showTip(ev, fmtMoney(r.value, currency), `${r.name} · ${r.sub}`));
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
        const text = fmtCompact(c.value, currency);
        if (text.length * 7 + 8 < cw) root.append(svg('text', { x: L + c.col * cw + cw / 2, y: T + c.row * cellH + cellH - 9, 'text-anchor': 'middle', class: 'value-ink', style: ink }, text));
      }
      if (!c.blank) {
        rect.addEventListener('pointermove', (ev) => showTip(ev, isNum(c.value) ? fmtMoney(c.value, currency) : '매도 없음', c.label));
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
    const kr = d.kr || {}, us = d.us || {}, rules = d.rules || {};
    // [09-28 화면 정리] 혼합1은 예전 국면 점수를 쓰지 않습니다.
    // [10-07] 국내도 시장 필터가 있습니다(10-01 결정: 주간 점검 날 코스피 < 60일선이면 그 주 신규 매수 멈춤).
    //   판정은 주간 점검 때 장부(kr_h1_book.json)에 남긴 값을 그대로 씁니다. 미국은 동일가중 지수 100일선 필터.
    const mk = rules.kr_h1 ? krMarket(d.kr_h1) : null;
    return el('div', { class: 'pills' },
      pill('국내 매매', st.kr_trading), pill('미국 매매', st.us_trading),
      rules.kr_h1 ? (mk ? el('span', { class: `pill ${mk.state === 'block' ? 'paused' : mk.state === 'ok' ? 'on' : ''}`, title: mk.text }, el('span', { class: 'dot' }), mk.short) : null)
        : el('span', { class: 'pill' }, `국내 국면 ${isNum(kr.regime) ? kr.regime : '?'}/3`),
      rules.us_h1 ? usMarketPill(us) : el('span', { class: 'pill' }, `미국 국면 ${isNum(us.regime) ? us.regime : '?'}/2`));
  }
  // [10-07] 국내 시장 필터 판정(주간 점검 때 장부에 남긴 값). 모르면 null.
  //   { state: 'ok' | 'block' | 'off', short: 알약 글자, text: '코스피 … → 이번 주 새로 삼', when: '10-05 점검' }
  function krMarket(plan) {
    if (!plan || !plan.week) return null;
    const when = plan.day ? `${String(plan.day).slice(5)} 점검` : '';
    if (plan.market_days === 0) return { state: 'off', short: '국내 시장 필터 꺼짐', text: '코스피와 관계없이 새로 삼', when };
    if (plan.market_block !== true && plan.market_block !== false) return null;     // 10-01 이전 장부
    const block = plan.market_block;
    let where = plan.market || '';
    if (isNum(plan.market_index) && isNum(plan.market_ma) && isNum(plan.market_gap)) {
      where = `코스피 ${fmtNum(plan.market_index, 0)} · ${plan.market_ma_days}일선 ${fmtNum(plan.market_ma, 0)}보다 `
        + `${fmtPct(Math.abs(plan.market_gap), 1)} ${plan.market_gap >= 0 ? '위' : '아래'}`;
    }
    const verdict = block ? '이번 주 새로 사지 않음 (매도·손절은 그대로)' : '이번 주 새로 삼';
    return { state: block ? 'block' : 'ok', short: `국내 시장 필터 ${block ? '신규 매수 멈춤' : '매수 가능'}`,
             text: where ? `${where} → ${verdict}` : verdict, when };
  }
  function krMarketLine(plan) {
    const mk = krMarket(plan);
    if (!mk) return null;
    return el('div', { class: `mline ${mk.state}` }, el('span', { class: 'dot', 'aria-hidden': 'true' }),
      el('span', {}, el('b', { text: '국내 시장 필터' }), ` · ${mk.text}`, mk.when ? [' · ', el('span', { class: 'muted nowrap', text: mk.when })] : null));
  }
  // 다음 국내 종가 매매 시각. 주말을 건너뛰고, 오늘이 휴장일인지는 PC 프로그램이 달력으로 확인한 값(openToday)을 씁니다.
  // 다음 날 이후의 공휴일은 알 수 없어 평일로 봅니다.
  function nextClose(hm, openToday = null) {
    const now = kstNow();
    const day = new Date(`${now.date}T00:00:00Z`);
    const wd = day.getUTCDay();
    if (wd >= 1 && wd <= 5 && now.hm < hm && openToday !== false) return `오늘 ${hm}`;
    do { day.setUTCDate(day.getUTCDate() + 1); } while (day.getUTCDay() === 0 || day.getUTCDay() === 6);
    return `${day.toISOString().slice(5, 10)}(${'일월화수목금토'[day.getUTCDay()]}) ${hm}`;
  }
  const stampText = (iso, today) => (String(iso).slice(0, 10) === today ? String(iso).slice(11, 16) : `${String(iso).slice(5, 10)} ${String(iso).slice(11, 16)}`);
  // [10-07 P1] 국내 매매가 꺼져 있으면 홈 맨 위에 가장 크게 보여 줍니다(재시작 뒤 /kr_on 을 잊는 일이 잦음).
  function krOffAlert(d) {
    const st = d.status || {};
    if (st.kr_trading !== false) return null;
    const today = kstNow().date;
    const off = Date.parse(st.kr_off_since), start = Date.parse(st.started_at);
    const grace = Math.max(600, (d.interval_sec || 300) * 2) * 1000;
    let since = '';
    if (Number.isFinite(off) && Number.isFinite(start) && off - start <= grace) since = `프로그램 재시작(${stampText(st.started_at, today)}) 뒤 아직 켜지 않음`;
    else if (Number.isFinite(off)) since = `${stampText(st.kr_off_since, today)}쯤부터 꺼짐`;
    const context = [since, `다음 종가 매매 ${nextClose(st.close_time || '15:18', (d.generated_at || '').slice(0, 10) === today ? st.kr_trading_day : null)}`].filter(Boolean).join(' · ');
    const us = st.us_trading ? [st.us_auto ? '미국은 켜짐(자동)' : '미국은 켜짐']
      : ['미국도 꺼짐 · ', el('kbd', { text: '/us_on' })];
    return alertBox('warn kroff', '국내 매매 꺼짐',
      el('div', { class: 'alert-line', text: context }),
      el('div', { class: 'alert-line' }, el('span', { class: 'alert-do' }, '켜기: 텔레그램 ', el('kbd', { text: '/kr_on' })), ' · ', ...us));
  }
  // [10-07 P1] 총자산 아래 '오늘' 한 줄: 계좌 vs 코스피, 오늘 실현손익, 매도·매수 건수, 비용.
  function todayLine(d) {
    const t = d.kr_today;
    if (!t || !t.date) return null;
    const trades = (t.sells || 0) + (t.buys || 0);
    const showRate = isNum(t.rate) && (isNum(t.kospi) || trades > 0);     // 휴장일엔 0% 를 굳이 보이지 않습니다
    if (!showRate && !trades) return null;
    const seg = (label, value, tone = '') => el('span', { class: 'tl-seg' }, el('span', { class: 'k', text: label }), ' ', el('b', { class: `num ${tone}`, text: value }));
    const head = el('span', { class: 'tl-head', text: t.date === kstNow().date ? '오늘' : String(t.date).slice(5) });
    const first = [];
    if (showRate) {
      first.push(seg(t.base === 'stocks' ? '계좌(주식 손익만)' : '계좌', `${fmtPct(t.rate, 2)}${isNum(t.change) ? ` (${fmtWon(t.change)})` : ''}`, cls(t.rate)));
      if (isNum(t.kospi)) first.push(seg('코스피', fmtPct(t.kospi, 2), cls(t.kospi)));
      if (isNum(t.gap)) first.push(seg('코스피와 차이 (봇 기준)', gapText(t.gap, ''), cls(t.gap)));
    }
    const second = [];
    if (t.known > 0 && isNum(t.realized)) second.push(seg('실현손익', fmtWon(t.realized), cls(t.realized)));
    if (trades) second.push(seg('체결', `매도 ${fmtNum(t.sells || 0)}건 · 매수 ${fmtNum(t.buys || 0)}건`));
    if (isNum(t.cost) && t.cost > 0) second.push(seg('비용', fmtWon(t.cost)));
    return el('div', { class: 'today-line' }, head,
      first.length ? el('div', { class: 'tl-row' }, first) : null,
      second.length ? el('div', { class: 'tl-row' }, second) : null);
  }
  function usMarketPill(us) {
    // [09-29 로그 점검] 시장 필터를 끈 상태(US_H1_MARKET_FILTER=False)에서는 지수가 100일선 아래여도
    // 새로 삽니다. 지수 위치(market_now)만 보고 '멈춤' 이라 쓰면 틀립니다 → 계획의 실제 판정(market_ok)을 씁니다.
    const h1 = us.h1 || {};
    if (h1.market_filter === false) return el('span', { class: 'pill', title: h1.market_desc || '' }, '미국 시장 필터 꺼짐');
    const ok = h1.market_ok;
    return el('span', { class: 'pill', title: h1.market_desc || '' },
      `미국 시장 필터 ${ok === true ? '매수 가능' : ok === false ? '신규 매수 멈춤' : '?'}`);
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
    if (!isNum(row.price)) return NONE;
    const digits = Math.abs(row.price) >= 1000 ? 0 : 2;
    return row.currency === 'USD' ? fmtUsd(row.price, digits) : fmtNum(row.price, digits);
  }
  function tickerBar(d) {
    const rows = ((d.brief || {}).items || []).filter((r) => isNum(r.price));
    if (!rows.length) return null;
    return el('div', { class: 'ticker', role: 'list', 'aria-label': '시장 지표' },
      rows.map((r) => el('div', { class: `tk ${r.stale ? 'old' : ''}`, role: 'listitem', title: `${r.as_of || ''}${r.stale ? ' · 갱신 실패, 직전 값' : ''}` },
        el('b', { text: r.label }),
        el('span', { class: 'v', text: briefValue(r) }),
        el('span', { class: `c ${cls(r.change)}`, text: fmtPct(r.change, 2) }))));
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
        { label: '일간', right: true, tone: (r) => cls(r.change), cell: (r) => fmtPct(r.change, 2) },
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
      queueMicrotask(() => candleChart(host, entry ? entry.bars : [], { market, avg: hold ? hold.avg : null, label: `${name} 일봉`,
        ma100: entry ? entry.ma100 : [], hi60: entry ? entry.hi60 : [], markers: entry ? entry.markers : [],
        levels: hold && hold.source === 'core' ? hold.levels : [], since: hold ? hold.since : null }));
      if (market === 'KR' && hold && hold.source !== 'manual' && (hold.levels || []).length) {
        put(body, el('div', { class: 'price-levels' }, dense([
          { label: '선 이름', lead: true, cell: (v) => v.label },
          { label: '가격', right: true, cell: (v) => `${fmtPrice(v.price)}원` },
          { label: '지금가 대비', right: true, cell: (v) => {
            if (!isNum(v.price) || !isNum(hold.price) || hold.price <= 0) return '—';
            const gap = (v.price / hold.price - 1) * 100;
            return `지금보다 ${fmtPct(Math.abs(gap), 1)} ${gap < 0 ? '아래' : gap > 0 ? '위' : '같음'}`;
          } },
        ], hold.levels.filter((v) => isNum(v.price) && v.price > 0))));
      }
    } else if (S.sub === 'rule') {
      if (!hold) put(body, empty('보유 중인 종목이 아닙니다. 매도 규칙은 보유할 때만 계산합니다.'));
      else if (market === 'KR') {
        put(body, el('dl', { class: 'kv' },
          el('dt', { text: '경로' }), el('dd', { text: { core: '모멘텀', watch: '눌림목', manual: '직접 매수' }[hold.source] || '—' }),
          el('dt', { text: '수익률' }), el('dd', { class: cls(rate), text: fmtPct(rate) })),
          hold.source === 'manual' ? el('div', { class: 'meter-text', text: '직접 매수 · 봇이 팔지 않습니다' }) : exitMeter(hold.exit),
          hold.target ? el('div', { class: 'meter-text' }, el('span', { text: `위쪽: ${hold.target.label} ${fmtPrice(hold.target.price)}` }), el('span', { class: 'num', text: fmtPct(hold.target.gap, 1) })) : null);
      } else {
        put(body, el('dl', { class: 'kv' },
          el('dt', { text: '구분' }), el('dd', { text: hold.bot ? (hold.kind || '모멘텀') : '수동 보유' }),
          el('dt', { text: '수익률' }), el('dd', { class: cls(rate), text: fmtPct(rate) }),
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
        { label: '수량', right: true, cell: (t) => fmtQty(t.qty) },
        { label: '단가', right: true, cell: (t) => fmtPrice(t.price, market) },
        { label: '손익', right: true, tone: (t) => cls(t.realized), cell: (t) => (isNum(t.realized) ? fmtMoney(t.realized, perf.currency) : '') },
        { label: '사유', cell: (t) => t.tag || '' },
      ], mine.slice(0, 40)) : empty('이 종목의 체결 기록이 없습니다'));
    } else {
      const facts = [];
      const push = (k, v) => { if (v !== null && v !== undefined && v !== '') facts.push(el('dt', { text: k }), el('dd', { text: v })); };
      if (hold) {
        push('현재가', fmtPrice(hold.price, market)); push('평단', fmtPrice(hold.avg, market));
        push('수량', isNum(hold.qty) ? String(hold.qty) : null);
        push('평가손익', fmtMoney(market === 'US' ? hold.pnl : hold.pl, market === 'US' ? 'USD' : 'KRW'));
      }
      if (watch) {
        push('관찰 방식', watch.mode); push('점수', watch.score); push('진입선', fmtPrice(watch.entry));
        push('전일종가', fmtPrice(watch.prev_close)); push('고점대비', fmtPct(watch.drop, 1));
        push('거래량', isNum(watch.vol) ? fmtTimes(watch.vol, 2) : null);
        push('수급', watch.supply); push('재무', watch.fund);
      }
      if (rank) { push('모멘텀 점수', rank.score); push('RSI', isNum(rank.rsi) ? fmtNum(rank.rsi, 0) : null); push('거래량비', isNum(rank.udv) ? fmtNum(rank.udv, 2) : null); }
      if (cand) { push('미국 점수', cand.score); push('RSI', isNum(cand.rsi) ? fmtNum(cand.rsi, 0) : null); push('roc_skip', fmtPct(cand.roc_skip, 1)); push('거래량', isNum(cand.vol) ? fmtTimes(cand.vol, 2) : null); }
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
    // 맨 위: 국내 매매 꺼짐(노랑, 가장 큼) → 자료 오류(빨강) → 점검(노랑, 작게). 오래된 자료 안내는 회색 띠(#stale).
    const off = krOffAlert(d);
    if (off) out.push(off);
    if (d.errors && d.errors.length) out.push(alertBox('err', '일부 자료를 만들지 못했습니다', el('div', { class: 'alert-line', text: d.errors.join(', ') })));
    (d.health || []).filter((h) => !(off && h.key === 'kr_off'))
      .forEach((h) => out.push(alertBox('warn small', null, el('div', { class: 'alert-line', text: `[점검] ${h.message}` }))));
    const today = todayLine(d);
    const hero = card('총자산', '국내 계좌 · 예수금 포함',
      el('div', { class: 'hero num', text: sum ? fmtWon(sum.total) : NONE }),
      sum ? el('div', { class: 'hero-sub' },
        el('span', { class: cls(sum.pl), text: `평가손익 ${fmtWon(sum.pl)} (${fmtPct(sum.pl_rate)})` }),
        // '오늘' 한 줄이 있으면 오늘 값은 거기에만 둡니다(같은 화면에 서로 다른 '오늘' 이 둘 보이지 않게).
        today ? null : [' · ', el('span', { class: cls(sum.day), text: `오늘 ${fmtWon(sum.day)} (${fmtPct(sum.day_rate)})` })]) : empty('보유 조회 전입니다'),
      today,
      isNum(us.value) ? el('div', { class: 'muted', style: 'margin-top:6px' }, `미국 ${fmtUsd(us.value)} · 손익 `, el('span', { class: cls(us.pnl), text: fmtUsd(us.pnl) })) : null,
      el('div', { style: 'margin-top:10px' }, statusPills(d)),
      (d.rules || {}).kr_h1 ? krMarketLine(d.kr_h1) : null,
      d.status && d.status.us_status ? el('div', { class: 'muted', style: 'font-size:12.5px;margin:4px 0 6px', text: `미국 상태: ${d.status.us_status}` }) : null);
    out.push(hero);
    const t = d.today;
    if (!t) { out.push(missing('오늘 할 일')); return out; }
    // 국내 매매 꺼짐은 맨 위 알림에 이미 크게 있으므로 '지금 확인' 목록에서는 뺍니다.
    const urgent = (t.urgent || []).filter((r) => !(off && r.kind === 'info' && r.market === '국내' && /매매가 꺼져/.test(r.title || '')));
    const now = kstNow();
    const sameDay = (d.generated_at || '').slice(0, 10) === now.date;
    const plan = (t.schedule || []).map((p) => ({ ...p, done: sameDay ? p.time <= now.hm : p.done }));
    const next = plan.find((p) => !p.done);
    out.push(el('div', { class: 'grid two' },
      card('지금 확인', `${urgent.length}건`, itemList(urgent, '확인할 것이 없습니다')),
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
  // [10-07] 매도선(손절선)까지 남은 거리의 경고 단계. 혼합1 손절은 고점 대비 −20%.
  //   5% 안 = 'hot'(빨간 바탕) · 13% 안 = 'near'(노란 바탕). 글자색(빨강=상승)과 헷갈리지 않게 바탕색으로 표시합니다.
  const stopLevel = (gap) => (!isNum(gap) ? '' : Math.abs(gap) < 5 ? 'hot' : Math.abs(gap) < 13 ? 'near' : '');
  function stopCell(exit, unmanaged = false) {
    if (unmanaged) return el('span', { class: 'muted', text: '봇 미관리' });
    if (!exit || !isNum(exit.gap)) return NONE;
    const level = stopLevel(exit.gap);
    return [el('span', { class: `gap ${level}`, text: fmtPct(exit.gap, 1), title: `${exit.label || '매도선'} ${fmtPrice(exit.price)}`,
                         'aria-label': `${exit.label || '매도선'}까지 ${fmtPct(exit.gap, 1)}${level === 'hot' ? ' · 가까움' : level === 'near' ? ' · 주의' : ''}` }),
      exit.label ? el('span', { class: 'gap-label', text: ` ${exit.label}` }) : null];
  }
  function exitMeter(exit, market) {
    if (!exit) return null;
    const gap = exit.gap;
    const closeness = Math.max(0, Math.min(1, 1 - Math.abs(gap) / 20));
    const level = stopLevel(gap);
    return el('div', { class: 'meter' },
      el('div', { class: `meter-bar ${level}`, role: 'meter', 'aria-valuemin': 0, 'aria-valuemax': 100, 'aria-valuenow': Math.round(closeness * 100), 'aria-label': '매도선까지 거리' },
        el('span', { style: `width:${(closeness * 100).toFixed(0)}%` })),
      el('div', { class: 'meter-text' }, el('span', { text: `${exit.label} ${fmtPrice(exit.price, market)}` }), el('span', { class: 'num', text: `${fmtPct(gap, 1)}` })));
  }
  function renderKR(d) {
    const kr = d.kr;
    if (!kr) return [missing('국내 계좌')];
    const out = [];
    const s = kr.summary;
    out.push(el('div', { class: 'tiles' },
      tile('총자산', s ? fmtWon(s.total) : '—', s ? `주식 ${fmtCompact(s.eval)} · 현금 ${fmtCompact(s.cash)}` : ''),
      tile('평가손익', s ? fmtWon(s.pl) : '—', s ? fmtPct(s.pl_rate) : '', s ? cls(s.pl) : ''),
      tile('오늘 손익', s ? fmtWon(s.day) : '—', s ? fmtPct(s.day_rate) : '', s ? cls(s.day) : ''),
      tile('봇 운용 손익', kr.bot ? fmtWon(kr.bot.pl) : '—', kr.bot ? `${fmtPct(kr.bot.pl_rate)} · 운용 ${fmtCompact(kr.bot.cost)}` : '봇 보유 없음', kr.bot ? cls(kr.bot.pl) : '')));
    out.push(assetCompareCard(kr));
    const pick = pickRow('KR');
    const KR_LABEL = { core: '모멘텀', watch: '눌림목', manual: '직접' };
    const holds = kr.holdings || [];
    // [10-07 P1] 휴대폰(390px)에서 핵심 열이 화면 밖이던 것을 고칩니다.
    //   순서: 종목 → 매도선까지 → 수익률 → 평가손익 → 일간 → 현재가 → 평단 → 수량
    //   모든 종목이 같은 경로(예: 전부 모멘텀)면 칩은 정보가 없고 고정 첫 칸만 넓히므로 숨깁니다.
    const mixed = new Set(holds.map((h) => h.source)).size > 1;
    out.push(card('보유 종목', `${holds.length}종목${mixed ? '' : holds.length ? ` · 전부 ${KR_LABEL[holds[0].source] || '봇'}` : ''} · 누르면 일봉`,
      holds.length ? dense([
        { label: '종목', lead: true, cell: (h) => [mixed ? chip(KR_LABEL[h.source], h.source === 'watch' ? 'cash' : h.source === 'core' ? 'idx' : '') : null, mixed ? ' ' : null,
          el('span', { class: 'sym', text: h.name || h.symbol }), h.half ? ' ½' : ''] },
        { label: '매도선까지', right: true, cell: (h) => stopCell(h.source === 'manual' ? null : h.exit, h.source === 'manual') },
        { label: '수익률', right: true, tone: (h) => cls(h.pl_rate), cell: (h) => fmtPct(h.pl_rate) },
        { label: '평가손익', right: true, tone: (h) => cls(h.pl), cell: (h) => fmtWon(h.pl) },
        { label: '일간', right: true, tone: (h) => cls(h.day_rate), cell: (h) => fmtPct(h.day_rate, 1) },
        { label: '현재가', right: true, cell: (h) => fmtPrice(h.price) },
        { label: '평단', right: true, cell: (h) => fmtPrice(h.avg) },
        { label: '수량', right: true, cell: (h) => fmtQty(h.qty) },
      ], holds, { onPick: pick, selected: S.pick, key: (h) => `KR:${h.symbol}` }) : empty('보유 종목이 없습니다')));
    const rules = d.rules || {};
    if (rules.kr_h1) out.push(h1PlanCard(d.kr_h1, 'KR', pick));
    const watch = d.watchlist || [];
    if (rules.kr_watch_buy !== false) out.push(card('눌림목 관찰목록', `${watch.length}종목 · 전일 종가 기준`, watch.length ? dense([
      // 지지선이 무엇인지가 핵심입니다. 진입 방식 이름에서 선 이름만 뽑습니다.
      // (예: '5분봉 반등·지지 (60일선)' -> '60일선', '20일선 회복' -> '20일선')
      { label: '종목', lead: true, cell: (w) => [chip(supportChip(w.mode), 'idx'), ' ', el('span', { class: 'sym', text: w.name || w.symbol })] },
      { label: '점수', right: true, cell: (w) => w.score },
      { label: '진입선', right: true, cell: (w) => fmtPrice(w.entry) },
      { label: '전일종가', right: true, cell: (w) => fmtPrice(w.prev_close) },
      { label: '진입선까지', right: true, cell: (w) => fmtPct(isNum(w.entry) && isNum(w.prev_close) && w.prev_close > 0 ? (w.entry / w.prev_close - 1) * 100 : null, 1) },
      { label: '고점대비', right: true, tone: (w) => cls(w.drop), cell: (w) => fmtPct(w.drop, 1) },
      { label: '거래량', right: true, cell: (w) => fmtTimes(w.vol) },
    ], watch, { onPick: pick, selected: S.pick, key: (w) => `KR:${w.symbol}` }) : empty('관찰 종목이 없습니다')));
    const ranks = rules.kr_h1 ? [] : (d.ranks || []);
    if (ranks.length) {
      out.push(card('모멘텀 순위', `오늘 채점 상위 ${ranks.length}`, el('details', {}, el('summary', { text: '펼치기' }), dense([
        { label: '#', right: true, cell: (r) => ranks.indexOf(r) + 1 },
        { label: '종목', lead: true, cell: (r) => [el('span', { class: 'sym', text: r.name || r.symbol }), r.rsi_div ? chip('RSI 약세', 'warn') : null] },
        { label: '점수', right: true, cell: (r) => r.score },
        { label: '종가', right: true, cell: (r) => fmtPrice(r.close) },
        { label: '1일', right: true, tone: (r) => cls(r.change), cell: (r) => fmtPct(r.change, 1) },
        { label: 'RSI', right: true, cell: (r) => fmtNum(r.rsi, 0) },
        { label: '거래량비', right: true, cell: (r) => fmtNum(r.udv, 2) },
      ], ranks, { onPick: pick, selected: S.pick, key: (r) => `KR:${r.symbol}` }))));
    }
    return [splitWith(pickPanel(d, 'KR'), ...out)];
  }

  // [09-28 화면 정리] 혼합1 이번 주 계획. 예전 점수 순위·점수 후보 대신 실제로 사고파는 목록을 보여 줍니다.
  // [10-07] 국내 규칙 문구는 PC 프로그램이 장부에 남긴 실제 규칙(plan.rule)을 씁니다(예전 문구는 '12-1개월' 뿐이었음).
  //   시장 필터 판정과, 그 때문에 사지 않은 종목(plan.buy_blocked)도 함께 보여 줍니다.
  function h1PlanCard(plan, market, pick) {
    const cur = market === 'US' ? 'USD' : 'KRW';
    const title = market === 'US' ? '미국 혼합1 이번 주 계획' : '국내 혼합1 이번 주 계획';
    if (!plan || !plan.week) return card(title, '아직 점검 전', empty('그 주 첫 거래일 종가 매매(국내 15:18 · 미국 첫 장) 때 계획을 세웁니다'));
    const name = (r) => [el('span', { class: 'sym', text: r.name || r.symbol }), r.held ? chip('보유', 'core') : null];
    const sub = `${plan.day ? String(plan.day).slice(5) : plan.week} ${plan.monthly ? '월 교체' : '주간 점검'} · 종목당 ${fmtMoney(plan.slot, cur)}`
      + (isNum(plan.ranked) ? ` · 순위 ${fmtNum(plan.ranked)}종목` : '');
    const list = (rows, extra) => dense([
      { label: '종목', lead: true, cell: (r) => name(r) },
      rows.some((r) => isNum(r.mom)) ? { label: '수익률(순위 기준)', right: true, tone: (r) => cls(r.mom), cell: (r) => fmtPct(r.mom, 1) } : null,
      ...(extra || []),
    ].filter(Boolean), rows, { onPick: pick, selected: S.pick, key: (r) => `${market}:${r.symbol}` });
    const sell = plan.sell || [], buy = plan.buy || [], left = plan.left || [], blocked = plan.buy_blocked || [];
    // 손절은 늘 '고점 대비 하락' 이라 설정 부호(−20 / 20)와 관계없이 −로 씁니다.
    const stop = isNum(plan.stop) && plan.stop !== 0 ? `고점 대비 ${fmtPct(-Math.abs(plan.stop), 0)} 손절` : '고점 대비 손절 끔';
    const keep = isNum(plan.keep) ? fmtPct(plan.keep, 0) : NONE;
    const rules = market === 'US'
      ? [['순위', '6-1개월 수익률'],
         ['매주 첫 장', `자격 잃음·순위 상위 ${keep} 밖이면 매도 · 월 첫 점검은 상위 10 밖 교체 · ${stop}(장중)`
           + (plan.market_filter === true ? ' · 동일가중 지수 100일선 아래면 신규 매수 멈춤' : '')]]
      : [['순위', plan.rule || '12-1개월 수익률'],
         ['매일 15:18', `${stop}${plan.daily_ma ? ' · 100일선 이탈 매도' : ''}`
           + (plan.score_drop ? ` · 모멘텀약화(산 날보다 ${fmtNum(plan.score_drop)}점 이상 하락${plan.score_floor ? `·${fmtNum(plan.score_floor)}점 이하` : ''}) 매도` : '')],
         ['매주 첫 거래일', `자격 잃음·순위 상위 ${keep} 밖이면 매도 · 월 첫 점검은 상위 ${fmtNum(plan.slots || 10)} 밖 교체`
           + (isNum(plan.share_limit) ? ` · 1주가 종목당의 ${fmtNum(plan.share_limit, 1, 0)}배 이하면 1주 매수` : '')]];
    return card(title, sub,
      el('dl', { class: 'rulebox' }, rules.flatMap(([k, v]) => [el('dt', { text: k }), el('dd', { text: v })])),
      market === 'KR' ? krMarketLine(plan) : null,
      el('h3', { class: 'minor', text: `자격 상위 ${(plan.top || []).length}` }),
      (plan.top || []).length ? list(plan.top) : empty('자격 있는 종목이 없습니다'),
      el('h3', { class: 'minor', text: `매도 ${sell.length} · 매수 ${buy.length}${left.length ? ` · 재시도 ${left.length}` : ''}${blocked.length ? ` · 시장 필터로 보류 ${blocked.length}` : ''}` }),
      sell.length ? list(sell, [{ label: '사유', cell: (r) => r.why || '' }]) : null,
      buy.length ? list(buy, [{ label: '구분', cell: () => '매수' }]) : null,
      left.length ? list(left, [{ label: '구분', cell: () => '다음 종가에 재시도' }]) : null,
      blocked.length ? list(blocked, [{ label: '구분', cell: () => '시장 필터로 이번 주 안 삼' }]) : null,
      !sell.length && !buy.length && !left.length && !blocked.length ? empty('이번 주 매도·매수 없음') : null);
  }

  // ------------------------------------------------------------------ 화면: 미국
  function renderUS(d) {
    const us = d.us;
    if (!us) return [missing('미국 계좌')];
    const out = [];
    out.push(el('div', { class: 'tiles' },
      tile('평가금액', fmtUsd(us.value), us.updated_at ? `계좌 조회 ${ago(us.updated_at).text}` : ''),
      tile('평가손익', fmtUsd(us.pnl), '', cls(us.pnl)),
      tile('오늘 손익', fmtUsd(us.day_pnl), '', cls(us.day_pnl)),
      tile('매수 가능', fmtUsd(us.buying_power), `${(d.rules || {}).us_h1 ? usMarketPill(us).textContent.replace('미국 ', '') : `국면 ${isNum(us.regime) ? us.regime : '?'}/2`} · 채점 ${(us.scan_date || '—').slice(5)}`)));
    if (us.status) out.push(el('div', { class: 'card muted', style: 'font-size:14px', text: `미국 자동매매 상태: ${us.status}` }));
    const chartHost = el('div', { class: 'chart' });
    out.push(card('미국 계좌 추이', 'USD · 뉴욕 날짜 기준', chartHost));
    queueMicrotask(() => lineChart(chartHost, (us.history || []).map((p) => ({ x: p.date, y: p.value })), { currency: 'USD', label: '미국 평가금액' }));
    const pick = pickRow('US');
    const holds = us.holdings || [];
    out.push(card('보유 종목', `${holds.length}종목 · 종목을 누르면 일봉이 열립니다`, holds.length ? dense([
      { label: '티커', lead: true, cell: (h) => [chip(h.bot ? (h.kind || '모멘텀') : '수동', h.bot ? 'idx' : ''), ' ', el('span', { class: 'sym', text: h.symbol })] },
      { label: '종목', cell: (h) => h.name || '' },
      { label: '현재가', right: true, cell: (h) => fmtUsd(h.price) },
      { label: '평단', right: true, cell: (h) => fmtUsd(h.avg) },
      { label: '수량', right: true, cell: (h) => fmtQty(h.qty) },
      { label: '손익', right: true, tone: (h) => cls(h.pnl), cell: (h) => fmtUsd(h.pnl) },
      { label: '수익률', right: true, tone: (h) => cls(h.rate), cell: (h) => fmtPct(isNum(h.rate) ? h.rate * 100 : null) },
      (d.rules || {}).us_h1 && !holds.some((h) => isNum(h.score)) ? null
        : { label: '점수', right: true, cell: (h) => (isNum(h.score) ? `${isNum(h.entry) ? h.entry + '→' : ''}${h.score}` : '—') },
      { label: '손절까지', right: true, cell: (h) => (h.bot && isNum(h.stop_gap) ? fmtPct(h.stop_gap, 1) : '봇 미관리') },
    ].filter(Boolean), holds, { onPick: pick, selected: S.pick, key: (h) => `US:${h.symbol}` }) : empty('보유 종목이 없습니다')));
    if ((d.rules || {}).us_h1) {
      out.push(h1PlanCard(us.h1, 'US', pick));
      return [splitWith(pickPanel(d, 'US'), ...out)];
    }
    const cand = us.candidates || [];
    out.push(card('모멘텀 매수 후보', `15점 이상 · RSI·roc_skip·거래량 조건 통과 ${cand.length}종목`, cand.length ? dense([
      { label: '티커', lead: true, cell: (c) => el('span', { class: 'sym', text: c.symbol }) },
      { label: '종목', cell: (c) => c.name || '' },
      { label: '점수', right: true, cell: (c) => c.score },
      { label: '종가', right: true, cell: (c) => fmtUsd(c.close) },
      { label: 'RSI', right: true, cell: (c) => fmtNum(c.rsi, 0) },
      { label: 'roc_skip', right: true, tone: (c) => cls(c.roc_skip), cell: (c) => fmtPct(c.roc_skip, 1) },
      { label: '거래량', right: true, cell: (c) => fmtTimes(c.vol) },
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
      tile('실현손익', total.known ? fmtMoney(total.total, cur) : '—',
        isNum(spent.total) && spent.total > 0 ? `수수료·세금 ${fmtMoney(spent.total, cur)} 차감` : `원가 미확인 ${total.unknown || 0}건 제외`,
        cls(total.total)),
      tile('승률', fmtPct(total.win_rate, 0), `매도 ${total.count || 0}건 · 매수 ${perf.buys || 0}건`),
      tile('평균 손익', isNum(total.avg) ? fmtMoney(total.avg, cur) : '—', isNum(total.profit_factor) ? `이익/손실 비율 ${fmtNum(total.profit_factor, 2)}` : '', cls(total.avg)),
      tile('최대 낙폭', isNum(curve.max_drawdown) && curve.max_drawdown < 0 ? fmtMoney(curve.max_drawdown, cur) : '없음',
        curve.peak_date && curve.trough_date ? `${String(curve.peak_date).slice(5)} → ${String(curve.trough_date).slice(5)}` : '누적 실현손익 기준', curve.max_drawdown < 0 ? 'down' : '')));

    if (spent.before) out.push(el('div', { class: 'note-bar', text: `손익은 매수·매도 수수료와 증권거래세를 뺀 값입니다. 비용 반영 전 매도 ${spent.before}건은 세전 그대로입니다.` }));
    const barsHost = el('div', { class: 'chart' });
    const tags = (perf.by_tag || []).slice().sort((a, b) => (b.total || 0) - (a.total || 0));
    out.push(card('매도 규칙별 손익', '막대 = 실현손익 합계', barsHost));
    queueMicrotask(() => hBars(barsHost, tags.map((g) => ({ name: g.name, value: g.known ? g.total : null, sub: `${g.count}건 · 승률 ${fmtPct(g.win_rate, 0)}` })), cur));

    // 매수 규칙별 · 매수일 거래량별: 팔린 매수분을 선입선출로 이어 붙여 집계한 값
    const entrySub = (g) => `${g.count}건 · 승률 ${fmtPct(g.win_rate, 0)}`
      + (isNum(g.avg_pct) ? ` · 수익률 ${fmtPct(g.avg_pct, 1)}` : '')
      + (isNum(g.hold) ? ` · ${fmtNum(g.hold, 0)}일 보유` : '');
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
        el('td', { class: 'r', text: fmtQty(t.qty) }),
        el('td', { class: 'r', text: fmtPrice(t.price, S.perfMarket) }),
        el('td', { class: `r ${cls(t.realized)}`, text: isNum(t.realized) ? fmtMoney(t.realized, cur) : '' }),
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
    const fm = (a, v) => fmtMoney(v, a.currency);

    out.push(card('계좌별 수익률', `${p.started || ''} 시작 · 규칙은 계좌 이름에 표시 · 종가 기준`,
      dense([
        { label: '계좌', lead: true, cell: (a) => a.label },
        { label: '수익률', right: true, tone: (a) => cls(a.pl_rate), cell: (a) => fmtPct(a.pl_rate) },
        { label: '손익', right: true, tone: (a) => cls(a.pl), cell: (a) => fm(a, a.pl) },
        { label: '자산', right: true, cell: (a) => fm(a, a.value) },
        { label: '현금', right: true, cell: (a) => fmtPct(a.cash_rate, 0) },
        { label: '종목', right: true, cell: (a) => fmtNum(a.count) },
        { label: '매매', right: true, cell: (a) => (isNum(a.trades) ? `${fmtNum(a.trades)}건` : NONE) },
      ], accts, { onPick: (a) => { S.paperPick = a.key; render(true); }, selected: pick.key, key: (a) => a.key })));

    out.push(el('div', { class: 'tiles' },
      tile('가장 높은 수익률', fmtPct(Math.max(...accts.map((a) => a.pl_rate))),
        accts.slice().sort((a, b) => b.pl_rate - a.pl_rate)[0].label),
      tile('가장 낮은 수익률', fmtPct(Math.min(...accts.map((a) => a.pl_rate))),
        accts.slice().sort((a, b) => a.pl_rate - b.pl_rate)[0].label),
      tile('시작일', p.started || '—', accts[0].day ? `최근 ${accts[0].day}` : '')));

    const host = el('div', { class: 'chart' });
    out.push(card(`${pick.label} 자산 추이`, '종가 기준 · 하루 1점', host));
    // [10-07 P1] 자료는 [날짜, 자산] 쌍이고 lineChart 는 {x, y} 를 받습니다(예전엔 쌍을 그대로 넘겨 늘 '자료 부족').
    queueMicrotask(() => lineChart(host, (pick.equity || []).filter((pt) => Array.isArray(pt)).map(([date, v]) => ({ x: date, y: v })),
      { currency: pick.currency, height: 180, label: pick.label }));

    const paperMixed = new Set((pick.holdings || []).map((h) => (h.source === 'watch' ? 'watch' : 'core'))).size > 1;
    out.push(card(`${pick.label} 보유`, `${fmtNum(pick.count)}종목 · 현금 ${fm(pick, pick.cash)}`,
      (pick.holdings || []).length ? dense([
        { label: '종목', lead: true, cell: (h) => [paperMixed ? chip(h.source === 'watch' ? '눌림목' : '모멘텀', h.source === 'watch' ? 'watch' : 'core') : null, paperMixed ? ' ' : null, el('span', { class: 'sym', text: h.name || h.symbol })] },
        { label: '수량', right: true, cell: (h) => fmtNum(h.qty, 4, 0) },
        { label: '현재가', right: true, cell: (h) => fmtPrice(h.price, pick.market) },
        { label: '평단', right: true, cell: (h) => fmtPrice(h.avg, pick.market) },
        { label: '평가금액', right: true, cell: (h) => fmtCompact(h.value, pick.currency) },
        { label: '수익률', right: true, tone: (h) => cls(h.pl_rate), cell: (h) => fmtPct(h.pl_rate) },
        { label: '비중', right: true, cell: (h) => (pick.value > 0 ? fmtPct(h.value / pick.value * 100, 1) : NONE) },
      ], pick.holdings) : empty('아직 담은 종목이 없습니다')));

    out.push(card(`${pick.label} 매수 안 한 이유`, `${(pick.skipped || []).length}건`,
      (pick.skipped || []).length ? dense([
        { label: '종목', lead: true, cell: (r) => r.name || r.symbol || '—' },
        { label: '단계', cell: (r) => r.stage || '' },
        { label: '이유', cell: (r) => r.why || '' },
      ], pick.skipped) : empty('막힌 종목이 없습니다')));

    out.push(card('읽는 법', null, el('div', { class: 'note' },
      el('p', { text: '가상계좌는 실계좌와 규칙이 다를 수 있습니다. 실계좌 국내는 혼합1(12-1개월), 미국은 혼합1(6-1개월)입니다.' }),
      el('p', { text: '국내 기존점수·미국 기존점수 = 예전 점수 규칙 비교용 · 국내 혼합1(6-1) = 미국 규칙을 국내 종목에 적용한 비교용.' }),
      el('p', { text: '같은 규칙끼리는 자본금만 다릅니다. 갈리는 곳은 1주 단위, 한 종목 비중 상한, 한 칸 최소 금액, 예수금입니다.' }),
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
      count.textContent = `${fmtNum(lines.length, 0)}줄${current.truncated ? ' · 앞부분 생략' : ''}`;
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
