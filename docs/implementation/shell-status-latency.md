# Shell 입력 전 상태 확인 지연

## 보고된 현상과 확인 범위

사용자 보고에서는 입력 전 status 확인과 기존 하드웨어 정보 추출을 하나의 analysis로 요청했다. 첫 호출 전체 약 21.27초 중 capture 약 0.33초, stream 약 20.69초였다. 이후 analysis도 약 20초·27초였다. 당시 실제 입력과 원본 trace는 제공되지 않아 같은 사례를 재현했다고 할 수 없다. stream만으로 모델 추론·출력 생성·서버 대기를 분리할 수 없다.

Skill·MCP 설명·운영 문서에 첫 관찰에서 기존 결과 확인과 현재 입력 상태 확인을 함께 하라는 안내가 있었다. 이는 목적을 합친 선택을 유도할 수 있다. 문서가 실제 지연의 전부를 설명하지는 않는다.

## 수정하는 Parent workflow

- 다음 단계가 새 명령 입력이고 필요한 판단이 현재 프로그램·prompt·미제출 입력·실행 중 여부뿐이면 명시적으로 status를 선택한다. 질문도 이 범위로 제한하고 기본 8줄·1 KiB로 시작한다. 부족할 때만 확장한다.
- 기존 출력에서 사용자 질문의 답을 찾는 것이 현재 작업이면 analysis를 선택한다. 이미 충분히 관찰한 현재 상태를 기계적으로 다시 status 호출하지 않는다. analysis가 필요한 경우 그 관찰의 현재 상태 근거도 활용한다.
- 알려진 이전 결과로 답할 수 있으면 최신성 한계를 알리고 재사용한다. 입력 직전 status에 과거 하드웨어 항목 추출을 추가해 analysis로 바꾸지는 않는다.
- 호환성과 현재 실행 환경을 고려해 필요한 조회를 구성하고, 가능한 결과를 한 번에 분석한다. ACK는 완료가 아니며 미확정 입력을 재전송하지 않는다.

이는 Parent의 도구 선택 안내다. 서버가 objective를 규칙으로 분류하거나 analysis를 강제로 low로 바꾸지 않는다. 기본 analysis·Luna/medium, status·Luna/low, Fast off와 Worker 사용 원칙은 유지한다. 입력 전 상태 확인의 속도를 보장하거나 prompt를 규칙으로 판정하는 기능은 추가하지 않는다.

## 검증

원래 Parent의 선택을 재현하는 자동화된 판단 테스트는 없다. 문구 검색 테스트를 agent 행동의 회귀 검증으로 취급하지 않는다. 기존 공개 MCP 테스트로 status의 기본 범위·effort와 명시적 확장·대상 교체 처리를 확인한다.

실제 SDK의 준비를 마친 뒤 합성 shell 화면·동일 상태 질문으로 status와 analysis를 순서를 번갈아 각각 5회 호출했다. 독립 thread, 같은 SDK 프로세스, 표준 속도를 유지했다. 이 비교는 purpose에 따른 effort·schema 차이를 함께 측정하며 실제 SSH 재현이나 화면 크기 효과를 측정하지 않는다.

| 목적 | 성공/호출 | 성공 시간 중앙값 / 최대 | input tokens 중앙값 | output tokens 중앙값 |
| --- | --- | --- | --- | --- |
| status | 4/5 | 6.11초 / 8.24초 | 281.5 | 155 |
| analysis | 5/5 | 8.78초 / 13.11초 | 723 | 306 |

status의 한 호출은 7.77초 뒤 `worker_invalid_evidence`로 실패했다. 이 시간은 성공 latency에서 제외했으며 자동 재시도하지 않았다. 실패한 모델 원문을 수집하지 않아 구체적인 근거 오류 유형은 미확정이다. 이 별도 신뢰성 문제까지 해결했다고 주장하지 않는다. status가 항상 빠르거나 성공한다는 보장도 아니다.

실행 명령은 `.venv/bin/python /private/tmp/herdr-status-purpose-probe.py`이며, 합성 입력 진단용 script와 결과 `/private/tmp/herdr-status-purpose-probe.json`은 임시 파일로 남겼다. 실제 Herdr·SSH·사용자 terminal에는 접근하지 않았다. 공개 MCP 테스트 `tests/test_read_latency.py tests/test_mcp.py` 34개와 ruff·mypy를 통과했다. 변경은 Skill·운영/MCP 문서·Parent가 받는 tool/초기화 설명뿐이며 Worker prompt·처리 코드는 변경하지 않았다.

이번 수정의 완료 범위는 모드 선택 안내의 충돌 제거다. Parent의 실제 선택 개선과 전체 작업 지연 감소는 후속 사용에서 확인해야 한다. 사용자 보고의 21초 사례가 해결됐다고 단정하지 않는다.
