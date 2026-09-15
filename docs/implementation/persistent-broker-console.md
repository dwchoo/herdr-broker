# 지속되는 Broker Console과 공유 terminal

2026-09-16. 사용자는 자신과 Codex가 같은 실제 terminal을 보고 조작하는 작업 공간을 원한다. Project skill이 Broker Console을 열고, 연결된 Codex는 그 Console이 소유한 Target Pane만 Broker를 통해 읽고 조작한다.

## 확정한 사용 계약

- Broker Console은 하나 이상의 실제 terminal과 사용자 조작 화면을 가진 지속 작업 공간이다. Codex와 사용자가 같은 shell·SSH session을 관찰하고 조작한다.
- Console의 수명은 Codex와 독립적이다. 정상 종료와 비정상 종료 모두 Console과 terminal을 유지하며, 사용자가 작업 공간을 명시적으로 닫을 때 종료한다.
- Project skill은 새 Console 시작과 기존 Console 재접속을 지원한다. 전역 Codex MCP 등록 없이 이 프로젝트와 실제 Herdr 실행 문맥을 요구한다.
- Parent의 Broker 연결은 Console 하나에 결합한다. 다른 Console과 외부 pane의 출력 조회·Job·Action을 거부한다. 화면에 보이는 pane 목록만 줄이는 것으로 구현하지 않는다.
- 소유권은 pane·terminal 식별자에 결합한다. pane 이동·교체·재생성으로 다른 terminal을 조용히 채택하지 않는다.
- Parent가 끊기면 새 작업과 미제출 Action을 멈춘다. 이미 제출된 명령을 자동 재전송하거나 대상 shell에 자동 Ctrl-C를 보내지 않는다.
- 다시 연결한 Parent는 Console의 현재 대상·실행 기록·미확정 hold를 확인하고 새 관찰에서 작업을 이어간다. 이전 Codex 대화와 모든 과거 Snapshot을 영구 복구한다는 뜻은 아니다.
- Action Mode의 기본값 2, 사용자만 상향 가능, 같은 Pane Session 동안 유지하는 기존 계약은 계속 적용한다.
- 동일 OS 사용자가 코드나 내부 socket을 직접 바꾸는 고의적 우회를 막는 OS 격리는 이번 범위가 아니다.

## 실행 구조

사용자는 Herdr의 실제 pane을 전용 작업 공간으로 묶는 구성을 선택했다. Console마다 새 Herdr workspace를 만들고 사용자 조작 화면과 첫 Target Pane을 함께 배치한다. 사용자는 Target Pane에서 직접 입력하고, Parent는 같은 terminal을 Broker를 통해 읽고 조작한다. Console에서 추가한 terminal도 같은 소유 범위에 등록한다.

Console마다 core 하나와 독립적인 Control State를 둔다. 이를 허용하는 전제는 서로 겹치지 않는 terminal 소유권이다. Console은 생성 과정에서 새로 만든 pane·terminal만 등록하며, 기존 외부 pane의 가져오기와 다른 Console의 terminal 채택은 제공하지 않는다. 조회와 제출 모두 등록된 pane·terminal 및 현재 workspace를 다시 확인한다. 기존 ADR 0004의 endpoint 단위 core 선택은 이 구조에서 ADR 0005로 보완한다.

MCP 진입점은 처음에는 Console 시작·목록·접속을 제공하고, Console 하나를 선택한 뒤 그 core에 연결한다. 한 Parent 연결은 Console 하나에 고정한다. Console의 interactive 화면은 기존 승인·모드·SSH 준비·복구 기능과 소유 pane 목록을 제공한다. Console당 한 Parent 연결만 받으며 기존 연결이 끊긴 뒤 새 Parent가 붙는다.

Codex와 MCP의 종료는 Console process와 Herdr terminal을 종료하지 않는다. 재접속한 Parent는 소유 pane과 이전 Action Receipt를 확인하고 새로운 Job으로 관찰을 시작한다. 제출 완료와 결과 불명 상태는 그대로 유지하며 자동 재전송하지 않는다. Console 자체가 재시작되어도 동일 Console의 Control State를 열고 현재 terminal 식별자를 재검증한다.

