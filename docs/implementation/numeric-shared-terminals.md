# 숫자 주소와 pane 탐색을 갖춘 공유 terminal

2026-09-16. 사용자가 승인한 계획의 구현 계약이다. Broker는 같은 Herdr tab의 공유 terminal 묶음을 관리하고, 화면을 차지하지 않는 독립 process로 유지한다. 현재 Console pane도 일반 shell로 전환한다.

## 번호와 탐색

- 같은 OS 사용자 등록소에서 Broker와 terminal에 1000–9999의 고유 번호를 원자적으로 할당한다. 재시작·이름 변경 후 유지하며 자동 재사용하지 않는다. 소진되면 명확하게 거부한다. UUID와 실제 terminal identity는 보존한다.
- pane_list의 기본 범위는 현재 Herdr workspace 전체다. 미등록·다른 tab·다른 Broker 소유·Codex pane을 포함하며 역할, 번호, 이름, 위치, process·cwd, 소유권, 조작 가능 상태와 확인 시각을 제공한다. Broker 연결 전에도 조회할 수 있다.
- Broker 소유 목록은 종료·이동·교체 상태도 표시한다. 조회 실패는 빈 목록으로 위장하지 않는다. 목록은 페이지로 제공한다. 조회는 metadata만 읽고 출력·입력·Job·Worker·자동 등록·이름 변경을 일으키지 않는다.
- 불완전한 번호와 이름, 대화 맥락은 agent가 목록을 보고 판단한다. prefix·편집 거리·점수 기반 자동 교정은 구현하지 않는다. 실행 전에는 선택한 정확한 ID와 현재 identity·소유 범위를 검증한다.

## 수명과 조작

- 한 Broker에는 Parent 하나만 연결한다. 정상·비정상 Codex 종료와 관리 화면 종료 뒤에도 core·terminal을 유지한다. 같은 tab에서 명시적으로 연결을 해제·전환할 수 있으며 진행 중인 Action이 있으면 보류한다.
- 기본 화면은 일반 shell이다. 요청할 때만 같은 tab에 임시 관리 pane을 열고 이미 있으면 재사용한다. 관리 pane 종료는 그 pane만 닫는다. Broker 중지는 별도 사용자 조작이며 공유 terminal은 종료하지 않는다.
- 같은 tab의 사용자가 지정한 기존 terminal을 등록할 수 있다. shell·SSH·실행 중인 명령을 재시작하지 않는다. Codex, 관리 pane, 다른 Broker 소유 terminal은 등록을 거부한다. 모든 기존 Target이 닫혀도 새 terminal을 만들 수 있다.
- 등록한 pane 제목은 `4821 · 빌드`처럼 표시한다. 등록하지 않은 pane은 탐색만으로 이름을 바꾸지 않는다. 관리 pane은 `관리 · 7316`처럼 담당 Broker를 표시한다.
- core와 관리 화면 사이에 소유자 전용 local control 연결을 둔다. 관리 연결은 등록된 관리 pane의 현재 identity와 비공개 capability를 확인한다. 실제 interactive frontend만 승인·Mode 상향을 제공하며 Parent MCP에는 capability나 승인 명령을 노출하지 않는다. 같은 OS 사용자의 직접 socket/filesystem 공격 차단은 기존과 같이 범위 밖이다.
- 기본 Mode 2, stale review 검증, 보류·영속 Receipt를 유지한다. 기존 Job·Worker·Action과 상세 작업 목록은 별도 보기로 보존한다. 대기 작업·예약 실행은 후속 범위다.

## interface와 전환

- 기존 UUID·pane ID interface에 console_code·pane_code와 목록 metadata를 추가한다. console_attach는 정확한 UUID 또는 4자리 번호를 받는다. controller는 관리 화면이 닫혀 있으면 null이다.
- pane_list, 명시적 console_detach, terminal 등록·이름 변경, 관리 화면 열기를 제공한다. pane 번호는 현재 목록에서 실제 pane ID로 해석한 뒤 기존 실행 경로를 사용한다.
- 기존 Console 기록은 UUID·ledger 경로를 유지해 가져온다. 기존 고정 controller는 명시적 전환 때 공유 shell로 등록한다. controller가 이미 닫혔으면 기존 identity를 종료 상태로 보존하고 새 terminal 추가를 허용한다. 이전 core가 살아 있으면 전환을 거부하며 실행 중인 Action을 중단해 전환하지 않는다. 새로운 관리 pane만 닫고 기존 terminal은 재생성·이동하지 않는다.
- 기존 단일 endpoint Broker ADR의 입력 authority는 이제 Broker별 core와 terminal의 단일 소유권으로 유지한다. 전역 1개 core가 모든 terminal을 관리하는 방식은 사용하지 않는다.

