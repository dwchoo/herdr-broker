# Herdr 공유 terminal MCP

Python MCP는 현재 Herdr workspace의 pane을 조회하고 읽고 입력하며 이름과 배치를 바꾼다. 사용자와 Codex는 같은 terminal에서 작업한다. Console 시작·접속·등록·Mode 설정은 필요 없다. 승인 판단은 Parent Codex의 기존 정책을 따른다.

## 실행 설정과 선택적 Skill

Python 3.12 이상 3.15 미만, uv/uvx, 로컬 Herdr와 Worker용 Codex 인증이 필요하다. Codex config.toml에 `command = "uvx"`, `args = ["--from", "git+https://github.com/dwchoo/herdr-broker.git@main", "herdr-broker", "mcp"]`를 등록한다. clone·setup·Skill 설치와 project/cwd 지정은 필요 없다. 전체 예시는 [README](../README.md)를 따른다.

checkout 개발은 `uv sync --locked` 후 `uv run herdr-broker mcp`를 사용한다. 다른 위치에서 checkout을 실행할 때 uv 자체의 `--project`는 사용할 수 있다. Broker의 `mcp/check --project`는 deprecated 호환 인자이며 프로젝트 경계를 검사하지 않는다. 상대 template 경로만 이전 기준을 유지한다. 새 상대 template 경로는 시작 cwd 기준이다.

`herdr-broker setup`은 현재 폴더의 `.agents/skills/broker/SKILL.md`에 선택적 호출 안내를 설치한다. 다른 대상은 `--directory`로 지정한다. Herdr·인증 없이 실행되며 config.toml을 수정하지 않는다. 동일 내용은 변경 없이 성공하고, 다른 내용과 symlink는 보존하며 충돌을 알린다. 예전 setup의 --project/--source/Worker 옵션은 이행 안내와 함께 거부한다. MCP는 Skill 존재를 검사하거나 자동 설치하지 않는다.

Herdr shell과 같은 Mac·OS 사용자의 외부 Codex CLI/Desktop을 지원한다. 외부에서는 workspace_list로 workspace를 선택한다. 내부 caller 자동 식별은 선택적인 HERDR env_vars 전달로 활성화하며 실제 프로세스 조상·socket·terminal identity를 검증한다. 환경값이 없으면 외부 연결, 일부만 있거나 불일치하면 오류다. 사용자 소유 `~/.config/herdr-broker/config.json`의 herdr_socket·redaction_patterns를 사용할 수 있다. 원격/cloud 연결은 포함하지 않는다.

## 사용 흐름

1. `Herdr 현재 pane이 뭐야?` — workspace 전체의 tab·pane 이름과 실제 ID를 읽는다. 목록 조회는 화면 수집·분석·입력·이름 변경을 하지 않는다.
2. `1008 · 서버에서 상태 확인해줘` — Parent가 최신 목록과 대화 맥락에서 대상을 선택하고 사용자에게 알린다. 번호·이름이 불명확하면 후보와 위치를 확인한다.
3. `pane_read` — 출력 길이와 관계없이 설정된 Worker 모델(기본 `gpt-5.6-luna`)이 화면만 분석한다. 기본 `purpose="analysis"`는 Luna/medium, `purpose="status"`는 prompt 복귀·미완성 입력·실행 중 여부를 Luna/low로 확인한다. status는 최근 8줄·1 KiB, analysis는 80줄·64 KiB를 기본으로 읽는다. 문맥이 부족하면 `max_lines`를 명시해 최대 1,000줄·64 KiB로 넓힌다. 명시적 effort 지정은 유지한다. 이번 관찰로 결정할 일을 기준으로 purpose를 명시한다. 새 명령 입력 전에는 현재 프로그램·prompt·미제출 입력 확인만 status로 요청한다. 사용자에게 답할 내용이나 실행 결과를 해석할 때 analysis를 사용한다. 기존 출력에서 답을 찾는 작업은 analysis로 수행하며, 이미 필요한 분석에서 현재 입력 상태도 확인됐다면 status를 추가로 반복하지 않는다. Worker는 파일·shell·MCP 도구를 사용하지 않는다. 사용자가 원문을 요청했을 때만 raw 읽기를 사용한다.
4. `pane_execute` — 실행할 명령과 Enter 하나를 같은 요청으로 보낸다. 입력만 하거나 TUI의 특정 키를 누를 때는 기존 `pane_send`를 사용한다. SSH 여부에 따라 별도 준비 절차를 두지 않는다.
5. 최신 확인이 필요한 때만 실행하고, 최근 화면을 다시 읽어 결과와 prompt 복귀를 확인한다. 이전 출력 재사용 시 그 결과가 현재 값이라고 추측하지 않는다. ACK는 입력 접수이며 실행 완료·성공·exit code를 뜻하지 않는다.

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

