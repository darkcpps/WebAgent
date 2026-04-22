interface PendingApproval {
  resolve: (approved: boolean) => void;
  reject: (error: Error) => void;
}

export class ApprovalManager {
  private pending = new Map<string, PendingApproval>();

  request(actionId: string): Promise<boolean> {
    return new Promise<boolean>((resolve, reject) => {
      this.pending.set(actionId, { resolve, reject });
    });
  }

  approve(actionId: string): void {
    const pending = this.pending.get(actionId);
    if (!pending) {
      return;
    }
    pending.resolve(true);
    this.pending.delete(actionId);
  }

  reject(actionId: string): void {
    const pending = this.pending.get(actionId);
    if (!pending) {
      return;
    }
    pending.resolve(false);
    this.pending.delete(actionId);
  }

  cancelAll(message = 'Approval request cancelled.'): void {
    for (const [actionId, pending] of this.pending.entries()) {
      pending.reject(new Error(message));
      this.pending.delete(actionId);
    }
  }
}
