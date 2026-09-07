/**
 * Hang Time - WebRTC Voice Mesh Unit Tests
 */

import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import { VoiceMeshManager } from '../voice/voice-mesh-manager';
import { WebRTCSignalPayload, VoiceParticipant } from '../voice/types';

// Mock Web Audio & WebRTC APIs for Vitest jsdom environment
class MockMediaStreamTrack {
  enabled = true;
  stop = vi.fn();
}

class MockMediaStream {
  tracks: MockMediaStreamTrack[] = [new MockMediaStreamTrack()];
  getTracks() {
    return this.tracks;
  }
  getAudioTracks() {
    return this.tracks;
  }
}

class MockGainNode {
  gain = { value: 1.0 };
  connect = vi.fn();
}

class MockAnalyserNode {
  fftSize = 256;
  smoothingTimeConstant = 0.5;
  connect = vi.fn();
  getByteFrequencyData(arr: Uint8Array) {
    arr.fill(30); // moderate volume level
  }
}

class MockAudioContext {
  state = 'running';
  destination = {};
  resume = vi.fn().mockResolvedValue(undefined);
  close = vi.fn().mockResolvedValue(undefined);
  createMediaStreamSource = vi.fn().mockReturnValue({ connect: vi.fn() });
  createGain = vi.fn().mockReturnValue(new MockGainNode());
  createAnalyser = vi.fn().mockReturnValue(new MockAnalyserNode());
}

class MockRTCPeerConnection {
  iceServers: any;
  signalingState = 'stable';
  connectionState = 'connected';
  localDescription: any = null;
  remoteDescription: any = null;
  onicecandidate: ((e: any) => void) | null = null;
  ontrack: ((e: any) => void) | null = null;
  onconnectionstatechange: (() => void) | null = null;

  constructor(config?: any) {
    this.iceServers = config?.iceServers;
  }

  addTrack = vi.fn();
  createOffer = vi.fn().mockResolvedValue({ type: 'offer', sdp: 'v=0\r\no=mock' });
  createAnswer = vi.fn().mockResolvedValue({ type: 'answer', sdp: 'v=0\r\no=mock-answer' });
  setLocalDescription = vi.fn().mockImplementation((desc) => {
    this.localDescription = desc;
    return Promise.resolve();
  });
  setRemoteDescription = vi.fn().mockImplementation((desc) => {
    this.remoteDescription = desc;
    return Promise.resolve();
  });
  addIceCandidate = vi.fn().mockResolvedValue(undefined);
  close = vi.fn();
}

describe('VoiceMeshManager', () => {
  let voiceManager: VoiceMeshManager;
  let sentSignals: Array<{ targetUuid: string; signal: WebRTCSignalPayload }> = [];

  beforeEach(() => {
    sentSignals = [];
    vi.stubGlobal('AudioContext', MockAudioContext);
    vi.stubGlobal('RTCPeerConnection', MockRTCPeerConnection);
    vi.stubGlobal('RTCSessionDescription', class {
      type: string;
      sdp: string;
      constructor(init: any) {
        this.type = init.type;
        this.sdp = init.sdp;
      }
    });
    vi.stubGlobal('RTCIceCandidate', class {
      candidate: string;
      constructor(init: any) {
        this.candidate = init.candidate;
      }
    });

    // Mock navigator.mediaDevices.getUserMedia
    Object.defineProperty(navigator, 'mediaDevices', {
      value: {
        getUserMedia: vi.fn().mockResolvedValue(new MockMediaStream()),
      },
      writable: true,
      configurable: true,
    });

    voiceManager = new VoiceMeshManager();
  });

  afterEach(() => {
    voiceManager.leaveVoice();
    vi.restoreAllMocks();
  });

  it('initializes with default muted state and settings', () => {
    expect(voiceManager.getInVoice()).toBe(false);
    expect(voiceManager.getIsMuted()).toBe(true);
    expect(voiceManager.settings.voiceMode).toBe('open-mic');
    expect(voiceManager.settings.videoDucking).toBe(true);
  });

  it('joins voice room and acquires microphone stream', async () => {
    let participantUpdates: VoiceParticipant[] = [];
    voiceManager.initialize(
      'user-1',
      'act-123',
      (targetUuid, signal) => sentSignals.push({ targetUuid, signal }),
      {
        onParticipantsChanged: (parts) => {
          participantUpdates = parts;
        },
      }
    );

    const success = await voiceManager.joinVoice(['user-1', 'friend-bob']);
    expect(success).toBe(true);
    expect(voiceManager.getInVoice()).toBe(true);
    expect(participantUpdates.length).toBeGreaterThan(0);
    expect(participantUpdates[0]?.uuid).toBe('user-1');
  });

  it('toggles mute and updates local tracks and voice state', async () => {
    voiceManager.initialize('user-1', 'act-123', (targetUuid, signal) => {
      sentSignals.push({ targetUuid, signal });
    });

    await voiceManager.joinVoice();
    expect(voiceManager.getIsMuted()).toBe(true);

    voiceManager.setMuted(false);
    expect(voiceManager.getIsMuted()).toBe(false);

    voiceManager.setMuted(true);
    expect(voiceManager.getIsMuted()).toBe(true);
  });

  it('handles remote offer and sends answer signal back', async () => {
    voiceManager.initialize('user-1', 'act-123', (targetUuid, signal) => {
      sentSignals.push({ targetUuid, signal });
    });

    await voiceManager.joinVoice();

    const offerSignal: WebRTCSignalPayload = {
      target_uuid: 'user-1',
      sender_uuid: 'friend-alice',
      activity_id: 'act-123',
      type: 'offer',
      sdp: { type: 'offer', sdp: 'mock-sdp' },
      timestamp: Date.now(),
    };

    await voiceManager.handleSignal('friend-alice', offerSignal);

    expect(sentSignals.some(s => s.targetUuid === 'friend-alice' && s.signal.type === 'answer')).toBe(true);
  });

  it('cleans up audio tracks and peer connections on leaveVoice', async () => {
    voiceManager.initialize('user-1', 'act-123', (targetUuid, signal) => {
      sentSignals.push({ targetUuid, signal });
    });

    await voiceManager.joinVoice(['user-1', 'friend-bob']);
    expect(voiceManager.getInVoice()).toBe(true);

    voiceManager.leaveVoice();
    expect(voiceManager.getInVoice()).toBe(false);
    expect(voiceManager.getParticipants().length).toBe(0);
  });
});
