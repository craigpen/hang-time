/**
 * Hang Time - WebRTC Voice Mesh Manager
 * Manages serverless peer-to-peer audio mesh, microphone capture,
 * VAD (voice activity detection), audio graph, and video ducking.
 */

import {
  WebRTCSignalPayload,
  VoiceSettings,
  VoiceParticipant,
  AudioLevelEvent,
} from './types';

export interface PeerAudioEntry {
  pc: RTCPeerConnection;
  gainNode?: GainNode;
  analyser?: AnalyserNode;
  stream?: MediaStream;
  isSpeaking: boolean;
  isMuted: boolean;
  volume: number;
}

export class VoiceMeshManager {
  private currentUserId = '';
  private activityId = '';
  private sendSignalFn: ((targetUuid: string, signal: WebRTCSignalPayload) => void) | null = null;

  private localStream: MediaStream | null = null;
  private audioContext: AudioContext | null = null;
  private localAnalyser: AnalyserNode | null = null;
  private localGain: GainNode | null = null;

  private isMuted = true;
  private isInVoice = false;
  private isLocallySpeaking = false;

  private peers: Map<string, PeerAudioEntry> = new Map();
  private remoteVoiceStates = new Map<string, { inVoice: boolean; isMuted: boolean }>();
  private sessionMembers: string[] = [];
  private vadInterval: NodeJS.Timeout | null = null;

  public settings: VoiceSettings = {
    voiceMode: 'open-mic',
    pttKey: 'KeyV',
    micGain: 1.0,
    autoJoin: true,
    videoDucking: true,
  };

  private onParticipantsChanged: ((participants: VoiceParticipant[]) => void) | null = null;
  private onSpeakingChanged: ((event: AudioLevelEvent) => void) | null = null;
  private originalVideoVolume: number | null = null;

  private readonly iceServers: RTCIceServer[] = [
    { urls: 'stun:stun.l.google.com:19302' },
    { urls: 'stun:stun1.l.google.com:19302' },
    { urls: 'stun:stun2.l.google.com:19302' },
  ];

  constructor() {}

  public initialize(
    currentUserId: string,
    activityId: string,
    sendSignalFn: (targetUuid: string, signal: WebRTCSignalPayload) => void,
    callbacks?: {
      onParticipantsChanged?: (participants: VoiceParticipant[]) => void;
      onSpeakingChanged?: (event: AudioLevelEvent) => void;
    }
  ): void {
    this.currentUserId = currentUserId;
    this.activityId = activityId;
    this.sendSignalFn = sendSignalFn;
    if (callbacks?.onParticipantsChanged) this.onParticipantsChanged = callbacks.onParticipantsChanged;
    if (callbacks?.onSpeakingChanged) this.onSpeakingChanged = callbacks.onSpeakingChanged;
  }

  public setUserId(userId: string): void {
    if (userId) {
      this.currentUserId = userId;
    }
  }

  public setActivityId(activityId: string): void {
    if (activityId) {
      this.activityId = activityId;
    }
  }

  public getInVoice(): boolean {
    return this.isInVoice;
  }

  public getIsMuted(): boolean {
    return this.isMuted;
  }

