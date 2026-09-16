# Herdr 공유 terminal MCP

Python MCP는 현재 Herdr workspace의 pane을 조회하고 읽고 입력하며 이름과 배치를 바꾼다. 사용자와 Codex는 같은 terminal에서 작업한다. Console 시작·접속·등록·Mode 설정은 필요 없다. 승인 판단은 Parent Codex의 기존 정책을 따른다.

## 프로젝트 설정

Python 3.12 이상과 uv, 실행 중인 Herdr 0.9.0/protocol 22가 필요하다. Worker는 공식 `openai-codex` SDK와 함께 설치되는 Codex runtime, 기존 로컬 Codex 인증을 사용한다. Docker는 사용하지 않는다.

```sh
uv sync --locked
uv run herdr-broker setup --project .
```

setup은 `.codex/config.toml`의 Broker MCP 블록만 갱신하고 승인 설정은 바꾸지 않는다. 이 프로젝트에서 새 Codex를 시작한 뒤 `$broker`를 호출한다. Herdr shell과 같은 Mac의 Codex CLI·Desktop을 지원한다. 개발 checkout은 `uv run --project <경로> herdr-broker mcp --project <경로>`로 실행한다. 패키지는 `uvx --from <wheel 경로 또는 버전 고정 Git URL> herdr-broker mcp --project <프로젝트 경로>`로도 실행할 수 있다. 아직 공개 registry에 배포했다고 가정하지 않는다.

같은 Mac·OS 사용자의 Codex CLI·Desktop에서도 사용할 수 있다. Herdr 밖에서는 `workspace_list`로 workspace를 고르고 `workspace_id`를 지정해 tab·pane을 조회한다. Herdr 안에서는 주입된 workspace·tab·pane·socket과 실제 shell의 프로세스 조상 관계를 확인하며 caller workspace가 기본값이다. 불완전하거나 잘못된 Herdr 환경값을 외부 모드로 우회하지 않는다. MCP는 설정의 project 경로 아래에서 실행하며, 사용자 소유 `~/.config/herdr-broker/config.json`의 `herdr_socket`·`redaction_patterns` 설정을 사용할 수 있다. 원격 컴퓨터·cloud ChatGPT 연결은 이번 로컬 연결에 포함하지 않는다. legacy `codex_binary`는 새 SDK runtime 선택에 사용하지 않는다.

## 사용 흐름

1. `$broker 현재 pane이 뭐야?` — workspace 전체의 tab·pane 이름과 실제 ID를 읽는다. 목록 조회는 화면 수집·분석·입력·이름 변경을 하지 않는다.
2. `1008 · 서버에서 상태 확인해줘` — Parent가 최신 목록과 대화 맥락에서 대상을 선택하고 사용자에게 알린다. 번호·이름이 불명확하면 후보와 위치를 확인한다.
3. `pane_read` — 출력 길이와 관계없이 `gpt-5.6-luna/high`가 화면만 분석한다. Worker는 파일·shell·MCP 도구를 사용하지 않는다. 사용자가 원문을 요청했을 때만 raw 읽기를 사용한다.
4. `pane_execute` — 실행할 명령과 Enter 하나를 같은 요청으로 보낸다. 입력만 하거나 TUI의 특정 키를 누를 때는 기존 `pane_send`를 사용한다. SSH 여부에 따라 별도 준비 절차를 두지 않는다.
5. 화면을 다시 읽어 결과를 확인한다. ACK는 입력 접수이며 실행 완료·성공·exit code를 뜻하지 않는다.

대상 파일을 확인·편집·실행하는 작업은 옆 pane에 명령을 입력해서 수행한다. 사용자는 언제든 같은 terminal을 직접 사용할 수 있다. 화면 관찰과 입력 사이에 프로그램이나 사용자 입력이 바뀔 수 있으므로 Parent가 현재 화면을 확인한다.

여러 줄 heredoc도 `pane_execute(command=...)`로 제출한다. 붙여넣기 안의 마지막 newline은 별도 Enter와 다를 수 있다. 예를 들어 `python3 - <<'PY'\nprint('BROKER_' + 'EXEC_PROBE')\nPY\n`을 실행한 뒤 실제 `BROKER_EXEC_PROBE` 출력과 프롬프트 복귀를 확인한다. 입력한 코드나 marker 문자열이 보인다는 이유만으로 완료했다고 판단하지 않는다. 입력만 남아 있다면 현재 프로그램을 확인한 뒤 필요한 키만 보내고, 명령 본문을 다시 보내지 않는다.

## Pane 생성과 배치

`$broker 팬을 하나 만들어줘`라고 하면 현재 Codex pane 옆에 새 terminal을 만들고 번호를 붙인다. 위치를 지정하지 않으면 오른쪽에 좌우로 나누며 Codex의 focus를 유지한다. `아래에 만들어줘`는 위·아래로 나눈다. 방향은 가로·세로라는 표현만 쓰기보다 `좌우`·`상하`와 실제 위치로 설명한다.

