# Worker의 독립 분석과 구조화된 보고 계약

상태: 2026-09-17 사용자 승인 후 구현·검증 완료. 사용자 결정은 **SDK 프로세스만 재사용하고 매 호출 새 thread에서 독립 분석**하는 것이다. 응답 확장·독립 thread·`pane_excerpt`의 구현과 검증 결과는 [구현 보고](../implementation/worker-report.md)에 기록한다.

## 1. 목표와 책임

Worker는 현재 입력을 읽고 정해진 JSON을 반환한다. Parent Agent(Main Agent)가 필요한 항목을 지정하고, Broker가 원문·ID·예산·보관을 코드로 처리한다. 작은 결과로도 요청한 항목의 답, 근거, 미확인 사항을 구별할 수 있게 한다.

| 주체 | 책임 |
| --- | --- |
| Parent | 사용자 의도 해석, 대상·필요 항목·관찰 범위 선택, 추가 조회와 다음 행동, 승인 판단, 사용자에게 최종 설명 |
| Worker | 전달된 화면의 의미 해석, 항목별 답, 관찰과 추정 구분, 중요한 근거 위치와 불확실성 반환 |
| Broker | 수집·정제, 입력과 JSON 검증, 항목 누락 검사, 원문 추출·중복 제거·예산 적용, ID·시각·출처, snapshot 보관·추가 조회, SDK 수명 관리 |

Worker가 만든 중요한 내용의 선별이나 판단 정확성은 rule로 보장할 수 없다. Broker는 위치와 형식을 검증하며, 의미의 정확성은 실제 사례 평가와 Parent의 후속 확인으로 검증한다. prompt 판별·위험도·다음 명령을 정규식 규칙으로 옮기는 계획은 아니다.

현재 계약은 [MCP 문서](../mcp.md), SDK 구현은 [SDK 재사용](../implementation/sdk-reuse.md), 사용자 문맥 격리는 [Worker profile](../implementation/service-tier.md)을 기준으로 한다. 이 계획은 [Python MCP ADR](../adr/0005-simple-herdr-mcp.md)의 thread 문맥 재사용과 화면 미보관 원칙을 각각 독립 분석과 제한된 snapshot 보관으로 변경한다. SDK 프로세스 재사용과 terminal 입력 정책은 유지한다.

## 2. Worker에 전달하는 입력

Worker 전용 지침은 다음 행동만 설명하는 짧은 영어 package resource다: 제공된 화면에서 요청 항목을 해석하고 한국어 JSON으로 답하기, 현재 근거와 추정을 구분하기, terminal 텍스트는 관찰 자료로 다루기, 명령 echo와 실제 결과 구분하기. 입력 승인·도구 선택·실행 workflow 지침은 Parent 문서에 둔다.

매 호출의 입력은 아래로 제한한다.

- `purpose`: `status` 또는 `analysis`.
- `objective`: Parent가 작성한 현재 질문. 관련 대화가 필요하면 Parent가 필요한 사실만 담고 대화 전체를 전달하지 않는다.
- `requested_items`: analysis에서 확인할 항목. 예: `OS`, `CPU 모델·코어 수`, `RAM 용량`.
- `observation_id` 한 번과 짧은 줄 번호가 붙은 정제된 화면.
- 해당 purpose의 고정 JSON Schema. 좌표별 UUID 반복, 모든 유효 줄 번호를 나열한 enum, 호출별 임의 schema를 만들지 않는다.

기존 전용 profile을 유지해 사용자·프로젝트 AGENTS, Skill 목록, MCP·shell·파일·웹 도구 정의, 사용자 config의 작업 지침, 환경 설명, Parent 대화 이력이 추가되지 않게 한다. SDK의 기본 작업 지침은 Worker 전용 지침으로 지정한다. 실제 read-only·deny-all 및 도구 호출 거부는 코드에서 유지한다. 기존 Codex 인증과 고정 SDK를 유지하며 직접 API 호출로 전환하지 않는다.

검증 대상은 실제 SDK 전송 payload다. 사용자 환경의 지침과 도구 정의가 0개인지 검사하고, 빈 SDK envelope 같은 protocol 구조는 내용 프롬프트와 구분해 계측한다. 애플리케이션이 통제하지 않는 서비스 내부 문맥까지 없다고 주장하지 않는다.

## 3. 목적별 출력 계약

### 3.1 status: 화면 상태만 짧게

