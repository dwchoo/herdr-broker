# 단순한 Python MCP 구현 결과

2026-09-16. 구현 기준은 [ADR 0005](../adr/0005-simple-herdr-mcp.md)와 사용자 승인 계획이다. 사용 방법은 [운영 문서](../operations.md), 공개 interface는 [MCP 계약](../mcp.md)에 기록했다.

## 구현

- Python stdio MCP의 기본 interface는 `tab_list`, `pane_list`, `pane_read`, `pane_send`, `pane_rename`, `tab_rename` 여섯 개다.
- 현재 workspace metadata와 Herdr label을 직접 사용한다. Console 접속·등록·Mode·별도 DB는 새 경로에 없다. Parent의 승인 설정은 보존한다.
- Worker는 공식 `openai-codex==0.154.0` SDK와 bundled runtime을 사용한다. 화면 길이에 관계없이 `gpt-5.6-luna/high`를 호출하며, 사용자가 원문을 요청할 때만 raw 읽기를 사용한다.
- 실제 Herdr shell의 조상 관계·workspace·terminal identity를 확인한다. 요청 ID별 중복 제출 상태는 MCP process 메모리에 보관하며, 불확실한 전송을 재실행하지 않는다.
- 기존 TS Console·작업 목록·Action·Receipt 코드와 데이터는 보존했다. 기존 core나 pane을 종료하지 않았다. 기존 사용자 README 변경과 미추적 파일도 commit 대상에서 제외했다.

## 자동 검증

| 검증 | 결과 |
| --- | --- |
| Python 공개 MCP·stdio process·adapter·SDK 테스트 | 36개 통과 |
| `ruff check python tests acceptance` | 통과 |
| strict `mypy python` | 9개 source 파일 통과 |
| 기존 TS 테스트 | 261개 통과 |
| 기존 TS typecheck·build | 통과 |
| `uv build` | wheel·sdist 생성 성공 |
| 설치된 wheel의 `uv tool run` 실행·project setup | 성공, wheel source를 사용하는 MCP 설정 생성 |
| staged diff whitespace 검사 | 통과 |

SDK 테스트는 실제 bundled runtime과 로컬 Responses fixture를 연결했다. 요청 model·high effort·빈 tools 목록, provider의 강제 tool 호출 거부, 잘못된 보고서, timeout·취소·cleanup을 확인했다. process 테스트는 실제 stdio client를 사용하며, fixture 문맥 우회는 테스트 진입점에만 있다. production에서는 Herdr 외부 실행을 거부한다.

추가 회귀 검증은 잘못된 process 이름 metadata를 해당 row의 확인 실패로 표시하는지, 잘못된 read metadata를 Worker 호출 전에 거부하는지, 알려진 enqueue 거부와 ACK 유실을 구분하는지 확인한다.

## 실제 Herdr 확인

기존 Codex `w2:p7`의 실제 Herdr 환경과 기존 승인 정책에서 Python MCP를 실행했다. 공유 대상은 `1008 · 공유`, `w2:pF`, `term_65b918c64c9f93b`였다. 배치·tab·shell을 재생성하거나 이동하지 않았다.

1. 공개 `pane_list`에서 현재 pane과 정확한 identity를 조회했다.
2. 기본 `pane_read`의 실제 Luna/high 분석으로 shell 입력 대기를 확인했다.
3. 공개 `pane_send`로 새 `/tmp/herdr-simple-45ef3952001445218376cdb494686bad.sh`를 작성하고 `cat`으로 `echo before`를 확인했다.
4. 같은 pane에서 `sed`로 수정하고 `cat`으로 `echo after`를 확인했다.
5. 같은 pane에서 `sh`로 실행해 `after` 출력과 완료 marker를 확인했다.
6. 모든 단계의 결과를 실제 Luna/high 보고서와 출력 줄 근거로 확인했다. ACK만으로 완료를 판단하지 않았다. acceptance script도 출력·marker가 각각 근거에 있어야 통과하도록 검증한다.
7. 같은 label로 rename한 뒤 MCP를 종료·재시작했다. terminal ID와 번호·이름이 유지됐고 이전 명령을 재전송하지 않았다.
8. 기존 Codex가 새로운 `tab_list`·`pane_list`를 조회한 뒤 `100`과 “아까 파일 수정하던 공유 pane”을 현재 label·대화 맥락·identity를 근거로 `1008 · 공유`로 해석했다. 이 과정에서는 화면 읽기·입력·rename을 하지 않았다. 특정 후보 선택 규칙은 테스트에 넣지 않았다.
9. 최종 read metadata 검증 추가 후에도 입력 없이 실제 `pane_read`를 다시 실행했다. Luna/high가 `after` 출력과 현재 shell 입력 대기를 확인했다.

최초 acceptance는 Parent shell 도구의 sandbox에서 문맥 확인이 막혔고, 기존 on-request 승인 경로의 실행에서 통과했다. 환경값이나 승인 정책은 변경하지 않았다. 최초 모델 분석의 잘못된 evidence ID도 발견해, 실제 화면 줄 ID만 선택하는 output schema와 반환 시 재검증으로 보강했다.

## Standards

최종 재검토의 잔여 finding 0건. process metadata 오류, SDK 초기화·cleanup 오류, cleanup의 부분 성공 처리, legacy 문서 링크를 수정했다. 별도 code smell 지적은 없다.

## Spec

최종 재검토의 잔여 finding 0건. enqueue 거부 상태와 read metadata 검증을 보강했다. 사용하지 않는 process `pid`·`argv` 전체를 강제 검증하자는 의견은 최소 구현 범위에 맞춰 채택하지 않았다. 실제로 소비하는 이름과 caller shell identity는 검증한다.

## 적용과 한계

프로젝트 MCP 설정은 Python 진입점으로 갱신했고 기존 `approval_policy`를 보존했다. 이미 실행 중인 Codex의 MCP를 강제로 교체하지 않았으므로, Herdr 프로젝트 shell에서 새 Codex를 시작하면 `$broker`가 새 도구를 사용한다.

Herdr API는 terminal identity 확인과 입력을 하나의 원자적 요청으로 처리하지 않는다. 확인 직후 사용자가 프로그램이나 입력 상태를 바꾸는 상황까지 잠그지는 않는다. 중복 억제도 MCP 재시작을 넘지 않는다. 다시 연결하면 목록과 화면을 먼저 확인해야 한다.

MCP 자체에는 영속 DB가 없다. Codex SDK runtime은 분석별 임시 디렉터리에 내부 상태를 만들 수 있으며 정상 종료·취소 시 정리한다. Worker의 제공 도구가 없음을 검증했지만 동일 OS 사용자에 대한 hard isolation을 주장하지 않는다.
