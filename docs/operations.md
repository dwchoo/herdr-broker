# herdr-broker 설치와 사용

## 필요한 환경

검증 기준은 macOS arm64, Node 24, Herdr 0.9.0/protocol 22, Codex CLI 0.154.0이다. Worker는 `gpt-5.6-luna`/high를 사용하며 로컬 Codex 계정의 기존 인증으로 실행한다. 원격에 AI runtime이나 credential을 설치하지 않는다. 기본 입력은 프로그램 종류와 무관한 `terminal` profile이다. 기존 `ssh_posix` wrapper 실행만 사용자 준비 확인을 요구한다. [SSH acceptance](implementation/issue-24-ssh-acceptance.md)는 #24 artifact의 기록이며, 현재 checkout의 실행 문맥과 검증 절차는 [project skill 검증](implementation/project-skill-herdr-context.md)을 따른다.

## Broker 시작·접속과 공유 terminal

Herdr의 이 프로젝트 Codex에게 `$broker`를 요청한다. Broker는 같은 tab의 terminal 묶음을 관리하는 백그라운드 core다. 평소에는 일반 shell에서 사용자와 Codex가 함께 작업하며, 관리 화면은 요청할 때만 임시 pane으로 연다. Codex나 관리 화면 종료는 core·terminal 종료가 아니다.

Broker와 terminal은 로컬 등록소에서 겹치지 않는 4자리 번호를 받는다. “7316에 연결해”, “4821에서 실행해”처럼 요청한다. 번호는 재시작·이름 변경 후에도 유지한다. 정확하지 않은 번호나 “아까 빌드하던 pane”은 Codex가 목록과 대화 맥락을 보고 판단한다. 자동 prefix·오타 교정 규칙은 없다.

“현재 pane이 뭐야?”라고 물으면 연결 전에도 `pane_list`로 현재 Herdr workspace의 모든 tab을 조회한다. 번호·이름·위치·process·소유 Broker와 조작 가능 여부를 볼 수 있다. 이 조회는 출력 수집이나 terminal 등록·실행을 하지 않는다. 조회 실패와 닫힌 등록 대상은 따로 표시한다.

같은 tab의 기존 terminal은 명시적으로 등록할 수 있다. 실행 중인 shell·SSH는 유지한다. 다른 Broker 소유 pane, Codex 대화 pane과 관리 pane은 Target으로 등록하지 않는다. 등록된 제목은 `4821 · 빌드`처럼 표시한다. 모든 Target이 닫힌 경우에도 새 terminal을 추가할 수 있다.

한 Broker에는 Parent 하나씩 연결한다. 다른 Codex는 기존 연결이 종료된 뒤 같은 번호로 이어받는다. 같은 Codex에서 같은 tab의 다른 Broker로 전환할 수 있지만 실행 중인 Action이 있으면 보류한다. 연결을 바꿔도 이전 명령을 재전송하지 않는다. Broker 중지는 관리 화면의 별도 `stop` 명령이며 공유 shell은 유지한다.

Node 24로 checkout을 준비한다.

```sh
npm ci
npm run build
node .agents/skills/broker/scripts/run.mjs setup
```

setup은 이 프로젝트의 MCP 설정만 갱신한다. Herdr 밖에서는 MCP·core·관리 화면을 실행할 수 없다. Herdr 프로젝트 shell에서 새 Codex를 시작하거나 `node .agents/skills/broker/scripts/run.mjs parent`를 사용한다.

기본 설정 파일은 OS 계정 home의 `~/.config/herdr-broker/config.json`이며 없어도 기본 경로를 사용한다. 사용자 소유 regular file, mode 0600이어야 한다.

```json
{
  "herdr_socket": "/Users/you/.config/herdr/herdr.sock",
  "codex_binary": "/opt/homebrew/bin/codex",
  "redaction_patterns": ["내부에서만 사용하는 고정 문자열"]
}
```