  /**
   * Acquire microphone, initialize audio context, and connect to session members
   */
  public async joinVoice(sessionMembers: string[] = []): Promise<boolean> {
    if (this.isInVoice) return true;
    this.sessionMembers = sessionMembers;

    try {
      // 1. Acquire microphone
      const constraints: MediaStreamConstraints = {
        audio: {
          echoCancellation: true,
          noiseSuppression: true,
          autoGainControl: true,
          ...(this.settings.inputDeviceId ? { deviceId: { exact: this.settings.inputDeviceId } } : {}),
        },
        video: false,
      };

      this.localStream = await navigator.mediaDevices.getUserMedia(constraints);

      // Default to muted on join
      this.isMuted = true;
      this.localStream.getAudioTracks().forEach(track => {
        track.enabled = !this.isMuted;
      });

      // 2. Setup AudioContext and local analyzer
      const AudioCtx = window.AudioContext || (window as any).webkitAudioContext;
      if (AudioCtx) {
        this.audioContext = new AudioCtx();
        if (this.audioContext.state === 'suspended') {
          await this.audioContext.resume();
        }

        const source = this.audioContext.createMediaStreamSource(this.localStream);
        this.localGain = this.audioContext.createGain();
        this.localGain.gain.value = this.settings.micGain;

        this.localAnalyser = this.audioContext.createAnalyser();
        this.localAnalyser.fftSize = 256;
        this.localAnalyser.smoothingTimeConstant = 0.5;

        source.connect(this.localGain);
        this.localGain.connect(this.localAnalyser);
        // Do NOT connect local stream to destination to avoid self-echo
      }

      this.isInVoice = true;
      this.startVoiceActivityDetection();

      // 3. Connect to other session members who are already in voice
      for (const memberUuid of sessionMembers) {
        if (memberUuid !== this.currentUserId) {
          if (this.remoteVoiceStates.get(memberUuid)?.inVoice) {
            const isInitiator = this.currentUserId < memberUuid;
            this.initiatePeerConnection(memberUuid, isInitiator);
          }
        }
      }

      // Broadcast voice presence to all peers
      this.broadcastVoiceState();
      this.notifyParticipantsChanged();
      return true;
    } catch (err) {
      console.warn('[VoiceMeshManager] Failed to join voice room:', err);
      this.cleanup();
      return false;
    }
  }

  /**
   * Leave voice room, close peer connections, and release microphone
   */
  public leaveVoice(): void {
    if (!this.isInVoice) return;
    this.broadcastVoiceState(false);
    this.cleanup();
    this.notifyParticipantsChanged();
  }

  /**
   * Toggle or set mute state
   */
  public setMuted(muted: boolean): void {
    this.isMuted = muted;
    if (this.localStream) {
      this.localStream.getAudioTracks().forEach(track => {
        track.enabled = !muted;
      });
    }
    if (muted && this.isLocallySpeaking) {
      this.isLocallySpeaking = false;
      if (this.onSpeakingChanged) {
        this.onSpeakingChanged({ uuid: this.currentUserId, level: 0, isSpeaking: false });
      }
    }
    this.broadcastVoiceState();
    this.notifyParticipantsChanged();
  }

  /**
   * Adjust volume for a specific remote peer (0.0 to 1.0)
   */
  public setPeerVolume(peerUuid: string, volume: number): void {
    const peer = this.peers.get(peerUuid);
    if (peer) {
      peer.volume = Math.max(0, Math.min(1, volume));
      if (peer.gainNode) {
        peer.gainNode.gain.value = peer.volume;
      }
      this.notifyParticipantsChanged();
    }
  }

  /**
   * Get volume for a specific remote peer (0.0 to 1.0)
   */
  public getPeerVolume(peerUuid: string): number {
    return this.peers.get(peerUuid)?.volume ?? 1.0;
  }

