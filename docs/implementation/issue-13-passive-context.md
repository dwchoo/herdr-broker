# Issue 13: bounded pane context 구현

## 범위와 완료 조건

[Issue 13](https://github.com/dwchoo/herdr-broker/issues/13)의 첫 수직 흐름을 구현한다. 사용자가 실행한 단일 Broker에 Codex Parent가 MCP로 연결해 exact Target Pane의 작은 `prepared_context`를 얻는다. Worker와 Action은 후속 ticket의 범위다. 이 단계에서는 pane 입력 method를 제공하지 않는다.

기존 사용자 파일은 보존하고 이번에 추가한 파일만 commit한다. 검토 기준은 시작 commit `9077da550f8dc2055af839b42b7334fdc29bc9ad`이며, commit 전 staging diff로 Standards와 Spec을 각각 검토한다.

## 실행 구조

- Node 24와 TypeScript compiled ESM CLI를 사용한다. runtime dependency는 `@modelcontextprotocol/server@2.0.0`, `zod@4.6.5`, `better-sqlite3@13.0.3`으로 고정하고 lockfile integrity를 보존한다.
- `serve`는 canonical Herdr socket 경로에서 결정되는 state directory와 SQLite exclusive transaction을 소유한다. `mcp`는 이미 실행 중인 core에 stdio를 연결한다. MCP마다 core를 만들지 않는다.
- core는 연결마다 consumer identity를 만들고 job의 exact pane, objective, Pane Session, 예산을 결합한다. 연결 종료는 해당 연결의 활성 job을 취소한다.
- Herdr 0.9.0/protocol 22의 JSON socket에서 identity 조회와 명시적인 `recent`/`ansi` snapshot만 사용한다. 응답 ID, shape, version, wire 크기를 검사한다.
- Snapshot은 1,000 physical rows와 64 KiB로 제한한다. 정규화·redaction 후 불변 row Evidence ID를 발급하고 연속 중복만 접는다. 관찰하지 못한 history와 잘린 범위를 표시한다.
- 전처리한 row 표현이 4 KiB 이하인 `analysis=auto`만 직접 전달한다. 초과와 명시적인 Worker 요청은 `worker_unsupported`로 끝내며 원문을 대체 전달하지 않는다.
- job은 기본 300초, wait는 최대 20초다. Parent 응답 본문은 반복 전달까지 16 KiB로 제한하고 마지막 안내 공간을 예약한다. MCP framing 자체는 이 본문 예산에 포함하지 않는다. 분석 결과 준비, job 종료, Action 완료는 별도 상태다.
- 종료한 job의 redacted 진단 데이터는 30분 후 제거한다. 64 MiB의 보존 데이터 예산에는 job metadata 여유분을 포함하며 오래된 종료 job부터 제거한다.

## 검증 순서

사용자가 이미 확인한 검증 경계는 공개 MCP tools와 사용자 console이다. crash·복구는 실제 process와 SQLite, Herdr는 socket protocol peer와 실제 disposable pane으로 보강한다. 내부 helper의 구현을 그대로 따라 쓰는 test는 만들지 않는다.

1. 문서와 package 설정 → Node 24에서 설치와 typecheck 확인.
2. MCP handshake와 exact pane 관찰 → 하나의 실패 test부터 최소 구현 후 통과.
3. Snapshot 경계·redaction·routing → 공개 결과와 wire 요청을 검증하며 수직으로 확장.
4. 연결 소유권·deadline·cancel·payload·retention → 공개 MCP 결과로 검증. 시간과 외부 socket은 test에서 제어한다.
5. 실제 process의 authority·권한·console → 두 번째 core 거부와 crash 후 재기동 확인.
6. compiled package를 별도 디렉터리에 설치 → 실제 Codex와 새 disposable Herdr pane으로 다섯 tool 호출 확인.
7. 전체 검증 및 두 축 code-review → 필요한 수정과 재검증 → 선택적 staging과 현재 branch commit.

## 검증 기록

구현 후 실제 명령, runtime version, 결과와 남은 한계를 이 절에 기록한다.

### 개발 명령

Node 24를 PATH에 두고 `npm ci`, `npm run typecheck`, `npm run build`를 실행한다. 공개 MCP test는 `node --test test/mcp.test.mjs`, authority test는 `node --test test/authority.test.mjs`, 실제 process test는 `node --test test/process.test.mjs`다. 전체 검증은 `npm test`를 사용한다.

관찰 fixture는 실제 Unix socket peer이며 제품 adapter의 모든 method를 기록한다. Job의 deadline·retention test는 app 구성 시 clock을 주입한다. 메모리 초과 test는 app 구성 시 제한을 낮추며 제품 CLI에는 이 설정을 노출하지 않는다. process fixture도 test 파일에만 존재하고 package에 포함하지 않는다.

64 MiB는 보존한 진단 데이터의 보수적 회계 상한이다. job당 metadata·objective 여유분 16 KiB, redacted 문자열의 UTF-16 공간과 row별 여유분을 계산한다. Node/SDK/native library의 process RSS 전체를 64 MiB로 제한한다는 뜻은 아니다. 동시에 처리하는 관찰은 최대 4개, MCP 연결은 최대 32개로 제한한다.

### 실행 검증 중 확인한 사항

- Node `v24.19.0`, macOS `darwin/arm64`, SQLite `3.53.4`에서 compiled package의 실행과 native binding을 확인했다.
- 배포 tarball에도 transitive dependency integrity가 포함되도록 `npm-shrinkwrap.json`을 사용한다. package에는 compiled JS, package metadata·shrinkwrap, 사용 문서만 포함하고 test fixture와 source TypeScript는 제외한다.
- 실제 Codex `0.154.0`의 `initialize`, `notifications/initialized`, `tools/list`를 stdio trace로 확인했다. 첫 호출은 CLI의 `never` 승인 정책으로 거부돼 호출 완료로 계산하지 않았다. 조회 tool과 job 생성·취소의 annotations를 구분하고 상태 변경 승인은 review하도록 구성해 재검증한다.
- 사용자 파일·Codex MCP config를 바꾸지 않는다. synthetic 출력과 stdin byte 계측기를 새 disposable pane에 준비하고, 계측기 준비 후의 관찰 동안 입력이 없는지 확인한다. 준비용 입력은 Broker 관찰 호출과 분리한다.

### 실제 Codex acceptance 결과

2026-09-15, 설치한 package의 `mcp` facade를 실제 Codex `0.154.0`이 실행했다. `initialize`·`tools/list` 이후 `pane_describe` → `job_start` → `job_status` → `job_wait` → `job_cancel`이 모두 성공했다. 확인 가능한 응답과 method trace는 [acceptance 기록](issue-13-acceptance.json)에 저장했다.

- Target: 이번 검증에서 새로 만든 `w5:p1` (`w5`, `w5:t1`, `term_65b8093fdbf236`). 기존 pane은 사용하지 않았다.
- `prepared_context`에 실패·unknown detail·상충하는 성공 row가 모두 남았다. 결과 준비 시 `job_ended=false`, 취소 후 `job_ended=true`, Action은 계속 `unsupported`였다.
- job 응답의 실제 누적 본문은 4,168 bytes였다. API의 누적 usage와 실제 JSON text byte 합계가 일치했다.
- fixture가 raw stdin을 읽어 파일에 누적한 입력은 준비 완료 이후 **0 bytes**였다. 실제 판정은 Codex의 성공 서술과 별도로 tool 응답과 계측 파일을 검사했다.
- CLI의 일회성 설정으로 `approval_policy=on-request`, `approvals_reviewer=auto_review`, 서버 `default_tools_approval_mode=writes`를 사용했다. 상태 변경 tool을 read-only로 바꾸거나 사용자 config에 승인을 저장하지 않았다.

### Code-review에서 보강하는 경계

- JSON/YAML처럼 credential key가 따옴표로 둘러싸인 로그와 escaped quote가 있는 value도 기본 redaction에 포함한다.
- 비동기 대기 중 authority 파일이 유실되면 각 Herdr 요청의 전후와 Parent 응답 발행 직전에 소유권을 재확인한다. 이미 대기하던 요청도 새 관찰이나 prepared context 발행으로 이어지지 않아야 한다.
- 예산의 `used`와 `remaining` 자릿수가 동시에 변할 때도 실제 JSON text 길이와 공개 usage가 일치하도록 직렬화한 본문을 기준으로 계측한다. 필요한 경우 JSON 뒤의 공백까지 byte 예산에 포함한다.

### 최종 검증과 검토

`npm ci`로 shrinkwrap 재설치 후 Node 24에서 `npm run typecheck`와 `npm test`를 실행했다. 전체 **14 tests 통과, 실패 0**이다. 최종 코드를 다시 pack/install한 뒤 실제 Codex의 다섯 tool 호출과 입력 **0 bytes**도 재확인했다. 설치된 bin의 `--version`이 성공했고, 임의 `--state-dir` 인자는 거부됐다.

#### Standards

Authority 소실 중 비동기 결과가 발행될 수 있다는 finding 1건을 수정했다. 요청 생성·전송·응답 처리와 Parent 전달 직전에 소유권을 확인한다. 공개 MCP 회귀 test가 소실 뒤 capture 0건과 `authority_lost`를 확인한다. 검토자의 재검토 후 잔여 finding은 0건이다.

#### Spec

Quoted credential 누락과 usage 자릿수 경계 오차, 총 2건을 수정했다. JSON/YAML 및 escaped value와 예산 1,400–1,450 bytes의 공개 경계 test를 추가했다. 실제 전달 text와 `used`·`remaining`이 일치한다. 검토자의 재검토 후 잔여 finding은 0건이다.

기존 README·Markdown·skills 등 132개 파일은 시작 시 SHA-256과 일치했다. `docs/.DS_Store`의 외부 metadata 변경은 수정하거나 staging하지 않았다. 이번 구현에서 새로 추가한 파일만 commit 대상으로 삼는다.
