# herdr-broker 설치와 사용

## 필요한 환경

검증 기준은 macOS arm64, Node 24, Herdr 0.9.0/protocol 22, Codex CLI 0.154.0이다. Worker는 `gpt-5.6-luna`/low를 사용하며 로컬 Codex 계정의 기존 인증으로 실행한다. 원격에 AI runtime이나 credential을 설치하지 않는다. SSH 실행은 사용자 준비 확인이 필요한 `ssh_posix` profile로 제공한다. [SSH acceptance](implementation/issue-24-ssh-acceptance.md)는 #24 artifact의 기록이며, 현재 checkout의 실행 문맥과 검증 절차는 [project skill 검증](implementation/project-skill-herdr-context.md)을 따른다.

## Broker Console 시작과 재접속

Herdr에서 이 프로젝트를 연 Codex에게 `$herdr-broker`를 요청한다. Skill은 새 **Broker Console**을 열거나 기존 Console ID에 재접속한다. 새 Console은 전용 Herdr workspace 안에 사용자 조작 pane과 실제 Target terminal을 함께 만든다. 사용자는 Target terminal에 직접 입력하고 Codex는 같은 terminal을 Broker로 읽고 조작한다.

| 위치 | 역할 |
| --- | --- |
| Parent Pane | 프로젝트의 Codex CLI. 하나의 Console에 연결 |
| Console workspace의 조작 pane | 독립 core, 소유 pane 목록, 승인·모드·복구 |
| 같은 workspace의 Target Pane | 사용자와 Codex가 공유하는 실제 local/SSH shell |

Console마다 core와 Control State가 독립적이다. Broker가 새로 만든 terminal만 등록하며 기존 외부 pane 가져오기는 제공하지 않는다. Worker는 필요할 때 core가 실행하므로 별도 pane이 필요 없다.

Node 24로 checkout을 준비한다.

```sh
npm ci
npm run build
node .agents/skills/herdr-broker/scripts/run.mjs setup
```

`setup`은 이 checkout의 `.codex/config.toml`에 MCP 실행 경로를 설정한다. 전역 설정은 바꾸지 않는다. 기존 파일의 설정은 보존하며 이미 다른 `herdr_broker` 설정이 있으면 덮어쓰지 않는다. 새 파일의 승인 정책은 `on-request`이며 기존 approval reviewer를 사용한다. 이 설정 단계는 Herdr 밖에서도 가능하지만 Broker 도구 사용은 실제 Herdr 문맥을 요구한다. 실행 경로가 바뀌면 setup을 다시 실행한다.

이후 Herdr의 이 프로젝트 shell에서 Codex를 새로 시작해 `$herdr-broker`를 사용한다. 현재 실행 중인 Codex에는 새 MCP 설정이 소급 적용되지 않는다. 이번 실행에만 연결하려면 다음 helper도 사용할 수 있다.

```sh
node .agents/skills/herdr-broker/scripts/run.mjs parent
```

MCP가 처음 연결될 때는 terminal이나 core를 만들지 않는다. Skill의 `console_open`이 workspace와 core를 자동으로 시작하며, `console_attach`는 기존 Console을 검증해 연결한다. 사용자가 별도 `serve` 명령을 먼저 실행할 필요가 없다. 한 Console에 Parent 하나만 연결된다.

Codex의 정상 종료·강제 종료 뒤에도 Console과 shell/SSH는 유지된다. 재접속할 Codex에 `$herdr-broker Console <ID>에 이어 붙어줘`라고 요청한다. ID를 모르면 Skill이 목록을 조회한다. 새 Parent는 실행 결과와 hold를 확인한 뒤 새 Job으로 관찰을 이어간다. 이전 command를 재전송하지 않는다.

조작 pane에서 `panes`는 대상과 실행 기록을 보여 주고, `new`는 같은 workspace의 새 tab에 소유 terminal을 추가한다(최대 8개). Herdr에서 수동으로 만든 pane은 등록되지 않는다. `quit`는 core만 중지하고 terminal은 유지한다. 다시 접속하면 기존 조작 pane이 idle shell일 때 같은 Control State로 core를 재시작한다. **작업 공간 전체를 끝내려면 사용자가 Herdr workspace를 닫는다.** 닫힌 workspace를 이전 Console ID로 자동 재생성하지 않는다.

기본 설정 파일은 OS 계정 home의 `~/.config/herdr-broker/config.json`이며 없어도 기본 경로를 사용한다. 사용자 소유 regular file, mode 0600이어야 한다.

```json
{
  "herdr_socket": "/Users/you/.config/herdr/herdr.sock",
  "codex_binary": "/opt/homebrew/bin/codex",
  "redaction_patterns": ["내부에서만 사용하는 고정 문자열"]
}
```

`redaction_patterns`는 정규식이 아닌 literal 문자열이다. 재시작 때 적용한다. HOME/XDG·MCP 인자·`--state-dir`로 state 영역을 바꿀 수 없다. core는 OS 계정 home의 `~/.local/state/herdr-broker/<endpoint와 Console ID의 digest>/`를 사용한다. Console 등록 정보는 같은 root의 `consoles/`에 저장한다. directory는 0700, DB·identity·core socket은 0600이다.