  /**
   * Handle incoming WebRTC signaling message
   */
  public async handleSignal(senderUuid: string, signal: WebRTCSignalPayload): Promise<void> {
    if (!this.isInVoice && signal.type !== 'voice-state') {
      return;
    }

    try {
      if (signal.type === 'voice-state') {
        if (signal.in_voice === false) {
          this.remoteVoiceStates.delete(senderUuid);
          if (this.peers.has(senderUuid)) {
            this.removePeer(senderUuid);
          }
        } else {
          this.remoteVoiceStates.set(senderUuid, {
            inVoice: true,
            isMuted: signal.is_muted ?? false,
          });
          if (this.isInVoice && !this.peers.has(senderUuid)) {
            const isInitiator = this.currentUserId < senderUuid;
            this.initiatePeerConnection(senderUuid, isInitiator);
          } else if (this.peers.has(senderUuid)) {
            const peer = this.peers.get(senderUuid)!;
            peer.isMuted = signal.is_muted ?? false;
          }
        }
        this.notifyParticipantsChanged();
        return;
      }

      let peer = this.peers.get(senderUuid);
      if (!peer) {
        peer = this.createPeerConnection(senderUuid);
      }

      const pc = peer.pc;

      if (signal.type === 'offer' && signal.sdp) {
        await pc.setRemoteDescription(new RTCSessionDescription(signal.sdp));
        const answer = await pc.createAnswer();
        await pc.setLocalDescription(answer);

        if (this.sendSignalFn) {
          this.sendSignalFn(senderUuid, {
            target_uuid: senderUuid,
            sender_uuid: this.currentUserId,
            activity_id: this.activityId,
            type: 'answer',
            sdp: answer,
            timestamp: Date.now(),
          });
        }
      } else if (signal.type === 'answer' && signal.sdp) {
        if (pc.signalingState === 'have-local-offer') {
          await pc.setRemoteDescription(new RTCSessionDescription(signal.sdp));
        }
      } else if (signal.type === 'ice-candidate' && signal.candidate) {
        try {
          await pc.addIceCandidate(new RTCIceCandidate(signal.candidate));
        } catch (e) {
          console.debug('[VoiceMeshManager] Error adding ICE candidate:', e);
        }
      }
    } catch (err) {
      console.warn('[VoiceMeshManager] Error handling signal from', senderUuid, err);
    }
  }

  /**
   * Sync active session members (connects newly joined, removes parted)
   */
  public syncSessionMembers(members: string[]): void {
    this.sessionMembers = members;
    if (!this.isInVoice) return;

    const memberSet = new Set(members);

    // Remove peers no longer in session
    for (const peerUuid of this.peers.keys()) {
      if (!memberSet.has(peerUuid)) {
        this.removePeer(peerUuid);
      }
    }

    // Connect to new members
    for (const memberUuid of members) {
      if (memberUuid !== this.currentUserId && !this.peers.has(memberUuid)) {
        const isInitiator = this.currentUserId < memberUuid;
        this.initiatePeerConnection(memberUuid, isInitiator);
      }
    }

    this.notifyParticipantsChanged();
  }

  /**
   * List all current voice participants
   */
  public getParticipants(): VoiceParticipant[] {
    const list: VoiceParticipant[] = [];

    if (this.isInVoice) {
      list.push({
        uuid: this.currentUserId,
        isMuted: this.isMuted,
        isSpeaking: this.isLocallySpeaking,
        volume: 1.0,
        connectionState: 'connected',
        stream: this.localStream || undefined,
      });

      for (const [uuid, peer] of this.peers.entries()) {
        const isPeerInVoice = this.remoteVoiceStates.get(uuid)?.inVoice === true;
        const isPeerConnected = peer.pc.connectionState === 'connected';
        if (isPeerInVoice || isPeerConnected) {
          list.push({
            uuid,
            isMuted: peer.isMuted,
            isSpeaking: peer.isSpeaking,
            volume: peer.volume,
            connectionState: (peer.pc.connectionState || 'connected') as any,
            stream: peer.stream,
          });
        }
      }

      // Also include any remote peers known to be in voice who might still be connecting
      for (const [uuid, state] of this.remoteVoiceStates.entries()) {
        if (state.inVoice && !this.peers.has(uuid) && uuid !== this.currentUserId) {
          list.push({
            uuid,
            isMuted: state.isMuted,
            isSpeaking: false,
            volume: 1.0,
            connectionState: 'connecting',
          });
        }
      }
    } else {
      // Remote voice states when local client is not in voice
      for (const [uuid, state] of this.remoteVoiceStates.entries()) {
        if (state.inVoice) {
          list.push({
            uuid,
            isMuted: state.isMuted,
            isSpeaking: false,
            volume: 1.0,
            connectionState: 'disconnected',
          });
        }
      }
    }

    return list;
  }

