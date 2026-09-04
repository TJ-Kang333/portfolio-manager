// ============================================================
//  국내/해외 주식·ETF 시세 자동 조회 — Code.gs 와 같은 프로젝트에 별도 파일로.
//  키 불필요(둘 다 공개 API). Code.gs 의 doGet 이 ?action=stock_prices 를
//  여기로 라우팅.
//
//  국내: 네이버 금융 폴링 API (종목코드, 예: 069500)
//  해외: Yahoo Finance 차트 API (티커, 예: TSLA)
//
//  설치: 이 파일 추가 후 저장·배포만 하면 끝(즉시 앱의 "⟳ 시세 갱신" 버튼에서 사용 가능).
//  일 단위 자동 스냅샷을 원하면 setupStockSnapshotTrigger 1회 실행.
// ============================================================

// 6자리 코드(숫자 위주, 문자 섞일 수 있음. 예: 069500, 0172V0)면 국내로 판단.
// 순수 영문 티커(TSLA, AAPL 등)는 해외로 처리.
function isDomesticTicker(ticker) {
  const t = String(ticker || '').toUpperCase();
  return /^[0-9A-Z]{6}$/.test(t) && /\d/.test(t);
}

// 네이버 금융 폴링 API — 국내 종목 여러 개를 한 번에 조회 (키 불필요)
function fetchKrPrices(codes) {
  const out = {};
  if (!codes.length) return out;
  try {
    const url = 'https://polling.finance.naver.com/api/realtime/domestic/stock/' + codes.join(',');
    const res  = UrlFetchApp.fetch(url, { muteHttpExceptions: true,
      headers: { 'User-Agent': 'Mozilla/5.0', 'Referer': 'https://finance.naver.com/' } });
    const json = JSON.parse(res.getContentText());
    (((json || {}).result || {}).areas || []).forEach(area => {
      (area.datas || []).forEach(d => {
        const p = parseFloat(d.nv); // 현재가
        if (d.cd && !isNaN(p)) out[d.cd] = p;
      });
    });
  } catch (e) {}
  return out;
}

// Yahoo Finance 차트 API — 해외 개별 티커 (키 불필요), 결과는 USD
function fetchUsPriceUsd(ticker) {
  try {
    const url = 'https://query1.finance.yahoo.com/v8/finance/chart/' + encodeURIComponent(ticker);
    const res  = UrlFetchApp.fetch(url, { muteHttpExceptions: true,
      headers: { 'User-Agent': 'Mozilla/5.0' } });
    const json = JSON.parse(res.getContentText());
    const p = json && json.chart && json.chart.result && json.chart.result[0]
      && json.chart.result[0].meta && json.chart.result[0].meta.regularMarketPrice;
    return (typeof p === 'number') ? p : null;
  } catch (e) { return null; }
}

// tickerList(문자열 배열) → { ticker: 원화가격 } . 해외는 USD/KRW 곱해서 원화로 통일.
function fetchStockPricesKRW(tickerList) {
  const uniq = [...new Set((tickerList || []).map(t => String(t || '').trim()).filter(Boolean))];
  const krList = uniq.filter(isDomesticTicker);
  const usList = uniq.filter(t => !isDomesticTicker(t));

  const out = {};
  Object.assign(out, fetchKrPrices(krList));

  if (usList.length) {
    const rate = _usdKrw(); // okx.gs 재사용
    usList.forEach(t => {
      const usd = fetchUsPriceUsd(t);
      if (usd != null) out[t] = rate ? Math.round(usd * rate * 100) / 100 : usd;
    });
  }
  return out;
}

// doGet ?action=stock_prices&tickers=069500,160580,TSLA
function stockPricesResponse(tickersParam) {
  const tickers = String(tickersParam || '').split(',').map(s => s.trim()).filter(Boolean);
  if (!tickers.length) return { ok: false, error: '조회할 종목이 없습니다' };
  const prices = fetchStockPricesKRW(tickers);
  return { ok: true, ts: new Date().toISOString(), prices };
}

// ── 일 단위 자동 스냅샷 ────────────────────────────────────
// state(구글시트)를 읽기만 하고(=쓰지 않음) 최신 월의 qty 보유 종목을 오늘 시세로
// 재평가해 자산스냅샷에 한 줄 남긴다. state 자체는 안 건드려서(app 의 저장/동기화와
// 충돌 없음) 안전 — 실제 반영은 앱을 열었을 때 "⟳ 시세 갱신" 버튼(또는 자동 폴링)이 함.
function snapshotStockPrices() {
  try {
    const state = loadState();
    if (!state || !state.months) return;
    const monthKeys = Object.keys(state.months).sort();
    const latest = monthKeys[monthKeys.length - 1];
    if (!latest) return;

    const tickers = new Set();
    Object.values(state.months[latest]).forEach(acct => {
      Object.entries(acct || {}).forEach(([ticker, h]) => { if (h && h.qty > 0) tickers.add(ticker); });
    });
    if (!tickers.size) return;

    const prices = fetchStockPricesKRW([...tickers]);
    let total = 0, priced = 0;
    Object.values(state.months[latest]).forEach(acct => {
      Object.entries(acct || {}).forEach(([ticker, h]) => {
        if (!h) return;
        if (h.qty > 0 && prices[ticker]) { total += h.qty * prices[ticker]; priced++; }
        else total += h.balance || 0; // 시세 못 받은 종목·현금 등은 마지막 저장값 그대로 합산
      });
    });
    getSnapshotSheet().appendRow([
      new Date().toISOString(), '미래에셋증권(주식)', Math.round(total), '', '',
      `종목 ${tickers.size}개 중 ${priced}개 시세 반영 (${latest})`,
    ]);
  } catch (e) {
    try { getSnapshotSheet().appendRow([new Date().toISOString(), '미래에셋증권(주식)', '', '', '', 'ERROR: ' + e.message]); } catch (e2) {}
  }
}

function setupStockSnapshotTrigger() {
  ScriptApp.getProjectTriggers()
    .filter(t => t.getHandlerFunction() === 'snapshotStockPrices')
    .forEach(t => ScriptApp.deleteTrigger(t));
  ScriptApp.newTrigger('snapshotStockPrices').timeBased().everyDays(1).atHour(16).create(); // 장 마감 후
  snapshotStockPrices(); // 즉시 1회
}

// 편집기에서 실제 코드로 연결 점검 (사용자 CSV에서 나온 실제 종목코드)
function _testStockPrices() {
  const codes = ['069500', '160580', '385560', '453870', '464470', '474800', '0172V0', 'TSLA'];
  Logger.log(JSON.stringify(fetchStockPricesKRW(codes), null, 2));
}

// 국내 시세 API가 실제로 뭘 돌려주는지 원문 그대로 확인 (파싱 전 raw 응답)
function _testKrPriceRaw() {
  const url = 'https://polling.finance.naver.com/api/realtime/domestic/stock/069500,160580';
  const res = UrlFetchApp.fetch(url, { muteHttpExceptions: true,
    headers: { 'User-Agent': 'Mozilla/5.0', 'Referer': 'https://finance.naver.com/' } });
  Logger.log('HTTP ' + res.getResponseCode());
  Logger.log(res.getContentText().slice(0, 1500));
}
