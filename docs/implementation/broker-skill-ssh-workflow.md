# Broker Skill과 pane을 통한 공유 작업

2026-09-16. 사용자 요청에 따라 project Skill 호출 이름을 `$broker`로 줄인다. 저장소·실행 파일·MCP server의 이름은 `herdr-broker` / `herdr_broker`를 유지한다.

## Skill 이름 변경

- canonical Skill은 `.agents/skills/broker/SKILL.md`, helper는 같은 폴더의 `scripts/run.mjs`다.
- 기존 helper 경로는 짧은 전달 스크립트로 남겨 이미 안내된 명령이 동작하도록 한다. Skill 목록에는 `$broker` 하나를 노출한다.
- 현재 SSH terminal이나 실행 중인 Parent/core를 이름 변경만으로 종료하지 않는다. project·Herdr 문맥 검증과 기존 MCP 설정은 유지한다.
- 새 Skill 검사, helper 설정 보존·멱등성, Herdr 밖 실행 거부를 검증한다.

## 확인한 SSH 차단 원인

현재 1008은 SSH 연결이 확인되고 Mode 2가 적용되어 있지만, 별도의 사용자 준비 선언이 없어 `supported_profiles: ["passive"]`, `action_supported: false`로 표시된다. 현재 설계는 관리 화면에서 `inspect`, `ssh-ready <session> <cwd>`를 요구한다. 이는 원격 파일 권한 오류나 Mode 변경 실패와 다른 제약이다.

사용자는 SSH 전용 실행이 아니라, 현재 pane에 표시된 내용을 읽고 그 프로그램에 맞는 텍스트·키를 입력하는 방식을 요청했다. 파일 확인·편집·실행도 공유 pane에 명령을 입력해서 수행한다. Parent의 별도 shell/file tool로 대상 작업을 대신하지 않는다.

## 기본 read / input 계약

- `job_start`의 `action_scope: {"profile":"terminal"}`은 현재 pane을 통한 작업이다. shell, SSH, REPL, TUI 종류나 cwd, `ssh-ready` 선언을 요구하지 않는다. 기존 POSIX profile은 호환 경로로 보존한다.
- `job_wait`는 pane의 제한된 출력을 제공한다. 출력 길이와 무관하게 기본 `analysis: "worker"`로 restricted Worker가 `gpt-5.6-luna/high` 요약을 제공한다. 사용자가 원문 확인을 요청한 경우 `analysis: "direct"`와 `evidence_get`으로 제한된 원문을 조회한다. 기존 `auto`는 명시적 호환 옵션으로 유지한다. Worker는 전달된 Snapshot만 읽고 도구·파일·socket에 접근하거나 명령을 실행하지 않는다.
- `action_propose`의 `operation: "input"`에는 정확한 `target`, Job의 `objective`, `text`, `keys`, `risk`를 넣는다. Broker는 text 다음 keys 순서로 그대로 보낸다. wrapper, cwd 변경, Enter를 자동으로 추가하지 않는다. 줄바꿈도 입력에 포함되므로 Parent는 전체 입력의 영향을 판단해야 한다.
- Mode 1은 사용자 승인, 기본 Mode 2는 Parent의 위험 검토, Mode 3은 사용자가 선택한 자율 실행이다. Mode 상향·승인·hold 복구는 실제 interactive 관리 화면에 남긴다.
- 정확한 terminal identity, Session·Mode revision, Job 예산, 소유권, 영속 intent와 중복 제출 방지를 유지한다. input과 execute는 Job당 일반 입력 예산 3회를 공유한다.
- ACK는 입력 접수만 뜻한다. input Receipt는 `observation_state: "not_applicable"`, `exit_code: null`이며 명령 완료를 주장하지 않는다. Parent는 다음 `job_wait`에 cursor를 돌려주어 새 화면을 읽고 결과를 판단한다.
- input 전송 중에는 해당 terminal을 hold한다. 접수·명시적 거절이 확인되면 그 input의 hold만 해제한다. ACK 유실이나 core 중단은 hold를 유지하며 자동 재전송하지 않는다. 기존 execute의 미확정 hold를 input으로 우회할 수 없다.
- input의 미확정 hold는 사용자가 실제 pane 상태를 확인한 뒤 기존 `inspect` / `recover`로 복구한다. 이 경우 shell-ready를 요구하지 않고 `user_verified_input_target`을 기록한다. 기존 execute hold 복구에는 기존 ready-shell 조건을 유지한다.
- SSH 여부는 기존 호환 profile과 Session 연속성 판단에 쓰는 metadata일 뿐, 일반 pane 입력 가능 여부의 전제 조건이 아니다. 입력 직전에 terminal·Session을 재확인한다. 사용자도 같은 pane에 입력할 수 있으므로 화면 읽기와 입력 사이의 원자성이나 프로그램 상태 고정을 보장하지 않는다.

