/** A daily limit can ask for hours; say so in the unit a visitor reads. */
export function waitText(seconds: number): string {
  if (seconds < 90) return seconds === 1 ? '1 second' : `${seconds} seconds`;
  if (seconds < 90 * 60) return `${Math.ceil(seconds / 60)} minutes`;
  return `about ${Math.round(seconds / 3600)} hours`;
}
