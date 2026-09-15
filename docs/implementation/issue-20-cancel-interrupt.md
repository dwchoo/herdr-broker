# Issue 20: 취소·interrupt·사용자 복구

## 구현 전 계약

- `job_cancel`은 Worker와 미제출 입력을 중지한다. intent 뒤의 제출 사실과 제한된 passive 관찰은 유지하며 자동 Ctrl-C는 없다.
- `interrupt`는 현재 Pane Session과 같은 terminal의 held 일반 Action ID에 결합한다. 정확한 payload는 `{text: "", keys: ["Ctrl+c"]}`다. Herdr 0.9.0의 기존 adapter 실험에서 확인한 key spelling을 실제 disposable shell에서 다시 검증한다. command·env 변경·Enter를 섞지 않는다.
- 일반 입력 3회와 interrupt 1회를 job별로 따로 센다. 취소·deadline 이후의 job은 제어 입력도 시작하지 않는다. 새 active job에서 원래 Action을 명시적으로 결합할 수 있지만 관찰 가능한 같은 Pane Session이어야 한다. restart 뒤 이전 process 연속성이 불명하면 자동 interrupt 대신 사용자 복구를 요구한다.
- 승인 대기는 queue를 점유하지 않는다. 허용된 제출은 terminal별 wire queue에서 직렬화하고, 원래 Action의 hold가 있어도 허용된 interrupt 한 건은 통과한다. 두 receipt를 별도로 보존하며 interrupt는 `not_applicable`·null exit다. ACK는 원래 hold를 해제하지 않는다.
- interrupt가 dispatching/unknown인 동안 원래 명령의 완료 표식이 와도 hold를 유지한다. `interrupt_unconfirmed` 근거와 관련 control 기록은 원래 hold가 있는 동안 축약하지 않는다. 늦은 ACK는 사실만 보완하고 이 hold는 사용자 확인 복구를 요구한다.
- console의 `inspect <pane_id>`는 passive mapping/process 관찰과 현재 shell 준비 상태·hold ID를 보여준다. interactive 사용자의 `recover <original_proposal_id> <새 목표>`는 inspect한 binding을 다시 확인하고 ready shell일 때만 hold를 해제한다. 복구 근거와 시각을 기록하고 원래 unknown/exit null은 보존한다.
- 복구는 기존 job·pending proposal을 무효화하며 새 목표로 새 job을 시작해야 한다. mode 선택만으로는 hold를 해제하지 않는다. command나 목표 원문을 영속 Control State에 기록하지 않는다.

## 완료 확인

공개 MCP와 실제 interactive console에서 세 mode, cancel 시점, 승인 대기/queue 경합, interrupt budget과 deadline, 원래 표식 없는 ACK, restart hold의 사용자 복구를 확인한다. 실제 Herdr disposable POSIX shell의 `sleep`에 허용된 Ctrl-C를 보내고 재관찰한다. 테스트가 소유하지 않은 PID를 종료하지 않는다. Worker와 Parent 누적 budget 경계는 기존 공개 suite와 함께 확인한다.

## 검증 결과

- interrupt/복구 공개 테스트 11개, 기존 recovery와 합쳐 34개, #20까지 전체 suite 155개 통과.
- [실제 Herdr 결과](issue-20-local-acceptance.json): busy `sleep 20`에 명시적 Ctrl+c 1회. interrupt accepted/not_applicable, 원래 Action outcome_unknown/null exit와 hold 유지. fresh ready shell 검사와 새 목표 복구 뒤 새 명령 exit 0. Broker wire 총 3회, 자동 Ctrl-C 0회. 임시 workspace는 정리했다.
- 원래 완료 표식이 unknown interrupt를 지우는 Spec review 1건을 재현·수정했다. 재검토 Standards 0건, Spec 0건. 관련 control 기록과 hold는 restart에도 보존한다.
- Worker 종료·repair·stream/token·Parent payload·deadline 검증은 기존 공개 suite를 함께 실행했다. ACK와 관측 가능한 local shell 상태를 remote process 종료 보장으로 확대하지 않는다.
