import React from 'react';
import { ShieldAlert, Check, X } from 'lucide-react';
import type { PendingApproval } from '../types';

interface ApprovalPopoverProps {
  approval: PendingApproval | null;
  onResolve: (id: string, decision: 'allow' | 'deny') => void;
}

export const ApprovalPopover: React.FC<ApprovalPopoverProps> = ({ approval, onResolve }) => {
  if (!approval) return null;

  return (
    <div className="approval-popover" data-pet-interactive="true">
      <div className="approval-header">
        <ShieldAlert size={16} className="approval-icon" />
        <span>终端命令执行确认</span>
      </div>
      {approval.summary && <div className="approval-summary">{approval.summary}</div>}
      <pre className="approval-cmd">{approval.commandLine}</pre>
      <div className="approval-actions">
        <button
          type="button"
          className="btn-approve"
          onClick={() => onResolve(approval.id, 'allow')}
        >
          <Check size={14} /> 允许运行
        </button>
        <button
          type="button"
          className="btn-deny"
          onClick={() => onResolve(approval.id, 'deny')}
        >
          <X size={14} /> 拦截拒绝
        </button>
      </div>
    </div>
  );
};
