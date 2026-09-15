# Issue 24: 실제 SSH 통합과 최종 MVP 검증

이 문서의 설치 acceptance와 tarball 재현 절차는 #24 완료 시점 `ae7e0f5` 및 [당시 artifact receipt](final-artifact.json)에 대한 기록이다. 이후 Herdr 내부 실행 제한이 추가됐다. 기존 `installed-harness`는 설정만 proxy endpoint로 바꾸므로 현재 checkout의 `installed-operations`·`ssh-installed` 실행은 새 문맥 검사에서 거부된다. 현재 checkout은 [project skill의 검증 절차와 결과](project-skill-herdr-context.md)를 사용하며, 아래 과거 설치 결과를 새 tarball의 통과 근거로 삼지 않는다.

## 구현 전 계약

실행 환경은 이 Mac의 disposable localhost OpenSSH endpoint `127.0.0.1:65345`, OS 사용자 `dwchoo`, key-only 인증, 새 Herdr workspace의 SSH `-tt` POSIX `/bin/sh`다. host/client key와 known_hosts는 소유 임시 directory에만 두고 기존 SSH 설정·authorized_keys를 변경하지 않는다. 원격 cwd는 테스트가 만든 임시 directory다. 원격에는 AI runtime이나 AI credential을 설치하지 않는다. 이 localhost 검증이 임의 Linux host·네트워크 장애 조합을 보장하지는 않는다.

## SSH shell 준비 확인

- 로컬 `ssh` PID/argv는 원격 shell idle 상태나 host/user identity를 인증하지 못한다. 새 SSH session은 기본 mode 2이지만 passive 상태로 시작한다.
- 사용자가 실제 pane의 idle POSIX shell과 cwd를 확인하고 interactive console에서 `inspect <pane_id>` 후 `ssh-ready <pane_session_id> <absolute cwd>`를 선언한다. Broker는 직전 inspect와 새 mapping/session/revision/SSH foreground context를 대조한다. pipe/MCP로 선언할 수 없다.
- `ssh_posix` Action scope는 확인한 cwd와 일치해야 한다. local/SSH profile을 서로 대신 사용할 수 없다. caller의 trusted 선언만으로 SSH 준비 상태가 생기지 않는다.
- 제출 직전 준비 상태를 소비한다. 같은 연결에서 trusted 완료 표식이 관찰되거나 명확한 pre-enqueue 거부가 있으면 다시 준비 상태로 돌아간다. ACK·mode 변경·새 job은 준비나 hold를 복구하지 않는다.
- 결과 불명은 실제 shell 확인과 새 `inspect`/`ssh-ready`, 기존 `recover` 절차로만 복구한다. 사용자 선언의 한계, marker 위조·외부 입력·check/send race는 기존 관측 한계 그대로다.
- 연결·mapping·Herdr continuity 변경 또는 core restart는 선언을 버린다. 새 session에서 이전 mode/Approval/job을 이어 쓰지 않는다.

## 검증과 활성화

새 profile은 내부 acceptance 구성에서 먼저 실행하고 실제 SSH 결과가 통과한 뒤 공개 배포에서 활성화한다. protocol fixture는 mode·권한·scope·취소·중복·불명 결과와 stale target을 검증하고, 실제 SSH는 입력 전달·실패 관찰·완료/interrupt·재접속을 확인한다. 설치 executable과 실제 Codex Parent의 end-to-end 실행, 같은 SSH 실패의 세 경로 품질 비교를 함께 보존한다.

A01–A32는 최종 matrix에 환경/fixture/결과/근거를 연결한다. #12 spec 본문·label·상태는 변경하지 않는다. package registry publish와 운영 배포는 이 acceptance에 포함하지 않는다.

## Candidate 통과와 공개 활성화 결정

실제 SSH 세 mode·명령 완료·중복 제출·재접속 1개와 ACK/표식/부분 입력·취소/interrupt/복구·move/recreate/IPC 유실 6개가 통과했다. [실행 결과](issue-24-ssh-profile-results.json), [복구/fault 결과](issue-24-ssh-recovery-results.json)를 보존했다. 부분 입력은 proxy가 실제 SSH terminal에 처음 10글자만 Enter 없이 전달한 fault이며 자연 발생한 전송 장애라고 표시하지 않는다. Herdr app 자체는 재시작하지 않고 소유 proxy의 실제 IPC 연결을 끊었다.

