// ============================================================
//  포트폴리오 관리 — Google Apps Script 백엔드 (v5)
//  배포: 웹앱 / 액세스 권한 = 모든 사용자
//  ※ 이 파일은 사용자가 script.google.com 에 배포해 둔 현재 코드의 사본.
//     프로젝트 버전 관리를 위해 저장. 편집은 여기서 하고 GAS 에 반영.
// ============================================================

const SHEET_NAME = 'state';
const TXN_SHEET  = '가계부거래';
const META_SHEET = 'meta';
const CHUNK_SIZE = 45000; // 셀당 최대 45,000자

// ── 리비전(동기화 충돌 감지용) ────────────────────────────
// meta 시트 B1 에 정수 하나. 저장 성공 시마다 +1.
function getMetaSheet() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  let sh = ss.getSheetByName(META_SHEET);
  if (!sh) {
    sh = ss.insertSheet(META_SHEET);
    sh.getRange('A1').setValue('rev');
    sh.getRange('B1').setValue(0);
  }
  return sh;
}
function getRev() {
  return parseInt(getMetaSheet().getRange('B1').getValue()) || 0;
}
function setRev(n) {
  getMetaSheet().getRange('B1').setValue(n);
}

function getStateSheet() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  let sh = ss.getSheetByName(SHEET_NAME);
  if (!sh) sh = ss.insertSheet(SHEET_NAME);
  return sh;
}

function loadState() {
  const sh = getStateSheet();
  // A1에 청크 수 저장, A2부터 데이터
  const chunkCount = parseInt(sh.getRange('A1').getValue()) || 0;
  if (chunkCount === 0) {
    // 구버전 호환: A1에 JSON이 통째로 있는 경우
    const v = sh.getRange('A1').getValue();
    if (!v || typeof v !== 'string') return null;
    try { return JSON.parse(v); } catch(e) { return null; }
  }
  let json = '';
  for (let i = 0; i < chunkCount; i++) {
    json += sh.getRange(i + 2, 1).getValue();
  }
  try { return JSON.parse(json); } catch(e) { return null; }
}

function saveState(state) {
  const sh = getStateSheet();
  const json = JSON.stringify(state);
  const chunks = [];
  for (let i = 0; i < json.length; i += CHUNK_SIZE) {
    chunks.push(json.slice(i, i + CHUNK_SIZE));
  }
  // 기존 내용 지우기
  sh.clearContents();
  // A1에 청크 수, A2부터 청크 저장
  sh.getRange('A1').setValue(chunks.length);
  chunks.forEach((chunk, i) => {
    sh.getRange(i + 2, 1).setValue(chunk);
  });
  // 로그
  try {
    const ss = SpreadsheetApp.getActiveSpreadsheet();
    let log = ss.getSheetByName('log');
    if (!log) { log = ss.insertSheet('log'); log.appendRow(['timestamp','bytes','chunks']); }
    log.appendRow([new Date().toISOString(), json.length, chunks.length]);
  } catch(e) {}
}

function makeResponse(data) {
  return ContentService
    .createTextOutput(JSON.stringify(data))
    .setMimeType(ContentService.MimeType.JSON);
}

function loadEmailTxns() {
  try {
    const ss    = SpreadsheetApp.getActiveSpreadsheet();
    const sheet = ss.getSheetByName(TXN_SHEET);
    if (!sheet) return makeResponse({ ok: true, rows: [] });
    const data = sheet.getDataRange().getValues();
    const rows = [];
    for (let i = 1; i < data.length; i++) {
      const row    = data[i];
      const status = String(row[7] || '').trim();
      if (status === 'done') continue;
      const amount = parseFloat(row[3]) || 0;
      rows.push({
        rowIndex: i + 1,
        date:     formatDateVal(row[0]),
        type:     String(row[1] || 'expense').trim(),
        merchant: String(row[2] || '').trim(),
        amount:   amount,
        source:   String(row[4] || '').trim(),
        raw:      String(row[5] || '').trim(),
      });
    }
    return makeResponse({ ok: true, rows });
  } catch(e) {
    return makeResponse({ ok: false, error: e.message });
  }
}

