# 상태 확인 입력 축소

## 문제와 검증 기준

상태 확인은 Luna/low를 사용하지만 최근 80줄과 분석 보고 형식을 그대로 사용한다. 관찰 UUID를 행마다 반복하고, `input_bytes`에는 JSON·지침·schema가 포함되지 않는다. 같은 thread를 이어 쓰면 이전 입력도 모델 문맥에 남는다.

먼저 공개 `pane_read`와 실제 SDK→로컬 모의 provider 경로에서 입력 범위와 요청 크기를 재현한다. 화면 원문을 진단 로그에 남기지 않고, 화면·질문·조립 prompt·schema·고정 지침의 UTF-8 bytes를 구분해 측정한다. SDK가 보고한 input/cached/output tokens는 별도 지표다.

## 변경 방향

- status 기본 관찰은 최근 8줄·1 KiB로 줄인다. 사용자가 단순 대기 여부 확인에는 1k 정도를 원한다고 추가 지시했다. 전체 모델 입력 약 1,000 tokens도 목표로 측정하되 SDK 고정 문맥까지 포함한 달성을 가정하지 않는다. 분석은 80줄·64 KiB, 명시적 `max_lines` 확장은 최대 1,000줄·64 KiB를 유지한다. 짧은 관찰은 전체 상태를 보장하지 않으며 부족하면 Parent가 범위를 넓혀 읽는다.
- 관찰 ID는 화면 전체에 한 번만 붙이고 행에는 짧은 번호를 쓴다. 응답에서 관찰 ID와 실제 행 존재를 검증한 뒤 공개 evidence에는 기존 `관찰 ID:줄 ID` 형식을 복원한다.
- status는 Worker 내부의 짧은 전용 응답을 사용하고 공개 `report` 형식은 보존한다. 판단 불가·미완성 입력·실행 중 상태를 단정적으로 입력 허용으로 바꾸지 않는다.
- status는 Luna/low, 분석은 Luna/high를 유지한다. SDK와 작업 thread의 기존 재사용·상한 정책도 유지한다. 입력 압축이 이전 thread 문맥을 없애지는 않는다.
- 현재 요청의 조립 크기와 누적 context·SDK tokens를 구분해 공개한다. 실제 전송 전체 bytes와 모델 tokens를 동일한 값으로 취급하지 않는다.

## 검증 결과

### 재현과 입력 구조

공개 MCP 회귀 테스트에서 기존 코드는 73줄을 그대로 전달하고 18,022 bytes의 긴 줄도 status로 보냈다. 테스트는 각각 8줄·1,024 bytes 이내와 마지막 미완성 입력 보존을 검사한다. 명시적으로 80줄로 확장하면 원래 화면을 다시 받을 수 있으며 자동 후속 호출은 없다.

같은 73줄을 실제 SDK와 로컬 모의 provider에 전달한 초기 구조 비교에서 prompt의 관찰 UUID 반복은 **74회→1회**, status schema는 **1,384→486 bytes**로 줄었다. 화면 축소와 별도로 내부 형식 비용도 줄어드는 것을 확인했다. 모의 provider의 token usage는 성능 수치로 사용하지 않았다.

### 실제 Luna 측정

합성 OS·하드웨어 과거 출력 72줄과 마지막 shell prompt를 사용했다. 같은 텍스트를 baseline 전체 읽기, baseline의 최근 8줄, 최종 8줄 형식으로 비교했다. 사용자 SSH나 terminal에 입력을 보내지 않았다.

| 요청 | 모델 input tokens | cached tokens | 비고 |
| --- | ---: | ---: | --- |
| 기존 73줄 status | 8,915 | 0 | 이전 형식·Luna/low |
| 기존 형식에서 8줄만 읽기 | 5,768 | 4,864 | 화면 범위만 축소 |
| 최종 8줄 status | 5,390 | 0 | 짧은 ID·전용 schema·Luna/low |

전체 입력은 약 **40% 감소**했지만 **1,000 tokens 목표에는 미달**했다. 최종 8줄 화면은 489 bytes, objective 71 bytes, 조립 prompt 957 bytes, schema 485 bytes, 고정 지침 585 bytes다. 애플리케이션이 직접 조립한 합계는 2,027 bytes이며 SDK 전체 전송량과 동일하지 않다.

빈 화면도 최종 모델 입력이 5,200 tokens였다. 모의 provider에서 확인한 짧은 status의 SDK 요청에는 애플리케이션 prompt 외에 `additional_tools` 항목 약 10.6 KB, developer message 약 7.8 KB, 별도 user context 약 3.7 KB 등이 있었다. 이는 이 실행 환경의 요청 본문 bytes 측정이며, 각 부분의 token 수는 분리 측정하지 않았다. `developer_instructions`를 빈 값으로 명시한 대조 시험에서도 요청 크기는 동일했다. 권한·SDK 내부 문맥을 우회하거나 SDK를 교체하지 않았다.

최종 실제 모델 시험에서는 표시된 prompt는 대기로, 미완성 heredoc은 추가 입력 중으로, prompt가 돌아오지 않은 명령은 실행 중으로 해석했다. 빈 화면은 불확실하다고 보고하고 더 넓은 읽기를 제안했다. 마지막 상태 확인은 warm 기준 약 5.20초였다. 합성 사례의 관찰 결과이며 모든 shell·TUI 상태 판단의 정확도를 보장하는 수치는 아니다.

동일 thread의 후속 분석도 실제 실행했다. 문맥이 누적되므로 SDK 프로세스 재사용이나 입력 압축이 다음 호출의 token 수를 초기 상태로 되돌리지는 않는다. 기존 8 turn·128 KiB 문맥 상한과 `analysis_release`를 유지한다.

재현 스크립트는 `acceptance/status-input.py`다. `--baseline-worker`에 commit `2dafcbd`의 `python/herdr_broker/worker.py`를 추출한 파일을 전달하면 이전 구현과 비교한다. benchmark artifact의 화면은 합성 데이터이며, production 진단 로그에는 크기·시간만 남긴다.

### 회귀 검증과 적용

Python 전체 115 tests, ruff, mypy, wheel·sdist build를 통과했다. 기존 35분 유지 시험은 opt-in으로 이번 실행에서 제외했다. SDK/process 수명 코드는 변경하지 않았다. Standards·Spec review에서 추가 actionable finding은 없었다.

새 MCP 실행부터 적용하며, 실행 중인 MCP·Herdr terminal을 재시작하지 않는다. 사용자 README 변경과 기존 미추적 파일은 보존한다.

## 후속 설정 변경

위 수치와 high 분석은 당시 측정 조건이다. 이후 사용자 요청으로 로그·출력 analysis 기본은 Luna/medium, Fast는 off로 변경한다. 추가 문맥의 실제 구성과 tier 계약은 [Worker service tier](service-tier.md)에 기록한다.
