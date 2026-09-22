# Mattermost Manager Plugin (MMP)

Codex와 Claude Code에서 함께 사용하는 로컬 stdio MCP 서버입니다. Mattermost Incoming Webhook, 논리 채널, 참여자 식별 정보, 메시지 컨벤션을 로컬 SQLite에 저장하고 자연어로 관리하거나 메시지를 전송할 수 있습니다.

## 기능

- Mattermost Incoming Webhook 등록·조회·수정·삭제
- 여러 논리 채널 및 DM 대상 등록·조회·수정·삭제
- 전역 사람 정보 CRUD, 이름 부분검색, GitLab 사용자와 Mattermost `@아이디` 매핑
- 전역 사람을 외래키로 연결하는 논리 채널별 참여자 디렉터리
- 저장된 사람에게 Incoming Webhook 채널 오버라이드로 개인 DM 전송
- `{{variable}}` 메시지 컨벤션 CRUD 및 미리보기
- 한 번의 호출로 여러 채널에 메시지 전송
- Codex·Claude Code 공용 자연어 리뷰 메시지·웹훅·채널 관리 스킬
- 리뷰 요청·완료 메시지의 정확한 `@멘션`, 상태 이모지, MR/Jira 한 줄 형식 강제
- GitLab 인스턴스·Personal Access Token 등록 및 토큰 교체
- 본인이 리뷰어인 열린 MR 조회, 신규 건 표시, MR 확인 이모지 등록
- MR diff·기존 논의 조회와 리뷰 댓글 등록(MR 댓글 및 라인 댓글)
- 처리한 MR의 todo 정리, 재태그 시 재리뷰 요청으로 구분

## 요구 환경

- Node.js 22.13 이상 (`node:sqlite` 무플래그 사용)
- npm
- Git
- Codex CLI 또는 Claude Code
- 메시지를 보낼 Mattermost Incoming Webhook URL
- GitLab 리뷰 기능을 쓸 경우 `api` 스코프 GitLab Personal Access Token

Windows, macOS, Linux에서 실행할 수 있습니다. 현재 GitHub 저장소는 공개되어 있으며, 저장소가 비공개로 전환된 경우에만 접근 권한과 GitHub 인증이 필요합니다.

## 설치

```powershell
gh repo clone kdHyeok/MMP
cd MMP
npm ci
npm test
npm run smoke
```

`gh`를 사용하지 않으면 접근 권한이 있는 Git 자격 증명으로 저장소를 복제한 뒤 `npm ci`를 실행하세요.

## Codex와 Claude Code에 등록

| 클라이언트 | 설치 후 표시되는 플러그인 | 포함 기능 | 적용 시점 |
|---|---|---|---|
| Codex | `mmp@personal` | MCP 서버, 공용 자연어 스킬, MMP 아이콘 | 새 Codex 작업 |
| Claude Code | `mmp@mmp-local` | MCP 서버, 동일한 자연어 스킬 | 새 Claude Code 세션 |

### Codex 로컬 플러그인으로 설치

Codex에서는 저장소 전체를 로컬 플러그인 소스로 사용할 수 있습니다. 플러그인 하나로 MCP와 `mattermost-review-message` 스킬이 함께 설치됩니다.

먼저 저장소에서 의존성과 동작을 확인합니다.

```powershell
npm ci
npm test
npm run smoke
```

그다음 이 저장소를 개인 마켓플레이스의 `mmp` 소스로 등록하고 플러그인을 설치합니다. 이 저장소에 포함된 `scripts/install-codex-plugin.ps1`을 실행하면 됩니다.

```powershell
powershell -ExecutionPolicy Bypass -File .\scripts\install-codex-plugin.ps1
```

설치 상태는 다음 명령으로 확인합니다.

```powershell
codex plugin list
```

출력에서 `mmp@personal`이 활성화되어 있는지 확인합니다.

설치 또는 업데이트 후에는 새 Codex 작업을 열어야 플러그인의 MCP 도구와 스킬이 적용됩니다. 로컬 SQLite 설정은 `~/.mmp/mattermost.sqlite3`에서 Codex와 Claude가 함께 사용하며, 기존 Windows AppData 데이터는 첫 실행 때 자동 이전됩니다.

### Claude Code 플러그인으로 설치

Claude Code에서도 같은 `mattermost-review-message` 스킬과 MCP 서버를 플러그인 하나로 설치할 수 있습니다. 저장소 루트의 `.claude-plugin` 마켓플레이스를 추가한 뒤 설치합니다.

