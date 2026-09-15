# MVP A01–A32 검증 근거

2026-09-15. Node 24.19.0/macOS arm64, Herdr 0.9.0/protocol 22, Codex CLI 0.154.0, `gpt-5.6-luna`/low 기준이다. 제품 public MCP/실제 interactive console을 주 경계로 삼는다. 프로토타입 결과를 제품 검사의 대체 근거로 사용하지 않는다.

## 실행 환경 구분

- **Public/process**: 실제 Broker·MCP socket·console PTY·SQLite·Worker process adapter, 통제된 Herdr/provider protocol peer. 전체 suite 185 tests pass.
- **Native local/SSH**: 실제 Herdr의 새 disposable workspace. SSH는 key-only localhost OpenSSH와 `/bin/sh -i`; 원격 cwd와 key는 테스트 소유 영역이다. AI runtime/credential을 SSH에 설치하지 않는다.
- **Actual models**: 실제 Codex Parent/Worker. 품질 reference Parent는 도구 없는 비교 호출, 설치 검증 Parent는 설치 executable의 MCP를 사용한다.
- **Fault**: 소유 proxy에서 ACK/표식/부분 입력·IPC 유실을 주입한 경우를 명시한다. 자연 발생한 장애나 임의 원격 host 전체의 보장으로 확대하지 않는다.

## Matrix

