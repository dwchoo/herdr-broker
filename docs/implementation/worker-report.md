# Worker 독립 분석과 보고 계약 구현

## 변경

[승인 계획](../plans/worker-report-contract.md)에 따라 Worker는 현재 화면·질문·필요 항목을 받아 정해진 JSON을 반환한다. 사용자 AGENTS·Skill·도구 정의·환경 작업 지침은 기존 전용 profile로 제외한다. 짧은 공통 지침과 해당 purpose의 지침만 package resource로 전달하고, purpose별 schema는 호출 간 동일하다. observation ID와 근거 위치는 코드로 검증한다.

- `requested_items`: 최대 6개의 답을 순서대로 반환한다. 관찰·추정·미확인을 구분하고 미확인 이유도 빈 값으로 생략하지 않는다.
- 상태 확인은 기존 작은 형식과 Luna/low·8줄·1 KiB, 내용 분석은 Luna/medium을 유지한다. Fast는 기본 off다.
- Worker는 원문을 복사하거나 다음 행동을 생성하지 않는다. Broker가 원문 추출·겹침 제거·총 3,000자 예산·부분 인용·누락 표시를 처리한다. 서술은 항목 이름을 포함해 최대 1,000자다.
- 매 분석은 새로운 ephemeral thread의 한 turn이다. 성공·실패·취소 후 구독 해제하고 Broker의 thread 참조를 지운다. SDK 프로세스는 계속 사용하며 analysis_id는 대상에 묶인 작은 작업 연결 기록이다.
- 성공 관찰의 정제 화면만 최대 10분·16개·1 MiB 보관한다. pane_excerpt는 같은 관찰의 범위·literal 검색·cursor 조회다. 검색 세션은 저장하지 않고 cursor는 프로세스별 키로 검증한다.
- SDK 임시 용량 측정에서 외부 실행 파일을 가리키는 symlink 대상을 중복 합산하던 문제도 수정했다. 실제 파일 약 8 MiB를 약 640 MiB로 계산해 불필요한 교체를 일으킬 수 있었다.

새 관찰은 과거 화면을 이어 붙이지 않는다. Parent가 필요한 문맥을 현재 objective에 넣고, 과거 원문이 필요하면 observation_id로 확인한다. 입력 정책·중복 제출 기록·Herdr terminal·TS legacy 경로는 그대로 유지한다. 변경은 새 MCP 프로세스부터 적용한다.

## 검증 방법

기준은 구현 시작점 `bae7ff8`다. 실제 SDK와 로컬 모의 provider로 입력 격리, 같은 process와 서로 다른 thread, 현재 근거 검증, 오류·취소·동시성·자원 상한을 검사했다. 단위 및 공개 MCP/process 테스트로 원문 정확성, 한글·마스킹, 중복·부분 인용, pagination 경계, 변조 cursor, TTL·메모리 상한·재시작을 확인한다.

실제 Luna는 기존 Codex 인증과 표준 속도로 **합성 화면만** 평가했다. `acceptance/worker-report.py`는 네 시나리오별 cold 1회와 warm 5회를 기록한다. baseline은 기존 권장 workflow대로 같은 analysis_id의 thread를 이어 쓰고, 변경 버전은 같은 작업 ID여도 독립 thread다. 이 비교는 반복 사용 workflow 비교이며 첫 호출의 순수 schema 비용만 비교한 실험이 아니다. 각 모델 호출은 별도 화면·목적과 동일 effort를 사용했다. 호출 시점이 달라 서비스 지연은 통제되지 않았다.

첫 후보 실측에서 build의 warm 호출 하나가 근거 검증 실패로 반환됐다. 후보 번호와 focus_line 범위, 중복 서술 지침을 보강하고 현재 버전만 새로 측정했다. baseline의 완료된 표본은 재사용했다. runtime에 모델 자동 재시도는 추가하지 않았다. 최종 네 시나리오 모두 warm 성공 5회, 실패 0회이며 실패 시간은 성공 latency 집계에 포함하지 않는다.

## 실제 모델 결과

