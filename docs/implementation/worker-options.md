# uvx 실행과 Worker 설정

2026-09-17 승인 계획. 구현 시작점은 `0987930`이다. 범위는 로컬 구현·검증·commit이며 GitHub push는 제외한다. 현재 공개 main에 Python 패키징이 없으므로 원격 반영 전에는 아래 주소로 새 MCP를 설치할 수 없다.

## 실행 인자

| 인자 | 기본값 | 허용값/역할 |
| --- | --- | --- |
| --analysis-model | gpt-5.6-luna | analysis 모델 |
| --analysis-effort | medium | SDK enum 및 모델 지원 목록 검증 |
| --status-model | gpt-5.6-luna | status 모델 |
| --status-effort | low | SDK enum 및 모델 지원 목록 검증 |
| --response-length-mode | medium | short / medium / long / auto |
| --fast-mode | off | off / analysis / status / all |
| --template-dir | 내장 파일 | analysis.md, status.md 디렉터리 |

두 purpose는 하나의 SDK 프로세스를 사용하며 매번 독립 thread를 만든다. 지정한 모델만 격리 catalog에 넣고 도구 노출을 차단한다. 모델·effort·Fast가 지원되지 않으면 오류로 알리며 자동 대체하지 않는다. 시작 인자가 기본값이고, 사용자가 변경을 요청한 경우에만 Main Agent가 호출별 effort·service_tier를 명시한다. 생략/null은 시작 설정을 상속하고 명시적인 default tier는 그 호출의 Fast를 끈다. 사용자 요청 판단은 Main Agent의 책임이며 MCP 승인 정책을 추가하지 않는다.

## GitHub와 설정 생성

Worker 인자는 config.toml의 mcp 실행 인자로 직접 지정한다. setup은 선택적 Skill 설치만 수행한다. uvx cache는 업데이트할 때 --refresh로 재검증한다.

```toml
[mcp_servers.herdr_broker]
command = "uvx"
args = [
  "--from", "git+https://github.com/dwchoo/herdr-broker.git@main",
  "herdr-broker", "mcp",
  "--analysis-model", "gpt-5.6-luna", "--analysis-effort", "medium",
  "--status-model", "gpt-5.6-luna", "--status-effort", "low",
  "--response-length-mode", "medium", "--fast-mode", "off"
]
env_vars = ["HERDR_ENV", "HERDR_PANE_ID", "HERDR_WORKSPACE_ID", "HERDR_TAB_ID", "HERDR_SOCKET_PATH"]
```

