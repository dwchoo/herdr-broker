# Worker effort와 service tier

## 구현 계약

2026-09-16 사용자 요청에 따라 호출별 Fast 선택을 추가한다. 이후 지시한 “로그나 출력 분석용 Luna medium, Fast off”를 기본값으로 적용한다.

- `pane_read`의 analysis 기본은 Luna/medium, status 기본은 Luna/low다. 명시적 low·medium·high는 계속 지원한다.
- `service_tier`는 `default`(기본) 또는 `fast`다. 생략해도 SDK의 상속 설정에 맡기지 않고 표준 속도를 명시한다. raw에는 적용하지 않는다.
- SDK 0.154.0의 `turn_service_tier`로 현재 turn에만 적용하며 `fast`는 모델 catalog의 wire 값인 `priority`로 변환한다. thread 기본 tier, model, effort, 권한을 변경하지 않는다. 같은 작업의 다음 호출에서 생략하면 다시 표준 속도다.
- 응답과 내용 없는 timing 로그에 `service_tier_requested`를 제공한다. 실제 제공 tier는 SDK가 노출하지 않으므로 추정하지 않는다. 모델 catalog에서 지원하지 않는 tier는 runtime이 요청에서 생략할 수 있다. Provider 실패는 기존 Worker 오류로 보고하며 Broker가 자동 재시도하거나 모델을 바꾸지 않는다.
- SDK/process·thread 재사용, 입력 범위, raw, 중복 제출 방지는 유지한다. 사용 중인 MCP·terminal을 재시작하지 않고 새 MCP부터 적용한다.

