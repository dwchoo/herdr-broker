# Pane 배치와 외부 로컬 Codex 지원

2026-09-16 사용자 후속 요청을 반영했다. 기존 여섯 도구에 `workspace_list`, `pane_layout`, `pane_split`, `pane_close`, `pane_swap`, `pane_move`, `pane_reorient`를 추가했다. 사용 계약은 [MCP 문서](../mcp.md), 사용 예시는 [운영 문서](../operations.md#pane-생성과-배치)를 따른다.

## 사용자 흐름

- `$broker 팬을 하나 만들어줘`: Herdr 안에서는 현재 Codex pane 오른쪽에 terminal을 만들고 번호를 붙인다. 아래쪽 분할도 지정할 수 있다.
- 배치 조회 후 같은 tab의 두 pane 위치를 교환하거나, 같은 workspace의 다른 기존 tab으로 terminal을 옮길 수 있다.
- 하나의 분할을 공유하는 두 pane은 좌우·상하로 전환할 수 있다. Herdr 0.9.0의 API 제약 때문에 두 번째 pane이 임시 tab을 거쳐 돌아오며, terminal·프로세스·순서·비율을 유지한다.
- pane 닫기는 실행 중인 작업을 종료할 수 있는 조작이다. 판단과 승인은 Parent Codex의 기존 정책을 따른다.
- 같은 Mac·OS 사용자의 Codex CLI·Desktop도 연결한다. 외부에서는 workspace 목록을 조회하고 명시적인 workspace ID로 tab·pane을 고른다. 별도 Console·등록·DB·승인 Mode는 추가하지 않았다.

## 실제 Herdr 검증

Herdr 밖의 현재 Codex 작업에서 production Python stdio MCP를 실행했다. `connection=local`로 workspace·tab·pane을 조회했고, 기존 `w2:p7`을 기준으로 테스트용 shell 두 개를 만들었다.

| 작업 | 확인 결과 |
| --- | --- |
| 오른쪽 분할·새 번호 부여 | 성공 |
| 아래쪽 분할 | 성공 |
| 상하 → 좌우 전환 | 성공 |
| 두 pane 위치 교환 | 성공 |
| 좌우 → 상하 전환 | 성공 |
| 다른 tab의 pane 옆으로 이동·돌아오기 | 성공 |
| 테스트 pane 두 개 닫기 | 성공 |
| 기존 pane·tab·terminal identity와 원래 배치 | 유지 |
| 이동·전환 전후 테스트 terminal ID와 shell PID | 동일 |

[실환경 acceptance script](../../acceptance/layout-herdr.py)는 새로 만든 pane만 정리하며, 기존 terminal에 명령을 입력하거나 닫지 않는다. tab 간 이동의 시험 준비에서는 테스트 pane 하나만 native `pane.move(new_tab)`으로 옮겼다. 실제 사용자 도구 검증은 공개 MCP로 수행했다. 화면 Worker는 배치 작업에 호출하지 않는다.

## 자동 검증

- Python 전체 테스트 68개 통과. workspace 선택, 외부 caller 없는 연결, 부분·빈 Herdr 환경값 거부, 이동 후 오래된 tab 환경값, 정확한 terminal identity, 생성·교환·종료·이동·방향 전환, 중복·취소·ACK 유실, 중간 실패와 동시 배치 변경을 포함한다.
- 기존 TS 테스트 261개와 typecheck·build 통과.
- ruff와 strict mypy 통과. wheel·sdist build 성공.
- 설치한 wheel을 `uv tool run`으로 실행해 외부 `check`의 `connection=local` 응답 확인.

검토 중 발견한 “회전 준비 중 요청된 terminal이 교체되면 새 terminal을 채택”하는 문제는 두 위치의 leaf에 대해 실패 테스트로 재현한 뒤 수정했다. 최초 요청의 terminal ID와 다시 비교해 실제 이동 전에 중단한다. 잘못된 focus·중복 pane metadata와 실제 pane 목록에 없는 leaf도 거부한다. 이동·교환 응답이 잘못되면 `unknown`으로 기록하고 재전송하지 않으며, 기존 terminal을 종료하지 않는 배치 도구와 pane 종료의 effect annotation을 구분했다.

최종 code-review는 Standards·Spec 두 축에서 미해결 사항 0건이다. 실제 변경 여부와 no-op 이유가 모순된 응답도 거부하며, 정상 `same_pane`·`same_tab` no-op은 유지한다.

## 한계와 실패 처리

방향 전환은 두 자식이 leaf pane인 분할에 적용한다. 복잡한 하위 그룹 전체를 재배치하거나 `layout.apply`로 terminal을 재생성하지 않는다. 중간 실패 시 임시 tab에 pane이 남을 수 있으며, 수행한 단계와 마지막으로 확인한 identity·위치를 반환한다. 불확실한 마지막 이동은 자동 재전송하지 않는다.

Herdr API는 여러 이동과 사용자 조작을 하나의 transaction으로 잠그지 않는다. MCP 내부의 배치 조작은 순서대로 실행하고 단계 사이 identity·배치 변경을 확인한다. 다른 Codex나 사용자와의 전역 잠금은 두지 않는다. 원격 컴퓨터·cloud ChatGPT 연결은 이번 범위 밖이다.
