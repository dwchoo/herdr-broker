# 프로젝트 skill과 Herdr 내부 실행

2026-09-16. 사용자는 Parent와 Broker를 Herdr 안에서 사용하는 것을 전제로 하며, 프로젝트 skill을 기본 진입점으로 요청했다. Codex Desktop·ChatGPT·Herdr 밖의 Codex가 같은 Broker MCP를 정상 실행 경로로 사용하는 것은 거부한다.

## 실행 계약

- 이 저장소의 `.agents/skills/herdr-broker/`에 skill과 실행 helper를 둔다. helper는 자신의 위치에서 프로젝트 root를 구하고 현재 cwd가 그 프로젝트 안인지 확인한다.
- Herdr의 Parent Pane에서 Codex와 대화한다. Target Pane은 별도 pane, Broker console은 같은 로컬 Herdr의 별도 pane/tab이다. Worker는 기존 제한된 child process로 유지한다.
- helper의 `parent`는 해당 Codex 실행에만 Broker MCP 설정을 전달한다. 사용자 전역 Codex 설정이나 다른 프로젝트의 MCP 설정은 수정하지 않는다.
- Parent 실행의 Codex 승인 정책은 `on-request`로 설정해 MCP의 변경 도구를 승인 검토할 수 있게 한다. 기존 승인 검토기 설정은 유지한다. `never`는 변경 도구의 승인 자체를 거부하므로 Broker 사용에 맞지 않는다. 이 Codex 도구 승인과 Broker의 Action Mode는 별개이며 모두 적용된다.
- MCP transport가 환경변수를 제한할 수 있으므로, helper는 검증을 마친 Herdr 문맥 변수만 해당 MCP 설정에 명시적으로 전달한다. facade는 전달받은 값과 실제 process 계층을 다시 검증한다.
- 이미 `herdr_broker` MCP에 연결된 Parent는 그 facade가 시작할 때 검증한 문맥을 사용한다. 같은 검사를 Codex의 제한된 shell tool에서 다시 실행하도록 요구하지 않는다. MCP가 없어서 설치·재연결할 때는 helper check를 사용한다.
- production CLI의 `serve`, `mcp`, `doctor`는 실제 Herdr 실행 문맥을 요구한다. `--help`와 `--version`은 실행 문맥 없이 사용할 수 있다.
- Herdr가 주입한 `HERDR_ENV`, pane/workspace/tab ID, socket 경로가 완전해야 한다. canonical socket은 Broker 설정의 endpoint와 일치해야 한다.
- Herdr의 현재 pane mapping과 shell PID를 조회하고, OS가 보고하는 현재 process의 부모 계층에 그 shell PID가 있는지 확인한다. 환경변수의 ID만 복사한 외부 process는 거부한다. 조회 실패·문맥 불일치는 fail closed다.
- 검사를 통과하기 전에 Broker state를 만들거나 MCP facade socket에 연결하지 않는다. Herdr 문맥 확인에는 pane 출력이나 입력을 사용하지 않는다.

## 보호 범위

보호 대상은 정상 CLI/MCP 진입점을 통한 외부 Parent의 Broker 사용이다. 기존 정상 실행 경로는 MCP 설정만 있으면 외부 Terminal에서도 연결되므로, 프로젝트 skill 범위와 실제 process 문맥 검사를 함께 적용한다.

이는 실행 진입점의 제한이다. 같은 OS 계정이 소스를 바꾸거나 내부 socket에 직접 protocol을 쓰는 고의적인 우회까지 막는 OS 격리를 새로 보장하지 않는다. 기존 동일 사용자 hard isolation의 범위는 유지한다. Action의 대상·정책·예산·영속 hold 검사는 계속 적용된다.

## 검증과 완료 기준

기존에 합의한 공개 MCP·사용자 console·실제 process 경계를 사용한다.

1. 외부 production CLI의 `serve`/`mcp`/`doctor`가 명확한 오류로 종료한다. `--help`/`--version`은 성공한다.
2. 실제 Herdr pane의 환경변수를 복사한 외부 process도 거부한다.
3. 실제 Herdr pane에서 helper의 확인, Broker console 기동, Parent MCP의 initialize·tools 목록 조회가 성공한다.
4. helper는 다른 프로젝트 cwd에서 거부하고, 프로젝트 내부 실행에는 해당 Parent에 한정된 MCP 설정을 사용한다.
5. 기존 전체 tests, typecheck, skill validation을 수행하고 Standards·Spec review 뒤 로컬 commit한다.

기존 사용자 README·AGENTS·CONTEXT·ADR·다른 skill 변경은 보존한다. 이 변경은 원격 push·issue 수정·registry publish를 포함하지 않는다.

## 현재 checkout 검증 경로

Node 24로 `npm test`와 `npm run typecheck`를 실행한다. Herdr 안에서 project helper의 `serve`를 켠 뒤, 같은 프로젝트의 다른 Herdr shell에서 다음을 실행하면 helper·doctor·MCP 연결을 검증한다.

