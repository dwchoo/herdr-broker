# herdr-broker

**사용자와 Codex가 같은 Herdr terminal을 보면서 함께 작업하는 Python MCP server입니다.**

Codex가 pane을 찾고, 화면을 읽고, 명령이나 키를 입력합니다. SSH·로컬 shell·REPL·TUI를 같은 pane 흐름으로 다루며, 사용자는 그 terminal에 직접 입력할 수 있습니다. 실행 승인은 사용자와 대화하는 Codex의 정책을 따릅니다.

## 할 수 있는 일

- workspace·tab·pane 목록과 이름·위치 확인
- terminal 화면의 상태 확인, 로그 분석, 필요한 정보 추출
- 명령 실행과 텍스트·키 입력, 실행 후 화면 확인
- pane 생성·종료·이름 변경, 좌우·상하 분할, 위치 교환·다른 tab으로 이동
- 상태 확인용·내용 분석용 Worker 모델, effort, Fast, 응답 길이 설정

별도 Broker Console이나 pane 등록 절차는 없습니다. MCP가 종료되어도 Herdr terminal은 유지됩니다. 현재 지원 범위는 **같은 Mac·같은 OS 사용자로 실행하는 Herdr와 Codex CLI/Desktop**입니다.

## 준비 사항

| 항목 | 조건 |
| --- | --- |
| Herdr | 실행 중인 로컬 Herdr. 검증 환경은 0.9.0 / protocol 22 |
| uv / uvx | GitHub에서 Python package 설치·실행 |
| Git | Git source 설치에 필요 |
| Python | 3.12 이상, 3.15 미만 |
| Codex | 로컬 로그인과 Worker가 사용할 모델 접근 권한 |