  private initiatePeerConnection(peerUuid: string, isInitiator: boolean): void {
    let peer = this.peers.get(peerUuid);
    if (!peer) {
      peer = this.createPeerConnection(peerUuid);
    }

    if (isInitiator) {
      peer.pc.createOffer({ offerToReceiveAudio: true })
        .then(offer => peer!.pc.setLocalDescription(offer))
        .then(() => {
          if (this.sendSignalFn && peer!.pc.localDescription) {
            this.sendSignalFn(peerUuid, {
              target_uuid: peerUuid,
              sender_uuid: this.currentUserId,
              activity_id: this.activityId,
              type: 'offer',
              sdp: peer!.pc.localDescription,
              timestamp: Date.now(),
            });
          }
        })
        .catch(err => console.warn('[VoiceMeshManager] Create offer error for', peerUuid, err));
    }
  }

  private createPeerConnection(peerUuid: string): PeerAudioEntry {
    const pc = new RTCPeerConnection({ iceServers: this.iceServers });

    const entry: PeerAudioEntry = {
      pc,
      isSpeaking: false,
      isMuted: false,
      volume: 1.0,
    };
    this.peers.set(peerUuid, entry);

    // Add local mic audio tracks
    if (this.localStream) {
      this.localStream.getAudioTracks().forEach(track => {
        pc.addTrack(track, this.localStream!);
      });
    }

    pc.onicecandidate = (e) => {
      if (e.candidate && this.sendSignalFn) {
        this.sendSignalFn(peerUuid, {
          target_uuid: peerUuid,
          sender_uuid: this.currentUserId,
          activity_id: this.activityId,
          type: 'ice-candidate',
          candidate: e.candidate.toJSON(),
          timestamp: Date.now(),
        });
      }
    };

    pc.ontrack = (e) => {
      if (e.streams && e.streams[0]) {
        entry.stream = e.streams[0];
        this.attachRemoteAudioStream(peerUuid, entry, e.streams[0]);
        this.notifyParticipantsChanged();
      }
    };

    pc.onconnectionstatechange = () => {
      if (pc.connectionState === 'failed' || pc.connectionState === 'closed') {
        this.removePeer(peerUuid);
      }
      this.notifyParticipantsChanged();
    };

    return entry;
  }

  private attachRemoteAudioStream(_peerUuid: string, entry: PeerAudioEntry, stream: MediaStream): void {
    try {
      if (!this.audioContext) {
        const AudioCtx = window.AudioContext || (window as any).webkitAudioContext;
        if (AudioCtx) this.audioContext = new AudioCtx();
      }

      if (this.audioContext) {
        const source = this.audioContext.createMediaStreamSource(stream);
        entry.gainNode = this.audioContext.createGain();
        entry.gainNode.gain.value = entry.volume;

        entry.analyser = this.audioContext.createAnalyser();
        entry.analyser.fftSize = 256;
        entry.analyser.smoothingTimeConstant = 0.5;

        source.connect(entry.gainNode);
        entry.gainNode.connect(entry.analyser);
        entry.analyser.connect(this.audioContext.destination);
      }
    } catch (err) {
      console.warn('[VoiceMeshManager] Attach remote audio error:', err);
    }
  }