## 진단과 Action

1. Parent가 exact pane을 `pane_describe`로 확인하고 목표를 정해 `job_start`한다.
2. `job_wait`로 bounded context 또는 Worker report를 받고 필요한 `evidence_get`만 조회한다. 결과 준비는 job/명령 완료와 별개다.
3. 실행할 경우 처음부터 cwd·영향 경로·협조적 shell 범위를 `action_scope`로 선언한다. Parent가 정확한 command·env·위험 판단을 넣어 `action_propose`한다.
4. 현재 모드에 따라 `action_submit`을 호출한다. 완료 여부는 `action_status`의 observation과 exit를 확인한다.

새 Pane Session 기본은 **2 Agent Risk Review**다. 같은 세션의 다음 job에도 모드를 유지한다.

| Mode | 입력 허용 방식 |
| --- | --- |
| 1 User Approval | 매 proposal을 사용자가 승인 |
| 2 Agent Risk Review | 확인된 저위험/제한 변경은 Parent 판단으로 허용. 고위험·불확실·누락 판단은 사용자 승인 |
| 3 Autonomous | 선언한 범위 안에서 개별 승인 없이 허용 |

모드 상향은 `serve`의 실제 interactive console에서만 한다. 세 모드 모두 같은 대상·예산·취소·영속 hold 검사를 사용한다. mode는 같은 OS 사용자의 직접 CLI/socket 접근을 막는 격리가 아니다.

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

`job_cancel`은 이후 Worker와 미제출 입력을 중지하며 자동 Ctrl-C를 보내지 않는다. 이미 제출된 명령의 ACK와 제한된 passive 관찰은 독립적으로 정리한다. 원래 Action과 같은 관찰 session에 결합한 별도 `interrupt`만 현재 정책에 따라 `Ctrl+c`를 보낼 수 있다. interrupt는 자체 exit를 약속하지 않는다.

`accepted`는 Herdr의 입력 접수 응답이다. `completion_observed`와 exit code가 관찰돼야 명령 결과를 말할 수 있다. unknown은 자동 재전송하지 않으며 새 job이나 mode 3도 terminal hold를 우회하지 못한다. 늦거나 중복된 terminal 출력은 신뢰할 수 있는 process 완료 증명과 다르다.

held terminal에서 실제 shell이 준비됐음을 확인한 뒤 console에서 다음을 사용한다.

```text
inspect <pane_id>
recover <original_proposal_id> <새 작업 목표>
```

Broker가 현재 mapping·session·revision·ready shell을 다시 확인한다. 원래 unknown/null exit를 성공으로 바꾸지 않고 복구 근거를 남긴다. 기존 job은 중지되므로 새 목표로 새 job을 시작한다. mode 선택이나 상태 파일 삭제로 복구하지 않는다.

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
| `console_already_bound` | 이 MCP 연결은 이미 Console 하나에 결합됨. 다른 Console은 새 Parent에서 접속 |
| `pane_outside_console` | 해당 Console이 등록한 pane·terminal·workspace만 사용 |
| `console_workspace_changed` / `console_controller_busy` | 조작 pane의 mapping과 실행 중인 process를 사용자와 확인 |
| `config_invalid` / `state_permissions` | 소유권·regular file·권한·strict 설정 field |
| `session_changed` / `target_changed` | exact pane 재조회 후 새 job/proposal |
| `terminal_held` | original receipt와 실제 shell 확인 후 명시적 복구 |
| `ledger_missing` / `ledger_invalid` / `ledger_unavailable` | core를 중지하고 신뢰할 수 있는 저장 상태를 확인. 기존 intent를 버리는 빈 ledger 생성 금지 |

원격 identity 인증, 감지되지 않는 연결 변화, 재검증과 전송 사이 race, 외부 Herdr client 입력 잠금, exactly-once 실행은 보장하지 않는다.

## SSH POSIX shell 준비

SSH 연결 후 실제 pane이 협조적인 idle POSIX shell이고 현재 cwd가 맞는지 확인한다. 이어서 `serve` console에서 다음을 실행한다.

```text
inspect <pane_id>
ssh-ready <pane_session_id> <absolute cwd>
```

Parent는 같은 cwd의 `ssh_posix` scope로 job을 시작한다. 이 확인은 사용자 선언이며 remote host/user의 인증 결과가 아니다. 명령 제출 시 준비 상태를 소비하고 신뢰 가능한 완료 관찰 뒤에만 다음 입력이 가능하다. 결과 불명은 실제 shell 확인 후 `inspect`/`ssh-ready`, 다시 `inspect`/`recover` 순서로 복구한다. 재연결·대상 변경·core restart 뒤에는 다시 확인해야 한다. 최종 acceptance가 통과한 package만 SSH 실행 profile을 제공한다.