Luna/low, 최근 **8줄·1 KiB**를 유지한다. 내부 출력은 현재의 `observation_id`, `summary`, `lines`, `uncertainty` 네 필드다. summary와 uncertainty는 각각 최대 60자, 근거 줄은 최대 2개다. 이 JSON과 Broker가 조립한 기존 공개 status report의 1 KiB 한도를 유지한다.

현재 프로그램, prompt 복귀, 미완성 입력, 실행 중으로 보이는 근거, 질문 관련 기존 결과의 존재를 필요한 범위에서 보고한다. 단일 화면으로 알 수 없으면 그 부분만 불확실성에 쓴다. `safe_to_execute` 같은 승인·안전 보장 필드는 만들지 않는다. 자유로운 항목별 내용 분석은 analysis에서 수행한다.

Broker는 근거 줄에서 원문을 추출한다. 요청 요약·분석용 항목·후속 도구 사용법을 status Worker에 추가하지 않는다. 부족한 화면은 Parent가 `max_lines`로 명시적으로 확장한다.

### 3.2 analysis: 요청 항목을 빠짐없이 채우기

Luna/medium, 최근 **80줄·64 KiB**를 유지한다. 명시적 effort, 최대 1,000줄·64 KiB 확장과 호출별 Fast 선택도 유지한다. Fast 기본은 off다.

`pane_read`에 optional `requested_items: list[str]`를 추가한다. analysis에서만 사용하며 1–6개, 항목당 40자, 공백뿐인 항목과 정확히 중복된 항목은 거부한다. 생략하면 항목 목록은 비어 있고 기존처럼 objective 중심의 summary·findings를 반환한다. status·raw에 이 인자를 함께 넘기면 명시적 인자 오류를 반환한다. 더 많은 항목은 Parent가 목적에 맞게 묶거나 나눠 요청하며 Broker가 자동 분할 호출하지 않는다.

내부 JSON의 고정 필드는 다음과 같다. Worker가 작성하는 것은 짧은 답과 근거 위치뿐이다.

| 필드 | 의미와 제약 |
| --- | --- |
| `observation_id` | 현재 입력 ID를 한 번 확인. Broker가 생성한 값과 일치해야 함 |
| `summary` | 전체 결론 한 번, 최대 160자. items의 단순 반복을 피함 |
| `items` | 요청한 항목마다 하나. `item`은 입력 목록의 1-based 번호, `value`는 최대 60자, `basis`는 `observed / inferred / unknown`, `refs`는 근거 후보 번호 |
| `findings` | 항목 답과 중복되지 않는 핵심 오류·반대 증거·주의점, 최대 2개 × 70자. 항목 미지정 시 주요 관찰. 기존 confidence 의미와 근거 연결 유지 |
| `uncertainties` | 개별 unknown 항목에 이미 쓴 내용을 제외한 한계, 최대 2개 × 50자 |
| `evidence` | 중요도 순의 후보 최대 6개. 줄 범위·핵심 줄·필요한 anchor만 지정. 원문 본문 없음 |

`items`는 입력 목록의 번호를 순서대로 정확히 한 번씩 반환한다. 값이 보이지 않아도 항목을 생략하지 않고 `basis=unknown`과 짧은 이유를 쓴다. observed·inferred 답은 현재 화면의 후보 근거가 필요하다. unknown은 refs가 비어 있어도 되며 관찰 부재를 확정적 대상 부재로 표현하지 않는다. 범위 밖 번호, 중복·누락 항목, 거짓 근거는 검증 오류이며 Broker가 답을 추측해 채우지 않는다.

수치에는 단위와 대상 이름을 보존한다. 화면의 출력과 명령 본문, 이전 결과와 이번 실행, 성공 문구와 함께 있는 오류를 구별한다. 항목에 없더라도 결론을 바꾸는 오류나 반대 증거는 findings로 전달한다. 긴 분석·계획·도구 사용 제안·사고 과정은 출력하지 않는다. 원래 제안의 `request_summary`는 요청 반복을 줄이기 위해 추가하지 않고, Worker가 다음 명령을 생성하는 `next_checks`도 제거한다.

다음은 **Broker가 조립한 항목 부분의 예시**다. 실제 응답은 아래의 공통 envelope와 원문 근거도 포함한다.

