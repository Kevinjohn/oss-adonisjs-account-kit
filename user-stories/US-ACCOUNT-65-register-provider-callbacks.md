# US-ACCOUNT-65 — Register configuration callbacks from a provider

As an application integrator, I want to register callbacks from an application provider so that my config files can hold options without importing application services.

**Status:** Current with the provider for the service being configured
**Access:** Application boot code, before the target registry first resolves (service startup or Account Kit diagnostics). The admission registry requires the optional admission provider.
**Entry:** In the application provider's `boot()`, resolve `account_kit.callbacks` or `account_admission.callbacks` and call `register(factory)`.
**Documentation:** [Registering callbacks from a provider](../README.md#registering-callbacks-from-a-provider)
**Source:** [Account Kit registry](../src/callback_registry.ts), [admission registry](../src/admission/callback_registry.ts)
**Coverage:** [Registry and service resolution tests](../tests/callback_registry.spec.ts)

## Acceptance criteria

- Register one factory per registry. It can return the callback object directly or through a promise. The factory is resolved lazily and the registry caches the result. Resolving Account Kit or running `account-kit:doctor` can trigger Account Kit config resolution.
- The [supported callback keys](../README.md#registering-callbacks-from-a-provider) may be supplied inline or by the registry. Defining the same field in both places fails with `InvalidConfigurationError` during resolution. A second registration or a registration after resolution starts fails when called.
- `defineConfig` and `defineAdmission` check inline options first. Service resolution checks the final required callbacks, including the `users` adapter, invitation callbacks for enabled invitations and `approval.authorize` for enabled approval. The admission registry can supply the authoriser but enabling approval remains a config choice. An inline-only configuration still works with an empty registry.

## User flow

```mermaid
flowchart TD
    A["Choose which callbacks to move out of the configuration file"] --> B["Register their factory in the application's provider"]
    B --> C{"Registration accepted before the registry first resolves?"}
    C -->|No| D["Correct provider boot order or remove duplicate registration"]
    C -->|Yes| E["Resolve the service or run the Account Kit diagnostic"]
    E --> F{"Do the resolved callbacks and options pass validation?"}
    F -->|No| G["Correct the configuration or factory"]
    F -->|Yes| H["Use the service or inspect the diagnostic results"]
```

## Code flow

```mermaid
flowchart TD
    A["Host provider boot calls CallbackRegistry.register(factory)"] --> B{"Factory already registered or resolution started?"}
    B -->|Yes| X["Throw InvalidConfigurationError"]
    B -->|No| C["Store factory for lazy resolution"]
    C --> D{"Which entry resolves the configuration?"}
    D -->|Account Kit service or doctor| E["resolveAccountKitConfig resolves factory, merges fields and calls resolveConfig"]
    D -->|Admission| F["AdmissionProvider resolves AccountKit, then resolves admission factory and calls resolveAdmissionConfig"]
    E --> G{"Factory and merged configuration succeed?"}
    F --> G
    G -->|No| I["Reject configuration resolution"]
    G -->|Yes| J{"Caller?"}
    J -->|Service provider| H["Construct service with resolved configuration"]
    J -->|Doctor| K["AccountKitDoctor passes merged config to runDoctor"]
```

For the diagnostic checks after config resolution, see [US-ACCOUNT-32](US-ACCOUNT-32-diagnose-account-kit.md).

**Code references:** [CallbackRegistry](../src/callback_registry.ts), [Account Kit provider](../providers/account_kit_provider.ts), [doctor command](../commands/doctor.ts), [resolveAccountKitConfig](../src/config_resolution.ts), [resolveConfig](../src/config.ts), [admission provider](../src/admission/provider.ts), [resolveAdmissionConfig](../src/admission/config.ts)
