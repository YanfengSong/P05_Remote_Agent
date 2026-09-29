import { RestartBudget, type SupervisionSnapshot } from "./supervision.js";

export type ServiceObserved = "stopped" | "running" | "starting" | "stopping" | "failed" | "unknown";
export interface ServiceDescriptor {
  serviceId: string;
  version: string;
  scope: "host" | "slot";
  ownerId: string;
  dependencies: string[];
}
export interface ServiceDesired {
  revision: number;
  state: "running" | "stopped";
  manualHold: boolean;
}
export interface ServiceObservation { state: ServiceObserved; healthy: boolean }
export interface ManagedServiceAdapter {
  /** Must inspect authenticated owned process identity, never guess by process name. */
  observe(): Promise<ServiceObservation>;
  start(): Promise<void>;
  stop(): Promise<void>;
}
export interface ManagedServiceStore {
  get<T>(key: string): T | undefined;
  put(key: string, value: unknown): void;
}
interface ServiceRecord {
  definition: string;
  desired: ServiceDesired;
  observation: ServiceObservation;
  supervision: SupervisionSnapshot;
  diagnostic: string | null;
  /** Tracks unexpected loss once; stopped observations must not consume budget repeatedly. */
  expectedRunning: boolean;
}

/** One owner per controller; a host controller must use host-owned storage, not a Slot replica.
 * All effects and desired changes are serialized. Calling reconcile again retries safe convergence,
 * never an uncertain start: unknown observations require explicit adapter reconciliation first. */
export class ManagedServiceController {
  private readonly registrations = new Map<string, { descriptor: ServiceDescriptor; adapter: ManagedServiceAdapter }>();
  private pending: Promise<unknown> = Promise.resolve();

  constructor(private readonly store: ManagedServiceStore,
    private readonly owner: { scope: "host" | "slot"; ownerId: string },
    private readonly clock: { now?: () => number; random?: () => number } = {}) {}

