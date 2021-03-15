import { WebAPICallResult } from "@slack/web-api";

export interface Presence extends WebAPICallResult {
  presence: 'active' | 'away';
  online: boolean;
  auto_away: boolean;
  manual_away: boolean;
  connection_count: number;
  last_activity: number;
}