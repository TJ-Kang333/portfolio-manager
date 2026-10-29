// ============================================================
//  가계부 문자/알림 파서 — Gmail → '가계부거래' 시트
//  Code.gs 와 같은 Apps Script 프로젝트에 "별도 파일"로 추가.
//
//  설치:
//   1) 이 파일 추가 후 저장.
//   2) 편집기 함수 목록에서 setupFinanceAlertTrigger 선택 → 실행.
//      (Gmail 접근 권한 승인창이 뜨면 허용)
//   3) 이후 5분마다 parseFinanceAlerts 가 자동 실행됨.
//
//  전제: 폰의 MacroDroid 가 카드 문자 / 결제앱 알림을
//        제목에 FINALERT (대괄호 없이) 가 든 메일로 본인 Gmail 에 보낸다.
//        받는 Gmail 은 반드시 이 스프레드시트를 소유한 계정이어야 함.
//
//  Gmail 필터(제목에 FINALERT → 라벨 finalert)는 "선택".
//   - 만들면: 라벨 붙은 메일만 처리 (받은편지함도 깔끔).
//   - 안 만들면: 최근 7일치 중 제목에 FINALERT 든 메일을 검색해서 처리.
//  둘 다 처리 끝난 메일엔 finalert-done / finalert-review 라벨을 붙여 재처리 방지.
// ============================================================

const ALERT_LABEL        = 'finalert';         // 수집 대기
const ALERT_DONE_LABEL   = 'finalert-done';    // 파싱 완료
const ALERT_REVIEW_LABEL = 'finalert-review';  // 파서가 인식 못함 — 수동 확인 필요
const TXN_SHEET_NAME     = '가계부거래';
// 컬럼: A날짜 B유형 C가맹점 D금액 E출처 F원문 G해시(중복방지) H상태('' | 'done') I시각(ISO, 이체 매칭용)
// J열(잔액): 은행 알림에 실제 잔액이 같이 오면 기록 — 앱이 가계부 계좌 잔액을
// 누적(더하기/빼기) 대신 이 값으로 덮어써서, 놓친 알림 때문에 생기는 오차를 매번 바로잡음.
const ALERT_HEADER = ['날짜', '유형', '가맹점', '금액', '출처', '원문', '해시', '상태', '시각', '잔액'];

// ── 사용자 설정 ────────────────────────────────────────────
// 한 은행에 계좌가 여러 개일 때, 여기 적은 계좌번호(앞부분)로 온 알림만 가계부에 반영.
// 나머지 계좌 알림은 조용히 무시. 그 은행을 아예 안 적으면 전체 반영.
//   계좌 하나:   { '우리은행': '1002-644-889' }
//   계좌 여러 개: { '우리은행': ['1002-644-889', '1002-777-123'] }  ← 배우자 계좌 등
const BANK_ACCT_FILTER = { '우리은행': '1002-644-889' };

// ── 설치: 5분 트리거 생성 (편집기에서 1회 실행) ───────────
function setupFinanceAlertTrigger() {
  ScriptApp.getProjectTriggers()
    .filter(t => t.getHandlerFunction() === 'parseFinanceAlerts')
    .forEach(t => ScriptApp.deleteTrigger(t));
  ScriptApp.newTrigger('parseFinanceAlerts').timeBased().everyMinutes(5).create();
  parseFinanceAlerts(); // 즉시 1회 실행
}

// ── 메인: Gmail 스캔 → 파싱 → 시트 적재 ──────────────────
function parseFinanceAlerts() {
  const lock = LockService.getScriptLock();
  // 짧게만 시도 — 못 잡으면 5분 뒤 다시 돌면 됨. ingest(HTTP) 를 오래 막지 않도록.
  if (!lock.tryLock(3000)) return;
  try {
    const doneLabel   = GmailApp.getUserLabelByName(ALERT_DONE_LABEL)   || GmailApp.createLabel(ALERT_DONE_LABEL);
    const reviewLabel = GmailApp.getUserLabelByName(ALERT_REVIEW_LABEL) || GmailApp.createLabel(ALERT_REVIEW_LABEL);

    // 필터로 라벨을 붙였으면 그 라벨함을, 안 만들었으면 제목 검색으로 대체
    const label = GmailApp.getUserLabelByName(ALERT_LABEL);
    const threads = label
      ? label.getThreads(0, 50)
      : GmailApp.search(
          'subject:FINALERT newer_than:7d -label:' + ALERT_DONE_LABEL + ' -label:' + ALERT_REVIEW_LABEL,
          0, 50);
    if (!threads.length) return;

    const sheet  = getTxnSheet();
    const hashes = getExistingHashes(sheet);

    threads.forEach(thread => {
      let anyFail = false;
      thread.getMessages().forEach(msg => {
        const text = extractAlertText(msg);
        if (!text) return;
        const rec = parseAlert(text, msg.getDate());
        if (rec && rec.skip) return;      // 인식했으나 기록 대상 아님(결제 실패 등)
        if (!rec) { anyFail = true; return; }
        if (hashes.has(rec.hash)) return; // 중복 스킵
        sheet.appendRow([rec.date, rec.type, rec.merchant, rec.amount, rec.source, rec.raw, rec.hash, '',
                         msg.getDate().toISOString(), rec.balance != null ? rec.balance : '']);
        hashes.add(rec.hash);
        if (rec.balance != null) appendBankSnapshot(rec.source, rec.balance, msg.getDate().toISOString());
      });
      if (label) thread.removeLabel(label);
      thread.addLabel(anyFail ? reviewLabel : doneLabel);
    });
  } finally {
    lock.releaseLock();
  }
}

function getTxnSheet() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  let sh = ss.getSheetByName(TXN_SHEET_NAME);
  if (!sh) sh = ss.insertSheet(TXN_SHEET_NAME);
  if (sh.getLastRow() === 0) sh.appendRow(ALERT_HEADER);
  return sh;
}

