# SDK 재사용과 목적별 화면 분석

2026-09-16 승인된 구현 기준. 이전 [수명 검토](sdk-reuse-lifecycle-analysis.md)의 후보 정책을 이 문서로 확정한다.

후속 상태 확인 입력 축소는 [status 입력 개선](status-input.md)을 따른다. 아래의 기존 80줄 공통 기본값과 UUID를 행마다 반복하는 Worker 입력은 status 8줄·1 KiB, 단일 관찰 ID와 짧은 행 번호, 전용 status 응답으로 변경한다. SDK·thread 수명 정책은 유지한다.

## 동작과 계약

- 검증된 MCP 시작 시 SDK 하나를 백그라운드에서 준비한다. 모델 호출 없이 초기화하며 metadata·입력은 기다리지 않는다. 정상 SDK는 idle 시간이나 누적 생성 횟수로 종료하지 않는다.
- `pane_read`에 `purpose="analysis"|"status"`, 선택적 `analysis_id`를 추가한다. effort 생략 시 analysis는 Luna/high, status는 Luna/low다. 명시적 low·medium·high는 유지한다.
- 분석 응답은 기존 필드와 함께 analysis ID, observation ID, SDK/thread 재사용 여부, 문맥 초기화 여부·원인을 제공한다. `analysis_release`로 작업 문맥을 정리한다. raw는 분석 문맥을 변경하지 않는다.
- 같은 workspace·pane·terminal과 작업에서만 thread를 이어 쓴다. 재사용 문맥은 idle 포함 2개, 동시 분석 2개, 같은 thread의 동시 turn은 금지한다. 초과 요청을 대기 Job으로 쌓지 않는다.
- 문맥은 작업 완료·5분 idle에서 release한다. 새 작업에 자리가 필요하면 가장 오래된 idle 문맥을 release한다. 만료 ID는 명시적 오류로 반환하며 Parent는 재탐색 후 새 분석을 시작한다. tombstone 목록을 누적하지 않는다.
- 8 turn 또는 누적 화면·질문·보고 128 KiB 한도에서 다음 분석은 새 thread로 전환한다. 새 입력으로 한도를 넘으면 시작 전 전환한다. 자동 요약은 하지 않는다.
- 각 화면에 고유 observation ID와 줄 ID를 붙이고 현재 응답 근거를 이번 화면에만 결합한다. SDK 내부의 bounded 작업 문맥 외에 화면·보고 이력은 보관하지 않는다.
- structured output schema에도 현재 observation ID와 실제 줄 목록을 제한하고 반환 후 실제 줄 존재 여부를 다시 검증한다. status는 요약·주장을 각각 40자 이내로 짧게 쓰고 필요한 최소 근거만 인용하도록 지시한다. byte 상한 위반을 자동 절단하거나 재호출하지 않는다.
- status 보고는 최대 1 KiB·findings 2개, analysis 보고는 최대 4 KiB다. 기본 최근 80줄, 최대 1,000줄·64 KiB, raw 기본 1,000줄을 유지한다. 실제 차분·화면 cache는 이번 범위에 없다.

## 자원·실패 관리

전역 notification과 turn stream을 소비해 폐기한다. 분석 timeout 60초, 정리 대기 5초를 유지한다. 취소 시 interrupt 후 turn 종료를 확인한다. 미확인 상태는 SDK를 불건전 상태로 전환하며 실패한 분석·terminal 입력은 재전송하지 않는다.

30초 간격으로 SDK RSS·임시 파일 bytes를 측정한다. RSS 512 MiB 이상을 최소 30초 간격으로 두 번 관측하거나 임시 폴더가 128 MiB 이상이면 교체한다. 실제 loaded thread가 64개이면 새 thread 생성 전에 교체한다. RSS는 hard limit이나 전용 물리 메모리가 아니며 측정 실패는 unknown이다.

교체 시 신규 분석은 `worker_recycling`, 기존 분석은 완료를 기다린다. 소유한 이전 자식의 exit를 확인한 뒤 폴더를 제거하고 새 SDK를 준비한다. 미확인 종료에서는 신규 생성을 막고 shutdown 때 정리를 한 번 재시도한다. 자동 재시작 루프를 만들지 않는다. SDK 교체는 MCP의 입력 dedupe와 Herdr terminal·SSH에 영향을 주지 않는다.

## 검증과 적용

