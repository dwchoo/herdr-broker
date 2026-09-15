# Issue 14: 반복 관찰과 Evidence

## 범위와 기준

[Issue 14](https://github.com/dwchoo/herdr-broker/issues/14)의 공개 MCP·사용자 console 동작을 구현한다. 기준 commit은 `c03fb430da2085ffe295b53b6f0399081d027562`다. 기존 사용자 변경은 보존하고 이번 issue의 수정만 검토·commit한다. Worker·Action은 후속 ticket이며 기존 passive Herdr 계약과 Node 24 dependency pin을 유지한다.

검증 경계는 앞서 사용자가 확인한 공개 MCP tools와 console이다. 실제 core·SQLite와 Herdr socket peer를 사용하고, clock·외부 응답을 제어해 만료·동시 요청을 재현한다. 내부 helper를 그대로 따라 쓰는 test는 추가하지 않는다.

## 공개 계약

| Interface | 동작 |
| --- | --- |
| `job_status(job_id, cursor?)` | 보존된 현재 view를 예산 안에서 조회한다. 새 관찰을 시작하지 않는다. |
| `job_wait(job_id, wait_ms?, cursor?)` | 현재 view의 cursor를 제시하면 같은 job에서 passive 관찰을 시작한다. 진행 중이면 같은 관찰을 기다린다. cursor 없는 재요청과 이전 view의 재전송은 현재 Snapshot을 재사용한다. |
| `evidence_get(job_id, evidence_id, offset_bytes?)` | 해당 job이 발급한 불변 row ID를 redacted 원문에 해석한다. UTF-8을 보존한 제한된 발췌와 다음 위치를 제공한다. caller quote·파일 경로는 허용하지 않는다. |
| console `purge <job_id>` / `purge all` | 진단 본문과 cursor를 제거하고 해당 job의 추가 관찰을 중지한다. 사용한 예산과 발급한 ID의 최소 만료 기록은 유지한다. |
| console `status` | 본문을 출력하지 않고 보존·만료·purge·메모리·예산 상태를 보여준다. |

## Cursor와 Snapshot

- cursor는 Broker가 발급하며 consumer·job·Pane Session·source·redaction version에 결합한다. 다른 job이나 연결의 cursor를 baseline으로 인정하지 않는다.
- 전달 자체를 수신 확인으로 취급하지 않는다. caller가 제시한 유효 cursor의 digest와 현재 view가 같을 때만 `unchanged_view`를 반환한다. 그 외에는 bounded `replace`와 현재 cursor를 반환한다.
- cursor의 초기 유효 기간은 발급 후 60초다. 만료된 baseline은 인정하지 않고 Snapshot이 남아 있으면 같은 불변 ID의 replacement와 새 cursor를 제공한다. job 종료 뒤에는 새 관찰을 시작하지 않는다.
- view digest는 redacted rows, 관찰 범위·누락 정보, source·format과 redaction 규칙을 포함한다. title과 Herdr revision은 output cursor가 아니다. `unchanged_view`는 중간 출력 부재나 전체 history의 동일성을 뜻하지 않는다.
- 출력이나 관찰 문맥이 바뀌면 새 Snapshot을 만들고 이전 Evidence는 원래 Snapshot에 남긴다. 같은 view를 다시 전달할 때는 ID를 바꾸지 않는다. 실제 재관찰 시각·순번은 불변 Snapshot의 생성 시각과 구분한다.
- 새 session·관찰 metadata는 Snapshot 확보와 함께 반영한다. 실패한 재관찰은 이전 Snapshot을 새 결과나 `unchanged_view`로 공개하지 않으며, 과거 Evidence는 원래 ID로 계속 조회할 수 있다.
- terminal/workspace/tab의 관찰 가능한 identity 변경은 새 Pane Session으로 구분한다. 한 번의 capture 도중 identity가 바뀌면 기존처럼 실패한다. SSH 문맥의 완전한 연속성 판정은 후속 session ticket의 범위다.

## Evidence와 데이터 수명

- 초기 Evidence 블록과 추가 조회의 발췌는 각각 최대 2 KiB다. metadata까지 포함해 보수적으로 제한하고, 남은 행 ID·byte offset·잘림을 함께 알린다. 하나의 큰 행도 이어서 조회할 수 있다.
- JSON escaping으로 context와 초기 Evidence의 합계가 응답 상한을 넘으면 초기 발췌를 비우고 첫 row의 `next`를 제공한다. 별도 Evidence 조회가 가능하도록 지원 대상 context를 우선 전달한다. 이를 반영한 응답도 남은 예산을 넘으면 기존 예산 종료 규칙을 적용한다.
- D13에 따라 먼저 도달한 상한을 적용한다. 4 KiB는 routing 기준이고, JSON escaping·metadata를 포함한 정상 응답은 별도로 8 KiB 이하이다. 발췌를 제외해도 응답 상한을 넘으면 누적 16 KiB에 여유가 있어도 `parent_budget_exhausted`로 종료한다. 남은 예산을 이미 사용한 것으로 계산하지 않는다.
- Snapshot은 생성 후 수정하지 않는다. `evidence_get`은 저장한 row만 읽고 새 pane capture로 과거 ID를 대체하지 않는다.
- 최초 context·Evidence·반복 조회·소유한 job의 오류 안내를 모두 기존 16 KiB Parent 예산에 합산한다. 마지막 안내 공간을 예약하며 cursor·purge가 예산을 초기화하지 않는다.
- 소유한 job ID가 있는 잘못된 tool 인자도 `invalid_tool_arguments`로 예산에 합산한다. 공개 JSON Schema의 strict 제약은 유지하고, validation 결과를 handler로 전달해 SDK의 무제한 오류 본문 대신 제한된 오류를 반환한다. 소유권 확인에 실패한 요청은 다른 job의 예산에 접근하지 않는다.
- 종료 후 30분·명시적 purge·core 종료 시 진단 본문을 제거한다. 같은 core의 발급 기록으로 만료 ID와 미발급 ID를 구분한다. 다른 연결의 job 접근은 존재 여부를 노출하지 않는 소유권 오류로 처리한다.
- 64 MiB에는 활성 Snapshot과 최소 만료 기록을 함께 계산한다. 압박 시 오래된 종료 job의 본문부터 제거한다. 활성 데이터 또는 남겨야 할 최소 기록 때문에 공간이 없으면 추가 처리를 거부한다. ID를 재사용하지 않는다.
- purge는 진행 중인 관찰도 중지하고 해당 job을 종료한다. 이후 status는 본문 없는 상태와 남은 예산을 반환하며 Evidence는 만료로 응답한다. 취소·purge 전에 이미 전달된 데이터를 회수한다고 표현하지 않는다.

## 실행과 완료 조건

1. Evidence 조회 한 흐름을 실패 test부터 구현하고, UTF-8·발췌 크기·소유권으로 확장한다.
2. cursor 수신 확인·재관찰·재전송·context 변경을 공개 MCP test로 검증한다.
3. console purge·30분 만료·메모리 압박·동시 요청에서 원문 제거와 예산 보존을 검증한다.
4. Node 24 typecheck와 관련 test를 반복하고 마지막에 전체 suite를 실행한다.
5. Standards·Spec 두 축 code-review, 필요한 수정과 재검증 후 현재 branch에 commit한다.

개발 명령은 `npm run typecheck`, `npm run build`, `node --test test/evidence-delta.test.mjs`, `node --test test/process.test.mjs`, 최종 `npm test`다. 구현 후 검증 결과를 아래에 기록한다.

## 검증 결과

- 실행 환경: Node 24.19.0, macOS arm64. 기존 dependency pin을 유지했다.
- `npm run typecheck`와 `npm test`의 26개 test가 통과했다. 이후 문서 명확화와 함께 추가한 4,096-byte 경계 test를 포함해 `test/evidence-delta.test.mjs` 13개를 다시 검증했다. 현재 총 27개 test가 검증 범위에 포함된다.
- 추가한 공개 MCP·console test 13개가 Evidence의 불변성·UTF-8 연속 조회·2 KiB 상한, 두 연결·두 job의 격리, cursor 수신 확인·60초 만료·context 변경, 동시 관찰, purge·30분 만료·메모리 압박·실패한 재관찰·JSON escaping 경계를 검증한다.
- 실제 전달 JSON text byte를 누적한 값과 보고한 usage가 일치하며, 잘못된 tool 인자와 purge 뒤 오류까지 16 KiB 한도를 공유한다. 마지막 안내 뒤에는 추가 text를 전달하지 않는다.
- 실제 core/facade process와 SDK client로 Evidence를 조회하고, facade 종료 후 core 유지 및 core crash/restart 후 과거 job 접근 거부를 확인했다.
- 이번 검증의 pane 출력은 실제 Unix socket의 제어 가능한 Herdr peer가 제공한다. 실제 Codex·Herdr 제품 연결 검증은 [#13의 acceptance 기록](issue-13-passive-context.md)을 기준으로 하며, #14에서 제품 환경 전체를 재실행했다고 간주하지 않는다.
- `npm pack --dry-run`의 build와 package 구성을 확인했다. dependency·설치 경로·CLI entrypoint는 유지했다.

## Code review

### Standards

Snapshot 보존 실패 때 새 Pane Session 정보가 이전 Snapshot과 섞이는 문제 1건을 수정했다. 관찰 metadata의 반영을 Snapshot 보존 성공 뒤로 옮겼고, 실패 응답에서 이전 view를 새 결과로 공개하지 않는다. 회귀 test와 재검토 후 잔여 finding은 0건이다.

### Spec

초기 Evidence가 전체 응답을 넘겨 작은 context를 조기에 거부하는 문제 1건을 수정했다. 필요하면 발췌를 비우고 `next`를 제공한다. 4 KiB routing 기준과 8 KiB 응답 한도는 D13의 상한 우선 규칙에 따라 독립적으로 적용하며, 정확한 경계와 제한된 종료 안내를 추가 검증했다. 재검토 후 잔여 finding은 0건이다.