## 검증

1. 준비 선언 없는 SSH와 실행 중인 REPL/TUI에 동일한 public MCP input을 사용하고, 실제 wire payload에 wrapper나 Enter가 추가되지 않는지 확인한다.
2. Mode·승인 만료·대상 교체·hold·공유 예산·ACK 유실·재시작 중복 방지를 검증한다. input Receipt가 실행 완료로 표시되지 않아야 한다.
3. Worker high 인자와 tool 제한, Snapshot 요약·Evidence 흐름을 확인한다.
4. 전체 test·typecheck·build와 Standards/Spec review 후 commit한다. 실제 Herdr 검증은 기존 terminal 및 SSH process를 보존한다.

## 기존 결정과의 관계

[ADR 0002](../adr/0002-action-submission-and-observation.md)의 제출·관찰 분리를 유지한다. 기존 POSIX wrapper의 완료 추적을 모든 입력에 강제하던 범위를 바꾼다. 일반 pane 입력의 접수 이후 작업 상태는 새 화면 관찰로 판단한다. [ADR 0001](../adr/0001-pane-session-action-modes.md)의 사용자만 Mode 상향 정책은 유지한다.

## 구현 검증 기록

- 전체 test **261개 통과**. 기존 자동 size 분기 검증은 `analysis: "auto"`를 명시해 호환 동작을 유지하고, 새 기본값은 짧은 출력에도 Worker를 실행하는 별도 public MCP test로 확인했다.
- 새 test는 준비되지 않은 SSH·Python·Vim의 동일 입력 경로, exact text/keys, 사용자 승인과 Mode 변경, 잘못된 payload·대상 교체 거부, 3회 예산, execute hold 우회 거부, ACK 유실·late ACK·재시작과 interactive 복구를 포함한다.
- typecheck, build, Skill validator, `git diff --check` 통과.
- 기준 `884bada` 이후 Standards·Spec review 완료. 오래된 Worker effort와 MCP 인자 표를 수정한 뒤 두 축 모두 잔여 지적 0건.

### 실제 Herdr 확인

- 기존 Broker `1000`의 Parent가 종료됐고 진행 중인 입력·hold가 없음을 확인한 뒤 core를 정상 종료하고 같은 Herdr tab에서 재개했다. 새 `$broker` Parent를 `w2:p7`에서 시작했다. Target `1008`의 pane `w2:pF`와 terminal `term_65b918c64c9f93b`를 그대로 유지했다. 확인 당시 Target은 사용자가 SSH를 종료한 local shell이었다.
- Parent가 Broker MCP만으로 `/tmp/herdr-broker-demo.8NIqGr/hello.sh`를 작성하고 `cat`으로 확인했다. 이어 같은 pane에서 `before`를 `after`로 수정하고 `cat`, 마지막으로 `sh`를 실행했다. 별도 wrapper 없이 같은 shell의 `hb_demo_dir` 변수가 유지됐다.
- 각 화면은 기본 Worker로 관찰했다. 최종 보고가 실제 출력 `hello after`와 prompt 복귀를 확인했다. 요청 profile은 `gpt-5.6-luna/high`이며 provider가 실제 model 식별자를 반환하지 않아 `model_observed`는 null이다.
- 실제 input Receipt 3건은 모두 `accepted`, `not_applicable`, null exit이며 `parent_risk_review`로 허용됐다. 최종 hold 0, 진행 중인 Action 0, 검증 Job 종료를 확인했다. ACK만으로 성공을 추정하지 않고 후속 화면으로 판단했다.
- 과정 중 Parent 데이터 예산 도달 1회와 Worker report 형식 오류 1회가 있었다. 새 Job에서 화면만 다시 관찰해 이어갔으며 제출된 입력은 재전송하지 않았다. 형식 검증은 유지했고 `auto`/`direct`로 우회하지 않았다.
- shell·Broker·Parent는 사용 가능한 상태로 남겼다. 실제 SSH·REPL·TUI 입력은 동일 wire 계약의 fixture 테스트로 검증했으며, 이 사용 확인에서 SSH에 다시 연결하거나 기존 사용자 파일을 수정하지 않았다.