- `pane_layout`: 현재 tab의 pane 배치와 분할 방향을 metadata로 확인한다.
- `pane_split`: 지정한 pane의 오른쪽(`right`, 좌우) 또는 아래쪽(`down`, 상하)에 새 shell을 만든다. 기존 shell·SSH를 복제하지 않으며 기존 terminal은 유지한다.
- `pane_close`: 정확한 pane을 닫는다. 해당 terminal과 실행 중인 작업도 종료될 수 있으므로 Parent가 사용자 요청과 자신의 승인 정책에 따라 판단한다.
- `pane_swap`: 같은 tab의 두 pane 위치를 교환한다. terminal ID·프로세스·분할 비율을 유지한다.
- `pane_move`: 현재 workspace의 다른 기존 tab에 있는 pane 옆으로 옮긴다. 같은 tab 안에서는 swap이나 방향 전환을 사용한다.
- `pane_reorient`: 하나의 분할을 공유하는 두 leaf pane을 좌우·상하로 전환한다. 복잡한 하위 분할 전체를 한 번에 회전하지는 않는다.

Herdr 0.9.0은 방향 전환 API가 없다. `pane_reorient`는 두 번째 pane을 임시 tab으로 옮긴 뒤 같은 terminal을 원래 tab의 첫 번째 pane 옆에 새 방향으로 붙인다. 순서와 분할 비율을 유지하며, 비워진 임시 tab은 Herdr가 없앤다. `layout.apply`는 terminal을 재생성하므로 사용하지 않는다. 중간에 통신이 끊기거나 배치가 달라지면 수행한 단계와 확인한 위치를 반환하고 멈춘다. 임시 tab에 pane이 남을 수 있으므로 최신 목록을 확인한 뒤 후속 행동을 판단한다. 자동 재전송이나 다른 pane 삭제로 복구하지 않는다.

모든 배치 변경은 정확한 pane·terminal ID와 request ID를 사용한다. 같은 MCP의 중복 요청은 다시 실행하지 않는다. 배치 확인·변경은 화면 분석 Worker를 호출하지 않는다. 조회 후 사용자가 배치를 바꾸는 상황까지 원자적으로 잠그지는 않는다.

## 번호와 수명

`1234 · 빌드`는 Herdr label이다. 명시적인 이름 변경에서 `numbered: true`를 사용하면 기존 번호를 유지하거나 현재 workspace에서 미사용 번호를 선택한다. 번호 없는 pane도 사용할 수 있고 조회만으로 번호를 붙이지 않는다. 중복 번호는 실제 ID·위치로 구분한다. 닫힌 번호의 이력·전역 고유성은 보장하지 않는다.

MCP는 자체 DB나 상시 core를 만들지 않는다. 중복 제출 기록과 분석 중 상태는 process 메모리에만 둔다. 같은 request ID의 다른 payload는 거부하고, ACK 유실·취소 후에는 입력을 재전송하지 않는다. MCP 재시작을 넘는 중복 억제는 제공하지 않는다. 재시작하면 목록·화면을 새로 확인한다. Herdr terminal은 Codex/MCP 종료 후에도 유지된다.

대화·완료 Job·화면·요약·명령 본문을 누적 보관하지 않는다. 중복 방지 기록은 최대 1만 건이며, 완료·실패·취소 후에는 상태·오류·정확한 ID·마지막 확인 위치만 유지한다. 최초 응답에는 기존 상세 결과가 있지만 중복 조회는 `details_retained: false`인 간소화한 결과다. 최신 배치는 `pane_layout`으로 확인한다. 기록을 자동 삭제하지 않으며, 한도에 도달하면 새 중복 방지 대상 변경 요청은 거부한다. 기존 요청 조회와 화면·목록 조회는 계속 가능하다. 재연결 전 미확정 작업을 확인하고 재연결 후 재탐색하며, 기존 명령을 재전송하지 않는다.

분석 Worker는 MCP 하나당 최대 2개다. 화면 수집 전에 슬롯을 확보하며 초과 호출에는 `worker_busy`를 반환한다. 대기 Job은 만들지 않는다. 분석 제한은 60초, 종료 대기는 5초다. 종료 실패·timeout이 발생하면 새 분석을 중단하고 `worker_cleanup_failed`를 알린다. MCP 종료 시 정리를 한 번 다시 시도하며, 종료가 확인되지 않은 프로세스가 종료됐다고 표시하지 않는다. 목록·입력 기능은 계속 사용할 수 있다.

## 개발과 legacy

`uv run pytest`, `uv run ruff check python tests`, `uv run mypy python`, `uv build`로 새 경로를 검증한다. 기존 TS는 Node 24에서 기존 test/typecheck/build를 유지한다.

기존 TS Console·Job·Action·Receipt·DB와 실행 명령은 보존한다. 새 기본 MCP가 이를 시작하거나 기존 core를 자동 종료하지 않는다. legacy 관리 방법은 [기존 운영 문서](operations-legacy.md), 새 결정은 [ADR 0005](adr/0005-simple-herdr-mcp.md)를 따른다. 기존 실행 중 core는 활성 입력을 확인한 뒤 별도로 정상 종료하며 terminal은 닫지 않는다.
