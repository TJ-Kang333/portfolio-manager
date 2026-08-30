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
//        제목에 [FINALERT] 가 든 메일로 본인 Gmail 에 보내고,
//        Gmail 필터가 그 메일에 라벨 'finalert' 를 붙인다.
// ============================================================

const ALERT_LABEL        = 'finalert';         // 수집 대기
const ALERT_DONE_LABEL   = 'finalert-done';    // 파싱 완료
const ALERT_REVIEW_LABEL = 'finalert-review';  // 파서가 인식 못함 — 수동 확인 필요
const TXN_SHEET_NAME     = '가계부거래';
// 컬럼: A날짜 B유형 C가맹점 D금액 E출처 F원문 G해시(중복방지) H상태('' | 'done')
const ALERT_HEADER = ['날짜', '유형', '가맹점', '금액', '출처', '원문', '해시', '상태'];

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
  try { lock.waitLock(30000); } catch (e) { return; }
  try {
    const label = GmailApp.getUserLabelByName(ALERT_LABEL);
    if (!label) return; // 필터/라벨 아직 미설정

    const doneLabel   = GmailApp.getUserLabelByName(ALERT_DONE_LABEL)   || GmailApp.createLabel(ALERT_DONE_LABEL);
    const reviewLabel = GmailApp.getUserLabelByName(ALERT_REVIEW_LABEL) || GmailApp.createLabel(ALERT_REVIEW_LABEL);

    const sheet  = getTxnSheet();
    const hashes = getExistingHashes(sheet);

    label.getThreads(0, 50).forEach(thread => {
      let anyFail = false;
      thread.getMessages().forEach(msg => {
        const text = extractAlertText(msg);
        if (!text) return;
        const rec = parseAlert(text, msg.getDate());
        if (!rec) { anyFail = true; return; }
        if (hashes.has(rec.hash)) return; // 중복 스킵
        sheet.appendRow([rec.date, rec.type, rec.merchant, rec.amount, rec.source, rec.raw, rec.hash, '']);
        hashes.add(rec.hash);
      });
      thread.removeLabel(label);
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

// ── 파서 레지스트리 ──────────────────────────────────────
function parseAlert(text, msgDate) {
  for (const p of ALERT_PARSERS) {
    if (!p.match(text)) continue;
    const r = p.parse(text, msgDate);
    if (r && r.amount > 0 && r.date) {
      r.source = r.source || p.name;
      r.raw    = text.slice(0, 500);
      r.merchant = (r.merchant || '').trim();
      r.hash   = makeHash(r);
      return r;
    }
  }
  return null;
}

function makeHash(r) {
  const key = [r.source, r.date, r.amount, (r.merchant || '').replace(/\s/g, ''), r.type].join('|');
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

  // ── 현대카드 승인/취소 SMS ────────────────────────────
  //  [Web발신]
  //  현대카드 MX Black 승인
  //  강*준
  //  24,800원 일시불
  //  03/05 19:40
  //  네이버페이
  //  누적2,930,149원
  {
    name: '현대카드',
    match: t => /현대카드/.test(t) && /(승인|취소)/.test(t),
    parse: (t, msgDate) => {
      const lines = t.split('\n').map(s => s.trim()).filter(Boolean);
      const isCancel = /취소/.test(t);

      // 금액 줄: '원' 포함 + 결제방식(일시불/할부) 포함. 없으면 '누적' 아닌 첫 금액 줄.
      const amtLine = lines.find(l => /[\d,]+\s*원/.test(l) && /(일시불|개월|할부)/.test(l))
                   || lines.find(l => /[\d,]+\s*원/.test(l) && !/누적/.test(l));
      // '원' 앞의 숫자만 — "360,000원 3개월" 에서 뒤의 3 이 붙지 않도록
      const am = amtLine && amtLine.match(/([\d,]+)\s*원/);
      const amount = am ? parseInt(am[1].replace(/,/g, ''), 10) : 0;

      // 날짜/시각: MM/DD HH:MM
      const dm = t.match(/(\d{1,2})\/(\d{1,2})\s+\d{1,2}:\d{2}/);
      const date = dm ? resolveDate(parseInt(dm[1], 10), parseInt(dm[2], 10), msgDate) : null;

      // 가맹점: 날짜 줄 다음 줄부터 '누적' 나오기 전까지
      let merchant = '';
      const dIdx = lines.findIndex(l => /^\d{1,2}\/\d{1,2}\s+\d{1,2}:\d{2}$/.test(l));
      if (dIdx >= 0) {
        for (let i = dIdx + 1; i < lines.length && !/^누적/.test(lines[i]); i++) {
          merchant = (merchant ? merchant + ' ' : '') + lines[i];
        }
      }

      return { type: isCancel ? 'income' : 'expense', amount, merchant, source: '현대카드', date };
    }
  },

  // ── 경기지역화폐 (앱 알림) — 샘플 확보 후 작성 ─────────
  // {
  //   name: '경기지역화폐',
  //   match: t => /지역화폐/.test(t),
  //   parse: (t, msgDate) => { ... }
  // },

  // ── 하나카드 승인 SMS — 샘플 확보 후 작성 ─────────────
  // {
  //   name: '하나카드',
  //   match: t => /하나(카드)?/.test(t) && /승인/.test(t),
  //   parse: (t, msgDate) => { ... }
  // },

];

// ── 편집기에서 파서 점검용 (Gmail 없이) ──────────────────
function _testParser() {
  const sample = [
    '[Web발신]',
    '현대카드 MX Black 승인',
    '강*준',
    '24,800원 일시불',
    '03/05 19:40',
    '네이버페이',
    '누적2,930,149원',
  ].join('\n');
  const r = parseAlert(sample, new Date(2026, 2, 5));
  Logger.log(JSON.stringify(r, null, 2));
}