Parent 대화와 완료 Job 이력은 보관하지 않는다. 화면·질문·보고는 아래의 제한된 SDK 작업 문맥에만 유지하며 별도 이력이나 cache로 쌓지 않는다. 중복 방지 기록은 최대 1만 건이며, 완료·실패·취소 후에는 상태·오류·정확한 ID·마지막 확인 위치만 유지한다. 최초 응답에는 기존 상세 결과가 있지만 중복 조회는 `details_retained: false`인 간소화한 결과다. 최신 배치는 `pane_layout`으로 확인한다. 기록을 자동 삭제하지 않으며, 한도에 도달하면 새 중복 방지 대상 변경 요청은 거부한다. 기존 요청 조회와 화면·목록 조회는 계속 가능하다. 재연결 전 미확정 작업을 확인하고 재연결 후 재탐색하며, 기존 명령을 재전송하지 않는다.

검증된 MCP 시작 시 SDK 하나를 백그라운드에서 준비하며 모델은 호출하지 않는다. 목록·입력은 기다리지 않고, 준비 전 분석만 초기화를 기다린다. 정상 프로세스는 MCP 종료까지 유지하며 idle 종료나 누적 thread 생성 횟수에 따른 재시작은 없다.

같은 작업의 `analysis_id`는 workspace·pane·terminal에 결합된 작은 연결 기록이다. 매 `pane_read`는 새 thread에서 한 turn만 분석하고 이전 대화를 넣지 않는다. 완료 시 thread를 정리하며 `analysis_release`는 연결 기록을 해제한다. 연결 기록과 동시 분석은 각각 최대 2개, 기록은 5분 idle에서 만료된다. 같은 기록의 동시 호출은 거부하고 만료된 ID는 현재 대상을 확인한 뒤 새로 시작한다. SDK 프로세스는 유지한다. 화면 근거는 관찰 ID와 위치로 구분한다.

분석 60초·정리 대기 5초, 전역 알림 소비, 취소 시 interrupt와 종료 확인을 적용한다. RSS 512 MiB를 30초 간격으로 두 번 확인하거나 임시 폴더 128 MiB, 실제 loaded thread 64개에 도달하면 실행 중 분석을 마친 뒤 SDK만 교체한다. 종료가 미확인이면 새 SDK를 띄우지 않는다. 목록·입력·기존 중복 방지 기록과 Herdr terminal은 유지된다. 세부 계약과 검증은 [SDK 재사용](implementation/sdk-reuse.md)을 따른다.

## 개발과 legacy

`uv run pytest`, `uv run ruff check src tests`, `uv run mypy src`, `uv build`로 새 경로를 검증한다. 기본 설치·검증은 Python만 사용한다. TS 코드는 `legacy/typescript/`에 참조·복원용으로 보관하며 별도로 유지보수한다.

기존 TS Console·Job·Action·Receipt 코드, npm 설정·테스트와 옛 Node Skill 스크립트는 [legacy/typescript](../legacy/typescript/README.md)에 보관한다. 기존 DB·실행 데이터는 이동하거나 변환하지 않는다. 새 기본 MCP가 이를 시작하거나 기존 core를 자동 종료하지 않는다. legacy 관리 방법은 [기존 운영 문서](operations-legacy.md), 새 결정은 [ADR 0005](adr/0005-simple-herdr-mcp.md)를 따른다. 기존 실행 중 core는 활성 입력을 확인한 뒤 별도로 정상 종료하며 terminal은 닫지 않는다.

## 읽기 지연 확인

입력 전 확인과 내용 추출을 합쳐 analysis를 선택한 지연 사례 및 선택 기준은 [shell 상태 확인 지연](implementation/shell-status-latency.md)을 따른다. 기본 analysis는 API 호환성 값이며 모든 관찰에 권장하는 모드가 아니다.

`pane_read`의 `timings_ms`는 수집·SDK 준비 대기·thread 생성·turn 접수·첫 event 대기·나머지 stream·보고 검증·정리·최종 identity 확인과 전체 시간을 제공한다. 모델 서비스의 queue·입력 처리·추론 내부 시간은 SDK가 구분하지 않으므로 측정한 것처럼 표시하지 않는다. 실패 시에도 내용 없는 timing 진단을 stderr로 남긴다. 선택한 최근 범위가 부족하면 명시적으로 넓혀 관찰하며, 실제 delta는 만들지 않는다. 추가 근거 조회용 정제 화면만 최대 10분·16개·1 MiB 보관한다. 사용자가 원문을 요청한 raw 읽기는 기존 1,000줄 기본을 유지한다. 검증 방법과 결과는 [화면 분석 지연 개선](implementation/read-latency.md)을 따른다.

상태 확인의 입력 크기와 SDK token 수는 [status 입력 개선](implementation/status-input.md)을 따른다. `input_bytes`는 화면+목적만, `input_sizes`는 조립 prompt·schema·고정 지침을 구분해 보여 준다. SDK protocol 부가량은 이 bytes 합계에 포함되지 않으며, 실제 모델 입력은 `usage`를 확인한다. 독립 thread이므로 이전 turn은 다음 모델 입력에 포함하지 않는다.

## Worker 속도 선택

