# Mattermost Manager MCP

Codex와 Claude Code에서 함께 사용하는 로컬 stdio MCP 서버입니다. Mattermost Incoming Webhook, 논리 채널, 참여자 식별 정보, 메시지 컨벤션을 로컬 SQLite에 저장하고 자연어로 관리하거나 메시지를 전송할 수 있습니다.

## 기능

- Mattermost Incoming Webhook 등록·조회·수정·삭제
- 여러 논리 채널 및 DM 대상 등록·조회·수정·삭제
- 전역 사람 정보 CRUD, 이름 부분검색, GitLab 사용자와 Mattermost `@아이디` 매핑
- 전역 사람을 외래키로 연결하는 논리 채널별 참여자 디렉터리
- 저장된 사람에게 Incoming Webhook 채널 오버라이드로 개인 DM 전송
- `{{variable}}` 메시지 컨벤션 CRUD 및 미리보기
- 한 번의 호출로 여러 채널에 메시지 전송
- Codex용 자연어 리뷰 메시지·웹훅·채널 관리 스킬

## 요구 환경

- Node.js 22.13 이상 (`node:sqlite` 무플래그 사용)
- npm
- Git
- Codex CLI 또는 Claude Code
- 메시지를 보낼 Mattermost Incoming Webhook URL

Windows, macOS, Linux에서 실행할 수 있습니다. 아래 GitHub 저장소가 비공개인 동안에는 접근 권한과 GitHub 인증이 필요합니다.

## 설치

```powershell
gh repo clone kdHyeok/mattermost-manager-mcp
cd mattermost-manager-mcp
npm ci
npm test
npm run smoke
```

`gh`를 사용하지 않으면 접근 권한이 있는 Git 자격 증명으로 저장소를 복제한 뒤 `npm ci`를 실행하세요.

## Codex와 Claude Code에 등록

### Windows PowerShell

저장소 루트에서 실행합니다.

```powershell
$repoPath = (Resolve-Path .).Path
$nodePath = (Get-Command node).Source
$serverPath = Join-Path $repoPath 'src\server.js'

codex mcp add mattermost-manager -- $nodePath $serverPath
claude mcp add --scope user mattermost-manager -- $nodePath $serverPath
```

### macOS 또는 Linux

```bash
codex mcp add mattermost-manager -- "$(command -v node)" "$(pwd)/src/server.js"
claude mcp add --scope user mattermost-manager -- "$(command -v node)" "$(pwd)/src/server.js"
```

등록 상태를 확인합니다.

```powershell
codex mcp get mattermost-manager
claude mcp get mattermost-manager
```

등록 후 새 Codex/Claude 작업을 열어야 도구가 표시될 수 있습니다.

## Codex 자연어 스킬 설치

MCP 도구 이름을 직접 말하지 않고 `웹훅 목록 보여줘`, `리뷰 요청 mm에 보내줘`처럼 사용하려면 포함된 스킬을 설치합니다.

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

## 처음 설정하기

Mattermost에서 `Product menu → Integrations → Incoming Webhooks`로 웹훅을 만들고 URL을 복사합니다. URL은 비밀번호처럼 취급하세요.

새 Codex/Claude 작업에서 자연어 스킬을 설치했다면 다음처럼 요청할 수 있습니다.

```text
이 Mattermost 웹훅을 prod라는 이름으로 등록해줘: https://mattermost.example.com/hooks/REPLACE_ME
```

```text
prod 웹훅을 사용하는 alerts 채널을 만들어줘.
실제 Mattermost 채널명은 dev-alerts야.
```

DM 대상은 Mattermost 사용자명을 사용합니다.

```text
prod 웹훅으로 @username에게 보내는 "나에게 보내기" 채널을 추가해줘.
```

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

## 제공 도구

| 영역 | 도구 |
|---|---|
| 웹훅 | `webhook_create`, `webhook_list`, `webhook_update`, `webhook_delete` |
| 채널 | `channel_create`, `channel_list`, `channel_update`, `channel_delete` |
| 참여자 | `participant_create`, `participant_list`, `participant_update`, `participant_delete` |
| 채널 참여자 | `channel_member_add`, `channel_member_remove` |
| 컨벤션 | `convention_create`, `convention_list`, `convention_update`, `convention_delete` |
| 메시지 | `message_preview`, `message_send`, `message_send_dm` |

`channel_create`의 `mattermost_channel`을 생략하면 웹훅 생성 시 지정한 기본 채널로 전송합니다. 값을 주면 Mattermost 채널명 또는 `@username`으로 대상을 오버라이드합니다.

## 데이터 저장 위치

- Windows: `%LOCALAPPDATA%\mattermost-manager-mcp\mattermost.sqlite3`
- macOS/Linux: `~/mattermost-manager-mcp/mattermost.sqlite3`

`MATTERMOST_MCP_DATA_DIR` 환경변수로 위치를 바꿀 수 있습니다. 여러 클라이언트에서 같은 설정을 사용하려면 동일한 경로를 지정하세요.

신뢰하는 로컬 Mattermost가 HTTP만 제공할 때에만 서버 실행 환경에 `MATTERMOST_MCP_ALLOW_HTTP=1`을 설정하세요. 기본값은 HTTPS 전용입니다.

## 보안

- 웹훅 URL은 조회·전송 결과에 반환하지 않습니다.
- 웹훅 URL은 현재 OS 사용자의 로컬 SQLite에 저장되며 별도로 암호화하지 않습니다. 사용자 계정과 디스크 접근을 보호하세요.
- 저장소에는 실제 웹훅 URL이나 SQLite 파일을 커밋하지 마세요.
- 전송은 저장된 웹훅만 사용하고 HTTP 리다이렉트를 따르지 않습니다.
- 연결된 채널이 있는 웹훅은 삭제되지 않습니다.
- 웹훅 URL이 노출되면 Mattermost에서 재발급하고 저장된 URL을 교체하세요.

## 제거

```powershell
codex mcp remove mattermost-manager
claude mcp remove mattermost-manager --scope user
```

MCP 등록 제거는 로컬 SQLite 데이터를 삭제하지 않습니다.
