const INTERRUPTION_LIMIT_MILLISECONDS = 200;
const RECONNECT_STATUS_LIMIT_MILLISECONDS = 1_000;
const REPLACEMENT_GAP_LIMIT_MILLISECONDS = 500;
const REQUIRED_MEETING_MINUTES = 60;

export function buildAutomatedCanaryEvidence({
  interruptionMilliseconds,
  reconnectStatusMilliseconds,
  staleOutputBlocked,
  replacementGapMilliseconds,
  acceleratedMeetingMinutes,
  proactiveReplacement,
  outputContinued,
} = {}) {
  const interruption = {
    ok: finiteWithin(interruptionMilliseconds, INTERRUPTION_LIMIT_MILLISECONDS),
    milliseconds: interruptionMilliseconds,
  };
  const reconnect = {
    ok: finiteWithin(reconnectStatusMilliseconds, RECONNECT_STATUS_LIMIT_MILLISECONDS)
      && staleOutputBlocked === true,
    statusMilliseconds: reconnectStatusMilliseconds,
    staleOutputBlocked: staleOutputBlocked === true,
  };
  const longSession = {
    ok: finiteWithin(replacementGapMilliseconds, REPLACEMENT_GAP_LIMIT_MILLISECONDS)
      && Number.isFinite(acceleratedMeetingMinutes)
      && acceleratedMeetingMinutes >= REQUIRED_MEETING_MINUTES
      && proactiveReplacement === true
      && outputContinued === true,
    replacementGapMilliseconds,
    acceleratedMeetingMinutes,
    proactiveReplacement: proactiveReplacement === true,
    outputContinued: outputContinued === true,
  };
  return {
    ok: interruption.ok && reconnect.ok && longSession.ok,
    interruption,
    reconnect,
    longSession,
  };
}

function finiteWithin(value, limit) {
  return Number.isFinite(value) && value >= 0 && value <= limit;
}
