/**
 * Noise gate for the listening wave / orb: it must move when the founder TALKS, not on room hum.
 *
 * update(rms) takes the loudness of one audio frame (0..1) and returns 0 while it is only
 * background, else a level 0..1. The floor adapts slowly to the room, learning only from frames
 * the gate itself calls quiet. While the agent speaks its voice leaks into the mic: the gate is
 * stricter then.
 */
export function createNoiseGate({ initialFloor = 0.01, whileAgentSpeaks = 1.8 } = {}) {
  let floor = initialFloor;
  return {
    update(rms, agentSpeaking = false) {
      const gate = (floor * 2.5 + 0.02) * (agentSpeaking ? whileAgentSpeaks : 1);
      if (rms <= gate) {
        floor = Math.max(0.002, floor * 0.98 + rms * 0.02);
        return 0;
      }
      return Math.min(1, (rms - gate) / 0.15);
    },
    floor: () => floor,
  };
}
