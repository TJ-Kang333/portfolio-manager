// ============================================================
//  OKX 잔고 자동 조회 — Code.gs 와 같은 Apps Script 프로젝트에 별도 파일로.
//
//  키 설정 (코드/시트/대화에 안 넣음):
//   프로젝트 설정(톱니) → 스크립트 속성 → 아래 3개 추가
//     OKX_API_KEY      = OKX API Key
//     OKX_API_SECRET   = OKX Secret Key
//     OKX_PASSPHRASE   = 생성 시 정한 passphrase
//   (선택) OKX_SIMULATED = 1  → 데모(모의거래) 계정으로 조회
//
//  설치: 편집기에서 setupOkxTrigger 1회 실행 → 매일 1회 자동 스냅샷.
//  앱에서 즉시 조회: doGet ?action=okx_balance   (Code.gs 가 라우팅)
// ============================================================

const OKX_BASE       = 'https://www.okx.com';
const SNAPSHOT_SHEET = '자산스냅샷';
// 컬럼: A일시  B출처  C원화(KRW)  D USD  E USD/KRW  F상세(JSON)
const SNAPSHOT_HEADER = ['일시', '출처', 'KRW', 'USD', 'USD_KRW', '상세'];

function _okxProps() {
  const p = PropertiesService.getScriptProperties();
  return {
    key:  p.getProperty('OKX_API_KEY'),
    sec:  p.getProperty('OKX_API_SECRET'),
    pass: p.getProperty('OKX_PASSPHRASE'),
    sim:  p.getProperty('OKX_SIMULATED') === '1',
  };
}

// OKX V5 서명: Base64( HMAC-SHA256( timestamp + method + requestPath + body , secret ) )
function _okxSign(ts, method, path, body, secret) {
  const msg = ts + method + path + (body || '');
  const raw = Utilities.computeHmacSha256Signature(msg, secret);
  return Utilities.base64Encode(raw);
}

function _okxGet(path) {
  const { key, sec, pass, sim } = _okxProps();
  if (!key || !sec || !pass) throw new Error('OKX 키가 스크립트 속성에 없습니다 (OKX_API_KEY/SECRET/PASSPHRASE).');
  const ts = new Date().toISOString(); // 예: 2026-09-03T12:34:56.789Z
  const headers = {
    'OK-ACCESS-KEY':        key,
    'OK-ACCESS-SIGN':       _okxSign(ts, 'GET', path, '', sec),
    'OK-ACCESS-TIMESTAMP':  ts,
    'OK-ACCESS-PASSPHRASE': pass,
  };
  if (sim) headers['x-simulated-trading'] = '1';
  const res  = UrlFetchApp.fetch(OKX_BASE + path, { method: 'get', headers, muteHttpExceptions: true });
  const json = JSON.parse(res.getContentText());
  if (json.code && json.code !== '0') throw new Error('OKX ' + json.code + ': ' + json.msg);
  return json.data || [];
}

// 현재 USD/KRW (무료·키 불필요)
function _usdKrw() {
  try {
    const r = JSON.parse(UrlFetchApp.fetch('https://open.er-api.com/v6/latest/USD', { muteHttpExceptions: true }).getContentText());
    if (r && r.rates && r.rates.KRW) return r.rates.KRW;
  } catch (e) {}
  try {
    const r = JSON.parse(UrlFetchApp.fetch('https://api.frankfurter.app/latest?from=USD&to=KRW', { muteHttpExceptions: true }).getContentText());
    if (r && r.rates && r.rates.KRW) return r.rates.KRW;
  } catch (e) {}
  return null;
}

// 스테이블 외 코인 시세(USD) — OKX 공개 시세 API, 키 불필요
const _okxPriceCache = {};
function _okxSpotUsdPrice(ccy) {
  if (ccy === 'USDT' || ccy === 'USDC' || ccy === 'USD') return 1;
  if (ccy in _okxPriceCache) return _okxPriceCache[ccy];
  let price = null;
  try {
    const r = JSON.parse(UrlFetchApp.fetch(
      OKX_BASE + '/api/v5/market/ticker?instId=' + ccy + '-USDT',
      { muteHttpExceptions: true }).getContentText());
    if (r.data && r.data[0] && r.data[0].last) price = parseFloat(r.data[0].last);
  } catch (e) {}
  _okxPriceCache[ccy] = price;
  return price;
}
// bucket 은 { ccy: usd } 또는 { ccy: {qty,note} } 로 채워짐 — 같은 ccy 가 여러 창구(적립+스테이킹)에
// 걸쳐 있어도 누적되도록 처리. 반환값은 이번 호출로 추가된 USD (합계 usd 에 그대로 더하면 됨).
function _addPriced(bucket, ccy, qty) {
  const price = _okxSpotUsdPrice(ccy);
  if (price) {
    const add = qty * price;
    const prev = (typeof bucket[ccy] === 'number') ? bucket[ccy] : 0;
    bucket[ccy] = prev + add;
    return add;
  }
  const prevQty = (bucket[ccy] && typeof bucket[ccy] === 'object') ? bucket[ccy].qty : 0;
  bucket[ccy] = { qty: prevQty + qty, note: '시세 조회 실패' };
  return 0;
}