아래는 **warm 5회의 중앙값**이다. 모델 입력은 SDK usage의 inputTokens이며, 응답 bytes는 Worker.analyze 결과만 JSON 직렬화한 참고치다. 공개 MCP가 더하는 identity·capture·request_id·보관 metadata와 transport envelope는 제외한다. Parent가 받은 전체 응답 크기나 실제 사용한 모델 tokens를 뜻하지 않는다.

| 시나리오 | 기존 입력 tokens → 변경 | 기존 시간 → 변경 | 변경 최대 시간 | 기존 Worker 결과 bytes → 변경 |
| --- | --- | --- | --- | --- |
| 짧은 status | 1,194 → 254 | 3.36 → 4.83초 | 6.27초 | 1,656 → 2,314 |
| 1 KiB status | 1,580 → 384 | 3.26 → 4.98초 | 5.65초 | 1,509 → 2,017 |
| OS·CPU·RAM | 1,513 → 716 | 4.86 → 7.00초 | 8.05초 | 2,215 → 2,126 |
| build 오류 | 4,285 → 1,358 | 6.01 → 9.61초 | 10.78초 | 2,555 → 3,337 |

반복 thread 문맥을 제거해 Worker 입력은 줄었고 표본에서는 모두 20초 이하였다. 그러나 **기존 thread를 이어 쓰는 것보다 응답 시간은 늘었다.** 변경 버전의 새 thread 생성 중앙값은 4.5–7.5 ms, 정리는 0.3–0.6 ms였다. 대부분의 시간은 model stream 수신에 들었으며, 비교가 같은 시점에 수행되지 않아 지연 증가의 주원인을 확정할 수 없다. SDK 재초기화는 반복하지 않았다. 상태 확인의 1,000 tokens 목표도 이 합성 표본에서는 충족하지만 임의의 1 KiB 텍스트·질문에 대한 보장은 아니다.

같은 warm 표본의 output tokens 중앙값은 순서대로 126→137, 84→151, 211→227, 253→343이었다. cachedInputTokens는 모두 0이었다. 구조화된 결과를 반환하며 output이 증가한 점도 비용 비교에 포함해야 한다.

cold 각 1회의 전체 시간은 같은 순서로 기존 5.98·5.62·7.46·11.11초, 변경 5.61·5.06·6.82·8.01초였다. 이 환경의 SDK 준비 시간은 약 67–78 ms였다. 한 번씩의 표본이므로 cold 분포나 다른 환경의 초기화 비용을 대표하지 않는다.

| 변경 입력 구성 | prompt bytes | 고정 schema bytes | Worker 지침 bytes |
| --- | --- | --- | --- |
| 짧은 status | 207 | 444 | 504 |
| 1 KiB status | 1,186 | 444 | 504 |
| OS·CPU·RAM | 272 | 1,980 | 1,419 |
| build 오류 | 2,087 | 1,980 | 1,419 |

원문·출처 metadata를 더 전달하므로 Parent의 입력량까지 항상 줄어드는 것은 아니다. 기존·변경 공개 MCP 전체 응답의 비교는 이 benchmark에서 측정하지 않았다. 전체 비용을 평가할 때 공개 envelope와 실제 필요한 후속 조회도 함께 봐야 한다.

품질 사례 6개는 디스크 오류 뒤 cleanup 성공, 입력 echo만 남은 화면, 진행률, 수집 범위 앞쪽의 최초 오류, 긴 한 줄 오류, RAM 정보 부재다. 최종 사례에서는 echo를 완료로 단정하지 않았고 RAM은 unknown, 긴 오류는 핵심 위치가 포함된 partial 원문으로 반환됐다. 상태·내용의 의미 정확성은 schema만으로 보장되지 않으며 이 결과도 전 사례의 정확도 보장이 아니다.

## 실제 Herdr

`acceptance/worker-report-herdr.py`로 현재 workspace의 Codex pane 옆에 테스트 pane만 임시 생성했다. 사용자가 사용하던 SSH pane에는 입력·화면 수집을 하지 않았다.

