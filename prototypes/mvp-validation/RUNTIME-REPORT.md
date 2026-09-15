# Worker와 Herdr runtime 검증 결과

2026-09-15, macOS arm64. Codex CLI 0.154.0, Node 26.5.0, live Herdr 0.9.0 / protocol 22. 합성 데이터와 새 disposable workspace만 사용했다. 두 Herdr workspace는 생성 때 받은 ID로 닫았다. 제품 구현의 acceptance 결과가 아니다.

## Codex Worker

| 관찰 | 근거와 판정 |
| --- | --- |
| 기존 인증 | credential 본문을 읽거나 복사하지 않고 ChatGPT 로그인 상태와 실제 구조화 응답을 확인했다. |
| 모델 | `model/list`에서 `gpt-5.6-luna`, `gpt-5.6-sol`의 `low` 지원을 확인했다. CLI JSONL은 provider가 실제 사용한 model ID를 제공하지 않는다. 요청 model과 관찰 model을 같은 값으로 채우지 않는다. |
| 옵션 위치 | 최초 실행에서 exec 앞의 `-c` provider·저장 경로 override가 적용되지 않았다. exec 뒤로 옮긴 뒤 localhost request와 지정 state directory를 관찰했다. feature flag와 config flag를 같은 방식으로 취급하지 않는다. 수정 전 입력도 합성 오류 한 줄뿐이었다. |
| 실제 tool 목록 | local fake provider + 알려진 `gpt-5.6-luna` metadata에서는 Responses request의 `tools: []`. 강제로 반환한 `exec_command`는 `unsupported call`로 거부됐다. 알려지지 않은 model fallback에서는 `request_user_input`이 남았다. 임의 model 허용은 하지 않는다. |
| 설정의 한계 | `skip_host_skill_discovery`는 개발 중 feature이고 Code Mode host 차단 경고가 발생했다. 이 조합은 고정 version의 실험 결과다. 정식으로 안정된 전용 Worker API라고 해석하지 않는다. version·profile 변경 때 capability probe를 다시 수행하고 알려지지 않은 오류는 실행을 막는다. |
| 실제 injection 입력 | 합성 파일 읽기와 socket 접속 지시를 로그에 넣었다. 보고는 TS2305 진단과 제공된 Evidence ID를 유지했다. canary는 보고에 없었고 socket connection은 0이었다. syscall 전체 감사나 동일 OS 사용자 hard isolation을 증명한 것은 아니다. |
| 결과 수집 | 실제 응답은 JSONL `turn.completed`, exit 0, 별도 report validator를 통과했다. 8,130 input tokens, 325 output tokens, 약 14초였다. |
| 잘못된 출력 | fake provider가 `{"not_a_report":true}`를 반환해도 CLI는 exit 0과 `turn.completed`를 냈다. Broker validator는 필수 field 누락과 알 수 없는 Evidence ID를 거부했다. schema와 사실 검증은 별도다. |
| 중단 | 응답을 멈춘 fake provider에서 deadline과 명시적 cancel을 각각 8초에 주입했다. SIGTERM 종료, 완료 event·최종 파일 없음, 해당 process group 잔존 없음. provider 측 생성 중단이나 이미 실행된 외부 작업의 취소는 증명하지 않는다. |
| 기록 | ephemeral·history none·features disabled에도 별도 state directory에 SQLite DB/WAL이 생겼다. final JSON 파일은 실험이 명시적으로 요청했다. host directory metadata 비교는 다른 Codex 작업과 겹치므로 귀속할 수 없다. DB 본문이나 credential은 열지 않았다. 전체 로컬·provider no-store는 보장할 수 없다. |

원자료: [model catalog](results/model-catalog.json), [tool inventory와 강제 호출](results/provider-forced-tool.json), [실제 Worker](results/worker-live.json), [잘못된 결과](results/provider-malformed.json), [deadline](results/provider-hang.json), [cancel](results/provider-cancel.json), [validator·복구 fixture](results/faults.json).

### 채택

고정 CLI와 allowlist model의 broker-fed Worker는 다음 spec의 출발점으로 쓸 수 있다. 임의 tool/provider 설정을 Parent 입력으로 받지 않는다. `-c`는 exec subcommand 뒤에 두며 stdin, read-only sandbox, approval never, ephemeral, 제한된 subprocess와 report validator를 함께 사용한다. `--ignore-rules`나 sandbox bypass는 사용하지 않는다. 실제 provider request와 fake provider의 동일성을 모든 배포에서 보장했다고 주장하지 않는다.

## Herdr Action

