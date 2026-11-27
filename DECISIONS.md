# Decisions

## Departures

1. **Aligning ([conventions #24](https://github.com/Kevinjohn/oss-adonisjs-code-conventions/issues/24))** — IMP-5, NAM-3 and PKG-6. The linked setup generators, consumer renderers, demo overlays and test fixtures contain strings or templates of application source, including the optional Ally configuration. Application aliases are correct there, and each rendered module holds its own class. The checker reads those strings as package imports and class declarations; the package itself does not import Ally.
2. **Aligning ([conventions #25](https://github.com/Kevinjohn/oss-adonisjs-code-conventions/issues/25))** — PKG-1. The `docs` finding is VitePress configuration and theme source in `docs/.vitepress`: documentation tooling, not package implementation.
3. **Aligning ([conventions #26](https://github.com/Kevinjohn/oss-adonisjs-code-conventions/issues/26))** — IMP-5. The VitePress theme imports a Vue single-file component; VitePress requires the `.vue` extension.
4. PKG-23. `src/setup/generated_env_helpers.ts` and `src/setup/session_config.ts` emit environment reads into the application's configuration files. Neither reads the package's process environment. Moving these reads out of their generated config destination would break application configuration ownership. The checker scans source strings as executable code; [conventions #24](https://github.com/Kevinjohn/oss-adonisjs-code-conventions/issues/24) tracks that limitation.
