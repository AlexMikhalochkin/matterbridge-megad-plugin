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
    name: string;
    port: number;
    room?: string;
  }>;
}

/**
 * Configuration schema for Matterbridge UI
 */
export const configSchema = {
  type: 'object',
  properties: {
    name: {
      type: 'string',
      title: 'Plugin Name',
      default: 'MegaD Plugin',
      readOnly: true,
    },
    mqtt: {
      type: 'object',
      title: 'MQTT Configuration',
      properties: {
        broker: {
          type: 'string',
          title: 'Broker URL',
          default: 'mqtt://localhost:1883',
          description: 'MQTT broker URL (e.g., mqtt://localhost:1883)',
          pattern: '^mqtt://.*',
        },
        username: {
          type: 'string',
          title: 'Username',
          description: 'MQTT username (leave empty if no authentication required)',
        },
        password: {
          type: 'string',
          title: 'Password',
          description: 'MQTT password (leave empty if no authentication required)',
          format: 'password',
        },
      },
      required: ['broker'],
    },
    devices: {
      type: 'array',
      title: 'MegaD Devices',
      description: 'List of MegaD devices to control',
      items: {
        type: 'object',
        title: 'Device',
        properties: {
          name: {
            type: 'string',
            title: 'Device Name',
            description: 'Friendly name for the device (e.g., "Living Room Light")',
          },
          port: {
            type: 'integer',
            title: 'Device Port',
            description: 'MegaD port number (1-999)',
            minimum: 1,
            maximum: 999,
          },
          room: {
            type: 'string',
            title: 'Room',
            description: 'Room where the device is located (optional)',
          },
        },
        required: ['name', 'port'],
      },
      minItems: 1,
      default: [],
    },
  },
  required: ['mqtt', 'devices'],
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

// Attach the configuration schema to the default export function
// This is how Matterbridge discovers the schema
initializePlugin.configSchema = configSchema;

// Schema is already exported above, no need to re-export

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
      devices: config.devices || [],
    };

    // Attach schema to the platform instance for discovery
    (this as unknown as { configSchema: typeof configSchema }).configSchema = configSchema;

    // Verify that Matterbridge is the correct version
    if (this.verifyMatterbridgeVersion === undefined || typeof this.verifyMatterbridgeVersion !== 'function' || !this.verifyMatterbridgeVersion('3.0.7')) {
      throw new Error(
        `This plugin requires Matterbridge version >= "3.0.7". Please update Matterbridge from ${this.matterbridge.matterbridgeVersion} to the latest version in the frontend."`,
      );
    }

    this.log.info(`Initializing MegaD Platform...`);
    this.log.info(`MQTT Broker: ${this.megaDConfig.mqtt.broker}`);
    this.log.info(`Configured devices: ${this.megaDConfig.devices.length}`);

    // Log the configuration schema availability for debugging
    this.log.info(`Configuration schema available: ${typeof this.getConfigSchema === 'function'}`);
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
      if (this.megaDConfig.devices && this.megaDConfig.devices.length > 0) {
        for (const deviceConfig of this.megaDConfig.devices) {
          const stateTopic = `alex/${deviceConfig.port}`;
          this.mqttClient?.subscribe(stateTopic);
          this.log.info(`Subscribed to ${stateTopic}`);
        }
      } else {
        this.log.warn('No devices configured for MQTT subscription');
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
      this.log.warn('No devices configured in settings. Please configure devices in the Matterbridge UI.');
      return;
    }

    // Create configured devices
    for (const deviceConfig of this.megaDConfig.devices) {
      this.log.info(`Creating configured device: ${deviceConfig.name} (Port: ${deviceConfig.port})`);
      await this.createMegaDLight(deviceConfig.port, deviceConfig.name);
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

  private async updateDeviceState(deviceId: number, message: string) {
    // First, let's debug what devices we have
    const allDevices = this.getDevices();
    this.log.info(`Available devices: ${allDevices.map((d) => `${d.name}(${d.uniqueId})`).join(', ')}`);

    // Find the device by matching the port number with our configured devices
    const configuredDevice = this.megaDConfig.devices.find((d) => d.port === deviceId);
    if (!configuredDevice) {
      this.log.warn(`Device with port ${deviceId} not found in configuration`);
      return;
    }

    // Try multiple ways to find the device:
    // 1. By uniqueId matching our expected format
    // 2. By endpoint name matching the configured device name
    // 3. As a fallback, use the first device if there's only one (common case)
    let device = allDevices.find((d) => {
      const endpointName = d.name || '';
      this.log.info(`Checking device: name="${endpointName}", uniqueId="${d.uniqueId}"`);
      return d.uniqueId === `megad_${deviceId}` || endpointName === configuredDevice.name || endpointName.includes(`${deviceId}`);
    });

    // Fallback: if we only have one device and couldn't find by ID, use it anyway
    if (!device && allDevices.length === 1) {
      this.log.info(`Using single available device as fallback for device ID ${deviceId}`);
      device = allDevices[0];
    }

    if (!device) {
      this.log.warn(`Device with ID ${deviceId} not found. Available devices: ${allDevices.map((d) => d.name).join(', ')}`);
      return;
    }

    // Parse the JSON message format: {"port":11,"value":"OFF"}
    let isOn = false;
    try {
      const messageObj = JSON.parse(message);
      if (messageObj.value) {
        // Handle "ON"/"OFF" string values
        isOn = messageObj.value.toUpperCase() === 'ON';
      } else if (messageObj.port && messageObj.port.toString() === deviceId.toString()) {
        // Fallback: if no value field, assume the message itself indicates state
        isOn = true; // Default to ON if we can't determine
      }
    } catch (_error) {
      // Fallback to original logic for non-JSON messages
      isOn = message.trim() === '1';
    }

    this.log.info(`Updating device ${deviceId} (${device.name}) state to: ${isOn ? 'ON' : 'OFF'}`);

    // Update the Matter device state
    if (device.hasClusterServer('onOff')) {
      await device.setAttribute('onOff', 'onOff', isOn);
      this.log.info(`Successfully updated device ${deviceId} Matter state`);
    } else {
      this.log.warn(`Device ${deviceId} does not have onOff cluster`);
    }
  }

  /**
   * Get configuration schema for Matterbridge UI
   * This method is called by Matterbridge to get the configuration schema
   *
   * @returns {object} The configuration schema object
   */
  getConfigSchema() {
    this.log.info('getConfigSchema() called');
    return configSchema;
  }

  /**
   * Static method to get configuration schema
   * Some Matterbridge versions might expect this
   *
   * @returns {object} The configuration schema object
   */
  static getConfigSchema() {
    return configSchema;
  }
}
