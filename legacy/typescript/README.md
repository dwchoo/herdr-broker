# TypeScript 구현 보관

Python MCP 전환 이전의 Console·Job·Action·Receipt 구현을 향후 참조·복원용으로 보관한다. 기본 설치·실행·검증 대상은 루트의 Python package다.

- `src/`, `test/`: 기존 TS 코드와 테스트, PTY fixture.
- `package.json`, `npm-shrinkwrap.json`, `tsconfig.json`: 당시 Node 24/npm 의존성과 build 설정.
- `acceptance/`: TS 검증 스크립트와 전용 JSON fixture.
- `.agents/skills/*/scripts/run.mjs`: 기존 Node launcher 및 이전 skill 이름의 호환 launcher.

파일 내용은 이동 시 그대로 보존한다. 과거 운영 문서는 [operations-legacy](../../docs/operations-legacy.md), 계약은 [mcp-legacy](../../docs/mcp-legacy.md), 당시 결과는 [구현 기록](../../docs/implementation/)에 남아 있다. 과거 문서의 경로·명령·검증 결과는 당시 저장소 배치를 기준으로 한다.

이 디렉터리는 실행 호환성을 계속 보장하는 배포 제품이 아니다. 복원할 때는 Node 24 환경과 문서·출력·프로젝트 경로를 검토하고 별도로 검증해야 한다. 기존 데이터베이스·프로세스·terminal은 이동하거나 종료하지 않는다. Python 설치에 이 코드나 Node/npm은 필요 없다.
