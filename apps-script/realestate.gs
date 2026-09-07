// ============================================================
//  KB부동산 KB시세(하한가) 자동 조회 — Code.gs 와 같은 프로젝트에 별도 파일로.
//
//  ⚠️ KB부동산의 "비공식" 내부 API 를 사용한다.
//     - 예고 없이 바뀔 수 있음 (그러면 그냥 값이 안 옴, 앱은 안 죽음)
//     - 구글 서버(해외 IP)에서 차단될 가능성이 있음
//     → 배포 후 편집기에서 먼저 _testKbPrice() 를 실행해 로그를 확인할 것.
//       {ok:true, low: ...} 가 나오면 성공. HTTP 403/451 이나 빈 응답이면 해외 IP 차단.
//
//  쓰는 값:
//   - 법정동코드(10자리): 아파트가 속한 법정동. 예) 서울 강남구 대치동 = 1168010600
//     (행정표준코드관리시스템 code.go.kr 또는 주소 검색으로 확인)
//   - 단지명: KB부동산에 등록된 이름 (예: "은마", "래미안대치팰리스")
//   - (선택) 면적일련번호: 특정 평형. 안 주면 단지 대표 평형 사용.
// ============================================================

const KB_API = 'https://api.kbland.kr';

function _kbGet(path, params) {
  const qs = Object.keys(params || {})
    .map(k => encodeURIComponent(k) + '=' + encodeURIComponent(params[k]))
    .join('&');
  const res = UrlFetchApp.fetch(KB_API + path + (qs ? '?' + qs : ''), {
    muteHttpExceptions: true,
    headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)', 'Referer': 'https://kbland.kr/' },
  });
  const code = res.getResponseCode();
  const txt = res.getContentText();
  let json = null;
  try { json = JSON.parse(txt); } catch (e) {}
  return { code: code, json: json, raw: txt.slice(0, 300) };
}

// 법정동코드 안의 아파트 단지 목록에서 이름으로 단지기본일련번호 찾기
function kbFindComplex(lawdCd, name) {
  const r = _kbGet('/land-complex/complexComm/hscmList', { '법정동코드': lawdCd });
  const list = r.json && r.json.dataBody && r.json.dataBody.data;
  if (!Array.isArray(list)) return { err: 'hscmList 실패 (HTTP ' + r.code + ') ' + r.raw };
  const norm = s => String(s || '').replace(/\s|아파트|APT/gi, '');
  const want = norm(name);
  // 아파트/주상복합 우선 → 타입 무관 정확일치 → 부분일치 순
  let hit = list.find(c => norm(c['단지명']) === want && /아파트|주상복합/.test(c['매물종별구분명'] || ''));
  if (!hit) hit = list.find(c => norm(c['단지명']) === want);
  if (!hit) hit = list.find(c => norm(c['단지명']).indexOf(want) > -1);
  return hit ? { hscmSn: hit['단지기본일련번호'], name: hit['단지명'] } : { err: '단지 못 찾음: ' + name };
}

// 단지 대표 평형의 면적일련번호
function kbRepAreaSn(hscmSn) {
  const r = _kbGet('/land-complex/complex/main', { '단지기본일련번호': hscmSn });
  const d = r.json && r.json.dataBody && r.json.dataBody.data;
  return d ? d['대표면적일련번호'] : null;
}

// 단지 + 면적일련번호 → KB시세 (원 단위)
function kbPrice(hscmSn, areaSn) {
  const r = _kbGet('/land-price/price/BasePrcInfoNew', { '단지기본일련번호': hscmSn, '면적일련번호': areaSn });
  const arr = r.json && r.json.dataBody && r.json.dataBody.data && r.json.dataBody.data['시세'];
  const s = Array.isArray(arr) ? arr[0] : null;
  if (!s) return { err: 'BasePrcInfoNew 시세 없음 (HTTP ' + r.code + ') ' + r.raw };
  const won = v => (v == null || v === '' ? null : Math.round(Number(v) * 10000)); // 만원 → 원
  return {
    low: won(s['매매하한가']), mid: won(s['매매일반거래가']), high: won(s['매매상한가']),
    baseDate: s['기준년월일'] || s['시세기준년월일'] || null,
    area: (s['공급면적평수'] || '?') + '평 (전용 ' + (s['전용면적'] || '?') + '㎡)',
  };
}

// 전체 조회: (법정동코드+단지명) 또는 (hscmSn 직접) [+ 면적일련번호] → KB시세
// hscmSn 을 주면 이름 검색을 건너뜀 (같은 이름의 오피스텔/주상복합 구분 등).
function kbLookup(lawdCd, name, areaSn, hscmSn) {
  let c;
  if (hscmSn) {
    c = { hscmSn: hscmSn, name: name || ('단지#' + hscmSn) };
  } else {
    c = kbFindComplex(lawdCd, name);
    if (c.err) return { ok: false, error: c.err };
  }
  const sn = areaSn || kbRepAreaSn(c.hscmSn);
  if (!sn) return { ok: false, error: '면적일련번호 없음 (hscmSn=' + c.hscmSn + ')' };
  const pr = kbPrice(c.hscmSn, sn);
  if (pr.err) return { ok: false, error: pr.err, hscmSn: c.hscmSn, areaSn: sn };
  return { ok: true, complex: c.name, hscmSn: c.hscmSn, areaSn: sn,
           low: pr.low, mid: pr.mid, high: pr.high, baseDate: pr.baseDate, area: pr.area };
}

// doGet ?action=kb_price&lawd=1168010100&name=개나리래미안[&area=133735][&hscm=32011]
function kbPriceResponse(p) {
  const hscm = p && p['hscm'] ? String(p['hscm']).trim() : null;
  if (!hscm && (!p || !p['lawd'] || !p['name']))
    return { ok: false, error: 'lawd(법정동코드 10자리)+name(단지명), 또는 hscm(단지ID) 이 필요합니다' };
  return kbLookup(
    p['lawd'] ? String(p['lawd']).trim() : null,
    p['name'] ? String(p['name']).trim() : null,
    p['area'] ? String(p['area']).trim() : null,
    hscm);
}

// ── 편집기 점검: 해외 IP 차단 여부 + 파서 확인 ─────────────
function _testKbPrice() {
  // 역삼동(1168010100) '개나리래미안' — 아무 단지나 넣어 값이 오는지만 확인
  const res = kbLookup('1168010100', '개나리래미안');
  Logger.log(JSON.stringify(res, null, 2));
  // 원시 응답도 한 번 — HTTP 코드 확인용 (403/451 이면 구글 서버 IP 차단)
  const raw = _kbGet('/land-complex/complexComm/hscmList', { '법정동코드': '1168010100' });
  Logger.log('hscmList HTTP ' + raw.code + ' / 본문앞부분: ' + raw.raw);
}
