import type {
  PaperclipAgent,
  PaperclipBinding,
  PaperclipCommand,
  PaperclipCompany,
  PaperclipIssue,
  PaperclipPersistence,
  PaperclipProfile,
  PaperclipReceipt,
  PaperclipSnapshot,
  PaperclipTransport,
} from "./contract.js";
import {
  canonicalPaperclipServer,
  PaperclipFailure,
  request,
  rows,
  session,
  signInToPaperclip,
  verifyPaperclipUser,
} from "./protocol.js";
import {
  emptyPaperclipSnapshot,
  paperclipFailureState,
  validatePaperclipCommand,
  paperclipReconciliationState,
} from "./commands.js";
import { readBoundLog, readBoundDocument, downloadBoundAttachment } from "./reads.js";
import { readDetail, reconcileMutation, sendMutation } from "./api.js";
import {
  restorePaperclipWorkspace,
  findPaperclipReceipt as pendingReceipt,
  saveProfile,
  saveReceipts,
  recordMutationFailure,
} from "./persistence.js";
export class PaperclipWorkspaceService {
  private state = emptyPaperclipSnapshot();
  private listeners = new Set<() => void>();
  private generation = 0;
  private detailGeneration = 0;
  private refreshGeneration = 0;
  private logGeneration = 0;
  private receipts: PaperclipReceipt[] = [];
  private storageBlocked = false;
  private mutationInFlight = false;
  constructor(
    private transport: PaperclipTransport,
    private storage: PaperclipPersistence,
    private uuid = () => globalThis.crypto.randomUUID(),
  ) {
    const restored = restorePaperclipWorkspace(storage);
    this.state = restored.state;
    this.receipts = restored.receipts;
    this.storageBlocked = !!restored.state.error;
  }