```powershell
claude plugin marketplace add ./ --scope user
claude plugin install mmp@mmp-local --scope user
claude plugin list
```

출력에서 `mmp@mmp-local`의 `enabled`가 `true`이고 MCP 서버 `mmp`가 표시되는지 확인합니다.

GitHub에서 직접 설치할 다른 사용자는 저장소 접근 권한과 Git 인증 후 아래처럼 등록합니다.

```powershell
claude plugin marketplace add kdHyeok/MMP --scope user
claude plugin install mmp@mmp-local --scope user
```

설치 후 새 Claude Code 세션을 시작합니다. 개발 중인 현재 파일을 설치 없이 시험하려면 저장소의 부모 디렉터리에서 `claude --plugin-dir .\MMP`를 실행할 수 있습니다.

Claude Code는 `claude-mcp.json`의 `${CLAUDE_PLUGIN_ROOT}`를 사용하고, Codex는 `codex-mcp.json`의 `${PLUGIN_ROOT}`를 사용합니다. 두 클라이언트 모두 같은 서버 코드와 로컬 SQLite 데이터를 사용합니다.

Codex 설정 파일 이름은 `.mcp.json`이 아니라 `codex-mcp.json`입니다. `.mcp.json`은 Claude Code가 프로젝트 스코프 MCP 설정으로 자동 인식하는 예약 파일명이어서, 이 저장소 안에서 Claude Code를 실행하면 `${PLUGIN_ROOT}`를 확장하지 못한 채 서버를 띄우려다 실패합니다. Codex는 `.codex-plugin/plugin.json`의 `mcpServers` 값으로 경로를 찾으므로 파일명이 달라도 문제없습니다.

Claude Code에서 리뷰 메시지 스킬을 직접 실행하는 명령은 `/mmp:mattermost-review-message`입니다. 이는 Codex의 `mattermost-review-message`와 같은 스킬이며, 연결되는 MCP 서버는 `plugin:mmp:mmp`로 표시됩니다. 설정이 비어 있다고 나오면 플러그인을 업데이트한 뒤 새 Claude Code 세션을 시작하세요.

### MCP만 직접 등록

아래 방식은 플러그인 스킬 없이 MCP 도구만 직접 등록할 때 사용합니다.

### Windows PowerShell

저장소 루트에서 실행합니다.

```powershell
$repoPath = (Resolve-Path .).Path
$nodePath = (Get-Command node).Source
$serverPath = Join-Path $repoPath 'src\server.js'

codex mcp add mmp -- $nodePath $serverPath
claude mcp add --scope user mmp -- $nodePath $serverPath
```

### macOS 또는 Linux

```bash
codex mcp add mmp -- "$(command -v node)" "$(pwd)/src/server.js"
claude mcp add --scope user mmp -- "$(command -v node)" "$(pwd)/src/server.js"
```

등록 상태를 확인합니다.

```powershell
codex mcp get mmp
claude mcp get mmp
```

등록 후 새 Codex/Claude 작업을 열어야 도구가 표시될 수 있습니다.

## 자연어 스킬만 별도 설치

플러그인을 설치하지 않고도 MCP 도구 이름을 직접 말하지 않은 채 `웹훅 목록 보여줘`, `리뷰 요청 mm에 보내줘`처럼 사용하려면 포함된 스킬을 별도 설치할 수 있습니다. 아래 수동 복사는 Codex용이며, Claude Code는 위 플러그인 설치를 권장합니다.

### Windows PowerShell

```powershell
$skillSource = Join-Path (Resolve-Path .).Path 'skills\mattermost-review-message'
$skillTarget = Join-Path $env:USERPROFILE '.codex\skills\mattermost-review-message'
New-Item -ItemType Directory -Force -Path $skillTarget | Out-Null
Copy-Item -Path (Join-Path $skillSource '*') -Destination $skillTarget -Recurse -Force
```

### macOS 또는 Linux

```bash
mkdir -p ~/.codex/skills
cp -R skills/mattermost-review-message ~/.codex/skills/
```

새 Codex 작업부터 자동으로 적용됩니다. 첫 메시지 전송 시 등록된 채널 목록을 조회해 선택을 요청하고, 선택한 채널은 현재 작업에서만 기본값으로 기억합니다.

## 처음 사용하는 사람을 위한 설정 가이드