Homebrew를 사용하는 Mac에서는 `brew install uv`로 uv와 uvx를 설치할 수 있습니다. 다른 방법은 [uv 설치 안내](https://docs.astral.sh/uv/getting-started/installation/)를 참고하세요.

Worker는 Codex SDK에 포함된 runtime과 기존 file 인증을 사용합니다. 기본 Codex home인 `~/.codex` 또는 `CODEX_HOME` 아래에 `auth.json`과 `models_cache.json`이 필요합니다. 파일이 없다면 Codex에서 정상 로그인·시작을 완료한 뒤 MCP를 다시 실행하세요. 인증 파일을 프로젝트에 복사할 필요는 없습니다. MCP 실행에 Node/npm이나 별도 API key는 요구하지 않습니다.

## 빠른 시작: GitHub + uvx

Codex의 `~/.codex/config.toml` 또는 프로젝트의 `.codex/config.toml`에 다음 설정을 추가하세요. 별도 clone·setup·Skill 설치는 필요 없습니다. Codex가 MCP를 시작하면 uvx가 패키지와 의존성을 준비하고 cache를 재사용합니다.

```toml
[mcp_servers.herdr_broker]
command = "uvx"
args = [
  "--from", "git+https://github.com/dwchoo/herdr-broker.git@main",
  "herdr-broker", "mcp"
]
```

설정을 읽는 새 Codex에서 “Herdr 현재 workspace와 pane을 보여줘”라고 요청하세요. 도구 사용 지침은 실행 중인 MCP가 제공합니다. Herdr 밖에서는 workspace를 먼저 선택합니다. 별도 Console은 필요 없습니다.

## Worker 인자를 포함한 설정

필요한 인자를 추가할 수 있습니다. 아래는 기본값을 명시한 예시입니다. 위 최소 설정과 **둘 중 하나만** 사용하세요.

```toml
[mcp_servers.herdr_broker]
command = "uvx"
args = [
  "--from", "git+https://github.com/dwchoo/herdr-broker.git@main",
  "herdr-broker", "mcp",
  "--analysis-model", "gpt-5.6-luna", # 내용 분석 모델: 로컬 Codex catalog에 있는 모델 ID
  "--analysis-effort", "medium", # 예: low, medium, high, xhigh (선택한 모델이 지원하는 값만)
  "--status-model", "gpt-5.6-luna", # 상태 확인 모델: 로컬 Codex catalog에 있는 모델 ID
  "--status-effort", "low", # 예: low, medium, high, xhigh (선택한 모델이 지원하는 값만)
  "--response-length-mode", "medium", # short, medium, long, auto (필요에 따라 medium 또는 long)
  "--fast-mode", "off" # off: 끔, analysis: 분석만, status: 상태 확인만, all: 둘 다 Fast 요청
]
enabled = true
```

Herdr 내부에서 현재 caller pane과 workspace를 자동 식별하려면 같은 MCP 블록에 다음 선택 설정을 추가합니다.

```toml
env_vars = [
  "HERDR_ENV", "HERDR_PANE_ID", "HERDR_WORKSPACE_ID",
  "HERDR_TAB_ID", "HERDR_SOCKET_PATH"
]
```

주입된 환경값이 없으면 로컬 외부 연결 방식으로 workspace를 선택합니다. 일부 값만 있거나 실제 caller와 불일치하면 오류로 처리합니다. 다른 pane의 환경값을 복사하지 마세요. Desktop에서 uvx를 찾지 못하면 `command -v uvx` 결과를 `command`에 지정하세요. [OpenAI MCP 설정 안내](https://learn.chatgpt.com/ko-KR/docs/extend/mcp)

## 사용 예시

다음은 **Codex 대화창에 입력할 요청**입니다. 번호는 실제 조회된 pane 번호로 바꿉니다.

```text
Herdr 현재 pane이 뭐야?
Herdr 내 오른쪽에 terminal 하나 만들어줘.
Herdr 1008 pane 이름을 서버로 바꿔줘.
Herdr 1008에서 OS, CPU, RAM 정보를 확인해줘.
Herdr 빌드 pane의 오류를 분석해줘.
Herdr 1008과 1234의 위치를 서로 바꿔줘.
Herdr 이 두 pane을 좌우 대신 위아래로 배치해줘.
```

`1008 · 서버` 같은 번호는 Herdr의 이름에 붙이는 별명입니다. Codex는 현재 목록과 대화 맥락으로 대상을 해석하고, 실제 작업에는 정확한 pane·terminal ID를 사용합니다. 닫히거나 교체된 pane을 다른 대상으로 조용히 대체하지 않습니다.

작업은 **화면 확인 → Codex의 판단 → 입력 → 결과 확인** 순서로 진행합니다. shell 명령은 `pane_execute`가 명령과 Enter 하나를 함께 보내며, TUI 키나 제출하지 않을 텍스트는 `pane_send`를 사용합니다. 입력이 접수됐다는 응답은 명령 완료를 뜻하지 않으므로 후속 화면으로 결과를 확인합니다.

입력 전 prompt·미완성 입력·실행 상태를 확인할 때는 `status`, 로그 해석이나 정보 추출에는 `analysis`를 사용합니다. 기본 읽기 범위는 각각 최근 8줄·1 KiB와 최근 80줄·64 KiB이며, 부족하면 agent가 범위를 넓혀 다시 읽습니다. 원문이 필요하면 “요약 말고 원문을 보여줘”라고 요청하세요.

### 주요 MCP 도구

| 작업 | 도구 |
| --- | --- |
| 목록 확인 | `workspace_list`, `tab_list`, `pane_list` |
| 화면 분석·근거 확인 | `pane_read`, `pane_excerpt` |
| 명령·키 입력 | `pane_execute`, `pane_send` |
| 이름 변경 | `pane_rename`, `tab_rename` |
| 생성·종료 | `pane_split`, `pane_close` |
| 배치 확인·변경 | `pane_layout`, `pane_swap`, `pane_move`, `pane_reorient` |
| 작업 연결 기록 해제 | `analysis_release` |

방향 전환은 분할 하나를 공유하는 두 leaf pane을 대상으로 합니다. 자세한 대상 검증·중복 제출·오류 처리 계약은 [MCP 문서](docs/mcp.md)를 참고하세요.

## 선택 사항: `$broker` Skill 설치

`$broker`라는 이름으로 요청하려면 **설치할 프로젝트 폴더에서** 다음 명령을 실행하세요. MCP만으로 사용한다면 생략합니다.

```sh
uvx --from git+https://github.com/dwchoo/herdr-broker.git@main \
  herdr-broker setup
```

현재 폴더의 `.agents/skills/broker/SKILL.md`에 짧은 호출 안내를 복사합니다. 다른 위치는 `setup --directory <프로젝트 경로>`로 지정합니다. Herdr·인증 없이 설치할 수 있으며 config.toml은 수정하지 않습니다. 기존 파일과 같으면 그대로 두고, 내용이 다르거나 symlink이면 덮어쓰지 않고 위치와 충돌을 알립니다. 설치 후 Skill이 보이지 않으면 새 Codex 세션을 시작하세요.

Skill은 상세 도구 규칙이나 모델 기본값을 복제하지 않습니다. 실제 지침은 실행 중인 MCP가 제공하며 Worker에 Skill을 전달하지 않습니다.

### 이전 설정에서 전환

기존 MCP 설정의 `--project`와 `cwd`는 제거할 수 있습니다. 상대 `--template-dir`를 쓰고 있다면 먼저 절대 경로로 바꾸세요. 새 상대 경로 기준은 MCP 시작 작업 디렉터리입니다. 기존 runtime의 `--project`는 당분간 호환 인자로 받아 상대 template 경로 기준만 유지하고 stderr에 안내합니다. 프로젝트 접근 경계는 설정하지 않습니다.

이전 `setup --source ... --project ...`와 Worker 인자는 더 이상 config를 생성하지 않으며 이행 안내와 함께 거부합니다. MCP 설정은 위 예시로 직접 작성하고, 선택적 Skill 대상은 `--directory`로 지정하세요.

## Worker 설정

Worker 시작 인자는 `mcp` 명령에 전달합니다.

| 인자 | 기본값 | 설명 |
| --- | --- | --- |
| `--analysis-model` | `gpt-5.6-luna` | 내용 분석 모델 |
| `--analysis-effort` | `medium` | 내용 분석 추론 수준 |
| `--status-model` | `gpt-5.6-luna` | 상태 확인 모델 |
| `--status-effort` | `low` | 상태 확인 추론 수준 |
| `--response-length-mode` | `medium` | `short`, `medium`, `long`, `auto` |
| `--fast-mode` | `off` | `off`, `analysis`, `status`, `all` |
| `--template-dir` | 내장 template | 사용자 Markdown template 디렉터리 |

모델은 로컬 Codex catalog에 있어야 합니다. effort는 SDK와 선택한 모델이 모두 지원하는 값이어야 하며, Fast도 모델 지원 여부를 확인합니다. 미지원 조합을 다른 모델이나 설정으로 자동 대체하지 않습니다.

- `--fast-mode analysis`: 내용 분석만 Fast 요청. `status`는 상태 확인만, `all`은 둘 다, `off`는 모두 표준 속도입니다. Fast 요청은 실제 속도 보장이 아닙니다.
- 시작 인자는 기본값입니다. 사용자가 요청하면 agent가 개별 `pane_read`의 `effort`·`service_tier`를 바꿀 수 있습니다. 명시적인 `service_tier="default"`는 해당 호출의 Fast를 끄고, 다음 호출에서 생략하면 시작 설정으로 돌아갑니다.
- 모델·길이 모드·template 등 시작 설정을 바꾸면 새 MCP를 시작해야 합니다.

### 응답 길이

| 모드 | 서술 상한 | 원문 근거 상한 |
| --- | ---: | ---: |
| `short` | 500자 | 1,500자 |
| `medium` | 1,000자 | 3,000자 |
| `long` | 2,000자 | 6,000자 |
| `auto` | medium 또는 long | 선택한 모드 기준 |

Unicode 문자 수 기준으로, tokens나 bytes가 아닙니다. `auto`는 평소 medium을 선택하고 필요한 경우 한 번의 분석 안에서 long을 선택합니다. 길이를 늘려도 화면 수집 범위가 자동으로 늘어나지는 않습니다. status의 작은 응답 계약은 그대로 유지합니다.

### Markdown 응답 template 편집

프로젝트 디렉터리에서 내장 template을 내보냅니다.

```sh
uvx --from git+https://github.com/dwchoo/herdr-broker.git@main \
  herdr-broker templates --output-dir ./worker-templates
```

생성된 `analysis.md`와 `status.md`에서 응답 우선순위·말투·요약 방식·예시를 편집하고, MCP 설정의 `args`에 다음 두 항목을 추가합니다.

```toml
# 기존 args 배열 안에 추가
"--template-dir", "worker-templates"
```

상대 경로는 MCP 시작 작업 디렉터리 기준입니다. 전역 설정에서는 절대 경로를 권장합니다. 각 파일은 비어 있지 않은 UTF-8 Markdown이며 최대 8 KiB입니다. 기존 파일은 내보내기로 덮어쓰지 않습니다. 수정 내용은 다음 MCP 시작부터 적용됩니다. JSON 구조·길이 상한·근거 검증·도구 제한은 코드가 관리합니다. 내장 파일은 [analysis.md](src/herdr_broker/resources/analysis.md), [status.md](src/herdr_broker/resources/status.md)에서 확인할 수 있습니다.

Worker는 매번 독립 thread에서 전달받은 화면만 분석합니다. SDK 프로세스는 재사용하지만 이전 분석 대화와 사용자 AGENTS·Skill 목록·도구 정의를 Worker 입력에 넣지 않습니다.

## 업데이트와 문제 해결

GitHub main의 새 버전을 받을 때 다음 명령으로 cache를 갱신하고 새 MCP를 시작합니다. 평소 config의 실행 인자에는 `--refresh`를 넣지 않습니다.

```sh
uvx --refresh --from git+https://github.com/dwchoo/herdr-broker.git@main \
  herdr-broker --help
```

MCP와 사용 지침은 같은 패키지 버전으로 갱신됩니다. uvx는 매 실행마다 최신 main을 확인한다고 보장하지 않습니다. 기존 MCP는 자동으로 재시작되지 않습니다.

연결 확인은 아래 명령을 실행합니다. `check`는 로컬 Herdr 연결과 주입된 caller 문맥을 확인하며, Worker 모델 호출까지 검사하지는 않습니다.

```sh
uvx --from git+https://github.com/dwchoo/herdr-broker.git@main \
  herdr-broker check
```

| 증상 | 확인할 내용 |
| --- | --- |
| `$broker`가 보이지 않음 | 선택적 setup으로 설치한 Skill 경로를 확인하고 새 Codex 시작 |
| MCP 도구가 보이지 않음 | 프로젝트 `.codex/config.toml`, `uvx` 실행 경로, MCP 시작 오류 확인 |
| `herdr_context_required` / `herdr_context_mismatch` | 실제 Herdr shell에서 시작하거나, 외부 Codex에서는 복사한 Herdr 환경값을 사용하지 않는지 확인 |
| `worker_auth_unavailable` / `worker_model_catalog_unavailable` | Codex file 인증·model cache와 선택 모델을 확인한 뒤 새 MCP 시작 |
| `worker_effort_unsupported` / `worker_fast_unsupported` | 선택 모델이 지원하는 effort·tier로 시작 설정 또는 사용자 요청 조정 |
| `worker_busy` / `worker_recycling` | 진행 중인 분석 또는 SDK 준비가 끝난 뒤 다시 관찰 |

MCP는 terminal을 소유하거나 이전 입력을 자동 재전송하지 않습니다. 재접속하면 현재 pane과 화면을 다시 확인합니다. 동작·자원 제한은 [운영 문서](docs/operations.md)에 정리되어 있습니다.

## 개발

```sh
git clone https://github.com/dwchoo/herdr-broker.git
cd herdr-broker
uv sync --locked
uv run herdr-broker check

uv run pytest
uv run ruff check src tests
uv run mypy src
uv build
```

checkout 개발에서는 `uv run herdr-broker mcp`로 로컬 코드를 실행합니다. config.toml에 개발 경로를 연결하려면 uv 자체의 `--project <checkout 경로>`를 사용할 수 있습니다. Broker의 프로젝트 경계 설정과는 별개입니다.

```text
src/herdr_broker/       Python MCP와 Worker, 내장 template
tests/                 Python 테스트
acceptance/            Python 검증 스크립트
docs/                  운영·MCP 계약·설계와 검증 기록
.agents/skills/broker/  project Skill
legacy/typescript/     이전 Console·Job·TS 구현 보관
pyproject.toml         package·CLI·개발 도구 설정
uv.lock                고정 의존성
```

기존 TypeScript 구현은 [legacy 보관 안내](legacy/typescript/README.md)를 따릅니다. Python 설치·기본 검증·배포에는 포함되지 않습니다.

## 개발 workflow와 초기 설계 기록

아래는 이 저장소에서 사용하던 개발 workflow와 초기 MVP 기록입니다. 현재 설치·실행 방식은 위 안내와 [MCP 계약](docs/mcp.md)을 기준으로 합니다.

## Codex와 Matt workflow

Codex의 저장소 지침은 [AGENTS.md](AGENTS.md)에 있다. Codex는 실행을 시작할 때 저장소의 지침 파일을 읽으므로, 새 작업을 시작하면 이 설정을 사용한다. 자세한 규칙은 [OpenAI 공식 문서](https://learn.chatgpt.com/docs/agent-configuration/agents-md)를 참고한다.

이 저장소는 Codex의 SetupMatt plugin에서 제공하는 workflow를 기준으로 구성했다. GitHub 작업에는 인증된 `gh` CLI와 `dwchoo/herdr-broker` 접근 권한이 필요하다.

| 설정 | 내용 | 문서 |
| --- | --- | --- |
| Issue tracker | GitHub Issues | [issue-tracker.md](docs/agents/issue-tracker.md) |
| Triage labels | 기본 역할 이름 5개 | [triage-labels.md](docs/agents/triage-labels.md) |
| Domain docs | `single-context`, 루트 `CONTEXT.md`와 `docs/adr/` | [domain.md](docs/agents/domain.md) |

SetupMatt에는 설정 workflow와 `triage`가 포함된다. Triage는 요청할 때 실행하며, 이 규칙을 사용하는 `to-tickets`, `to-spec`, `wayfinder` 같은 Matt workflow도 같은 설정 문서를 참조할 수 있다. 이 설정 파일은 해당 skill 자체를 설치하지 않는다.

설정을 바꿀 때는 `docs/agents/*.md`를 직접 수정한다. Tracker 전환이나 초기화가 필요하면 SetupMatt 설정을 다시 실행할 수 있다.

## 제품 배경

[Herdr 계층형 Pane Agent Broker 개념서](docs/herdr_hierarchical_pane_agent_broker_concept_brief_ko.md)는 PRD 이전 단계의 제품·기술 초안이다. Domain 용어와 설계 결정이 확정되면 `CONTEXT.md`와 ADR에 기록한다.

## MVP 구현 준비

- [MVP spec: Codex 기반 Herdr Pane 진단과 3단계 Action Mode](https://github.com/dwchoo/herdr-broker/issues/12)가 구현 계약과 acceptance의 기준이다. [로컬 spec 본문](docs/specs/mvp-codex-pane-broker.md)도 함께 보존한다.
- [MVP 구현 ticket 목록](docs/plans/mvp-tickets/README.md)에 12개 ticket과 선행 의존성, acceptance 담당을 정리했다. 첫 구현은 [Codex Parent에서 Herdr pane의 bounded context 읽기](https://github.com/dwchoo/herdr-broker/issues/13)부터 시작한다.
- [MVP 설계 결정 map: Codex 기반 SSH pane 진단과 3단계 행동 정책](https://github.com/dwchoo/herdr-broker/issues/1)은 설계 질문과 선행 실험을 완료했다. 개념서 작성 이후의 결정 근거는 이 map에 연결되어 있다.
- 공통 domain 용어는 [CONTEXT.md](CONTEXT.md)에 기록한다.
- 설계 결정과 runtime·품질 실험의 결과, 제품에서 확인할 acceptance는 [MVP spec 인계](docs/mvp-spec-handoff.md)에 정리했다. 개념서의 후보 schema와 항상 Worker를 거치는 경로를 그대로 구현하지 않는다.
