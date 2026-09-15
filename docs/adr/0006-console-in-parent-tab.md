# Console은 Parent와 같은 tab의 split pane을 소유한다

사용자는 Codex와 대화하면서 옆 terminal을 동시에 보고 직접 작업하기를 원한다. 별도 workspace를 만든 ADR 0005의 화면 배치는 이 요구를 놓쳤으므로 정정한다.

Console은 검증한 Parent Pane 옆에 Target terminal과 사용자 조작 pane을 split하고 추가 terminal도 같은 tab에 둔다. 소유 범위는 workspace와 tab 및 새로 만든 pane·terminal 식별자로 제한한다. 같은 tab의 다른 pane은 자동으로 등록하지 않는다. 재접속한 Parent도 해당 tab에서 실행해야 한다.

ADR 0005의 Console별 독립 core, 서로 겹치지 않는 Target 소유권, Parent 종료 후 유지, 영속 Control State와 재전송 금지는 유지한다. 기존 Console이나 terminal을 자동 이동·가져오지 않으며 tab 정보가 없는 이전 기록은 보존하고 새 배치로의 재생성을 요구한다. 사용자는 종료할 pane을 직접 닫고, `quit`는 core만 중지한다.
