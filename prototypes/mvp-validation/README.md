# MVP 설계 검증 prototype

이 코드는 제품 구현이 아니다. Codex CLI의 Worker 경계와 Herdr의 shell Action이 설계에서 가정한 보장을 실제로 제공하는지 확인한다. 입력은 합성 로그와 이 실험에서 만든 파일·socket·pane만 사용한다.

## 확인할 질문

1. CLI 설정으로 pane 관찰 전용 Worker를 만들 수 있는가? 실제 provider request의 tool 목록, 구조화된 결과, 취소와 기록을 확인한다.
2. Herdr의 제출 응답과 shell 종료 신호를 구분할 수 있는가? 별도 local pane에서 cwd·environment·exit code와 출력 한계를 확인한다.
3. 작은 합성 fixture에서 Worker report가 원인·불확실성·근거를 보존하며 Parent 입력을 줄이는가?

## 실행과 판정

Node standard library만 사용한다. `node prototypes/mvp-validation/probe.mjs <command>`로 실행한다. Codex 모델 호출은 기존 CLI 인증을 사용한다. credential 파일은 읽거나 복사하지 않는다. local fake provider에는 합성 key만 사용하고 request의 tool 이름·설정만 저장한다. Herdr 명령은 생성 응답으로 얻은 대상에만 보낸다.

실제 runtime 관찰, fake provider·fault fixture, 아직 검증하지 않은 조건을 결과에서 구분한다. runtime이 제공하지 않는 보장을 prototype 성공으로 대체하지 않는다. `state-demo.html`은 확정할 상태 계약을 눌러보는 독립 HTML이다.

## 산출물

- `results/`: 입력이 합성인 검증 결과와 판정. 개인 경로·인증·일반 사용자 pane 내용은 보존하지 않는다.
- `fixtures/`: 재현 가능한 합성 build log와 정답 기준.
- `state-demo.html`: ACK 유실·중복·session 변경의 상태 전이를 보는 demo.

모델 provider의 서버 측 보존은 이 실험으로 검증할 수 없다. `--ephemeral`을 전체 기록 삭제 보장으로 해석하지 않는다.