// 거래·펀딩·Earn(적립/스테이킹) 계좌 전부 합산 → USD 총액
// Earn 은 OKX 내부적으로도 여러 창구(유연적립/고정적립/스테이킹)로 나뉘어 있어
// 전부 다 못 잡을 수 있음 — detail 을 보고 빠진 게 있으면 알려주면 그 창구를 추가함.
function okxTotalUsd() {
  let usd = 0;
  const detail = { trading: {}, funding: {}, earn: {} };

  // 거래(트레이딩) 계정 — eqUsd 를 바로 줌
  try {
    const acct = _okxGet('/api/v5/account/balance');
    if (acct[0]) {
      (acct[0].details || []).forEach(d => {
        const v = parseFloat(d.eqUsd || '0');
        if (v) { usd += v; detail.trading[d.ccy] = v; }
      });
    }
  } catch (e) { detail.tradingError = e.message; }

  // 펀딩 계정 — 수량만 옴 → 시세 곱해서 환산
  try {
    const fund = _okxGet('/api/v5/asset/balances');
    fund.forEach(d => {
      const bal = parseFloat(d.bal || '0');
      if (bal) usd += _addPriced(detail.funding, d.ccy, bal);
    });
  } catch (e) { detail.fundingError = e.message; }

  // Earn — 심플언 유연적립(Flexible Savings)
  try {
    const savings = _okxGet('/api/v5/finance/savings/balance');
    savings.forEach(d => {
      const amt = parseFloat(d.amt || '0');
      if (amt) usd += _addPriced(detail.earn, d.ccy, amt);
    });
  } catch (e) { detail.earnSavingsError = e.message; }

  // Earn — 스테이킹/온체인(ETH 스테이킹 등) 활성 주문
  try {
    const orders = _okxGet('/api/v5/finance/staking-defi/orders-active');
    orders.forEach(o => {
      const inv = (o.investData || [])[0];
      const amt = inv ? parseFloat(inv.amt || '0') : 0;
      if (amt && inv.ccy) usd += _addPriced(detail.earn, inv.ccy, amt);
    });
  } catch (e) { detail.earnStakingError = e.message; }

  return { usd, detail };
}

function okxBalanceKRW() {
  const { usd, detail } = okxTotalUsd();
  const rate = _usdKrw();
  const krw  = rate ? Math.round(usd * rate) : null;
  return {
    ok: true,
    ts: new Date().toISOString(),
    usd: Math.round(usd * 100) / 100,
    krwRate: rate,
    krw,
    detail,
  };
}

function getSnapshotSheet() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  let sh = ss.getSheetByName(SNAPSHOT_SHEET);
  if (!sh) sh = ss.insertSheet(SNAPSHOT_SHEET);
  if (sh.getLastRow() === 0) sh.appendRow(SNAPSHOT_HEADER);
  return sh;
}

// 하루 1회 스냅샷 (트리거)
function snapshotOkx() {
  try {
    const b = okxBalanceKRW();
    getSnapshotSheet().appendRow([
      b.ts, 'OKX', b.krw, b.usd, b.krwRate, JSON.stringify(b.detail),
    ]);
  } catch (e) {
    getSnapshotSheet().appendRow([new Date().toISOString(), 'OKX', '', '', '', 'ERROR: ' + e.message]);
  }
}

function setupOkxTrigger() {
  ScriptApp.getProjectTriggers()
    .filter(t => t.getHandlerFunction() === 'snapshotOkx')
    .forEach(t => ScriptApp.deleteTrigger(t));
  ScriptApp.newTrigger('snapshotOkx').timeBased().everyDays(1).atHour(6).create();
  snapshotOkx(); // 즉시 1회
}

// 앱이 자산스냅샷 시트를 읽어감 (doGet ?action=load_snapshots)
function loadSnapshots() {
  try {
    const ss = SpreadsheetApp.getActiveSpreadsheet();
    const sh = ss.getSheetByName(SNAPSHOT_SHEET);
    if (!sh || sh.getLastRow() < 2) return { ok: true, rows: [] };
    const vals = sh.getRange(2, 1, sh.getLastRow() - 1, 6).getValues();
    const rows = vals.map(r => ({
      ts:      r[0] instanceof Date ? r[0].toISOString() : String(r[0]),
      source:  String(r[1] || ''),
      krw:     Number(r[2]) || null,
      usd:     Number(r[3]) || null,
      usdKrw:  Number(r[4]) || null,
      detail:  String(r[5] || ''),
    })).filter(r => r.source);
    return { ok: true, rows };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

// 편집기에서 연결 점검용
function _testOkx() {
  Logger.log(JSON.stringify(okxBalanceKRW(), null, 2));
}
