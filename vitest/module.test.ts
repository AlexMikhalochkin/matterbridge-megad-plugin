import { vi, describe, beforeEach, afterAll } from 'vitest';
import { AnsiLogger, LogLevel } from 'matterbridge/logger';
import { Matterbridge, MatterbridgeEndpoint, PlatformConfig } from 'matterbridge';

import { MegaDPlatform } from '../src/module.ts';

// Mock MQTT completely to prevent actual connections during tests
const mockMqttClient = {
  on: vi.fn(),
  subscribe: vi.fn(),
  publish: vi.fn(),
  end: vi.fn((force: any, options: any, callback: any) => {
    if (callback) callback();
  }),
  connected: false,
  reconnecting: false,
  options: {},
};

vi.mock('mqtt', () => ({
  default: {
    connect: vi.fn(() => mockMqttClient),
  },
}));

const mockLog = {
  fatal: vi.fn((message: string, ...parameters: any[]) => {}),
  error: vi.fn((message: string, ...parameters: any[]) => {}),
  warn: vi.fn((message: string, ...parameters: any[]) => {}),
  notice: vi.fn((message: string, ...parameters: any[]) => {}),
  info: vi.fn((message: string, ...parameters: any[]) => {}),
  debug: vi.fn((message: string, ...parameters: any[]) => {}),
} as unknown as AnsiLogger;

const mockMatterbridge = {
  matterbridgeDirectory: './jest/matterbridge',
  matterbridgePluginDirectory: './jest/plugins',
  systemInformation: { ipv4Address: undefined, ipv6Address: undefined, osRelease: 'xx.xx.xx.xx.xx.xx', nodeVersion: '22.1.10' },
  matterbridgeVersion: '3.0.0',
  log: mockLog,
  getDevices: vi.fn(() => {
    return [];
  }),
  getPlugins: vi.fn(() => {
    return [];
  }),
  addBridgedEndpoint: vi.fn(async (pluginName: string, device: MatterbridgeEndpoint) => {}),
  removeBridgedEndpoint: vi.fn(async (pluginName: string, device: MatterbridgeEndpoint) => {}),
  removeAllBridgedEndpoints: vi.fn(async (pluginName: string) => {}),
} as unknown as Matterbridge;

const mockConfig = {
  name: 'matterbridge-megad-plugin',
  type: 'DynamicPlatform',
  version: '1.0.0',
  debug: false,
  unregisterOnShutdown: false,
  mqtt: {
    broker: 'mqtt://localhost:1883',
    username: undefined,
    password: undefined,
  },
  devices: [
    {
      id: 11,
      name: 'Test Light',
      room: 'Test Room',
    },
  ],
} as PlatformConfig;

const loggerLogSpy = vi.spyOn(AnsiLogger.prototype, 'log').mockImplementation((level: string, message: string, ...parameters: any[]) => {});

describe('Matterbridge MegaD Plugin', () => {
  let instance: MegaDPlatform;

  beforeEach(() => {
    vi.clearAllMocks();
    // Reset mock client state
    mockMqttClient.connected = false;
    mockMqttClient.reconnecting = false;
  });

  afterEach(async () => {
    // Clean up MQTT connection to prevent hanging and reconnection attempts
    if (instance?.mqttClient) {
      // Force disconnect without reconnection
      instance.mqttClient.connected = false;
      instance.mqttClient.reconnecting = false;
      await new Promise<void>((resolve) => {
        instance.mqttClient?.end(true, {}, () => resolve());
      });
      instance.mqttClient = null;
    }
  });

  afterAll(() => {
    // Clear any remaining timers and restore mocks
    vi.clearAllTimers();
    vi.restoreAllMocks();
  });

  it('should throw an error if matterbridge is not the required version', async () => {
    mockMatterbridge.matterbridgeVersion = '2.0.0'; // Simulate an older version
    expect(() => new MegaDPlatform(mockMatterbridge, mockLog, mockConfig)).toThrow(
      'This plugin requires Matterbridge version >= "3.0.7". Please update Matterbridge from 2.0.0 to the latest version in the frontend.',
    );
    mockMatterbridge.matterbridgeVersion = '3.0.7';
  });

  it('should create an instance of the platform', async () => {
    instance = (await import('../src/module.ts')).default(mockMatterbridge, mockLog, mockConfig) as MegaDPlatform;
    expect(instance).toBeInstanceOf(MegaDPlatform);
    expect(instance.matterbridge).toBe(mockMatterbridge);
    expect(instance.log).toBe(mockLog);
    expect(instance.config).toEqual(
      expect.objectContaining({
        name: 'matterbridge-megad-plugin',
        type: 'DynamicPlatform',
      }),
    );
    expect(instance.matterbridge.matterbridgeVersion).toBe('3.0.7');
    expect(mockLog.info).toHaveBeenCalledWith('Initializing MegaD Platform...');
  });

  it('should start', async () => {
    await instance.onStart('Jest');
    expect(mockLog.info).toHaveBeenCalledWith('onStart called with reason: Jest');
    await instance.onStart();
    expect(mockLog.info).toHaveBeenCalledWith('onStart called with reason: none');
  });

  it('should call the command handlers', async () => {
    for (const device of instance.getDevices()) {
      if (device.hasClusterServer('onOff')) {
        await device.executeCommandHandler('on');
        await device.executeCommandHandler('off');
      }
    }
    expect(mockLog.info).toHaveBeenCalledWith(expect.stringContaining('Turning ON device'));
    expect(mockLog.info).toHaveBeenCalledWith(expect.stringContaining('Turning OFF device'));
  });

  it('should configure', async () => {
    await instance.onConfigure();
    expect(mockLog.info).toHaveBeenCalledWith('onConfigure called');
    expect(mockLog.info).toHaveBeenCalledWith(expect.stringContaining('Configuring device:'));
  });

  it('should change logger level', async () => {
    await instance.onChangeLoggerLevel(LogLevel.DEBUG);
    expect(mockLog.info).toHaveBeenCalledWith('onChangeLoggerLevel called with: debug');
  });

  it('should shutdown', async () => {
    await instance.onShutdown('Jest');
    expect(mockLog.info).toHaveBeenCalledWith('onShutdown called with reason: Jest');

    // Mock the unregisterOnShutdown behavior
    mockConfig.unregisterOnShutdown = true;
    await instance.onShutdown();
    expect(mockLog.info).toHaveBeenCalledWith('onShutdown called with reason: none');
    expect(mockMatterbridge.removeAllBridgedEndpoints).toHaveBeenCalled();
    mockConfig.unregisterOnShutdown = false;
  });
});