```json
{
  "summary": "OS와 CPU는 확인됐고 RAM 용량은 현재 화면에 없습니다.",
  "items": [
    {"item": "OS", "value": "Ubuntu 24.04", "basis": "observed", "evidence_ids": ["obs:L0002"], "evidence_delivery": "full"},
    {"item": "CPU", "value": "8 logical CPUs", "basis": "observed", "evidence_ids": ["obs:L0004"], "evidence_delivery": "full"},
    {"item": "RAM", "value": "용량을 보여 주는 출력 없음", "basis": "unknown", "evidence_ids": [], "evidence_delivery": "none"}
  ],
  "findings": [],
  "uncertainties": []
}
```

고정 schema가 항목별 누락은 검출하지만 내용이 충분하거나 정확한지 자동 보장하지는 않는다. 복잡한 요청은 근거 원문과 추가 조회로 보완한다.

### 3.3 Parent가 받는 공개 응답과 예산

기존 `report`·`evidence` envelope, model·effort·usage·timings·service tier와 identity metadata를 유지한다. `report.items`를 추가하고 Worker의 항목 번호를 원래 이름으로 바꾼다. 기존 `summary`, `findings`, `uncertainties` 형태는 유지한다. `next_checks` 필드는 호환용 빈 배열로 남기고 다음 행동은 Parent가 정한다. items를 같은 내용의 findings로 다시 복제하지 않는다. 이 의미 변화는 MCP 계약과 Skill에 명시한다.

Broker가 생성·검증하는 추가 정보는 다음과 같다.

- optional read `request_id`: 생략하면 발급. 조회 연결용이며 동일 ID라도 새 관찰을 수행한다. mutation 중복 방지 기록에 저장하지 않는다.
- `analysis_id`, `observation_id`: 작업 연결과 개별 관찰 ID. 별도 snapshot ID는 만들지 않는다.
- `evidence`: 기존 `id`·`text`에 원본 범위·실제 반환 범위·중요도·partial 정보를 추가한다.
- `omitted_evidence`: 선택됐지만 예산으로 제외된 후보 ID·위치와 `reason=budget`. Worker가 발견하지 못한 내용의 목록이 아니다.
- 항목·finding별 `evidence_delivery`: `full / partial / omitted / none`. 인용 전달 상태이며 Worker 판단의 확실성과 별개다. full도 의미적 입증을 보장하지 않는다.
- 관찰 metadata: workspace·tab·pane·terminal, 관찰 시각·수집 범위·줄 수·수집 잘림, 보관 만료 시각.

analysis 콘텐츠 예산은 **서술 최대 1,000자 + 원문 최대 3,000자**다. 서술에는 summary 160자, 최대 6개의 항목 이름 40자와 값 60자, findings 2개 × 70자, uncertainties 2개 × 50자를 포함한다. JSON 문법·ID·좌표·enum은 제외하지만 자유 서술을 metadata로 옮겨 예산을 우회하지 않는다. 원문·서술 예산은 서로 넘겨 쓰지 않고 상한까지 채울 필요도 없다. status는 위의 작은 서술 한도와 원문 최대 3,000자를 사용하며, 기본 수집 원문 자체는 1 KiB 이하다.

문자 수는 Python `len(str)` 기준이며 tokens·UTF-8 bytes와 구분한다. 기존 analysis의 Worker JSON 4 KiB 제한은 이 콘텐츠·필드·개수 한도로 대체하되, 모델 stream 수집의 총 크기 제한은 유지한다. anchor는 최대 80자로 별도 제한한다. 마스킹 후 최종 결과에도 한도를 검사한다. 잘못된 보고를 자동으로 다시 생성하거나 임의로 서술을 잘라 성공 처리하지 않는다.

## 4. Broker의 원문 추출 규칙

