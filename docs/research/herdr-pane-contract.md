# Herdr pane 관찰·입력 계약 조사

- 조사일: 2026-09-15
- 관련 issue: [Herdr pane 관찰·입력·대상 식별·완료 신호의 보장 범위 조사](https://github.com/dwchoo/herdr-broker/issues/4)
- 범위: 설치 CLI metadata, bundled schema, 공식 문서와 upstream source. 실제 pane 조회·입력·SSH 실행은 수행하지 않았다.
- 결론: Herdr는 terminal snapshot과 입력 primitive를 제공하지만, 임의 명령의 정확히 한 번 실행·새 출력 cursor·명령별 완료를 제공하는 것으로 해석할 수 없다. 아래의 **source 근거**와 **Broker 제안**을 구분한다.

## 1. 조사 기준과 설치본 대조

설치 CLI는 `herdr 0.9.0`, bundled schema는 `protocol: 22`, `schema_version: 1`이다. 출력한 schema는 공식 `v0.9.0` tag의 [schema artifact][schema]와 byte 단위로 일치했다. Source 근거는 해당 tag의 commit `b99002ac99b09e00b4ca692436cb15a6b0d676f1`에 고정한다.

```text
herdr --version
herdr pane --help
herdr pane read --help
herdr pane run --help
herdr pane wait-output --help
herdr agent prompt --help
herdr terminal --help
herdr api schema --output /private/tmp/herdr-pane-contract-schema.json
schema SHA-256: 5fb46b13fdaf39c88cf699b9806685868c7ee6b0142523d84391b1606416dc0a
```

이는 **설치 binary의 metadata와 같은 version의 공개 source를 대조한 결과**다. 실행 중인 server의 version·설정·agent detection 상태는 조회하지 않았으므로 실제 server 동작을 실험으로 확인한 결과가 아니다. 공식 문서도 schema가 설치 binary에 포함된 것이며, 업데이트된 CLI와 실행 중인 server가 다를 수 있다고 설명한다. [Socket API][docs-api]

| 확인 항목 | 설치본·v0.9.0 source | 조사일의 공식 문서와 비교 |
| --- | --- | --- |
| `pane run` | CLI에 존재하며 `PaneSendInput`을 전송 | 문서의 atomic text+Enter 설명과 대응한다. 별도 `pane.run` socket method는 없다. [CLI source][cli-pane] |
| `wait-output` | help에 기존 snapshot 즉시 검사·무기한 기본 대기 명시 | 문서 설명과 일치한다. [CLI reference][docs-cli] |
| alternate-screen history read | v0.9.0 server source에 구현되어 있다 | 최신 문서만의 기능으로 제외할 수 없다. 아래 조건을 만족하면 pane read에도 적용된다. [Source][headless], [문서][docs-agent] |
| `revision` | schema에 있지만 read 응답은 literal `0` | schema의 field 존재만으로 cursor를 약속하지 않는다. [Read handler][pane-handler] |
| row 제한 | 기본 recent 80, 지정값은 최대 1000으로 제한 | CLI help의 “lines”만 읽으면 rendered row·논리 line의 차이와 상한을 놓칠 수 있다. [Snapshot helper][helpers] |

## 2. CLI와 socket method 대응

아래 대응은 설치 schema와 같은 tag의 CLI/source에서 확인했다. CLI 성공 여부와 Target Pane 내부 작업의 성공 여부는 별개다. [CLI source][cli-pane], [Method 정의][methods]

| CLI | socket method / 처리 | 반환에서 읽을 것 |
| --- | --- | --- |
| `pane list`, `pane get`, `pane current` | `pane.list`, `pane.get`, `pane.current` | `PaneInfo`와 현재 대상 mapping |
| `pane process-info` | `pane.process_info` | `process_info`의 shell/foreground process metadata |
| `pane read` | `pane.read` | CLI는 `.result.read.text`만 출력; socket은 `source`, `format`, `truncated` 등도 제공 |
| `pane send-text` | `pane.send_text` | `ok`; text의 queue 수락 |
| `pane send-keys` | `pane.send_keys` | `ok`; terminal key 입력 |
| `pane run` | `pane.send_input`, `text`와 `keys: ["Enter"]` | `ok`; shell command 실행 결과가 아님 |
| `pane wait-output` | `pane.wait_for_output` | `matched_line`, `read`, `pane_id` |
| `agent prompt --wait`, `agent wait` | `agent.prompt`의 `wait`, `agent.wait` | agent lifecycle 상태 |

`pane.read` CLI의 text 출력에는 socket 응답의 `truncated`와 identity metadata가 남지 않는다. Evidence에 이를 보존하려면 socket 결과를 저장하는 방식이 필요하다. 이는 Broker 설계 제안이다. [CLI 출력 구현][cli]

## 3. 관찰 보장과 정보 손실

| primitive | 확인된 의미·보장 | 보장하지 않는 것 |
| --- | --- | --- |
| `visible` | 현재 rendered viewport의 text/ANSI snapshot | viewport 밖의 기록, 이전 화면, append-only log |
| `recent` | 최근 rendered row를 wrapping 유지 상태로 읽음 | N개 command/logical line, 모든 과거 출력 |
| `recent-unwrapped` | 같은 row 범위에서 soft wrapping을 제거 | hard newline 제거, 제한 전에 잘린 logical line 복원 |
| `detection` | agent detection용 bottom-buffer plain text | 원본 ANSI stream, transcript 전체 |
| `--lines N` | recent는 row 선택 후 unwrap; visible/detection은 snapshot의 마지막 newline line 선택. 최대 1000 | byte 제한·token 예산·완전한 명령 경계 |
| `--ansi` / `--format ansi` | terminal state가 노출하는 styling을 포함한 snapshot | PTY에 도착했던 원본 byte stream |
| `truncated` | 선택 범위 밖의 row/line이 있음을 표현 | `false`일 때 과거 scrollback·덮어쓴 화면까지 모두 보존되었다는 증명 |

위 표의 근거는 [read source 문서][docs-cli], [snapshot 선택·상한][helpers], [terminal snapshot 구현][terminal-read]이다. CR, cursor movement, 지우기 등으로 이미 덮어쓴 내용은 현재 terminal state만으로 복원할 수 없다는 판단은 이 snapshot 구현에서 도출한 한계다. ANSI 형식도 그 손실을 되돌리지 않는다.

### `read`가 입력을 발생시킬 수 있는 조건

v0.9.0에서는 **`agent.read`와 raw socket `pane.read` 모두** alternate-screen history traversal의 대상이다. `PaneReadParams.intent`는 `serde(skip)`·`schemars(skip)`된 내부 field이고 기본값은 `Interactive`다. Client가 JSON에 `intent: passive`를 넣어 passive 관찰을 선택할 수 있는 공개 계약은 없다. [Params][pane-params], [기본값][common]

Source의 traversal 조건은 다음과 같다. [Server 처리][headless]

1. `format: text`와 `recent` 또는 `recent-unwrapped`다.
2. recognized agent의 내부 상태가 `Idle`이고 alternate screen과 mouse-wheel reporting을 사용한다.
3. 요청 row 수가 현재 screen보다 크다. `lines`를 생략해도 기본 80이므로 조건에 해당할 수 있다.
4. direct attach owner와 같은 terminal의 진행 중 traversal이 없다.

Herdr는 bottom 여부를 probe한 뒤 ScrollUp으로 겹치는 page를 모으고 ScrollDown으로 복귀를 시도한다. 중단·시간 제한·복귀 실패 경로는 기존 passive snapshot으로 fallback할 수 있다. 따라서 성공 응답만으로 전체 transcript나 viewport 복귀의 무조건적 성공을 추가 보장하지 않는다. [Traversal state machine][alt-read]

- `visible`, `detection`, ANSI read는 traversal에서 제외된다. CLI `--raw`는 `format: ansi`도 설정하므로 제외된다. Raw socket의 `strip_ansi: false`만으로는 `format: text` 기본값을 바꾸지 않는다. [CLI parser][cli-pane], [Server 조건][headless]
- output wait와 subscription의 내부 read는 `ReadIntent::Passive`를 명시한다. [Wait][wait], [Subscription][subscriptions]
- 명시적인 `agent read --lines N`이 alternate-screen history를 필요로 하는데 agent가 non-idle이면 `agent_not_idle`이 가능하다. 이 검사는 `AgentRead`에만 적용된다. 같은 조건의 `PaneRead`가 반드시 같은 error를 반환한다고 가정하면 안 된다. [Server 검사][headless]

**Broker 제안:** 입력이 허용되지 않은 Delegation Job에는 `visible`/`detection` 또는 명시적 ANSI snapshot을 사용하고 필요한 text 정규화는 별도로 한다. Text recent read를 관찰 전용으로 분류하지 않는다.

## 4. 대상 identity와 입력 atomicity

| primitive | 확인된 보장 | 비보장·Broker 책임 |
| --- | --- | --- |
| `pane_id` | workspace-qualified public target; cross-workspace move는 새 public ID와 이전 ID를 반환 | 영구 process/session identity가 아니다. move 후 반환 ID로 mapping을 갱신한다. [공식 문서][docs-api] |
| `terminal_id` | server-owned terminal의 opaque identity; layout 위치에서 유도하면 안 됨 | 현재 shell·SSH remote session·agent turn identity가 아니다. [TerminalId][terminal-id] |
| process metadata | PTY child PID, server가 관찰한 foreground process group·processes·cwd. unavailable field 가능 | SSH pane에서 remote 명령·인증 사용자·remote cwd가 동일하다는 증명은 아니다. 이는 로컬 process probe에서 도출한 한계다. [Process handler][pane-handler] |
| agent name/session | live agent 이름은 현재 occupant에 속함; 종료·교체 시 해제. session reference는 별도 metadata | 이름·title만으로 입력 직전 occupant 일치가 보장되지 않는다. [Agent 문서][docs-agent] |
| `pane.send_input` | text와 검증된 key encoding을 한 byte buffer로 합쳐 한 번 enqueue; live bracketed-paste mode 반영 | terminal이 shell prompt인지, text가 의도한 명령인지, PTY 전달·실행·종료 성공인지 보장하지 않는다. [Encoding][helpers], [Unix queue][pty] |
| expected identity | `PaneSendInputParams`는 `pane_id`, `text`, `keys`뿐 | expected terminal/process/session/revision, CAS, idempotency key가 없다. 사전 조회와 입력 사이 race가 남는다. [Params][pane-params] |
| 동시 제어 | direct terminal attach/control에는 한 owner와 takeover가 있음 | `pane.send_*` handler는 그 owner를 검사하지 않는다. 전체 Broker job·사람·socket 입력에 대한 배타적 lock으로 확대할 수 없다. [Owner][headless], [Input handler][pane-handler] |

`pane run`의 atomicity는 **한 입력 제출을 구성하는 text+Enter의 묶음**에 한정한다. 승인·identity 조회·입력·완료 관찰 전체가 transaction이 되지는 않는다. 별도 `send-text`와 `send-keys` 두 호출은 그 사이 다른 입력이 들어올 수 있다. [CLI mapping][cli-pane], [입력 구현][pane-handler]

## 5. 새 출력, 완료와 timeout

- `wait-output`은 호출 즉시 기존 snapshot부터 검사한다. `recent`와 `recent-unwrapped`는 모두 unwrapped recent로 검색하며 substring/regex는 한 line 단위다. timeout 생략 시 무기한 대기다. **기존 “passed” 문구만으로 방금 제출한 명령이 완료됐다고 판정하면 안 된다.** [CLI 문서][docs-cli], [Wait 구현][wait]
- `PaneReadResult.revision`은 pane/agent read handler에서 `0`으로 구성되고 wait 결과도 이 값을 전달한다. 반면 `PaneInfo.revision`은 `terminal.revision`이며 title·metadata 변경으로도 증가한다. 두 field를 같은 output cursor로 취급할 수 없다. [Read handler][pane-handler], [Agent read][agent-handler], [PaneInfo][creation], [Title revision][terminal-state]
- schema의 `events.wait`에는 `pane_output_changed`용 `min_revision`이 있지만, `pane.read`/`pane.wait_for_output`에는 `after_cursor`·offset·`since_revision`이 없다. 이 조합만으로 유실 없는 Delta를 제공한다고 확정하지 않는다. [Schema][schema]
- lifecycle subscription은 수락 이후 시작하고 이전 event replay를 보장하지 않는다. 문서의 bootstrap 절차는 먼저 subscribe ACK를 받고 stream을 buffer한 뒤 snapshot을 설치하는 것이다. 재접속 후에는 새 snapshot이 필요하다. 이 절차도 PTY byte log의 복구 cursor를 뜻하지 않는다. [Socket API][docs-api]
- `agent wait`은 같은 terminal/name/agent를 확인하고 move·종료에 `agent_not_running`을 반환하는 경로가 있다. `agent prompt --wait`는 submission과 wait를 묶지만 개별 turn을 추적하지 않는다. 이미 working이면 기존 turn의 완료가 충족할 수 있다. [Agent wait source][wait], [설치 help와 공식 문서][docs-cli]
- `done`은 agent가 idle이고 server에서 아직 seen으로 표시되지 않은 상태다. `blocked`는 approval/question UI, `unknown`은 lifecycle 분류 불확실이다. 이들은 임의 shell command의 exit code가 아니다. [상태 변환][helpers]
- `pane run`의 `ok`는 입력 queue 수락이다. 요청을 app에 보낸 뒤 응답을 못 받거나 연결이 끊겨도 이미 제출된 입력을 취소·회수하는 일반 계약은 없다. 따라서 **timeout/연결 끊김 후 재전송은 중복 실행 가능성을 남긴다.** [Unix queue][pty], [API dispatch][dispatch]

**Broker 제안:** 제출 상태와 명령 완료를 별도로 기록한다. 응답 유실 후에는 실행 결과를 `unknown`으로 유지하고, 추가 관찰 없이 재전송하지 않는다. 이 Broker 결과 상태는 Herdr의 agent lifecycle `unknown`과 의미를 구분해야 한다.

## 6. 구현 전에 선택할 계약

| 선택지 | 얻는 것 | 필요한 Broker 책임·한계 |
| --- | --- | --- |
| A. passive snapshot을 Evidence로 전달 | 관찰만 허용된 job에 적용하기 쉬움 | source·format·row limit·truncated·관찰 시각·대상 identity를 함께 저장; Delta는 snapshot 비교라는 제한을 명시 |
| B. shell 전용 제출 + job별 sentinel | 명령별 완료·exit code를 연결할 후보 | shell 상태 확인, job별 nonce와 begin/end 규칙, command echo 오인 방지, 결과 검증, 중복 실행 정책 필요 |
| C. recognized agent의 `agent.prompt --wait` | occupant 검사와 lifecycle wait를 활용 | turn ID와 완료 산출물을 별도로 검증; already-working 경우 attribution 불명확 |
| D. terminal observe stream | passive live frame을 관찰할 후보 | frame은 rendered ANSI이며 command transcript·job 완료 계약은 별도; reconnect 누락을 처리 |

A–D는 확정 ADR이 아닌 설계 선택지다. B의 sentinel은 기존 snapshot 오탐을 줄이는 수단이며, 출력 생산자가 조작할 수 있는 문자열을 신뢰된 실행 증명으로 바꾸지는 않는다. D의 공식 CLI 계약은 여러 observer와 한 controller를 구분한다. [Terminal stream 문서][docs-cli]

Broker가 최소한 맡아야 할 부분은 target binding 재확인, Broker 내부의 terminal별 입력 직렬화, Action Mode 승인과 입력 내용 결합, Evidence 한도·정규화, stale output 판별, `unknown` 이후 reconciliation이다. 내부 직렬화는 Broker 밖의 사람·다른 client까지 막지 못한다. 이 책임 분리는 위 primitive의 비보장에서 도출한 제안이다.

## 7. 후속 실험과 검증 한계

이번 조사에서는 아래 실험을 실행하지 않았다. 별도 허용된 disposable pane에서 재현하고 구현 acceptance test로 전환할 후보다.

| 후속 실험 | 확인할 판정 기준 |
| --- | --- |
| read matrix: source × format × idle/working × alternate screen | CLI/socket별 입력 발생 여부, default 80·상한 1000, fallback과 viewport 복귀; `strip_ansi`만 바꾼 경우 포함 |
| 긴 wrap·blank row·CR overwrite·scrollback eviction | 선택 row와 logical line, ANSI/text 차이, `truncated`가 표현하는 범위 |
| move·pane 교체·shell→SSH→shell 변화 | public ID/terminal ID/process metadata 변화와 승인 후 입력 race; live server behavior 확인 |
| 두 job·사람·direct controller의 동시 입력 | text+Enter buffer 경계와 job 전체 배타성의 차이, Broker lock 밖 입력 감지 가능 범위 |
| 기존 match·unique sentinel·대량 출력 | stale match, command echo, nonce 충돌·위조, 결과가 row 범위에서 사라진 경우 |
| enqueue 직전/직후 disconnect·wait timeout·server 재시작 | 수락 여부와 실제 종료를 복구할 수 있는 근거, 재시도 시 중복 방지 조건 |

수행한 검증은 metadata help 확인, 설치 schema와 tag artifact의 JSON/byte hash 일치, 인용 source 경로·line 존재 확인, Markdown의 상대 링크·형식 및 변경 범위 점검이다. Build/test 명령은 저장소에 정의되지 않았고, upstream test를 실행하거나 실제 pane 동작을 재현하지 않았다.

## 출처

[schema]: https://github.com/herdrdev/herdr/blob/b99002ac99b09e00b4ca692436cb15a6b0d676f1/docs/next/api/herdr-api.schema.json
[docs-api]: https://herdr.dev/docs/socket-api/
[docs-cli]: https://herdr.dev/docs/cli-reference/
[docs-agent]: https://herdr.dev/docs/agent-automation/
[cli-pane]: https://github.com/herdrdev/herdr/blob/b99002ac99b09e00b4ca692436cb15a6b0d676f1/src/cli/pane.rs#L1050
[cli]: https://github.com/herdrdev/herdr/blob/b99002ac99b09e00b4ca692436cb15a6b0d676f1/src/cli.rs#L85
[methods]: https://github.com/herdrdev/herdr/blob/b99002ac99b09e00b4ca692436cb15a6b0d676f1/src/api/schema.rs#L190
[pane-params]: https://github.com/herdrdev/herdr/blob/b99002ac99b09e00b4ca692436cb15a6b0d676f1/src/api/schema/panes.rs#L346
[common]: https://github.com/herdrdev/herdr/blob/b99002ac99b09e00b4ca692436cb15a6b0d676f1/src/api/schema/common.rs#L86
[helpers]: https://github.com/herdrdev/herdr/blob/b99002ac99b09e00b4ca692436cb15a6b0d676f1/src/app/api_helpers.rs#L109
[terminal-read]: https://github.com/herdrdev/herdr/blob/b99002ac99b09e00b4ca692436cb15a6b0d676f1/src/pane/terminal.rs#L2646
[headless]: https://github.com/herdrdev/herdr/blob/b99002ac99b09e00b4ca692436cb15a6b0d676f1/src/server/headless.rs#L2659
[alt-read]: https://github.com/herdrdev/herdr/blob/b99002ac99b09e00b4ca692436cb15a6b0d676f1/src/server/alt_screen_read.rs#L350
[pane-handler]: https://github.com/herdrdev/herdr/blob/b99002ac99b09e00b4ca692436cb15a6b0d676f1/src/app/api/panes.rs#L1489
[agent-handler]: https://github.com/herdrdev/herdr/blob/b99002ac99b09e00b4ca692436cb15a6b0d676f1/src/app/api/agents.rs#L237
[terminal-id]: https://github.com/herdrdev/herdr/blob/b99002ac99b09e00b4ca692436cb15a6b0d676f1/src/terminal/id.rs#L5
[creation]: https://github.com/herdrdev/herdr/blob/b99002ac99b09e00b4ca692436cb15a6b0d676f1/src/app/creation.rs#L306
[terminal-state]: https://github.com/herdrdev/herdr/blob/b99002ac99b09e00b4ca692436cb15a6b0d676f1/src/terminal/state.rs#L228
[wait]: https://github.com/herdrdev/herdr/blob/b99002ac99b09e00b4ca692436cb15a6b0d676f1/src/api/wait.rs#L21
[subscriptions]: https://github.com/herdrdev/herdr/blob/b99002ac99b09e00b4ca692436cb15a6b0d676f1/src/api/subscriptions.rs#L493
[pty]: https://github.com/herdrdev/herdr/blob/b99002ac99b09e00b4ca692436cb15a6b0d676f1/src/pty/actor/unix.rs#L108
[dispatch]: https://github.com/herdrdev/herdr/blob/b99002ac99b09e00b4ca692436cb15a6b0d676f1/src/api/server.rs#L854
