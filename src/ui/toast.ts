/**
 * Hang Time - Toast & UI Helper Utilities
 */

/**
 * Escapes HTML characters to prevent XSS in rendered templates
 */
export function escapeHtml(text: string): string {
  const div = document.createElement('div');
  div.textContent = text;
  return div.innerHTML;
}

/**
 * Simple toast notification manager
 */
export class ToastManager {
  private container: HTMLElement | null = null;

  init(): void {
    this.container = document.getElementById('toast-container');
  }

  show(message: string, options?: { duration?: number; onClick?: () => void }): void {
    if (!this.container) {
      this.init();
    }
    if (!this.container) return;

    const toast = document.createElement('div');
    toast.className = 'toast';
    toast.textContent = message;

    if (options?.onClick) {
      toast.style.cursor = 'pointer';
      toast.addEventListener('click', options.onClick);
    }

    this.container.appendChild(toast);

    // Auto-remove after duration
    const duration = options?.duration || 4000;
    setTimeout(() => {
      toast.classList.add('toast-hide');
      setTimeout(() => toast.remove(), 300);
    }, duration);
  }

  showSuccess(message: string): void {
    this.show(message, { duration: 3000 });
  }

  showError(message: string): void {
    this.show(message, { duration: 5000 });
  }
}

export const toastManager = new ToastManager();