1. 근거 후보 번호는 배열 순서로 정하며 작은 번호가 높은 중요도다. 후보는 `start_line`, `end_line`, 범위 안의 `focus_line`, `anchor`를 가진다. 줄 번호는 현재 정제된 화면의 1-based 정수이고 양 끝을 포함한다. focus_line은 항상 지정하며 anchor는 빈 문자열 또는 해당 줄의 최대 80자 exact 문자열이다. 핵심 줄 자체가 3,000자를 넘으면 비어 있지 않은 anchor가 필수다.
2. 범위·핵심 줄·anchor의 실제 존재를 검증한다. 중복 anchor는 지정된 핵심 줄 안의 첫 일치로 정한다. anchor 검증 실패·과거 observation·유효하지 않은 후보 참조는 명시적 오류다. 짧은 줄에는 불필요한 원문 echo용 anchor를 요구하지 않는다.
3. 후보 원문은 ANSI 제거·secret masking을 거친 하나의 정제된 화면에서 그대로 추출한다. 완전 중복·포함·부분 중복 구간 모두 같은 문자를 한 번만 전달하고 원래 후보별 연결을 보존한다. 분리된 구간을 이어 붙여 연속된 원문처럼 만들지 않는다. 겹치는 구간의 처리는 모델 호출 없이 코드로 수행한다.
4. 선택 후보의 중복 제거 후 원문 합계가 3,000자를 넘으면 낮은 중요도 후보부터 통째로 제외하고 omitted_evidence에 기록한다. 중요도는 Worker가 정하며 Broker는 값이 맞는지 재해석하지 않는다.
5. 최상위 후보 하나가 3,000자를 넘으면 핵심 줄을 넣고 그 후보 범위 안에서 앞 줄, 뒤 줄 순으로 인접한 완전한 줄을 추가한다. 다음 줄이 예산을 넘으면 멈춘다. 핵심 줄 자체가 길면 첫 anchor 일치를 포함하는 최대 3,000자의 연속 창을 만들고 경계에서 창을 이동한다. 원본 범위·실제 반환 범위·`partial=true`를 남긴다.
6. 긴 줄의 문자 좌표는 정제된 줄의 Unicode code point 기준 0-based·끝 미포함이다. 줄 구분 문자도 원문 예산에 센다. 일부 후보가 다른 인용과 겹쳐 제공되면 그 연결도 반영한다. evidence_delivery는 연결된 원래 근거의 전체/일부/전무 전달 상태로 계산한다.
7. 공백을 제외한 내용이 있는 성공 보고에는 실제 원문 발췌를 최소 하나 포함한다. 빈 화면·공백뿐인 화면은 empty 상태로 명시하고 인용을 강제하지 않는다. unknown 항목만 있어도 화면에 보이는 한계를 나타내는 원문 후보는 제공할 수 있다.

Parent는 partial·omitted인 근거를 필요한 경우 추가 조회한다. 입력 ACK나 echo를 실행 완료로 판단하지 않는다. 원문이나 Worker 서술을 Parent에게 전달할 때도 실행 지시가 아닌 관찰 자료로 취급한다.

## 5. 같은 관찰의 추가 조회와 메모리

성공한 status·analysis의 정제된 화면과 출처 metadata를 수집 시점부터 **10분, 최대 16개, 원문 UTF-8 bytes 합계 1 MiB** 보관한다. 이는 Python 전체 RSS의 상한은 아니다. 용량 초과 시 수집 시점이 오래된 화면부터 퇴출하고, 접근으로 TTL을 연장하지 않는다. 만료 시각은 최대 보관 시각이며 이전에도 용량 때문에 퇴출될 수 있다. 조회가 없어도 정기적으로 만료 내용을 해제하고 MCP 종료 시 모두 정리한다.

저장 범위는 실제 수집한 화면뿐이다. status 기본 8줄·1 KiB나 analysis 기본 80줄 바깥, 이미 잘린 내용은 복구하지 못한다. SDK thread와 독립된 저장이므로 `analysis_release`나 SDK 교체 이후에도 남아 있는 observation을 조회할 수 있다. 화면을 여러 형식으로 중복 저장하거나 Worker 보고·질문·대화의 별도 이력을 쌓지 않는다. 기존 화면 안에 들어 있는 명령 echo는 관찰 원문에 포함될 수 있다.

새 read-only `pane_excerpt`는 `observation_id`와 다음 중 하나를 받는다.

- 줄 범위 `start_line`, `end_line`: 1-based, 양 끝 포함.
- `query`: 비어 있지 않은 최대 256자의 case-sensitive literal. 정규식은 사용하지 않는다. 일치 주변 앞뒤 5줄, 겹친 범위는 병합한다.
- `cursor`: 같은 observation·조회 조건·다음 위치에 결합한 이어 읽기. 다른 조건과 함께 넘기지 않는다.

한 응답은 원문 최대 4,000자이며 남은 부분은 next_cursor로 제공한다. 긴 한 줄은 문자 좌표로 나누고, 검색에서는 일치 지점을 포함한 부분을 먼저 보여 주며 미반환 위치도 명시한다. 여러 일치는 원본 위치순, 인용은 중복 제거하며 pagination은 누락·무한 반복 없이 종료돼야 한다.

cursor는 프로세스별 키로 검증 가능한 고정 크기 상한의 불투명 token으로 만들고 서버에 검색 세션을 쌓지 않는다. query·범위·다음 위치는 token에 포함하며 최대 2 KiB다. 검색 구간은 요청마다 제한된 snapshot에서 계산하고 전체 일치 목록을 계속 보관하지 않는다. snapshot이 없으면 cursor도 사용할 수 없다.

