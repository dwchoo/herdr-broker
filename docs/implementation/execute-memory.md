# 실행 제출과 MCP 메모리 제한

2026-09-16 승인한 계획의 구현 기준이다. shell 실행 요청은 `pane_execute`로 명령과 Enter 하나를 함께 보내고 `pane_read`로 결과를 확인한다. 입력만 하는 기존 `pane_send`의 의미는 유지한다. 입력 echo와 실제 출력·완료 증거를 구분하며 자동 재전송하지 않는다.

중복 방지 기록은 1만 건 상한과 무삭제 정책을 유지한다. 최초 상세 응답을 반환한 뒤에는 digest·상태·오류·수행 단계·정확한 ID와 마지막 위치만 보관한다. 중복 조회는 `details_retained: false`를 반환한다. 화면·요약·명령 본문·배치 트리·설명 metadata는 보관하지 않는다.

분석은 화면 수집 전에 동시 2개 한도를 적용하며, 초과 호출은 대기열 없이 `worker_busy`로 거부한다. 분석 timeout 60초, cleanup 대기 5초를 사용한다. cleanup 실패 시 신규 분석을 중단하고 남은 client를 종료 시 한 번 다시 정리한다. SDK가 확인하지 못한 종료를 성공으로 표시하지 않는다.

## 검증 범위

- 명시적인 Enter 한 번, 단일 줄·heredoc, 입력만 전달, exact identity·중복·ACK 유실.
- 성공·실패·취소 receipt 축소, 1만 건 상한과 중복 조회, 큰 배치 트리 미보관.
- 화면 수집 전 분석 슬롯, 동시 2개 한도, 반복 종료 실패 시 생성 중단, 임시 디렉터리·client 정리.
- 실제 SDK와 로컬 모의 provider의 반복 분석에서 Python 메모리·자식 프로세스 수 확인.
- 실제 Herdr 테스트 pane의 실행 및 기존 pane 보존. 준비된 SSH 대상이 없으면 로컬 검증만 수행했다고 구분.
- 전체 테스트·lint·typecheck·build·Standards/Spec review 후 로컬 commit.

## 자동 검증 결과

- Python 최종 전체 85개, 기존 TS 261개 테스트 통과. ruff·strict mypy·TS typecheck·build·Python wheel/sdist build 통과.
- 입력/receipt 회귀 테스트 9개가 기존 코드에서 실패하는 것을 확인한 뒤 구현했다. 추가 검증은 동시 슬롯·capture 실패/취소·cleanup 실패/timeout·반복 취소·종료 도중 capture 경계를 포함한다.
- SDK는 실제 `openai-codex` runtime과 로컬 모의 model provider로 8회 반복했다. 각 회 종료 후 child 0개, active client·cleanup task·임시 디렉터리 0개를 확인했다.
- 해당 테스트 Python process RSS는 약 116.1→116.2 MiB, 실행 중 SDK child RSS는 약 267–300 MiB였다. 이 값은 테스트 환경의 관측값이며 production baseline이나 장기간 무누수 보장은 아니다.
- 동일한 모의 측정에서 입력 1만 건은 약 6.02 MiB를 유지했다. 32-pane 배치 결과 1천 건은 18.16→0.61 MiB로 줄었고, 저장된 배치 트리는 0개였다. 무삭제 정책과 한도 도달 시 새 변경 요청 거부는 유지한다.
- Standards·Spec 두 축의 구현 검토는 미해결 사항 0건이다.

## 실제 Herdr 검증

사용자가 SSH 화면의 Worker 전송을 명시적으로 허용한 뒤 기존 `1000` pane의 idle shell을 확인했다. 단일 `printf`와 Python heredoc을 `pane_execute`로 제출하고, 각 요청의 중복 조회가 재전송 없이 compact receipt를 반환하는 것을 확인했다. Worker는 실제 출력 행과 shell 프롬프트 복귀를 인용했다.

첫 SSH 입력 직후 화면에는 이전 내용이 관찰됐다. 명령을 재전송하지 않고 화면만 재관찰해 실제 출력과 프롬프트 복귀를 확인했다. 이는 ACK와 화면 갱신·실행 완료를 구분해야 하는 실제 사례다. acceptance는 최대 3회의 관찰만 반복하며 입력은 재전송하지 않는다. Worker에도 예상 출력이 없으면 먼저 화면을 재관찰하도록 안내했다.

새 로컬 테스트 pane에서는 `pane_send`로 입력만 남는 상태를 관찰하고 Enter만 보내 실제 출력을 확인했다. 이어 `pane_execute`의 단일 명령·heredoc 실행과 중복 요청 억제를 확인했다. 테스트 pane만 닫은 뒤 기존 pane·terminal·tab ID와 배치 트리가 모두 원래와 같은 것을 공개 MCP로 검증했다. 기존 SSH 연결과 Codex pane은 유지했다.

재현 가능한 로컬·선택적 SSH 검증은 [acceptance script](../../acceptance/execute-herdr.py)를 사용한다. 기존 SSH pane을 지정할 때는 먼저 현재 화면으로 idle 상태를 확인한다. 상세 실행 증거는 로컬 `/private/tmp/herdr-execute-local-proof.json`, `/private/tmp/herdr-execute-ssh-proof.json`에 있으며 저장소에는 terminal 원문이나 환경별 증거 파일을 추가하지 않았다.

acceptance 실행 시 `--local-prompt`와 SSH를 지정했다면 `--ssh-prompt`에 관찰한 정확한 prompt를 제공한다. 검증은 marker의 실제 행과 그 뒤에 있는 prompt 행을 모두 요구한다. marker만 있거나 marker보다 앞에 있는 이전 prompt, 입력 echo는 실패한다. 이 조건을 회귀 테스트로 검증했고 수집한 로컬 3건·SSH 2건의 실제 evidence도 모두 통과했다. 해당 회귀 테스트에서 사용하는 acceptance script는 sdist에도 포함한다.