  getSnapshot = (): PaperclipSnapshot => this.state;
  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };
  private publish(next: Partial<PaperclipSnapshot>) {
    this.state = { ...this.state, ...next };
    for (const listener of this.listeners) listener();
  }
  private receiptFor = (binding: PaperclipBinding | null) => pendingReceipt(this.receipts, binding);

  private fail = (error: unknown) => this.publish(paperclipFailureState(error));
  async configure(profile: PaperclipProfile): Promise<boolean> {
    try {
      const normalized = {
        serverUrl: canonicalPaperclipServer(profile.serverUrl),
        name: profile.name.trim() || "我的服务器",
      };
      saveProfile(this.storage, normalized);
      this.generation++;
      this.detailGeneration++;
      this.logGeneration++;
      this.publish({ ...emptyPaperclipSnapshot(), profile: normalized, connection: "signed-out" });
      await this.refresh();
      return true;
    } catch (error) {
      this.fail(error);
      return false;
    }
  }
  async signIn(): Promise<void> {
    const profile = this.state.profile;
    if (!profile || this.state.busy) return;
    const generation = this.generation;
    const current = () => generation === this.generation;
    this.publish({ busy: true, error: null });
    try {
      const result = await signInToPaperclip(this.transport, profile.serverUrl, current);
      if (!current()) return;
      if (!result.completed) this.publish({ notice: "登录已取消，可以稍后继续" });
      else await this.refresh();
    } catch (error) {
      if (current()) this.fail(error);
    } finally {
      if (current()) this.publish({ busy: false });
    }
  }
  async signOut(): Promise<void> {
    if (!this.state.profile || this.mutationInFlight) return;
    const profile = this.state.profile;
    this.generation++;
    this.detailGeneration++;
    this.logGeneration++;
    const generation = this.generation;
    this.publish({ ...emptyPaperclipSnapshot(), profile, connection: "signed-out", busy: true });
    try {
      await this.transport.signOut({ serverUrl: profile.serverUrl });
    } catch {
      if (generation === this.generation)
        this.fail(new Error("服务器退出未确认。请重新连接后核对登录状态"));
    } finally {
      if (generation === this.generation) this.publish({ busy: false });
    }
  }
  async selectCompany(companyId: string): Promise<void> {
    const { profile, user, companies } = this.state;
    if (!profile || !user || !companies.some((c) => c.id === companyId)) return;
    this.generation++;
    this.detailGeneration++;
    this.logGeneration++;
    const binding = { serverUrl: profile.serverUrl, companyId, userId: user.id };
    this.publish({
      binding,
      agents: [],
      issues: [],
      detail: null,
      log: null,
      receipt: this.receiptFor(binding),
      confirmedReply: null,
      error: null,
      notice: null,
      connection: "connecting",
      busy: false,
    });
    await this.refresh();
  }
  async refresh(): Promise<void> {
    const profile = this.state.profile;
    if (!profile) return;
    const generation = this.generation;
    const refresh = ++this.refreshGeneration;
    const current = () => generation === this.generation && refresh === this.refreshGeneration;
    try {
      const user = await session(this.transport, profile.serverUrl);
      const companies = rows<PaperclipCompany>(
        await request(this.transport, profile.serverUrl, "GET", "/companies?scope=accessible"),
        ["id", "name"],
      );
      if (!current()) return;
      if (this.state.binding && this.state.binding.userId !== user.id) {
        this.generation++;
        this.detailGeneration++;
        this.logGeneration++;
        this.publish({
          ...emptyPaperclipSnapshot(),
          profile,
          user,
          companies,
          connection: "online",
          notice: "登录账号已变化，请重新选择组织；之前的操作仍绑定原账号",
        });
        return;
      }
      let binding = this.state.binding;
      if (binding && !companies.some((c) => c.id === binding!.companyId)) {
        this.publish({
          binding: null,
          detail: null,
          issues: [],
          agents: [],
          log: null,
          receipt: null,
        });
        binding = null;
      }
      this.publish({ user, companies, connection: "online", error: null });
      if (!binding) return;
      const [issues, agents] = await Promise.all([
        request(
          this.transport,
          profile.serverUrl,
          "GET",
          `/companies/${encodeURIComponent(binding.companyId)}/issues?limit=100&sortField=updated&sortDir=desc`,
        ),
        request(
          this.transport,
          profile.serverUrl,
          "GET",
          `/companies/${encodeURIComponent(binding.companyId)}/agents`,
        ),
      ]);
      if (!current()) return;
      this.publish({
        issues: rows<PaperclipIssue>(issues, ["id", "companyId", "title", "status"], binding),
        agents: rows<PaperclipAgent>(agents, ["id", "companyId", "name", "status"], binding),
        updatedAt: new Date().toISOString(),
        receipt: this.receiptFor(binding),
      });
      if (this.state.detail) await this.selectIssue(this.state.detail.issue.id, true);
    } catch (error) {
      if (current()) {
        this.publish({
          connection:
            error instanceof PaperclipFailure && error.status === 401 ? "signed-out" : "offline",
        });
        this.fail(error);
      }
    }
  }
  async selectIssue(issueId: string, preserve = false): Promise<void> {
    const binding = this.state.binding;
    if (!binding) return;
    const generation = this.generation;
    const detailGeneration = ++this.detailGeneration;
    if (!preserve) {
      this.logGeneration++;
      this.publish({ detail: null, log: null, error: null });
    }
    try {
      const detail = await readDetail(this.transport, binding, issueId);
      if (generation === this.generation && detailGeneration === this.detailGeneration)
        this.publish({ detail });
    } catch (error) {
      if (generation === this.generation && detailGeneration === this.detailGeneration)
        this.fail(error);
    }
  }
  async mutate(command: PaperclipCommand): Promise<boolean> {
    const binding = this.state.binding;
    if (
      !binding ||
      this.state.connection !== "online" ||
      this.mutationInFlight ||
      this.receiptFor(binding) ||
      this.storageBlocked
    )
      return false;
    const generation = this.generation;
    this.mutationInFlight = true;
    this.publish({ busy: true, error: null, notice: null });
    let receipt: PaperclipReceipt | null = null;
    try {
      command = validatePaperclipCommand(this.state, command);
      await verifyPaperclipUser(this.transport, binding);
      if (generation !== this.generation) return false;
      receipt = {
        id: this.uuid(),
        binding: { ...binding },
        command: { ...command },
        createdAt: new Date().toISOString(),
        state: "sending",
      };
      saveReceipts(this.storage, [...this.receipts, receipt]);
      this.receipts.push(receipt);
      this.publish({ receipt });
      const issueId = await sendMutation(this.transport, receipt);
      if (command.kind === "cancel") await reconcileMutation(this.transport, receipt);
      this.complete(receipt);
      if (generation === this.generation) {
        this.publish({ notice: "服务器已确认操作", receipt: null });
        await this.refresh();
        if (issueId) await this.selectIssue(issueId);
      }
      return generation === this.generation;
    } catch (error) {
      this.mutationFailure(receipt, error, generation);
      return false;
    } finally {
      this.mutationInFlight = false;
      if (generation === this.generation) this.publish({ busy: false });
    }
  }
  private complete(receipt: PaperclipReceipt) {
    const next = this.receipts.filter((r) => r.id !== receipt.id);
    saveReceipts(this.storage, next);
    this.receipts = next;
  }
  private mutationFailure(
    receipt: PaperclipReceipt | null,
    error: unknown,
    generation: number,
    retainReceipt = false,
  ) {
    if (receipt) {
      try {
        this.receipts = recordMutationFailure(
          this.storage,
          this.receipts,
          receipt,
          error,
          retainReceipt,
        );
      } catch {
        this.storageBlocked = true;
      }
    }
    if (generation === this.generation) {
      this.publish({
        receipt: this.receiptFor(this.state.binding),
        ...(receipt && this.receipts.includes(receipt)
          ? { notice: "结果待核实。请勿重复提交；使用“核实结果”恢复原操作" }
          : {}),
      });
      this.fail(error);
    }
  }
  acknowledgeReceipt(): void {
    const receipt = this.receiptFor(this.state.binding);
    if (!receipt || this.mutationInFlight) return;
    try {
      const next = this.receipts.map((r) =>
        r.id === receipt.id ? { ...r, state: "acknowledged" as const } : r,
      );
      saveReceipts(this.storage, next);
      this.receipts = next;
      this.publish({
        receipt: null,
        error: null,
        notice: "已记录人工核实，解除提交阻塞；原回执保留在本机，不会重新发送",
      });
    } catch (error) {
      this.fail(error);
    }
  }
  async reconcile(): Promise<void> {
    const receipt = this.receiptFor(this.state.binding);
    if (!receipt || this.mutationInFlight) return;
    const generation = this.generation;
    this.mutationInFlight = true;
    this.publish({ busy: true, error: null });
    try {
      await verifyPaperclipUser(this.transport, receipt.binding);
      if (generation !== this.generation) return;
      const issueId = await reconcileMutation(this.transport, receipt);
      this.complete(receipt);
      if (generation === this.generation) {
        this.publish(paperclipReconciliationState(receipt));
        await this.refresh();
        if (issueId) await this.selectIssue(issueId);
      }
    } catch (error) {
      this.mutationFailure(receipt, error, generation, true);
    } finally {
      this.mutationInFlight = false;
      if (generation === this.generation) this.publish({ busy: false });
    }
  }
  async loadLog(runId: string): Promise<void> {
    const binding = this.state.binding;
    if (!binding || !this.state.detail?.runs.some((r) => r.id === runId)) return;
    const generation = this.generation;
    const detail = this.detailGeneration;
    const logGeneration = ++this.logGeneration;
    const previous = this.state.log?.runId === runId ? this.state.log : null;
    try {
      const log = await readBoundLog(this.transport, binding, runId, previous);
      if (
        generation === this.generation &&
        detail === this.detailGeneration &&
        logGeneration === this.logGeneration
      )
        this.publish({ log });
    } catch (error) {
      if (generation === this.generation && logGeneration === this.logGeneration) this.fail(error);
    }
  }
  async readDocument(key: string): Promise<string | null> {
    const binding = this.state.binding;
    const issueId = this.state.detail?.issue.id;
    if (!binding || !issueId || !this.state.detail?.documents.some((d) => d.key === key))
      return null;
    const generation = this.generation;
    const detailGeneration = this.detailGeneration;
    try {
      const body = await readBoundDocument(this.transport, binding, issueId, key);
      return generation === this.generation && detailGeneration === this.detailGeneration
        ? body
        : null;
    } catch (error) {
      if (generation === this.generation) this.fail(error);
      return null;
    }
  }
  async download(attachmentId: string): Promise<void> {
    const binding = this.state.binding;
    const attachment = this.state.detail?.attachments.find((a) => a.id === attachmentId);
    if (!binding || !attachment) return;
    try {
      await verifyPaperclipUser(this.transport, binding);
      await downloadBoundAttachment(this.transport, binding, attachment);
    } catch (error) {
      this.fail(error);
    }
  }
}