이 근거로 사용자 확인을 요구하는 `ssh_posix` profile을 공개 core의 기본 기능으로 활성화한다. 새 SSH session은 계속 passive로 시작한다. 다음 검증은 최종 tarball의 실제 Parent 실행, default 60초 관찰/hold와 재시작, 전체 회귀 및 review다. 하나라도 제품 보장 위반이 발견되면 수정 후 다시 확인한다.

설치본의 첫 실제 Parent는 기존 파일 덮어쓰기 가능성을 uncertainty로 남겨 mode 2가 정확히 승인 대기로 차단했다(입력 0). [초기 결과](issue-24-installed-parent-initial.json)를 보존한다. 정책을 완화하지 않고 fixture 수정 명령에 POSIX noclobber(`set -C`)를 사용하도록 개선해, 확인과 실행 사이에 파일이 생겨도 덮어쓰지 않는 방식으로 다시 평가한다. job_wait의 공개 상한 20,000 ms도 Parent 실행 지침에 명시한다.

두 번째 Parent는 noclobber를 반영했지만 아직 실행하지 않은 build의 성공 여부를 `risk.uncertainties`에 넣어 다시 승인 대기가 됐다. [두 번째 결과](issue-24-installed-parent-second.json)를 보존한다. Action의 안전성·영향 범위·복구에 관한 불확실성과 관찰 전 결과를 구분하도록 공개 risk field 설명을 보완한다. 실제 안전성 불확실성은 계속 빠짐없이 기록하며, 배열이 비어 있지 않으면 기존 정책대로 승인 대기한다.

세 번째 Parent도 제공된 script의 변경 가능성을 안전성 불확실성으로 남겼고 mode 2는 계속 차단했다. [세 번째 결과](issue-24-installed-parent-third.json)를 보존한다. 이를 제거하도록 강제하지 않는다. 실제 Parent의 전체 SSH 수정 흐름은 이 disposable pane에서 console로 mode 3을 명시적으로 선택해 검증한다. 기본 mode 2는 유지하며, 실제 SSH의 저위험 mode 2 자동 실행과 고위험 승인 대기는 native public-MCP 검증에서 이미 통과했다. 실제 Parent의 mode 2 자동 실행은 #18의 더 작은 local fixture에서도 통과했다. 세 번의 보류는 모델의 위험 판단에 따른 정상 정책 결과이지 실행 성공으로 계산하지 않는다.

Standards review에서 acceptance의 고정 SSH 준비 표식이 이전 연결 history와 혼동될 수 있음을 발견했다. 연결마다 새 nonce 표식을 생성하고 이번 연결의 독립된 행만 기다리도록 수정했다. 재접속·다른 cwd 검증은 이 변경으로 다시 실행한다.

## 재현

Node 24를 PATH에 두고 `npm test`로 public/process suite를 실행한다. `acceptance/pack-install.mjs`는 compiled 파일과 소유 문서를 별도 tarball/설치 directory에 넣으며 설치 metadata JSON을 stdout에 출력한다. 실제 모델 검증은 Codex CLI의 기존 OS 계정 인증을 사용한다.

테스트용 SSH daemon은 별도 terminal에서 다음처럼 준비한다. 이 명령은 새 key를 임시 경로에 만들며 사용자 SSH 설정이나 authorized_keys를 수정하지 않는다. `65345`가 사용 중이면 비어 있는 높은 port로 바꾸고 양쪽 terminal에 동일하게 적용한다.

