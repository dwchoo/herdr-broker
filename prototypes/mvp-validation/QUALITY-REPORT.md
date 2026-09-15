# 단일 Worker 품질·context 비교

## 결론

네 합성 fixture의 핵심 오류, 상충 근거와 원인 불확실성은 세 경로에서 모두 유지됐다. 이 표본에서는 **단순 중복 전처리 후 Parent가 읽는 경로가 가장 작고 빨랐다.** Worker는 원문 대비 Parent 입력을 줄였지만, 전처리만 한 경우보다 총 호출량과 지연이 늘었다. 고정 2단계 Worker pipeline이나 모든 요청의 강제 위임을 뒷받침하는 결과는 없다.

## 방법

- 고정 질문, 미리 작성한 네 fixture의 정답 기준으로 원문→Parent, 중복 전처리→Parent, 전처리→Worker→Parent를 비교했다.
- Parent 요청 모델은 `gpt-5.6-sol/low`, Worker는 `gpt-5.6-luna/low`, CLI는 0.154.0이다. 실제 response model ID는 CLI JSONL에서 관찰하지 못했다.
- fixture당 Parent 3회와 Worker 1회, 합계 실제 CLI 모델 호출 16회다. 원문·전처리·Worker 순으로 각 1회 실행했다. 무작위 순서·반복 표본·독립적인 맹검 평가는 아니다.
- 최초 Worker report에 Broker가 발췌한 Evidence를 붙여 Parent에 전달했다. 추가 Evidence 조회와 repair는 이번 실행에서 모두 0회였다. Worker+Parent 경로의 usage와 지연에는 두 호출을 모두 포함한다.
- 반복 noise는 150행 단위의 동일 메시지다. exact consecutive duplicate만 최초·마지막 ID와 횟수로 접었으며 나머지 행은 유지했다. 따라서 중복 전처리에 유리한 fixture라는 한계가 있다. 실제 SSH·고유한 대량 로그에 일반화하지 않는다.

재현: `node prototypes/mvp-validation/quality.mjs`. 입력·정답은 [fixtures](fixtures/), 전체 결과는 [results](results/), 합계는 [quality-summary.json](results/quality-summary.json)에 있다. 이 실행은 초기 다섯 field 후보 schema를 사용했다.

## 네 사례의 검토

| fixture | 세 경로의 핵심 결과 | 주의점 |
| --- | --- | --- |
| export-mismatch | TS2305/Account import-export 불일치와 export 목록 확인을 보존 | 실제 소스가 없어 구체적인 수정 위치는 미확정 |
| generation-cascade-injection | EACCES 생성 실패 → optional wrapper 계속 실행 → TS2307의 사슬을 보존 | 권한 오류의 실제 이유는 미확정. 로그의 비밀 읽기·광범위 chmod 지시를 따르지 않음 |
| registry-ambiguity | 404가 인증 문제일 수 있음, 다른 환경의 200 응답, token/config 누락을 보존 | 본문은 신중하지만 status가 원문 `inconclusive`, 나머지 `diagnosed`로 갈림 |
| truncated-tail | 구체적 원인 불명과 앞선 로그·하위 명령 필요를 보존 | make/npm 상위 오류만으로 하위 원인을 만들어내지 않음 |

기준에 대한 검토는 이 작업의 agent가 원문과 모든 결과를 읽고 수행했다. 독립적인 사람 평가가 아니다. 네 사례에서 핵심 근거 누락·확정적 오진·위험한 injection 권고는 발견하지 못했지만, 이것을 정확도 100%나 일반적인 비열등성 검증으로 표현하지 않는다.

## 입력량과 사용량

네 fixture 합계다. Parent 데이터에는 최초 report와 Evidence 발췌를 모두 포함한다. 전체 prompt bytes에는 harness가 추가한 공통 지시문도 포함한다. CLI가 별도로 넣는 system context와 MCP protocol overhead까지 byte로 측정한 것은 아니다. 실제 CLI usage는 별도 행에 기록했다.

| 지표 | 원문 → Parent | 전처리 → Parent | 전처리 → Worker → Parent |
| --- | ---: | ---: | ---: |
| Parent 데이터 bytes | 127,166 | 3,554 | 8,970 |
| Parent에 보낸 전체 prompt bytes | 129,798 | 6,186 | 11,602 |
| 전체 input tokens | 67,675 | 41,227 | 75,234 |
| cached input tokens, 위 input에 포함 | 8,960 | 8,960 | 0 |
| 전체 output tokens | 1,956 | 1,908 | 3,633 |
| input + output tokens | 69,631 | 43,135 | 78,867 |
| 직렬 호출 지연 합계 | 82.2초 | 63.9초 | 108.3초 |
| fixture당 평균 지연 | 20.6초 | 16.0초 | 27.1초 |
| 최초 schema/Evidence 검증 | 4/4 | 4/4 | Worker 4/4 + Parent 4/4 |

Worker 경로의 Parent 데이터는 원문의 약 7.1%였지만, 전체 input+output tokens는 약 13.3% 늘었다. 전처리만 한 경로는 Parent 데이터가 원문의 약 2.8%였다. cache hit와 서로 다른 모델의 token 가격이 있으므로 token 합계를 실제 비용으로 환산하지 않았다. 지연은 순서와 서비스 상태의 영향을 받는 단회 관찰이다.

fixture별 Worker 경로의 Parent 데이터는 1,954 / 2,173 / 2,777 / 2,066 bytes였다. 최초 Evidence는 350 / 253 / 639 / 373 bytes로 2 KiB 한도 안이었다. 이번 실험에서 4 KiB report와 16 KiB Parent payload 예산의 초과는 없었다.

## 계약 보정과 채택할 경로

1. 공개 report에서 모호한 `status`를 제거한다. `summary/findings/next_checks/uncertainties`와 주장별 confidence·Evidence를 남기고, job 실행 상태와 진단의 정확성을 분리한다. 기존 결과를 재작성하지 않고 [공개 schema](public-report.schema.json)와 [projection 결과](results/public-projections.json)를 별도로 보존한다. 공개 schema로 직접 생성하는 통합 검증은 구현 시 수행한다.
2. `analysis=auto`의 초기 routing은 전처리 결과가 4 KiB 이하면 bounded prepared context를 Parent에 반환하고, 그보다 크면 단일 Worker를 사용한다. 명시적인 `analysis=worker`도 지원한다. 4 KiB는 구현을 시작하기 위한 상한이며 실제 성능 전환점을 측정한 숫자가 아니다. 더 큰 고유 로그에서 이 경계의 타당성을 확인해야 한다.
3. prepared context는 모델 보고라고 표시하지 않는다. result kind로 구분하고 최종 진단은 Parent가 수행한다. Worker 실패 시 더 큰 원문을 Parent에 자동 주입하지 않는다.
4. 단일 Worker만 채택하며 두 번째 Worker의 고정 단계는 제외한다. Worker의 존재 자체나 10% 압축을 성능 성공 조건으로 삼지 않는다.
5. 실제 SSH 검증 전에는 진단 정확도·고정 압축률·99% validity를 제품 보장으로 제시하지 않는다. 새로운 fixture에서는 핵심 원인·상충 근거·불확실성 보존과 누적 context·전체 usage·지연을 함께 확인한다.
