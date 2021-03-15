import { StatusColors } from ".";

export interface PresenceConfig {
  name: string;
  accessory: string;
  oAuthToken: string;
  interval: number;
  setColorApi: string;
  offApi: string;
  onApi: string;
  startTime: string;
  endTime: string;
  lightType: string;
  statusColors: StatusColors;
  weekend: boolean;
  debug: boolean;
}