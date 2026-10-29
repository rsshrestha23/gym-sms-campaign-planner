import { randomUUID } from 'node:crypto';
import { ProviderError, SendSmsInput, SendSmsResult, SmsProvider } from './provider';

export type SimulatedBehaviour =
  | { type: 'accept' }
  | { type: 'error'; error: ProviderError }
  /** The provider accepts the message, then the response is lost (timeout). */
  | { type: 'accept_then_timeout' }
  | { type: 'delay'; ms: number; then?: SimulatedBehaviour };

/**
 * In-memory provider that honours idempotency keys exactly like a real provider should: the first
 * accepted request for a key creates a message; any later request with the same key returns that
 * same message id without a second acceptance. Used by tests and the local stack.
 */
export class SimulatedProvider implements SmsProvider {
  readonly name = 'simulated';
  readonly accepted = new Map<string, { providerMessageId: string; to: string; body: string; acceptedAt: Date }>();
  readonly requests: SendSmsInput[] = [];
  private script: SimulatedBehaviour[] = [];

  /** Queue behaviours for the next calls; once exhausted every call is accepted. */
  enqueue(...behaviours: SimulatedBehaviour[]): this {
    this.script.push(...behaviours);
    return this;
  }

  get acceptanceCount(): number {
    return this.accepted.size;
  }

  async send(input: SendSmsInput): Promise<SendSmsResult> {
    this.requests.push(input);
    return this.run(this.script.shift() ?? { type: 'accept' }, input);
  }

  private async run(b: SimulatedBehaviour, input: SendSmsInput): Promise<SendSmsResult> {
    switch (b.type) {
      case 'delay':
        await new Promise((r) => setTimeout(r, b.ms));
        return this.run(b.then ?? { type: 'accept' }, input);
      case 'error':
        throw b.error;
      case 'accept_then_timeout':
        this.accept(input);
        throw new ProviderError('ambiguous', 'TIMEOUT', 'provider outcome unknown (TIMEOUT)');
      default:
        return { providerMessageId: this.accept(input), providerRequestId: randomUUID() };
    }
  }

  private accept(input: SendSmsInput): string {
    const existing = this.accepted.get(input.idempotencyKey);
    if (existing) return existing.providerMessageId;
    const providerMessageId = `sim-${randomUUID()}`;
    this.accepted.set(input.idempotencyKey, { providerMessageId, to: input.to, body: input.body, acceptedAt: new Date() });
    return providerMessageId;
  }
}
