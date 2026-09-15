export const initial = () => ({ submission: 'not_submitted', observation: 'not_started', attempts: 0, held: false, session: 1, proposalSession: 1, message: '제안이 준비됐습니다.' });

export function transition(state, event) {
  const s = { ...state };
  if (event === 'submit') {
    if (s.attempts || s.held || s.session !== s.proposalSession) return { ...s, message: '제출을 보류했습니다. 기존 receipt를 확인하거나 새 대상에 제안을 다시 만드세요.' };
    return { ...s, submission: 'dispatching', observation: 'observing', attempts: 1, held: true, message: '전송 의도를 기록했습니다. 이 제안은 다시 보내지 않습니다.' };
  }
  if (event === 'ack' && s.submission === 'dispatching') return { ...s, submission: 'accepted', message: 'Herdr가 입력을 받았습니다. 종료 결과는 아직 모릅니다.' };
  if (event === 'lost' && s.attempts) return { ...s, submission: 'unknown', held: true, message: '응답이 유실됐습니다. 자동 재전송하지 않습니다.' };
  if (event === 'complete' && s.attempts) return { ...s, observation: 'completion_observed', held: false, message: '현재 Action의 종료 표식을 관찰했습니다. 출력의 주장이며 신뢰된 실행 증명은 아닙니다.' };
  if (event === 'timeout' && s.attempts) return { ...s, observation: 'outcome_unknown', held: true, message: '종료 여부를 확인하지 못했습니다. 다음 일반 입력을 보류합니다.' };
  if (event === 'cancel') return { ...s, message: '후속 작업을 취소했습니다. 이미 전송된 명령은 별도 interrupt가 필요합니다.' };
  if (event === 'restart' && s.submission === 'dispatching') return { ...s, submission: 'unknown', held: true, message: '재시작 전의 전송 의도를 복구했습니다. 실행 여부를 추정하지 않습니다.' };
  if (event === 'session') return { ...s, session: s.session + 1, held: true, message: 'Pane Session이 바뀌었습니다. 기존 제안과 승인을 무효화합니다.' };
  return { ...s, message: '현재 상태에서는 이 사건으로 상태가 바뀌지 않습니다.' };
}