```sh
HB_CONTEXT_PROOF=/private/tmp/herdr-broker-context-proof.json node --test acceptance/herdr-context-inside.mjs
```

외부 거부 검증은 `acceptance/herdr-context.mjs`를 사용한다. 실제 Herdr pane의 문맥 변수 JSON 파일을 `HB_HERDR_CONTEXT`로 전달하고 Herdr 밖에서 실행한다. 파일의 변수는 외부 child에 복사되지만 실제 process 계층이 다르므로 세 CLI 진입점 모두 거부돼야 한다.

기존 `acceptance/installed-operations.mjs`와 `acceptance/ssh-installed.mjs`는 #23·#24의 과거 artifact 검증용이다. `installed-harness`는 사용자 설정만 소유 proxy endpoint로 전환하므로 새 실행 문맥 검사와 맞지 않는다. 현재 checkout의 검증 결과로 재사용하지 않으며, 이번 변경은 새 tarball의 SSH 설치 acceptance 통과를 주장하지 않는다. 과거 artifact와 결과는 그대로 보존한다.

## Herdr 기본 동작 확인

다른 pane에서 단순 명령을 실행하는 기능은 Herdr가 이미 제공한다. `herdr pane run <pane_id> "echo 'hello world'"`로 입력하고 `herdr pane read <pane_id> --source recent-unwrapped --lines 8`로 출력을 확인할 수 있다. 실행 전에 대상이 사용 가능한 shell인지 확인한다. 이 직접 CLI 경로에는 Broker의 Worker·Evidence·Action Mode가 적용되지 않는다.

사용자가 요청한 최종 사용 확인은 Herdr tab 1의 Codex Parent를 시작하고, 그 Parent가 `herdr_broker` MCP를 통해 옆 pane에 `echo 'hello world'`를 제출하는 흐름이다. 기존 mode를 유지하고 이번 proposal의 완료 관찰·exit code·새 Snapshot의 Evidence로 성공을 확인한다. 과거 hello world 출력만으로 이번 실행을 성공 처리하지 않는다.

## 실행 결과

- Node 24.19.0에서 전체 **192 tests 통과**. 새 공개 CLI/helper 검사 7개가 포함된다. typecheck도 통과했다.
- 실제 Herdr pane의 환경을 복사한 외부 `serve`·`mcp`·`doctor` **3개 모두 거부**했다. 검사 추가 전에는 같은 `doctor` 호출이 성공해 재현이 확인됐다.
- 실제 Herdr `w2:p1`에서 helper check·doctor·MCP initialize/10 tools 조회 **1개 acceptance 통과**. [구조화 결과](project-skill-herdr-context-results.json)에 기록했다.
- 첫 내부 MCP 연결에서 transport의 환경변수 제한을 확인했고, 검증된 문맥 전달을 추가한 뒤 재검증했다.
- 실제 interactive Parent의 shell tool은 `approval_policy=never` sandbox에서 로컬 socket·process 조회를 제한해 helper 재검사가 실패했지만, 기동 때 검사를 통과한 MCP의 `pane_describe`는 성공했다. 연결된 Parent는 기존 MCP로 진행하고, helper check는 설치·재연결에 사용하는 방식으로 skill을 보완했다.
- 이어서 `job_start`가 Codex의 `approval_policy=never` 때문에 승인 요청 전 거부됐다. helper가 시작하는 Parent에만 `on-request`를 지정해 기존 승인 검토기를 사용할 수 있게 보완했다. 전역 설정·sandbox·Broker Action Mode는 바꾸지 않는다.
- 수정한 helper로 시작한 실제 `w2:p1` Codex가 `herdr_broker` MCP를 통해 `w2:p2`에 `echo 'hello world'`를 한 번 실행했다. 이번 proposal은 `parent_risk_review`, `completion_observed`, exit 0이며 Action Mode 2를 유지했다. 새 Snapshot의 Evidence와 Target Pane의 이번 BEGIN/END 표식 사이 출력이 일치했고 `job_cancel`도 완료했다. 실제 호출·receipt·출력 근거는 [구조화 결과](project-skill-herdr-context-results.json)에 기록했다. 최종 helper 변경 뒤 관련 7 tests·syntax check·skill validation을 다시 통과했다.
- skill-creator의 `quick_validate.py`가 통과했다. PyYAML은 임시 validator 환경에만 설치했다.
- 같은 `herdr-broker` workspace의 Parent는 `w2:p1`, Target은 기존 `w2:p2`, Broker console은 새 tab `w2:t2`의 `w2:p3`이다. 실제 Parent가 idle로 준비됐고, project helper와 production facade process가 함께 실행 중인 것을 확인했다. Parent model은 사용자의 기존 기본값을 사용한다.
- 외부 Terminal에 앞서 띄웠던 두 process는 종료된 것을 확인했다. 기존 Control State를 유지해 Herdr console에서 다시 열었다.
