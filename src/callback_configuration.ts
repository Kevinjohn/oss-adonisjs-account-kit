// Holds the callbacks an application provider registers, so config files need not import them.
import { E_ACCOUNT_KIT_INVALID_CONFIGURATION } from './errors.ts'

/** A registry for one package service. The service reads it once, when first resolved. */
export class CallbackConfiguration<Callbacks extends object> {
  readonly #service: string
  #factory?: () => Callbacks | Promise<Callbacks>
  #resolved?: Promise<Callbacks | undefined>

  constructor(service: string) {
    this.#service = service
  }

  /**
   * Registers the factory that returns the callbacks. Call it once, from a provider's `boot()`,
   * before the service is first resolved. The factory runs when the service is first built.
   *
   * @example
   * ```ts
   * registry.register(() => callbacks)
   * ```
   */
  register(factory: () => Callbacks | Promise<Callbacks>): void {
    if (this.#resolved)
      throw new E_ACCOUNT_KIT_INVALID_CONFIGURATION(
        'callbacks',
        `account_kit: callbacks must be registered before ${this.#service} is first resolved`
      )
    if (this.#factory)
      throw new E_ACCOUNT_KIT_INVALID_CONFIGURATION(
        'callbacks',
        'account_kit: callbacks are already registered'
      )
    this.#factory = factory
  }

  /**
   * The registered callbacks, built once; undefined when nothing was registered.
   *
   * @internal
   */
  resolve(): Promise<Callbacks | undefined> {
    this.#resolved ??= (async () => this.#factory?.())()
    return this.#resolved
  }
}
