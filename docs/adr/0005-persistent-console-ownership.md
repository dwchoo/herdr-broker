# 지속 Console이 서로 겹치지 않는 terminal을 소유한다

화면 배치는 [ADR 0006](0006-console-in-parent-tab.md)에서 Parent와 같은 tab의 split pane으로 정정했다. 아래 기록의 독립 core와 소유권·수명 결정은 유지한다.

사용자는 Codex와 함께 조작할 실제 terminal을 Console 하나에 모으고, Codex의 정상·비정상 종료 뒤에도 유지해 재접속하기로 했다. Console마다 새 Herdr workspace와 독립 core를 두며, Console이 새로 만든 pane·terminal만 등록해 다른 Console과 소유권이 겹치지 않도록 한다. 기존 외부 terminal 가져오기는 제공하지 않는다.

이 결정은 ADR 0004의 Herdr endpoint당 core 하나 선택을 Console별 독립 실행으로 바꾼다. 같은 terminal에 여러 core가 입력하지 않아야 한다는 이유는 유지하며, 이를 등록된 terminal의 독점 소유·현재 mapping 재검증·Console별 영속 Control State로 충족한다. Parent 연결이 끊겨도 Console과 terminal은 유지하고, 새 Parent는 이전 결과와 hold를 확인해 새 Job으로 이어간다. 이미 제출된 명령은 자동 재전송하지 않는다.
