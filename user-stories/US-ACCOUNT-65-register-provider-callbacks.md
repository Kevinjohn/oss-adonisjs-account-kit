# US-ACCOUNT-65 — Register configuration callbacks from a provider

As an application integrator, I want to register callbacks from an application provider so that my config files can hold options without importing application services.

**Status:** Current with the provider for the service being configured
**Access:** Application boot code, before the target registry first resolves (service startup or Account Kit diagnostics). The admission registry requires the optional admission provider.
**Entry:** In the application provider's `boot()`, resolve `account_kit.callbacks` or `account_admission.callbacks` and call `register(factory)`.
**Documentation:** [Registering callbacks from a provider](../README.md#registering-callbacks-from-a-provider)
**Source:** [Account Kit registry](../src/account_kit_callback_registry.ts), [admission registry](../src/admission/callback_registry.ts)
**Coverage:** [Registry and service resolution tests](../tests/callback_registry.spec.ts)

## Acceptance criteria

- Register one factory per registry. It can return the callback object directly or through a promise. The factory is resolved lazily and the registry caches the result. Resolving Account Kit or running `account-kit:doctor` can trigger Account Kit config resolution.
- The [supported callback keys](../README.md#registering-callbacks-from-a-provider) may be supplied inline or by the registry. Defining the same field in both places fails with `E_ACCOUNT_KIT_INVALID_CONFIGURATION` during resolution. A second registration or a registration after resolution starts fails when called.
- The Account Kit and admission `defineConfig` helpers check inline options first. Service resolution checks the final required callbacks, including the `users` adapter, invitation callbacks for enabled invitations and `approval.authorize` for enabled approval. The admission registry can supply the authoriser but enabling approval remains a config choice. An inline-only configuration still works with an empty registry.
- The Account Kit config provider merges registered callbacks during resolution. Admission merges them when the config was built by its `defineConfig`. A missing Account Kit config returns before its registry resolves.
- The factory runs while the package service is being built, so application services that depend on `AccountKit` or `AccountAdmission` are resolved inside the callbacks, not in the factory body.

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
    B -->|Yes| X["Throw E_ACCOUNT_KIT_INVALID_CONFIGURATION"]
    B -->|No| C["Store factory for lazy resolution"]
    C --> D{"Which entry resolves the configuration?"}
    D -->|Account Kit service or doctor| E["resolveAccountKitConfig reads supplied config"]
    D -->|Admission| F["AdmissionProvider resolves AccountKit and admission config, then admission factory"]
    E -->|Missing config| M["Return undefined; service refuses or doctor reports missing config"]
    E -->|Resolution fails| I["Reject configuration resolution"]
    F -->|Resolution fails| I
    E -->|Present| Q{"Account config made by defineConfig?"}
    Q -->|No| R["Use supplied config without merging callbacks"]
    Q -->|Yes| G["resolveRegisteredCallbacks resolves factory and validates merged config"]
    G -->|Failure| I
    G -->|Success| J{"Caller?"}
    R --> J
    F -->|Factory resolves| T{"Admission config made by defineConfig?"}
    T -->|No| U["Use supplied config without merging callbacks"]
    T -->|Yes| V["resolveAdmissionConfig merges callbacks and validates"]
    U --> H
    V -->|Failure| I
    V -->|Success| H
    J -->|Service provider| H["Construct service with resolved configuration"]
    J -->|Doctor| K["AccountKitDoctor passes merged config to runDoctor"]
```

For the diagnostic checks after config resolution, see [US-ACCOUNT-32](US-ACCOUNT-32-diagnose-account-kit.md).

**Code references:** [CallbackRegistry](../src/callback_registry.ts), [Account Kit provider](../providers/account_kit_provider.ts), [doctor command](../commands/doctor.ts), [resolveAccountKitConfig](../src/config_resolution.ts), [resolveConfig](../src/config.ts), [admission provider](../providers/account_admission_provider.ts), [resolveAdmissionConfig](../src/admission/config.ts)