// ── MacroDroid HTTP 직접 수신 (Code.gs 의 doPost 에서 호출) ──
//   문자/알림 원문 1건을 받아 즉시 파싱 → '가계부거래' 시트에 적재.
//   Gmail 을 안 거치므로 5분 트리거보다 빠름.
//   when(선택): 알림이 실제로 온 시각 — 미인식알림을 나중에 다시 처리할 때(reprocessUnparsedAlerts) 날짜·시각을 원래대로 맞춘다.
//   noStash(선택): true 면 못 읽어도 미인식알림 시트에 다시 쌓지 않음(재처리 중 중복 방지).
function ingestAlertText(rawText, sourceHint, when, noStash) {
  const text = String(rawText || '').replace(/\r/g, '').trim();
  if (!text) return { ok: false, error: '빈 내용' };

  const at = when instanceof Date && !isNaN(when) ? when : new Date();
  const rec = parseAlert(text, at, sourceHint);
  if (rec && rec.skip) return { ok: true, skipped: true };
  if (!rec) { if (!noStash) stashUnparsed(text, sourceHint); return { ok: true, unparsed: true }; }

  const lock = LockService.getScriptLock();
  const locked = lock.tryLock(15000); // 못 잡아도 진행 — 중복은 해시로 거른다
  const ts = at.toISOString();
  try {
    const sheet  = getTxnSheet();
    const hashes = getExistingHashes(sheet);
    const isDup  = hashes.has(rec.hash);
    if (!isDup) {
      sheet.appendRow([rec.date, rec.type, rec.merchant, rec.amount, rec.source, rec.raw, rec.hash, '',
                       ts, rec.balance != null ? rec.balance : '']);
    }
    // 은행 알림처럼 잔액이 같이 온 경우 — 거래 중복 여부와 별개로 자산 스냅샷은 남김
    if (rec.balance != null) appendBankSnapshot(rec.source, rec.balance, ts);
    if (isDup) return { ok: true, duplicate: true };
    return { ok: true, added: true, lockless: !locked,
             row: { date: rec.date, type: rec.type, amount: rec.amount, merchant: rec.merchant, source: rec.source, balance: rec.balance } };
  } finally {
    if (locked) lock.releaseLock();
  }
}

// 은행 알림에서 뽑은 잔액을 자산스냅샷 시트에 기록 (okx.gs 의 getSnapshotSheet 재사용)
function appendBankSnapshot(source, krw, ts) {
  try {
    getSnapshotSheet().appendRow([ts || new Date().toISOString(), source, krw, '', '', '거래알림에서 추출']);
  } catch (e) {}
}

// 파서가 인식 못한 원문 보관 (파서 개선용)
function stashUnparsed(text, sourceHint) {
  try {
    const ss = SpreadsheetApp.getActiveSpreadsheet();
    let sh = ss.getSheetByName('미인식알림');
    if (!sh) { sh = ss.insertSheet('미인식알림'); sh.appendRow(['시각', '출처힌트', '원문']); }
    sh.appendRow([new Date(), String(sourceHint || ''), text.slice(0, 1500)]);
  } catch (e) {}
}

// ── 미인식알림 재처리 (편집기에서 직접 실행) ──────────────────
//  파서가 없던 시절에 와서 '미인식알림' 시트에 쌓인 알림(예: 해외승인)을 지금의 파서로 다시 읽어 '가계부거래' 시트에 넣는다.
//  · reprocessUnparsedAlerts  — 실제로 반영. 줄마다 D열에 결과("재처리: 반영/중복/무시")를 적어 같은 줄을 두 번 처리하지 않음.
//  · previewReprocessUnparsedAlerts — 시트는 건드리지 않고 로그에만 "이렇게 읽힌다"를 보여줌(먼저 이걸로 확인).
//  여전히 못 읽는 줄(명세서 안내 등)은 그대로 둔다. 원래 온 시각을 그대로 써서 날짜가 맞게 들어간다.
function previewReprocessUnparsedAlerts() { _reprocessUnparsed(true); }
function reprocessUnparsedAlerts()        { _reprocessUnparsed(false); }
function _reprocessUnparsed(dryRun) {
  const sh = SpreadsheetApp.getActiveSpreadsheet().getSheetByName('미인식알림');
  if (!sh || sh.getLastRow() < 2) { Logger.log('미인식알림 시트에 처리할 줄이 없습니다.'); return; }
  const rows = sh.getRange(2, 1, sh.getLastRow() - 1, 4).getValues(); // 시각, 출처힌트, 원문, 처리결과
  const count = { added: 0, duplicate: 0, skipped: 0, still: 0, done: 0 };
  rows.forEach((r, i) => {
    if (String(r[3] || '').trim()) { count.done++; return; }
    const text = String(r[2] || '').trim();
    if (!text) return;
    const when = r[0] instanceof Date ? r[0] : new Date(r[0]);
    const hint = String(r[1] || '');
    if (dryRun) {
      const rec = parseAlert(text, when, hint);
      if (!rec) { count.still++; Logger.log('[못 읽음] ' + text.replace(/\s+/g, ' ').slice(0, 60)); return; }
      if (rec.skip) { count.skipped++; return; }
      count.added++;
      Logger.log('[읽힘] ' + rec.date + ' ' + rec.type + ' ' + rec.amount + '원 ' + rec.merchant + ' (' + rec.source + ')');
      return;
    }
    const res = ingestAlertText(text, hint, when, true);
    let mark = '';
    if (res.added) { mark = '재처리: 반영'; count.added++; }
    else if (res.duplicate) { mark = '재처리: 중복'; count.duplicate++; }
    else if (res.skipped) { mark = '재처리: 무시'; count.skipped++; }
    else count.still++;
    if (mark) sh.getRange(i + 2, 4).setValue(mark);
  });
  Logger.log((dryRun ? '[미리보기] ' : '[실행] ') + '반영 ' + count.added + ' / 중복 ' + count.duplicate + ' / 무시(광고 등) ' + count.skipped +
             ' / 여전히 못 읽음 ' + count.still + ' / 이미 처리됨 ' + count.done);
}

function getExistingHashes(sheet) {
  const set = new Set();
  const last = sheet.getLastRow();
  if (last < 2) return set;
  sheet.getRange(2, 7, last - 1, 1).getValues().forEach(r => { if (r[0]) set.add(String(r[0])); });
  return set;
}

// MacroDroid 메일에서 알림 원문만 추출
function extractAlertText(msg) {
  let body = msg.getPlainBody() || '';
  if (!body.trim()) body = (msg.getBody() || '').replace(/<[^>]+>/g, ' ');
  return body.replace(/\r/g, '').trim();
}