검색 불일치는 해당 화면 안에서의 불일치다. 만료·퇴출·재시작은 `snapshot_unavailable`, 다른 관찰의 cursor·범위 밖 좌표는 인자 오류이며 새 화면으로 대체하지 않는다. 추가 조회는 Worker와 Herdr 수집을 호출하지 않는다. Parent는 필요한 근거를 별도 재승인 없이 조회할 수 있고, 새 화면이 필요할 때만 pane_read를 호출한다. 기존 live raw는 명시적인 사용자 원문 요청 경로로 유지하고 분석 실패의 자동 fallback으로 쓰지 않는다.

## 6. SDK 프로세스 재사용과 독립 thread

사용자 선택에 따라 **성공·실패와 관계없이 매 분석은 새 ephemeral thread의 한 turn**으로 수행한다. 이전 화면·보고·질문을 다음 thread에 복사하지 않는다. 여러 화면의 비교가 필요하면 Parent가 보관된 원문을 확인해 비교하고, 이번 Worker에는 이번 질문에 필요한 내용만 명시한다. Worker가 과거 SDK thread를 이어서 읽지 않는다.

- MCP 시작의 SDK prewarm, 동일 process 재사용, 동시 분석 최대 2개·초과 즉시 worker_busy, 60초 분석·5초 정리 제한을 유지한다. 새 thread 비용은 SDK 재초기화 비용과 따로 측정한다.
- turn 완료 후 thread 구독을 해제하고 Broker의 thread·보고·화면 참조를 해제한다. 취소·timeout은 interrupt와 중단 확인 후 같은 정리 경로를 사용한다. 정리 상태가 불명확하면 SDK를 불건전 상태로 처리하고 새 프로세스를 무제한 만들지 않는다.
- `analysis_id`는 호환을 위한 **작업 연결·대상 identity 기록**으로 유지하고 문맥 저장소로 사용하지 않는다. 같은 ID도 매번 새 thread이며 다른 target 사용은 거부한다. 이 작은 기록은 최대 2개·5분 idle 만료, 기존 busy·퇴출 규칙을 유지하고 analysis_release로 지운다.
- 응답에 `context_mode="independent"`를 추가한다. `context_reused=false`, `context_reset=false`, `context_reset_reason=null`이며 sdk_reused는 실제 process 재사용 상태를 나타낸다. 8 turn·128 KiB에 따른 thread 전환은 더 이상 필요하지 않다. 이 의미 변경과 과거 문맥이 필요하면 Parent가 명시해야 한다는 점을 계약·Skill에 기록한다.
- SDK의 실제 loaded thread 수·RSS·임시 파일은 기존 기준으로 감시한다. RSS 512 MiB 두 번, loaded 64개, 임시 파일 128 MiB의 교체 기준을 유지한다. 누적 생성 횟수나 idle 시간만으로 process를 종료하지 않는다. 교체 중 신규 분석 거부, 진행 중 분석 종료 후 process 종료 확인·재준비, terminal·mutation 중복 기록 보존도 유지한다.

