# Issue 16: 사용자 console과 불변 Proposal

## 구현

[Action 구현 계약](action-lifecycle.md)에 따라 공개 `action_propose`, `action_status`, `session_lower_mode`와 `serve`의 interactive 사용자 console을 연결했다. 이 단계는 입력 전송을 활성화하지 않는다.

- 모든 관찰 job은 exact mapping과 passive `pane.process_info`로 Pane Session을 연결한다. 처음에는 mode 2, 동일 session의 다음 job에는 mode만 유지한다. Action scope가 없는 job은 진단만 한다.
- Proposal에는 exact target·동일 목표·cwd/env·영향 경로·Parent risk review를 고정한다. wrapper·nonce·Enter까지 생성해 digest에 포함하고 수정 API를 제공하지 않는다. command/cwd/env는 별도 subshell의 literal quoting으로 결합한다.
- mode 1은 개별 승인, mode 2는 확인한 읽기·제한 변경의 자동 허용 후보, mode 3은 범위 안의 자동 허용 후보다. 어느 후보도 이 단계에서 wire 입력을 만들지 않는다.
- 위험 판단 구조·고위험 범주·불확실성을 검사한다. Parent의 의미적 판단을 별도 Worker로 재실행하거나 명령 이름으로 저위험을 추정하지 않는다.
- 자체 cancel/deadline은 관찰된 연결 단절로 취급하지 않아 기존 mode를 바꾸지 않는다. 원래 objective의 digest와 redacted 진단용 문구를 구분하며 같은 원문은 redaction 여부에 관계없이 동일 목표로 검증한다.
- 사용자 console의 검토·승인·mode 변경에도 현재 authority를 즉시 확인한다.
- console은 실제 stdin/stdout TTY에서 `review`한 전체 payload의 digest를 기억하고 `approve/reject`를 받는다. 실제 TTY fd를 확인하므로 pipe·다른 stream의 `isTTY` 주장·MCP 승인 field로 권한을 만들 수 없다.
- mode 변경은 revision을 올려 기존 제안을 무효화한다. `revoke`, job 종료·purge·deadline과 session 변경도 승인을 막는다. Approval TTL 5분보다 원래 job deadline이 먼저 오면 그 한도가 적용된다.
- JSON escaping에 더해 C1 control과 방향 제어 문자를 escape해 console이 payload의 control sequence를 실행하거나 숨겨 보여주지 않게 한다.
- scope 문자열, session의 process metadata, purge 후 남는 Proposal 최소 레코드도 공통 메모리 예산에 계측한다. 본문을 지워도 최소 제어 레코드 비용은 유지한다.
- Proposal 본문은 job의 memory 예산을 사용하며 purge 시 함께 제거된다. 응답의 전체 payload는 기존 Parent 전달 예산에 포함한다.

## 검증

`test/actions.test.mjs`는 공개 MCP, 별도 Broker process와 실제 PTY를 통해 아래를 검증한다. Python PTY fixture는 terminal adapter이며 제품 배포에는 포함하지 않는다.

- mode 유지·agent 상향 거부·사용자 상향·위험 불명과 고위험 승인 대기.
- 정확한 payload 표시, 검토 전 승인 거부, 승인 후 mode 변경·철회·cancel 무효화.
- pipe 거부, caller의 approved/actor/token 거부, 다른 owner 접근 차단.
- 원래 job deadline과 TTL 경계, 바뀐 payload에 승인 이전 불가, purge 후 본문 제거.
- 잘못된 mapping, console 자신의 process, TUI foreground에서 Action 거부.
- 모든 경우 `pane.send_input` 호출 0건.

실제 제출과 영속 Control State는 #17, 광범위 session 전이 검증은 #21에서 이어간다. 현재 process metadata만으로 remote identity 인증이나 PID 세대 확인을 주장하지 않는다.

## 완료 기록

Node 24.19.0의 전체 suite 75개를 통과했다. Standards의 메모리/authority/변경 감지 경계와 Spec의 cancel mode 유지/objective redaction/최소 메모리 지적을 수정했고, 재검토는 Standards 0건·Spec 0건이다. 실제 TTY 경로를 사용한 합성 acceptance에서 입력 전송은 0건이다.
