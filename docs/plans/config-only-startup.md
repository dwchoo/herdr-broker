# config.toml 실행과 선택적 Skill 설치 정리

상태: 구현·검증 완료. 계획 당시 setup은 MCP 설정을 생성하고 mcp/check --project가 필수였다. 아래 목표 동작으로 변경했으며 [검증 기록](../implementation/config-only-startup.md)에 결과와 실제 확인 범위를 기록한다.

## 목표

사용자는 config.toml에 GitHub uvx 실행 명령만 등록해 MCP를 사용한다. 별도 clone·setup·Skill은 기본 실행의 전제 조건이 아니다. `setup`은 `$broker` 호출을 원하는 사용자를 위한 선택적 Skill 설치 명령으로 전환한다.

## 1. 문서와 Parent 지침

- README를 기본 config → 자연어 사용 예시 → Worker 인자 → 선택적 Skill → 업데이트 순서로 정리한다. 현재 추가한 인자별 `#` 주석과 사용자 변경을 보존한다.
- 운영 문서와 MCP 계약에서 필수 프로젝트 경계·config 생성 설명을 변경한다. ADR 0005의 프로젝트 shell 전제를 이번 변경과 구분해 갱신한다.
- 기본 지침의 기준은 MCP server instructions와 tool description이다. 기존 Skill의 실행 전 status, 결과 analysis, exact identity, ACK와 완료 구분, 사용자 요청에 따른 설정 변경 규칙을 대조해 누락을 보완한다.
- 선택적 Skill에는 MCP를 찾아 사용하고 해당 MCP의 지침을 따르라는 짧은 안내만 둔다. 저장소 상대 링크·모델 기본값·세부 도구 계약은 중복하지 않는다.
- Parent용 지침은 화면 분석 Worker에 전달하지 않는다. 기존 Worker 격리를 유지한다.

## 2. 경로 없는 MCP 실행

목표 최소 설정:

```toml
[mcp_servers.herdr_broker]
command = "uvx"
args = [
  "--from", "git+https://github.com/dwchoo/herdr-broker.git@main",
  "herdr-broker", "mcp"
]
```

- `mcp`와 `check`는 프로젝트 인자 없이 실행한다. Context에서 프로젝트 보관과 매 호출 cwd 경계 검사를 제거한다.
- 기본 실행에는 config의 `cwd`가 필요 없다. cwd는 pane 선택이나 pane shell의 작업 디렉터리를 의미하지 않는다.
- 상대 `--template-dir`는 MCP 시작 시 작업 디렉터리를 기준으로 한 번 해석한다. 전역 설정에서는 절대 template 경로를 권장한다.
- 기존 실행 설정을 깨뜨리지 않도록 `mcp/check --project`는 deprecated 호환 인자로 당분간 받는다. 프로젝트 접근 경계를 만들지 않으며, 기존 상대 template 경로 해석만 유지한다. 사용 시 stderr로 새 설정을 안내한다. 신규 예시에서는 제외한다.
- Herdr socket 소유권·연결, 내부 caller 프로세스 관계와 실제 terminal identity 검증은 유지한다. Herdr 밖에서는 workspace를 명시적으로 선택한다.
- `env_vars`는 Herdr 내부 caller 식별용 선택 설정으로 별도 설명한다. 문맥 변수가 없으면 외부 연결 방식으로 동작하고, 일부만 있거나 불일치하면 기존처럼 오류를 반환한다.
- setup 실행 여부와 Skill 존재 여부로 MCP 시작을 막거나 파일을 자동 생성하지 않는다.

## 3. setup을 선택적 Skill 설치로 전환

```sh
uvx --from git+https://github.com/dwchoo/herdr-broker.git@main \
  herdr-broker setup
```

- 기본 설치 대상은 현재 디렉터리의 `.agents/skills/broker/SKILL.md`다. 다른 프로젝트를 지정할 때만 `setup --directory <path>`를 사용한다. 프로젝트 루트를 자동 추측하지 않는다.
- Herdr 연결·Codex 인증·Worker 초기화 없이 설치한다. config.toml과 승인 설정은 읽거나 수정하지 않는다.
- Skill 원본은 Python package resource에 하나만 유지하고 wheel·sdist에 포함한다. 캐시 경로를 symlink로 연결하지 않고 파일을 복사한다. 저장소의 활성 Skill과 같은 내용인지 검증한다.
- 같은 내용이면 재실행은 변경 없이 성공한다. 다른 내용·기존 symlink·부적절한 파일이 있으면 보존하고 경로와 충돌 이유를 알린다. 자동 덮어쓰기·업데이트 명령은 이번 범위에 추가하지 않는다.
- 동시 설치 시 기존 내용을 덮어쓰거나 불완전한 Skill을 남기지 않도록 게시한다.
- 이전 setup의 `--source`·Worker 인자·`--project` 조합은 변경 전에 거부하고, MCP는 config.toml에 등록하며 Skill 대상은 `--directory`로 지정하라는 이행 안내를 제공한다. 이전 config 생성 동작으로 조용히 실행하지 않는다.
- 설치 결과에 경로와 변경 여부를 표시하고, 현재 Codex에서 Skill이 보이지 않으면 새 세션을 시작하도록 안내한다. 기본 MCP 사용에는 재설치가 필요 없다.

## 4. 구현 순서

1. README·운영 문서·MCP 계약에 목표 동작과 기존 사용자 이행 절차를 기록한다.
2. CLI의 runtime 인자와 Context를 분리하고 프로젝트 경계 검사를 제거한다. Worker 옵션과 상대 template 호환 처리를 연결한다.
3. 패키지 Skill resource와 setup 설치 경로를 구현한다. 이전 config 생성 코드는 새 기본 경로에서 제거한다.
4. MCP 지침을 기존 Skill과 대조하고 짧은 선택적 Skill로 정리한다.
5. process·CLI·패키징 테스트 및 acceptance 스크립트를 갱신하고 설치된 배포물로 검증한다.

## 5. 검증과 완료 조건

- 임시 Git 저장소를 source로 별도 프로젝트에서 uvx를 실행한다. editable 설치나 PYTHONPATH 없이 CLI·check·MCP initialize와 tools/list를 검증한다.
- `--project`·config cwd·Skill 없이 실제 로컬 Herdr workspace/pane metadata 조회가 성공한다. Skill 없는 Parent의 도구 선택·status/analysis 구분은 별도 실제 시나리오로 확인한다. 서버 테스트만으로 agent의 판단을 보장했다고 보고하지 않는다.
- Herdr 내부 환경 전달, 외부 workspace 선택, 불완전한 환경·caller/terminal 교체 거부를 확인한다.
- setup의 신규 설치·동일 파일 재실행·사용자 편집 보존·symlink 거부·동시 설치를 확인한다. 기존 config.toml이 byte 단위로 유지되는지 검증한다.
- wheel·sdist에서 Skill과 analysis/status template이 로드되며 설치된 Skill에 끊어진 저장소 링크가 없다.
- 기존 Worker 모델·effort·Fast·응답 길이 인자와 template 경로, deprecated runtime 인자, 이전 setup 인자의 오류 안내를 검증한다.
- Python 전체 테스트, `ruff check src tests`, `mypy src`, wheel·sdist build와 Standards·Spec review를 수행한다. legacy TS는 수정하지 않는다.
- 공개 GitHub 검증은 원격 반영 후 수행한다. 로컬 Git source 검증을 공개 main의 검증으로 보고하지 않는다.

변경분만 로컬 commit하며 push는 별도 요청으로 진행한다. 실행 중 MCP·사용자 terminal·기존 config는 자동 재시작하거나 수정하지 않는다.
