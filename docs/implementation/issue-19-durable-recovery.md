# Issue 19: 재시작·응답 유실·저장 장애의 Control State

## 구현 전 계약

#17의 WAL/FULL intent, 소비한 ID와 terminal hold를 실제 process/storage 장애에 적용한다. 같은 canonical endpoint의 authority 한 개, 진단 메모리와 Control State의 분리, 자동 replay 0을 유지한다.

- 전송 전후 6개 crash 지점과 실제 commit 실패에 더해 ledger/identity/WAL의 유실·교체·권한 변경, 같은 endpoint의 두 번째 core와 authority 상실을 검증한다. 불명확한 저장 상태에서 새 ledger를 만들거나 입력을 보내지 않는다.
- 최초 ACK 기한이 끝나면 submission unknown을 즉시 기록한다. 제출 뒤 제한된 관찰 시간 안에 늦은 대응 ACK를 받으면 제출 사실만 보완한다. marker·exit·hold의 판정은 별도이며 부분 payload나 Enter를 보충하지 않는다.
- unknown terminal hold는 새 proposal/job/owner와 재시작을 넘어 유지한다. 일반 입력은 하나만 진행하고 승인 대기는 hold를 만들지 않는다.
- owner 종료 뒤 미제출 작업과 Worker는 중지한다. 제출된 Action은 core가 살아 있는 동안 별도 기한 안에서 passive 관찰을 계속한다. 새 연결은 이전 본문을 받을 수 없다.
- 명시적 purge는 pending payload·Snapshot·report·Evidence를 지우지만 Control State를 지우지 않는다. 해결된 기록만 7일 뒤 식별 tombstone으로 줄이며 미확정 hold와 소비한 ID는 자동 만료하지 않는다.
- console에는 raw command·원문·Evidence quote를 출력하지 않는다. crash 위치, 실제 wire count, 독립된 두 상태와 보류 이유를 재현 결과로 남긴다.
- console의 receipt/held terminal 목록은 각각 최근 32개로 제한하고 전체 Control State·소비한 ID·hold 수를 별도로 표시한다. 본문 purge와 7일 축약이 미확정 hold를 지우지 않았는지 이 수치와 재시작 결과로 확인한다.
- SQLite transaction마다 증가하는 generation을 별도 identity 파일에 fsync해 기록한다. 입력은 intent와 이 기록이 모두 저장된 뒤에만 보낸다. 재시작 때 SQLite generation이 기록보다 과거이면 WAL 잘림·유실로 보고 중지한다. 최초 Herdr 확인 실패에도 빈 ledger 초기화를 정상 종료해 이후 재시도가 가능하게 한다. ACK 기한은 일부 응답 bytes와 무관한 절대 5초다.

## 확인 범위

공개 MCP/실제 console, 별도 Node 24 Broker process, 실제 SQLite 파일과 Unix protocol peer를 사용한다. 늦은 ACK·partial 입력 가능성은 protocol fault이며 실제 remote exactly-once나 모든 power-failure에 대한 보장으로 표현하지 않는다. Broker 밖의 Herdr client 입력은 이 queue의 통제를 받지 않는다. 명시적 사용자 복구와 interrupt는 #20에서 연결한다.

## 검증 결과

`test/recovery.test.mjs` 23개와 전체 144개 테스트가 통과했다. SQLite·실제 Broker crash 검증은 기존 `test/execution.test.mjs`의 6개 SIGKILL 지점과 함께 다시 실행했다. 두 축 code-review의 3건씩을 수정한 뒤 Standards 0건, Spec 0건을 확인했다.

| 재현 | 입력과 복구 결과 |
| --- | --- |
| 초기 5초 ACK timeout 뒤 5.2초의 대응 ACK | 최초 unknown, 후속 accepted/observing, exit null, hold 유지, 입력 1회 |
| 잘못된 JSON/request ID, 모호한 오류, partial reply | unknown/outcome_unknown, 새 job도 held, 입력 1회·자동 보충 0 |
| owner 연결 종료 | core 생존, 원래 Action의 exit 0 관찰, 새 owner의 기존 job 접근 거부 |
| DB/identity/WAL/SHM 유실, identity 변경, WAL 권한 변경, DB header 손상 | 제출 전 오류, 입력 0 |
| ledger와 identity 동시 유실 | 기존 authority를 근거로 새 ledger 초기화 거부, restart 입력 0 |
| ACK 기록 후 실제 SIGKILL·WAL 유실 또는 0-byte 잘림 | dirty 표식과 generation으로 과거 DB 재사용 거부, 원래 입력 1회·restart 0 |
| 최초 unsupported Herdr 수정 뒤 재시작 | 두 번째 기동 성공, 입력 0 |
| 1초에 ACK 일부, 5.2초에 나머지 도착 | 5초 unknown, 후속 accepted·exit null·hold 유지 |
| 실제 두 core 및 authority 유실 | rival busy, live socket 보존, authority 상실 후 입력 0 |
| purge·7일 직전/직후·restart | 해결된 receipt 1개 축약, consumed ID 2개와 unknown hold 1개 보존 |
| 40개 terminal hold | 40개 보존, console에는 32개와 전체 개수/잘림 표시 |

새 authority에서만 ledger를 처음 만들며, 정상 종료 뒤 SQLite close와 fsync한 clean 표식을 남긴다. dirty 재시작은 WAL이 없거나 SQLite generation이 별도 저장 기록보다 이전이면 중지한다. 이전 개발용 identity 형식은 정상 종료와 WAL 유실을 구별할 근거가 없으므로 자동으로 신뢰하거나 빈 상태로 승격하지 않는다. 장애를 만든 파일은 테스트가 소유한 임시 상태뿐이며 사용자 원문·command를 persistent Control State에 추가하지 않았다.

외부 Herdr client의 queue 독립성은 [직접 adapter 계약의 기존 실험](https://github.com/dwchoo/herdr-broker/blob/13fc41842d871293a7e5109d533388fb4f8f2ffc/prototypes/mvp-validation/RUNTIME-REPORT.md)과도 일치한다. 본 ticket의 제품 검증 결과와 해당 prototype 근거를 구분한다. 파일 전체의 동시 유실과 모든 in-place bit corruption, disk power-failure를 빠짐없이 탐지한다는 보장은 하지 않는다.
