# Action 구현 계약

## 범위와 완료 조건

Issue #16–#21의 문서 기준은 Parent spec D8–D13이다. 공개 MCP의 제안·제출·상태 조회와 `serve`가 소유한 interactive console을 연결한다. SQLite intent와 한 번의 wire 시도, 독립된 제출/관찰 상태, session 변경 차단을 실제 protocol peer와 disposable shell에서 검증한다. SSH 실행은 #24의 실제 acceptance 전까지 비활성이다.

## 모듈과 상태

- `Jobs`는 연결 소유권, 목표, job 중지, Snapshot/Evidence와 전체 메모리·전달 예산을 소유한다.
- `Actions`는 Pane Session, 불변 Proposal, mode/revision, Approval, 제출 정책과 관찰 수명을 소유한다. 같은 binding의 다음 job은 mode만 공유하고 목표·예산을 공유하지 않는다.
- `Ledger`는 별도 WAL/FULL SQLite에 intent·소비·hold·receipt의 최소 Control State를 저장한다. authority의 EXCLUSIVE transaction과 수명을 혼합하지 않는다.
- `Herdr`는 passive process 정보와 exact mapping, 단일 `pane.send_input` 및 대응 ACK 분류를 소유한다. 지원 version의 enqueue 전 오류 외에는 접수 여부를 unknown으로 기록한다.

## 공개 입력과 사용자 확인

`job_start`의 선택적 Action scope는 협조적 local POSIX shell의 절대 cwd, 변경 가능한 절대 경로, 신뢰한 작업인지 여부를 명시한다. scope가 없으면 진단만 가능하다. Caller가 보낸 host/user 설명은 관찰한 process 정보와 구분한다. Broker는 파일 경로 선언의 범위와 Parent 판단 구조를 검사하며 임의 shell script의 의미적 안전성을 증명하지 않는다.

`action_propose`는 job ID, exact target, 같은 목표, execute/interrupt, command, cwd/env, 영향 경로와 Parent risk review를 받는다. env는 명시적인 키/값만 허용한다. Broker는 nonce와 wrapper, Enter까지 포함한 전송 payload를 생성해 immutable digest로 고정한다. `action_submit`은 proposal ID만 받는다.

mode 2의 자동 후보에는 확인한 효과와 입력, 영향 범위, 복구 방법, 불확실성, 고위험 범주가 필요하다. 형식 누락·불확실성·미확인 script·고위험 범주는 개별 승인을 요구한다. mode 3은 범위 안의 위험 불명·고위험에도 추가 승인을 삽입하지 않는다. 세 mode 모두 scope/target/session/revision/cancel/deadline/budget/hold 검사를 유지한다.

console의 `review <proposal>`는 JSON escaping으로 전체 payload와 대상·목표·위험·revision을 표시한다. 사용자가 확인한 현재 proposal만 `approve`할 수 있다. `mode <session> <1|2|3>`와 명시적 복구도 interactive TTY에서만 가능하다. stdin의 `isTTY` 주장만 믿지 않고 실제 TTY fd를 검사한다. pipe/RPC/CLI flag로 사용자 권한을 만들지 않는다. mode 변경은 revision을 올리고 이전 승인을 무효화한다. agent의 `session_lower_mode`는 하향 또는 중지만 적용한다.

## 제출과 관찰

승인 대기는 terminal을 점유하지 않는다. 제출 요청 시 terminal이 점유 중이면 입력 없이 대기 사유를 반환하며, 재요청 때 동일 proposal을 재검증한다. intent transaction에서 unique proposal, digest, revision, 승인 소비, 시각과 hold를 함께 기록한 후 wire를 한 번 시도한다. 반복 요청은 기존 receipt를 돌려주며 새 입력을 만들지 않는다.

wrapper는 `/bin/sh -c` 안에서 명시적 cwd/env와 명령을 실행하고, 종료 표식은 command 밖에서 출력한다. quote·달러·개행을 literal하게 보존하며 subshell의 상태가 다음 Action에 지속되지 않는다. 준비된 shell 이외의 foreground에서는 execute를 거부한다. 별도 interrupt는 원래 Action에 연결한 Ctrl-C만 지원한다.

제출 전 baseline과 nonce, 제출 이후 passive Snapshot을 연결한다. 독립된 완전한 종료 행 하나에서만 exit를 읽는다. echo·baseline의 표식·관찰된 중복은 완료로 채택하지 않는다. 잘린 history와 marker 관찰 여부는 별도다. nonce를 아는 출력의 위조는 완전히 막을 수 없으므로 비신뢰 scope에는 marker만으로 후속 자동 실행을 허용하지 않는다.

cancel/deadline/owner 종료는 미제출 작업과 Worker를 중지하며 Ctrl-C를 자동 전송하지 않는다. 이미 intent를 기록한 Action은 별도 60초 수명으로 결과를 관찰한다. interrupt ACK만으로 원래 결과·hold를 바꾸지 않는다. 관찰 실패·접수 불명은 hold를 보존한다.

## 복구·수명·검증

core restart는 dispatching을 unknown, 미정리 관찰을 outcome_unknown으로 복구한다. 본문이나 입력을 복원·재생하지 않는다. 초기 ledger 생성 표식과 기존 ledger 유실을 구분하고 저장 실패에는 입력을 보내지 않는다. unresolved hold는 시간으로 해제하지 않는다. resolved 기록은 7일 뒤 consumed ID tombstone으로 줄인다.

console 복구는 현재 exact shell을 다시 관찰하고 사용자가 새 목표를 명시해 확인한 경우에만 hold를 해제한다. 원래 unknown/exit null은 보존하고 복구 사유를 별도 기록한다. mode 변경은 hold를 해제하지 않는다.

제안 payload와 진단은 기존 메모리 예산/수명에 포함한다. purge는 pending payload를 지우되 consumed ID와 hold를 지우지 않는다. 일반 Action 3회와 interrupt 1회, 전달되는 payload 포함 Parent 16 KiB, job 300초를 적용한다.

검증은 공개 MCP/실제 TTY, 별도 Broker process·실제 SQLite의 commit/wire/ACK crash 지점, disposable Herdr shell의 quoting/비정상 exit/지연/이동을 사용한다. 실제 wire count, receipt, 원문 잔존 여부를 기록한다. 관찰되지 않은 remote 변경, check/send race, 외부 Herdr client 입력, disk power-failure 전체를 보장하지 않는다.