공식 [Fast mode 문서](https://developers.openai.com/api/docs/guides/fast-mode)는 요청 tier와 실제 처리 tier를 구분하며 Fast의 추가 비용을 설명한다. API 설명만으로 현재 Codex runtime의 전달값을 추정하지 않고, 고정된 실제 SDK와 로컬 모의 provider 사이의 요청으로 검증한다.

## 추가 문맥 조사

실제 SDK와 로컬 모의 provider에 합성 한 줄 prompt를 보냈다. 사용자 terminal·SSH 내용을 보내지 않았다. 요청의 각 메시지 구조를 확인하니 다음 내용이 있었다.

| 구성 | 확인한 내용 |
| --- | --- |
| `additional_tools` | 실행 도구 namespace와 함수 설명 등 |
| developer message | Broker의 화면 분석 지침(585 bytes) |
| developer message | 설치된 Skill 목록과 사용 지침(7,243 bytes), read-only·approval 권한 설명(341 bytes) |
| user context | 전역 AGENTS 지침(2,912 bytes), cwd·날짜·shell·filesystem 등 실행 환경(525 bytes) |
| 마지막 user message | 관찰 목적·관찰 ID·짧은 화면·보고 제약(384 bytes) |

이 값은 해당 환경·요청의 UTF-8 본문 크기이며 tokens와 다르다. Parent 대화 전체를 보관해서 붙인 내용은 아니다. 앞서 “SDK 공통 문맥”이라고 묶은 표현은 이 환경이 추가한 도구·Skill·지침·실행 정보를 포함한다. 모든 SDK 환경에서 반드시 같은 비용이 든다는 뜻은 아니다.

화면 1 KiB 제한은 화면 데이터에만 적용한다. 위 문맥과 schema, 이어 쓰는 thread의 앞선 turn은 별도이므로 전체 모델 입력 1,000 tokens를 보장하지 않는다. 기존 도구 비활성화·project_doc_max_bytes 설정이 있어도 이 실행 환경에서 추가 문맥이 관찰됐다. 모델 요청의 도구 설명 존재와 실제 도구 실행 허용은 구분하며, Worker는 요청한 도구 사용을 거부하는 검증 경로를 유지한다. 후속 요청에 따라 `skills.include_instructions=false`, `include_environment_context=false`, `include_apps_instructions=false`, `include_collaboration_mode_instructions=false`, `include_permissions_instructions=false`를 Worker 전용 SDK 설정에 추가한다. 실제 전송에서 Skill·앱·협업·실행 환경·권한 설명 블록이 빠지는지 검사한다. 권한 설명을 생략해도 실제 read-only·deny-all 설정과 도구 거부 검증은 유지한다. thread 생성에는 빈 `developer_instructions`와 `personality="none"`을 명시해 사용자 설정의 일반 추가 지침·말투를 상속하지 않는다. 사용자 전역 설정 파일은 수정하지 않는다. SDK 인증·read-only·deny-all·보고 도구 거부 검증을 유지한다.

사용자는 SDK·기존 인증을 유지하면서 **전역 AGENTS와 도구 설명도 제거**하도록 범위를 넓혔다. Worker 임시 디렉터리 안의 전용 Codex profile을 사용한다. 부모 프로세스의 환경이나 사용자 전역 설정은 바꾸지 않는다. 전용 profile에는 전역·프로젝트 AGENTS와 config를 복사하지 않는다. 기존 Codex home의 `auth.json`만 symlink로 참조하고 종료 시 임시 profile만 삭제한다. 인증 내용은 Broker가 읽거나 복사·기록하지 않으며 갱신은 고정 SDK의 기존 인증 저장 경로가 담당한다. 이 경로는 로컬 file 기반 Codex 인증을 대상으로 하며, file 인증이 없으면 명시적으로 실패한다.

모델의 도구 선택은 feature flag보다 model metadata가 우선한다. 기존 `models_cache.json`에서 실제 Luna metadata를 읽어 Worker 전용 catalog를 만들고, `tool_mode=direct`, `apply_patch_tool_type=null`, `supports_search_tool=false`, `multi_agent_version=null`로 도구 노출만 제한한다. 그 외 model·context window·service tier·guardian metadata를 보존한다. 모델 cache가 없거나 유효한 Luna 항목이 없으면 `worker_model_catalog_unavailable`로 실패하며, 사용자 문맥이 포함된 설정으로 fallback하지 않는다. 이 경우 기존 Codex를 정상 시작해 모델 목록을 갱신한 뒤 새 MCP를 시작한다. Fast feature 자체는 Worker에서 활성화하되 모든 기본 turn은 명시적 `default`로 보내 Fast off를 유지한다.

도구 제한은 공개 tool array와 runtime의 `additional_tools` 안쪽 목록이 모두 비어 있는지 실제 SDK 전송에서 확인한다. 빈 `additional_tools` envelope는 남을 수 있지만 도구 설명·정의는 없다. Worker 지침은 기존 `INSTRUCTIONS` 한 곳에 유지한다. 향후 별도 분석 지침을 도입할 수 있지만 사용자 AGENTS를 자동 상속하지 않는다.

관련 근거: [공식 설정 schema](https://github.com/openai/codex/blob/rust-v0.154.0/codex-rs/core/config.schema.json), [전역 지침 provider](https://github.com/openai/codex/blob/rust-v0.154.0/codex-rs/codex-home/src/instructions/mod.rs), [tool mode 선택](https://github.com/openai/codex/blob/rust-v0.154.0/codex-rs/core/src/tools/mod.rs), [고정 SDK의 file 인증 저장](https://github.com/openai/codex/blob/rust-v0.154.0/codex-rs/login/src/auth/storage.rs).

## 검증 계획

- 공개 MCP에서 medium/low 기본값, 명시적 high, fast/default 전환, 잘못된 tier 거부, raw의 Worker 미호출을 검사한다.
- 실제 고정 SDK와 로컬 모의 provider로 같은 PID·thread에서 호출별 tier 전달과 비지속성을 확인한다. 상속 SDK Fast 설정에도 기본 호출이 표준 속도를 요청하는지 검사한다.
- 전용 profile의 사용자 AGENTS·Skill·도구 정의 제거, 기존 인증 파일 참조·갱신·정리, metadata 부재 오류를 검사하고, 실제 Luna의 합성 화면 입력 tokens를 전후 비교한다. Fast 실측 모델 호출은 하지 않는다.
- Python 전체 test·ruff·mypy·build를 수행하고 시작점 `af28786` 기준 Standards·Spec review 후 변경분만 로컬 commit한다. SDK/process 수명을 변경하지 않으므로 이전 장기 유지 시험은 반복하지 않는다.

## 최종 검증 결과

실제 Codex SDK 0.154.0과 기존 file 인증으로 합성 화면을 분석했다. 모두 표준 속도이며 Fast 유료 모델 호출은 하지 않았다. baseline은 시작점 `af28786`의 Worker다. 재현 스크립트는 `acceptance/worker-profile.py`다.

| 요청 | 화면 bytes | 모델 input tokens | 전체 Worker 호출 | SDK 준비 대기 |
| --- | ---: | ---: | ---: | ---: |
| 기존 status/low | 47 | 5,233 | 12.02초 | 6.218초 |
| 전용 profile status/low | 47 | 350 | 6.95초 | 0.075초 |
| 전용 profile analysis/medium | 47 | 444 | 8.28초 | 0.003 ms |
| 전용 profile status/low, 1 KiB 화면 | 1,024 | 719 | 6.24초 | 0.002 ms |

동일 짧은 화면의 입력은 약 93% 줄었다. 1 KiB 합성 화면의 전체 입력도 1,000 tokens 아래였으나 모든 문자열·긴 objective·누적 thread 문맥에 대한 보장은 아니다. 1 KiB 표본은 Worker에 직접 전달한 byte 한도 검증이며 공개 MCP의 8줄 기본과 별개다. 시간은 각 조건 한 번의 관찰로, 서비스 지연 보장이나 통계적 성능 비교가 아니다. 반복 초기화 여부·thread 재사용은 별도 회귀 테스트로 확인했다.

실제 SDK→로컬 모의 provider에서 사용자 AGENTS·설정 지침·Skill·환경·권한 설명이 빠지고, 공개 tools와 `additional_tools`의 안쪽 목록도 비어 있음을 확인했다. 실제 thread의 read-only·deny-all은 유지됐으며 provider가 도구 호출을 보내도 파일이 생성되지 않았다. 동일 PID·thread에서 `default → fast → default` 요청의 실제 wire tier는 `미지정 → priority → 미지정`이었고 Fast는 다음 호출로 유지되지 않았다. 실제 제공 tier는 SDK가 노출하지 않아 보장하지 않는다.

가짜 인증 파일로 symlink를 통한 갱신과 정리 후 원본 보존을 검사했다. 실제 만료 token의 refresh·여러 Codex의 동시 refresh는 강제로 재현하지 않았다. 모델 metadata 부재·구조 오류는 SDK 종료 후 구체적 오류로 보고하며, background warmup 실패 후 공개 pane_read에서도 같은 오류를 유지한다. 이때 목록·raw는 계속 동작한다.

Python 전체 **132 passed, 1 skipped**(기존 opt-in 장기 유지 시험), ruff·mypy·wheel/sdist build를 통과했다. TS는 Node 24.19.0에서 **261 tests**와 typecheck·build를 통과했다. 초기 시스템 Node 26 실행의 버전 검사 실패는 요구 버전으로 재검증했다. Standards review는 finding 없으며 Spec review의 Fast gate·초기화 오류 보존·catalog 오류 분류 문제를 수정하고 재검토를 통과했다. 사용 중인 MCP·Herdr terminal은 재시작하지 않는다.