// MacroDroid URL 의 &source=... 값을 파서 키로 정규화
// 은행 알림은 &source=woori / &source=hana_bank 로 명시 (하나카드와 구분하기 위해 "하나"만으론 은행으로 취급)
function normalizeSourceHint(s) {
  s = String(s || '').toLowerCase().trim();
  if (!s) return '';
  if (/samsung|삼성/.test(s))                      return 'samsung';
  if (/hyundai|현대카드/.test(s))                 return 'hyundai';
  if (/gyeonggi|경기|지역화폐|사랑화폐/.test(s))  return 'gyeonggi';
  if (/hana.?card|하나카드/.test(s))               return 'hana_card';
  if (/hana.?bank|하나은행/.test(s))               return 'hana_bank';
  if (/woori|우리/.test(s))                        return 'woori';
  if (/^hana$|하나/.test(s))                       return 'hana_bank'; // 명시 없으면 은행으로
  if (/현대/.test(s))                              return 'hyundai';
  return s;
}

// ── 파서 레지스트리 ──────────────────────────────────────
//  sourceHint 가 있으면(= MacroDroid 가 어느 앱에서 왔는지 알려줌) 그 파서를 강제.
//  알림 텍스트가 잘려 와서 키워드 매칭이 안 되는 경우를 대비.
//  명의 구분: &source=hyundai~배우자  처럼 "~" 뒤에 라벨을 붙이면 출처가
//  "현대카드 (배우자)" 가 되어 가계부에서 별도 계좌로 잡힘. (배우자 폰 등 같은 카드 구분용)
function parseAlert(text, msgDate, sourceHint) {
  // 광고성 알림(법적으로 맨 앞에 "(광고)" 표기 의무)은 source 힌트로 파서가 강제돼도
  // 거래로 취급하지 않는다. (forced 파서는 match() 검사를 건너뛰므로, 예를 들어
  // &source=gyeonggi 로 강제된 지역화폐 광고 문자에 우연히 낀 "5,000원" 같은 숫자를
  // 실제 결제로 잘못 기록하던 문제 — 항상 맨 먼저 걸러야 함.)
  if (/^\s*[\(\[]?\s*광고\s*[\)\]]?/.test(text)) return { skip: true };
  const rawHint = String(sourceHint || '');
  const sep = rawHint.search(/[~|]/);
  const hintMain = sep >= 0 ? rawHint.slice(0, sep) : rawHint;
  const hintWho  = sep >= 0 ? rawHint.slice(sep + 1).replace(/[_+]/g, ' ').trim() : '';
  const hint = normalizeSourceHint(hintMain);
  const list = hint
    ? ALERT_PARSERS.slice().sort((a, b) => (b.srcKey === hint ? 1 : 0) - (a.srcKey === hint ? 1 : 0))
    : ALERT_PARSERS;
  for (const p of list) {
    const forced = hint && p.srcKey === hint;
    if (!forced && !p.match(text)) continue;
    const r = p.parse(text, msgDate);
    if (r && r.skip) return { skip: true };
    // forceAccept: amount>0을 확인할 수 없는 경우(예: 해외결제 원화 미정)에도 기록은 해야 하는 케이스.
    // 파서가 명시적으로 표시한 경우에만 우회 — 다른 파서의 일반 실패(amount=0)는 여전히 미인식 처리.
    if (r && (r.amount > 0 || r.forceAccept) && r.date) {
      r.source = r.source || p.name;
      if (hintWho) r.source = r.source + ' (' + hintWho + ')';
      r.raw    = text.slice(0, 500);
      r.merchant = (r.merchant || '').trim();
      // 알림 원문의 시각(MM/DD HH:MM) — 같은 금액 거래를 하루에 두 번 해도 구분되도록 중복키에 포함.
      // 같은 알림이 이메일+HTTP 로 두 번 와도 원문 시각은 같으니 여전히 중복 제거됨.
      r.timeKey = (text.match(/\d{1,2}\/\d{1,2}\s+\d{1,2}:\d{2}/) || [''])[0];
      r.hash   = makeHash(r);
      return r;
    }
    // 지정된 파서가 못 뽑았으면 다른 파서(match 기반)로 넘어간다.
    // (전엔 여기서 return null 해서, source 힌트가 잘못 오면 미인식으로 버려졌음)
  }
  return null;
}

function makeHash(r) {
  const key = [r.source, r.date, r.timeKey || '', r.amount, (r.merchant || '').replace(/\s/g, ''), r.type].join('|');
  const digest = Utilities.computeDigest(Utilities.DigestAlgorithm.MD5, key);
  return Utilities.base64EncodeWebSafe(digest).slice(0, 16);
}

// MM/DD (+ 메일 수신 연도) → yyyy-MM-dd. 메일보다 3일 이상 미래면 작년으로 보정.
function resolveDate(mm, dd, msgDate) {
  let y = msgDate ? msgDate.getFullYear() : new Date().getFullYear();
  const cand = new Date(y, mm - 1, dd);
  if (msgDate && cand.getTime() - msgDate.getTime() > 3 * 24 * 3600 * 1000) {
    y -= 1;
  }
  return Utilities.formatDate(new Date(y, mm - 1, dd), 'Asia/Seoul', 'yyyy-MM-dd');
}

