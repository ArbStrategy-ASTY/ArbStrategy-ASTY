// Reminder windows are measured against the fight's exact end time.
// One-minute Cloudflare cron sends the 15m, 10m and 5m messages separately.
export function countdownThreshold(secondsRemaining){
  if(!Number.isFinite(secondsRemaining)||secondsRemaining<=0||secondsRemaining>900)return null;
  if(secondsRemaining>600)return 15;
  if(secondsRemaining>300)return 10;
  return 5;
}
