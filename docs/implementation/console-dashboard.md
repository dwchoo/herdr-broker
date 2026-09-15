# Broker Console 실시간 상태판

2026-09-16. 사용자가 승인한 구현 계획이다. 같은 tab의 기존 Console 조작 pane에서 Parent와 소유 Target의 연결 관계, 진행 상황, 사용자 조작을 확인한다.

## 화면과 조작

- interactive TTY는 고정 위치를 갱신하는 상태판을 기본으로 한다. 좁은 화면은 Parent → Console → 선택한 Target, 승인·보류 요약과 도움말을 우선하고, 넓은 화면은 pane 목록과 최근 이벤트를 함께 표시한다. resize와 한글·Unicode 표시 폭을 처리한다.
- 연결선은 소유 범위다. pane별 Job·Worker 분석·Action 상태는 별도로 표시하며 headless Worker를 pane으로 표현하지 않는다. Parent 끊김, pane 종료·이동·교체, 확인 실패와 마지막 확인 시각을 구분한다.
- 현재 관찰과 일치하는 Pane Session만 Mode를 표시한다. 문맥이 바뀌었거나 아직 확인하지 않은 세션은 `확인 필요`다. 입력 접수와 완료 관찰을 구분하며 unknown을 성공으로 표현하지 않는다.
- `↑↓` 선택, `Enter` 상세, `a` 승인 검토, `m` Mode 선택, `n` terminal 추가, `l` 이벤트, `:` 기존 명령 입력, `?` 도움말, `Esc` 돌아가기를 제공한다. 긴 상세와 정확한 실행 입력은 스크롤한다. 자동 갱신이 선택·입력·검토 대상을 바꾸지 않는다.
- 승인 화면은 특정 proposal의 정확한 입력·대상·위험 근거를 고정해 보여 준다. 사용자가 명시적으로 승인·거절하고 기존 digest·세션·Mode·만료 검증을 통과해야 한다. Mode 변경은 현재 세션을 확인한 후 적용한다. 기본 Mode 2, 사용자만 상향, 실제 interactive Console 권한을 유지한다.
- 단축키와 기존 명령은 같은 처리 경로를 사용한다. bracketed paste는 단축키나 승인으로 실행하지 않는다. 상세 화면에도 외부 문자열의 제어문자를 이스케이프한다.
- 사용자 Mode 변경의 현재 세션 확인이 진행 중이면 해당 세션의 Action 제출을 보류한다. 확인을 기다리는 동안 이전 승인으로 입력이 먼저 전송되지 않도록 intent 직전과 socket write 직전에 검사한다.

## 구현 계약

- Core의 typed read model과 TUI를 분리한다. MCP 초기화 후 검증한 Parent를 기록하고 `console_status`에 Parent·controller 식별 정보를 추가한다. 기존 필드와 JSON 명령 응답은 호환된다.
- 내부 상태는 1초, Herdr metadata는 2초 간격으로 갱신하며 중복 요청과 불필요한 다시 그리기를 피한다. metadata observer는 실행 경로와 별도로 유지한다. 상태판은 Job·Worker·Snapshot을 만들거나 Pane Session·승인·예산을 변경하지 않는다.
- 최근 상태 변경은 메모리에서 최대 50개만 보관한다. 영속 Receipt는 기존 ledger에서 상세 화면으로 제공한다. 재접속·재시작이 명령을 재전송하지 않는다.
- Node TTY와 `string-width` 8.2.2로 구현한다. `serve <console_id> --format json`, non-TTY, `TERM=dumb`은 기존 JSON 출력을 사용한다. 정상 종료·signal·처리 가능한 오류에서 raw mode, cursor, alternate screen을 복원한다.
- 기존 pane·tab과 사용자 변경을 보존한다. 화면 개선을 위해 `layout.apply`, pane 재생성·이동을 하지 않는다. 실행 중인 core는 자동 재시작하지 않고 다음 실행부터 새 화면을 사용한다.

## 완료 조건

1. 실제 PTY에서 한글·좁은 화면·resize·선택 및 입력 보존·붙여넣기·terminal 복원을 검증한다.
2. 공개 MCP와 process/adapter 경계에서 Parent 재접속, 여러 Target, 이동·종료·확인 실패와 승인·보류·완료 표시를 검증한다.
3. proposal 만료·Mode·세션 변경 후 오래된 검토를 거부하고 상태판 조회에 실행·예산 소비가 없음을 확인한다.
4. 기존 JSON 테스트와 전체 테스트, typecheck, build, Skill validation, Standards·Spec review를 수행한다. 새 변경만 로컬 commit한다.

## 검증 결과

Node 24.19.0에서 다음 검증을 통과했다.

| 검증 | 결과 |
| --- | --- |
| `node node_modules/typescript/bin/tsc --noEmit` | 통과 |
| `node node_modules/typescript/bin/tsc` | 통과 |
| `node --test test/*.test.mjs` | 235개 통과, 실패·skip 0개 |
| `herdr-broker` project Skill의 `quick_validate.py` | 통과 |
| Standards / Spec code-review | 미해결 지적 각각 0건 |

- 실제 PTY의 27·56·100열, 5행 화면, resize, 한글·emoji 폭과 UTF-8 기록, 선택·명령 보존, 긴 proposal 검토 및 붙여넣기를 확인했다. 종료 후 raw mode·cursor·alternate screen 복원과 정상 process 종료를 검증했다.
- 공개 MCP와 격리된 Herdr native protocol fixture에서 Parent 검증·재접속·terminal 교체 거부, 여러 Target, 이동·종료·metadata 실패, Mode 확인 필요, 50개 이벤트와 32개를 넘는 활성 Job·승인 목록을 검증했다.
- 실제 child shell의 명령 완료·exit 0과 unknown 보류, core 재시작 후 영속 Receipt·보류 보존 및 입력 재전송 방지를 확인했다. 오래된 Mode·세션·만료된 Job으로 승인을 받지 못하며, Mode 변경 확인 중에도 기존 승인으로 입력이 전송되지 않는다.
- 상태 조회만으로 Snapshot·Job·Worker 생성이나 실행·예산 소비가 발생하지 않는지 확인했다. 기존 JSON 명령과 non-TTY·`TERM=dumb`·명시적 JSON의 호환성도 통과했다.
- 메모리 제한 테스트의 가상 foreground PID는 실제 테스트 프로세스 PID와 겹치지 않게 생성한다. Console 자체 조작 방지와 기존 회귀 검증은 유지한다.

검증은 격리된 process/adapter/PTY에서 수행했다. 사용 중인 Herdr pane 배치와 실행 중인 Console은 변경하거나 재시작하지 않았다. 새 상태판은 다음 Console 실행에 적용된다. 기존 사용자 변경은 commit 대상에서 제외했다.
