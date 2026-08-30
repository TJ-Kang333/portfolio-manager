# 변경 이력

## Phase 2 (진행중) — 문자/알림 파서 (2026-08-30)

목표: 결제하면 손 안 대도 `가계부거래` 시트에 쌓이게 (AUDIT A1).

### 파이프라인
```
결제 → 카드 SMS / 결제앱 push
     → 폰의 MacroDroid (SMS 수신 트리거 + 알림 수신 트리거)
     → 제목에 FINALERT 든 메일로 "시트 소유 계정" Gmail 전송
     → Gmail 필터가 라벨 'finalert' 부여
     → Apps Script parseFinanceAlerts() 5분 트리거
     → 파싱 후 '가계부거래' 시트에 append (해시로 중복 방지)
     → 앱에서 "미반영 거래 가져오기"로 검토·반영 (기존 UI 그대로)
```

### 새 파일: `apps-script/email_parser.gs`
- `setupFinanceAlertTrigger()` — 편집기에서 1회 실행 → 5분 트리거 생성 + 즉시 1회 수집.
- `parseFinanceAlerts()` — `finalert` 라벨 메일 스캔 → 파싱 → 시트 적재 → 라벨을
  `finalert-done`(성공) 또는 `finalert-review`(파서 미인식)로 이동. 아무것도 조용히 버리지 않음.
- 컬럼: A날짜 B유형(expense/income) C가맹점 D금액 E출처 F원문 **G해시(중복키)** H상태.
  (G열은 기존 `loadEmailTxns`가 안 읽던 자리 → 안전하게 재사용)
- 중복 방지: `출처|날짜|금액|가맹점|유형` MD5 → 시트 G열과 대조.
- 연도 보정: SMS엔 연도가 없음 → 메일 수신 연도 사용, 3일 이상 미래면 -1년(12/31↔1/1 경계).

### 파서 현황
- **현대카드 승인/취소 SMS** — 작성 + 테스트 완료.
  - 실제 샘플 + 할부(`360,000원 3개월`) + 취소(`승인취소`→income) + 2줄 가맹점 검증.
  - 버그 1건 잡음: 금액을 `[^\d]` 전부 제거로 뽑으면 "3개월"의 3이 붙음 → `([\d,]+)원` 앞부분만 추출로 수정.
- **경기지역화폐** — 스텁. 앱 결제 알림(push) 샘플 필요. MacroDroid "알림 수신" 트리거로 같은 파이프에 태움.
- **하나카드** — 스텁. 승인 SMS 샘플 나오면 작성.

### 사용자가 할 것
1. `email_parser.gs`를 기존 Apps Script 프로젝트에 **새 파일로** 추가 → 저장.
2. 편집기에서 `setupFinanceAlertTrigger` 실행 → Gmail 권한 승인.
3. 폰에 **MacroDroid** 설치 후 매크로 2개 (받는사람 = **구글 시트를 소유한 Gmail 계정**):
   - 매크로 A: 트리거 `SMS 수신` → 동작 `이메일 보내기` (제목=`FINALERT 카드`, 본문=매직텍스트 `{sms_message}`).
   - 매크로 B: 트리거 `알림 수신` → 앱 `경기지역화폐` → 동작 `이메일 보내기` (제목=`FINALERT 지역화폐`, 본문=`{notification_title}` 줄바꿈 `{notification_message}`).
   - ※ 제목에 대괄호 `[ ]` 쓰지 말 것 (MacroDroid가 변수로 오해). MacroDroid, 경기지역화폐 앱 둘 다 배터리 최적화 해제.
4. Gmail 필터: 검색 `subject:FINALERT` → `라벨 적용: finalert` (읽음처리 X). 라벨은 처음 한 번 직접 만들어야 할 수도 있음.
5. 카드 한 번 긁고 → 5분 뒤 스프레드시트 `가계부거래`에 행이 생기는지 확인 → 앱에서 "미반영 거래 가져오기".
6. 경기지역화폐로 소액 결제 후, 그 앱 알림 문구를 캡처해서 전달 (파서 작성용).



## Phase 1 — 동기화 견고화 (2026-08-30)

목표: 폰↔PC에서 한쪽 편집이 다른 쪽 저장에 조용히 덮여 사라지는 문제(AUDIT A3) 제거.

### 서버 (`apps-script/Code.gs`)
- **리비전 도입.** `meta` 시트 `B1`에 정수 `rev`. 저장 성공 시마다 +1.
- `doGet`:
  - `?action=load` → 응답에 `rev` 포함.
  - `?action=rev` (신규) → `rev`만 반환하는 가벼운 확인용.
- `doPost` 저장 경로:
  - 요청의 `baseRev`와 서버 현재 `rev` 비교.
  - 같으면 저장 + `rev` +1, 새 `rev` 반환.
  - 다르면 `{ ok:false, conflict:true, rev, state }` 반환 (덮어쓰지 않음).
  - `baseRev` 미전송(구버전 클라이언트)은 그대로 통과 — **하위호환 유지**.
  - `LockService` 스크립트 락으로 동시 저장 직렬화.

### 클라이언트 (`portfolio_manager_4.html`)
- `_baseRev` 추적 + `localStorage['pf_rev']`에 영속.
- `loadFromSheets()` → 응답의 `rev` 저장.
- `saveToSheets()`:
  - `baseRev` 함께 전송.
  - `conflict` 응답 시 → 서버 상태의 **추가분만 로컬에 병합**(`mergeServerInto`) 후 1회 재저장.
  - 병합 규칙: 저장하는 쪽(현재 기기)이 충돌 시 우선, 단 다른 기기가 **새로 추가한** 항목(거래·계좌·카테고리·암호화폐·월별잔고·포트폴리오)은 union으로 보존.
  - 삭제 동기화는 이번 범위 밖 — 드물게 한쪽에서 지운 항목이 되살아날 수 있음 (추후 tombstone).
- `checkFreshness()` (신규): 탭이 다시 활성화될 때 + 90초마다 `?action=rev` 확인 → 서버가 앞서 있으면 조용히 불러와 병합·재렌더. 저장 진행 중이면 건너뜀.

### 검증
- 병합 헬퍼 단위 테스트(`_mergeById`/`_mergeMap`/`_mergeMonths`/`mergeServerInto`) — 브라우저 콘솔에서 통과.
- 충돌 왕복 시뮬레이션(모의 서버 응답) — 로컬/서버 거래 both 보존, `rev` 갱신, 플래그 정리 확인.
- 실제 GAS 왕복은 아래 배포 후 확인 필요.

### 배포 방법 (사용자가 할 것)
1. [script.google.com](https://script.google.com) → 기존 프로젝트 열기.
2. `Code.gs` 내용을 이 저장소의 `apps-script/Code.gs`로 **전체 교체**.
3. 저장 → **배포 → 배포 관리 → 편집(연필) → 버전: 새 버전 → 배포.**
   (URL은 그대로 유지됨. "새 배포"를 만들면 URL이 바뀌니 하지 말 것.)
4. 앱에서 아무 값이나 바꿔 저장 → 동기화 상태에 "Sheets 저장됨" 뜨는지 확인.
5. 스프레드시트에 `meta` 시트가 생기고 `B1` 숫자가 올라가는지 확인.
6. (선택) 폰·PC 양쪽에서 열어 한쪽에서 거래 추가 → 다른 쪽에서 90초 내 반영되는지 확인.