| ID | 결과와 환경 | 실행 근거 |
| --- | --- | --- |
| A01 | 설치·native SQLite·실제 Parent/facade handshake와 10 tools 통과 | [설치 결과](issue-23-installed-acceptance.json), [설치 runner](../../acceptance/installed-operations.mjs) |
| A02 | 실제 Parent→MCP→native pane passive 진단, 입력 0 통과 | [첫 연결](issue-13-acceptance.json), [설치 결과](issue-23-installed-acceptance.json) |
| A03 | 다른 owner의 job/Evidence/receipt 거부, facade 종료 뒤 core·제출 관찰 유지 통과 | [Evidence](../../test/evidence-delta.test.mjs), [recovery](../../test/recovery.test.mjs), [process](../../test/process.test.mjs) |
| A04 | 4 KiB 경계·explicit Worker·작은 auto 0회 통과 | [Worker](../../test/worker.test.mjs), [경계](../../test/evidence-delta.test.mjs), [실제 비교](issue-22-quality-results.json) |
| A05 | 1000행/64 KiB·UTF-8·gap/mapping·상충 출력 보존 통과 | [MCP](../../test/mcp.test.mjs), [확장 품질](issue-22-diagnosis-quality.md) |
| A06 | ANSI/CR/control·private key/token/literal pattern·중복을 provider 전 redaction 통과 | [MCP](../../test/mcp.test.mjs), [Worker](../../test/worker.test.mjs), [실제 Worker](issue-15-acceptance.json) |
| A07 | 실제 Worker four-field 직접 schema/bytes/ID 검증 통과 | [Worker 결과](issue-15-acceptance.json), [최종 비교](issue-22-quality-results.json), [strict bounds](../../test/worker.test.mjs) |
| A08 | malformed/없는 Evidence 1회 repair·재실패/timeout/cancel typed failure·raw fallback 0 통과 | [Worker 실제 process adapter](../../test/worker.test.mjs) |
| A09 | 실제 제한 profile·도구/파일/socket 차단·canary 미노출, 소유 process group 종료 통과 | [실제 profile 결과](issue-15-acceptance.json), [profile runner](../../acceptance/worker-profile.mjs), [lifecycle](../../test/worker.test.mjs) |
| A10 | immutable Evidence/owner/만료·2 KiB 페이지·UTF-8 continuation 통과 | [Evidence](../../test/evidence-delta.test.mjs), [실제 Parent](issue-15-parent-acceptance.json) |
| A11 | 두 소비자 cursor 독립·replace/unchanged·재전송 Snapshot ID 유지 통과 | [Delta suite](../../test/evidence-delta.test.mjs) |
| A12 | 반복/추가 Evidence/Action 포함 16 KiB 정확한 byte 누적·초과 중지 통과 | [Delta](../../test/evidence-delta.test.mjs), [자동 실행](../../test/automatic-modes.test.mjs), [실제 비용 비교](issue-22-diagnosis-quality.md) |
| A13 | mode 1 미승인 읽기/변경 입력 0, 승인 뒤 단일 제출 통과 | [승인](../../test/actions.test.mjs), [실행](../../test/execution.test.mjs), [native SSH](issue-24-ssh-profile-results.json) |
| A14 | 새 session mode 2·저위험 자동/고위험·불명·잘못된 평가 승인 대기 통과 | [mode suite](../../test/automatic-modes.test.mjs), [native SSH](issue-24-ssh-profile-results.json), [실제 Parent uncertainty 차단](issue-24-installed-parent-initial.json) |
| A15 | mode 3의 disposable 고위험 삭제 실행, scope/취소/예산/hold 우회 차단 통과 | [mode suite](../../test/automatic-modes.test.mjs), [native SSH](issue-24-ssh-profile-results.json) |
| A16 | 상향·Approval 위조·pipe 권한 거부, console escaped payload 확인 통과 | [승인](../../test/actions.test.mjs), [SSH 준비](../../test/ssh-profile.test.mjs), [native SSH](issue-24-ssh-profile-results.json) |
| A17 | TTL·철회·재사용·payload/operation/session/job/revision 변경과 before-wire 무효 입력 0 통과 | [승인](../../test/actions.test.mjs), [실행](../../test/execution.test.mjs) |
| A18 | mode 세션 유지·감지된 SSH/PID/argv/mapping/endpoint 변경 시 stale 0·새 mode2 통과 | [continuity](../../test/session-continuity.test.mjs), [native local](issue-21-local-acceptance.json), [native SSH](issue-24-ssh-profile-results.json), [SSH 이동/IPC](issue-24-ssh-recovery-results.json) |
| A19 | local literal quoting/cwd/env/exit/subshell 비지속·TUI/REPL 거부, 확인된 SSH POSIX 통과 | [실행](../../test/execution.test.mjs), [native local](issue-17-local-acceptance.json), [SSH 준비](../../test/ssh-profile.test.mjs), [native SSH](issue-24-ssh-profile-results.json) |
| A20 | accepted/observing과 실제 exit 분리, unknown/null 유지 통과 | [실행](../../test/execution.test.mjs), [SSH fault](issue-24-ssh-recovery-results.json) |
| A21 | echo/stale/중복/부분행·잘린 표식은 완료 아님, truncation 별도 유지 통과 | [실행](../../test/execution.test.mjs), [실제 SSH+표식 fault](issue-24-ssh-recovery-results.json) |
| A22 | 동시/반복 submit 1회·늦은 ACK·모호/부분 reply unknown·보충 입력 0 통과 | [실행](../../test/execution.test.mjs), [recovery](../../test/recovery.test.mjs), [실제 SSH+부분 입력 fault](issue-24-ssh-recovery-results.json) |
| A23 | SQLite transaction/wire/응답 기록 전후 실제 SIGKILL·restart unknown/hold·replay 0 통과 | [crash suite](../../test/execution.test.mjs), [WAL 유실/축약](../../test/recovery.test.mjs) |
| A24 | terminal queue·승인 대기·다른 job/owner/restart hold 우회 차단 통과 | [실행](../../test/execution.test.mjs), [recovery](../../test/recovery.test.mjs), [interrupt](../../test/interrupt.test.mjs) |
| A25 | cancel/wait는 자동 Ctrl-C 없음·별도 interrupt 1회·ACK가 original 종료를 뜻하지 않음 통과 | [interrupt](../../test/interrupt.test.mjs), [native local](issue-20-local-acceptance.json), [native SSH](issue-24-ssh-recovery-results.json) |
| A26 | 사용자 fresh-shell/새 목표 복구, unknown 원상 유지·mode 우회 없음 통과 | [interrupt](../../test/interrupt.test.mjs), [native SSH](issue-24-ssh-recovery-results.json) |
| A27 | 단일 authority·실제 DB lock/손상/missing/WAL witness 실패 시 새 입력 0 통과 | [authority](../../test/authority.test.mjs), [recovery](../../test/recovery.test.mjs), [실행](../../test/execution.test.mjs) |
| A28 | 30분/7일·purge/core 종료·64 MiB 압박·consumed/hold 영속·본문 미저장 통과 | [Evidence](../../test/evidence-delta.test.mjs), [recovery](../../test/recovery.test.mjs), [operations](../../test/operations.test.mjs), [설치 purge](issue-23-installed-acceptance.json) |
| A29 | Worker 동시1/4회/60초/100k·job300초·Action3/interrupt1·소유 group 정리 통과 | [Worker](../../test/worker.test.mjs), [MCP](../../test/mcp.test.mjs), [실행](../../test/execution.test.mjs), [interrupt](../../test/interrupt.test.mjs) |
| A30 | 0700/0600·0400 거부·doctor 입력0·자신의 console target 거부 통과 | [operations](../../test/operations.test.mjs), [승인](../../test/actions.test.mjs), [설치](issue-23-installed-acceptance.json), [운영 한계](../operations.md) |
| A31 | native SSH 및 설치본 실제 Parent mode3 수정·재관찰, default60초 unknown·purge/restart·복구 통과 | [profile](issue-24-ssh-profile-results.json), [recovery](issue-24-ssh-recovery-results.json), [설치 최종 결과](issue-24-installed-acceptance.json), [runner](../../acceptance/ssh-installed.mjs) |
| A32 | 실제 SSH 포함 8종 fixture+수정 후2종, 내용 rubric·전체 usage·bytes·지연 평가 완료 | [품질과 실패 내역](issue-22-diagnosis-quality.md), [최종 직접 출력](issue-22-quality-results.json) |

## 해석 범위

A32에서 raw/prepared reference Parent의 Evidence ID 오류 2건과 초기 표현 실패를 보존했다. 제품 Worker 경로의 직접 ID/bytes/schema 검사는 통과했다. 단회 agent 내용 평가이며 독립 사람 검토, 모든 로그의 정확도 또는 비용 절약 보장이 아니다. 작은 입력에서는 Worker를 추가한 전체 token 사용량이 늘었다.

SSH 준비는 사용자의 협조적 idle shell 선언이다. local PID/title을 remote 인증으로 취급하지 않으며 외부 client 입력 잠금·check/send race 제거·marker 위조 완전 탐지·exactly-once·전체 no-store를 보장하지 않는다. fault injection 결과와 미관측 remote 변경은 구분한다.