Herdr 자체의 workspace를 닫으면 그 Console과 terminal이 종료된다. 종료된 workspace를 같은 Console ID로 조용히 재생성하지 않는다.

## 검증할 공개 interface

기존에 합의한 공개 MCP 도구·사용자 console·실제 process와 Herdr adapter를 사용한다.

1. Skill로 실제 공유 terminal을 만들고 사용자 입력과 Parent의 Broker 입력이 같은 terminal에 나타난다.
2. 다른 Console·미등록 pane·교체된 terminal에 대한 조회와 입력이 모두 거부된다.
3. Codex 정상 종료와 강제 종료 뒤에도 terminal과 Console이 유지된다.
4. 새 Parent가 기존 Console에 재접속해 현재 출력과 이전 실행 결과를 확인하고 작업을 이어간다.
5. 미확정 Action이 있는 재접속은 자동 재전송·hold 우회·모드 상향을 하지 않는다.
6. 외부 Codex와 다른 프로젝트의 정상 실행 진입점은 계속 거부된다.

기존 사용자 변경과 실행 중인 shell은 보존한다. 검증은 새로 만든 소유 작업 공간에서 수행한다.

## 구현과 검증 결과

Project skill과 `.codex/config.toml`의 project 전용 설정을 적용했다. MCP는 `console_open`·`console_list`·`console_attach`·`console_status`와 기존 Broker 도구를 제공한다. 조작 pane에서 `new`로 terminal을 추가하고 `panes`로 소유 대상과 Receipt를 확인한다. 시작·재접속에 필요한 core는 native 조작 pane에서 자동으로 실행한다.

[검증 기록](persistent-broker-console-results.json)에 실제 Herdr·Codex 결과를 기록했다.

- 실제 Codex가 skill로 기존 Console에 붙어 `hello world from Codex skill`을 출력했고 `accepted`·`completion_observed`·exit 0을 확인했다.
- Codex의 정상 종료와 Job 시작 직후 SIGKILL 모두 기존 core와 Target shell PID를 유지했다. 새 Parent가 이전 Receipt와 같은 terminal을 확인하고 작업을 이어갔다.
- 사용자 console에서 추가한 terminal도 재접속한 Parent가 읽고 조작했다. core를 `quit`로 중지한 뒤 다시 붙었을 때 두 terminal과 Receipt 4개가 유지됐다.
- 교차 Console 접근, 미등록·이동·교체된 pane, controller의 REPL 교체, 단일 Parent 연결, hold 보존과 재전송 금지를 공개 MCP 경계에서 검증했다.
- Review에서 찾은 설정 보존·목록 크기·doctor 경로·controller 준비 검사를 보완했다. 관련 회귀 검증과 최종 전체 테스트 206개가 모두 통과했다. Typecheck와 Skill validator도 통과했다.

실제 Codex 검증에서는 proposal의 objective가 Job과 달라 한 번 거부됐고 Codex가 수정했다. 명령 완료를 확인한 뒤 추가 Evidence를 조회하면서 누적 예산에 도달해 Job이 종료됐다. 이 결과를 숨기지 않고 검증 기록에 남겼으며 Skill은 exact Job objective를 재사용하도록 보완했다.

Idle core의 한 시점 RSS는 약 79 MiB였다. Parent·MCP gateway·Worker를 포함한 전체 사용량이나 부하 측정 결과는 아니다. 이전에 실행 중이던 legacy core와 사용자 pane은 유지했다. 새 project MCP 설정은 새로 시작한 Codex부터 적용된다.

## Standards

Project 설정의 symlink 차단·원자적 갱신, 목록 응답 크기와 pagination, Console별 doctor 경로를 재검토했다. 잔여 finding은 0건이다.

## Spec

공유 terminal 소유권, Parent 종료 후 수명, 재접속, controller의 실제 shell 확인과 기존 설정 보존을 재검토했다. 잔여 finding은 0건이다.

검토 요약: Standards 0건 · Spec 0건.
