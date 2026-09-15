# Codex와 공유 terminal을 같은 tab에 배치

2026-09-16. 사용자는 Codex와 대화하면서 옆 terminal을 함께 보고 직접 작업할 수 있어야 한다고 정정했다. 별도 Herdr workspace나 tab으로 나누는 기존 배치는 이 요구를 만족하지 않는다.

## 구현 계약

- 실제 Herdr 실행 문맥으로 검증한 Parent Pane을 기준으로 같은 tab 안에 pane을 split한다. Parent 옆에 Target terminal을 만들고 그 아래에 작은 사용자 조작 pane을 둔다. 기존 Parent pane은 유지한다.
- `console_open`은 workspace나 tab을 새로 만들지 않는다. 조작 pane의 `new`도 같은 tab의 등록된 Target을 split해 terminal을 추가한다.
- Console 등록 정보는 workspace·tab·controller·Target의 pane 및 terminal 식별자를 기록한다. 읽기·Job·Action은 등록된 Target에만 허용한다. 같은 tab의 Parent나 미등록 pane은 대상이 아니다.
- 재접속할 Parent도 해당 Console과 같은 tab에서 실행해야 한다. 다른 tab에서 접속하거나 연결한 Parent가 이동하면 Broker 호출을 거부한다. 기존 연결이 있다면 해제해 미제출 작업을 중지한다.
- 위치는 gateway의 호출 전후와 core의 Action 제출 직전에 검사한다. 대기 중 이동이 감지되면 결과를 전달하지 않고 미제출 작업을 중지한다. gateway는 검증된 Parent pane ID를 내부 MCP 연결의 capability에 결합한다. 이는 동일 OS 사용자에 대한 인증 수단이 아니며, Herdr 이동과 입력을 원자적으로 잠그지는 않는다.
- Target이나 controller를 다른 tab으로 옮기거나 terminal을 교체하면 기존 소유권을 자동 갱신하지 않는다. Action 직전에도 tab을 포함한 mapping을 재검증한다.
- Codex의 정상·비정상 종료 뒤에도 core와 terminal은 유지한다. 같은 tab에서 새 Codex가 같은 Console에 붙어 Receipt와 hold를 확인하고 새 Job으로 이어간다. 명령 재전송이나 자동 Ctrl-C는 없다.
- `quit`는 core만 중지한다. 사용자는 필요한 pane을 직접 닫는다. 다른 작업이 함께 있을 수 있으므로 Console 종료를 위해 workspace 전체를 닫도록 안내하지 않는다.
- 첫 Target을 닫아도 `new`는 남아 있는 유효한 등록 Target을 split한다. 닫히거나 이동·교체된 Target은 새 소유권으로 채택하지 않는다. 유효한 Target이 모두 없으면 추가를 거부한다.
- 이전 tab 정보 없는 Console 기록과 실행 중인 pane은 보존한다. 자동 이동·가져오기 없이 `console_layout_upgrade_required`를 반환하며, 새 Console은 수정된 배치로 연다.

기존 project 전용 Skill, Herdr 실행 검증, 기본 Action Mode 2, 사용자만 모드 상향, Console별 Control State와 단일 Parent 규칙을 유지한다. [ADR 0006](../adr/0006-console-in-parent-tab.md)이 이전 workspace 배치 결정을 정정한다.

## 완료 조건과 검증

실제 27열 Target에서 `recent` 출력이 자동 줄바꿈을 포함해 완료 marker를 둘로 나누는 문제가 재현됐다. 같은 native API의 `recent_unwrapped`는 온전한 marker를 반환했다. Action의 baseline과 완료 관찰에만 이 source를 사용하고 응답 source를 엄격히 확인한다. 진단 Snapshot의 `recent` source, nonce와 단일 완료 row 검증, 이전 unknown Receipt·hold는 유지한다.

이미 합의한 공개 MCP 도구, 사용자 console, 실제 process와 Herdr adapter 경계를 사용한다.

