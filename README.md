# herdr-broker

## Python MCP

사용자와 Codex가 같은 Herdr terminal에서 작업하는 Python MCP server다. 구현은 `src/herdr_broker`, 테스트는 `tests`, 이전 TS Console·Job 구현은 [legacy 보관 안내](legacy/typescript/README.md)에 있다.

```sh
uv sync --locked
uv run herdr-broker setup --project .
```

새 Codex에서 `$broker`를 사용한다. 설치·인증 조건은 [운영 문서](docs/operations.md), 모델·effort·Fast·응답 길이·template 인자는 [Worker 설정](docs/implementation/worker-options.md)을 따른다.

GitHub main에 Python 변경을 반영한 뒤 다음처럼 실행할 수 있다. 이번 작업은 로컬 준비이며 아직 push하지 않았다.

```sh
uvx --from git+https://github.com/dwchoo/herdr-broker.git@main \
  herdr-broker mcp --project /absolute/path/to/project
```