  private startVoiceActivityDetection(): void {
    if (this.vadInterval) clearInterval(this.vadInterval);

    const dataArray = new Uint8Array(128);

    this.vadInterval = setInterval(() => {
      if (!this.isInVoice) return;

      let anyoneSpeaking = false;

      // 1. Check local microphone
      if (this.localAnalyser && !this.isMuted) {
        this.localAnalyser.getByteFrequencyData(dataArray);
        let sum = 0;
        for (let i = 0; i < dataArray.length; i++) {
          const val = dataArray[i] ?? 0;
        sum += val * val;
        }
        const rms = Math.sqrt(sum / dataArray.length);
        const level = Math.min(1.0, rms / 128);
        const isSpeaking = level > 0.12;

        if (isSpeaking !== this.isLocallySpeaking) {
          this.isLocallySpeaking = isSpeaking;
          if (this.onSpeakingChanged) {
            this.onSpeakingChanged({ uuid: this.currentUserId, level, isSpeaking });
          }
        }
        if (isSpeaking) anyoneSpeaking = true;
      }

      // 2. Check remote peers
      for (const [peerUuid, peer] of this.peers.entries()) {
        if (peer.analyser) {
          peer.analyser.getByteFrequencyData(dataArray);
          let sum = 0;
          for (let i = 0; i < dataArray.length; i++) {
            const val = dataArray[i] ?? 0;
        sum += val * val;
          }
          const rms = Math.sqrt(sum / dataArray.length);
          const level = Math.min(1.0, rms / 128);
          const isSpeaking = level > 0.12;

          if (isSpeaking !== peer.isSpeaking) {
            peer.isSpeaking = isSpeaking;
            if (this.onSpeakingChanged) {
              this.onSpeakingChanged({ uuid: peerUuid, level, isSpeaking });
            }
          }
          if (isSpeaking) anyoneSpeaking = true;
        }
      }

      // 3. Smart Video Ducking
      if (this.settings.videoDucking) {
        this.applyVideoDucking(anyoneSpeaking);
      }
    }, 100);
  }

  private applyVideoDucking(isSpeaking: boolean): void {
    const video = document.querySelector('video') as HTMLVideoElement | null;
    if (!video) return;

    if (isSpeaking) {
      if (this.originalVideoVolume === null) {
        this.originalVideoVolume = video.volume;
      }
      const ducked = Math.max(0, this.originalVideoVolume * 0.7);
      if (Math.abs(video.volume - ducked) > 0.05) {
        video.volume = ducked;
      }
    } else if (this.originalVideoVolume !== null) {
      video.volume = this.originalVideoVolume;
      this.originalVideoVolume = null;
    }
  }

  private broadcastVoiceState(inVoice = this.isInVoice): void {
    if (!this.sendSignalFn) return;

    const targetUuids = new Set<string>([...this.sessionMembers, ...this.peers.keys()]);
    for (const targetUuid of targetUuids) {
      if (targetUuid && targetUuid !== this.currentUserId) {
        this.sendSignalFn(targetUuid, {
          target_uuid: targetUuid,
          sender_uuid: this.currentUserId,
          activity_id: this.activityId,
          type: 'voice-state',
          is_muted: this.isMuted,
          in_voice: inVoice,
          timestamp: Date.now(),
        });
      }
    }
  }

  private removePeer(peerUuid: string): void {
    const peer = this.peers.get(peerUuid);
    if (peer) {
      try {
        peer.pc.close();
      } catch (_) {}
      this.peers.delete(peerUuid);
      if (peer.isSpeaking && this.onSpeakingChanged) {
        this.onSpeakingChanged({ uuid: peerUuid, level: 0, isSpeaking: false });
      }
    }
  }

  private cleanup(): void {
    this.isInVoice = false;
    this.isMuted = true;
    this.isLocallySpeaking = false;

    if (this.vadInterval) {
      clearInterval(this.vadInterval);
      this.vadInterval = null;
    }

    for (const peer of this.peers.values()) {
      try {
        peer.pc.close();
      } catch (_) {}
    }
    this.peers.clear();

    if (this.localStream) {
      this.localStream.getTracks().forEach(t => t.stop());
      this.localStream = null;
    }

    if (this.audioContext && this.audioContext.state !== 'closed') {
      try {
        this.audioContext.close();
      } catch (_) {}
      this.audioContext = null;
    }

    if (this.originalVideoVolume !== null) {
      const video = document.querySelector('video');
      if (video) video.volume = this.originalVideoVolume;
      this.originalVideoVolume = null;
    }
  }

  private notifyParticipantsChanged(): void {
    if (this.onParticipantsChanged) {
      this.onParticipantsChanged(this.getParticipants());
    }
  }
}
