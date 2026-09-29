import { CoreState, type CoreStateOptions } from "./state.js";
import { RestartBudget } from "./supervision.js";

export type CoreMode = "NORMAL" | "DEGRADED" | "RECOVERY" | "LOCKED";
export interface ProtectionAssessment {
  verified: boolean;
  /** A safe code, not raw credentials, ACL dumps, or workspace paths. */
  code: string;
}
export interface CoreRuntimeOptions extends CoreStateOptions {
  recoveryMode?: boolean;
  /** Host-specific verifier must check ACL / identity / writable-root exclusions.
   * Directory naming is NOT OS isolation. Missing verifier leaves mutations locked. */
  verifyProtection?: (stateDir: string) => Promise<ProtectionAssessment>;
  /** Trusted IPC connector only; untrusted plugin initialization belongs in another process. */
  connectOptional?: (signal: AbortSignal) => Promise<void>;
  optionalTimeoutMs?: number;
}

export class CoreRuntime {
  readonly state: CoreState;
  readonly supervision: RestartBudget;
  readonly optionalSettled: Promise<void>;
  private readonly optionalAbort = new AbortController();
  private connectionState: "disconnected" | "connected" = "disconnected";
  private optionalHealth: "disabled" | "starting" | "healthy" | "failed";
  private protection: ProtectionAssessment = { verified: false, code: "PROTECTION_NOT_ATTESTED" };
  private stopped = false;

  private constructor(state: CoreState, private readonly options: CoreRuntimeOptions, protection: ProtectionAssessment) {
    this.state = state;
    this.protection = protection;
    this.supervision = new RestartBudget({ initial: state.get("supervision:core") });
    this.optionalHealth = options.recoveryMode || !options.connectOptional ? "disabled" : "starting";
    this.optionalSettled = this.connectOptional();
  }

  static async start(options: CoreRuntimeOptions): Promise<CoreRuntime> {
    if (options.optionalTimeoutMs !== undefined && (!Number.isFinite(options.optionalTimeoutMs) || options.optionalTimeoutMs <= 0 || options.optionalTimeoutMs > 120_000)) throw new Error("INVALID_OPTIONAL_TIMEOUT");
    const state = CoreState.open(options);
    let protection: ProtectionAssessment = { verified: false, code: "PROTECTION_NOT_ATTESTED" };
    let timeout: ReturnType<typeof setTimeout> | undefined;
    try {
      if (options.verifyProtection) {
        protection = await Promise.race([
          options.verifyProtection(state.stateDir),
          new Promise<never>((_, reject) => { timeout = setTimeout(() => reject(new Error("PROTECTION_TIMEOUT")), 5_000); }),
        ]);
        if (typeof protection.verified !== "boolean" || !/^[A-Z0-9_]{1,96}$/.test(protection.code)) protection = { verified: false, code: "INVALID_PROTECTION_ASSESSMENT" };
      }
    } catch { protection = { verified: false, code: "PROTECTION_VERIFICATION_FAILED" }; }
    finally { if (timeout) clearTimeout(timeout); }
    try { return new CoreRuntime(state, options, protection); }
    catch (error) { state.close(); throw error; }
  }

  private async connectOptional(): Promise<void> {
    if (this.optionalHealth === "disabled" || !this.protection.verified) {
      this.optionalHealth = "disabled";
      return;
    }
    let timeout: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([
        Promise.resolve().then(() => this.options.connectOptional!(this.optionalAbort.signal)),
        new Promise<never>((_, reject) => {
          timeout = setTimeout(() => { this.optionalAbort.abort(); reject(new Error("OPTIONAL_TIMEOUT")); }, this.options.optionalTimeoutMs ?? 5_000);
        }),
      ]);
      if (!this.stopped && !this.optionalAbort.signal.aborted) this.optionalHealth = "healthy";
    } catch { if (!this.stopped) this.optionalHealth = "failed"; }
    finally { if (timeout) clearTimeout(timeout); }
  }

  setConnectionState(state: "disconnected" | "connected"): void { this.connectionState = state; }

  status() {
    const storageHealth = this.state.probe() ? "healthy" : "unavailable";
    const mode: CoreMode = !this.protection.verified || storageHealth !== "healthy" ? "LOCKED"
      : this.options.recoveryMode ? "RECOVERY"
      : ["starting", "failed"].includes(this.optionalHealth) ? "DEGRADED" : "NORMAL";
    return {
      schemaVersion: "p05.core.v1",
      ...this.state.identity,
      liveness: !this.stopped,
      readiness: {
        diagnostics: !this.stopped,
        recovery: !this.stopped && mode !== "LOCKED",
        mutations: !this.stopped && (mode === "NORMAL" || mode === "DEGRADED"),
        optional: !this.stopped && this.optionalHealth === "healthy",
      },
      mode,
      connectionState: this.connectionState,
      optionalHealth: this.optionalHealth,
      storageHealth,
      protection: { ...this.protection },
      securityMode: "trusted-host" as const,
      isolationVerified: false,
      trustLimitations: [
        "Protected state verification is independent of execution isolation; this runtime does not provide an OS execution sandbox.",
        "Same-OS-principal processes are inside the trusted-host boundary.",
        "Mutation readiness never replaces per-operation authorization and approval.",
      ],
      supervision: this.supervision.snapshot(),
    };
  }

  /** Called by the owner of a supervised process, not by client-supplied PID. */
  recordOwnedCrash(): void { this.state.put("supervision:core", this.supervision.recordCrash()); }

  close(): void {
    if (this.stopped) return;
    this.stopped = true;
    this.optionalAbort.abort();
    this.state.close();
  }
}