const ALERT_PARSERS = [

  // ── 삼성카드 승인/취소 문자 ─────────────────────────────
  //  [문자] 삼성1234승인 홍*동 15,000원 일시불 10/16 12:34 스타벅스 누적1,234,567원  (한 줄 또는 줄 단위)
  //  가맹점명에 "삼성"이 든 다른 카드 알림(삼성전자 결제 등)을 잘못 잡지 않도록, "삼성1234승인" 같은
  //  카드 표기나 "삼성카드"+승인/취소 일 때만 식별한다. 현대카드보다 먼저 검사(가맹점명에 "현대"가 든 문자 대비).
  {
    name: '삼성카드',
    srcKey: 'samsung',
    match: t => /삼성\s*\d{4}\s*(해외)?\s*(승인|취소)/.test(t) || (/삼성카드/.test(t) && /(승인|취소)/.test(t)),
    parse: (t, msgDate) => parseSamsungCard(t, msgDate),
  },

  // ── 현대카드 승인/취소 — 문자·앱 알림 두 형식 다 지원 ──────
  //  [문자]  [Web발신] / 현대 MX Black 승인 / 강*준 / 77,950원 일시불 /
  //          09/03 16:59 / 네이버페이 / 누적2,521,146원
  //  [앱알림] 쿠팡 / 41,530원 · 일반승인 / 강태준 님, 현대 MX Black 승인 일시불, 8/30 22:07 /
  //          누적2,294,286원   ← 제목(첫 줄)이 곧 가맹점이라 오히려 더 깔끔
  //  (취소는 문자="현대 MX Black 취소", 앱알림="일반취소"/"승인취소" — 둘 다 '취소' 포함)
  {
    name: '현대카드',
    srcKey: 'hyundai',
    // '현대' + 승인/취소 + '누적' 조합으로 식별 (문자엔 "현대카드"가 아니라 "현대 MX Black"으로 옴)
    // 자동납부(관리비 등)는 "누적" 줄이 아예 없이 오므로 "자동납부"만으로도 인식.
    // 해외승인/해외취소도 "누적" 줄 유무가 불확실해 "해외"만으로도 인식.
    match: t => /현대/.test(t) && /(승인|취소)/.test(t) && (/누적/.test(t) || /자동납부/.test(t) || /해외/.test(t)),
    parse: (t, msgDate) => {
      // source 힌트가 잘못 와서 강제로 이 파서로 들어와도, 명백한 지역화폐 알림이면 넘긴다.
      if (/사랑화폐|지역화폐|경기지역화폐/.test(t)) return null;
      const isCancel = /취소/.test(t);

      // 자동납부(아파트관리비 등) — "자동납부 승인 강*준님 아파트관리비 656,340원"처럼
      // 가맹점명과 금액이 한 줄에 붙어 오고, 시각/누적 줄이 아예 없어 아래 일반 로직
      // (줄 단위로 보일러플레이트를 걸러 가맹점을 찾는 방식)으로는 뽑을 수 없다.
      // 전용 패턴으로 가맹점+금액을 한 번에 추출.
      const autoM = t.match(/자동납부\s*승인\s*\S*님?\s*(.+?)\s*([\d,]+)\s*원/);
      if (autoM) {
        return {
          type: isCancel ? 'income' : 'expense',
          amount: parseInt(autoM[2].replace(/,/g, ''), 10),
          merchant: autoM[1].trim(),
          source: '현대카드',
          date: Utilities.formatDate(msgDate || new Date(), 'Asia/Seoul', 'yyyy-MM-dd'),
          balance: null,
        };
      }

      // 해외승인/해외취소(예: 대한항공120 카드 해외 사용) — "GBP 11.45 · 해외승인"처럼
      // 원화("원")가 아니라 외화로 와서 금액을 뽑을 수 없다. 아직 원화 환산 전이니
      // amount=0 + forceAccept(아래 parseAlert 의 amount>0 게이트 우회)로 일단 기록해두고,
      // 가맹점명에 외화 통화·금액을 남겨서 사용자가 가계부에서 "수정"으로 원화를 직접 입력하게 한다.
      // 실제 알림 원문은 "…해외승인 EUR 4.00 9/15 4:18" 처럼 통화·금액이 승인 뒤에 오고, 앱 알림 목록 화면은
      // "GBP 11.45 · 해외승인" 처럼 앞에 온다 — 두 순서를 다 읽는다. (앞쪽 형태만 보던 때는 실제 해외승인이 전부 미인식이었음)
      const fxA = t.match(/([A-Z]{3})\s+([\d,]+(?:\.\d+)?)\s*[·,]?\s*해외\s*(승인|취소)/);
      const fxB = fxA ? null : t.match(/해외\s*(승인|취소)\s*([A-Z]{3})\s+([\d,]+(?:\.\d+)?)/);
      const fxM = fxA || (fxB && [fxB[0], fxB[2], fxB[3], fxB[1]]);
      if (fxM) {
        const isFxCancel = fxM[3] === '취소';
        const dm2 = t.match(/(\d{1,2})\/(\d{1,2})\s+(\d{1,2}):(\d{2})/);
        const date2 = dm2 ? resolveDate(parseInt(dm2[1], 10), parseInt(dm2[2], 10), msgDate)
                           : Utilities.formatDate(msgDate || new Date(), 'Asia/Seoul', 'yyyy-MM-dd');
        const lines2 = t.split('\n').map(s => s.trim()).filter(Boolean);
        const isBoilerplate2 = l => !l || /(승인|취소)/.test(l) || /^\d{1,2}[\/.:]\d/.test(l) ||
          !/[가-힣A-Za-z]/.test(l) || /님,?$/.test(l) || /^현대\s*(카드)?$/.test(l) || /^누적/.test(l);
        const merchant2 = lines2.find(l => !isBoilerplate2(l)) || '해외결제';
        return {
          type: isFxCancel ? 'income' : 'expense',
          amount: 0,
          forceAccept: true,
          merchant: merchant2 + ' (' + fxM[1] + ' ' + fxM[2] + ', 환전 전)',
          source: '현대카드',
          date: date2,
          balance: null,
        };
      }

      const lines = t.split('\n').map(s => s.trim()).filter(Boolean);

      // 금액: '누적' 줄을 빼고 나서 나오는 첫 'N원' — 구분자가 문자와 앱알림에서 달라("·" 등)도
      // 상관없이, 누적 줄만 아니면 거의 항상 첫 번째 금액이 승인 금액.
      const withoutBal = t.replace(/누적[^\n]*/g, '');
      const am = withoutBal.match(/([\d,]+)\s*원/);
      const amount = am ? parseInt(am[1].replace(/,/g, ''), 10) : 0;

      // 날짜/시각: M/DD HH:MM 또는 MM/DD HH:MM (앱알림은 "8/30"처럼 0 없이 올 수 있음)
      const dm = t.match(/(\d{1,2})\/(\d{1,2})\s+(\d{1,2}):(\d{2})/);
      const date = dm ? resolveDate(parseInt(dm[1], 10), parseInt(dm[2], 10), msgDate)
                       : Utilities.formatDate(msgDate || new Date(), 'Asia/Seoul', 'yyyy-MM-dd');

      // 가맹점: ① 문자 형식 — "MM/DD HH:MM" 단독 줄 다음부터 '누적' 전까지
      let merchant = '';
      const dIdx = lines.findIndex(l => /^\d{1,2}\/\d{1,2}\s+\d{1,2}:\d{2}$/.test(l));
      if (dIdx >= 0) {
        for (let i = dIdx + 1; i < lines.length && !/^누적/.test(lines[i]); i++) {
          merchant = (merchant ? merchant + ' ' : '') + lines[i];
        }
      }
      // ② 앱 알림 형식 — 못 찾았으면, 보일러플레이트(금액/승인·취소/이름/누적/앱이름 자체) 아닌
      // 첫 줄을 가맹점으로. 알림 제목이 "현대카드"(앱 이름)로 오고 본문에 가맹점이 있는 경우 대비 —
      // 그냥 lines[0] 을 쓰면 "현대카드"가 가맹점으로 잘못 들어감.
      if (!merchant) {
        // 숫자로 시작하는 상호("521 헤어룸", "365마트")도 살리기 —
        // 예전 /^\d/ 는 그런 상호를 통째로 걸러버렸음. 이제 날짜/시각 줄과
        // 글자 없는 줄(계좌·전화번호)만 제외한다.
        // 금액 줄 판정은 "숫자+원"으로 한정 — 예전엔 /원/ 하나만 봐서 "OO의원"(병원),
        // "풀무원" 처럼 상호에 그냥 "원"이 들어간 것도 통째로 걸러버렸음.
        const isBoilerplate = l => !l || /[\d,]+\s*원/.test(l) || /(승인|취소)/.test(l) ||
          /^\d{1,2}[\/.:]\d/.test(l) ||       // 9/6, 09.06, 12:26 …
          !/[가-힣A-Za-z]/.test(l) ||         // 글자 없는 줄
          /님,?$/.test(l) || /^현대\s*(카드)?$/.test(l) || /MX\s*Black/i.test(l) || /^누적/.test(l);
        merchant = lines.find(l => !isBoilerplate(l)) || '';
      }

      // 누적N원 = 이번 결제주기 카드 사용액 = 미결제 부채. 카드 계좌 잔액은 음수로 추적하므로 -값.
      const cm = t.match(/누적\s*([\d,]+)\s*원/);
      const balance = cm ? -parseInt(cm[1].replace(/,/g, ''), 10) : null;

      return { type: isCancel ? 'income' : 'expense', amount, merchant, source: '현대카드', date, balance };
    }
  },

  // ── 경기지역화폐 / OO사랑화폐 (앱 푸시 알림) ────────────
  //  결제 완료 1,100원
  //  씨유(CU) 광명역푸르지오점
  //  광명사랑화폐 추가형인센티브 100원
  //  광명사랑화폐(통합) 총 보유 잔액 631,085원
  //  (결제 실패 알림은 무시. 푸시 본문에 날짜가 없으면 메일 수신시각 사용)
  {
    name: '경기지역화폐',
    srcKey: 'gyeonggi',
    // 알림이 잘려 와도 잡히도록 "결제 완료/취소/실패" 만으로도 매칭
    match: t => /결제\s*(완료|취소|실패)/.test(t) ||
                (/(경기지역화폐|지역화폐|사랑화폐)/.test(t) && /결제/.test(t)),
    parse: (t, msgDate) => {
      if (/결제\s*실패/.test(t)) return { skip: true }; // 거래 아님
      const isCancel = /(결제\s*취소|취소\s*완료|승인\s*취소|환불)/.test(t);
      const lines = t.split('\n').map(s => s.trim()).filter(Boolean);

      // 금액: '결제 완료/취소' 든 줄 우선, 없으면 본문 첫 'N원'
      const headLine = lines.find(l => /결제\s*(완료|취소)/.test(l));
      const am = (headLine || t).match(/([\d,]+)\s*원/);
      const amount = am ? parseInt(am[1].replace(/,/g, ''), 10) : 0;

      // 가맹점: 보일러플레이트(사랑화폐/잔액/인센티브/결제상태/날짜/[..]) 아닌 첫 줄
      let merchant = '';
      for (const l of lines) {
        if (/결제\s*(완료|취소|실패|승인)/.test(l)) continue;
        if (/(사랑화폐|지역화폐|인센티브|잔액|보유)/.test(l)) continue;
        if (/^\d{4}[.\/-]\d{1,2}[.\/-]\d{1,2}/.test(l)) continue;
        if (/^\[/.test(l)) continue;
        if (!/[가-힣A-Za-z]/.test(l)) continue;
        merchant = l;
        break;
      }

      // 날짜: 본문에 YYYY/MM/DD 있으면 사용, 없으면 메일 수신시각
      const dm = t.match(/(\d{4})[.\/-](\d{1,2})[.\/-](\d{1,2})/);
      let date;
      if (dm) {
        const p = n => String(n).padStart(2, '0');
        date = dm[1] + '-' + p(dm[2]) + '-' + p(dm[3]);
      } else {
        date = Utilities.formatDate(msgDate || new Date(), 'Asia/Seoul', 'yyyy-MM-dd');
      }

      // "총 보유 잔액 N원" = 지역화폐 지갑에 남은 선불금 = +자산. 있으면 계좌 잔액 기준점으로.
      const bm = t.match(/(?:총\s*)?보유\s*잔액\s*([\d,]+)\s*원/);
      const balance = bm ? parseInt(bm[1].replace(/,/g, ''), 10) : null;

      return { type: isCancel ? 'income' : 'expense', amount, merchant, source: '경기지역화폐', date, balance };
    }
  },

  // ── 우리은행 / 하나은행 입출금 알림 (앱 푸시) ───────────
  //  우리WON뱅킹: 출금 -31,366원 / 카카오페이 | 우리 1002952535***
  //  하나원큐  : 1,283,738 원 입금 | 강태준           (순서가 반대로 옴)
  //  둘 다: (선택) 잔액 36,001,074원 — 있으면 자산스냅샷에도 기록
  //  광고성 알림("(광고)...")은 입금/출금 문구가 없어 자연히 걸러짐(parse()가 null 반환).
  {
    name: '우리은행', srcKey: 'woori',
    match: t => /우리/.test(t) && /(입금|출금)/.test(t) && /원/.test(t),
    parse: (t, msgDate) => parseBankAlert(t, msgDate, '우리은행'),
  },
  {
    name: '하나은행', srcKey: 'hana_bank',
    match: t => /하나/.test(t) && /(입금|출금)/.test(t) && /원/.test(t),
    parse: (t, msgDate) => parseBankAlert(t, msgDate, '하나은행'),
  },

  // ── 하나카드 승인 SMS — 샘플 확보 후 작성 ─────────────
  // {
  //   name: '하나카드', srcKey: 'hana_card',
  //   match: t => /하나(카드)?/.test(t) && /승인/.test(t),
  //   parse: (t, msgDate) => { ... }
  // },

];

// 삼성카드 문자 파서. 한 줄/여러 줄 어느 쪽이든 같은 방식으로 읽는다:
//  금액 = "누적…" 부분을 뺀 첫 "N원", 날짜·시각 = "M/D HH:MM", 가맹점 = 시각 뒤 ~ 누적/한도 앞.
//  원화 금액이 없는 해외승인은 외화 금액만 남기고 amount=0 으로 기록(현대카드 해외승인과 같은 방식).
//  "누적N원"이 이번 결제주기 사용액인지 확실치 않아 카드 잔액 기준점(balance)으로는 쓰지 않는다.
function parseSamsungCard(t, msgDate) {
  // 문자 앱 "알림"으로 받을 땐 제목/본문/큰 본문이 같은 내용으로 겹쳐 올 수 있다 — 카드 표기("삼성8588승인")가
  // 두 번째로 나오는 지점부터는 같은 문자의 반복이므로 잘라낸다. (이게 없으면 가맹점이 반복된 글자로 오염됨)
  const mk = [...t.matchAll(/삼성\s*\d{4}\s*(?:해외)?\s*(?:승인|취소)/g)];
  if (mk.length > 1) t = t.slice(0, mk[1].index);
  if (/승인\s*거절|결제\s*실패|한도\s*초과/.test(t)) return { skip: true };
  const isCancel = /취소/.test(t);
  const flat = t.replace(/\s+/g, ' ').trim();
  const noAccum = flat.replace(/누적\s*:?\s*[\d,]+\s*원?/g, ' ');

  const dm = noAccum.match(/(\d{1,2})[\/.](\d{1,2})\s+(\d{1,2}):(\d{2})/);
  const date = dm ? resolveDate(parseInt(dm[1], 10), parseInt(dm[2], 10), msgDate)
                   : Utilities.formatDate(msgDate || new Date(), 'Asia/Seoul', 'yyyy-MM-dd');

  let merchant = '';
  if (dm) {
    // 시각 뒤 ~ 누적/한도 앞. (누적을 지운 noAccum 이 아니라 원문 flat 기준으로 잘라야, 뒤에 이어 붙은 다른 줄이 안 섞임)
    const after = flat.slice(flat.indexOf(dm[0]) + dm[0].length);
    merchant = after.split(/누적|잔여|한도|※|\(광고|문의|고객센터/)[0].trim();
  }
  if (!merchant) { // 시각 뒤에 없으면 줄 단위로 보일러플레이트가 아닌 첫 줄
    const lines = t.split('\n').map(s => s.trim()).filter(Boolean);
    const isBoiler = l => !/[가-힣A-Za-z]/.test(l) || /(승인|취소|누적|Web발신)/.test(l) || /삼성/.test(l) ||
      /[\d,]+\s*원/.test(l) || /^\d{1,2}[\/.]\d/.test(l) || /^[가-힣]\*[가-힣]님?$/.test(l);
    merchant = lines.find(l => !isBoiler(l)) || '';
  }

  const am = noAccum.match(/([\d,]+)\s*원/);
  const krw = am ? parseInt(am[1].replace(/,/g, ''), 10) : 0;
  if (krw > 0) return { type: isCancel ? 'income' : 'expense', amount: krw, merchant, source: '삼성카드', date, balance: null };

  const fx = /해외/.test(t) && noAccum.match(/(?:^|\s)([A-Z]{3})\s*([\d,]+(?:\.\d+)?)(?=\s|$)/);
  if (fx) {
    return {
      type: isCancel ? 'income' : 'expense', amount: 0, forceAccept: true,
      merchant: (merchant || '해외결제') + ' (' + fx[1] + ' ' + fx[2] + ', 환전 전)',
      source: '삼성카드', date, balance: null,
    };
  }
  return null;
}

// 우리은행/하나은행 공용 파서 — 배열 순서(금액↔유형)가 은행마다 달라 순서 무관 정규식으로 처리
function parseBankAlert(t, msgDate, sourceLabel) {
  // 방향 판정: [입금]/[출금] 대괄호 형태 우선.
  // 없으면 헤더의 "입출금알림" 같은 잡음("입출금"→"출금" 오인식)을 지우고 판정.
  let dir = (t.match(/\[(입금|출금)\]/) || [])[1];
  if (!dir) dir = (t.replace(/입출금/g, '').match(/(입금|출금)/) || [])[1];
  if (!dir) return null; // 광고 등 실제 거래 알림이 아님
  const isOut = dir === '출금';

  // 계좌 필터: 지정 계좌번호(앞부분) 목록에 없으면 무시. 문자열 하나 또는 배열 모두 허용.
  const rule = BANK_ACCT_FILTER && BANK_ACCT_FILTER[sourceLabel];
  if (rule) {
    const allow = Array.isArray(rule) ? rule : [rule];
    const acctM = t.match(/(\d{2,4}-\d{2,4}-\d{2,6})\s*\*/);
    if (acctM && !allow.some(a => a && acctM[1].indexOf(a) === 0)) return { skip: true };
  }

  const withoutBal = t.replace(/잔액[^\n]*/g, '');
  const am = withoutBal.match(/([\d,]+)\s*원/);
  const amount = am ? parseInt(am[1].replace(/,/g, ''), 10) : 0;
  if (!amount) return null;

  const balM = t.match(/잔액\s*(-?[\d,]+)\s*원/);
  const balance = balM ? parseInt(balM[1].replace(/,/g, ''), 10) : null;

  // 적요/상대방 뽑기 — 은행·형식마다 위치가 달라서 여러 패턴을 순서대로 시도.
  // (잔액 뒷부분은 이미 잘라낸 withoutBal 기준으로 매칭)
  let merchant = '';
  //  ① 우리WON뱅킹 팝업:  [출금] 하나생활비급여 100,000원 1002-644-...
  let mm = withoutBal.match(/\[(?:입금|출금)\]\s*(\S.*?)\s+[\d,]+\s*원/);
  //  ② 하나원큐 팝업:     입금 100,000원 생활비급여   (그 뒤 잔액은 잘려나감)
  if (!mm) mm = withoutBal.match(/(?:입금|출금)\s+[\d,]+\s*원\s+(\S.*?)\s*$/m);
  if (mm && mm[1]) {
    merchant = mm[1].trim();
  } else {
    //  ③ 'A | B' 형태 (예전 앱알림함 스타일)
    const lines = t.split('\n').map(s => s.trim()).filter(Boolean);
    const pipeLine = lines.find(l => l.includes('|'));
    const looksLikeAcct = s => /^(우리|하나|국민|신한|농협|기업|카카오뱅크|토스뱅크)\s*[\d*]+/.test(s) || /^\d[\d*-]{5,}/.test(s);
    const looksLikeAmt  = s => /원/.test(s) && /(입금|출금)/.test(s);
    if (pipeLine) {
      const parts = pipeLine.split('|').map(s => s.trim()).filter(Boolean);
      merchant = parts.find(p => !looksLikeAcct(p) && !looksLikeAmt(p)) || parts[0] || '';
    } else {
      const hi = lines.findIndex(l => /(입금|출금)/.test(l));
      if (hi >= 0 && lines[hi + 1] && !/잔액/.test(lines[hi + 1])) merchant = lines[hi + 1];
    }
  }
  // 계좌번호/은행명만 남은 경우는 적요 없는 걸로
  if (/^\d[\d*-]{4,}/.test(merchant) || /계좌$/.test(merchant)) merchant = '';

  return {
    type: isOut ? 'expense' : 'income',
    amount, merchant, source: sourceLabel,
    date: Utilities.formatDate(msgDate || new Date(), 'Asia/Seoul', 'yyyy-MM-dd'),
    balance,
  };
}

// ── 편집기에서 파서 점검용 (Gmail 없이) ──────────────────
function _testParser() {
  const cases = {
    현대카드_승인: [
      '[Web발신]', '현대 MX Black 승인', '강*준',
      '77,950원 일시불', '09/03 16:59', '네이버페이', '누적2,521,146원',
    ].join('\n'),
    현대카드_취소: [
      '[Web발신]', '현대 MX Black 취소', '강*준',
      '77,950원 일시불', '09/03 17:04', '네이버페이', '누적2,443,196원',
    ].join('\n'),
    현대카드_앱알림_승인: [
      '쿠팡', '41,530원 · 일반승인',
      '강태준 님, 현대 MX Black 승인 일시불, 8/30 22:07',
      '누적2,294,286원',
    ].join('\n'),
    현대카드_앱알림_취소: [
      '에스케이큰나무셀프주유소', '150,000원 · 일반취소',
      '강태준 님, 현대 MX Black 승인취소 일시불, 8/30 17:12',
      '누적2,176,370원',
    ].join('\n'),
    지역화폐_완료: [
      '결제 완료 1,100원', '씨유(CU) 광명역푸르지오점',
      '광명사랑화폐 추가형인센티브 100원',
      '광명사랑화폐(통합) 총 보유 잔액 631,085원',
      '2026/09/01 16:44',
    ].join('\n'),
    지역화폐_실패: [
      '결제 실패 12,000원', '경기지역화폐 결제를 지원하지 않는 매장이에요',
      '2026/09/01 13:53',
    ].join('\n'),
    // 실제 팝업 알림 원문 (2026-09-05 확인)
    우리은행_출금: [
      '우리WON뱅킹 입출금알림',
      '[출금] 하나생활비급여 100,000원 1002-644-889***계좌 잔액 35,901,074원 09/05 21:50:57',
    ].join('\n'),
    // 입금 — 헤더의 "입출금알림" 때문에 예전엔 지출로 오인식되던 케이스 (2026-09-07 확인)
    우리은행_입금: [
      '우리WON뱅킹 입출금알림',
      '[입금] 현대자동차      170,388원 1002-644-889***계좌 09/07 14:02:36',
    ].join('\n'),
    // 관리 대상 아닌 다른 우리 계좌 → BANK_ACCT_FILTER 로 skip 되어야 함
    우리은행_타계좌: [
      '우리WON뱅킹 입출금알림',
      '[입금] 현대자동차      170,388원 1002-952-535***계좌 09/07 14:02:36',
    ].join('\n'),
    하나은행_입금: [
      '하나은행',
      '입금 100,000원 생활비급여    잔액 1,494,051원 09/05 21:50 118-******-72107',
    ].join('\n'),
    우리은행_광고: [
      '(광고)LCK 한정굿즈 사전응모', 'LCK 결승전 현장 수령', '당첨되고 편히 수령해요!',
    ].join('\n'),
    // 상호에 "원"이 들어간 경우(병원·의원·풀무원 등) — /원/ 하나만 보던 예전 필터가
    // 금액줄로 오인해서 가맹점을 통째로 날리던 케이스 (2026-09-22 확인)
    현대카드_앱알림_의원상호: [
      '현대카드',
      '강태준 님, 현대 MX Black 승인 9,200원 일시불, 9/21 18:03',
      '강태준 님, 현대 MX Black 승인 9,200원 일시불, 9/21 18:03',
      '365제이에스소아청소년과의원',
      '누적3,925,298원',
    ].join('\n'),
    현대카드_앱알림_풀무원: [
      '현대카드',
      '강태준 님, 현대 MX Black 승인 40,000원 일시불, 9/20 23:48',
      '풀무원',
      '누적3,910,038원',
    ].join('\n'),
    // 지역화폐 광고 — source=gyeonggi 로 강제돼도 "(광고)"면 거래로 잡히면 안 됨
    // (예전엔 문구 속 "5,000원"을 결제금액으로 오인해서 가계부에 들어갔음)
    지역화폐_광고: [
      '(광고) [광명사랑상품권 5,000원 지급] 광명사랑상품권 이용 실태조사',
      '설문에 참여해 주신 분들 중 추첨을 통해 총 200분께 광명사랑상품권 5,000원을 드립니다.',
    ].join('\n'),
    // 아파트관리비 자동납부 — 일반 승인 알림과 형식이 달라(누적/시각 줄 없음, 가맹점+금액이
    // 한 줄) 전용 처리 필요 (2026-09-25 확인)
    현대카드_자동납부_관리비: [
      '현대카드',
      '자동납부 승인 강*준님 아파트관리비 656,340원',
      '자동납부 승인 강*준님 아파트관리비 656,340원',
    ].join('\n'),
    // 대한항공120 카드(국내) — MX Black과 카드명만 다를 뿐 형식은 동일, 이미 되는지 확인용
    // (2026-09-27 확인)
    현대카드_대한항공120_국내: [
      '(주)페이허브',
      '60,000원 · 일반승인',
      '강태준 님, 현대 대한항공120 승인 일시불, 8/24 16:03',
      '누적6,354,098원',
    ].join('\n'),
    // 대한항공120 카드 해외승인 — 원화("원") 없이 외화로 옴. amount=0으로 일단 기록,
    // 가맹점명에 외화 금액 남기고 "확인 필요"에 뜨게 됨 (2026-09-27 확인)
    현대카드_대한항공120_해외: [
      'JONESTHEGROCER',
      'GBP 11.45 · 해외승인',
      '강태준 님, 현대 대한항공120 해외승인 9/18 23:01',
    ].join('\n'),
    // 실제 알림 원문 (미인식알림 시트, 2026-09-17): 통화·금액이 "해외승인" 뒤에 오고, 같은 줄이 두 번 겹쳐 옴
    현대카드_해외_실제원문: [
      '현대카드',
      '강태준 님, 현대 대한항공120 해외승인 GBP 535.98 9/17 5:06 ',
      '강태준 님, 현대 대한항공120 해외승인 GBP 535.98 9/17 5:06 ',
      'HERTZUK',
    ].join('\n'),
    현대카드_해외_실제원문_EUR: [
      '현대카드',
      '강태준 님, 현대 대한항공120 해외승인 EUR 4.00 9/15 4:18 ',
      '강태준 님, 현대 대한항공120 해외승인 EUR 4.00 9/15 4:18 ',
      'MS*MARITIMFRANKFURT',
    ].join('\n'),
    // 금액 없는 안내성 알림은 거래로 잡히면 안 됨(미인식으로 남음)
    현대카드_해외사용확인알림: '현대카드\n[사고예방] 해외사용 확인 알림\n[사고예방] 해외사용 확인 알림',
    // ── 삼성카드 문자 ──
    // 실제 문자 원문 (2026-10-19 확인): 4줄 구성, [Web발신] 머리말 없음
    삼성카드_승인_실제: [
      '삼성8588승인 강*준', '39,600원 일시불', '10/19 19:01 스시노칸도시흥플', '누적262,690원',
    ].join('\n'),
    // 문자 앱 "알림"으로 받을 때: 제목 + 본문 + 큰 본문이 겹쳐 오는 경우 (2026-10-25 실제 문자: "삼성카드 승인안내" 제목, "알림" 소제목)
    삼성카드_알림_겹침: [
      '삼성카드 승인안내',
      '삼성8588승인 강*준 7,000원 일시불 10/25 11:16 365제이에스JS소아 누적282,570원',
      '알림', '삼성8588승인 강*준', '7,000원 일시불', '10/25 11:16 365제이에스JS소아', '누적282,570원',
    ].join('\n'),
    // ⚠️ 아래는 일반적인 형태를 가정한 샘플(취소·해외 등 실제 문자 원문은 아직 미확인)
    삼성카드_승인_한줄: '[Web발신]\n삼성1234승인 홍*동 15,000원 일시불 10/16 12:34 스타벅스 누적1,234,567원',
    삼성카드_승인_여러줄: [
      '[Web발신]', '삼성1234승인', '홍*동', '15,000원 일시불', '10/16 12:34', '스타벅스', '누적1,234,567원',
    ].join('\n'),
    삼성카드_취소: '[Web발신]\n삼성1234취소 홍*동 15,000원 일시불 10/16 12:40 스타벅스',
    삼성카드_해외: '[Web발신]\n삼성1234해외승인 홍*동 USD 12.34 10/16 12:34 AMAZON.COM',
    삼성카드_광고: '(광고) 삼성카드 10월 혜택 안내 승인 시 5,000원 캐시백',
    // 가맹점이 "삼성전자"인 현대카드 알림은 삼성카드로 오인되면 안 됨
    현대카드_삼성전자가맹점: [
      '삼성전자(주)', '5,900원 · 일반승인', '강태준 님, 현대 MX Black 승인 일시불, 10/8 13:00', '누적5,093,523원',
    ].join('\n'),
  };
  // source 힌트를 강제해도(=forced) 광고는 걸러지는지까지 확인
  const hints = { 우리은행_출금: 'woori', 우리은행_입금: 'woori', 우리은행_타계좌: 'woori',
                  우리은행_광고: 'woori', 하나은행_입금: 'hana_bank',
                  현대카드_앱알림_의원상호: 'hyundai', 현대카드_앱알림_풀무원: 'hyundai',
                  지역화폐_광고: 'gyeonggi', 현대카드_자동납부_관리비: 'hyundai',
                  현대카드_대한항공120_국내: 'hyundai', 현대카드_대한항공120_해외: 'hyundai',
                  현대카드_해외_실제원문: 'hyundai', 현대카드_해외_실제원문_EUR: 'hyundai', 현대카드_해외사용확인알림: 'hyundai',
                  삼성카드_승인_실제: 'samsung', 삼성카드_알림_겹침: 'samsung', 삼성카드_승인_한줄: 'samsung', 삼성카드_승인_여러줄: 'samsung', 삼성카드_취소: 'samsung',
                  삼성카드_해외: 'samsung', 삼성카드_광고: 'samsung', 현대카드_삼성전자가맹점: 'hyundai' };
  Object.keys(cases).forEach(k => {
    Logger.log(k + ' → ' + JSON.stringify(parseAlert(cases[k], new Date(2026, 8, 1), hints[k])));
  });
}

// ── 실결제 없이 전체 경로 테스트 (편집기에서 실행) ──────────
//   parseAlert → 가계부거래 시트 적재 → 중복 방지 까지 그대로 탄다.
//   실행 후 '가계부거래' 시트에 아래 샘플 1줄이 들어오면 서버쪽은 정상.
//   (같은 걸 또 실행하면 duplicate 로 안 들어옴 = 정상)
function _testIngest() {
  const sample = [
    '[Web발신]',
    '현대 MX Black 승인',
    '강*준',
    '1원 일시불',
    Utilities.formatDate(new Date(), 'Asia/Seoul', 'MM/dd HH:mm'),
    '테스트가맹점',
    '누적1원',
  ].join('\n');
  const res = ingestAlertText(sample, 'manual-test');
  Logger.log(JSON.stringify(res, null, 2));
}
