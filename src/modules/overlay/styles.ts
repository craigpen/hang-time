/**
 * Hang Time - Overlay UI Styles
 * CSS stylesheet and style utilities for in-page co-watching overlay
 */

export function getOverlayStyles(): string {
  return `
    <style id="hang-time-overlay-styles">
      #hang-time-overlay {
        position: fixed;
        top: 20px;
        right: 20px;
        width: 320px;
        max-height: 80vh;
        background: rgba(15, 23, 42, 0.88);
        backdrop-filter: blur(16px);
        -webkit-backdrop-filter: blur(16px);
        border: 1px solid rgba(255, 255, 255, 0.12);
        border-radius: 12px;
        box-shadow: 0 12px 40px rgba(0, 0, 0, 0.55), inset 0 1px 0 rgba(255, 255, 255, 0.14);
        z-index: 2147483647;
        font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, 'Helvetica Neue', sans-serif;
        -webkit-font-smoothing: antialiased;
        -moz-osx-font-smoothing: grayscale;
        text-rendering: optimizeLegibility;
        color: white;
        display: flex;
        flex-direction: column;
        overflow: hidden;
        transition: opacity 0.2s ease, transform 0.2s ease;
        opacity: var(--overlay-opacity, 0.85);
        pointer-events: auto;
      }

      #hang-time-overlay.hidden {
        opacity: 0 !important;
        pointer-events: none !important;
        visibility: hidden !important;
      }

      #hang-time-overlay.fading-out {
        transition: opacity 3s ease-out !important;
        opacity: 0 !important;
        pointer-events: auto;
      }

      #resize-handle {
        position: absolute;
        bottom: 0;
        right: 0;
        width: 18px;
        height: 18px;
        cursor: nwse-resize;
        user-select: none;
        background: linear-gradient(135deg, transparent 50%, rgba(255, 255, 255, 0.25) 50%);
        border-radius: 0 0 12px 0;
      }

      #resize-handle:hover {
        background: linear-gradient(135deg, transparent 50%, rgba(255, 255, 255, 0.5) 50%);
      }

      .overlay-header {
        padding: 10px 12px;
        border-bottom: 1px solid rgba(255, 255, 255, 0.08);
        cursor: grab;
        user-select: none;
        background: rgba(255, 255, 255, 0.02);
      }

      .overlay-header:active {
        cursor: grabbing;
      }

      .header-top {
        display: flex;
        justify-content: space-between;
        align-items: center;
        gap: 8px;
        margin-bottom: 8px;
      }

      .video-title {
        font-size: 13px;
        font-weight: 700;
        letter-spacing: 0.3px;
        white-space: nowrap;
        overflow: hidden;
        text-overflow: ellipsis;
        color: rgba(255, 255, 255, 0.95);
        flex: 1;
        display: flex;
        align-items: center;
        gap: 6px;
      }

      .overlay-brand-icon {
        flex-shrink: 0;
        display: block;
      }

      .overlay-role-row {
        display: flex;
        align-items: center;
        gap: 6px;
        min-height: 20px;
      }

      .overlay-role-label {
        font-size: 10px;
        font-weight: 700;
        letter-spacing: 0.8px;
        text-transform: uppercase;
        color: rgba(255, 255, 255, 0.65);
        min-width: 44px;
        flex-shrink: 0;
      }

      .video-title-row {
        display: flex;
        align-items: center;
        gap: 6px;
        font-size: 12px;
        color: rgba(255, 255, 255, 0.85);
        font-weight: 500;
        white-space: nowrap;
        overflow: hidden;
        text-overflow: ellipsis;
      }

      .media-title-text {
        white-space: nowrap;
        overflow: hidden;
        text-overflow: ellipsis;
      }

      .progress-bar-wrapper {
        display: flex;
        gap: 8px;
        align-items: center;
        flex: 1;
      }

      .progress-bar-container {
        flex: 1;
        height: 6px;
        background: rgba(255, 255, 255, 0.15);
        border-radius: 3px;
        overflow: visible;
        position: relative;
        display: flex;
        align-items: center;
      }

      .progress-bar-controls-left {
        display: flex;
        align-items: center;
        gap: 6px;
        height: 22px;
        flex-shrink: 0;
        box-sizing: border-box;
      }

      .host-state-indicator {
        font-size: 11px;
        line-height: 22px;
        height: 22px;
        display: inline-flex;
        align-items: center;
        justify-content: center;
        color: rgba(255, 255, 255, 0.7);
        flex-shrink: 0;
        user-select: none;
      }

      .host-state-indicator.host-state-playing {
        color: #10b981;
      }

      .progress-time-display {
        font-size: 10px;
        font-weight: 600;
        font-variant-numeric: tabular-nums;
        color: rgba(255, 255, 255, 0.75);
        white-space: nowrap;
        line-height: 22px;
        height: 22px;
        min-width: 28px;
        display: inline-flex;
        align-items: center;
        justify-content: flex-end;
      }

      #progress-sync-button {
        display: none;
        padding: 0 6px;
        height: 18px;
        line-height: 16px;
        background: rgba(255, 255, 255, 0.12);
        border: 1px solid rgba(255, 255, 255, 0.2);
        color: white;
        border-radius: 4px;
        cursor: pointer;
        font-size: 11px;
        white-space: nowrap;
        transition: all 0.2s ease;
        align-items: center;
        justify-content: center;
        flex-shrink: 0;
        box-sizing: border-box;
      }

      #progress-sync-button:hover {
        background: rgba(255, 255, 255, 0.22);
        border-color: rgba(255, 255, 255, 0.35);
      }

      .progress-bar-fill {
        height: 100%;
        background: linear-gradient(90deg, #10b981, #059669);
        border-radius: 3px;
        width: 0%;
        transition: width 0.1s linear;
      }

      .progress-bar-marker {
        position: absolute;
        top: 50%;
        transform: translateY(-50%);
        left: 0%;
        width: 10px;
        height: 12px;
        background: #f43f5e;
        transition: left 0.1s linear;
        user-select: none;
        pointer-events: none;
        z-index: 6;
      }

      .progress-bar-marker.arrow-right {
        clip-path: polygon(0% 0%, 0% 100%, 100% 50%);
        margin-left: 3px;
      }

      .progress-bar-marker.arrow-left {
        clip-path: polygon(100% 0%, 100% 100%, 0% 50%);
        margin-left: -13px;
      }

      .progress-bar-host-marker {
        position: absolute;
        top: 50%;
        transform: translateY(-50%);
        width: 3px;
        height: 16px;
        background: #10b981;
        left: 0%;
        transition: left 0.1s linear;
        box-shadow: 0 0 6px rgba(16, 185, 129, 0.8);
        pointer-events: none;
      }

      .attendee-chip {
        display: inline-flex;
        align-items: center;
        padding: 2px 8px;
        border-radius: 9999px;
        font-size: 11px;
        color: white;
        font-weight: 600;
        letter-spacing: 0.2px;
        text-shadow: 0 1px 2px rgba(0, 0, 0, 0.4);
        box-shadow: 0 1px 3px rgba(0, 0, 0, 0.2);
        transition: all 0.15s ease;
      }

      .guest-markers-container {
        position: absolute;
        top: 0;
        left: 0;
        width: 100%;
        height: 100%;
        pointer-events: none;
      }

      .guest-marker {
        position: absolute;
        top: 50%;
        transform: translateY(-50%);
        width: 2px;
        height: 14px;
        left: 0%;
        border-radius: 1px;
        transition: left 0.1s linear;
      }

      .user-position-marker {
        position: absolute;
        top: 50%;
        transform: translateY(-50%);
        width: 3px;
        height: 16px;
        background: #f43f5e;
        border-radius: 1.5px;
        left: 0%;
        transition: left 0.1s linear;
        pointer-events: none;
        box-shadow: 0 0 4px rgba(0, 0, 0, 0.6);
        z-index: 10;
      }

      .gap-indicator {
        position: absolute;
        top: 50%;
        transform: translateY(-50%);
        height: 2px;
        background: #f43f5e;
        left: 0%;
        transition: left 0.1s linear, width 0.1s linear;
        pointer-events: none;
        z-index: 5;
      }

      .icon-buttons {
        display: flex;
        gap: 6px;
        align-items: center;
        flex-shrink: 0;
      }

      .icon-button {
        width: 22px;
        height: 22px;
        padding: 0;
        background: transparent;
        border: none;
        cursor: pointer;
        display: flex;
        align-items: center;
        justify-content: center;
        transition: all 0.2s ease;
        font-size: 11px;
        color: rgba(255, 255, 255, 0.7);
      }

      .icon-button:hover {
        background: transparent;
        border: none;
        color: white;
        transform: scale(1.08);
      }

      .icon-button:active {
        transform: scale(0.94);
      }

      #pin-button {
        background: transparent;
        border: none;
      }

      #pin-button:hover {
        background: transparent;
        border: none;
        color: white;
      }

      #pin-button.pinned {
        background: transparent;
        border: none;
        color: #ef4444;
      }

      #pin-button svg {
        transition: fill 0.2s ease, stroke 0.2s ease;
      }

      #pin-button.pinned svg {
        fill: #ef4444;
        stroke: #ef4444;
      }

      #discord-button {
        background-size: 16px 16px;
        background-position: center;
        background-repeat: no-repeat;
        font-size: 0;
        background-color: transparent;
        border: none;
      }

      #discord-button:hover {
        opacity: 0.9;
      }

      .opacity-control {
        position: relative;
        display: flex;
        align-items: center;
        justify-content: center;
      }

      .opacity-popover {
        position: absolute;
        top: calc(100% + 6px);
        right: -6px;
        background: rgba(15, 23, 42, 0.96);
        backdrop-filter: blur(16px);
        border: 1px solid rgba(255, 255, 255, 0.15);
        border-radius: 8px;
        padding: 8px 10px;
        box-shadow: 0 10px 25px -5px rgba(0, 0, 0, 0.6), 0 8px 10px -6px rgba(0, 0, 0, 0.4);
        display: none;
        flex-direction: column;
        gap: 6px;
        width: 120px;
        z-index: 100;
        pointer-events: auto;
      }

      /* Invisible bridge to prevent mouse leaving while moving from button to popover */
      .opacity-control::after {
        content: '';
        position: absolute;
        top: 100%;
        left: -10px;
        right: -10px;
        height: 10px;
        display: none;
      }

      .opacity-control:hover::after,
      .opacity-control:focus-within::after {
        display: block;
      }

      .opacity-control:hover .opacity-popover,
      .opacity-control:focus-within .opacity-popover,
      .opacity-control.open .opacity-popover {
        display: flex;
        animation: popoverFadeIn 0.15s cubic-bezier(0.16, 1, 0.3, 1);
      }

      @keyframes popoverFadeIn {
        from {
          opacity: 0;
          transform: translateY(-4px) scale(0.96);
        }
        to {
          opacity: 1;
          transform: translateY(0) scale(1);
        }
      }

      .opacity-popover-header {
        display: flex;
        align-items: center;
        justify-content: space-between;
        font-size: 10px;
        font-weight: 600;
        color: #94a3b8;
        text-transform: uppercase;
        letter-spacing: 0.05em;
      }

      .opacity-value-label {
        font-size: 10px;
        font-weight: 700;
        color: #38bdf8;
      }

      .opacity-slider {
        width: 100%;
        height: 4px;
        cursor: pointer;
        accent-color: #38bdf8;
        flex-shrink: 0;
        -webkit-appearance: none;
        appearance: none;
        background: rgba(255, 255, 255, 0.2);
        border-radius: 2px;
        outline: none;
      }

      .opacity-slider::-webkit-slider-thumb {
        -webkit-appearance: none;
        appearance: none;
        width: 12px;
        height: 12px;
        border-radius: 50%;
        background: #38bdf8;
        cursor: pointer;
        box-shadow: 0 0 6px rgba(56, 189, 248, 0.6);
      }

      .opacity-slider::-moz-range-thumb {
        width: 12px;
        height: 12px;
        border-radius: 50%;
        background: #38bdf8;
        cursor: pointer;
        border: none;
        box-shadow: 0 0 6px rgba(56, 189, 248, 0.6);
      }

      .opacity-slider::-moz-range-track {
        background: transparent;
        border: none;
      }

      .divergence-join-btn {
        background: rgba(16, 185, 129, 0.15);
        border: 1px solid rgba(16, 185, 129, 0.3);
        color: #34d399;
        border-radius: 7px;
        width: 26px;
        height: 26px;
        display: flex;
        align-items: center;
        justify-content: center;
        cursor: pointer;
        transition: all 0.2s ease;
        padding: 0;
        flex-shrink: 0;
      }

      .divergence-join-btn:hover {
        background: rgba(16, 185, 129, 0.3);
        border-color: rgba(16, 185, 129, 0.6);
        color: #10b981;
        transform: scale(1.06);
      }

      .divergence-join-btn:active {
        transform: scale(0.95);
      }

      #hang-time-chat-container {
        flex: 1;
        overflow-y: auto;
        padding: 8px 10px;
        display: flex;
        flex-direction: column;
        gap: 4px;
      }

            .chat-time-divider {
        text-align: center;
        font-size: 9.5px;
        font-weight: 500;
        color: rgba(255, 255, 255, 0.38);
        margin: 6px 0 2px 0;
        user-select: none;
        letter-spacing: 0.2px;
      }

      .chat-message {
        display: flex;
        flex-direction: column;
        gap: 1px;
        font-size: 11.5px;
        line-height: 1.35;
        max-width: 85%;
      }

      .chat-message.message-user {
        align-self: flex-end;
        align-items: flex-end;
      }

      .chat-message.message-friend {
        align-self: flex-start;
        align-items: flex-start;
      }

      .message-content {
        padding: 3px 8px;
        border-radius: 9px;
        word-wrap: break-word;
        font-size: 11.5px;
        flex: 0 1 auto;
      }

      .message-time {
        font-size: 9px;
        color: rgba(255, 255, 255, 0.4);
        margin-top: 1px;
        padding: 0 3px;
        user-select: none;
        line-height: 1.1;
      }

      .message-user .message-time {
        align-self: flex-end;
      }

      .message-friend .message-time {
        align-self: flex-start;
      }

      .message-friend .message-content {
        background: rgba(255, 255, 255, 0.08);
        color: rgba(255, 255, 255, 0.95);
        border-bottom-left-radius: 3px;
      }

      .message-user .message-content {
        background: rgba(244, 63, 94, 0.25);
        border: 1px solid rgba(244, 63, 94, 0.35);
        color: white;
        border-bottom-right-radius: 3px;
      }

      .message-input-container {
        padding: 8px 10px;
        border-top: 1px solid rgba(255, 255, 255, 0.08);
        display: flex;
        gap: 6px;
        align-items: flex-end;
        background: rgba(255, 255, 255, 0.02);
      }

      #message-input {
        box-sizing: border-box;
        flex: 1;
        height: 32px;
        min-height: 32px;
        max-height: 68px;
        line-height: 20px;
        padding: 5px 8px;
        background: rgba(255, 255, 255, 0.06);
        border: 1px solid rgba(255, 255, 255, 0.1);
        border-radius: 6px;
        color: white;
        font-size: 12px;
        font-family: inherit;
        resize: none;
        outline: none;
        overflow-y: auto;
        transition: border-color 0.2s ease, background 0.2s ease;
      }

      #message-input::placeholder {
        color: rgba(255, 255, 255, 0.35);
      }

      #message-input:focus {
        background: rgba(255, 255, 255, 0.09);
        border-color: rgba(244, 63, 94, 0.5);
      }

      #send-button {
        padding: 4px 8px;
        background: transparent;
        border: none;
        color: rgba(255, 255, 255, 0.5);
        cursor: pointer;
        font-size: 14px;
        transition: color 0.2s, transform 0.1s;
      }

      #send-button:hover {
        color: rgba(255, 255, 255, 0.9);
        transform: translateY(-1px);
      }

      #send-button:active {
        color: #34d399;
        transform: translateY(0);
      }
      /* Ephemeral In-Video Chat Toast Notifications */
      #hang-time-toast-container {
        position: fixed;
        pointer-events: none;
        z-index: 2147483646;
        display: flex;
        flex-direction: column;
        gap: 6px;
        max-width: 320px;
        transition: opacity 0.2s ease;
      }

      .hang-time-chat-toast {
        pointer-events: auto;
        background: rgba(15, 23, 42, 0.88);
        backdrop-filter: blur(16px);
        -webkit-backdrop-filter: blur(16px);
        border: 1px solid rgba(255, 255, 255, 0.14);
        border-radius: 10px;
        padding: 7px 10px;
        box-shadow: 0 8px 30px rgba(0, 0, 0, 0.55), inset 0 1px 0 rgba(255, 255, 255, 0.14);
        font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
        font-size: 11.5px;
        color: white;
        display: flex;
        flex-direction: column;
        gap: 2px;
        opacity: 0;
        transform: translateY(-6px) scale(0.97);
        transition: opacity 0.25s cubic-bezier(0.16, 1, 0.3, 1), transform 0.25s cubic-bezier(0.16, 1, 0.3, 1);
        max-width: 100%;
        word-break: break-word;
        cursor: pointer;
      }

      .hang-time-chat-toast.toast-visible {
        opacity: 0.95;
        transform: translateY(0) scale(1);
      }

      .hang-time-chat-toast.toast-fading {
        opacity: 0;
        transform: translateY(-6px) scale(0.97);
      }

      .hang-time-chat-toast:hover {
        opacity: 1;
        border-color: rgba(255, 255, 255, 0.25);
      }

      .toast-header {
        display: flex;
        align-items: center;
        gap: 6px;
      }

      .toast-content {
        line-height: 1.35;
        color: rgba(255, 255, 255, 0.95);
        font-size: 11.5px;
      }

      

    </style>
  `;
}
