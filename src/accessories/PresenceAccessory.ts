/// <reference types="hap-nodejs" />

import { WebClient } from '@slack/web-api';
import { Homebridge, HomebridgeAccessory, PresenceConfig, Logger, StatusColors, ProfileData, Availability, Presence, DnD } from '../models';
import { splitHours } from '../helpers';
import { BusyLightService } from '../services';

export class PresenceAccessory implements HomebridgeAccessory {
  private static api: Homebridge = null;
  private static service: HAPNodeJS.Service = null;
  private static characteristic: HAPNodeJS.Characteristic = null;
  private static version: string = null;

  private accessoryService: HAPNodeJS.Service = null;

  private switchOff: HAPNodeJS.Service = null;
  private switchAway: HAPNodeJS.Service = null;
  private switchAvailable: HAPNodeJS.Service = null;
  private switchDnD: HAPNodeJS.Service = null;

  private activitySwitches: { [name: string]: HAPNodeJS.Service} = {};

  private timeoutIdx: NodeJS.Timeout = null;

  private readonly defaultColors: StatusColors = {
    available: {
      red: 0,
      green: 144,
      blue: 0
    },
    away: {
      red: 255,
      green: 191,
      blue: 0
    },
    donotdisturb: {
      red: 149,
      green: 0,
      blue: 0
    }
  };

  private config: PresenceConfig = {
    name: null,
    accessory: null,
    oAuthToken: null,
    interval: 1, // Every minute
    setColorApi: null,
    offApi: null,
    onApi: null,
    startTime: null,
    endTime: null,
    lightType: null,
    statusColors: this.defaultColors,
    weekend: false,
    debug: false
  };
  
  /**
   * Initialize the accessory registration
   * 
   * @param homebridge 
   * @param packageJSON 
   * @param platformName 
   */
  public static register(homebridge: Homebridge, packageJSON: any, platformName: string) {
    console.log(`The ${packageJSON.name} plugin version is: ${packageJSON.version}. Installed on Homebridge version: ${homebridge.version}.`);

    this.api = homebridge;
    this.service = homebridge.hap.Service;
    this.characteristic = homebridge.hap.Characteristic;
    this.version = packageJSON.version;
    
    homebridge.registerAccessory(packageJSON.name, platformName, PresenceAccessory);
  }

  constructor(private log: Logger, options: PresenceConfig, private api: Homebridge) {
    // Overwrite the default config
    this.config = Object.assign({}, this.config, options);

    // Register new switch
    this.accessoryService = new PresenceAccessory.service.Switch(this.config.name, null);
    this.accessoryService.getCharacteristic(PresenceAccessory.characteristic.On).updateValue(false).on("set", this.setStatus);

    // Register state switches
    this.switchOff = new PresenceAccessory.service.Switch(`Switch Offline - ${this.config.name}`, 'Offline');
    this.switchOff.getCharacteristic(PresenceAccessory.characteristic.On).updateValue(false);

    this.switchAway = new PresenceAccessory.service.Switch(`Switch Away - ${this.config.name}`, 'Away');
    this.switchAway.getCharacteristic(PresenceAccessory.characteristic.On).updateValue(false);

    this.switchAvailable = new PresenceAccessory.service.Switch(`Switch Available - ${this.config.name}`, 'Available');
    this.switchAvailable.getCharacteristic(PresenceAccessory.characteristic.On).updateValue(false);

    this.switchDnD = new PresenceAccessory.service.Switch(`Switch DnD - ${this.config.name}`, 'DnD');
    this.switchDnD.getCharacteristic(PresenceAccessory.characteristic.On).updateValue(false);

    // Register custom switches if needed
    const otherStates = Object.keys(this.config.statusColors).filter(status => status !== "available" && status !== "away" && status !== "donotdisturb");
    if (otherStates && otherStates.length > 0) {
      for (const state of otherStates) {
        this.activitySwitches[state.toLowerCase()] = new PresenceAccessory.service.Switch(`Switch ${state} - ${this.config.name}`, state);
        this.activitySwitches[state.toLowerCase()].getCharacteristic(PresenceAccessory.characteristic.On).updateValue(false);
      }
    }
  }

  /**
   * Return the new accessory service
   */
  public getServices() {
    const informationService = new (PresenceAccessory.service as any).AccessoryInformation();
    const characteristic = PresenceAccessory.characteristic;
    informationService.setCharacteristic(characteristic.Manufacturer, 'Elio Struyf')
                      .setCharacteristic(characteristic.Model, 'Slack Presence Indicator')
                      .setCharacteristic(characteristic.SerialNumber, 'PI_02')
                      .setCharacteristic(characteristic.FirmwareRevision, PresenceAccessory.version);
    const otherSwitches = Object.keys(this.activitySwitches);
    return [informationService, this.accessoryService, this.switchOff, this.switchDnD, this.switchAway, this.switchAvailable, ...otherSwitches.map(name => this.activitySwitches[name])];
  }

  /**
   * Set status event listener
   */
  private setStatus = (on: boolean, callback: () => void) => {
    if (on && this.config.oAuthToken) {
      // Turned on
      this.presencePolling();
    } else  {
      // Turned off
      if (this.timeoutIdx) {
        clearTimeout(this.timeoutIdx);
        this.timeoutIdx = null;
      }
    }

    callback();
  }