## 검증

번호 동시 할당·소진·재시작, 단일 소유권, 등록 전 전체 workspace 조회와 페이지·실패·이동·종료, 실행 없는 탐색, Parent 인계·전환과 실행 중 보류, headless core와 실제 PTY 관리 화면 수명, 기존 shell·SSH 보존, 외부 Herdr·non-TTY·위조 관리 권한 거부, 기존 JSON·Action·Receipt 회귀를 검증한다. 실제 agent가 목록과 맥락을 이용하는 시나리오는 선택 알고리즘을 고정하지 않고 호출·선택 근거를 검토한다. 전체 테스트·typecheck·build·code-review 뒤 로컬 commit하고 실제 Herdr에서 전환을 확인한다.

## 결과

- Node 24에서 전체 테스트 **250개 통과**, `tsc --noEmit`, build, project Skill validator 통과.
- 4개 process의 동시 번호 발급, 2개 process의 중복 소유 경쟁, 재시작·번호 소진·생성/탐색 race를 검증했다. 예약 뒤 다른 조회가 먼저 발급한 주소는 그대로 채택하고 예약 번호는 재사용하지 않는다.
- 공개 MCP를 통해 연결 전 전체 workspace·다른 tab·미등록/다른 Broker 소유 pane, 번호/이름 등록, 페이지·실패의 마지막 확인 시각, 이동·종료·교체, 연결 전환 보류를 검증했다.
- 별도 background process와 실제 PTY에서 56/27열, resize, 붙여넣기 보존, 정상 terminal 복원, 관리 화면 종료 뒤 shell·core 유지와 Parent 재접속을 검증했다. 기존 승인·Mode·Receipt·hold·외부 Herdr 거부 테스트도 통과했다.
- Standards·Spec 병렬 code-review의 지적을 수정하고 재검토했다. 잔여 지적은 각각 0건이다.
- 실제 Herdr에서 이전 controller와 Target이 이미 닫힌 것을 확인했다. 실행 중인 이전 core도 없었다. UUID `fda1cd6e-a7b3-4b17-8d2a-3b9766e567c3`와 기존 Receipt를 유지해 **Broker 1000**으로 전환했다. 기존 pane `w2:p7`과 tab `w2:t3`은 유지했다.
- 실제 Herdr Codex가 연결 전 workspace 조회 → 숫자 접속 → 공유 terminal **1008 · 공유** 생성/명명 → Mode 2의 `printf 'hello world\n'` 실행을 완료했다. 결과는 `accepted`, `completion_observed`, `exit 0`, hold 0개, Worker 미실행이다. 임시 관리 화면 `w2:pG`의 연결·번호·완료 상태를 확인했다.

- 두 번째 실제 시나리오에서 agent는 최신 목록의 `1003 · Codex`, `1008 · 공유`, `1009 · 관리`와 앞선 실행 identity를 확인했다. “아까 hello world를 출력한 공유 pane”, `100`이라는 지칭을 **1008**로 해석한 근거를 먼저 알리고 `shared-again`을 실행해 exit 0을 확인했다. 후보 선택 규칙을 코드나 테스트로 고정하지 않았다.
- 두 번째 관찰 Job은 완료 확인 후 `job_cancel` 응답에서 누적 Parent 예산 소진을 알렸으며 `job_ended: true`였다. 영속 Receipt의 완료·exit 0과 hold 0개는 유지됐다.
- 실제 임시 관리 화면을 Ctrl+C로 종료하고 이번 검증의 Codex Parent를 `/exit`로 종료했다. 관리 pane만 사라지고 `w2:p7`은 기존 shell PID `81012`로 돌아왔다. 공유 terminal `1008`의 `w2:pF` / `term_65b918c64c9f93b`와 tab은 그대로 유지됐다.
- 같은 `w2:p7`에서 새 Codex Parent를 시작해 **1000**으로 재접속했다. `1008`의 native identity와 ready 상태, `controller: null`, 기존 Receipt 3건 모두 `completion_observed / exit 0`, hold 0개를 확인했다. 조회 과정에서 Job·Worker·입력은 생성하지 않았다. 최종 사용 화면에는 같은 tab의 Codex와 공유 shell만 남겨 두었다.
