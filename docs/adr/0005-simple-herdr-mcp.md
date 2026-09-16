# Herdr를 직접 연결하는 Python MCP

상태: 승인됨. 2026-09-16 사용자 계획을 구현 기준으로 삼는다.

## 결정

기본 실행 경로를 Python stdio MCP로 바꾼다. Herdr가 terminal과 이름을 유지하고, MCP는 현재 workspace의 tab·pane 조회, 화면 읽기, 텍스트·키 입력, 이름 변경을 제공한다. 실제 Herdr 프로젝트 shell의 부모 프로세스 관계와 terminal identity를 검증한다. 현재 workspace의 자기 자신·다른 agent pane도 탐색·조작 대상이다.

승인 판단은 Parent Codex에 맡긴다. MCP는 Codex의 설정을 수정하거나 별도 Mode·승인·소유권 정책을 만들지 않는다. 기존 ADR 0001–0004의 Console, 장시간 core, 영속 Control State는 보존한 TS legacy 경로에만 적용한다. 기존 CONTEXT.md의 Console·Job·Mode 용어 역시 legacy 모델이며 새 기본 경로의 전제 조건이 아니다.

번호는 `1234 · 빌드` 같은 Herdr label이다. 현재 workspace를 조회해 해석하며 별도 등록소는 두지 않는다. 번호 없는 pane도 그대로 사용할 수 있다. 번호를 붙이는 명시적 rename 요청에서만 미사용 번호를 선택하고 기존 이름을 유지한다. 동시에 붙인 번호나 사용자가 만든 중복 번호는 위치·실제 ID로 구분한다. 전역 영구 고유성·닫힌 번호의 재사용 금지는 보장하지 않는다. 불완전한 지칭은 Parent가 목록과 맥락으로 해석한다.

`pane_read`는 출력 길이에 관계없이 Codex Python SDK의 `gpt-5.6-luna/high` Worker로 분석한다. 사용자가 원문을 요청한 때만 direct 읽기를 사용한다. Worker는 전달된 화면만 읽고 파일·shell·MCP 도구를 사용할 수 없다. SDK의 runtime·취소·도구 제한을 실제 검증한다. 실패 시 raw나 다른 모델로 자동 대체하지 않는다.

입력은 정확한 text·keys를 한 번 제출한다. wrapper·Enter를 추가하지 않는다. ACK는 접수이며 완료 증거가 아니다. 같은 MCP process의 request ID에 대해 중복 제출을 막고, 다른 payload를 같은 ID로 보내면 거부한다. 불확실한 접수 결과와 취소 후에는 자동 재전송하지 않는다. 입력 이력은 메모리에만 있고 재시작을 넘는 중복 억제·복구를 보장하지 않는다.

## 수명과 범위

MCP와 분석 Worker는 호출한 Codex와 함께 종료한다. Herdr terminal은 독립적으로 유지된다. 다음 Codex는 목록과 화면을 새로 확인한다. pane 생성·분할·종료·이동, 예약 실행, 별도 관리 UI는 이번 범위에 없다. 기존 TS 코드와 DB는 삭제·변환하지 않고 보존한다.

## 검증

공개 MCP/process 테스트에서 여섯 tool, 조회의 무변경성, 짧은 출력의 Worker 사용, raw 요청, 대상 교체·종료, 중복·취소·ACK 유실, workspace 경계, 외부 실행 거부를 확인한다. 실제 Herdr에서는 기존 배치에서 목록, 공유 shell의 파일 출력·편집·실행, MCP 재시작 후 같은 label 발견을 확인한다. Python lint/typecheck/test·packaging과 기존 TS test/typecheck/build, 두 축 code-review를 마친 뒤 로컬 commit한다.
