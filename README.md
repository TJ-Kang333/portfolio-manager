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
- **백엔드 자동 반영**: `main` 에 `apps-script/` 변경이 머지되면 GitHub Actions
  (`.github/workflows/apps-script-deploy.yml`)가 clasp 로 Apps Script 에 코드를 올리고 기존 웹앱 배포를
  새 버전으로 업데이트(URL 그대로). 반영 전에 Apps Script 의 현재 코드를 저장소 기록과 비교해서, 어느 버전과도
  다르면(= 편집기에서 직접 고침) 덮어쓰지 않고 멈춤. 매니페스트(`apps-script/appsscript.json`)는 저장소 것과
  같아야 진행. 처음 설정은 아래 참고.

## Apps Script 자동 반영 — 처음 한 번 설정

1. https://script.google.com/home/usersettings 에서 **Google Apps Script API** 를 켬.
2. PC 에 Node.js 를 설치하고 터미널(PowerShell)에서:
   ```
   npm install -g @google/clasp@2.4.2
   clasp login
   ```
   브라우저에서 Google 계정(시트 소유 계정)으로 허용하면 사용자 폴더에 `.clasprc.json` 이 생김
   (Windows: `notepad $HOME\.clasprc.json`). 워크플로와 같은 버전(2.4.2)이어야 파일 형식이 맞음.
3. GitHub 저장소 → Settings → Secrets and variables → Actions → **New repository secret** 3개:
   - `CLASPRC_JSON`: `.clasprc.json` 내용 전체
   - `APPS_SCRIPT_ID`: Apps Script 편집기 → 프로젝트 설정(톱니바퀴) → 스크립트 ID
   - `APPS_SCRIPT_DEPLOYMENT_ID`: 편집기 → 배포 → 배포 관리 → 지금 쓰는 웹앱의 배포 ID
4. Actions 탭 → **Apps Script 배포** → Run workflow → `check` 로 실행해서 Apps Script 의 현재 코드와
   저장소를 비교(통과하면 설정 끝). 매니페스트를 편집기에서 바꿨다면 `apps-script/appsscript.json` 도 같이 맞출 것.

Secrets 가 없으면 워크플로는 아무것도 하지 않고 넘어감(예전처럼 직접 붙여넣기).
`.clasprc.json` 은 Google 계정 권한이 담긴 인증 정보이므로 Secrets 외의 곳(저장소·채팅 등)에 올리지 말 것.

## 문자 자동 수집 (MacroDroid)

결제 문자/알림 → MacroDroid HTTP 요청 → `<웹앱URL>?action=ingest&source=<hyundai|samsung|lotte|gyeonggi|woori|hana_bank|hana_card>`
→ 파서가 `가계부거래` 시트에 적재 → 앱이 자동 반영.
