# Python src 구조와 uvx 설치 준비

2026-09-17 승인 계획. 시작점은 `c6a2508`이며 로컬 구현·검증·commit까지만 수행한다.

## 변경 계약

- Python package를 `src/herdr_broker`로 옮기고 기존 `pyproject.toml`·`uv.lock`과 Python 버전·의존성·CLI·MCP 계약을 유지한다.
- TS 소스·테스트·npm 설정·TS acceptance·전용 fixture·Node Skill launcher를 `legacy/typescript/`에 참조·복원용으로 보관한다. 기본 실행·검증·Python 배포에는 포함하지 않는다.
- 루트에는 Python 테스트와 acceptance를 유지한다. checkout 판별과 packaging 경로를 수정하며 임시 프로젝트 Git uvx 설치가 editable 경로나 PYTHONPATH에 의존하지 않는지 검증한다.
- 문서와 Skill을 먼저 갱신한다. 사용자 README 변경은 보존하고 이번 안내만 commit한다. 과거 문서·실행 데이터·실행 중 MCP·terminal은 유지한다.
- GitHub push는 제외한다. 공개 main 검증은 원격 반영 후 별도 수행한다.

## 완료 검증

Python test·ruff·mypy·wheel/sdist build, checkout setup 및 사용자 설정 보존, 두 Markdown resource 포함과 legacy 제외, 로컬 Git uvx CLI·template·설정 생성·MCP 초기화·metadata 조회를 확인한다. Standards·Spec review 후 변경분만 commit한다. 결과는 아래에 기록한다.

## 검증 결과 (2026-09-17)

- `uv sync --locked` 성공. Python 의존성·버전 범위와 lockfile은 유지했다.
- `uv run pytest -q`: **176 passed, 1 skipped**. 35분 SDK soak는 기존 선택 실행 테스트로 이번 경로 정리에서는 실행하지 않았다.
- `uv run ruff check src tests`, `uv run mypy src` 통과. `src` 레이아웃에서 달라진 import 분류를 해당 테스트 파일에 반영했다.
- checkout 판별 회귀 테스트에서 `uv run --locked --project ...`와 Worker 인자 생성, 반복 실행, 기존 승인·다른 MCP 설정 보존을 확인했다.
- TS 자산 **84개 파일**을 원본 commit과 byte 단위로 비교해 내용 보존을 확인했다. legacy는 보관용이므로 TS 실행 테스트는 기본 검증에서 제외했다.
- wheel·sdist build 성공. 최초 sdist 검사에서 비고정 `src` 포함 패턴이 legacy의 `src`까지 포함하는 문제를 발견했다. Hatch의 `only-include`로 루트 경로를 한정한 뒤 wheel 21개·sdist 46개 항목에서 두 Markdown template 포함과 TS·legacy·Node manifest·로컬 설정 제외를 확인했다.
- 별도 임시 Git main을 uvx로 설치했다. CLI 도움말·MCP 인자 도움말·template 내보내기·명시적인 source 설정 생성이 성공했다. PYTHONPATH·VIRTUAL_ENV를 제거한 환경에서 uv cache의 설치된 site-packages를 import하는 것을 확인했다.
- 임시 프로젝트에서 설치된 MCP 초기화·도구 16개·실제 Herdr workspace 1개 조회를 확인했다. 모델 turn이나 pane 입력·배치 변경 없이 metadata만 조회했다. 검증 경로: `/private/tmp/herdr-src-uvx-3mokvegf`.
- 현재 checkout의 MCP 설정과 사용 중 terminal은 변경하지 않았다. README의 기존 사용자 문단은 작업 트리에 보존하고 이번 Python 안내만 commit 대상으로 분리했다.
- GitHub push와 공개 main URL 설치 검증은 수행하지 않았다. 원격 반영 후 별도로 확인한다.

### Standards review

기준 `c6a2508` 대비 staged 변경에서 수정이 필요한 위반·code smell 0건.

### Spec review

승인된 구조·보관·패키징·설정 보존 요구에 대한 미해결 사항 0건.