function markEmailDone(rowIndices) {
  try {
    const ss    = SpreadsheetApp.getActiveSpreadsheet();
    const sheet = ss.getSheetByName(TXN_SHEET);
    if (!sheet || !rowIndices || !rowIndices.length) return makeResponse({ ok: true });
    rowIndices.forEach(r => sheet.getRange(r, 8).setValue('done'));
    return makeResponse({ ok: true, updated: rowIndices.length });
  } catch(e) {
    return makeResponse({ ok: false, error: e.message });
  }
}

function formatDateVal(val) {
  if (!val) return '';
  if (val instanceof Date) return Utilities.formatDate(val, 'Asia/Seoul', 'yyyy-MM-dd');
  return String(val).slice(0, 10).replace(/[./]/g, '-');
}

function doGet(e) {
  try {
    const action = (e && e.parameter && e.parameter.action) || 'load';
    if (action === 'load')            return makeResponse({ ok: true, state: loadState(), rev: getRev() });
    if (action === 'rev')             return makeResponse({ ok: true, rev: getRev() });
    if (action === 'load_email_txns') return loadEmailTxns();
    return makeResponse({ ok: false, error: '알 수 없는 action' });
  } catch(err) {
    return makeResponse({ ok: false, error: err.message });
  }
}

function doPost(e) {
  try {
    let body    = null;
    let state   = null;
    let baseRev = null; // 클라이언트가 마지막으로 알던 rev (없으면 구버전 클라이언트)
    if (e.postData && e.postData.contents) {
      const raw = e.postData.contents;
      try { body = JSON.parse(raw); } catch(err) {}
    }
    // ── MacroDroid 등에서 문자/알림 원문을 직접 POST (Gmail 우회) ──
    //   URL 에 ?action=ingest, 본문(text/plain)에 문자 원문. 또는 JSON {action:'ingest', text, source}.
    const ingestAction = (e.parameter && e.parameter.action === 'ingest') ||
                         (body && body.action === 'ingest');
    if (ingestAction) {
      const text = (body && body.text) ||
                   (e.parameter && e.parameter.text) ||
                   (e.postData && e.postData.contents) || '';
      const src  = (body && body.source) || (e.parameter && e.parameter.source) || '';
      return makeResponse(ingestAlertText(text, src));
    }

    if (body) {
      if (body.action === 'mark_email_done') return markEmailDone(body.rowIndices);
      if (body.state)              state = body.state;
      if (body.baseRev != null)    baseRev = parseInt(body.baseRev);
    }
    if (!state && e.parameter) {
      if (e.parameter.payload) {
        try {
          const b = JSON.parse(e.parameter.payload);
          if (b.action === 'mark_email_done') return markEmailDone(b.rowIndices);
          if (b.state)           state = b.state;
          if (b.baseRev != null) baseRev = parseInt(b.baseRev);
        } catch(err) {}
      }
      if (!state && e.parameter.state) {
        try { state = JSON.parse(e.parameter.state); } catch(err) {}
      }
      if (baseRev == null && e.parameter.baseRev != null) baseRev = parseInt(e.parameter.baseRev);
    }
    if (state) {
      // 동시 저장 직렬화 — rev 확인과 쓰기가 겹치지 않게
      const lock = LockService.getScriptLock();
      try { lock.waitLock(30000); }
      catch(err) { return makeResponse({ ok: false, error: '다른 저장이 진행 중입니다. 잠시 후 재시도.' }); }
      try {
        const cur = getRev();
        // baseRev 를 보낸 클라이언트만 충돌 검사. 구버전(미전송)은 그대로 통과.
        if (baseRev != null && !isNaN(baseRev) && baseRev !== cur) {
          return makeResponse({ ok: false, conflict: true, rev: cur, state: loadState() });
        }
        saveState(state);
        const next = cur + 1;
        setRev(next);
        return makeResponse({ ok: true, rev: next });
      } finally {
        lock.releaseLock();
      }
    }
    return makeResponse({ ok: false, error: '저장할 state를 찾지 못했습니다.' });
  } catch(err) {
    return makeResponse({ ok: false, error: err.message });
  }
}