`redaction_patterns`는 정규식이 아닌 literal 문자열이다. 재시작 때 적용한다. HOME/XDG·MCP 인자·`--state-dir`로 state 영역을 바꿀 수 없다. core는 OS 계정 home의 `~/.local/state/herdr-broker/<endpoint와 Console ID의 digest>/`를 사용한다. 숫자 주소와 소유권은 같은 root의 `registry.sqlite`에 원자적으로 저장한다. 기존 `consoles/*.json`은 처음 조회할 때 UUID를 유지해 가져오고 원본을 보존한다. directory는 0700, DB·identity·core socket은 0600이다.

기존 Broker를 shell에서 다시 시작하려면 `node dist/cli.js start <번호>`를 사용한다. 관리 화면은 `node dist/cli.js manage <번호>` 또는 Parent의 `console_manage`로 연다. 이미 실행 중이면 재사용한다. 기존 고정 controller를 전환할 때는 진행 중인 Action이 없는 것을 확인하고 이전 Console process만 정상 종료한 뒤 `start`로 전환한다. 기존 shell과 terminal ID는 유지한다. 이미 닫힌 controller는 종료 상태로 남고, 새 terminal을 추가할 수 있다.

## Console 상태판

요청한 임시 관리 pane에서 연결·terminal과 승인 상태를 확인한다. 상세 작업 목록은 별도 보기로 유지한다. Parent → Console → Target은 소유 범위를 표시하며, 각 Target의 진행 중인 Job·Worker 분석·Action은 별도 상태로 보인다. 입력 접수는 실행 완료와 구분하고, 승인 대기·미확정 실행의 보류를 요약한다. Parent 연결 끊김, pane 종료·이동·교체, 확인 실패는 각각 표시한다. `확인 필요`인 Mode는 현재 Pane Session을 아직 확인하지 못했다는 뜻이다.

| 키 | 조작 |
| --- | --- |
| `↑↓`, `Enter` | Target 선택, 상세 보기. 상세에서는 스크롤 |
| `a` | 선택한 Target의 proposal 검토 후 명시적 승인·거절 |
| `m` | 현재 세션 확인 후 Mode 선택 |
| `n` | 같은 tab에 소유 Target 추가 |
| `w` | workspace 전체 pane 목록. 다음 페이지는 `:workspace <cursor>` |
| `l`, `?`, `Esc` | 최근 이벤트, 도움말, 돌아가기 |
| `:` | 아래의 기존 명령 입력 (`status`, `inspect`, `ssh-ready`, `recover`, `quit`, `workspace`, `stop` 등) |

작은 pane에서는 연결과 승인·보류 상태가 먼저 보인다. 상세는 같은 Console 화면에서 열리며 pane 배치를 변경하지 않는다. 최근 상태 변경 50개는 core 실행 동안 유지되고, 영속 실행 기록은 상세에서 확인한다. 상태판을 켜 두는 것만으로 terminal 출력 수집·Job·Worker 실행·승인 소비가 발생하지 않는다. 자동 갱신은 입력 중인 명령이나 검토 대상을 바꾸지 않는다.

기존 JSON 출력을 쓰려면 소유 controller에서 `herdr-broker serve <console_id> --format json`으로 시작한다. non-TTY와 `TERM=dumb`도 JSON을 사용하며 pipe에서는 사용자 승인·Mode 상향 권한을 얻지 못한다. 관리 화면의 `quit`는 관리 pane만 닫고 core는 유지한다. 기존 고정 controller는 명시적 전환 시 공유 shell이 되며 UUID·Control State를 이어받는다.

## 진단과 Action

1. 공유 작업의 파일 확인·편집·실행은 옆 pane에 명령을 입력해서 수행한다. Parent의 별도 file/shell tool로 대신하지 않는다. Parent가 exact pane을 `pane_describe`로 확인하고 목표를 정해 `job_start`한다.
2. `job_wait`로 bounded context 또는 Worker report를 받고 필요한 `evidence_get`만 조회한다. 출력 길이와 무관하게 기본 `gpt-5.6-luna/high` Worker가 전달된 Snapshot만 요약한다. 사용자가 원문 확인을 요청하면 `analysis: "direct"`와 `evidence_get`을 사용한다. 결과 준비는 job/명령 완료와 별개다.
3. 기본 `action_scope`는 `{"profile":"terminal"}`이다. Parent는 현재 화면을 읽고 `operation: "input"`과 정확한 `text`, `keys`, 위험 판단으로 `action_propose`한다. shell·SSH·REPL·TUI에 같은 경로를 쓰며 `ssh-ready`나 cwd 선언은 필요 없다. Enter는 필요할 때 `keys: ["Enter"]`로 명시한다.
4. 현재 모드에 따라 `action_submit`을 호출한다. input Receipt의 `accepted`는 입력 접수이며 exit는 null이다. 직전 cursor를 `job_wait`에 돌려주어 새 화면을 읽고 결과를 판단한다. 기존 POSIX `execute`만 wrapper와 완료 marker를 사용한다.