- 목적별 기본값·명시적 effort·raw·현재 근거·대상 교체·ID 만료·동시성·상한을 공개 MCP와 Worker 테스트에서 확인한다.
- pinned SDK와 모의 provider로 PID 유지·low/high 전환·도구 제한·interrupt·종료 확인·notification 소비를 검증한다.
- 최소 100회 분석과 35분 유지 시험에서 Python 메모리, SDK RSS, 실제 loaded thread, 알림 잔류, 자식 수, 파일을 측정한다. 낮춘 테스트 상한으로 교체를 강제한다.
- Herdr에서 상태 확인→실행→분석을 반복하고 cold/warm 중앙값·최댓값·token을 보고한다. 20초 목표 미달 시 원인을 구분하고 high를 임의로 낮추지 않는다.
- 실행 ACK 직후에는 출력 전 frame을 읽을 수 있다. 실제 marker 출력과 그 뒤 prompt가 근거로 확인될 때까지 읽기만 반복하고, 추가 관찰 시간도 완료 시간에 포함한다. 입력 echo만 확인한 호출을 실행 완료로 집계하지 않는다.
- Python test·ruff·mypy·build, TS test·typecheck·build, Standards·Spec review 후 변경분만 로컬 commit한다. 기존 MCP는 강제 재시작하지 않는다.

## 검증 결과

### 실제 SDK와 Herdr 지연

2026-09-16, `openai-codex==0.154.0`, 기존 인증의 `gpt-5.6-luna`로 측정했다. 상태 확인은 low, 결과 분석은 high다. 합계는 공개 MCP를 통한 상태 확인→입력 접수→실제 marker 출력과 prompt를 근거로 확인한 결과 분석까지다. Parent가 최종 답변을 작성하는 시간은 포함하지 않는다. 소수 표본이며 서비스 지연 보장은 아니다.

SSH는 cold preflight에 13.37초(SDK 준비 대기 5.27초)가 걸렸다. 이후 같은 프로세스·thread의 세 번 실행에서 모두 실제 출력과 prompt를 확인했다.

| SSH warm 반복 | 상태 확인 | 결과 분석 | 입력 포함 합계 | input tokens: 상태 / 분석 | output tokens: 상태 / 분석 |
| --- | ---: | ---: | ---: | ---: | ---: |
| 1 | 6.29초 | 16.12초 | 22.52초 | 11,169 / 14,221 | 211 / 807 |
| 2 | 5.33초 | 9.93초 | 15.38초 | 17,744 / 20,870 | 188 / 468 |
| 3 | 4.32초 | 7.44초 | 11.88초 | 24,202 / 27,408 | 144 / 325 |

SSH warm 중앙값은 **15.38초**, 최댓값은 **22.52초**다. 세 번 중 두 번이 20초 이하였다. SDK 준비 대기는 0.002–0.004 ms, thread 생성은 0 ms로 반복 초기화 비용이 사라졌다. 가장 느린 반복은 stream 구간에 low 6.06초, high 15.88초를 사용했다. SDK가 서비스 내부 queue·입력 처리·추론 시간을 분리하지 않으므로 이를 전부 순수 추론 시간으로 부르지 않는다.

최종 실제 줄 목록 제한까지 적용한 local 시험 결과는 다음과 같다. cold 실행은 첫 결과 보고에서 실제 marker·prompt 근거가 모두 확보되지 않아 추가 읽기 한 번을 포함한다. 이때 명령은 한 번만 보냈다.

| local 반복 | 상태 확인 | 결과 분석 합계 | 입력 포함 합계 | input tokens: 상태 / 마지막 분석 | output tokens: 상태 / 마지막 분석 |
| --- | ---: | ---: | ---: | ---: | ---: |
| cold | 12.81초 | 18.81초, 2회 관찰 | 31.64초 | 5,535 / 7,609 | 187 / 357 |
| warm 1 | 5.78초 | 9.55초 | 15.35초 | 8,690 / 9,985 | 216 / 424 |
| warm 2 | 4.75초 | 9.98초 | 14.95초 | 11,550 / 13,325 | 164 / 432 |

local warm 중앙값 **15.15초**, 최댓값 **15.35초**로 두 번 모두 20초 이하였다. 최초 SDK 준비 대기는 3.80초였고 이후에는 0.002–0.013 ms였다. cold와 추가 관찰을 포함한 모든 상황에서 20초 이하를 달성한 것은 아니다.

같은 thread의 input token에는 이전 turn 문맥이 포함되어 증가한다. 마지막 high의 27,408 input tokens 중 20,224는 cached tokens였다. 화면 차분은 구현하지 않았으며, 8 turn·128 KiB에서 문맥을 바꾸는 이유도 이 증가를 제한하기 위해서다.

