# SDK 재사용과 분석 thread 수명 검토

상태: 과거 관리 방안 검토와 측정 기록. 후속 구현 기준은 [승인된 SDK 재사용 계획](sdk-reuse.md)을 따른다. 기준: `openai-codex==0.154.0`과 함께 설치된 runtime, 2026-09-16 확인.

## 사용자와 정한 표기·역할

| 작업 | 모델 / effort |
| --- | --- |
| prompt 복귀·미완성 입력·실행 중 여부 확인 | **Luna/low** (`gpt-5.6-luna`, `low`) |
| 로그 해석·오류 진단·중요 내용 선별·종합 분석 | **Luna/high** (`gpt-5.6-luna`, `high`) |

SDK 프로세스는 재사용하며, 같은 pane의 같은 사용자 작업에서는 분석 thread도 재사용한다. Worker는 전달한 화면을 분석하고 Parent가 입력·실행과 승인을 판단한다. 이 결정은 앞선 [지연 개선](read-latency.md)의 일괄 low 기본값을 대체한다. 이 문서를 처음 작성한 검토 시점에는 구현 전이었으며, 현재 구현과 검증 결과는 [SDK 재사용](sdk-reuse.md)을 따른다.

## 구분해야 할 수명

- SDK client / App Server 프로세스: 초기화 비용을 한 번 지불하고 여러 thread를 처리한다. Python client 객체와 자식 프로세스가 각각 메모리를 사용한다.
- 분석 thread: 이전 화면·분석 결과가 이어지는 작업 문맥이다. `ephemeral`도 실행 중 문맥은 메모리에 존재한다.
- turn: 한 번의 분석 호출이다. 완료는 그 호출이 끝났다는 뜻이며 thread 해제를 의미하지 않는다.
- Herdr terminal: 위 객체들과 별개다. 분석 프로세스나 thread를 정리해도 terminal과 SSH를 종료하면 안 된다.

## 소스와 공식 문서에서 확인한 점

### 완료 thread의 해제를 별도로 확인해야 한다

