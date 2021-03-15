import { WebAPICallResult } from "@slack/web-api";

export interface DnD extends WebAPICallResult  {
  dnd_enabled: boolean;
  next_dnd_start_ts: number;
  next_dnd_end_ts: number;
  snooze_enabled: boolean;
}