새 Pane Session 기본은 **2 Agent Risk Review**다. 같은 세션의 다음 job에도 모드를 유지한다.

| Mode | 입력 허용 방식 |
| --- | --- |
| 1 User Approval | 매 proposal을 사용자가 승인 |
| 2 Agent Risk Review | 확인된 저위험/제한 변경은 Parent 판단으로 허용. 고위험·불확실·누락 판단은 사용자 승인 |
| 3 Autonomous | 선언한 범위 안에서 개별 승인 없이 허용 |

모드 상향은 `manage`의 실제 interactive 관리 화면에서만 한다. 세 모드 모두 같은 대상·예산·취소·영속 hold 검사를 사용한다. mode는 같은 OS 사용자의 직접 CLI/socket 접근을 막는 격리가 아니다.

```text
status
mode <pane_session_id> 1
review <proposal_id>
approve <proposal_id>
reject <proposal_id>
revoke <proposal_id>
```

`review`에 표시된 대상·목표·전체 escaped payload를 확인한 뒤 승인한다. mode 변경·새 목표·payload 변경·session 변경은 새 proposal을 요구한다. 승인은 최대 5분이며 한 번의 제출 시도에만 사용한다. pipe·RPC의 인간 주장으로 승인할 수 없다.

## 중지·불명 상태·복구

`job_cancel`은 이후 Worker와 미제출 입력을 중지하며 자동 Ctrl-C를 보내지 않는다. 이미 제출된 명령의 ACK와 제한된 passive 관찰은 독립적으로 정리한다. 기존 POSIX execute가 held 상태라면 원래 Action과 같은 관찰 session에 결합한 별도 `interrupt`만 현재 정책에 따라 `Ctrl+c`를 보낼 수 있다. interrupt는 자체 exit를 약속하지 않는다.

`accepted`는 Herdr의 입력 접수 응답이다. 일반 input은 `not_applicable`과 null exit를 유지하고 결과를 다음 화면에서 확인한다. 기존 POSIX execute는 `completion_observed`와 exit code로 완료 관찰을 기록한다. unknown은 자동 재전송하지 않으며 새 job이나 mode 3도 terminal hold를 우회하지 못한다. 늦거나 중복된 terminal 출력은 신뢰할 수 있는 process 완료 증명과 다르다.

held terminal의 현재 상태를 직접 확인한 뒤 console에서 다음을 사용한다.

```text
inspect <pane_id>
recover <original_proposal_id> <새 작업 목표>
```

Broker가 현재 mapping·session·revision을 다시 확인한다. 일반 input hold는 `user_verified_input_target`으로 복구하며 shell 준비 선언을 요구하지 않는다. 기존 execute hold는 ready shell을 요구한다. 원래 unknown/null exit를 성공으로 바꾸지 않고 복구 근거를 남긴다. 기존 job은 중지되므로 새 목표로 새 job을 시작한다. mode 선택이나 상태 파일 삭제로 복구하지 않는다.

## 데이터와 예산

```text
purge <job_id>
purge all
help
quit
```

purge는 Snapshot·report·Evidence·pending payload를 제거한다. 제거된 Evidence를 현재 pane 내용으로 대체하지 않는다. consumed ID와 미확정 intent/hold는 남는다. 본문은 job 종료 후 30분, purge, core 종료 중 먼저 도달한 시점에 지워진다. 메모리 압박은 오래된 종료 job부터 지우고 활성 본문만 남으면 새 처리를 거부한다.

