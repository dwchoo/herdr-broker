# Codex broker-fed Worker 실행 가능성 조사

- 대상: [Codex broker-fed Worker의 실행·권한·결과 수집 가능성 조사](https://github.com/dwchoo/herdr-broker/issues/3)
- 확인일: 2026-09-15, macOS, 설치 CLI `codex-cli 0.154.0`.
- 질문: Broker가 전달한 context를 one-shot Worker Agent가 분석하고 Output Contract로 돌려줄 수 있는가?
- 범위: 로컬 metadata와 OpenAI 공식 문서. 모델 호출, Target Pane 접근, 인증·config 변경은 수행하지 않았다.
- 가정: Worker Agent는 로컬 subprocess이며, Broker가 Target Pane을 읽어 stdin으로 전달한다. provider·model·Action Mode는 이 조사에서 결정하지 않는다.
- 완료 기준: 기능·한계마다 근거를 연결하고, invocation 후보와 실행 검증 항목을 남긴다.

## 요약

1. `exec`의 stdin, JSONL, JSON Schema, 최종 메시지 파일 옵션은 설치 help에서 확인했다. headless adapter의 입출력 후보가 성립한다. [L2](#local-evidence)
2. `--ignore-user-config`는 user config를 제외하면서 `CODEX_HOME` 인증을 사용한다. 기존 인증 재사용은 문서상 지원하지만 이 계정으로 실행하지는 않았다. [L2](#local-evidence), [Non-interactive mode][noninteractive]
3. `read-only`는 명령 실행을 허용한다. tool 비활성화와 filesystem/socket 경계는 별도로 검증해야 한다. [Agent approvals & security][security]
4. `--ephemeral`의 문서상 범위는 session rollout 파일이다. 전체 로그·캐시·Broker 파일·provider 보존까지 포함하는 no-store 근거는 아니다. [Developer commands][commands], [Advanced Configuration][advanced]
5. model/effort 지원, 실제 전달된 tool 목록, 취소 후 프로세스 정리, 결과 정확성은 아직 검증되지 않았다. 기능 확인을 제품의 권한 보장으로 확대하면 안 된다.

## 근거 수준과 로컬 확인

**로컬 metadata 확인**은 명령·flag·feature가 표시되었다는 뜻이다. **문서상 지원**은 공식 설명이며 설치 binary와의 완전한 일치를 보장하지 않는다. **실행 미검증**은 모델·인증·sandbox·출력의 실제 동작을 시험하지 않았다는 뜻이다. **설계 추론**은 Broker 구현 후보이지 확정 정책이 아니다.

<a id="local-evidence"></a>

아래 metadata probe는 모두 2026-09-15에 실행했고 exit code는 0이었다.

| ID | 실행 명령 | 관찰 |
| --- | --- | --- |
| L1 | `command -v codex`; `codex --version`; `ls -l /opt/homebrew/bin/codex` | `/opt/homebrew/bin/codex` → `/opt/homebrew/Caskroom/codex/0.154.0/bin/codex`, version `0.154.0` |
| L2 | `codex --help`; `codex exec --help` | `exec`, `-m`, `-c`, `-C`, sandbox, approval, stdin, `--json`, `--output-schema`, `-o`, `--ephemeral`, `--ignore-user-config`, `--ignore-rules`, `--strict-config` |
| L3 | `codex features --help`; `codex features list` | `--disable`로 다룰 feature 이름·stage·현재 effective state 확인. 아래 목록 참조 |
| L4 | `codex login --help` | `status`, API key·access token stdin 입력, device auth 명령 표시. `login status`와 로그인은 실행하지 않음 |
| L5 | `codex app-server --help` | experimental App Server, 기본 `stdio://`, protocol schema 생성 명령 표시. 서버는 시작하지 않음 |
| L6 | 아래 feature-disable 조합에 `--help`를 붙인 명령 | help 출력 성공. config key의 의미·model 지원·실제 tool 제거를 검증한 결과는 아님 |

일부 probe에서 PATH alias를 만들지 못했다는 sandbox warning이 stderr에 나왔다. 따라서 metadata 조회만으로도 CLI의 모든 내부 쓰기가 없다고 주장할 수 없다. 인증 파일·session·pane 본문은 읽지 않았다.

L3에서 `shell_tool`, `unified_exec`, `apps`, `plugins`, `hooks`, `multi_agent`, `browser_use`, `computer_use`, `image_generation`, `view_image`, `goals`, `shell_snapshot`은 `stable / true`, `memories`는 `stable / false`였다. 이 값은 **해당 조회 환경의 effective state**이며 모든 설치의 기본값이나 Worker의 실제 tool 목록은 아니다.

## 실행·model·결과 수집

| 항목 | 확인한 수단 | 한계와 근거 |
| --- | --- | --- |
| Headless | `codex exec` | TUI 없이 실행. 로컬 help와 문서 일치. [L2](#local-evidence), [Non-interactive mode][noninteractive] |
| Broker 입력 | prompt 생략 또는 `-`로 stdin; prompt와 pipe를 함께 쓰면 stdin이 추가 context | 이 구분은 권한·신뢰 경계를 만들지 않는다. [L2](#local-evidence) |
| 실행 디렉터리 | `-C`, 필요하면 `--skip-git-repo-check` | 읽을 수 있는 filesystem 전체를 이 디렉터리로 제한한다는 의미가 아니다. [L2](#local-evidence) |
| Model | `--model <MODEL>` | help는 임의 문자열 인자를 받는 interface만 확인한다. 계정별 지원 model은 미검증. [L2](#local-evidence) |
| Effort | `-c model_reasoning_effort=...` | 공식 config 항목. 지원 값은 model에 의존하며 `max` 등을 공통 지원이라고 가정할 수 없다. [Config Reference][config] |
| 일반 출력 | stderr에 진행 정보, stdout에 최종 메시지 | stdout/stderr를 합쳐 파싱하지 않는다. [Non-interactive mode][noninteractive] |
| Events | `--json`으로 stdout JSONL | `thread.started`, `turn.started/completed/failed`, `item.*`, `error`가 문서화됨. [L2](#local-evidence), [Non-interactive mode][noninteractive] |
| Output Contract | `--output-schema <FILE>` | 최종 응답의 JSON Schema. Evidence 정확성·권한 허용을 대신 검증하지 않는다. [L2](#local-evidence), [Non-interactive mode][noninteractive] |
| 최종 응답 분리 | `-o <FILE>` | JSONL stream 전체를 결과 JSON으로 오인하지 않도록 별도 수집하는 후보. [L2](#local-evidence) |

App Server의 `model/list`는 `supportedReasoningEfforts` 등을 반환한다. 요청 model이 실제 model과 달라지는 `model/rerouted` notification도 문서화되어 있다. 따라서 **설계 추론**으로 요청값과 관찰값을 분리해 기록해야 한다. 이번에는 App Server를 호출하지 않았으며, 앱에 표시된 model 목록도 CLI 지원 근거로 사용하지 않았다. [App Server][appserver]

### 관측용 invocation 후보

아래는 **실행하지 않은 예시**다. `BROKER_*`는 Broker가 검증해 공급할 값이고, `BROKER_EFFORT_TOML`은 TOML string literal이다. 경로는 absolute path이며, 입력은 비밀정보를 제거한 합성 fixture를 전제로 한다. 이 예시는 결과·진단 파일을 만드는 관측용이므로 no-store 예시가 아니다. [L2](#local-evidence), [Advanced Configuration][advanced]

```sh
codex -a never exec \
  --ignore-user-config --strict-config --ephemeral \
  --sandbox read-only \
  --cd "$BROKER_WORK_DIR" --skip-git-repo-check \
  --model "$BROKER_MODEL" \
  -c "model_reasoning_effort=$BROKER_EFFORT_TOML" \
  -c 'web_search="disabled"' \
  -c 'history.persistence="none"' \
  --disable shell_tool --disable unified_exec \
  --disable apps --disable plugins --disable multi_agent \
  --disable hooks --disable memories --disable shell_snapshot \
  --disable browser_use --disable computer_use \
  --disable image_generation --disable view_image --disable goals \
  --json --color never \
  --output-schema "$BROKER_SCHEMA_FILE" \
  --output-last-message "$BROKER_RESULT_FILE" \
  - < "$BROKER_INPUT_FILE" \
  > "$BROKER_EVENTS_FILE" 2> "$BROKER_DIAGNOSTICS_FILE"
```

L6은 위 조합의 global approval·`exec`·isolation flags·`--disable` 목록에 `--help`만 전달해 확인했다. model/config/schema/파일 경로를 포함한 완성된 invocation을 실행하거나 검증하지 않았다.

**설계 추론:** 실제 Broker는 shell 문자열 조합 대신 subprocess argument 배열과 pipe를 사용하고, raw context를 argv에 넣지 않는다. `--ignore-rules`는 기존 execpolicy 제한도 건너뛰므로 이 후보에 넣지 않았다. 전용 working directory를 사용해 project config·instructions 유입을 줄이는 것이 다음 실험의 전제다. [L2](#local-evidence), [Advanced Configuration][advanced]

## 최소 권한과 tool-less의 한계

| 통제 | 확인 수준 | 보장하지 않는 것 |
| --- | --- | --- |
| `read-only` + `-a never` | 로컬 flag 확인; 문서상 read-only 명령 실행과 비대화형 사용 지원 | 명령 실행 금지, 파일 읽기 금지, 개별 pane scope. [L2](#local-evidence), [Agent approvals & security][security] |
| `--disable shell_tool`, `--disable unified_exec` | feature 이름 확인; shell과 PTY exec 설명은 문서상 지원 | 모든 built-in·hosted tool 제거. [L3](#local-evidence), [Config Reference][config] |
| apps·plugins·browser·computer·multi-agent 등 비활성화 후보 | 로컬 feature 이름 확인 | feature 조합 적용 후 모델이 받는 정확한 tool 목록. [L3](#local-evidence) |
| MCP별 `enabled=false` 또는 tool allow/deny list | 문서상 지원 | 다른 config layer나 plugin이 제공한 별도 경로. [MCP][mcp] |
| `--ignore-user-config` | 로컬 help·공식 문서 일치 | 모든 system/project config, AGENTS.md, skills, hook discovery까지 무시하는 보장. [L2](#local-evidence), [Advanced Configuration][advanced] |
| filesystem `read/write/deny`와 network Unix socket allowlist | 문서상 permission profile 지원 | 설치 profile의 실제 효과, Herdr socket 차단의 실행 증거. [Permissions][permissions] |

로컬 help와 확인한 config 문서에는 범용 `--tools none` 또는 `tool_choice=none` interface가 제시되지 않았다. 이는 모든 내부 가능성이 없다는 증명이 아니다. 위 disable 조합을 완전한 tool-less 보장으로 채택하려면 시작 시 tool 목록 또는 provider request를 검증하는 후속 실험이 필요하다. [L2–L3](#local-evidence), [Config Reference][config]

macOS command sandbox는 Seatbelt로 집행된다. command network proxy가 통제하지 않는 경로에는 MCP, apps, browser/Computer Use, model·인증 요청이 포함된다. 따라서 shell network 제한만으로 Worker의 모든 외부 접근을 설명할 수 없다. [Sandbox][sandbox], [Agent approvals & security][security]

**경계 평가:** 보호 대상은 Herdr socket·pane 입력권·로컬 credential이다. 공격 입력은 pane 출력에 섞인 instructions일 수 있다. Worker가 전달된 text를 따라 접근 가능한 tool을 호출하는 경로가 잠재 위험이다. 이 조사에서는 실제 우회 경로를 실행하지 않았으므로 취약점이 확인됐다고 결론내리지 않는다. 최소 검증은 가짜 socket·canary 파일을 사용하는 접근 거부 실험이며, 결과 전에는 context 분리와 security isolation을 구분해야 한다. 이는 조사 근거에서 도출한 설계 추론이다.

## 기존 인증과 기록·no-store

| 대상 | 확인 사실·한계 |
| --- | --- |
| 기존 CLI 인증 | `exec`는 저장된 CLI 인증을 재사용한다. ChatGPT와 API key는 별도 인증 방식이다. 이 계정의 mode·가용량·동시 실행은 조사하지 않았다. [Non-interactive mode][noninteractive], [Authentication][auth] |
| 저장 위치 | file mode는 `CODEX_HOME/auth.json`, 대안은 OS credential store. `keyring/auto/ephemeral` 선택지가 있다. ChatGPT token은 사용 중 자동 갱신될 수 있다. [Authentication][auth] |
| `--ignore-user-config` | 같은 `CODEX_HOME`의 auth를 계속 사용한다는 help 근거가 있다. user config에 있던 credential-store 선택을 제외했을 때 같은 인증을 찾는지는 별도 확인이 필요하다. [L2](#local-evidence), [Authentication][auth] |
| 다른 `CODEX_HOME` | local state 위치도 바뀐다. 빈 directory로 바꾸면 기존 인증이 자동 재사용된다고 가정할 수 없다. credential 복사·출력은 이 조사에서 수행하지 않았다. [Advanced Configuration][advanced], [Authentication][auth] |
| Session rollout | `--ephemeral`은 session rollout 파일을 남기지 않는 옵션이다. 이 설명을 모든 persistent state 미생성으로 확대할 수 없다. [Developer commands][commands] |
| History | `history.persistence="none"`은 `history.jsonl` 저장 제어다. rollout·로그·캐시까지 같은 파일은 아니다. [Advanced Configuration][advanced] |
| 로그·telemetry | `log_dir` 기본은 `$CODEX_HOME/log`; 명시 설정은 plaintext TUI log도 활성화한다. `otel.log_user_prompt`는 raw prompt export 선택이다. 전체 local state는 실행 후 점검해야 한다. [Config Reference][config] |
| Broker 파일 | 위 예시의 input/result/events/stderr는 Broker가 만드는 기록이다. pipe와 제한된 memory buffer를 쓰는 후보도 별도의 TTL·삭제·crash 정책이 필요하다. **설계 추론** |
| Provider 저장 | 데이터 처리 정책은 ChatGPT workspace 또는 API organization 인증 방식에 따라 달라진다. CLI ephemeral 옵션은 provider의 zero retention을 증명하지 않는다. [Authentication][auth] |

기존 인증을 쓰는 로컬 subprocess는 가능한 경로다. 그러나 인증 refresh가 파일을 쓸 수 있고 logs/caches도 별개이므로, “인증 재사용 + 디스크 무기록”을 현재 근거만으로 동시에 보장하지 않는다. credential 접근 방식·raw 보존 범위·provider 데이터 정책은 후속 결정 사항이다. [Authentication][auth], [Advanced Configuration][advanced]

## Timeout·취소·실패·usage

- 로컬 `exec --help`에는 Delegation Job 전체 timeout, 최대 wall time, 정확한 비용 상한 flag가 없었다. 개별 request/tool 제한을 job deadline으로 간주하지 않는다. Broker timer는 별도 설계 후보다. [L2](#local-evidence)
- 문서의 JSONL `turn.completed.usage` 예시에는 `input_tokens`, `cached_input_tokens`, `output_tokens`, `reasoning_output_tokens`가 있다. 실제 설치 출력의 필드·누적 범위·실패 시 누락은 미검증이다. [Non-interactive mode][noninteractive]
- App Server는 `turn/interrupt`와 종료 상태 `interrupted`, `thread/tokenUsage/updated`, ChatGPT `account/rateLimits/read`를 문서화한다. account 한도는 특정 Delegation Job 비용이 아니다. API는 이번에 호출하지 않았다. [App Server][appserver]
- App Server는 더 풍부한 lifecycle adapter의 후보지만 experimental interface이며, stdio 요청·응답·notification 처리가 추가된다. one-shot `exec` 채택 여부와 별개로 검토할 사항이다. [L5](#local-evidence), [App Server][appserver]
- 실제 model, token usage, 요청·완료 시각은 관찰값으로 저장하고, usage 누락을 0으로 바꾸지 않는 것이 설계 후보다. dollar cost나 subscription credit 소모를 token만으로 정확히 환산하는 근거는 확보하지 않았다.

다음 상태 분리는 **Broker adapter 설계 추론**이다. CLI exit code 번호를 상태별로 고정 매핑한 근거는 아직 없다.

| Broker가 구분할 상황 | 수집할 증거·완료 조건 |
| --- | --- |
| 실행 실패 | spawn 오류, exit code/signal, 제한된 stderr, terminal event 유무 |
| Worker 실패 | `turn.failed`/`error` 내용과 프로세스 종료를 함께 확인; 중간 오류와 최종 실패 구분 |
| Timeout | Broker deadline 초과 기록; 종료 signal·grace period·child process 정리 실험 |
| Cancel | 사용자/Parent 요청 ID·시각, 종료 확인; timeout 원인과 분리 |
| Invalid output | 응답 누락, JSON parse 실패, JSON Schema 실패, Evidence 참조 범위 실패를 구분 |
| 성공 | terminal completion, 허용된 process 종료, Output Contract와 Evidence 검증 모두 만족 |

`--output-schema`가 있어도 Broker의 JSON parse·schema validation·크기 제한·Evidence 검증은 필요하다. shell command나 pane 입력은 모델 결과 문자열을 바로 실행하지 않고 별도 Action Mode 경계에서 다룬다는 가정이다.

## Codex Parent Agent와 비동기 Broker interface

Codex MCP는 STDIO와 Streamable HTTP를 문서화하며, MCP server startup 기본 timeout은 10초, tool 호출 기본 timeout은 60초다. tool allow/deny list와 `required=true`도 제공한다. 실제 Parent 설정은 읽거나 바꾸지 않았다. [MCP][mcp]

**설계 추론:** `pane_delegate`가 빠르게 `job_id`를 반환하고, `job_get`·짧은 `job_wait`·`job_cancel`로 추적하는 interface를 실험할 근거가 있다. `job_wait`는 MCP timeout보다 여유 있게 짧게 끝나야 한다. MCP 호출 종료·client 연결 종료와 Worker 취소를 같은 사건으로 처리할지는 명시적으로 정해야 한다.

Parent에게는 검증된 Worker report와 제한된 Evidence만 돌려주는 계약을 시험한다. JSONL 전체에는 reasoning·command·MCP tool output 등이 포함될 수 있으므로 그대로 Parent MCP 응답에 붙이면 context 분리 목표를 무너뜨릴 수 있다. 이 판단은 event 종류와 Broker 목적에서 도출한 추론이다. [Non-interactive mode][noninteractive]

## 다음 최소 실험

현재 허용 범위 밖인 실제 모델 실행은 별도 후속 작업에서 수행한다. 모두 합성 입력·가짜 자원으로 시작한다.

1. **Capability/auth:** 설치 version을 고정하고 전용 App Server의 `model/list` 또는 provider가 지원하는 조회로 model·effort 후보를 확인한다. 기존 auth 재사용·실패를 credential 본문 없이 판별한다.
2. **One-shot 계약:** 작은 pane fixture 하나로 stdin→schema JSON→Broker 검증을 연결한다. stdout/stderr, JSONL terminal event, 결과 파일, usage의 실제 모양을 수집한다.
3. **Tool 경계:** 위 disable 후보로 실제 노출 tool 목록을 확인한다. synthetic prompt injection에 대한 file/socket 접근 거부를 측정하며, 실제 Herdr socket은 사용하지 않는다.
4. **Lifecycle:** 정상·강제 종료·deadline·명시 cancel·invalid schema·인증 실패를 구분한다. parent와 child process가 정리되는지 확인한다.
5. **보존:** 통제된 state directory와 임시 파일의 생성·변경을 전후 비교한다. ephemeral/history 설정, auth refresh, logs/caches를 분리해 no-store의 가능한 범위를 정한다.
6. **MCP:** 짧은 wait, 연결 중단, 재조회, 취소를 합성 job으로 확인한다. raw context가 Parent 응답으로 새지 않는지 검사한다.

## 공식 문서

모든 링크는 2026-09-15에 해당 페이지를 열어 확인했다. `developers.openai.com/codex/...`의 여러 문서는 아래 `learn.chatgpt.com/docs/...`로 redirect되었다. 문서는 특정 CLI release에 고정된 source snapshot이 아니므로 로컬 metadata와 함께 해석한다.

[noninteractive]: https://learn.chatgpt.com/docs/non-interactive-mode
[commands]: https://learn.chatgpt.com/docs/developer-commands?surface=cli
[config]: https://learn.chatgpt.com/docs/config-file/config-reference
[advanced]: https://learn.chatgpt.com/docs/config-file/config-advanced
[auth]: https://learn.chatgpt.com/docs/auth
[security]: https://learn.chatgpt.com/docs/agent-approvals-security
[sandbox]: https://learn.chatgpt.com/docs/sandboxing
[permissions]: https://learn.chatgpt.com/docs/permissions
[appserver]: https://learn.chatgpt.com/docs/app-server
[mcp]: https://learn.chatgpt.com/docs/extend/mcp