  register(descriptor: ServiceDescriptor, adapter: ManagedServiceAdapter): void {
    if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,95}$/.test(descriptor.serviceId) || !descriptor.version) throw new Error("INVALID_SERVICE_DESCRIPTOR");
    if (descriptor.scope !== this.owner.scope || descriptor.ownerId !== this.owner.ownerId) throw new Error("SERVICE_OWNER_MISMATCH");
    if (this.registrations.has(descriptor.serviceId)) throw new Error("DUPLICATE_SERVICE");
    if (descriptor.dependencies.includes(descriptor.serviceId) || new Set(descriptor.dependencies).size !== descriptor.dependencies.length) throw new Error("INVALID_SERVICE_DEPENDENCIES");
    // Requiring predecessors to be registered makes cycles impossible and ordering explicit.
    if (descriptor.dependencies.some((id) => !this.registrations.has(id))) throw new Error("UNREGISTERED_SERVICE_DEPENDENCY");
    const definition = JSON.stringify({ serviceId: descriptor.serviceId, version: descriptor.version, scope: descriptor.scope, ownerId: descriptor.ownerId, dependencies: [...descriptor.dependencies].sort() });
    const stored = this.store.get<ServiceRecord>(`service:${descriptor.serviceId}`);
    if (stored && stored.definition !== definition) throw new Error("SERVICE_DEFINITION_CHANGED_REQUIRES_MIGRATION");
    if (!stored) {
      this.store.put(`service:${descriptor.serviceId}`, {
        definition,
        desired: { revision: 1, state: "stopped", manualHold: false },
        observation: { state: "unknown", healthy: false },
        supervision: new RestartBudget(this.clock).snapshot(), diagnostic: null, expectedRunning: false,
      } satisfies ServiceRecord);
    }
    this.registrations.set(descriptor.serviceId, { descriptor: structuredClone(descriptor), adapter });
  }

  describe(serviceId: string) {
    const registration = this.registration(serviceId);
    return { descriptor: structuredClone(registration.descriptor), ...this.record(serviceId) };
  }

  list() { return [...this.registrations.keys()].map((id) => this.describe(id)); }

  private registration(serviceId: string) {
    const registration = this.registrations.get(serviceId);
    if (!registration) throw new Error("UNKNOWN_SERVICE");
    return registration;
  }

  private record(serviceId: string): ServiceRecord {
    this.registration(serviceId);
    const record = this.store.get<ServiceRecord>(`service:${serviceId}`);
    if (!record) throw new Error("MISSING_SERVICE_STATE");
    return structuredClone(record);
  }

  private serialize<T>(work: () => Promise<T>): Promise<T> {
    const result = this.pending.then(work);
    this.pending = result.catch(() => undefined);
    return result;
  }

  /** Mutation caller must already be authenticated/authorized by the Core boundary. */
  setDesired(serviceId: string, update: { state: "running" | "stopped"; manualHold: boolean }, expectedRevision: number) {
    return this.serialize(async () => {
      const record = this.record(serviceId);
      if (record.desired.revision !== expectedRevision) throw new Error("STALE_SERVICE_REVISION");
      if (!["running", "stopped"].includes(update.state) || typeof update.manualHold !== "boolean") throw new Error("INVALID_SERVICE_DESIRED");
      record.desired = { ...update, revision: expectedRevision + 1 };
      this.store.put(`service:${serviceId}`, record);
      return structuredClone(record.desired);
    });
  }

  resetCrashBudget(serviceId: string, expectedRevision: number) {
    return this.serialize(async () => {
      const record = this.record(serviceId);
      if (record.desired.revision !== expectedRevision) throw new Error("STALE_SERVICE_REVISION");
      record.supervision = new RestartBudget(this.clock).snapshot();
      record.desired.revision++;
      this.store.put(`service:${serviceId}`, record);
      return record.desired.revision;
    });
  }

  reconcile(serviceId: string) {
    return this.serialize(async () => {
      const { descriptor, adapter } = this.registration(serviceId);
      const record = this.record(serviceId);
      const budget = new RestartBudget({ ...this.clock, initial: record.supervision });
      try {
        record.observation = await adapter.observe();
        const shouldRun = record.desired.state === "running" && !record.desired.manualHold;
        if (record.observation.state === "unknown") {
          record.diagnostic = "OUTCOME_UNKNOWN_REQUIRES_RECONCILIATION";
        } else if (!shouldRun) {
          if (["running", "starting"].includes(record.observation.state)) {
            // Persist intent before external effect; after a crash the next observe is authoritative.
            record.expectedRunning = false;
            this.store.put(`service:${serviceId}`, record);
            await adapter.stop();
            record.observation = await adapter.observe();
          }
          record.expectedRunning = false;
          record.diagnostic = record.desired.manualHold ? "MANUAL_HOLD" : null;
        } else if (record.observation.state === "running") {
          budget.heartbeat();
          record.expectedRunning = true;
          record.diagnostic = record.observation.healthy ? null : "UNHEALTHY";
        } else if (["stopped", "failed"].includes(record.observation.state)) {
          if (record.expectedRunning) { budget.recordCrash(); record.expectedRunning = false; }
          const dependenciesHealthy = (await Promise.all(descriptor.dependencies.map(async (id) => {
            const dependency = await this.registration(id).adapter.observe();
            return dependency.state === "running" && dependency.healthy;
          }))).every(Boolean);
          if (!dependenciesHealthy) record.diagnostic = "WAITING_DEPENDENCY";
          else if (!budget.canRestart()) record.diagnostic = budget.snapshot().state === "crash_loop" ? "CRASH_LOOP" : "RESTART_BACKOFF";
          else {
            record.expectedRunning = true;
            record.observation = { state: "starting", healthy: false };
            record.supervision = budget.snapshot();
            this.store.put(`service:${serviceId}`, record);
            await adapter.start();
            record.observation = await adapter.observe();
            record.diagnostic = record.observation.state === "running" && record.observation.healthy ? null : "START_NOT_READY";
          }
        }
      } catch {
        // Start/stop may have happened before the exception. Never infer stopped or replay here.
        record.observation = { state: "unknown", healthy: false };
        record.diagnostic = "ADAPTER_FAILED_RECONCILE_REQUIRED";
      }
      record.supervision = budget.snapshot();
      this.store.put(`service:${serviceId}`, record);
      return this.describe(serviceId);
    });
  }
}