MMP를 처음 사용할 때는 아래 순서로 설정합니다.

```text
1. Mattermost에서 Incoming Webhook 발급
2. MMP에 웹훅 등록
3. 메시지를 보낼 논리 채널 등록
4. 본인과 팀원 정보 등록
5. 메시지 컨벤션 등록
6. 미리보기 후 첫 메시지 전송
```

웹훅, 채널, 사람, 컨벤션 설정은 한 번 등록하면 로컬 SQLite에 저장되므로 Codex와 Claude Code가 함께 사용할 수 있습니다. 단, 대화에서 선택한 기본 채널은 현재 Codex 작업 또는 Claude Code 세션에서만 기억합니다.

### 1. Mattermost Incoming Webhook 발급

1. Mattermost에서 메시지를 보낼 팀에 접속합니다.
2. `Product menu → Integrations → Incoming Webhooks`로 이동합니다.
3. `Add Incoming Webhook`을 선택합니다.
4. 웹훅 이름과 설명을 입력하고 기본 수신 채널을 선택합니다.
5. 생성 후 표시되는 `https://<서버>/hooks/<발급키>` URL을 복사합니다.

`Integrations` 또는 `Incoming Webhooks` 메뉴가 보이지 않으면 서버 관리자가 Incoming Webhook 기능이나 사용자 생성 권한을 활성화해야 합니다. 자세한 발급 절차는 [Mattermost Incoming Webhook 공식 문서](https://developers.mattermost.com/integrate/webhooks/incoming/)를 참고하세요.

웹훅 생성 화면에서 채널 잠금을 활성화하면 그 웹훅은 지정된 기본 채널에만 전송할 수 있습니다. 한 웹훅으로 여러 채널이나 DM에 보내려면 Mattermost 서버 정책과 웹훅 설정이 채널 오버라이드를 허용해야 하며, 웹훅 생성자가 대상 채널에 접근할 수 있어야 합니다. 조직 정책상 잠금이 강제되면 채널별로 웹훅을 따로 발급하세요.

> 웹훅 URL은 메시지를 보낼 수 있는 비밀값입니다. README, Git, 이슈, 채팅 로그에 실제 URL을 남기지 말고 노출되면 Mattermost에서 폐기·재발급하세요.

### 2. MMP에 웹훅 등록

Codex 또는 Claude Code의 새 세션에서 자연어로 다음처럼 요청합니다.

```text
웹훅 이름은 "팀-웹훅"이고 URL은
https://mattermost.example.com/hooks/REPLACE_ME 이야. MMP에 등록해줘.
```

등록 후 URL은 다시 출력되지 않고 마지막 경로가 가려진 형태로만 조회됩니다. 다음 요청으로 정상 등록 여부를 확인합니다.

```text
등록된 Mattermost 웹훅 목록 보여줘.
```

이름을 바꾸거나 URL을 재발급한 경우에도 자연어로 수정할 수 있습니다.

```text
"팀-웹훅" 이름을 "프로젝트-웹훅"으로 변경해줘.
"프로젝트-웹훅"의 URL을 새로 발급한 이 URL로 교체해줘: https://mattermost.example.com/hooks/REPLACE_ME
```

### 3. 메시지를 보낼 채널 등록

MMP의 채널은 실제 Mattermost 채널을 생성하는 기능이 아니라, 저장된 웹훅과 Mattermost 목적지를 연결하는 로컬 별칭입니다.

1. Mattermost에서 대상 채널을 엽니다.
2. 브라우저 주소를 복사합니다. 일반적인 주소는 `https://<서버>/<팀>/channels/<채널명>` 형태입니다.
3. 원하는 로컬 별칭, 사용할 웹훅 이름, 복사한 채널 URL을 함께 전달합니다.

```text
"프로젝트-웹훅"을 사용하는 논리 채널을 등록해줘.
이름은 "백엔드-팀"이고 채널 URL은
https://mattermost.example.com/my-team/channels/backend-team 이야.
```

자연어 스킬은 `/channels/` 뒤의 `backend-team`을 Mattermost 채널명으로 저장합니다. Mattermost Webhook API는 화면 표시명 대신 URL에 나타나는 채널명을 사용합니다.

웹훅을 발급할 때 지정한 기본 채널에만 보낼 경우에는 URL을 생략할 수 있습니다.

```text
"프로젝트-웹훅"의 기본 채널을 사용하는 "기본-알림" 채널을 등록해줘.
```

등록 결과는 다음처럼 확인합니다.

```text
등록된 Mattermost 채널 목록 보여줘.
"백엔드-팀" 채널 설정 보여줘.
```

채널 URL 전체가 `mattermost_channel` 값으로 저장되는 것이 아니라 실제 전송에 필요한 마지막 채널명만 저장됩니다. `Couldn't find the channel` 오류가 나면 URL의 `/channels/` 뒤 값, 웹훅 생성자의 채널 접근 권한, 채널 잠금 설정을 확인하세요.

### 4. 본인과 메시지를 보낼 사람 등록

정확한 `@멘션`과 DM 전송을 위해 사람 정보를 등록합니다. 필요한 값은 다음과 같습니다.

- 표시 이름: 대화에서 사람을 찾을 때 사용하는 이름
- Mattermost 사용자명: 프로필에 표시되는 `@username`의 `username` 부분
- GitLab 사용자명: 리뷰 요청자 또는 MR 작성자를 자동으로 연결할 때 사용하는 선택값
- 본인 여부: 현재 사용자를 다른 리뷰 요청자와 구분하기 위한 값

본인은 한 명만 등록할 수 있습니다.

```text
내 이름은 김동혁이고 Mattermost 아이디는 qaz000219,
GitLab 아이디는 kdHyeok이야. 나로 등록해줘.
```

팀원은 다음처럼 등록합니다.

```text
윤성용을 사람 목록에 등록해줘.
Mattermost 아이디는 yunsy이고 GitLab 아이디는 yunsy야.
```

등록한 사람을 특정 논리 채널의 로컬 참여자 목록에도 연결할 수 있습니다.

```text
윤성용을 "백엔드-팀" 참여자로 추가해줘.
"백엔드-팀"에 등록된 참여자 목록 보여줘.
```

이 참여자 목록은 MMP의 로컬 디렉터리입니다. Incoming Webhook은 실제 Mattermost 채널 멤버를 조회할 수 없으므로, Mattermost 서버의 가입 상태를 자동으로 가져오거나 변경하지 않습니다.

이름 일부로도 사람을 찾을 수 있습니다.

```text
이름에 "성용"이 들어가는 사람 찾아줘.
```

여러 명이 검색되면 MMP 스킬은 임의로 선택하지 않고 누구인지 다시 묻습니다. 사람 목록은 다음 요청으로 전체 확인할 수 있습니다.

```text
등록된 사람과 GitLab-Mattermost 매핑을 모두 보여줘.
```

### 5. 메시지 컨벤션 등록

컨벤션은 `{{변수명}}`을 포함하는 재사용 가능한 메시지 템플릿입니다. 컨벤션 자체는 전역으로 저장되며 특정 채널에 자동 귀속되지 않습니다. 채널마다 다른 형식을 사용하려면 컨벤션 이름을 나눠 등록하고 전송할 때 원하는 채널과 컨벤션을 함께 지정합니다.

```text
"백엔드-배포완료" 컨벤션을 등록해줘.
템플릿은 "{{mention}} ✅ {{service}} {{version}} 배포 완료"야.
```

리뷰 자연어 기능을 사용하려면 아래 두 예약 컨벤션을 정확히 등록합니다.

```text
"review-request" 컨벤션을 등록해줘.
템플릿은 "{{mention}} :merge_please: !{{mr_number}} | [{{jira_key}}] {{message}}"야.
```

```text
"review-complete" 컨벤션을 등록해줘.
템플릿은 "{{mention}} :review_complete_shake: !{{mr_number}} | [{{jira_key}}] {{message}}"야.
```

예약 리뷰 컨벤션은 서버에서도 형식을 검사합니다. 멘션이 `@`로 시작하지 않거나 MR 번호, Jira 키, 한 줄 메시지가 빠지면 전송이 거부됩니다. 리뷰 DM의 본문 멘션이 선택한 DM 대상과 달라도 전송되지 않습니다.

등록된 컨벤션과 필요한 변수는 다음처럼 확인합니다.

```text
등록된 메시지 컨벤션 목록 보여줘.
"review-request" 컨벤션에 필요한 변수 보여줘.
```

일반 컨벤션은 전송 전에 값을 넣어 미리볼 수 있습니다.

```text
"백엔드-배포완료" 컨벤션을
mention=@channel, service=api, version=v1.2.0으로 미리보기 해줘.
```

### 6. 첫 메시지 미리보기와 전송

현재 세션에서 기본 채널을 아직 선택하지 않았다면 MMP 스킬이 등록된 채널 목록을 조회한 뒤 어느 채널을 사용할지 묻습니다. 한 번 승인한 채널은 해당 세션의 기본 채널이 되며 이후 `mm에 보내줘`라고만 해도 그 채널을 사용합니다.

처음에는 미리보기로 대상과 문구를 확인하는 것을 권장합니다.

```text
"백엔드-배포완료"를 service=api, version=v1.2.0으로
"백엔드-팀"에 보낼 메시지 미리보기 해줘.
```

미리보기가 맞으면 전송을 요청합니다.

```text
방금 미리보기를 "백엔드-팀"에 mm으로 보내줘.
```

다른 채널을 이번 한 번만 사용할 수도 있습니다.

```text
이번에만 "기본-알림" 채널에 mm 보내줘.
```

전송 후 MMP 스킬은 현재 세션의 기본 채널을 바꿀지 물어봅니다.

### 7. 리뷰 요청과 리뷰 완료 보내기

리뷰 메시지는 현재 대화, 브랜치, MR에서 대상자·MR 번호·Jira 키를 확인하고, 등록된 사람 정보로 GitLab 사용자명을 Mattermost 멘션에 연결합니다. 확인되지 않은 값은 추측하지 않고 필요한 값만 다시 묻습니다.

```text
성용이형에게 MR !124 리뷰 요청 mm 미리보기 보여줘.
Jira 키는 S15P21C206-124야.
```

예상 형식:

```text
@yunsy :merge_please: !124 | [S15P21C206-124] 리뷰 부탁드립니당.
```

채널로 보내려면 다음처럼 요청합니다.

```text
리뷰 요청 mm에 보내줘.
```

개인 DM으로 보내려면 대상을 명시합니다.

```text
윤성용에게 DM으로 리뷰 요청 mm 보내줘.
```

리뷰 완료도 같은 방식으로 사용할 수 있습니다.

```text
MR !124 리뷰 완료 mm 미리보기 보여줘.
```

```text
@요청자 :review_complete_shake: !124 | [S15P21C206-124] 리뷰 완료 했습니다.
```

리뷰 요청·완료는 자유문 `text`로 우회 전송할 수 없습니다. 반드시 예약 컨벤션을 사용하며, 상세 변경 요약이나 검증 내역은 사용자가 별도로 요청한 경우에만 덧붙입니다.

### 8. DM 보내기

DM은 등록된 사람의 Mattermost 사용자명을 목적지로 사용하고, `via_channel_name`에 해당하는 논리 채널의 웹훅 자격을 빌려 전송합니다.

```text
윤성용에게 "회의 10분 전에 시작할게요."라고 Mattermost DM 보내줘.
```

처음 사용하는 세션에서는 어떤 논리 채널의 웹훅을 사용할지 묻게 됩니다. 웹훅의 채널 오버라이드가 막혀 있거나 서버 정책상 DM이 허용되지 않으면 Mattermost 오류를 그대로 안내합니다.

### 9. GitLab 리뷰 처리

Mattermost Incoming Webhook은 메시지를 보내기만 할 수 있어 리뷰 요청 수신이나 이모지 리액션이 불가능합니다. 그래서 리뷰 요청 감지와 확인 표시는 GitLab에서 처리합니다. 실제 이벤트는 "GitLab MR에 리뷰어로 지정됨"이고 Mattermost 메시지는 그 알림이므로, 감지 위치만 옮긴 것입니다.

먼저 GitLab 인스턴스와 Personal Access Token을 등록합니다. 토큰은 `api` 스코프가 필요하며 `read_api`로는 댓글을 등록할 수 없습니다. 토큰은 웹훅 URL과 동일하게 로컬 SQLite에 저장되고 조회 결과에 다시 나오지 않습니다.

```text
GitLab 인스턴스를 등록해줘. 이름은 "ssafy", 주소는 https://lab.ssafy.com 이고 토큰은 glpat-... 이야.
```

내게 온 리뷰 요청은 다음처럼 확인합니다. 처음 발견된 MR은 `is_new`로 표시되고, 마지막으로 댓글을 단 이후 변경된 MR은 `changed_since_review`로 표시됩니다.

```text
나한테 온 리뷰 요청 있어?
```

이 조회는 두 곳을 함께 봅니다. `gitlab_review_inbox`는 리뷰어로 지정된 MR을, `gitlab_todo_inbox`는 GitLab todo를 읽어 **MR 본문이나 댓글에서 `@멘션`된 경우**까지 잡습니다. 둘은 서로를 대체하지 못합니다. 리뷰어로 지정돼도 해당 todo가 이미 정리되면 todo에는 안 나오고, 반대로 댓글 멘션은 리뷰어 목록에 안 나옵니다.

todo는 MR이 머지된 뒤에도 pending으로 남는 경우가 있어 기본적으로 열린 MR만 보여줍니다. 처리 끝난 건은 `gitlab_todo_done`으로 정리합니다.

```text
!170 처리 끝났으니 todo 정리해줘
```

리뷰를 맡기로 한 MR에는 확인 표시를 남깁니다. Mattermost 리액션 대신 MR에 `:eyes:` award emoji가 붙고, 요청자와 작성자 모두 GitLab에서 볼 수 있습니다. 여러 번 호출해도 중복되지 않습니다.

```text
!124 확인했다고 표시해줘.
```

diff와 기존 논의를 읽고 리뷰 초안을 받습니다. diff가 너무 크면 잘린 사실을 함께 알려줍니다.

```text
!124 diff 보고 리뷰 초안 잡아줘.
```

리뷰는 확인을 거치지 않고 바로 GitLab에 등록됩니다. 사람이 본문을 먼저 보지 않으므로, 그 자리를 근거 요건이 대신합니다.

- 이번 세션에서 코드를 읽거나 직접 실행해 확인한 것만 단정합니다.
- 실패를 주장할 때는 실제 출력을 그대로 인용합니다. 보지 않은 오류를 옮겨 적지 않습니다.
- 확인하지 못한 부분은 댓글 안에 그대로 밝힙니다.
- 필요한 근거를 얻지 못했으면(diff가 잘렸는데 다시 안 가져왔거나, 테스트를 못 돌렸거나) 확신하는 리뷰를 올리지 않습니다.
- 기존 논의가 이미 지적한 내용은 반복하지 않습니다.

라인 댓글도 같은 방식으로 요청할 수 있습니다.

```text
src/auth.js 42번째 줄에 "null 체크가 필요합니다."로 라인 댓글 달아줘.
```

확인을 거치고 싶은 경우에는 미리보기만 요청하면 됩니다.

```text
!124 리뷰 초안만 보여주고 올리지는 마.
```

게시가 끝나면 `review-complete` 컨벤션으로 Mattermost에 자동 회신합니다. 별도로 요청하지 않아도 됩니다. GitLab 게시가 실패하면 메시지를 보내지 않고 실패를 알립니다.

한 줄 문구는 리뷰 결론을 반영합니다. 막는 문제가 있으면 `리뷰 완료 했습니다.`만 보내지 않고 사유를 같은 줄에 덧붙입니다.

```text
@yunsy :review_complete_shake: !173 | [S15P21C206-123] 리뷰 완료 했습니다. 마이그레이션 번호 2건 확인 부탁드립니다.
```

대상이나 채널을 이번만 바꾸려면 함께 말하면 됩니다.

```text
MR !124 리뷰 완료는 성용이형한테 DM으로 보내줘.
```

토큰이 만료되면 HTTP 401을 그대로 안내합니다. 새로 발급한 뒤 교체하세요.

```text
"ssafy" GitLab 토큰을 새로 발급한 걸로 교체해줘.
```

### 10. 리뷰 요청 자동 감지

Claude Code 세션을 열어두는 동안 주기적으로 확인하려면 `/loop`를 씁니다.

```text
/loop 5m 나한테 온 리뷰 요청 확인해서, 새 건 있으면 확인 표시하고 diff 읽고 리뷰해서 GitLab에 댓글까지 올려줘.
```

올리기 전에 직접 보고 싶으면 마지막에 `댓글은 올리지 말고 보여주기만 해`를 붙이면 됩니다.

세션을 열어두지 않아도 알림을 받으려면 백그라운드 감시 프로세스를 띄웁니다. 새 MR이 감지되면 본인에게 Mattermost DM을 보냅니다.

```powershell
npm run watch:reviews
```

옵션은 다음과 같습니다.

| 옵션 | 기본값 | 설명 |
|---|---|---|
| `--interval <초>` | `300` | 폴링 주기. 최소 30초 |
| `--site <이름>` | 등록된 사이트가 하나면 자동 | GitLab 인스턴스 |
| `--via <채널>` | 활성 채널이 하나면 자동 | DM에 쓸 웹훅을 가진 논리 채널 |
| `--once` | | 한 번만 확인하고 종료 |
| `--dry-run` | | 전송하지 않고 보낼 내용만 출력 |

처음에는 `--once --dry-run`으로 확인하는 것을 권장합니다.

```powershell
node scripts/review-watcher.mjs --once --dry-run
```

알림은 MR당 한 번만 갑니다. 알림 여부는 리뷰 상태와 별도로 기록되므로, 감시 프로세스가 먼저 확인해도 세션에서 `is_new`는 그대로 유지됩니다.

감시 프로세스는 감지와 알림만 합니다. 확인 이모지, diff 조회, 리뷰 작성, 댓글 게시는 하지 않습니다. 리뷰를 쓰려면 모델이 필요한데 이 프로세스에는 없습니다. 알림을 받으면 세션에서 이어서 진행하세요.

### 11. 설정 수정·삭제 예시

```text
"백엔드-팀" 채널 이름을 "특화-팀-BND"로 변경해줘.
윤성용의 Mattermost 아이디를 new-yunsy로 수정해줘.
"백엔드-배포완료" 컨벤션의 문구를 수정해줘.
사용하지 않는 "기본-알림" 채널을 삭제해줘.
```

연결된 논리 채널이 남아 있는 웹훅은 실수로 삭제되지 않습니다. 먼저 해당 채널을 다른 웹훅으로 옮기거나 삭제해야 합니다.

### 12. 최초 설정 완료 체크리스트

- [ ] Incoming Webhook을 발급하고 비밀 URL을 안전하게 보관했다.
- [ ] MMP의 `webhook_list`에서 웹훅 이름이 조회된다.
- [ ] 메시지를 보낼 논리 채널이 `channel_list`에서 활성 상태로 조회된다.
- [ ] 본인과 리뷰 대상자의 Mattermost·GitLab 사용자 매핑을 등록했다.
- [ ] `review-request`와 `review-complete` 컨벤션을 정확한 템플릿으로 등록했다.
- [ ] 실제 전송 전에 `message_preview` 또는 자연어 미리보기로 한 줄 문구를 확인했다.
- [ ] 테스트 메시지 전송 결과의 `ok`가 `true`인지 확인했다.

## 사용 예

```text
등록된 웹훅과 채널 목록을 보여줘.
```

```text
deploy_ok 컨벤션을 "✅ {{service}} {{version}} 배포 완료"로 등록해줘.
```

```text
deploy_ok를 service=api, version=v1.2.0으로 alerts 채널에 보내줘.
```

```text
리뷰 요청 mm에 보내줘.
```

리뷰 메시지의 정확한 멘션을 위해 본인과 팀원의 식별 정보를 먼저 등록합니다.

```text
내 이름은 동혁이고 Mattermost 아이디는 qaz000219, GitLab 아이디는 my-gitlab-id야. 나로 등록해줘.
GitLab review-author는 Mattermost @reviewer.mm을 쓰는 리뷰 요청자야. 특화-팀-BND 참여자로 등록해줘.
```

Incoming Webhook만으로는 Mattermost 서버의 실제 채널 참여자를 조회할 수 없습니다. `participant_*`와 `channel_member_*`는 사용자가 제공한 식별 정보를 관리하는 로컬 디렉터리이며, 실제 멤버십을 조회하거나 변경하지 않습니다.

사람 정보는 채널과 독립적으로 한 번만 저장됩니다. `participant_list`의 `name_query`는 이름 일부를 검색하며 여러 명이 나오면 호출자가 대상을 확인해야 합니다. 채널에 없는 사람을 `channel_member_add`할 때 `display_name`을 함께 주면 전역 사람 정보를 먼저 만들고 채널에 연결합니다.

개인 DM은 `message_send_dm`이 선택한 논리 채널의 웹훅으로 `@사용자명` 대상을 오버라이드합니다. Mattermost 서버에서 웹훅의 채널 오버라이드를 허용해야 합니다.

리뷰 요청과 리뷰 완료는 채널·DM 모두 자유문 `text` 전송이 차단됩니다. 각각 `review-request`, `review-complete` 컨벤션을 사용해야 하며, DM 본문도 선택한 참여자의 정확한 `@아이디`로 시작해야 합니다. 대상 오버라이드만 설정하고 본문 멘션을 빼는 방식은 거부됩니다.

## 제공 도구

| 영역 | 도구 |
|---|---|
| 웹훅 | `webhook_create`, `webhook_list`, `webhook_update`, `webhook_delete` |
| 채널 | `channel_create`, `channel_list`, `channel_update`, `channel_delete` |
| 참여자 | `participant_create`, `participant_list`, `participant_update`, `participant_delete` |
| 채널 참여자 | `channel_member_add`, `channel_member_remove` |
| 컨벤션 | `convention_create`, `convention_list`, `convention_update`, `convention_delete` |
| 메시지 | `message_preview`, `message_send`, `message_send_dm` |
| 진단 | `storage_info` |
| GitLab 인스턴스 | `gitlab_site_create`, `gitlab_site_list`, `gitlab_site_update`, `gitlab_site_delete` |
| GitLab 리뷰 | `gitlab_review_inbox`, `gitlab_todo_inbox`, `gitlab_todo_done`, `gitlab_mr_changes`, `gitlab_mr_ack`, `gitlab_note_create` |

`channel_create`의 `mattermost_channel`을 생략하면 웹훅 생성 시 지정한 기본 채널로 전송합니다. 값을 주면 Mattermost 채널명 또는 `@username`으로 대상을 오버라이드합니다.

## 데이터 저장 위치

- 모든 운영체제: `~/.mmp/mattermost.sqlite3`

Claude Desktop이 Windows `AppData`를 격리해도 Codex와 같은 파일을 보도록 사용자 홈 바로 아래의 `.mmp`를 사용합니다. Claude 플러그인은 제한된 MCP 자식 환경에서도 같은 홈 경로를 계산하도록 부모의 `USERPROFILE`을 명시적으로 전달합니다.

Windows의 기존 `%LOCALAPPDATA%\mattermost-manager-mcp\mattermost.sqlite3`에 데이터가 있고 새 저장소가 비어 있으면 첫 실행 때 웹훅, 채널, 참여자, 컨벤션을 자동 이전합니다. 기존 파일은 삭제하지 않습니다.

`MATTERMOST_MCP_DATA_DIR` 환경변수로 위치를 바꿀 수 있습니다. 여러 클라이언트에서 같은 설정을 사용하려면 동일한 경로를 지정하세요.

두 클라이언트의 목록이 다르면 `storage_info`로 실제 데이터 디렉터리와 저장 건수를 비교하세요. 이 도구는 웹훅 URL을 반환하지 않습니다.

신뢰하는 로컬 Mattermost가 HTTP만 제공할 때에만 서버 실행 환경에 `MATTERMOST_MCP_ALLOW_HTTP=1`을 설정하세요. 기본값은 HTTPS 전용입니다.

## 보안

- 웹훅 URL은 조회·전송 결과에 반환하지 않습니다.
- 웹훅 URL은 현재 OS 사용자의 로컬 SQLite에 저장되며 별도로 암호화하지 않습니다. 사용자 계정과 디스크 접근을 보호하세요.
- 저장소에는 실제 웹훅 URL이나 SQLite 파일을 커밋하지 마세요.
- 전송은 저장된 웹훅만 사용하고 HTTP 리다이렉트를 따르지 않습니다.
- 연결된 채널이 있는 웹훅은 삭제되지 않습니다.
- 웹훅 URL이 노출되면 Mattermost에서 재발급하고 저장된 URL을 교체하세요.
- GitLab Personal Access Token도 웹훅 URL과 동일하게 취급합니다. 조회 결과에 반환하지 않고, 로컬 SQLite에 암호화 없이 저장되며, 커밋하거나 채팅 로그에 남기지 마세요.
- GitLab 토큰은 `api` 스코프가 필요하며 만료 기간을 짧게 잡는 것을 권장합니다. 노출되면 GitLab에서 즉시 폐기하고 `gitlab_site_update`로 교체하세요.
- `gitlab_note_create`는 프로젝트 접근 권한이 있는 모두에게 보이는 댓글을 등록하며 되돌릴 수 없습니다. 사용자가 승인한 본문만 게시합니다.

## 제거

```powershell
codex mcp remove mmp
claude mcp remove mmp --scope user
claude plugin uninstall mmp@mmp-local --scope user
claude plugin marketplace remove mmp-local
```

MCP 등록 제거는 로컬 SQLite 데이터를 삭제하지 않습니다.
