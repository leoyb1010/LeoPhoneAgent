import { AgentHub } from '../../../agent-hub';

type AgentHubTabProps = {
  /** Passed from Settings so a launch can close the modal and reveal the new chat. */
  onClose: () => void;
};

/** Top-level Settings tab hosting the agent-profile library. */
export default function AgentHubTab({ onClose }: AgentHubTabProps) {
  return (
    <div className="min-w-0">
      <AgentHub onAfterLaunch={onClose} />
    </div>
  );
}