구독 해제는 즉시 메모리 회수를 보장하지 않는다. [공식 thread 수명 설명](https://learn.chatgpt.com/docs/app-server#unsubscribe-from-a-loaded-thread)은 loaded 상태를 별도로 다룬다. 고정 SDK에서 반복 독립 thread의 loaded 잔류를 측정한다. 실제 상한 도달로 process 교체가 필요하면 숨기지 않고 원인·빈도·지연을 보고하며, 토큰을 줄이려고 끝난 thread를 다시 사용하는 fallback은 두지 않는다.

## 7. 구현 순서와 완료 조건

1. **문서와 예시:** MCP·운영 문서·ADR·SDK 재사용 문서에 위 변경을 반영한다. `$broker` reference에 항목 지정, unknown·partial 처리, pane_excerpt, 독립 thread 사례를 기록한다. Parent 지침과 Worker 지침을 분리하고 본 계획을 Worker prompt에 통째로 넣지 않는다.
2. **계약과 입력 격리:** `requested_items`, purpose별 고정 schema·짧은 package resource, 구조 검증과 공개 응답 조립을 구현한다. Worker에 요청 요약·명령 계획·도구 설명을 붙이지 않는다. package 설치 후에도 정확한 resource가 로드되는지 확인한다.
3. **독립 분석 수명:** `_analyze`와 공통 정리 경로를 한 turn/thread로 바꾸고 analysis_id를 작은 연결 기록으로 제한한다. 고정 SDK adapter의 loaded 조회·구독 해제·종료 확인 경계를 유지한다.
4. **원문과 추가 조회:** 별도 작은 모듈에서 후보 검증·인용·예산을 처리하고, Broker에 한정된 snapshot 저장과 pane_excerpt를 연결한다. 새로운 Job·Queue·DB·Console은 만들지 않는다.
5. **통합·실측·review:** 아래 검증을 완료하고 Python 전체 test·ruff·mypy·wheel/sdist build, 기존 TS test·typecheck·build, 구현 시작점 기준 Standards·Spec code-review를 수행한다. 구현 변경분만 로컬 commit한다.

| 검증 | 완료 기준 |
| --- | --- |
| 고정 출력 | 지정한 각 항목이 정확히 한 번 있고 관찰·추정·미확인을 구별함. 수치·단위와 중요한 오류·반대 증거를 보존. 중복 서술·다음 명령 생성 없음 |
| 계약 오류 | 누락·중복 항목, 잘못된 observation·범위·anchor·참조, 초과 길이를 명시적 오류로 반환. 자동 모델 재호출·입력 재전송 0회 |
| 상태 확인 | prompt, 미완성 입력, 실행 중, REPL·TUI, echo만 있는 화면, 빈 화면·부족한 8줄을 사례로 확인. 가짜 확정적 입력 허용을 만들지 않음 |
| 원문 | 한글·Unicode·ANSI·masking, 완전/부분 중복, 긴 한 줄·여러 줄, 총 3,000자·부분 인용·누락·후속 조회를 검증. 반환 문자가 지정 위치와 일치 |
| 추가 조회 | live 화면 변화 후에도 같은 원문, 검색 불일치·다중 일치·pagination·변조 cursor·TTL·용량 퇴출·재시작 처리. Worker·Herdr 호출 0회 |
| 격리 | 실제 SDK와 로컬 모의 provider에서 AGENTS·Skill·도구 정의·환경 작업 지침이 없고, 두 번째 분석에 첫 분석의 고유 sentinel이 없음. 도구 호출도 거부 |
| 수명·메모리 | 실제 SDK+모의 provider로 최소 100회와 35분 유지·만료 시험. Python RSS·SDK RSS·loaded·자식 수·notification·임시 파일·snapshot bytes·작업 기록·cursor 상태를 측정. 동시 호출·취소·timeout·EOF·unsubscribe 실패 후 무제한 누적 없음 |
| 회귀 | raw의 Worker 미호출, medium/low·명시적 effort·Fast off, 대상 교체, 입력 ACK·중복 방지, SDK만 교체한 뒤 mutation request ID 보존 |

실제 Luna 평가에는 OS·CPU·RAM, build 실패, 성공 뒤의 오류, echo만 남은 화면, 중요한 출력이 수집 범위 앞쪽에 있는 화면, 3,000자보다 긴 오류를 포함한다. 현재 구현과 동일 화면·목적으로 비교하고 중요한 정보의 누락·틀린 단정·근거 일치를 검토한다. schema 통과만으로 품질 통과를 선언하지 않는다.

성능은 짧은 status와 1 KiB status, 짧은 analysis와 긴 로그 각각 cold/warm을 분리하고 반복 표본의 중앙값·최댓값을 보고한다. 최소 warm 5회씩 input/output/cached tokens, prompt·schema·지침 bytes, Parent 응답 bytes, thread 시작·모델·정리 시간을 비교한다. status fixture의 입력 1,000 tokens 이하·warm 20초 이하를 목표로 두되 임의 화면에 대한 보장은 하지 않는다. analysis는 기존 전체 전송과 새 항목+원문의 비용을 함께 비교한다. 원문 추가로 Parent 입력이 늘어날 수 있으므로 Worker 비용만 줄었다고 전체 절감으로 보고하지 않는다.

Skill·MCP·Worker 실행 지침은 영어, 계획·일반 설계 문서·보고는 한국어다. 실행 중인 MCP·사용자 terminal·TS legacy·사용자 변경을 보존하며 새 MCP부터 적용한다. 완료 기준은 **불필요한 작업 문맥 없이 독립 분석한 항목별 결과와 검증 가능한 원문을 제한된 크기로 받고, 필요한 근거만 추가 조회하는 것**이다.
