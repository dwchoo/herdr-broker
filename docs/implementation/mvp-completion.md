# MVP 구현 완료 계획과 검증 기록

2026-09-15. 사용자가 남은 구현 전체의 완료를 요청했다. 기준 commit은 `55451403adc288b5836e6125f6a4e681e56dc282`이며, #14의 push·종료 뒤 #15–#24를 의존성 순서로 진행한다. Parent spec #12의 제품 정책을 유지하고, 기존 사용자 변경은 이번 commit에서 제외한다.

## 완료 기준과 순서

| 단계 | Issue | 완료 증거 |
| --- | --- | --- |
| 제한된 진단 | #15 | 공개 MCP의 네 field Report·Evidence, 실제 Codex와 fake provider의 권한·실패·취소 검증 |
| 승인 준비 | #16 | 실제 interactive console의 제안 확인·mode·승인·철회와 위조 거부 |
| 입력과 관찰 | #17–#18 | disposable POSIX shell의 단일 제출, 두 receipt 상태, 세 mode와 예산 |
| 복구·중지·session | #19–#21 | 실제 SQLite/process crash, 영속 hold, interrupt·복구, 대상 전이 시 입력 차단 |
| 품질 | #22 | 합성 fixture의 세 경로 결과·전체 usage·지연과 기대 내용 평가 |
| 설치와 운영 | #23 | Node 24 설치 artifact의 doctor·MCP·console·purge·권한 |
| SSH 통합 | #24 | 통제된 실제 SSH에서 전체 흐름, A01–A32의 실행 근거 |

구현 전 각 단계의 계약을 이 문서 또는 해당 구현 문서에 기록한다. 공개 MCP·console을 주 검증 경계로 사용하며, Worker·crash·SSH는 실제 process/adapter로 보강한다. 임시 protocol peer의 결과와 실제 제품 실행을 구분한다. 각 완료 묶음은 typecheck, 관련 test, Standards·Spec review와 로컬 commit으로 마무리한다. 원격 push·issue 게시/종료는 별도 승인 상태에 따라 진행한다. registry publish는 범위에 포함하지 않는다.

## 공유 경계

- 기존 `Jobs`가 owner, Snapshot/Evidence, Parent byte budget, 진단 데이터 수명을 소유한다. Worker와 Action 응답도 같은 전달 예산을 사용한다.
- Worker는 전용 process adapter에서 고정 profile로 실행한다. 전체 bounded redacted Snapshot을 stdin으로 받고, 정상 Report만 Jobs에 반환한다.
- Pane Session은 core 전체에서 exact mapping·관찰 process 문맥으로 관리한다. 같은 세션의 job은 mode만 공유하며 목표·예산은 각각 갖는다.
- Action은 immutable proposal과 메모리의 전체 payload, 별도 WAL/FULL ledger의 최소 Control State로 구분한다. 승인·정책·대상·예산을 확인하고 intent/hold를 transaction으로 저장한 뒤 단 한 번 전송한다.
- 승인·상향·수동 복구는 interactive console에서 해당 내용을 제시하고 확인하는 흐름이다. MCP의 인간 주장과 비대화형 입력은 승인 권한을 만들지 않는다.
- 기존 판정대로 새 session은 mode 2, 사용자만 상향, 세 모드 모두 범위·중지·예산·hold 검사를 적용한다. mode 3의 범위 내 고위험 입력에 추가 승인 단계를 넣지 않는다.
- 실제 SSH acceptance를 통과하기 전에는 SSH 실행을 지원 상태로 공개하지 않는다. 전체 no-store, 원격 exactly-once, 외부 입력 잠금, PID/title 기반 원격 인증을 보장하지 않는다.

## 진행 기록

- #14: `5545140`을 push하고 검증 댓글을 게시해 종료했다.
- #15 `138f505`, #16 `7c9b919`, #17 `2f326e0`: 구현·검증·push·issue 종료 완료.
- #18 `152277d`: 실제 Parent risk review/자동 실행과 세 mode.
- #19 `e38c46b`: durable intent/hold·SQLite/WAL crash 복구.
- #20 `1283f5d`: cancel/interrupt·명시적 shell 복구.
- #21 `ba4c04a`: Pane Session 연속성·stale 입력 차단.
- #22 `81d48ee`: 7개 합성 fixture의 진단 비교와 발견한 표현 문제 수정.
- #23 `b0aa3bb`: doctor·운영 console·실제 package 설치/MCP 검증.
- #24: 이 문서와 함께 commit하는 최종 SSH profile·설치/복구·8번째 실제 SSH 진단 fixture·A01–A32 matrix.

## 최종 결과

구현 범위 #15–#24를 완료했다. [운영 문서](../operations.md), [A01–A32 matrix](mvp-acceptance-matrix.md), [SSH 통합](issue-24-ssh-acceptance.md), [진단 내용과 전체 사용량](issue-22-diagnosis-quality.md)을 기준으로 확인한다.

전체 public/process suite185 tests와 마지막 관련17 tests, native SSH mode1개/recovery6개/설치1개, 실제 SSH 진단 비교2 tests가 통과했다. 실제 모델 reference의 ID 오류2건과 mode2 Parent의 승인 대기3건은 원본 결과에 보존했다. 이것을 실행 성공이나 일반 정확도 보장으로 확대하지 않았다.

기존 사용자 README·AGENTS·CONTEXT·ADR·계획·skill 파일은 staging/수정에서 제외했다. baseline hash 비교에서 사용자 파일은 보존됐으며 macOS가 갱신한 docs/.DS_Store만 차이가 있었다.

## 원격 반영 상태

#18부터 원격 main push가 자동 승인 검토에서 거부됐다. 이유는 사용자 요청이 구현·로컬 commit까지이며 원격 공유 branch 변경은 별도 명시 승인이 필요하다는 판단이다. push와 검증 댓글·issue 종료를 묶어 승인 질문을 보냈고 응답 대기 중이다. #18–#24는 로컬 commit까지 완료하며 승인 없이 원격을 변경하지 않는다. #12 parent spec은 요청대로 본문·label·상태를 변경하지 않았다. registry publish와 운영 배포도 수행하지 않았다.