- 최종 재검증의 상태 확인: 278 input tokens, 전체 pane_read 약 6.03초.
- 합성 OS·CPU 출력과 RAM 부재를 항목별 분석: 850 input tokens, 전체 pane_read 약 8.45초.
- 새 marker의 독립 출력 행을 후속 관찰에서 확인하고, 이전 observation 원문이 변경 전과 동일함을 확인했다. 이 후속 status는 382 input tokens, 약 11.95초였다.
- 위 세 공개 pane_read의 structured result는 각각 2,862·2,566·2,735 UTF-8 bytes였다. JSON 직렬화 기준이며 MCP transport wrapper·Parent token 수는 제외한다. baseline 공개 응답과의 비교는 아니다.
- analysis_release 후 원문 조회 가능, MCP 재시작 후 snapshot_unavailable을 확인했다.
- 테스트 pane을 닫은 뒤 기존 pane·terminal·tab identity와 layout tree가 동일함을 확인했다.

SSH 실행 검증은 수행하지 않았다. 위 결과는 별도 로컬 테스트 shell의 검증이다.

## 유지 시험과 검사 상태

실제 SDK + 로컬 모의 provider로 `tests/test_sdk_soak.py`의 **100회·2,100초 유지 시험이 통과**했다. 분석 완료 후 idle을 유지하며 SDK RSS, Python RSS·tracemalloc, loaded thread, global notification queue, 자식 수, 임시 파일, snapshot·작업 기록을 측정했다.

| 측정 | 관측 결과 |
| --- | --- |
| Python RSS | 표본 최대 112.9 MiB, 마지막 100.3 MiB |
| SDK RSS | 표본 최대 127.3 MiB, 마지막 69.5 MiB |
| SDK 자체 임시 파일 | 표본 최대 8.1 MiB |
| SDK 교체 | loaded thread 한도 경로로 1회, 동시 생존 자식 최대 1개 |
| loaded thread | 100회 직후 36개, 이후 0개. 10회마다 표본으로 측정한 최대는 60개 |
| global notification queue | 모든 표본에서 0개 |
| 작업 연결·snapshot | 연결 0개, snapshot 최대 16개, 10분 만료 후 0개·0 bytes |
| MCP 정리 | 소유 자식 모두 종료, SDK 임시 디렉터리 모두 제거 |

이 soak의 snapshot은 짧은 합성 텍스트로 최대 원문 합계 144 bytes였다. 1 MiB 용량 퇴출·동시 완료 순서·긴 화면 경계는 별도 테스트로 확인했다. 측정값은 해당 표본의 결과이며 전체 프로세스 메모리의 영구 상한을 뜻하지 않는다. 로컬 원본은 `/private/tmp/herdr-report-soak.json`이다.

최종 검사는 다음과 같다.

- Python: 156 passed, 1 skipped. skip은 별도로 실행한 opt-in 35분 유지 시험이다.
- Python ruff·mypy 통과. wheel·sdist build 후 checkout이 아닌 wheel에서 세 Worker 지침 resource의 로드를 확인했다.
- 기존 TS: 261 tests 통과, typecheck·build 통과.
- 최종 변경 diff의 공백 오류 없음. 기존 README와 무관한 사용자 변경은 commit 대상에서 제외한다.

### Standards

구현 시작점 기준 검토와 최종 추가 변경 검토에서 미해결 actionable finding은 0개다. 기존 스타일과 제한된 모듈 책임, 자원 정리, 테스트 pane 소유 범위를 확인했다.

### Spec

미해결 actionable finding은 0개다. 고정 schema, 원문·pagination 경계, unknown 이유, 중복 인용 전달 상태, 성공 표본 집계, 실제 화면 변경 확인, 측정 범위 표기의 지적을 반영했다. 의미 정확성을 schema만으로 보장한다고 주장하지 않는다.

모델 benchmark와 실제 Herdr 결과의 로컬 원본은 `/private/tmp/herdr-report-benchmark-final.json`, `/private/tmp/herdr-report-live-final.json`이며 사용자 환경의 화면·인증 내용을 repository에 추가하지 않는다.
