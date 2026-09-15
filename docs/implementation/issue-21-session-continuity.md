# Issue 21: Pane Session과 연결 문맥 변경

## 구현 전 계약

- 세션 fingerprint는 exact pane/terminal/workspace/tab, shell PID, Herdr 연결 연속성 generation, foreground group을 이끄는 SSH process의 PID·group·명령 digest를 사용한다. 일반 local foreground 명령의 시작/끝과 `git fetch`의 SSH transport 자식은 같은 shell session으로 유지한다. 간접 wrapper 안의 SSH를 검증된 primary 연결로 추정하지 않는다.
- Herdr endpoint의 inode 변경, passive 연결 실패 또는 지원 protocol 불일치는 연속성을 불명으로 만든다. 요청마다 정상 종료되는 단기 socket을 재접속으로 오판하지 않는다. Action ACK 하나의 유실은 별도 제출 불명이며, 그 사실만으로 관찰 가능한 동일 shell을 바꾸지 않는다.
- 정상 protocol 응답의 pane-local 거부는 다른 pane의 mode·session을 바꾸지 않는다. 첫 관찰부터 capture 전후 exact session을 비교하고, 변경을 감지한 capture는 Snapshot/Evidence로 반환하지 않는다.
- 관찰한 session이 바뀌면 기존 proposal·Approval·job을 자동 재결합하지 않는다. 새 job은 새 session의 기본 mode 2에서 시작하고 이전 Evidence는 이전 Snapshot을 가리킨다. mode 변경으로 terminal hold를 해제하지 않는다.
- SSH 문맥은 로컬에서 관찰한 process 정보다. argv는 binding digest에 사용하고 비밀일 수 있는 인자를 console/Parent에 원문으로 노출하지 않는다. 사용자 선언 remote identity와 인증 사실을 구분한다. 이 ticket에서 SSH 실행은 활성화하지 않는다.
- 실제 disposable pane move/recreate, fixture의 SSH 진입/종료/재접속·endpoint 교체·passive 연결 실패, 전송 전후 변화를 검증한다. PID/terminal ID가 관찰 사이 재사용된 경우, 감지되지 않는 원격 변화, check/send race, 외부 Herdr client 입력은 보장 밖이다.

## 검증 결과

- Session 전이 공개 테스트 20개, 전체 suite 175개 통과. 변경을 감지한 최초 capture는 원문을 반환하지 않으며 다른 pane의 정식 오류와 local `git fetch`의 SSH 자식은 현재 mode를 유지한다.
- [실제 Herdr 결과](issue-21-local-acceptance.json): 세 mode 각각 pane·terminal ID를 유지한 tab 이동과 pane 재생성을 수행했다. 기존 proposal 입력 0회, 새 session mode 2, 기존 job 자동 재개 0회. owned workspace를 정리했다.
- review의 대상별 오류·첫 capture 결합·보조 SSH process 오판을 재현·수정했다. 재검토 Standards 0건, Spec 0건.
- 기존 Delta 검증 두 곳은 새 계약에 맞춰 session 변경 뒤 새 job의 replacement를 검사한다. 이전 job의 Evidence는 계속 원래 Snapshot만 참조한다.
