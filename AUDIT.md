# portfolio_manager_4.html — 코드 감사 (2026-08-30)

기존 파일: 7150줄 단일 HTML. claude.ai로 제작. 아래는 "왜 자동 업데이트/동기화가 잘 안 됐나"에 초점을 맞춘 결함 목록.

## A. 치명적 (데이터 유실 위험 / 목표 직결)

### A1. 이메일 파서 백엔드가 없다  — 목표 1 (가계부 자동화)의 핵심
- 프런트엔드는 `GAS_URL + '?action=load_email_txns'` 를 호출하고( [portfolio_manager_4.html:5482](portfolio_manager_4.html:5482) ),
  `action=mark_email_done` 로 반영완료 표시를 보냄( [:5566](portfolio_manager_4.html:5566) ).
- 그런데 파일에 내장된 Apps Script 코드( `APPS_SCRIPT_CODE`, [:6611–6703](portfolio_manager_4.html:6611) )는
  `doGet` 이 `action === 'load'` 만 처리. `load_email_txns` / `mark_email_done` / Gmail 스캔 트리거가 전혀 없음.
- 즉 "미반영 거래 가져오기" 버튼은 항상 실패하거나 빈 응답. **카드 결제가 자동으로 들어오는 경로가 구현된 적이 없음.**
- 별도 `email_parser.gs` 를 설치했다면 그 코드를 확보해야 함. 안 했다면 이게 1번이 안 됐던 직접 원인.

### A2. state 를 시트 셀 1칸(A1)에 JSON 문자열로 저장 — 5만 자 한도
- `saveState` → `sh.getRange('A1').setValue(JSON.stringify(state))` ( [:6634](portfolio_manager_4.html:6634) ).
- 구글시트 셀 1칸 한도는 5만 자. 거래·월별잔고가 쌓이면 초과 → 저장 실패 또는 잘림 → **전체 데이터 유실**.
- `log` 시트에 매 저장 시 바이트 수를 남기고 있음 → 현재 크기 확인 가능. 구조화 시트로 이전 필요.

### A3. 동기화가 last-write-wins, 충돌 감지 없음 — 폰↔PC 데이터 유실
- `loadFromSheets`: `Object.assign(S, data.state)` 로 통째 덮어씀 ( [:1114](portfolio_manager_4.html:1114) ).
- 저장도 `state: S` 통째 전송 ( [:1139](portfolio_manager_4.html:1139) ). 타임스탬프/버전/리비전 없음.
- 시나리오: PC 탭 열어둠 → 폰에서 입력 → PC에서 뭔가 저장 → **폰 입력이 조용히 사라짐**.
- 최소한: 저장 전 재로드 + 리비전 번호 비교, 이상적으로는 항목 단위 머지.

### A4. 로드할 때마다 즉시 되쓰기(write-back)
- `loadFromSheets` 안에서 `migratePersonalTxns()` 가 조건부 `save()` 호출 ( [:1084](portfolio_manager_4.html:1084), [:1115](portfolio_manager_4.html:1115) ).
- 앱을 열기만 해도 시트에 쓰기 발생 가능 → A3 의 충돌 위험을 키움.

## B. 외부 API — 현재 깨졌거나 부정확

### B1. 환율 API 키 필요로 변경됨
- `api.exchangerate.host/{date}?base=USD&symbols=KRW` ( [:1222](portfolio_manager_4.html:1222) ) — 2024년부터 access key 필수. 키 없이는 실패.
- fallback `open.er-api.com/v6/latest/USD` ( [:1229](portfolio_manager_4.html:1229) ) — 동작하지만 **최신 환율만** 제공. 과거 월 잔고에 오늘 환율을 적용 → 과거치 부정확.

### B2. OKX 시세 = 근사치 + 계좌 잔고 조회 없음
- `USDC-USDT` 일봉으로 USDT/USD 를 역산 ( [:1205–1212](portfolio_manager_4.html:1205) ). 스테이블 간 환산이라 오차·CORS/지역차단 가능.
- **OKX 계좌 잔고를 읽는 코드는 없음.** 목표 2(코인 자동)를 하려면 OKX 조회 전용 API 키 + 서명 요청 필요 → Apps Script(서버)에서 처리해야 안전.

## C. 데이터 모델 — 목표를 담기엔 부족

### C1. 주식이 "수량"이 아니라 "월별 잔고 금액"으로 저장됨
- `months[YYYY-MM][acctNo][ticker] = {name, balance, assetId}` ( [:1047](portfolio_manager_4.html:1047) ).
- 보유 수량/평단이 없음 → **시세를 자동으로 받아도 평가액을 계산할 수 없음**. 매달 잔고를 손으로 넣는 구조.
- 필요: `holdings` 모델 (ticker, 수량, 평단, 계좌) + 시세 자동 → 평가액·수익률 계산.

### C2. 스냅샷이 월 단위뿐 — 목표 2는 "하루 단위"
- `S.months` 는 `YYYY-MM` 키. 일자별 자산 추이가 불가능.
- 필요: `snapshots` 시계열 (날짜별 계좌잔고/평가액), 그래프·수익률 계산의 토대.

### C3. 가계부 ↔ 자산 연계가 거의 없음  — 목표 3
- 유일한 연결: 카테고리명이 정확히 "투자 이체"인 지출을 `S.deposits[월]` 에 더함 ( [:5554–5557](portfolio_manager_4.html:5554) ).
- 순자산(은행+주식평가+코인−카드미결제), 현금흐름↔순자산 정합성, 배당·이자 양쪽 반영 등은 없음.

## D. 보안 / 견고성 (중간)

- **D1.** GAS 엔드포인트에 인증 토큰 없음 — URL 아는 사람은 전 재무데이터 읽기/쓰기. 공유 시크릿 파라미터 추가 권장. (URL 자체는 localStorage 에만 있고 소스에는 없음 → 공개 저장소여도 URL 은 노출 안 됨.)
- **D2.** `anthropic_api_key` 를 localStorage 평문 저장 ( [:2212](portfolio_manager_4.html:2212) ). 본인 브라우저 한정이라 위험은 제한적이나, 파싱 보조는 서버(Apps Script)로 옮기는 게 나음.
- **D3.** `fetchEmailParsedTxns` 가 전역 `event` 에 의존 ( [:5479](portfolio_manager_4.html:5479) ) — 크롬에서만 동작, 표준 아님.
- **D4.** 단일 7150줄 HTML — 유지보수/부분수정이 어려움. 최소한 CSS/JS 분리, 가능하면 모듈 분할.

## 종합

구조 선택(구글시트+Apps Script+Gmail 파서, 크립토 API, CSV import)은 옳음.
못 돌아간 이유는 **(A1) 이메일 파서 백엔드 미구현 + (A3) 동기화 충돌 처리 부재 + (C1/C2) 자동 시세를 담을 데이터 모델 부재** 세 가지가 핵심.
