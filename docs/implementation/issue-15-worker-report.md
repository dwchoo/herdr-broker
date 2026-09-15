# Issue 15: 제한된 Codex Worker

## 실행과 결과 계약

[Issue 15](https://github.com/dwchoo/herdr-broker/issues/15)와 Parent D3–D7, D12–D13을 구현한다. 고정 근거는 `13fc41842d871293a7e5109d533388fb4f8f2ffc`의 runtime 실험이며, prototype의 다섯 field 결과를 제품 성공으로 사용하지 않는다.

- `analysis=auto`의 전처리 결과가 4 KiB 이하이면 기존 `prepared_context`, 그 밖에는 `worker_report`를 반환한다. `analysis=worker`는 작은 입력도 Worker에 위임한다.
- 첫 profile은 Codex CLI 0.154.0, `gpt-5.6-luna/low`다. owner config의 검증된 절대 executable만 사용하며 MCP는 executable·model·provider·tool 설정을 받지 않는다.
- 고정 args로 shell·MCP·apps·plugins·host skill·추가 agent·Code Mode·browser·image·memory 도구를 비활성화하고 read-only sandbox, approval never, ephemeral 실행을 적용한다. Config override는 `exec` 뒤에 전달한다. Worker 자체의 도구 권한을 늘리거나 승인 우회 옵션을 쓰지 않는다.
- version 사전 점검에도 같은 allowlisted env와 소유 process group 정리를 적용한다. version timeout·cancel 때도 TERM 뒤 KILL까지 기다리고 core가 child 종료를 확인한다.
- subprocess 환경은 OS 사용자 인증에 필요한 기본 환경만 허용한다. Herdr endpoint·임의 provider credential·Parent의 plugin 설정은 전달하지 않는다. 인증 본문을 읽거나 복사하지 않는다. stdin의 Snapshot과 objective를 유일한 진단 입력으로 취급한다.
- final JSON은 `summary/findings/next_checks/uncertainties` 네 field만 허용한다. strict schema, 4,096 UTF-8 bytes, field/array 상한, Snapshot Evidence membership을 모두 검사한다. exit 0과 `turn.completed`만으로 성공 처리하지 않는다.
- Broker는 Report의 인용 ID를 실제 row에 해석해 bounded Evidence를 제공한다. 인용·schema 검증은 원인 판단의 정확성 증명이 아니다.
- 구조·참조 오류만 같은 Snapshot으로 한 번 repair한다. 호출·repair·usage·지연은 같은 job에 누적하며 timeout·cancel·출력 cap 초과를 repair하지 않는다.
- Worker 동시 실행 1개, job당 4회, 호출당 60초, stdout 전체 256 KiB·event 64 KiB를 지킨다. 관찰한 input+output이 100,000 tokens에 도달하면 다음 호출을 막는다. cached input을 이중 합산하지 않고, 누락 usage와 관찰하지 못한 model은 unavailable/null로 남긴다.
- owner 종료·job cancel/deadline·출력 초과 시 소유한 subprocess group을 정리한다. 재시작 뒤 기록된 PID만으로 process를 죽이지 않는다. provider 계산·기록까지 중단됐다고 표현하지 않는다.
- Broker report는 memory 수명과 기존 64 MiB·16 KiB 예산을 공유한다. CLI ephemeral DB/WAL은 별도 한계이며 전체 no-store를 약속하지 않는다.

## 검증 경계

공개 MCP와 실제 child process에서 성공·malformed/schema/ID·repair·동시성·timeout·cancel·stdout cap을 검증한다. 실제 Codex CLI를 fake provider에 연결해 `tools: []`와 강제 tool 거부를 확인하고, 합성 injection으로 파일 canary와 socket 접근 여부를 확인한다. 실제 Codex Parent→MCP→Worker도 별도로 실행한다.

지원 설정의 공식 참조: [Codex configuration](https://learn.chatgpt.com/docs/config-file/config-sample). 배포 profile의 실제 tool 목록과 process 동작은 pinned CLI probe 결과로 판단한다.

## 검증 결과

- Node 24.19.0에서 기존 전체 suite 56개 통과 후 review 회귀를 추가해 Worker 관련 34개가 통과했다. version hang·allowlisted env와 실패 시 관찰 usage 보존을 공개 MCP로 재현하고 수정했다.
- [실제 CLI probe](issue-15-acceptance.json): valid 네 field 결과, malformed 동일 Snapshot repair 2회 후 typed failure, 강제 shell의 `unsupported call: exec_command`, timeout·cancel을 확인했다. provider request에서 tools field는 생략되었고 해석한 도구 집합은 비어 있었다. 강제 tool 때 Broker는 profile 오류로 닫힌다.
- 실제 합성 injection에서 Worker report에 file canary가 나타나지 않았고 fake socket 연결은 0건이었다. live Worker는 input 8,366 / output 389 tokens, 14.4초였다. 관찰한 model identity는 null이다.
- [실제 Codex Parent 경로](issue-15-parent-acceptance.json)는 `pane_describe → job_start(worker) → job_wait → evidence_get → job_cancel`을 수행했다. Worker input 8,241 / output 398, Parent input 102,198(이 중 cached 84,224) / output 633, 전체 42.4초다. Parent runtime 문맥 비용까지 포함한 값이며 Worker의 낮은 출력량만으로 전체 비용 절감을 주장하지 않는다.
- 첫 Standards review 2건(version child 정리·환경 제한), Spec review 2건(동일 환경 제한·실패 usage)을 수정했다. core/CLI 구현과 합성 provider의 proof를 제품 진단 정확성 평가로 대체하지 않는다. 품질 평가는 #22에서 별도 수행한다.

최종 수정 뒤 전체 suite 61개 통과, 실제 CLI 정상/강제 tool 재검증 통과. 재검토의 Standards 0건, Spec 0건이다.
