import { LongTextPage } from '../pages/LongTextPage';
import { TurnSharePage } from '../pages/TurnSharePage';
import { AddProviderPage } from '../pages/AddProviderPage';
import { AppearancePage } from '../pages/AppearancePage';
import { ApprovalPage } from '../pages/ApprovalPage';
import { BackupPage } from '../pages/BackupPage';
import { BodyPage } from '../pages/BodyPage';
import { BrainSpacePage } from '../pages/BrainSpacePage';
import { CollectionsPage } from '../pages/CollectionsPage';
import { DocumentScanPage } from '../pages/DocumentScanPage';
import { EnvPage } from '../pages/EnvPage';
import { FleetPage } from '../pages/FleetPage';
import { LocalChatPage } from '../pages/LocalChatPage';
import { MailAccountsPage } from '../pages/MailAccountsPage';
import { McpOAuthPage } from '../pages/McpOAuthPage';
import { McpPage } from '../pages/McpPage';
import { MemoryPage } from '../pages/MemoryPage';
import { ModelGroupsPage } from '../pages/ModelGroupsPage';
import { ProviderDetailPage } from '../pages/ProviderDetailPage';
import { ProviderListPage } from '../pages/ProviderListPage';
import { RecordingsPage } from '../pages/RecordingsPage';
import { RelayPage } from '../pages/RelayPage';
import { ReleaseNotesPage } from '../pages/ReleaseNotesPage';
import { RemoteChatPage } from '../pages/RemoteChatPage';
import { RemoteWorkspacePage } from '../pages/RemoteWorkspacePage';
import { RuntimePage } from '../pages/RuntimePage';
import { SSHTerminalPage } from '../pages/SSHTerminalPage';
import { SchedulePage } from '../pages/SchedulePage';
import { ScreenSessionPage } from '../pages/ScreenSessionPage';
import { SettingsPage } from '../pages/SettingsPage';
import { SkillsPage } from '../pages/SkillsPage';
import { SoulPage } from '../pages/SoulPage';
import { SyncPage } from '../pages/SyncPage';
import { SystemIntegrationPage } from '../pages/SystemIntegrationPage';
import { TerminalPage } from '../pages/TerminalPage';
import { UsagePage } from '../pages/UsagePage';
import { WebPage } from '../pages/WebPage';
import { WorkspacePage } from '../pages/WorkspacePage';

@Builder
export function destination(name: string) {
  if (name === 'pages/LongTextPage') { LongTextPage() }
  else if (name === 'pages/TurnSharePage') { TurnSharePage() }
  else
  if (name === 'pages/AddProviderPage') { AddProviderPage() }
  else if (name === 'pages/AppearancePage') { AppearancePage() }
  else if (name === 'pages/ApprovalPage') { ApprovalPage() }
  else if (name === 'pages/BackupPage') { BackupPage() }
  else if (name === 'pages/BodyPage') { BodyPage() }
  else if (name === 'pages/BrainSpacePage') { BrainSpacePage() }
  else if (name === 'pages/CollectionsPage') { CollectionsPage() }
  else if (name === 'pages/DocumentScanPage') { DocumentScanPage() }
  else if (name === 'pages/EnvPage') { EnvPage() }
  else if (name === 'pages/FleetPage') { FleetPage() }
  else if (name === 'pages/LocalChatPage') { LocalChatPage() }
  else if (name === 'pages/MailAccountsPage') { MailAccountsPage() }
  else if (name === 'pages/McpOAuthPage') { McpOAuthPage() }
  else if (name === 'pages/McpPage') { McpPage() }
  else if (name === 'pages/MemoryPage') { MemoryPage() }
  else if (name === 'pages/ModelGroupsPage') { ModelGroupsPage() }
  else if (name === 'pages/ProviderDetailPage') { ProviderDetailPage() }
  else if (name === 'pages/ProviderListPage') { ProviderListPage() }
  else if (name === 'pages/RecordingsPage') { RecordingsPage() }
  else if (name === 'pages/RelayPage') { RelayPage() }
  else if (name === 'pages/ReleaseNotesPage') { ReleaseNotesPage() }
  else if (name === 'pages/RemoteChatPage') { RemoteChatPage() }
  else if (name === 'pages/RemoteWorkspacePage') { RemoteWorkspacePage() }
  else if (name === 'pages/RuntimePage') { RuntimePage() }
  else if (name === 'pages/SSHTerminalPage') { SSHTerminalPage() }
  else if (name === 'pages/SchedulePage') { SchedulePage() }
  else if (name === 'pages/ScreenSessionPage') { ScreenSessionPage() }
  else if (name === 'pages/SettingsPage') { SettingsPage() }
  else if (name === 'pages/SkillsPage') { SkillsPage() }
  else if (name === 'pages/SoulPage') { SoulPage() }
  else if (name === 'pages/SyncPage') { SyncPage() }
  else if (name === 'pages/SystemIntegrationPage') { SystemIntegrationPage() }
  else if (name === 'pages/TerminalPage') { TerminalPage() }
  else if (name === 'pages/UsagePage') { UsagePage() }
  else if (name === 'pages/WebPage') { WebPage() }
  else if (name === 'pages/WorkspacePage') { WorkspacePage() }
}