```sh
export HB_SSH_KEYS="$(mktemp -d /private/tmp/herdr-ssh-XXXXXX)"
export HB_SSH_PORT=65345
chmod 700 "$HB_SSH_KEYS"
ssh-keygen -q -t ed25519 -N '' -f "$HB_SSH_KEYS/host_key"
ssh-keygen -q -t ed25519 -N '' -f "$HB_SSH_KEYS/client_key"
awk -v port="$HB_SSH_PORT" '{print "[127.0.0.1]:" port, $1, $2}' "$HB_SSH_KEYS/host_key.pub" > "$HB_SSH_KEYS/known_hosts"
cat > "$HB_SSH_KEYS/sshd_config" <<CONFIG
Port $HB_SSH_PORT
ListenAddress 127.0.0.1
HostKey $HB_SSH_KEYS/host_key
PidFile $HB_SSH_KEYS/sshd.pid
AuthorizedKeysFile $HB_SSH_KEYS/client_key.pub
UsePAM no
PasswordAuthentication no
KbdInteractiveAuthentication no
PubkeyAuthentication yes
PermitRootLogin no
AllowUsers dwchoo
PrintMotd no
LogLevel ERROR
StrictModes no
PermitUserRC no
CONFIG
/usr/sbin/sshd -D -e -f "$HB_SSH_KEYS/sshd_config"
```

검증한 계정은 `dwchoo`다. 다른 계정에 일반화하는 fixture가 아니며, 다른 계정으로 재현할 때는 AllowUsers와 acceptance의 명시된 SSH destination을 함께 검토해야 한다. 두 번째 terminal에 실제 `HB_SSH_KEYS` 경로와 같은 `HB_SSH_PORT`를 설정한 뒤 다음을 실행한다. runtime/profile/version은 위 조건에 고정한다.

```sh
node --test acceptance/ssh-profile.mjs acceptance/ssh-recovery.mjs
HB_QUALITY_FIXTURES=actual-ssh-missing-config node --test acceptance/diagnosis-quality.mjs
node acceptance/pack-install.mjs > /private/tmp/herdr-installation.json
HB_INSTALLATION=/private/tmp/herdr-installation.json node --test acceptance/ssh-installed.mjs
```

owner 설정을 임시 사용하는 설치 acceptance 둘은 동시에 실행하지 않는다. runner는 자신이 만든 Herdr workspace·core·설정·state·Parent 임시 기록을 정리한다. 모두 끝나면 첫 terminal에서 Ctrl-C로 이 daemon만 종료하고 이번에 만든 `HB_SSH_KEYS` directory를 제거한다. 다른 sshd나 사용자 workspace를 종료하지 않는다.


## 최종 설치 결과

[설치본의 실제 Parent와 복구 결과](issue-24-installed-acceptance.json)는 137.2초에 통과했다. Parent는 사용자 선택 mode 3에서 설정 파일을 생성하고 build/exit0와 새 Snapshot을 관찰했다. 최종 cancel 응답은 누적 Parent byte 한도에 도달해 `parent_budget_exhausted`로 job을 중지했다. 이미 관찰한 exit를 뒤집거나 원문 fallback으로 숨기지 않았다.

이후 같은 설치 core에서 일반 Action의 ACK와 END를 proxy로 숨겼다. 취소는 추가 입력을 보내지 않았고 별도 interrupt만 전송됐다. default60초가 지나 `observation_deadline`/`outcome_unknown`/null exit/hold가 남았다. purge와 실제 core 종료·재시작 뒤에도 hold1·consumed ID3이 유지됐으며 새 session은 mode2·SSH 미준비였다. 사용자 준비 확인과 새 목표 복구 후 hold0, 원래 exit는 null 그대로였다. DB canary 본문 일치는 0, 자동 resend는 0이었다.

전체 public/process suite185개와 마지막 관련 suite17개가 통과했다. 실제 SSH candidate1개·fault/recovery6개·설치1개, SSH 진단 비교2 tests도 통과했다. Standards의 연결별 준비 nonce 보완 뒤 native 재접속도 재검증했다. A01–A32별 근거는 [최종 matrix](mvp-acceptance-matrix.md)에 연결했다. 이 결과는 registry publish나 사용자 운영 배포를 수행했다는 의미가 아니다.

배포 README가 operations 문서를 root로 옮기면서 생긴 상대 링크 오류를 최종 Standards review에서 발견했다. README 복사 때 `implementation/` 링크를 `docs/implementation/`으로 조정한다. tarball 자체 integrity receipt는 자기 해시를 포함할 수 없으므로 package 밖의 `final-artifact.json`에 저장한다. 실제 검증본과 최종 compiled 파일의 동일성을 다시 확인한다. 소유 workspace w6, 테스트 sshd와 일회용 key/config는 종료·제거했다.