초기 시험에서는 입력 직후 출력 전 frame을 캡처한 사례가 있었다. ACK를 완료로 세지 않고 입력 재전송 없이 후속 읽기로 실제 완료를 확인했다. 추가 시험에서 status의 1 KiB 초과와 잘못된 observation ID도 명시적 오류로 차단됐다. 이후 status 작성 지침과 현재 observation ID의 schema pattern을 보강했으며, 위 표는 보강 후 성공한 세 번의 측정이다. 실패한 호출을 성공 시간 표에 섞거나 raw·다른 모델로 전환하지 않았다.

재현 도구는 `acceptance/sdk-reuse-herdr.py`다. 테스트용 local pane만 생성·종료하며, SSH는 지정한 기존 pane의 사전 상태 보고를 검토한 뒤 읽기 전용 조회를 실행한다. 실제 기존 terminal ID와 tab 배치는 유지됐고 사용자 MCP를 재시작하지 않았다.

### 자동 검증과 review

- Python 전체: 112 passed, 장시간 opt-in 1 skipped. 마지막 근거 schema 보강 후 관련 SDK·분석·수명 테스트 32개도 통과했다. 별도 35분 유지 시험과 최종 100회 분석 시험도 각각 통과했다.
- ruff·mypy 통과, wheel·sdist build 통과.
- Node 24.19.0에서 기존 TS 261 tests·typecheck·build 통과. legacy 코드는 변경하지 않았다.
- 구현 시작 commit `6ca130cbeb183e4cdcf00f8779ccfe0a74f49641` 기준 Standards·Spec review에서 초기화 취소·부분 spawn 실패·반복 장애·종료 경합·검증 누락을 수정하고 재검토했다. 최종 actionable finding은 없다.
- EOF·SIGTERM·SIGINT·SIGKILL 및 초기화 중 종료를 실제 process로 확인했다. MCP의 blocking stdin reader 때문에 signal 종료가 지연되지 않도록 SDK 정리를 먼저 공유 task에서 마친다. 실패한 정리는 stderr에 명시하며 새 SDK를 겹쳐 생성하지 않는다.

### 100회 분석과 35분 유지

실제 pinned SDK에 로컬 모의 provider를 연결해 100회 분석한 뒤 총 **2,100.15초** 유지했다. 매 호출에서 새 작업 문맥을 release했고 low/high를 번갈아 사용했다. mock 결과의 token·추론 속도를 실제 모델 성능으로 해석하지 않는다.

| 측정 | 준비 직후 | 관측 최댓값 | 종료 직전 |
| --- | ---: | ---: | ---: |
| Python 추적 할당 | 0.469 MiB | 0.853 MiB | 0.853 MiB |
| SDK RSS | 232.328 MiB | 295.797 MiB | 88.125 MiB |
| SDK 임시 파일 | 22.578 MiB | 29.026 MiB | 22.584 MiB |

- 실제 loaded thread 64개 상한에서 한 번 교체했다. 소유한 SDK 자식은 모든 표본에서 1개였고, 이전 자식 종료를 확인한 뒤 새 자식을 만들었다.
- 교체 이후에는 idle만으로 PID가 바뀌지 않았다. 구독 해제된 thread가 즉시 사라지지는 않았고, 100회 분석 완료 약 60초 후 실제 loaded 수가 0으로 관찰됐다. 최신 공식 문서의 grace와 pinned runtime의 실제 결과를 혼동하지 않는다.
- 전역 notification 잔류는 모든 표본에서 0, 종료 직전 Broker 분석 문맥도 0이었다. shutdown 뒤 소유 자식 전부의 exit와 임시 디렉터리 제거를 확인했다.
- Python 값은 `tracemalloc`이 추적한 할당이며 프로세스 전체 RSS가 아니다. 모의 provider와 측정 기록의 메모리도 포함한다. SDK RSS도 전용 물리 메모리나 OS hard limit이 아니다. 이 표본은 무한 수명에서의 누수 부재를 증명하지 않는다.
- 장시간 시험 중 마지막 보고 schema 제한을 보강했으므로, 최종 schema에서도 별도로 100회 분석을 실행했다(58.12초). 자식 수 1개·notification 잔류 0개와 종료 후 자식 exit·임시 디렉터리 제거를 다시 확인했다. SDK 수명 코드는 동일하다.

### 적용

새 MCP 실행부터 적용된다. 실행 중인 MCP나 사용자 terminal을 강제로 재시작하지 않는다. Parent는 작업 중 반환된 `analysis_id`를 사용하고 작업 완료 시 `analysis_release`한다. `$broker` Skill과 공개 MCP 설명에 이 흐름을 반영했다.