최신 [App Server 문서](https://learn.chatgpt.com/docs/app-server#unsubscribe-from-a-loaded-thread)는 `thread/unsubscribe` 후 마지막 구독자가 없어지고 활동이 없는 상태가 30분 이어지면 unload한다고 설명한다. unsubscribe ACK를 즉시 메모리 해제로 해석할 수 없다. `thread/loaded/list`는 메모리에 올라온 thread 목록을 제공한다. 실제 pinned runtime 결과와 최신 문서가 다를 수 있으므로 버전별 검증을 따른다.

`thread/archive`는 영속 thread의 log를 archive로 옮기는 기능이다. ephemeral thread 정리에 무조건 적용하거나, 빠른 정리를 위해 영속 대화 저장을 켜는 방향은 사용하지 않는다.

### Python SDK의 전역 notification queue

설치된 `_message_router.py`의 `_global_notifications`는 상한 없는 `queue.Queue()`다. turn ID 없는 알림은 이 queue에 들어가며 turn stream을 끝까지 소비해도 별도로 남을 수 있다. 재사용 client에는 전역 알림을 계속 소비하는 경로가 필요하다. 내용은 저장하지 않고 필요한 수명 이벤트와 현재 상태만 처리한다.

turn별 stream은 `finally`에서 구독을 닫고, 마지막 소비자가 사라지면 router가 이벤트를 정리한다. 취소·예외에서도 async stream을 명시적으로 닫아야 한다. 단순히 Python task의 기다림을 취소했다고 서버의 분석이 끝난 것으로 취급하지 않는다.

### 같은 thread에 기록은 실제로 누적된다

짧은 입력이라도 이전 화면과 응답이 thread 문맥에 남는다. 회수만 제한하지 말고 입력 bytes/tokens와 idle 수명도 제한해야 한다. SDK의 자동 compaction에 의존해 무제한 유지하면 추가 모델 호출·지연이나 증거 누락이 생길 수 있다.

현재 화면의 근거 ID는 매 관찰마다 `L0001`부터 시작한다. thread 재사용 시에는 관찰 ID와 줄 ID를 함께 사용해 과거 화면의 `L0001`을 현재 화면의 `L0001`과 혼동하지 않게 해야 한다. 현재 상태 판단은 최신 관찰의 근거로 검증하고 과거 근거는 시점을 구분한다.

### 동시성·취소·프로세스 장애

전체 동시 분석 2개 제한과 별도로 같은 thread의 turn은 직렬화해야 한다. 서로 다른 호출이 SDK의 active-turn joining 동작으로 섞이지 않도록 동시 continuation을 거부한다. 취소 시 `turn/interrupt` 후 종료를 확인하고 stream·구독을 정리한다. 미확정 분석을 다음 호출에 그대로 재사용하지 않는다.

하나의 SDK 프로세스를 공유하면 프로세스 장애가 그 안의 여러 분석에 영향을 준다. 정상 idle 시 계획된 교체는 가능하지만, 종료 여부가 불명확한 채 새 프로세스를 계속 만들면 안 된다. 교체 시 기존 thread handle을 무효화하고 새 관찰을 요구한다. terminal 입력은 자동 재전송하지 않는다.

### 파일과 종료 처리

`history.persistence="none"`, ephemeral과 별개로 SDK runtime의 state·diagnostic 파일이 존재할 수 있다. 현재 구현은 private temporary directory로 경로를 돌리고 client 종료 뒤 폴더를 제거한다. 재사용에서는 이 폴더의 수명이 프로세스와 같아지므로 파일 수·bytes도 계측해야 한다. process가 살아 있는데 cwd/state 폴더만 먼저 삭제하면 안 된다.

정상 종료와 crash를 구분한다. MCP가 정상 종료하면 실행 중 turn과 SDK를 정리한다. 강제 종료에서는 EOF·부모 종료에 따라 자식이 실제 종료되는지 검증하고, 다음 실행은 재개 가능한 durable session이 있다고 가정하지 않는다.

## 제안하는 최소 관리 방식

1. MCP당 SDK 프로세스 하나를 필요할 때 시작하고 재사용한다. 동시 분석은 최대 2개, idle을 포함해 Broker가 유지하는 작업 문맥 수도 작게 제한한다.
2. thread를 `MCP instance + workspace/pane/terminal identity + 작업 식별자`에 연결한다. pane 번호만으로 재사용하거나 다른 작업에 과거 문맥을 넘기지 않는다. 같은 terminal 안에서 프로그램이 바뀔 수도 있으므로 최신 화면 확인은 유지한다.
3. Parent의 명시적인 작업 완료로 문맥을 release한다. 완료 통지를 잊은 경우를 위해 idle 만료도 둔다. 입력량 또는 turn 상한을 넘으면 다음 관찰은 새 thread로 시작하고 전환을 알린다.
4. 각 turn stream과 전역 notification을 소비한다. 완료 결과·화면을 별도 목록에 복제해 보관하지 않는다. payload 없는 카운터만 유지한다.
5. Broker의 논리적 release와 실제 loaded thread 수를 별도로 확인한다. unload가 지연되거나 RSS·파일이 계속 늘면 활성 turn이 없는 경계에서 SDK를 교체한다. 검증 없이 ACK만 보고 해제가 끝났다고 표시하지 않는다.
6. SDK 교체는 MCP 자체를 재시작하지 않는다. 기존 MCP의 입력 중복 방지 기록은 유지한다. 기존 thread는 무효화하며 입력 재전송은 하지 않는다.

상한의 구체적인 수치는 측정 후 정한다. idle만을 이유로 SDK 프로세스를 종료하지 않는다. 자동 요약 계층·영속 DB·작업 목록을 추가하지 않는다. 프로세스를 유지하는 만큼 일정한 상주 메모리 비용은 생긴다. 여러 Codex가 각각 MCP를 실행하면 비용도 증가하며, 공유 library를 포함하는 RSS를 단순 합산해 전용 물리 메모리로 해석하지 않는다.

## 구현 전 완료 조건

- 여러 작업에서 thread 생성·분석·release를 반복해 loaded thread, global queue, turn 구독, child 수, Python/Rust RSS, temporary bytes를 함께 확인한다.
- 한 thread에서 Luna/low와 Luna/high를 바꿔 이어갈 때 문맥량 상한과 근거 시점 구분을 검증한다.
- timeout·취소·EOF·cleanup 실패·동시 continuation·pane 교체를 주입한다. 바쁜 thread에 다른 요청이 합쳐지거나, 살아 있는 orphan SDK가 늘어나면 실패다.
- 지속 증가와 초기 allocator/cache 증가를 구분한다. 짧은 RSS 증가만으로 leak이라 단정하지 않으며, unload 확인만으로 모든 allocator 메모리가 OS에 즉시 반환된다고 주장하지 않는다.

## 이번 실제 runtime 측정

공식 Python SDK와 로컬 모의 provider로 3가지 관리 방식 각각 20개의 새 ephemeral thread를 생성해 1 turn씩 실행했다. provider의 요청 기록은 매번 비웠다. SDK 내부 필드 접근은 진단 계측에만 사용했다. 최종 진단 3개 모두 통과했고 종료 뒤 자식 프로세스 exit와 temporary directory 제거를 확인했다. 모델의 답변 품질·성능을 측정한 실험은 아니다.

| 처리 방식 | 완료 후 loaded thread | 남은 전역 알림 | Python 추적 메모리 시작 → 끝 |
| --- | ---: | ---: | ---: |
| 별도 관리 없음 | 20 | 236 | 468 → 1,049 KiB |
| thread마다 unsubscribe | 20 | 202 | 452 → 909 KiB |
| unsubscribe + 전역 알림 소비 | 20 | 0 | 461 → 502 KiB |

위 값은 20번째 turn 완료 후 짧게 안정화한 관측이며, 30분 유예기간 이후의 해제까지 기다린 실험은 아니다. 전역 알림에는 thread 시작·상태·설정·계정 제한·startup 상태 등이 포함됐다. turn별 router 상태와 응답 waiter는 완료 후 0이었다.

알림 소비 방식의 runtime RSS는 시작 약 231 MiB, 20개 처리 뒤 약 270 MiB였다. Python RSS는 약 72.4 MiB로 거의 같았다. private runtime 폴더는 약 22.6 → 24.4 MiB, 파일 수 15 → 18개였다. 이 값에는 SDK state/diagnostic 파일이 포함되며 대화가 영속 저장됐다는 뜻은 아니다. 파일 내용까지 분류한 측정은 아니다. RSS는 OS 회수·allocator·cache 영향을 받으므로 이 짧은 증가량을 곧바로 누수율로 외삽하지 않는다.

같은 thread에서 6 turn을 이어가며 `Luna/low`와 `Luna/high`를 번갈아 지정하자 provider 요청의 effort도 동일하게 바뀌었다. 입력 항목은 5 → 15개, 직렬화한 입력은 24,240 → 26,600 bytes로 증가했다. 이는 token 수가 아닌 JSON bytes이며, 짧은 합성 입력에서도 과거 turn이 누적됨을 보여준다.

상주 프로세스는 반복 초기화 비용을 줄이지만 약 수백 MiB의 runtime을 유지하는 비용이 있다. 정확한 사용량은 workload에 따라 다르다. `동시 분석 2개`와 `완료 thread가 남아 있는 수`를 분리 관리해야 한다. 이 runtime에서는 unsubscribe만으로 즉시 해제되지 않았으므로, 자원 상한을 넘었을 때 활성 turn이 없는 경계에서 프로세스를 교체하는 방식이 회수 수단이다. 처리 횟수만으로 자주 교체할 근거는 아직 부족하다. 교체를 위해 대화 내용을 archive하거나 새 DB를 둘 필요는 없다.

진단 코드: `/private/tmp/test_herdr_sdk_reuse_probe.py`. 최종 로그: `/private/tmp/herdr-sdk-management-probe-v2.log`. 측정 JSON: `/private/tmp/herdr-sdk-management-unmanaged.json`, `/private/tmp/herdr-sdk-management-unsubscribe.json`, `/private/tmp/herdr-sdk-management-drained.json`.

## 초기화 메모리 추가 진단

설치된 SDK의 `CodexClient.start()`는 Python 내부에서 HTTP 요청만 하는 대신 `codex app-server --listen stdio://` 자식 프로세스를 시작한다. [공식 설명](https://learn.chatgpt.com/docs/app-server)에 따르면 App Server는 인증, 대화 이력, 승인, agent event를 지원하는 runtime이다. 사용하지 않는 도구를 꺼도 이 실행 파일 자체가 작은 화면 요약 전용 프로그램으로 바뀌지는 않는다.

2026-09-16 모델 turn 없이 초기화와 빈 ephemeral thread 생성만 수행하고, 자식 프로세스에 `ps`와 `vmmap -summary`를 적용했다. 현재 Worker 설정과 사용자 설정의 MCP 항목을 각각 명시적으로 비활성화한 설정을 순차 비교했다. 원본 설정은 수정하지 않았고 두 자식의 종료를 확인했다.

| 설정 | initialize | 초기화 직후 RSS | 초기화 직후 physical footprint | 새 thread 생성 |
| --- | ---: | ---: | ---: | ---: |
| 현재 Worker 설정 | 5.124초 | 280.8 MiB | 약 209 MiB | 0.086초 |
| MCP 항목별 명시적 비활성화 | 5.218초 | 269.6 MiB | 약 196 MiB | 0.073초 |

프로세스 spawn 자체는 각각 0.007초와 0.004초였다. 약 5초는 spawn 이후 initialize 응답까지의 구간이다. 내부에서 설정·인증·네트워크·메모리 준비에 각각 얼마를 썼는지는 이 실험으로 분해하지 못했다. 한 쌍의 비교이므로 MCP 비활성화의 효과나 메모리 최솟값을 확정하지 않는다.

현재 설정의 초기화 후 `DefaultMallocZone`에는 live allocation 약 12.0 MiB, dirty+swap 약 141.6 MiB, fragmentation 약 129.6 MiB가 보고됐다. 이는 해당 allocator 영역에 관한 값이며 전체 프로세스의 실제 객체가 12 MiB뿐이라는 뜻은 아니다. `MALLOC_LARGE (empty)` 등 비어 있지만 resident인 영역도 있었다. 초기화 중 확보한 공간이 allocator에 남는 것이 사용량의 상당 부분이라는 근거이며, 어떤 runtime 기능이 그 할당을 만들었는지는 allocation stack을 추적하지 않아 미확인이다. RSS에는 공유 코드도 포함되며 virtual size는 실제 점유 메모리가 아니다. 두 계측은 순차 실행되므로 같은 순간의 값으로 차감하지 않는다.

이미 shell·apps·plugins·multi-agent·Code Mode 등 불필요한 기능을 비활성화한 상태다. 설정만으로 수십 MiB까지 줄일 수 있다는 근거는 현재 없다. 더 줄이려면 native allocator·초기화 할당을 추가 분석하거나 upstream runtime의 경량화가 필요할 수 있다. Python `gc.collect()`가 별도 native 자식의 allocator 공간을 회수하는 수단은 아니다.

따라서 지연을 우선하면 정상 SDK를 MCP 수명 동안 유지한다. 앞서 제안한 10분 idle 종료는 제외하고, 16 thread마다 무조건 교체하는 값도 확정 정책에서 제외한다. 자원 상한과 실제 잔류 thread 수·메모리 증가를 기준으로 필요한 교체만 수행하도록 후속 구현 기준을 조정한다. 최초 초기화 비용은 남으며, MCP 시작 시 분석 프로세스를 미리 준비해 요청 대기와 겹치는 방안은 별도 선택이다.

진단 코드: `/private/tmp/herdr-sdk-footprint-probe.py`. 성공한 비교 로그: `/private/tmp/herdr-sdk-footprint-probe-v3.log`. 측정 JSON: `/private/tmp/herdr-sdk-footprint.json`. runtime 구현은 변경하지 않았다.

## 자동 관리 정책 제안

다음은 구현을 위한 초기 추천값이다. 제품에 적용한 설정이나 장기 부하 검증으로 확정한 수치는 아니다. 현재 관측된 시작 비용·상주 메모리를 기준으로 잡고 반복 시험에서 조정한다.

### SDK 프로세스

- MCP마다 필요할 때 SDK 프로세스 하나를 시작하고 재사용한다. 정상 프로세스는 idle만을 이유로 종료하지 않는다. 분석 thread의 idle 만료와 SDK 프로세스의 수명을 구분한다.
- 새 thread 생성 횟수와 실제 loaded thread 수를 구분해 계측한다. 앞서 제안한 16개 생성 후 무조건 교체는 보류한다. 잔류 thread 상한은 unload까지 포함한 반복 검증으로 정하고, 자원 증가 없이 정상 유지되는 프로세스를 생성 횟수만으로 교체하지 않는다.
- SDK 자식 프로세스 RSS 512 MiB는 자원 교체 기준의 초기 후보이며, physical footprint와 allocator 안정화 이후 증가를 함께 검증해 확정한다. OS 메모리 hard limit은 아니다. 활동 중 30초마다, 각 분석 완료 후 계측하며 수집 실패를 0으로 취급하지 않는다. thread 문맥 상한은 메모리 계측과 독립적으로 적용한다.
- 교체를 예약하면 신규 분석 admission을 닫고 실행 중 분석이 끝나기를 기다린다. 기존 60초 분석 timeout을 유지한다. 대기 Job은 만들지 않고 `worker_recycling`을 반환한다. active turn·SDK 요청 정리가 끝난 뒤 종료·자식 exit를 확인하고 runtime 폴더를 삭제한다.
- 정리 대기는 기존 5초 한도를 사용한다. 이미 소유·식별한 자식 프로세스에 대해 종료를 시도하되 exit를 확인하지 못하면 신규 생성을 중단하고 명시적 오류를 반환한다. 확인되지 않은 이전 프로세스를 두고 교체를 반복하지 않는다.
- 실패한 분석을 자동 재실행하지 않는다. 종료가 확인된 뒤 다음 새 분석 요청에서 새 client/process를 시작한다. 프로세스 교체 전에 idle 작업 문맥이 남아 있었다면 모두 무효화하고 다음 호출에 문맥 전환 사실을 알린다.
- 교체는 SDK만 대상으로 한다. MCP의 mutation dedupe 기록과 Herdr terminal·SSH·진행 중 명령은 유지한다. 새 SDK 프로세스는 살아 있는 이전 프로세스와 겹쳐 미리 띄우지 않는다.

### 분석 thread

- Broker가 유지하는 재사용 작업 문맥은 idle을 포함해 최대 2개다. 별도로 전체 실행 중 분석도 최대 2개이며 같은 thread에서는 한 turn만 허용한다. 같은 thread의 동시 호출은 `analysis_session_busy`로 거부해 기존 turn에 합쳐지지 않게 한다.
- 같은 pane·terminal·작업의 후속 관찰에서만 thread를 재사용한다. 자동으로 마지막 pane thread를 고르지 않고, Parent가 반환된 불투명한 분석 session handle을 다음 `pane_read`에 전달한다. handle이 없으면 새로운 작업으로 취급한다.
- Parent는 작업 완료 시 release를 알린다. 이는 사람이 직접 처리하는 절차가 아니라 project Skill과 MCP interface로 agent가 수행하는 수명 관리다. 누락되면 마지막 분석 종료 후 5분 idle에서 문맥을 release한다.
- thread 하나는 최대 8 turn 또는 누적 128 KiB의 화면·질문·보고 payload를 기준으로 교체한다. bytes는 모델 token 수나 실제 프로세스 RSS와 같은 값이 아니다. 새 입력까지 포함해 한도를 넘을 예정이면 시작 전 새 thread로 바꾸며, 응답으로 넘게 된 경우에는 다음 turn 전에 바꾼다. 개별 화면·입력·보고 한도도 유지한다.
- 새 작업이 들어왔는데 2개 문맥을 유지 중이면 실행 중이 아닌 가장 오래된 문맥을 release한다. 둘 다 실행 중이면 `worker_busy`를 반환한다. 자동 요약·archive·영속 저장은 하지 않는다.
- 정상적인 만료·한도·프로세스 교체로 문맥이 없어져도 같은 정확한 pane identity를 다시 검증하고 새로운 화면으로 분석을 시작할 수 있다. 응답에는 `context_reset=true`와 원인을 제공한다. 이전 문맥이 있어야만 답할 수 있는 질문에는 그 한계를 알린다.
- 존재하지 않거나 다른 대상에 결합된 handle, SDK 재시작 전 불투명 handle을 무조건 신뢰하지 않는다. 만료된 과거 handle 정보를 무한히 보관하는 방식도 사용하지 않는다. 구체적인 handle 검증 계약은 구현 시 현재 프로세스 세대와 대상 identity를 검증하면서 tombstone을 누적하지 않는 형태로 정한다. 대상 종료·교체는 `target_changed`로 거부하며 다른 pane으로 대체하지 않는다.
- 관찰별 ID로 근거 시점을 구분한다. 단순 확인은 **Luna/low**, 분석은 **Luna/high**를 매 turn 명시하며, SDK/thread 재사용 자체가 모델이나 effort를 바꾸지는 않는다.

### 정상 흐름과 예외

일반 사용자는 session을 만들거나 닫는 명령을 직접 관리하지 않는다. Parent가 Skill에 따라 분석 handle을 이어 쓰고 작업 완료를 알린다. idle 만료·문맥 상한·프로세스 교체는 MCP 내부에서 자동 처리한다. 재사용은 서버가 계속 유지할 수 있는 성능 최적화이며, 만료된 문맥이 반드시 복구된다는 약속은 아니다.

분석 timeout/취소 시 먼저 해당 turn에 interrupt를 요청하고 완료를 확인한다. 정상 중단을 확인하면 해당 thread만 정리하고 다른 thread는 유지한다. 중단·통신 상태를 확인할 수 없으면 프로세스를 불건전 상태로 표시해 새 분석을 막는다. 영향을 받은 호출에는 오류를 반환하고 프로세스 종료 확인 후 다음 요청에서 새로 시작한다. 기존에 실패한 화면 분석이나 terminal 입력은 자동 재전송하지 않는다.
