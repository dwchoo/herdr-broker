# config.toml 실행과 선택적 Skill 설치 검증

구현 기준: [계획](../plans/config-only-startup.md). 시작 commit은 `d30416a35825560ab650e2f230ce54930f039cc6`이다.

## 변경

- `mcp/check`는 project·cwd 지정 없이 로컬 Herdr에 연결한다. Context의 프로젝트 필드와 매 호출 cwd 경계 검사를 제거했다. socket과 caller/terminal 검증은 유지한다.
- 기존 `--project`는 deprecated runtime 인자로 받아 상대 template 경로만 호환한다. 새 상대 template 경로는 시작 cwd 기준이다.
- `setup`은 현재 디렉터리 또는 `--directory` 아래에 package resource의 짧은 Skill을 복사한다. 인증·Herdr 없이 동작하고 config.toml을 수정하지 않는다.
- 동일 내용은 재실행해도 변경하지 않는다. 다른 내용·symlink·비정규 파일을 보존하고 이유와 대상 경로를 반환한다. 열린 directory descriptor와 no-follow 검증, 완성 파일의 원자적 hard-link 게시로 기존 파일을 교체하지 않는다. 임시 파일은 정리한다.
- 상세 Parent 지침은 MCP instructions와 tool description에 유지한다. 선택적 Skill에는 저장소 상대 링크·모델 기본값을 넣지 않는다. Worker의 입력 격리는 변경하지 않았다.
- README는 config-only 시작과 자연어 요청을 기본으로 설명하며, Worker 인자별 주석과 선택적 Skill·이행 절차를 제공한다.

## 자동 검증

- Python 전체 테스트: **185 passed, 1 skipped**. 생략은 별도 활성화하는 35분 SDK soak다.
- `ruff check src tests`, `mypy src`, `git diff --check`: 통과.
- `uv build`: wheel·sdist 생성 성공. Skill resource와 기존 Markdown template을 포함하며 legacy/Node 파일은 제외된다.
- 설치 신규/반복/충돌, config byte 보존, managed symlink 거부, 동시 16회 설치에서 게시 1회, 인증·Herdr 없는 CLI 설치를 검증했다.
- deprecated runtime template 경로, cwd 기준 template 경로, 이전 setup 인자 거부, project 없는 check 및 기존 MCP/SDK 회귀를 검증했다.
- 최초 sandbox 실행은 Unix socket 생성 권한 제한으로 실패했다. 필요한 실행 권한에서 전체 테스트를 다시 수행해 위 결과를 얻었다.

## Git source와 실제 Herdr

현재 소스를 별도 임시 Git 저장소에 저장하고 다른 임시 프로젝트에서 `uvx --from git+file://... herdr-broker ...`를 실행했다. child에서 PYTHONPATH와 VIRTUAL_ENV를 제거했다.

- `mcp --help`, `check`, MCP initialize와 tools/list 성공: 16개 도구.
- Skill·project 인자·MCP config cwd 없이 실제 Herdr workspace 1개와 pane 2개를 조회했다. 시작 작업 디렉터리만 임시 폴더로 지정해 저장소 밖 실행을 확인했다.
- 목록 확인 시 Worker 인증이 없는 환경을 사용해도 조회가 성공했다. 모델 turn·화면 캡처·terminal 입력은 수행하지 않았다.
- 조회 이후 선택적 setup의 신규/반복 실행과 template 내보내기가 성공했다. config.toml은 생성되지 않았다.
- 공개 GitHub main은 이번 변경을 push하기 전이므로 새 사용법에 대한 공개 주소 검증은 아직 수행하지 않았다.

## Skill 없는 Parent 확인

별도 임시 Codex home에 기존 인증과 model cache만 연결하고, Skill이 없는 프로젝트에서 실제 Codex를 실행했다. MCP의 목록 도구만 허용했다.

- 이벤트에서 `workspace_list`와 `pane_list` 호출 및 성공을 확인했다. shell 명령 실행 이벤트는 없었다.
- Parent가 workspace 1개·pane 2개를 보고했다.
- MCP 지침을 읽고 prompt·미제출 입력 확인에는 `status`, 로그 오류 분석에는 `analysis`를 선택한다고 설명했다.
- 이 검증은 실제 목록 도구 선택과 purpose 구분 판단을 확인한다. 화면 분석·명령 실행 전체 흐름이나 모든 자연어 요청에서의 agent 준수를 보장하는 검증은 아니다.

## Review

- Standards: config 생성 제거로 새로 미사용이 된 `WorkerOptions.arguments()`를 삭제했다. 재검토 미해결 0건.
- Spec: 설치 오류에 이유가 누락되는 문제를 수정했다. 내용 차이·symlink·비정규 파일·OS 오류를 구분하며 재검토 미해결 0건.

기존 사용자 변경·실행 중 MCP·terminal·config를 유지했다. 이번 변경은 새 MCP 시작부터 적용하며 GitHub push는 별도 단계다.