| 관찰 | 판정 |
| --- | --- |
| `/bin/sh -c` envelope | 새 local shell에서 cwd·exported environment 상속, quote·`$HOME`·`$(...)`의 literal 전달, exit 0/7 관찰을 확인했다. subshell의 `cd`는 다음 Action에 남지 않았다. |
| ACK와 완료 | raw socket의 matching `id` + `result.type: ok` 직후 완료 marker는 없었고 약 1초 뒤 나타났다. CLI `pane run`은 성공 ACK 본문을 출력하지 않는다. |
| passive read | `pane.read`의 `format: ansi`, `source: recent`로 `result.read` metadata를 받았다. revision은 0. 1,300행 출력에서 최대 1,000행을 반환했다. |
| 출력 누락 | BEGIN은 없어졌지만 고유 END와 exit 0은 남았다. 완료 관찰과 불완전한 출력 범위는 동시에 기록해야 한다. 전체 history라고 표시할 수 없다. |
| 완료 위조 | payload가 현재 nonce의 END/0을 먼저 출력하면 단순 parser는 약 0.2초에 완료로 오판했다. 실제 END/9까지 관찰한 뒤에는 중복 marker로 불명을 알 수 있었다. 늦게 재검사하는 것만으로 모든 위조를 막을 수 없다. |
| 오류 | live `invalid_key`와 닫힌 pane의 `pane_not_found`를 확인했다. `pane_send_failed`, partial PTY write, 실제 연결 단절은 live로 유발하지 않았다. 해당 분류는 pinned source와 fault fixture 근거다. |
| 중복 ID | 같은 socket request ID로 두 번 제출한 명령이 파일에 두 번 기록됐다. Herdr request ID는 idempotency key가 아니다. |
| ACK 유실 | live 전송 후 harness가 응답을 버리는 fault를 넣었다. 명령은 1회 실행됐지만 receipt는 unknown이며 재전송하지 않았다. 실제 네트워크 장애를 재현한 것은 아니다. |
| 입력 직렬화 | 기존 명령이 sleep 중일 때 별도 client의 후속 입력도 ACK를 받았다. Broker 밖의 입력을 잠그는 보장은 없다. |
| interrupt | Ctrl+C 접수 뒤 기존 envelope END는 관찰되지 않았다. key ACK를 process 종료 증거로 사용하지 않는다. |
| 이동·주소 | pane을 같은 disposable workspace의 새 tab으로 옮기자 pane/terminal ID는 유지되고 tab ID가 바뀌었다. 기존 binding을 재사용하면 안 된다. |
| crash 복구 | 별도 child process를 전송 의도 전/후와 fake wire 기록 후에 종료했다. fsync된 의도가 있으면 unknown·terminal hold로 복구하고 replay 0을 유지했다. production DB의 power-failure 내구성 검증은 아니다. |

원자료: [local shell](results/herdr-live.json), [raw socket](results/herdr-socket.json), [fault·직렬화 모델](results/faults.json), [상태 demo](state-demo.html).

### 채택과 제한

- Herdr adapter는 version을 확인하고 직접 JSON Unix socket을 사용한다. LF로 구분한 request/response의 ID와 type을 검사하고 response size와 deadline을 제한한다. CLI는 탐색·수동 사용에 남긴다.
- 첫 실행 profile은 `/bin/sh`를 호출할 수 있고 비대화형 명령을 받을 준비가 확인된 협조적인 POSIX shell이다. wrapper까지 포함한 정확한 입력을 승인 전에 고정한다. 외부 명령이 shell 상태를 바꾼다는 지속성은 약속하지 않는다.
- `completion_observed`는 형식이 맞는 terminal 종료 주장을 관찰했다는 뜻이다. 악의적인 출력에서도 실제 종료를 정확히 판별한다는 acceptance는 채택할 수 없다. 중복·모호성을 발견하면 hold하며, 신뢰할 수 없는 실행 대상에서는 이 marker에 의존한 자동 Action 연쇄를 허용하지 않는다.
- Broker가 보내는 일반 Action은 terminal별 하나만 진행한다. proposal digest 중복 검증, 영속 intent와 unknown hold가 필요하다. ACK loss 뒤 자동 replay는 없다.
- 실제 SSH 원격 shell·재접속·target race, 다른 OS, alternate-screen mouse 동작, 실제 partial write 장애는 검증하지 않았다. SSH가 제품 목표인 점은 유지하고 별도 통합 acceptance로 넘긴다.

## 재실행

`probe.mjs catalog`, `probe.mjs forced-tool`, `probe.mjs malformed`, `probe.mjs hang`, `probe.mjs cancel`, `worker.mjs`, `herdr.mjs`, `herdr-socket.mjs`, `faults.mjs`를 각각 Node로 실행한다. Herdr 명령은 실행 중인 0.9.0 server가 필요하다. 모델 호출은 계정 사용량을 소비한다. 결과의 token 숫자 중 fake provider 값은 실제 과금·성능 수치가 아니다.

## 외부 근거

[Codex non-interactive mode](https://learn.chatgpt.com/docs/non-interactive-mode), [Codex config reference](https://learn.chatgpt.com/docs/config-file/config-reference), [Codex app-server](https://learn.chatgpt.com/docs/app-server), [Herdr pinned schema](https://github.com/herdrdev/herdr/blob/b99002ac99b09e00b4ca692436cb15a6b0d676f1/docs/next/api/herdr-api.schema.json). 실제 결과와 다른 보장을 문서에서 추론하지 않는다.
