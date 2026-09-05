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
function ingestAlertText(rawText, sourceHint) {
  const text = String(rawText || '').replace(/\r/g, '').trim();
  if (!text) return { ok: false, error: '빈 내용' };

  const rec = parseAlert(text, new Date(), sourceHint);
  if (rec && rec.skip) return { ok: true, skipped: true };
  if (!rec) { stashUnparsed(text, sourceHint); return { ok: true, unparsed: true }; }

  const lock = LockService.getScriptLock();
  const locked = lock.tryLock(15000); // 못 잡아도 진행 — 중복은 해시로 거른다
  const ts = new Date().toISOString();
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
function parseAlert(text, msgDate, sourceHint) {
  const hint = normalizeSourceHint(sourceHint);
  const list = hint
    ? ALERT_PARSERS.slice().sort((a, b) => (b.srcKey === hint ? 1 : 0) - (a.srcKey === hint ? 1 : 0))
    : ALERT_PARSERS;
  for (const p of list) {
    const forced = hint && p.srcKey === hint;
    if (!forced && !p.match(text)) continue;
    const r = p.parse(text, msgDate);
    if (r && r.skip) return { skip: true };
    if (r && r.amount > 0 && r.date) {
      r.source = r.source || p.name;
      r.raw    = text.slice(0, 500);
      r.merchant = (r.merchant || '').trim();
      // 알림 원문의 시각(MM/DD HH:MM) — 같은 금액 거래를 하루에 두 번 해도 구분되도록 중복키에 포함.
      // 같은 알림이 이메일+HTTP 로 두 번 와도 원문 시각은 같으니 여전히 중복 제거됨.
      r.timeKey = (text.match(/\d{1,2}\/\d{1,2}\s+\d{1,2}:\d{2}/) || [''])[0];
      r.hash   = makeHash(r);
      return r;
    }
    if (forced) return null; // 지정된 파서가 못 뽑으면 다른 파서로 넘기지 않음
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
    match: t => /현대/.test(t) && /(승인|취소)/.test(t) && /누적/.test(t),
    parse: (t, msgDate) => {
      const lines = t.split('\n').map(s => s.trim()).filter(Boolean);
      const isCancel = /취소/.test(t);

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
        const isBoilerplate = l => !l || /원/.test(l) || /(승인|취소)/.test(l) || /^\d/.test(l) ||
          /님,?$/.test(l) || /^현대\s*(카드)?$/.test(l) || /MX\s*Black/i.test(l) || /^누적/.test(l);
        merchant = lines.find(l => !isBoilerplate(l)) || '';
      }

      return { type: isCancel ? 'income' : 'expense', amount, merchant, source: '현대카드', date };
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

      return { type: isCancel ? 'income' : 'expense', amount, merchant, source: '경기지역화폐', date };
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

// 우리은행/하나은행 공용 파서 — 배열 순서(금액↔유형)가 은행마다 달라 순서 무관 정규식으로 처리
function parseBankAlert(t, msgDate, sourceLabel) {
  const m = t.match(/(입금|출금)/);
  if (!m) return null; // 광고 등 실제 거래 알림이 아님
  const isOut = m[1] === '출금';

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
    하나은행_입금: [
      '하나은행',
      '입금 100,000원 생활비급여    잔액 1,494,051원 09/05 21:50 118-******-72107',
    ].join('\n'),
    우리은행_광고: [
      '(광고)LCK 한정굿즈 사전응모', 'LCK 결승전 현장 수령', '당첨되고 편히 수령해요!',
    ].join('\n'),
  };
  // source 힌트를 강제해도(=forced) 광고는 걸러지는지까지 확인
  const hints = { 우리은행_출금: 'woori', 우리은행_광고: 'woori', 하나은행_입금: 'hana_bank' };
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
