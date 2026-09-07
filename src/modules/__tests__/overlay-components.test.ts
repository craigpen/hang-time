import { describe, it, expect, beforeEach } from 'vitest';
import {
  getParticipantColor,
  buildRoomParticipantsHtml,
  buildMessagesHtml,
  buildChatToastHtml,
  formatMessageTime,
  formatDividerDate,
} from '../overlay/components.js';

describe('Overlay Components & Color Consistency', () => {
  let userColorMap: Map<string, string>;

  beforeEach(() => {
    userColorMap = new Map();
  });

  describe('getParticipantColor', () => {
    it('returns red (#f43f5e) for current user when user is a guest', () => {
      const color = getParticipantColor('user-1', 'host-1', 'user-1', userColorMap);
      expect(color).toBe('#f43f5e');
    });

    it('returns red (#f43f5e) for current user even when user is the host', () => {
      const color = getParticipantColor('user-1', 'user-1', 'user-1', userColorMap);
      expect(color).toBe('#f43f5e');
    });

    it('returns red (#f43f5e) for special "user" identifier', () => {
      const color = getParticipantColor('user', 'host-1', 'user-1', userColorMap);
      expect(color).toBe('#f43f5e');
    });

    it('returns emerald (#10b981) for remote host', () => {
      const color = getParticipantColor('host-1', 'host-1', 'user-1', userColorMap);
      expect(color).toBe('#10b981');
    });

    it('returns deterministic mapped color for remote guests', () => {
      const color1 = getParticipantColor('guest-1', 'host-1', 'user-1', userColorMap);
      const color2 = getParticipantColor('guest-1', 'host-1', 'user-1', userColorMap);
      expect(color1).toBe(color2);
      expect(color1).not.toBe('#f43f5e'); // Not user red
    });

    it('returns gray fallback for empty/undefined uuid', () => {
      const color = getParticipantColor(undefined, 'host-1', 'user-1', userColorMap);
      expect(color).toBe('#6b7280');
    });
  });

  describe('Color matching between Room Strip and Chat Messages', () => {
    it('ensures guest chips in room strip and chat messages share identical border colors', () => {
      const sessionMembers = ['host-1', 'user-1', 'test3'];
      const hostUuid = 'host-1';
      const currentUserId = 'user-1';
      const nicknameMap = new Map([
        ['host-1', 'HostAlice'],
        ['user-1', 'Bob'],
        ['test3', 'Charlie'],
      ]);

      const getColor = (uuid: string) =>
        getParticipantColor(uuid, hostUuid, currentUserId, userColorMap);

      const roomHtml = buildRoomParticipantsHtml(
        sessionMembers,
        hostUuid,
        currentUserId,
        nicknameMap,
        getColor
      );

      const messagesHtml = buildMessagesHtml(
        [
          { id: '1', sender: 'Charlie', sender_id: 'test3', content: 'hello', timestamp: 1000 },
          { id: '2', sender: 'You', sender_id: 'user-1', content: 'hi', timestamp: 2000 },
        ],
        currentUserId,
        Object.fromEntries(nicknameMap),
        getColor
      );

      // Verify "You" is red in both
      expect(roomHtml).toContain('border: 1px solid #f43f5e');
      expect(messagesHtml).toContain('border: 1px solid #f43f5e');

      // Verify guest test3 color matches across room bar and chat
      const test3Color = getColor('test3');
      expect(roomHtml).toContain(`border: 1px solid ${test3Color}`);
      expect(messagesHtml).toContain(`border: 1px solid ${test3Color}`);

      // Verify host color matches
      const hostColor = getColor('host-1');
      expect(hostColor).toBe('#10b981');
      expect(roomHtml).toContain(`border: 1px solid ${hostColor}`);
    });

    it('formats chat toast HTML with matching sender color', () => {
      const toastHtml = buildChatToastHtml('Alice', '#10b981', 'Hello from toast');
      expect(toastHtml).toContain('border: 1px solid #10b981');
      expect(toastHtml).toContain('Alice');
      expect(toastHtml).toContain('Hello from toast');
    });

    it('formats timestamps and divider dates accurately', () => {
      const now = Date.now();
      expect(formatMessageTime(now)).toBeTruthy();
      expect(formatDividerDate(now)).toContain('Today');
    });
  });
});
