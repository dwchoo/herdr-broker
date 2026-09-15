# Issue 23: 설치 package와 운영 점검

## 구현 전 계약

- Node 24/macOS arm64에서 배포 tarball을 별도 directory에 설치한다. compiled ESM CLI·native SQLite·shrinkwrap integrity를 확인하며 설치된 절대 executable로 `serve`, `mcp`, `doctor`를 실행한다. registry publish는 하지 않는다.
- `doctor`는 Node/platform·native SQLite, Herdr 0.9.0/protocol 22, Codex 0.154.0와 고정 Worker profile, state directory/파일 소유권·mode·쓰기 가능 여부를 점검한다. pane 입력과 model inference는 하지 않는다. 실제 계정의 model 이용 가능성은 확인하지 않았다고 표시한다.
- 쓰기 probe는 Broker의 state root 또는 이미 존재하는 endpoint directory 안의 임시 파일만 사용한다. 아직 없는 canonical endpoint directory나 authority/ledger를 만들지 않아 이후 최초 `serve`를 방해하지 않는다. 잘못된 기존 권한을 doctor가 조용히 수정하지 않는다.
- console status/help에 작업·세션·승인·제출/관찰·남은 Action/interrupt/Worker/Parent budget·redaction/gaps/retention·hold 복구 명령을 표시한다. 원문·command·Evidence quote는 status에 넣지 않는다. exact payload는 명시적 `review`에서만 보여준다.
- 새 사용자 문서에 설치/설정/기동/승인/취소/purge/복구/오류 점검을 정리한다. 기존 사용자 README 변경은 보존한다. MCP 문서는 영어를 유지한다.
- 실제 설치 acceptance는 테스트가 소유한 Herdr proxy endpoint와 새 pane을 사용한다. 필요할 때 owner config를 byte 단위로 백업·복원하며 기존 설정·자격 증명을 출력하지 않는다. config/state 위치를 caller 인자로 우회하지 않는다.
- 본문 30분·64 MiB 회계·oldest ended 우선 제거, explicit purge·restart 후 Control State 유지, 7일 기록 축약은 공개 suite와 설치 artifact에서 확인한다. `broker_memory`는 Broker 진단 본문의 보존 범위이며 Codex ephemeral DB/WAL과 provider 기록까지 no-store로 보장하지 않는다.

## Review 보완

두 review에서 읽기 전용(0400) ledger를 doctor가 writable로 보고하는 동일 문제를 발견했다. private directory는 0700, 기존 DB/identity/socket은 0600까지 검사하도록 보완한다. 잘못된 권한을 수정하지 않으며 실제 doctor process 회귀로 확인한다.

설치 acceptance의 기존 owner config는 private backup을 저장하고 같은 directory의 완성된 임시 파일을 rename하여 교체·복원한다. cleanup hook은 교체 전에 등록하며, 다른 변경을 발견하면 덮어쓰지 않는다. Codex 0.154.0의 ephemeral Parent는 guardian approval fork를 만들 수 없어 실제 도구 호출이 멈춘 실행을 기록했다. 실제 approval review를 쓰는 Parent acceptance는 ephemeral을 끄고 SQLite/log를 소유 임시 directory에 두어 종료 후 제거한다. 진단 전용 Worker의 기존 ephemeral profile은 유지한다.

## 검증 결과

- Node 24.19.0/macOS arm64 tarball 설치, native SQLite·shrinkwrap 포함 파일 목록·SHA512 integrity는 [설치 acceptance](issue-23-installed-acceptance.json)에 보존했다.
- 설치 executable의 `doctor/serve/mcp`, 실제 Codex Parent의 describe→job→Evidence→proposal→status→cancel, 별도 설치 facade의 initialize/10 tools를 통과했다. mode 1 입력 0, pending 본문 purge와 승인 차단, DB 본문 누출 0, directory0700/file/socket0600을 확인했다.
- 초기 acceptance의 purge assertion 오류와 ephemeral/guardian 충돌을 남기고 수정했다. 세 번째 실행은 55.8초에 통과했다. 제품 Worker profile과 사용자 정책은 변경하지 않았다.
- 전체 공개 suite 180개 통과 뒤 review 권한 회귀를 추가했으며 operations 5개가 통과했다. 기본 64 MiB 활성 압박·purge 회복도 실제 console에서 확인했다. 30분·7일/SQLite crash·unknown hold는 앞선 public process suite를 유지한다.
- 최종 #24 package에서 SSH profile을 포함한 설치·종료·unknown hold/restart 검증과 artifact 재생성을 마무리한다. registry publish는 하지 않았다.