  /**
   * Presence polling
   */
  private presencePolling = async () => {
    const shouldFetch = this.shouldCheckPresence();
    
    if (shouldFetch) {
      const slack = new WebClient(this.config.oAuthToken);
      const presenceData: Presence = await slack.users.getPresence() as Presence;

      if (this.config.debug) {
        this.log.info(`Slack presence data ${JSON.stringify(presenceData)}`);
      }
      
      if (presenceData && presenceData.ok && presenceData.online) {
        let availability = presenceData.presence && presenceData.presence === 'active' ? Availability.Available : Availability.Away;

        const profileData: ProfileData = await slack.users.profile.get() as ProfileData;
        if (this.config.debug) {
          this.log.info(`Slack profile data ${JSON.stringify(profileData)}`);
        }

        const dndData: DnD = await slack.dnd.info() as DnD;
        if (this.config.debug) {
          this.log.info(`Slack dnd data ${JSON.stringify(dndData)}`);
        }
        
        if (dndData.snooze_enabled) {
          availability = Availability.DoNotDisturb;
        }

        const statusText = profileData?.profile?.status_text;
        let colors = this.config.statusColors[statusText] || this.config.statusColors[availability.toLowerCase()];
        if (!colors || (!colors.red && !colors.green && !colors.blue)) {
          colors = this.defaultColors[availability.toLowerCase()];
        }

        this.setSwitchState(availability, statusText);

        if (this.config.setColorApi)  {
          await BusyLightService.post(this.config.setColorApi, colors, this.log, this.config.debug);
        }
      }
    } else {
      await this.turnOff();
    }

    this.timeoutIdx = setTimeout(() => {
      this.presencePolling();
    }, (this.config.interval > 0 ? this.config.interval : 1) * 60 * 1000);
  }

  private async turnOff() {
    this.setSwitchState(Availability.Offline, null);

    if (this.config.offApi) {
      await BusyLightService.get(this.config.offApi, this.log, this.config.debug);
    }
  }

  /**
   * Turn the right state on/off of the state switches
   * @param availability 
   */
  private setSwitchState(availability: Availability, statusText: string) {
    const characteristic = PresenceAccessory.characteristic.On;

    if (statusText && typeof this.activitySwitches[statusText.toLowerCase()] !== "undefined") {
      for (const switchName of Object.keys(this.activitySwitches)) {
        const activitySwitch = this.activitySwitches[switchName];
        
        if (switchName === statusText.toLowerCase()) {
          activitySwitch.getCharacteristic(characteristic).updateValue(true);
        } else {
          activitySwitch.getCharacteristic(characteristic).updateValue(false);
        }
      }

      this.switchAvailable.getCharacteristic(characteristic).updateValue(false);
      this.switchAway.getCharacteristic(characteristic).updateValue(false);
      this.switchOff.getCharacteristic(characteristic).updateValue(false);
      this.switchDnD.getCharacteristic(characteristic).updateValue(false);

      return;
    }
    
    this.switchAvailable.getCharacteristic(characteristic).updateValue(availability === Availability.Available);
    this.switchAway.getCharacteristic(characteristic).updateValue(availability === Availability.Away);
    this.switchDnD.getCharacteristic(characteristic).updateValue(availability === Availability.DoNotDisturb);
    this.switchOff.getCharacteristic(characteristic).updateValue(availability !== Availability.DoNotDisturb && availability !== Availability.Away && availability !== Availability.Available);

    for (const switchName of Object.keys(this.activitySwitches)) {
      this.activitySwitches[switchName].getCharacteristic(characteristic).updateValue(false);
    }
  }

  /**
   * Should the accessory check the presence
   */
  private shouldCheckPresence() {
    // Check if switch is on or off
    const state = (this.accessoryService.getCharacteristic(PresenceAccessory.characteristic.On) as any).value;
    if (this.config.debug) {
      this.log.info(`Current accessory state is: ${JSON.stringify(state)}`);
    }
    if (!state) {
      return false;
    }

    const startTimeSplit = splitHours(this.config.startTime);
    const endTimeSplit = splitHours(this.config.endTime);
    if (this.config.debug) {
      this.log.info(`startTimeSplit: ${JSON.stringify(startTimeSplit)}.`);
      this.log.info(`endTimeSplit: ${JSON.stringify(endTimeSplit)}.`);
    }
    const crntDate = new Date();

    if(!this.config.weekend && (crntDate.getDay() === 6 || crntDate.getDay() === 0)) {
      if (this.config.debug) {
        this.log.info(`It's weekend, accessory will not set the busy light.`);
      }
      return false;
    }

    if (startTimeSplit && (crntDate.getHours() < startTimeSplit.hour || crntDate.getHours() === startTimeSplit.hour && crntDate.getMinutes() < startTimeSplit.minutes)) {
      if (this.config.debug) {
        this.log.info(`Presence doesn't need to be checked, before working hours.`);
      }
      return false;
    }

    if (endTimeSplit && (crntDate.getHours() > endTimeSplit.hour || crntDate.getHours() === endTimeSplit.hour && crntDate.getMinutes() > endTimeSplit.minutes)) {
      if (this.config.debug) {
        this.log.info(`Presence doesn't need to be checked, after working hours.`);
      }
      return false;
    }

    if (this.config.debug) {
      this.log.info(`Presence can be retrieved`);
    }
    return true;
  }
}
