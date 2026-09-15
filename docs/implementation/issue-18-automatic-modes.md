# Issue 18: 진단 후 위험 판단에 따른 자동 실행

## 구현 전 계약

기존 mode 1의 durable submit 경로에 mode 2·3을 연결한다. 별도의 위험 검토 Worker를 추가하지 않고 Parent가 읽은 report/Evidence와 inspected action의 영향·복구·불확실성을 제안에 기록한다.

- mode 2는 inspected read/bounded_change이며 불확실성과 고위험 category가 없을 때 자동 허용한다. 누락/형식 오류/미확인 script/고위험/불명에는 사용자 승인이 필요하다.
- mode 3은 scoped high/unknown에도 개별 승인 없이 실행한다. objective·exact binding·session revision·취소·deadline·예산·terminal hold는 공통으로 검사한다.
- receipt의 `authorization`으로 user_approval, parent_risk_review, autonomous를 구분한다. 자동 허용에는 Approval 소비가 없으며 같은 immutable intent/receipt/단일 전송을 사용한다.
- 비신뢰 scope의 marker는 완료 관찰로 기록할 수 있지만 다음 자동 입력의 근거로 사용하지 않는다. terminal에 남긴 hold는 새 job의 trusted 선언이나 mode 3 선택으로 지워지지 않는다. #20의 console 복구에서 사용자가 현재 shell과 새 목표를 확인한 뒤 입력을 재개한다.
- 최초 진단, Evidence, 반복 응답, Action payload와 후속 재관찰은 기존 job의 Parent 16 KiB, Worker 4회, 일반 Action 3회, 300초 예산을 공유한다. 새 proposal이나 분석 완료로 초기화하지 않는다.
- SSH는 #24의 실제 acceptance까지 비활성이다.

## 검증 기준

공개 MCP와 실제 interactive console의 정책 결정표를 input count·receipt로 대조한다. disposable local shell에서 자동 실행 효과를 확인하고 실제 Codex Parent가 진단→위험 판단→제안→제출→재관찰을 수행한 transcript의 tool 결과와 usage를 기록한다. mode 1 회귀와 임의 상향 거부, stale revision·scope·hold·cancel·budget의 입력 차단도 확인한다.

## 실행 중 발견과 보정

첫 실제 Parent 실행은 `risk_invalid_or_missing`으로 제출이 차단되어 input 0이었다. runtime은 위험 판단 구조를 검사했지만 MCP input schema는 `unknown`으로만 공개해 필수 field를 발견할 수 없었다. 위험 판단의 구조를 schema에 공개하면서 잘못된 판단을 승인 대기로 받는 기존 정책은 유지했다. `pane_describe`의 자동 실행 capability 표시와 Evidence의 여러 행 반환 설명도 갱신했다. [첫 실행 기록](issue-18-parent-initial.json)을 성공 기록과 구분해 보존한다.

## 완료 검증

- Node 24.19.0 전체 suite 121개, 자동 mode 정책 13개와 기존 실행 경로를 합친 46개가 통과했다. schema 보정 후 자동 mode 13개를 다시 확인했다.
- mode 2의 7개 승인 필요 조건에서 input 0, 사용자 승인한 mode 2 고위험 입력의 authorization 구분, mode 3의 scoped 삭제 효과·unknown 허용, scope/목표/stale revision/상향/취소/4번째 시도 차단을 확인했다.
- 비신뢰 완료 뒤 새 job에서 trusted를 선언하고 mode 3으로 올려도 terminal hold를 우회하지 못한다.
- [실제 Codex Parent 재실행](issue-18-parent-acceptance.json)이 진단→Evidence→Parent risk review→단일 `/bin/sh` 입력→exit 0 관찰→같은 job 재관찰→cancel을 완료했다. disposable `build.config`의 실제 bytes가 `configured\n`인지 별도로 확인했다. Worker 호출은 없었다. 실행 대상은 Herdr protocol peer 뒤의 실제 local shell이며 native Herdr 검증은 #17과 구분한다.
- 성공 실행은 62.5초, Parent 관찰 usage는 input 193,643 / cached input 147,968 / output 1,325 tokens였고 job의 누적 전달+Action payload는 14,758 bytes였다. 앞선 실패 실행 64.6초와 input 205,984 / cached 178,432 / output 1,650도 별도 기록했다. cached input을 input에 다시 더하지 않으며 이를 비용 절감이나 일반 품질의 측정으로 해석하지 않는다.
- code-review의 Standards·Spec 잔여 finding은 각각 0개다.
