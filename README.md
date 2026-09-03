# portfolio-manager

개인용 가계부 + 자산관리 웹앱. 단일 HTML 파일(`index.html`)이고, 데이터는
비공개 Google Sheet(백엔드: Google Apps Script)에 저장된다. 이 저장소에는
**앱 코드만** 있고 재무 데이터·키·시트 주소는 들어있지 않다.

## 구성

| 경로 | 내용 |
|---|---|
| `index.html` | 앱 본체 (GitHub Pages 로 서빙) |
| `apps-script/Code.gs` | 백엔드 — 저장/불러오기, 리비전 동기화, 문자 수신(`?action=ingest`) |
| `apps-script/email_parser.gs` | 카드/결제 알림 파서 + 5분 Gmail 스캔 트리거 |
| `AUDIT.md` | 초기 코드 감사 |
| `CHANGELOG.md` | 변경 이력 (Phase 0~) |
| `tools/serve.ps1` | 로컬 테스트용 정적 서버 |

## 배포

- **프런트엔드**: 이 저장소를 GitHub Pages 로 공개 → `https://tj-kang333.github.io/portfolio-manager/`
- **백엔드**: `apps-script/` 의 두 파일을 Google Sheet 에 붙인 Apps Script 프로젝트에
  넣고 웹앱으로 배포. 그 URL 을 앱의 "Sheets 연동" 화면에 입력하면 연결됨.

## 문자 자동 수집 (MacroDroid)

결제 문자/알림 → MacroDroid HTTP 요청 → `<웹앱URL>?action=ingest&source=<hyundai|gyeonggi>`
→ 파서가 `가계부거래` 시트에 적재 → 앱이 자동 반영.
