# 화면 분석 지연 개선

## 문제와 범위

사용자 관측에서 실행 전·후 `pane_read`가 각각 약 31초 걸렸다. 당시 Worker 입력은 8,749·13,690 tokens였고 모든 분석이 Luna/high였다. 명령 접수 0.5초는 실행 시간과 다르다. 과거 관측만으로 모델 대기·추론·SDK 시작 중 주원인을 확정하지 않는다.

이번 변경은 Worker를 통한 분석을 유지하면서 기본 effort를 `low`, 최근 읽기 범위를 80줄로 줄인다. Parent는 `objective`에 사용자의 실제 질문을 포함해 현재 프로그램·미완성 입력·기존 관련 결과를 함께 확인한다. 결과의 최신성이 필요하거나 기존 증거가 부족할 때 실행한다. 실행 후에는 예상 출력과 prompt 복귀를 함께 확인하며 입력 echo를 결과로 취급하지 않는다.

## 계약

- `pane_read(effort="low", max_lines=80)`가 기본이다. effort는 `low`·`medium`·`high`, 범위는 1–1,000줄이다. 명시적 raw 읽기는 기존 1,000줄 기본을 유지한다.
- 정보가 잘렸거나 현재 프로그램·입력 상태가 불명확하면 Parent가 범위를 넓히거나 effort를 높인다. 자동 추가 모델 호출·자동 명령 재실행은 없다.
- Herdr에서 최근 범위를 요청하고, 응답에서도 줄 수와 64 KiB를 제한한다. 응답에는 선택 범위·잘림·완전하지 않은 이력임을 표시한다. Worker 공통 지침에는 제한된 최근 화면임을 알린다. 줄 번호는 이번 관찰에만 유효하다.
- 후속 읽기도 최근 범위의 새 화면이다. Herdr revision은 변경 여부 정보이지 append-only cursor가 아니다. 차이만 남기다가 재그리기·부분 입력을 놓치지 않도록 실제 delta API나 화면 캐시는 추가하지 않는다.
- 출력 schema에 모든 줄 ID를 열거하지 않는다. 반환된 evidence ID가 실제 제공한 줄에 속하는지 Python에서 계속 검증한다.
- 성공 응답의 `timings_ms`에 admission, capture(앞뒤 identity 확인 포함), SDK 시작, turn 접수, 첫 event 대기, 나머지 stream, 보고 검증, 정리, 최종 identity 확인, 전체 시간을 기록한다. total은 Broker read 메서드 진입부터 반환까지이며 앞선 MCP context 검증·전송·Parent 처리는 제외한다. SDK가 노출하지 않는 provider queue·입력 처리·추론 시간을 임의로 분리하지 않는다. 첫 event는 첫 답변 token을 뜻하지 않는다.
- Worker 분석 실패도 내용 없는 timing 진단을 stderr에 남긴다. 화면·질문·요약·명령은 진단 로그에 넣지 않는다.
- 대화·화면·완료 보고를 새로 저장하지 않는다. 기존 Worker 2개 상한·timeout·정리·중복 입력 방지는 유지한다.

## 완료 기준

공개 MCP에서 짧은 기본 범위와 명시적 범위·effort, 잘림, 원문 호환성, 교체된 대상 거부를 검증한다. 실제 SDK+모의 provider에서 effort 전달·도구 제한·근거 검증과 계측을 검증한다. 실제 모델에는 같은 가상 OS·하드웨어 화면을 보내 변경 전후 시간을 비교하고, 미완성 입력·실행 중 작업·marker echo 판별을 점검한다. 실제 모델 측정은 작은 표본이며 고정 SLA로 해석하지 않는다.

## 실제 SDK·모델 비교

2026-09-16 같은 가상 OS·하드웨어 화면에 이전 build 기록 220줄을 붙여 실제 Codex SDK와 Luna를 순차 호출했다. 실행 전/후에 해당하는 두 화면을 사용했으며 실제 SSH 명령 실행 시간을 측정한 것은 아니다. 모델 서비스 부하·순서에 따른 편차가 있는 각 1회 비교다.

| 관찰 | 이전 high·전체 범위 | 변경 low·최근 80줄 | 입력 tokens 이전 → 변경 |
| --- | ---: | ---: | ---: |
| 실행 전 화면 | 39.130초 | 20.785초 | 11,392 → 7,146 |
| 실행 후 화면 | 26.696초 | 18.795초 | 11,547 → 7,083 |
| 합계 | 65.826초 | 39.580초 | 약 38% 감소 |

두 분석의 합계는 약 40% 감소했다. 변경 후 SDK 시작은 각각 6.869·6.277초, 나머지 event stream은 13.850·12.501초, 정리는 0.052·0.012초였다. SDK 시작은 client 초기화와 `thread_start` 전체이며 내부 provider 대기와 순수 프로세스 생성 시간을 따로 분리한 값은 아니다. baseline에는 세부 계측이 없어 이전 39초의 원인을 사후 분해할 수 없다. effort·범위·schema 변경을 함께 적용한 비교이므로 각각의 효과를 독립적으로 확정하지 않는다.

새 첫 관찰은 기존 OS·CPU·RAM·디스크 결과로 답할 수 있다고 보고하면서 최신성은 알 수 없다고 밝혔다. Parent가 이 결과로 요청을 충족할 수 있다고 판단하면 재실행과 두 번째 관찰을 생략할 수 있다. 이 표는 비교를 위해 두 번 모두 호출한 결과이며 실제 Parent 대화 전체 시간을 측정한 값은 아니다.

별도의 실제 Luna/low 관찰 세 건에서 닫히지 않은 quote가 있는 입력, prompt가 돌아오지 않은 `sleep 120`, heredoc 소스의 `DONE_MARKER`를 확인했다. 모두 새 명령 입력이 안전하다고 단정하지 않았고, marker 입력 echo를 실제 출력으로 오인하지 않았다. 소수의 가상 화면 점검이며 모든 terminal/TUI에 대한 정확도 보증은 아니다.

진단 산출물은 `/private/tmp/herdr-latency-probe.py`, `/private/tmp/herdr-latency-baseline.json`, `/private/tmp/herdr-latency-optimized.json`, `/private/tmp/herdr-latency-safety.py`, `/private/tmp/herdr-latency-safety.json`에 두었다. 실제 사용자 화면·SSH 내용은 이번 모델 측정에 사용하지 않았다.

## 자동 검증

Python 테스트 94개 통과(실제 SDK+로컬 모의 provider 11개, 나머지 전체 83개), Ruff·strict mypy·wheel/sdist build 통과. 기본 범위와 미완성 마지막 줄 유지, 명시 범위·effort, raw 호환성, 잘못된 옵션, 분석 중 대상 교체, 없는 evidence 거부, 실패 timing 로그의 내용 미노출을 검증했다. 기존 concurrency·취소·정리·중복 입력 검증도 포함한다. TS legacy 구현은 변경하지 않았다.

새 default와 tool schema는 다음 MCP 연결부터 적용한다. 실행 중인 Codex/MCP나 Herdr terminal은 자동 재시작하지 않는다.
