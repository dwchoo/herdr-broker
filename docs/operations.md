# Herdr 공유 terminal MCP

Python MCP는 현재 Herdr workspace의 pane을 조회하고 읽고 입력하며 이름을 바꾼다. 사용자와 Codex는 같은 terminal에서 작업한다. Console 시작·접속·등록·Mode 설정은 필요 없다. 승인 판단은 Parent Codex의 기존 정책을 따른다.

## 프로젝트 설정

Python 3.12 이상과 uv, 실행 중인 Herdr 0.9.0/protocol 22가 필요하다. Worker는 공식 `openai-codex` SDK와 함께 설치되는 Codex runtime, 기존 로컬 Codex 인증을 사용한다. Docker는 사용하지 않는다.

```sh
uv sync --locked
uv run herdr-broker setup --project .
```

setup은 `.codex/config.toml`의 Broker MCP 블록만 갱신하고 승인 설정은 바꾸지 않는다. 이 프로젝트의 실제 Herdr shell에서 새 Codex를 시작한 뒤 `$broker`를 호출한다. 개발 checkout은 `uv run --project <경로> herdr-broker mcp --project <경로>`로 실행한다. 패키지는 `uvx --from <wheel 경로 또는 버전 고정 Git URL> herdr-broker mcp --project <프로젝트 경로>`로도 실행할 수 있다. 아직 공개 registry에 배포했다고 가정하지 않는다.

Herdr 밖의 Codex는 환경 변수만 복사해도 사용할 수 없다. Herdr가 주입한 workspace·tab·pane·socket과 실제 shell의 프로세스 조상 관계를 확인한다. MCP 설정의 project 경로 아래에서 실행해야 한다. 기존 사용자 소유 `~/.config/herdr-broker/config.json`의 `herdr_socket`·`redaction_patterns` 설정은 사용할 수 있다. legacy `codex_binary`는 새 SDK runtime 선택에 사용하지 않는다.

## 사용 흐름

1. `$broker 현재 pane이 뭐야?` — workspace 전체의 tab·pane 이름과 실제 ID를 읽는다. 목록 조회는 화면 수집·분석·입력·이름 변경을 하지 않는다.
2. `1008 · 서버에서 상태 확인해줘` — Parent가 최신 목록과 대화 맥락에서 대상을 선택하고 사용자에게 알린다. 번호·이름이 불명확하면 후보와 위치를 확인한다.
3. `pane_read` — 출력 길이와 관계없이 `gpt-5.6-luna/high`가 화면만 분석한다. Worker는 파일·shell·MCP 도구를 사용하지 않는다. 사용자가 원문을 요청했을 때만 raw 읽기를 사용한다.
4. `pane_send` — Parent가 결정한 text·keys를 그대로 제출한다. Enter는 명시한 경우에만 보내며 SSH·shell·TUI를 같은 경로로 처리한다.
5. 화면을 다시 읽어 결과를 확인한다. ACK는 입력 접수이며 실행 완료·성공·exit code를 뜻하지 않는다.

대상 파일을 확인·편집·실행하는 작업은 옆 pane에 명령을 입력해서 수행한다. 사용자는 언제든 같은 terminal을 직접 사용할 수 있다. 화면 관찰과 입력 사이에 프로그램이나 사용자 입력이 바뀔 수 있으므로 Parent가 현재 화면을 확인한다.

## 번호와 수명

`1234 · 빌드`는 Herdr label이다. 명시적인 이름 변경에서 `numbered: true`를 사용하면 기존 번호를 유지하거나 현재 workspace에서 미사용 번호를 선택한다. 번호 없는 pane도 사용할 수 있고 조회만으로 번호를 붙이지 않는다. 중복 번호는 실제 ID·위치로 구분한다. 닫힌 번호의 이력·전역 고유성은 보장하지 않는다.

MCP는 자체 DB나 상시 core를 만들지 않는다. 중복 제출 기록과 분석 중 상태는 process 메모리에만 둔다. 같은 request ID의 다른 payload는 거부하고, ACK 유실·취소 후에는 입력을 재전송하지 않는다. MCP 재시작을 넘는 중복 억제는 제공하지 않는다. 재시작하면 목록·화면을 새로 확인한다. Herdr terminal은 Codex/MCP 종료 후에도 유지된다.

## 개발과 legacy

`uv run pytest`, `uv run ruff check python tests`, `uv run mypy python`, `uv build`로 새 경로를 검증한다. 기존 TS는 Node 24에서 기존 test/typecheck/build를 유지한다.

기존 TS Console·Job·Action·Receipt·DB와 실행 명령은 보존한다. 새 기본 MCP가 이를 시작하거나 기존 core를 자동 종료하지 않는다. legacy 관리 방법은 [기존 운영 문서](operations-legacy.md), 새 결정은 [ADR 0005](adr/0005-simple-herdr-mcp.md)를 따른다. 기존 실행 중 core는 활성 입력을 확인한 뒤 별도로 정상 종료하며 terminal은 닫지 않는다.
