/** Physical motion shared by the ring, layout transitions, and CSS token generator. */
export const springs = {
  ring: { mass: 1.15, stiffness: 420, damping: 37.5 },
  layout: { mass: 1, stiffness: 420, damping: 35 },
  control: { mass: .7, stiffness: 650, damping: 34 },
} as const;

export function springValue(value: number, velocity: number, target: number, seconds: number, spring: { mass: number; stiffness: number; damping: number } = springs.ring): { value: number; velocity: number; settled: boolean } {
  const time = Math.max(0, Math.min(1, seconds));
  const omega = Math.sqrt(spring.stiffness / spring.mass), decay = spring.damping / (2 * spring.mass), displacement = value - target;
  const frequency = Math.sqrt(Math.max(0, omega * omega - decay * decay));
  let position: number, speed: number;
  if (frequency > .001) {
    const amplitude = (velocity + decay * displacement) / frequency;
    const sine = Math.sin(frequency * time), cosine = Math.cos(frequency * time), attenuation = Math.exp(-decay * time);
    const wave = displacement * cosine + amplitude * sine;
    position = attenuation * wave;
    speed = attenuation * (-decay * wave - displacement * frequency * sine + amplitude * frequency * cosine);
  } else {
    const impulse = velocity + omega * displacement, attenuation = Math.exp(-omega * time);
    position = (displacement + impulse * time) * attenuation;
    speed = (velocity - omega * impulse * time) * attenuation;
  }
  const settled = Math.abs(position) < .08 && Math.abs(speed) < 1;
  return { value: settled ? target : target + position, velocity: settled ? 0 : speed, settled };
}