1. `console_open`이 기존 Parent와 같은 tab에 Target·controller를 만들고 `new`도 같은 tab에 추가한다.
2. 미등록 pane, 다른 Console, 이동·교체된 Target과 다른 tab의 Parent 접근을 거부한다. 거부된 Action은 terminal에 입력을 보내지 않는다.
3. 같은 tab의 재접속과 core 재시작에서 terminal·Receipt·hold가 유지된다.
4. 실제 Herdr에서 Codex와 terminal이 같은 tab의 split pane으로 존재하고 Broker의 `echo` 완료를 확인한다.
5. 관련 회귀 테스트, typecheck, 전체 테스트, Skill validator와 Standards·Spec review를 완료한다.

기존 사용자 변경과 실행 중인 terminal은 보존하며 변경한 파일만 local commit한다.

## 검증 결과

- 공개 MCP와 실제 PTY console에서 최초 생성·`new`·재접속, Target·Parent·controller의 tab 이동 차단, 닫힌 첫 Target 이후 추가를 검증했다.
- Code review에서 대기 중 이동, Action intent 직전 검증, attach 응답 전 검증과 남은 Target 선택을 보완했다. 코드의 Standards·Spec 잔여 finding은 각각 0건이다. 아래 운영 실수와 구분한다.
- Typecheck, Skill validator와 전체 테스트 **217개**가 통과했다.
- 실제 Codex가 `w2:t1`의 Parent `w2:p1`에서 Console을 열고, `new`로 추가한 같은 tab의 `w2:p6`에서 `echo "hello world beside Codex"`를 실행했다. Receipt `492bb537-d9d4-437c-87cf-f231eefb0e20`은 `accepted`·`completion_observed`·exit 0이었다. 정상 종료와 core 재시작에서도 이전 Receipt와 unknown hold가 유지됐다.
- 처음 27열 출력에서 발생한 `outcome_unknown`은 성공으로 바꾸지 않았다. Action의 source만 수정해 새 실행으로 완료 관찰을 검증했다.

### 화면 정리 중 발생한 운영 실수

검증 후 화면을 정리하던 agent가 native `layout.apply`에 기존 pane ID를 넣으면 pane을 재배치한다고 잘못 판단했다. 이 호출은 `w2:t1`을 제거하고 새 tab `w2:t3`와 새 terminal을 만들었다. 기존 tab의 shell·Codex pane·해당 controller가 종료됐다. 이는 구현 계약의 기존 pane 보존을 지키지 못한 운영 실수이며, 기존 shell process를 복구했다고 주장하지 않는다.

기존 Console `2ffeca2d-3f83-4bfd-896f-20cd48e86bee`의 등록 정보·Control State·unknown hold는 삭제하거나 다른 terminal에 연결하지 않았다. 기존 Codex 대화는 resume하고, 이번 실수로 생성된 빈 pane만 정리했다. `공유 작업` tab에서 새 Parent `w2:p7`이 project Skill로 새 Console `fda1cd6e-a7b3-4b17-8d2a-3b9766e567c3`을 열어 공유 Target `w2:pC`와 controller `w2:pD`를 같은 tab에 준비했다. 별도 workspace `w13`의 기존 Console과 `w2:t2`의 legacy controller는 유지했다.

제품의 생성·추가 경로는 `pane.split`만 사용한다. live tab의 pane을 보존해야 하는 작업에는 `layout.apply`를 사용하지 않는다.

최종 `공유 작업` Console에서 실제 Codex가 실행한 `echo "hello world"`는 Receipt `569d2221-71d1-4cf9-bc1a-a362670883ee`의 `accepted`·`completion_observed`·exit 0으로 확인했다. Parent는 연결을 유지하고 새 Console의 hold는 0건이다. [구조화된 검증 기록](same-tab-broker-console-results.json)에 최종 ID와 운영 실수를 함께 기록했다.
