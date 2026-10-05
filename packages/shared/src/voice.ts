export interface VoiceSettings {
  enabled?: boolean;
  modelPath?: string;
  runtimePath?: string;
  language?: string;
  deviceId?: string;
  /** 0–100; higher values detect quieter speech. */
  sensitivity?: number;
  silenceMs?: number;
  commandsEnabled?: boolean;
  threads?: number;
  idleSeconds?: number;
}
export interface VoiceStatus {
  installed: boolean;
  installing: boolean;
  progress: number;
  running: boolean;
  modelPath?: string;
  runtimePath?: string;
  error?: string;
  supported: boolean;
}
export interface VoicePermission { status: string; platform: string; }
