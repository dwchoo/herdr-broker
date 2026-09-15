# Issue 17: 승인한 local shell 입력의 단일 제출

## 구현 전 계약

[Action 구현 계약](action-lifecycle.md)의 제출·관찰·최소 복구를 연결한다. 최초 wire부터 mode 1 사용자 승인과 WAL/FULL intent·Approval 소비·terminal hold를 함께 적용한다. mode 2/3의 자동 실행은 #18, SSH 실행은 #24에서 검증 후 활성화한다.

- `action_submit`은 proposal ID만 받고 저장한 payload를 사용한다. exact target/session/revision/허용 근거, job 중지·deadline·입력 예산을 직전에 확인한다.
- 하나의 terminal에 일반 Action 하나만 진행한다. 점유 중에는 입력 없이 사유를 반환하고 재요청 시 다시 검사한다. 같은 proposal의 동시/반복 요청은 동일 receipt와 wire 한 번이다.
- 별도 ledger 파일의 초기화 식별자와 DB를 함께 검증한다. 기존 DB 유실·손상·inode 교체에는 빈 ledger를 만들지 않는다. 실제 intent transaction과 최초 Approval 소비·hold commit 전에 전송하지 않는다.
- 전체 payload의 전송 bytes도 job의 Parent 예산에 합산한다. 일반 입력은 job당 세 번이며 verified rejection도 소모한다. 같은 receipt 재조회는 입력 횟수를 소모하지 않고 응답 bytes만 합산한다.
- 직접 `pane.send_input`의 대응 ok만 accepted, 검증한 enqueue 전 오류만 rejected, 나머지는 unknown이다. 일부분이나 Enter를 추가 전송하지 않는다.
- 제출 전에 passive baseline을 확보한다. 현재 nonce의 독립적인 종료 행과 exit status 하나만 관찰하며 echo/stale/중복은 제외한다. ACK 직후는 관찰 중이고, 완료를 관찰하기 전 exit는 null이다.
- 관찰은 제출 후 별도 60초다. job cancel/deadline/owner 종료 뒤에도 제한된 관찰을 유지하고 추가 Worker·입력은 시작하지 않는다. core 종료 시 정리되지 않은 관찰은 재기동 뒤 unknown/hold다.
- 접수와 관찰 상태는 독립적이다. unknown+completion_observed를 지원하되 ACK를 꾸며 기록하지 않는다. 이미 관찰한 exit 외에는 null을 유지한다. marker는 위조 불가능한 증거가 아니다.
- execute의 command/cwd/env에 terminal이 직접 해석할 수 있는 C0/C1 제어 문자를 넣는 것은 거부한다(LF는 shell quoting으로 유지). Ctrl-C는 별도 interrupt operation의 후속 경로를 사용하며, 일반 command에 숨겨 제어 입력 예산을 우회하지 않는다.
- 원문·payload·관찰 Evidence는 job 메모리에 보존하고, ledger에는 opaque 식별자·digest·revision·승인 소비·두 상태·시각·hold 이유만 남긴다. purge가 consumed ID와 hold를 지우지 않는다.

## 완료 증거

공개 MCP → 실제 TTY 승인 → disposable local Herdr shell → receipt/Evidence를 실행한다. 실제 shell quoting/cwd/env/exit 0·7/지연과 protocol peer의 ACK 유실·거부·partial write 가능성·중복 marker를 구분한다. 실제 SQLite의 commit 전후 crash와 restart wire count 0을 검증한다. 전체 장애 행렬과 7일 운영 수명은 #19에서 확장한다.

- Node 24.19.0에서 최종 전체 suite 108개가 통과했다. review 수정 후 실행 경로 33개와 실제 local acceptance도 다시 통과했다. Standards·Spec 재검토의 잔여 finding은 각각 0개다.
- 실제 SQLite write lock으로 intent commit 실패를 만들었으며 input 0과 Approval 유지, lock 해제 후 한 번의 제출을 확인했다.
- 6개 실제 Broker SIGKILL 지점에서 commit 전 input 0, commit 뒤 restart의 unknown/hold, 기존 ID와 새 job/proposal 모두 자동 replay 0을 확인했다.
- 실제 Herdr 0.9.0/protocol 22에서 직접 만든 workspace만 대상으로 3개 입력을 보냈다. literal quote/dollar/env, cwd, exit 0·7, 지연 관찰과 parent shell cwd 비지속성이 통과했다. workspace는 종료했다. [실행 기록](issue-17-local-acceptance.json)에 최초 receipt와 관찰 receipt, 실제 출력, Evidence를 남겼다.
- ACK 유실 후 `unknown+completion_observed`, marker 누락/echo/중복/partial fixture의 `accepted+outcome_unknown`, 제출 후 cancel의 자동 Ctrl-C 0을 확인했다. partial fixture는 가능한 관찰 실패를 재현하며 OS가 실제로 일부 bytes를 전송했다는 주장과 구분한다.
- code-review에서 발견한 socket 연결 대기 중 철회/revision 변경, marker 없는 관찰의 truncation 누락, byte crop으로 잘린 첫 행의 잘못된 완료 판정, custom redaction 전후 row index 불일치를 재현하고 수정했다. 실제 write 직전 승인·job·revision·ledger를 검사하며, 하나의 redacted Snapshot에서 완전한 행과 Evidence를 연결한다. console status에는 Evidence 원문을 포함하지 않는다.