로그·출력 분석은 Luna/medium, 상태 확인은 Luna/low가 기본이다. 명시적 `effort="high"`도 사용할 수 있다. Fast는 기본으로 꺼져 있으며 `pane_read(service_tier="fast")`로 해당 호출만 켤 수 있다. 생략/null이면 MCP 시작 설정을 상속하고 `"default"`는 해당 호출에 표준 속도를 요청한다. 같은 analysis_id의 다음 호출에도 Fast가 자동 유지되지 않는다. 응답의 `service_tier_requested`는 요청값이며 실제 제공된 tier나 속도를 보장하지 않는다. 비용과 지연에 영향을 줄 수 있지만 입력 tokens를 줄이지는 않는다. 설계·검증과 추가 문맥의 구성은 [Worker service tier](implementation/service-tier.md)를 참고한다.

Worker에는 자동 Skill·앱·협업·권한 설명·실행 환경 블록과 사용자 설정의 추가 developer 지침·말투를 넣지 않는다. 권한 설명만 생략하며 실제 read-only·deny-all 제한은 유지한다. Worker 전용 임시 profile로 사용자 AGENTS·config 상속을 차단하고, 선택한 모델의 metadata에서 도구 노출을 제한해 도구 정의도 제외한다. 기존 Codex home의 file 인증(`auth.json`)과 `models_cache.json`이 필요하며 인증 값은 복사하지 않는다. 모델 cache가 없으면 Codex를 정상 시작해 갱신한 뒤 새 MCP를 실행한다. 종료 시 참조한 원본 파일은 삭제하지 않는다. 화면 1 KiB와 전체 모델 입력 1,000 tokens는 별도 측정값이다. 기존 Codex 인증과 도구 실행 제한은 유지한다.

## 2026-09-17: 독립 분석과 항목별 보고

후속 사용자 결정으로 SDK 프로세스만 재사용하고 매 호출 새 ephemeral thread에서 한 turn을 수행한 뒤 구독 해제한다. 기존 thread 문맥 재사용·8 turn·128 KiB 전환 설명은 이 변경으로 대체된다. analysis_id는 대상에 묶인 최대 2개의 작은 작업 연결 기록이며 5분 idle 만료·analysis_release를 유지한다. 이전 질문·화면·보고를 다음 분석에 넣지 않는다. 사용자 AGENTS·Skill·도구 정의와 환경 작업 지침 격리는 유지한다.

analysis는 Luna/medium, status는 Luna/low·8줄·1 KiB, Fast는 기본 off다. analysis의 requested_items로 필요한 항목 최대 6개를 지정하고 값·관찰/추정/미확인·근거를 받는다. Worker는 실행 계획이나 원문 복사를 하지 않고 Broker가 근거 위치 검증·원문 추출·중복 제거·예산을 처리한다. 기본 medium 모드에서 서술 최대 1,000자와 원문 최대 3,000자를 구분한다. 이전 analysis JSON 4 KiB 제한은 이 계약으로 대체된다.

화면 미보관 원칙의 한정된 예외로 성공 관찰의 정제된 화면을 최대 10분·16개·UTF-8 합계 1 MiB 보관한다. pane_excerpt는 같은 observation의 범위·literal 검색·cursor 추가 조회이며 Worker나 Herdr 수집을 호출하지 않는다. SDK 교체나 analysis_release와 독립적으로 만료·퇴출한다. 대화·보고·검색 세션은 누적하지 않는다. 현재 계약은 [계획](plans/worker-report-contract.md)과 [MCP 문서](mcp.md)를 따른다.

임시 파일 용량은 Worker 디렉터리에 실제 보관한 일반 파일을 합산한다. SDK가 설치된 실행 파일이나 기존 인증을 가리키는 symlink 대상 크기를 반복 합산하지 않는다. 이 측정 오류로 불필요한 SDK 교체가 발생하지 않게 한다.

## Worker 실행 설정

모델·effort·Fast·응답 길이·Markdown template과 GitHub uvx 실행은 [Worker 설정](implementation/worker-options.md)을 따른다. Luna/medium·Luna/low와 Fast off는 기본값이다. 호출에서 effort·tier를 생략하면 시작 설정을 상속한다. 사용자가 요청한 변경만 Main Agent가 명시한다. 현재 공개 main의 Python 구현 반영과 현재 MCP 전환은 별도 작업이다.

## Python 저장소 구조

`src/herdr_broker`가 설치되는 package이며 `tests/`와 `acceptance/*.py`가 Python 검증을 담당한다. `pyproject.toml`·`uv.lock`으로 의존성을 관리하고 `uv sync --locked` 후 개발한다. wheel·sdist는 Python 코드와 Markdown template을 포함하며 legacy·npm 파일·로컬 MCP 설정은 배포하지 않는다. `uvx` 실행에는 Node/npm 설치가 필요 없다. 실제 Herdr와 Codex file 인증·model cache 조건은 그대로 적용한다.

setup은 선택적 Skill만 설치한다. GitHub 실행은 README의 config.toml 예시로 등록한다. [구조 변경 검증](implementation/python-src-layout.md)에 로컬 Git 설치 결과와 공개 main 검증의 구분을 기록한다.
