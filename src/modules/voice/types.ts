/**
 * Hang Time - WebRTC Voice Types
 */

export type SignalType = 'offer' | 'answer' | 'ice-candidate' | 'voice-state';

export interface WebRTCSignalPayload {
  target_uuid: string;
  sender_uuid: string;
  activity_id: string;
  type: SignalType;
  sdp?: RTCSessionDescriptionInit;
  candidate?: RTCIceCandidateInit;
  is_muted?: boolean;
  in_voice?: boolean;
  timestamp: number;
}

export type VoiceMode = 'open-mic' | 'ptt';

export interface VoiceSettings {
  inputDeviceId?: string;
  voiceMode: VoiceMode;
  pttKey: string;
  micGain: number; // 0.0 to 2.0 (default: 1.0)
  autoJoin: boolean;
  videoDucking: boolean; // Dims video volume when friends speak
}

export type PeerConnectionStatus = 'new' | 'connecting' | 'connected' | 'disconnected' | 'failed' | 'closed';

export interface VoiceParticipant {
  uuid: string;
  isMuted: boolean;
  isSpeaking: boolean;
  volume: number; // 0.0 to 1.0
  connectionState: PeerConnectionStatus;
  stream?: MediaStream;
}

export interface AudioLevelEvent {
  uuid: string; // 'self' or peer UUID
  level: number; // 0.0 to 1.0
  isSpeaking: boolean;
}