| 상한 | 값 |
| --- | --- |
| Snapshot | 1,000행 / 64 KiB |
| Report / response / Evidence | 4,096 bytes / 8 KiB / 2 KiB |
| Parent 누적 데이터 | job당 16 KiB, 반복 응답과 Action payload 포함 |
| Worker | 동시에 1개, job당 4회, 호출당 60초, observed input+output 100k tokens |
| 일반 Action / interrupt | job당 3회 / 1회 |
| job / Action 관찰 | 최대 300초 / 별도 최대 60초 |
| 본문 메모리 회계 | 64 MiB, process 전체 RSS 상한과 다름 |

해결된 control 기록은 7일 뒤 축약할 수 있다. 미확정 hold와 관련 interrupt, consumed ID는 자동 만료하지 않는다. SQLite에는 식별자·digest·상태·시각·승인 소비·복구 근거만 저장한다. digest는 비밀 암호화가 아니다. Codex ephemeral DB/WAL 및 provider 기록이 생길 수 있으므로 전체 no-store나 no-disk 조건을 만족하는 제품으로 사용하지 않는다.

## 문제 점검

`node dist/cli.js doctor <Console ID>`는 pane에 입력하지 않고 version·profile·해당 Console의 실제 state 쓰기/권한을 확인한다. model inference와 credential 조회는 하지 않으므로 계정의 model 사용 가능성은 실제 Worker 호출에서 확인한다.

| 오류 | 확인할 내용 |
| --- | --- |
| `node_24_required` | Node 24로 설치한 executable 실행 |
| `herdr_context_required` / `herdr_context_mismatch` | 이 프로젝트의 로컬 Herdr pane에서 시작. 환경변수를 수동으로 지정하지 않고 현재 pane의 문맥으로 Parent를 다시 실행 |
| `project_context_required` | project skill이 있는 저장소 안의 cwd에서 helper 실행 |
| `herdr_unsupported` / `worker_unsupported` | pinned Herdr/Codex version과 binary 경로 |
| `core_unavailable` / `authority_busy` | 해당 Console의 조작 pane과 core |
| `console_busy_or_disconnected` | 기존 Parent를 종료하고 다시 접속 |
| `console_already_bound` | 새 Broker 생성 전에 `console_detach`. 기존 Broker는 정확한 번호로 `console_attach`하여 전환 |
| `pane_outside_console` | 해당 Console이 등록한 pane·terminal·workspace만 사용 |
| `console_workspace_changed` / `console_controller_busy` | 조작 pane의 mapping과 실행 중인 process를 사용자와 확인 |
| `config_invalid` / `state_permissions` | 소유권·regular file·권한·strict 설정 field |
| `session_changed` / `target_changed` | exact pane 재조회 후 새 job/proposal |
| `terminal_held` | original receipt와 실제 shell 확인 후 명시적 복구 |
| `ledger_missing` / `ledger_invalid` / `ledger_unavailable` | core를 중지하고 신뢰할 수 있는 저장 상태를 확인. 기존 intent를 버리는 빈 ledger 생성 금지 |

원격 identity 인증, 감지되지 않는 연결 변화, 재검증과 전송 사이 race, 외부 Herdr client 입력 잠금, exactly-once 실행은 보장하지 않는다.

## 기존 POSIX wrapper의 SSH POSIX shell 준비

SSH 연결 후 실제 pane이 협조적인 idle POSIX shell이고 현재 cwd가 맞는지 확인한다. 이어서 `serve` console에서 다음을 실행한다.

```text
inspect <pane_id>
ssh-ready <pane_session_id> <absolute cwd>
```

Parent는 같은 cwd의 `ssh_posix` scope로 job을 시작한다. 이 확인은 사용자 선언이며 remote host/user의 인증 결과가 아니다. 명령 제출 시 준비 상태를 소비하고 신뢰 가능한 완료 관찰 뒤에만 다음 입력이 가능하다. 결과 불명은 실제 shell 확인 후 `inspect`/`ssh-ready`, 다시 `inspect`/`recover` 순서로 복구한다. 재연결·대상 변경·core restart 뒤에는 다시 확인해야 한다. 최종 acceptance가 통과한 package만 SSH 실행 profile을 제공한다.
