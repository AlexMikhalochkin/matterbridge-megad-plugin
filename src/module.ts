import { Matterbridge, MatterbridgeDynamicPlatform, MatterbridgeEndpoint, onOffLight, PlatformConfig } from 'matterbridge';
import { AnsiLogger, LogLevel } from 'matterbridge/logger';
import mqtt from 'mqtt';

/**
 * Configuration interface for MegaD plugin
 */
interface MegaDConfig extends PlatformConfig {
  mqtt: {
    broker: string;
    username?: string;
    password?: string;
  };
  devices: Array<{
    id: number;
    name: string;
    room?: string;
  }>;
}

/**
 * Configuration schema for Matterbridge UI
 */
export const configSchema = {
  type: 'object',
  properties: {
    mqtt: {
      type: 'object',
      title: 'MQTT Configuration',
      properties: {
        broker: {
          type: 'string',
          title: 'MQTT Broker URL',
          default: 'mqtt://localhost:1883',
          description: 'MQTT broker URL (e.g., mqtt://localhost:1883)',
        },
        username: {
          type: 'string',
          title: 'Username (optional)',
          description: 'MQTT username if authentication is required',
        },
        password: {
          type: 'string',
          title: 'Password (optional)',
          description: 'MQTT password if authentication is required',
        },
      },
      required: ['broker'],
    },
    devices: {
      type: 'array',
      title: 'MegaD Devices',
      items: {
        type: 'object',
        properties: {
          id: {
            type: 'number',
            title: 'Device ID',
            description: 'MegaD device ID (e.g., 11)',
            minimum: 1,
            maximum: 999,
          },
          name: {
            type: 'string',
            title: 'Device Name',
            description: 'Friendly name for the device',
          },
          room: {
            type: 'string',
            title: 'Room (optional)',
            description: 'Room name for organization',
          },
        },
        required: ['id', 'name'],
      },
      default: [
        {
          id: 11,
          name: 'Bedroom Light',
          room: 'Bedroom',
        },
      ],
    },
  },
  required: ['mqtt'],
};

/**
 * This is the standard interface for Matterbridge plugins.
 * Each plugin should export a default function that follows this signature.
 *
 * @param {Matterbridge} matterbridge - An instance of MatterBridge.
 * @param {AnsiLogger} log - An instance of AnsiLogger. This is used for logging messages in a format that can be displayed with ANSI color codes and in the frontend.
 * @param {MegaDConfig} config - The platform configuration.
 * @returns {MegaDPlatform} - An instance of the MatterbridgeAccessory or MatterbridgeDynamicPlatform class. This is the main interface for interacting with the Matterbridge system.
 */
export default function initializePlugin(matterbridge: Matterbridge, log: AnsiLogger, config: MegaDConfig): MegaDPlatform {
  return new MegaDPlatform(matterbridge, log, config);
}

// Here we define the MegaDPlatform class, which extends the MatterbridgeDynamicPlatform.
export class MegaDPlatform extends MatterbridgeDynamicPlatform {
  private mqttClient: mqtt.MqttClient | null = null;
  private megaDConfig: MegaDConfig;

  constructor(matterbridge: Matterbridge, log: AnsiLogger, config: MegaDConfig) {
    // Always call super(matterbridge, log, config)
    super(matterbridge, log, config);

    // Store our own configuration separately to avoid conflicts with parent class
    this.megaDConfig = {
      ...config,
      mqtt: {
        broker: config.mqtt?.broker || 'mqtt://localhost:1883',
        username: config.mqtt?.username,
        password: config.mqtt?.password,
      },
      devices: config.devices || [
        {
          id: 11,
          name: 'Bedroom Light',
          room: 'Bedroom',
        },
      ],
    };

    // Verify that Matterbridge is the correct version
    if (this.verifyMatterbridgeVersion === undefined || typeof this.verifyMatterbridgeVersion !== 'function' || !this.verifyMatterbridgeVersion('3.0.7')) {
      throw new Error(
        `This plugin requires Matterbridge version >= "3.0.7". Please update Matterbridge from ${this.matterbridge.matterbridgeVersion} to the latest version in the frontend."`,
      );
    }

    this.log.info(`Initializing MegaD Platform...`);
    this.log.info(`MQTT Broker: ${this.megaDConfig.mqtt.broker}`);
    this.log.info(`Configured devices: ${this.megaDConfig.devices.length}`);
  }

  override async onStart(reason?: string) {
    this.log.info(`onStart called with reason: ${reason ?? 'none'}`);

    // Wait for the platform to fully load
    await this.ready;

    // Clean the selectDevice and selectEntity maps
    await this.clearSelect();

    // Initialize MQTT client
    await this.initializeMqtt();

    // Create devices
    await this.createDevices();
  }

  override async onConfigure() {
    // Always call super.onConfigure()
    await super.onConfigure();

    this.log.info('onConfigure called');

    // Configure all your devices
    for (const device of this.getDevices()) {
      this.log.info(`Configuring device: ${device.uniqueId}`);
    }
  }

  override async onChangeLoggerLevel(logLevel: LogLevel) {
    this.log.info(`onChangeLoggerLevel called with: ${logLevel}`);
  }

