# 변경 이력

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