참고: [uv tools](https://docs.astral.sh/uv/guides/tools/). 갱신 예시는 `uvx --refresh --from git+https://github.com/dwchoo/herdr-broker.git@main herdr-broker --help`다. 공개 반영은 이번 범위 밖이므로 로컬 Git source와 임시 프로젝트에서 설치·실행을 검증한다. 현재 프로젝트의 실행 중 MCP·설정·terminal은 전환하지 않는다.

## 응답 길이와 template

analysis의 서술/근거 상한은 short 500/1500자, medium 1000/3000자, long 2000/6000자다. 항목 이름을 서술에 포함하며 Unicode 문자 수와 tokens·bytes를 구분한다. 개수 제한은 유지하고 필드별 문자열 상한은 medium의 절반/두 배로 한다. auto는 한 번의 모델 호출에서 medium 또는 long을 선택하고 해당 한도를 검증한다. 재분석·자동 재시도·서술 잘라내기는 하지 않는다. status 계약·수집 범위·pane_excerpt 한도는 바꾸지 않는다.

`herdr-broker templates --output-dir <directory>`로 analysis.md와 status.md를 내보낸다. 인증·Herdr·project가 필요 없고 기존 파일을 덮어쓰지 않는다. --template-dir 상대 경로는 시작 cwd 기준이며 deprecated runtime --project를 명시한 기존 호출만 이전 기준을 유지한다. 파일당 UTF-8 8 KiB 이내의 비어 있지 않은 Markdown을 시작 때 한 번 읽는다. 수정은 다음 MCP 시작부터 적용한다. 내용 우선순위·말투·예시만 편집하며 schema·길이 상한·도구 제한은 코드가 유지한다. 해당 purpose의 파일만 전달하며 AGENTS·Skill·Parent 대화·링크 문서를 자동 로드하지 않는다.

## 검증과 완료

CLI 기본값·오류·설정 보존, 모델별 catalog와 capability, Fast 상속·변경, 길이 경계·auto 1회 호출, template 오류·재시작·package resources를 검사한다. 실제 SDK+로컬 모의 provider에서 두 모델의 같은 PID·도구 격리·정리를 검증한다. 로컬 Git uvx 설치와 별도 프로젝트 MCP smoke를 실행하고 Python test/ruff/mypy/build, TS 회귀, Standards·Spec review 후 변경분만 commit한다. 아래에 실행 결과를 기록했다.

### Template 편집 예시

```sh
uvx --from git+https://github.com/dwchoo/herdr-broker.git@main \
  herdr-broker templates --output-dir ./worker-templates
```

두 Markdown 파일을 편집한 뒤 config의 MCP 실행 args에 `"--template-dir", "worker-templates"`를 추가한다. 상대 경로는 `--project` 디렉터리 기준이며, 새 MCP부터 읽는다. 개발 checkout에서는 `uv run herdr-broker templates --output-dir ./worker-templates`로 먼저 사용할 수 있다.

`--fast-mode analysis`는 내용 분석만 Fast를 요청한다. 사용자가 특정 호출에서 표준 속도를 원하면 Main Agent가 `service_tier="default"`를 전달하고, 추론 수준 변경을 원하면 `effort="high"`처럼 명시한다. 이후 생략된 값은 시작 설정으로 돌아간다. 지원하지 않는 조합은 오류이며 대체 모델·tier로 전환하지 않는다.

## 검증 결과 (2026-09-17)

- Python: `pytest -q` **175 passed, 1 skipped**. 35분 soak는 기존 선택 실행 검사이며 이번 설정 변경에서는 재실행하지 않았다. `ruff check python tests`, `mypy python` 통과.
- 실제 고정 SDK + 로컬 모의 provider: 서로 다른 purpose 모델이 같은 PID를 사용하고 low/medium/high 및 priority/default 요청이 정확히 전달됨을 검증했다. auto의 medium/long 선택마다 모델 호출은 한 번이다. 사용자 template만 선택적으로 전달하고 AGENTS·도구 정의는 제외했다. SDK 교체 후에도 시작 때 읽은 template을 유지하며 종료 시 자식·임시 폴더가 정리된다. 이 검사는 실제 유료 모델의 응답 품질·속도를 측정한 것이 아니다.
- Python 전체 검사 첫 실행에서 테스트 준비용 PID 파일이 비어 있는 순간 읽히는 경합이 발생했다. fixture의 파일 게시를 원자적인 rename으로 바꾼 뒤 전체 재검사가 통과했다. 제품의 SDK 종료 코드는 변경하지 않았다.
- wheel·sdist build 성공. 두 Markdown template의 포함을 확인했다.
- 별도 임시 Git main을 `uvx --from git+file://...@main`으로 설치하여 `--help`, MCP 인자 도움말, template 내보내기, source 설정 생성이 성공했다. 별도 임시 프로젝트에서 설치된 MCP가 실제 Herdr의 workspace 1개를 조회했고 16개 도구와 시작 설정 설명을 반환했다. 모델 turn·terminal 입력·배치 변경은 수행하지 않았다. 로컬 검증 경로는 `/private/tmp/herdr-options-uvx-j5_4x9kd`다.
- TS legacy: Node 24의 `npm test` **261 passed** (build 포함), `npm run typecheck` 통과.
- 공개 GitHub main 설치는 로컬 검증과 구분한다. 이번 작업에는 push가 없으며 공개 main에 Python 변경을 반영한 뒤 별도 검증해야 한다. 현재 프로젝트 MCP 설정·실행 중 MCP·사용자 terminal은 유지했다.

### Standards review

기준 `0987930` 대비 구현·신규 파일 검토에서 수정이 필요한 위반 0건. 사용자 README와 무관한 파일은 제외했다.

### Spec review

미해결 사항 0건. auto에서 medium 필드별 한도가 모델에 전달되지 않는 점을 발견해 지침에 명시했고 재검토로 해결을 확인했다. medium과 long 모두 단일 호출 및 선택한 계약으로 검증된다.