  override async onShutdown(reason?: string) {
    // Disconnect MQTT client
    if (this.mqttClient) {
      this.log.info('Disconnecting MQTT client...');
      await this.mqttClient.endAsync();
      this.mqttClient = null;
    }

    // Always call super.onShutdown(reason)
    await super.onShutdown(reason);

    this.log.info(`onShutdown called with reason: ${reason ?? 'none'}`);
    if (this.config.unregisterOnShutdown === true) await this.unregisterAllDevices();
  }

  private async initializeMqtt() {
    if (!this.megaDConfig.mqtt?.broker) {
      this.log.warn('MQTT broker not configured - devices will be created but MQTT functionality will be disabled');
      return;
    }

    this.log.info(`Connecting to MQTT broker: ${this.megaDConfig.mqtt.broker}`);

    const options: mqtt.IClientOptions = {};
    if (this.megaDConfig.mqtt.username) {
      options.username = this.megaDConfig.mqtt.username;
      options.password = this.megaDConfig.mqtt.password;
    }

    this.mqttClient = mqtt.connect(this.megaDConfig.mqtt.broker, options);

    this.mqttClient.on('connect', () => {
      this.log.info('Connected to MQTT broker');

      // Subscribe to state topics for all devices
      if (this.megaDConfig.devices) {
        for (const deviceConfig of this.megaDConfig.devices) {
          const stateTopic = `alex/${deviceConfig.id}`;
          this.mqttClient?.subscribe(stateTopic);
          this.log.info(`Subscribed to ${stateTopic}`);
        }
      }
    });

    this.mqttClient.on('error', (error) => {
      this.log.error(`MQTT error: ${error.message}`);
    });

    this.mqttClient.on('message', async (topic, message) => {
      await this.handleMqttMessage(topic, message.toString());
    });
  }

  private async createDevices() {
    if (!this.megaDConfig.devices || this.megaDConfig.devices.length === 0) {
      this.log.info('No devices configured, creating default bedroom light with ID 11');
      // Create a default bedroom light for POC/testing
      await this.createMegaDLight(11, 'Bedroom Light');
      return;
    }

    // Create configured devices
    for (const deviceConfig of this.megaDConfig.devices) {
      this.log.info(`Creating configured device: ${deviceConfig.name} (ID: ${deviceConfig.id})`);
      await this.createMegaDLight(deviceConfig.id, deviceConfig.name);
    }
  }

  private async createMegaDLight(deviceId: number, deviceName: string) {
    const light = new MatterbridgeEndpoint(onOffLight, { uniqueStorageKey: `megad_${deviceId}` })
      .createDefaultBridgedDeviceBasicInformationClusterServer(
        deviceName,
        `MEGAD${deviceId}`,
        this.matterbridge.aggregatorVendorId,
        'MegaD',
        `MegaD Light ${deviceId}`,
        deviceId,
        '1.0.0',
      )
      .createDefaultPowerSourceWiredClusterServer()
      .addRequiredClusterServers()
      .addCommandHandler('on', async (_data) => {
        this.log.info(`Turning ON device ${deviceId} (${deviceName})`);
        await this.sendMqttCommand(deviceId, 1); // 1 = ON
      })
      .addCommandHandler('off', async (_data) => {
        this.log.info(`Turning OFF device ${deviceId} (${deviceName})`);
        await this.sendMqttCommand(deviceId, 0); // 0 = OFF
      });

    await this.registerDevice(light);
    this.log.info(`Registered MegaD light: ${deviceName} (ID: ${deviceId})`);
  }

  private async sendMqttCommand(deviceId: number, state: number) {
    if (!this.mqttClient) {
      this.log.error('MQTT client not connected');
      return;
    }

    const commandTopic = `alex/cmd`;
    const command = `${deviceId}:${state}`;

    this.log.info(`Publishing to ${commandTopic}: ${command}`);
    this.mqttClient.publish(commandTopic, command);
  }

  private async handleMqttMessage(topic: string, message: string) {
    this.log.info(`MQTT message received - Topic: ${topic}, Message: ${message}`);

    // Parse topic to get device ID (alex/<deviceId>)
    const topicParts = topic.split('/');
    if (topicParts.length === 2 && topicParts[0] === 'alex') {
      const deviceId = parseInt(topicParts[1]);
      if (!isNaN(deviceId)) {
        await this.updateDeviceState(deviceId, message);
      }
    }
  }

  private async updateDeviceState(deviceId: number, state: string) {
    const device = this.getDevices().find((d) => d.uniqueId === `megad_${deviceId}`);
    if (!device) {
      this.log.warn(`Device with ID ${deviceId} not found`);
      return;
    }

    // Parse state (assuming it's "0" for OFF, "1" for ON)
    const isOn = state.trim() === '1';
    this.log.info(`Updating device ${deviceId} state to: ${isOn ? 'ON' : 'OFF'}`);

    // Update the Matter device state
    if (device.hasClusterServer('onOff')) {
      await device.setAttribute('onOff', 'onOff', isOn);
    }
  }
}
