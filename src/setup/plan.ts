import { lstat, readFile } from 'node:fs/promises'
import { safeSetupPath } from './safe_path.js'
import { migrationNames } from '../../configure.js'
import type { SetupChoices, SetupFileChange, SetupInspection, SetupPlan } from './types.js'
import { parseSetupChoices } from './parse.js'
import {
  defaultImportName,
  exactCall,
  hasUnsafeBindingReferences,
  importedName,
  isTypeOnlyReference,
  parseSetupSource,
  unwrapStaticExpression,
  walk,
  type SetupSource,
} from './ts_source.js'
import type * as TypeScript from 'typescript'
import { hasEmailFlow, selectedManagedRoutes, diagnostic } from './shared.js'
import { validate } from './validate.js'
import { generatedEnv, migrationContent, addChange, ownedChange, changedFields } from './changes.js'
import {
  disabledManagedRoutesSource,
  selectedRouteSource,
  retainedGeneratedChoices,
  allyConfigSource,
  managedGuardSource,
  managedAccessMiddlewareSource,
  proofHeadersMiddlewareSource,
  accountConfigSource,
} from './generated_sources.js'
import {
  planRouteImport,
  directClassBaseHeritage,
  planArrayImports,
  planRouterMiddleware,
  planServerProofMiddleware,
} from './source_edits.js'
import {
  shieldCsrfState,
  mailerSelectionState,
  limiterConfigurationState,
} from './config_inspection.js'
import {
  type NativeSessionConfiguration,
  nativeSessionConfiguration,
  selectedSessionDiagnostic,
  unwrapManagedSessionConfig,
  planSessionConfigIntegration,
} from './session_config.js'
import {
  classColumns,
  unsupportedClassRuntime,
  conventionalSetupImport,
} from './model_inspection.js'

export async function planSetup(
  choices: SetupChoices,
  state: SetupInspection,
  options: {
    apply?: boolean
    production?: boolean
    timestamp?: number
    retirementImpact?: SetupPlan['retirementImpact']
    retirementMaintenanceWindow?: boolean
    runtimeInventoryUnavailable?: boolean
  } = {}
): Promise<SetupPlan> {
  choices = parseSetupChoices(choices)
  const diagnostics = validate(choices, state, {
    production: options.production ?? false,
    retirementImpact: options.retirementImpact ?? null,
    retirementMaintenanceWindow: options.retirementMaintenanceWindow ?? false,
    runtimeInventoryUnavailable: options.runtimeInventoryUnavailable ?? false,
  })
  if (
    hasEmailFlow(choices) &&
    choices.mail.integration === 'adonisjs-mail' &&
    state.files['config/mail.ts']
  ) {
    const selection = await mailerSelectionState(
      state.files['config/mail.ts'],
      state.root,
      choices.mail.transportEnv
    )
    if (selection === 'missing')
      diagnostic(
        diagnostics,
        'config/mail.ts',
        'Selected Mail mailer is absent from the configured mailers map'
      )
    else if (selection === 'invalid')
      diagnostic(
        diagnostics,
        'config/mail.ts',
        'Selected Mail mailer must be a callable transport provider'
      )
    else if (selection === 'unsafe')
      diagnostic(
        diagnostics,
        'config/mail.ts',
        'Resolve runtime Mail and environment module provenance before setup'
      )
    else
      diagnostic(
        diagnostics,
        'config/mail.ts',
        selection === 'unresolved'
          ? 'Confirm the selected Mail mailer and its transport configuration manually before readiness'
          : 'Verify the selected Mail transport delivers messages with the deployed configuration before readiness',
        'action'
      )
  }
  if (
    choices.user.adapter === 'lucid' &&
    /^#models\/[A-Za-z_][A-Za-z0-9_/]*$/.test(choices.user.model) &&
    !choices.user.model.includes('//')
  ) {
    const modelPath = `app/models/${choices.user.model.slice('#models/'.length)}.ts`
    try {
      if (
        !(await conventionalSetupImport(
          state.root,
          choices.user.model,
          '#models/*',
          './app/models/*.js',
          `./${modelPath.slice(0, -3)}.js`
        ))
      )
        diagnostic(
          diagnostics,
          'user.model',
          `Setup cannot resolve ${choices.user.model} to the inspected model`
        )
      const modelFile = await safeSetupPath(state.root, modelPath)
      const modelStat = await lstat(modelFile)
      if (!modelStat.isFile())
        throw new Error(`Setup cannot inspect non-regular model ${modelPath}`)
      const model = await parseSetupSource(await readFile(modelFile, 'utf8'))
      const { ts } = model
      const classes = model.file.statements.filter(
        (node): node is TypeScript.ClassDeclaration =>
          ts.isClassDeclaration(node) &&
          Boolean(
            node.modifiers?.some((modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword)
          ) &&
          Boolean(
            node.modifiers?.some((modifier) => modifier.kind === ts.SyntaxKind.DefaultKeyword)
          )
      )
      const selectedClass = classes.length === 1 ? classes[0] : null
      const baseModelBinding = importedName(model, '@adonisjs/lucid/orm', 'BaseModel')
      const schemaBinding = importedName(model, '#database/schema', 'UserSchema')
      const composeBinding = importedName(model, '@adonisjs/core/helpers', 'compose')
      const authFinderBinding = importedName(model, '@adonisjs/auth/mixins/lucid', 'withAuthFinder')
      const hashBinding = defaultImportName(model, '@adonisjs/core/services/hash')
      const providerBinding = importedName(
        model,
        '@adonisjs/auth/access_tokens',
        'DbAccessTokensProvider'
      )
      if (
        !selectedClass ||
        !selectedClass.heritageClauses?.some(
          (clause) => clause.token === ts.SyntaxKind.ExtendsKeyword
        )
      )
        diagnostic(
          diagnostics,
          'user.model',
          'Selected Lucid model must expose a default model class'
        )
      const staticMember = (name: string) =>
        selectedClass?.members.filter(
          (member) =>
            ts.isPropertyDeclaration(member) &&
            Boolean(
              member.modifiers?.some((modifier) => modifier.kind === ts.SyntaxKind.StaticKeyword)
            ) &&
            (ts.isIdentifier(member.name) || ts.isStringLiteral(member.name)) &&
            member.name.text === name
        ) ?? []
      const metadataNames = ['table', 'connection', 'primaryKey', 'namingStrategy', 'accessTokens']
      const unsafeMetadata =
        selectedClass?.members.some((member) => {
          if (ts.isClassStaticBlockDeclaration(member)) return true
          if (
            !ts.canHaveModifiers(member) ||
            !ts
              .getModifiers(member)
              ?.some((modifier) => modifier.kind === ts.SyntaxKind.StaticKeyword)
          )
            return false
          const name = member.name
          if (!name) return false
          if (ts.isComputedPropertyName(name)) return true
          return (
            !ts.isPropertyDeclaration(member) &&
            (ts.isIdentifier(name) || ts.isStringLiteral(name)) &&
            metadataNames.includes(name.text)
          )
        }) || metadataNames.some((name) => staticMember(name).length > 1)
      let mutatedModel = false
      const nativeProvider = staticMember('accessTokens')[0]
      const nativeProviderCall =
        nativeProvider && ts.isPropertyDeclaration(nativeProvider)
          ? nativeProvider.initializer && unwrapStaticExpression(model, nativeProvider.initializer)
          : undefined
      const supportedTokenProvider = Boolean(
        nativeProviderCall &&
        providerBinding &&
        exactCall(model, nativeProviderCall, providerBinding, 'forModel') &&
        nativeProviderCall.arguments.length === 1 &&
        ts.isIdentifier(nativeProviderCall.arguments[0]) &&
        nativeProviderCall.arguments[0].text === selectedClass?.name?.text &&
        !hasUnsafeBindingReferences(
          model,
          providerBinding,
          (call) =>
            call === nativeProviderCall && exactCall(model, call, providerBinding, 'forModel')
        )
      )
      const safeSelfReference = (node: TypeScript.Identifier) =>
        Boolean(
          node.parent &&
          ts.isCallExpression(node.parent) &&
          node.parent.arguments.length === 1 &&
          node.parent.arguments[0] === node &&
          node.parent === nativeProviderCall &&
          providerBinding &&
          exactCall(model, node.parent, providerBinding, 'forModel') &&
          !hasUnsafeBindingReferences(
            model,
            providerBinding,
            (call) =>
              call === nativeProviderCall && exactCall(model, call, providerBinding, 'forModel')
          )
        )
      if (selectedClass?.name)
        walk(model, (node) => {
          if (
            ts.isIdentifier(node) &&
            node.text === selectedClass.name!.text &&
            node !== selectedClass.name &&
            !isTypeOnlyReference(model, node) &&
            !safeSelfReference(node)
          )
            mutatedModel = true
        })
      if (
        unsafeMetadata ||
        mutatedModel ||
        (selectedClass && unsupportedClassRuntime(model, selectedClass, false))
      )
        diagnostic(
          diagnostics,
          'user.model',
          'Model static metadata or later class references require manual review before generated migrations'
        )
      if (choices.authentication?.strategy === 'access_tokens' && !supportedTokenProvider)
        diagnostic(
          diagnostics,
          'user.model',
          'Token guard model must initialize accessTokens with the supported DbAccessTokensProvider.forModel(User) provider'
        )
      let schemaClass: TypeScript.ClassDeclaration | null = null
      let schemaSource: SetupSource | null = null
      const heritage = selectedClass?.heritageClauses?.find(
        (clause) => clause.token === ts.SyntaxKind.ExtendsKeyword
      )
      const extended = heritage?.types.length === 1 ? heritage.types[0].expression : null
      const composeCall = extended && ts.isCallExpression(extended) ? extended : null
      const finderCall =
        composeCall && ts.isCallExpression(composeCall.arguments[1])
          ? composeCall.arguments[1]
          : null
      const composed =
        composeCall &&
        ts.isIdentifier(composeCall.expression) &&
        composeCall.expression.text === composeBinding &&
        composeCall.arguments.length === 2 &&
        ts.isIdentifier(composeCall.arguments[0]) &&
        composeCall.arguments[0].text === schemaBinding &&
        finderCall &&
        ts.isIdentifier(finderCall.expression) &&
        finderCall.expression.text === authFinderBinding &&
        finderCall.arguments.length === 1 &&
        ts.isIdentifier(finderCall.arguments[0]) &&
        finderCall.arguments[0].text === hashBinding
      const onlyImportedReference = (
        binding: string | null,
        expected: TypeScript.Node | undefined
      ) => {
        if (!binding || !expected) return false
        let safe = true
        walk(model, (node) => {
          if (
            !ts.isIdentifier(node) ||
            node.text !== binding ||
            node === expected ||
            isTypeOnlyReference(model, node)
          )
            return
          if (
            ts.isImportSpecifier(node.parent) &&
            (node.parent.name === node || node.parent.propertyName === node)
          )
            return
          if (ts.isImportClause(node.parent) && node.parent.name === node) return
          if (ts.isPropertyAssignment(node.parent) && node.parent.name === node) return
          if (ts.isPropertyAccessExpression(node.parent) && node.parent.name === node) return
          safe = false
        })
        return safe
      }
      const safeComposition =
        composed &&
        !hasUnsafeBindingReferences(model, composeBinding!, (call) => call === composeCall) &&
        !hasUnsafeBindingReferences(model, authFinderBinding!, (call) => call === finderCall) &&
        onlyImportedReference(schemaBinding, composeCall.arguments[0]) &&
        onlyImportedReference(hashBinding, finderCall.arguments[0])
      const composedBase =
        composeCall &&
        ts.isIdentifier(composeCall.expression) &&
        composeCall.expression.text === composeBinding &&
        composeCall.arguments.length === 2 &&
        ts.isIdentifier(composeCall.arguments[0]) &&
        composeCall.arguments[0].text === baseModelBinding &&
        finderCall &&
        ts.isIdentifier(finderCall.expression) &&
        finderCall.expression.text === authFinderBinding &&
        finderCall.arguments.length === 1 &&
        ts.isIdentifier(finderCall.arguments[0]) &&
        finderCall.arguments[0].text === hashBinding
      const safeBaseComposition =
        composedBase &&
        !hasUnsafeBindingReferences(model, composeBinding!, (call) => call === composeCall) &&
        !hasUnsafeBindingReferences(model, authFinderBinding!, (call) => call === finderCall) &&
        onlyImportedReference(hashBinding, finderCall.arguments[0])
      if (
        baseModelBinding &&
        hasUnsafeBindingReferences(
          model,
          baseModelBinding,
          () => false,
          (reference) =>
            (directClassBaseHeritage(model, reference) &&
              reference.parent.parent.parent === selectedClass) ||
            Boolean(safeBaseComposition && reference === composeCall?.arguments[0])
        )
      )
        diagnostic(
          diagnostics,
          'user.connection',
          'Resolve imported BaseModel provenance before generated migrations'
        )
      if (safeComposition && schemaBinding) {
        const schemaPath = 'database/schema.ts'
        try {
          if (
            !(await conventionalSetupImport(
              state.root,
              '#database/schema',
              '#database/*',
              './database/*.js',
              './database/schema.js'
            ))
          )
            throw new Error('Setup cannot resolve #database/schema to the inspected schema')
          const path = await safeSetupPath(state.root, schemaPath)
          const schemaStat = await lstat(path)
          if (!schemaStat.isFile())
            throw new Error(`Setup cannot inspect non-regular schema ${schemaPath}`)
          const parsed = await parseSetupSource(await readFile(path, 'utf8'))
          const base = importedName(parsed, '@adonisjs/lucid/orm', 'BaseModel')
          const column = importedName(parsed, '@adonisjs/lucid/orm', 'column')
          const matches = parsed.file.statements.filter(
            (node): node is TypeScript.ClassDeclaration =>
              parsed.ts.isClassDeclaration(node) &&
              node.name?.text === 'UserSchema' &&
              Boolean(
                node.modifiers?.some(
                  (modifier) => modifier.kind === parsed.ts.SyntaxKind.ExportKeyword
                )
              )
          )
          const candidate = matches.length === 1 ? matches[0] : null
          const directBase = candidate?.heritageClauses?.some(
            (clause) =>
              clause.token === parsed.ts.SyntaxKind.ExtendsKeyword &&
              clause.types.length === 1 &&
              parsed.ts.isIdentifier(clause.types[0].expression) &&
              clause.types[0].expression.text === base
          )
          const unsafeBase = Boolean(
            base &&
            hasUnsafeBindingReferences(
              parsed,
              base,
              () => false,
              (reference) => directClassBaseHeritage(parsed, reference)
            )
          )
          const unsafeColumn =
            !column ||
            hasUnsafeBindingReferences(
              parsed,
              column,
              (call) =>
                parsed.ts.isDecorator(call.parent) &&
                ((parsed.ts.isIdentifier(call.expression) && call.expression.text === column) ||
                  exactCall(parsed, call, column, 'dateTime') ||
                  exactCall(parsed, call, column, 'date'))
            )
          let escaped = false
          if (candidate?.name)
            walk(parsed, (node) => {
              if (
                !parsed.ts.isIdentifier(node) ||
                node.text !== candidate.name!.text ||
                node === candidate.name ||
                isTypeOnlyReference(parsed, node)
              )
                return
              if (
                node.parent &&
                parsed.ts.isPropertyAccessExpression(node.parent) &&
                node.parent.expression === node &&
                node.parent.name.text === '$columns' &&
                node.parent.parent &&
                parsed.ts.isPropertyDeclaration(node.parent.parent) &&
                node.parent.parent.name.getText(parsed.file) === '$columns' &&
                node.parent.parent.parent === candidate
              )
                return
              escaped = true
            })
          const schemaMetadata = ['table', 'connection', 'primaryKey', 'namingStrategy']
          const metadataUnsafe =
            candidate?.members.some((member) => {
              if (parsed.ts.isClassStaticBlockDeclaration(member)) return true
              if (
                !parsed.ts.canHaveModifiers(member) ||
                !parsed.ts
                  .getModifiers(member)
                  ?.some((modifier) => modifier.kind === parsed.ts.SyntaxKind.StaticKeyword)
              )
                return false
              if (!member.name) return false
              if (parsed.ts.isComputedPropertyName(member.name)) return true
              return (
                !parsed.ts.isPropertyDeclaration(member) &&
                (parsed.ts.isIdentifier(member.name) || parsed.ts.isStringLiteral(member.name)) &&
                schemaMetadata.includes(member.name.text)
              )
            }) ||
            schemaMetadata.some(
              (name) =>
                candidate?.members.filter(
                  (member) =>
                    parsed.ts.isPropertyDeclaration(member) &&
                    member.modifiers?.some(
                      (modifier) => modifier.kind === parsed.ts.SyntaxKind.StaticKeyword
                    ) &&
                    (parsed.ts.isIdentifier(member.name) ||
                      parsed.ts.isStringLiteral(member.name)) &&
                    member.name.text === name
                ).length! > 1
            )
          if (
            directBase &&
            !unsafeBase &&
            !unsafeColumn &&
            !escaped &&
            !metadataUnsafe &&
            candidate &&
            !unsupportedClassRuntime(parsed, candidate, true)
          ) {
            schemaClass = candidate
            schemaSource = parsed
          }
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
            // The missing schema is diagnosed through unresolved inheritance below.
          } else if (
            (error as Error).message ===
            'Setup cannot resolve #database/schema to the inspected schema'
          ) {
            diagnostic(diagnostics, 'user.connection', (error as Error).message)
          } else throw error
        }
      }
      const inheritedMember = (name: string) =>
        schemaClass?.members.filter(
          (member) =>
            schemaSource!.ts.isPropertyDeclaration(member) &&
            Boolean(
              member.modifiers?.some(
                (modifier) => modifier.kind === schemaSource!.ts.SyntaxKind.StaticKeyword
              )
            ) &&
            (schemaSource!.ts.isIdentifier(member.name) ||
              schemaSource!.ts.isStringLiteral(member.name)) &&
            member.name.text === name
        ) ?? []
      const modelColumns = selectedClass ? classColumns(model, selectedClass) : null
      const inheritedColumns =
        schemaClass && schemaSource ? classColumns(schemaSource, schemaClass) : null
      const primaryKeyMember = (member: TypeScript.Node | undefined) =>
        member &&
        ts.isPropertyDeclaration(member) &&
        member.initializer &&
        ts.isStringLiteral(member.initializer) &&
        member.initializer.text === choices.user.primaryKey
      const declaredKeys = [...staticMember('primaryKey'), ...inheritedMember('primaryKey')]
      if (
        declaredKeys.some((member) => !primaryKeyMember(member)) ||
        staticMember('namingStrategy').length ||
        inheritedMember('namingStrategy').length
      )
        diagnostic(
          diagnostics,
          'user.idType',
          'Resolve the model primary key and naming strategy before generating migrations'
        )
      if (modelColumns?.unsafe || inheritedColumns?.unsafe)
        diagnostic(
          diagnostics,
          'user.idType',
          'Resolve model column decorators before generating migrations'
        )
      if (selectedClass && modelColumns) {
        const effective = new Map([
          ...(inheritedColumns?.columns ?? new Map()),
          ...modelColumns.columns,
        ])
        const primary = [...effective.entries()].filter(([, value]) => value.primary)
        const id = effective.get(choices.user.primaryKey)
        const expectedType =
          choices.user.idType === 'integer'
            ? ts.SyntaxKind.NumberKeyword
            : ts.SyntaxKind.StringKeyword
        if (
          !id ||
          !id.primary ||
          id.physical !== choices.user.primaryKey ||
          primary.length !== 1 ||
          primary[0][0] !== choices.user.primaryKey ||
          id.declaration.type?.kind !== expectedType
        )
          diagnostic(
            diagnostics,
            'user.idType',
            'Model must expose one physical id primary column with the selected TypeScript id type'
          )
      }
      const tableMember = staticMember('table')
      const tableInitializer =
        tableMember.length === 1 && ts.isPropertyDeclaration(tableMember[0])
          ? tableMember[0].initializer
          : undefined
      const table =
        tableInitializer && ts.isStringLiteral(tableInitializer) ? tableInitializer.text : null
      if (tableMember.length && !table)
        diagnostic(
          diagnostics,
          'user.table',
          'Resolve the inherited or declared model table before generating migrations'
        )
      if (table && table !== choices.user.table)
        diagnostic(
          diagnostics,
          'user.table',
          `Model table ${table} differs from selected ${choices.user.table}`
        )
      if (staticMember('connection').length || inheritedMember('connection').length)
        diagnostic(
          diagnostics,
          'user.connection',
          'Selected Lucid model must not declare an explicit connection override'
        )
      if (!table && selectedClass?.name?.text !== 'User')
        diagnostic(
          diagnostics,
          'user.table',
          'Confirm the final model table mapping before generated migrations'
        )
      if (!table && choices.user.table !== 'users')
        diagnostic(
          diagnostics,
          'user.table',
          'Default Lucid User table is users; declare a model-owned table for another name'
        )
      if (
        inheritedMember('table').length &&
        inheritedMember('table').some(
          (member) =>
            ts.isPropertyDeclaration(member) &&
            member.initializer &&
            !ts.isStringLiteral(member.initializer)
        )
      )
        diagnostic(
          diagnostics,
          'user.table',
          'Resolve schema table evaluation before generated migrations'
        )
      const extendsBase = selectedClass?.heritageClauses?.some(
        (clause) =>
          clause.token === ts.SyntaxKind.ExtendsKeyword &&
          clause.types.some(
            (item) =>
              (ts.isIdentifier(item.expression) && item.expression.text === baseModelBinding) ||
              (composed && schemaClass !== null) ||
              (safeBaseComposition && item.expression === composeCall)
          )
      )
      if (!extendsBase)
        diagnostic(
          diagnostics,
          'user.connection',
          'Resolve the imported Lucid BaseModel inheritance before using this model for generated migrations'
        )
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
      diagnostic(diagnostics, 'user.model', `${modelPath} was not found`)
    }
  }
  const changes: SetupFileChange[] = []
  const retainedChoices = retainedGeneratedChoices(state)
  const priorGenerated = state.existingChoices?.authentication
    ? state.existingChoices
    : retainedChoices
  ownedChange(
    changes,
    state,
    'config/account_kit.ts',
    accountConfigSource(choices),
    state.existingChoices ? accountConfigSource(state.existingChoices) : null,
    'Configure selected services, policy and operational notification adapters'
  )
  ownedChange(
    changes,
    state,
    '.env.account-kit.example',
    generatedEnv(choices),
    state.existingChoices ? generatedEnv(state.existingChoices) : null,
    'Document deployment references'
  )
  await planSessionConfigIntegration(changes, state, choices, diagnostics)
  if (choices.social.status === 'enabled') {
    if (state.files['config/ally.ts'] === undefined)
      addChange(
        changes,
        state,
        'config/ally.ts',
        allyConfigSource(choices),
        'Configure selected Ally providers using deployment references and exact callbacks'
      )
    else
      diagnostic(
        diagnostics,
        'config/ally.ts',
        'Review the existing Ally configuration and add selected providers without replacing existing providers',
        'action'
      )
  }
  if (
    !choices.authentication &&
    state.existingChoices?.authentication &&
    state.files['app/middleware/account_kit_access_middleware.ts']
  )
    diagnostic(
      diagnostics,
      'authentication.retirement',
      'Review application-owned routes for the generated account access middleware and remove or replace their references after authentication retirement',
      'action'
    )
  if (
    choices.authentication &&
    (choices.managed.length || state.files['app/services/account_kit_guard.ts'])
  ) {
    ownedChange(
      changes,
      state,
      'app/services/account_kit_guard.ts',
      managedGuardSource(choices),
      priorGenerated?.authentication ? managedGuardSource(priorGenerated) : null,
      'Adapt the selected existing AdonisJS guard'
    )
    ownedChange(
      changes,
      state,
      'app/middleware/account_kit_access_middleware.ts',
      managedAccessMiddlewareSource(choices),
      priorGenerated?.authentication ? managedAccessMiddlewareSource(priorGenerated) : null,
      'Offer the same account revision and restriction gate to application-owned routes'
    )
  }
  if (choices.managed.length && choices.authentication) {
    ownedChange(
      changes,
      state,
      'start/account_kit_routes.ts',
      selectedRouteSource(choices),
      state.existingChoices?.authentication && state.existingChoices.managed.length
        ? selectedRouteSource(state.existingChoices)
        : retainedChoices
          ? disabledManagedRoutesSource(retainedChoices)
          : null,
      'Mount selected maintained endpoints through the existing guard'
    )
  } else if (state.existingChoices?.managed.length && state.existingChoices.authentication) {
    ownedChange(
      changes,
      state,
      'start/account_kit_routes.ts',
      disabledManagedRoutesSource(state.existingChoices),
      selectedRouteSource(state.existingChoices),
      'Retire the managed route mount without changing application routes or account data'
    )
  }
  if (
    choices.managed.length ||
    state.files['app/middleware/account_kit_proof_headers_middleware.ts']
  ) {
    ownedChange(
      changes,
      state,
      'app/middleware/account_kit_proof_headers_middleware.ts',
      proofHeadersMiddlewareSource(choices),
      state.existingChoices ? proofHeadersMiddlewareSource(state.existingChoices) : null,
      'Protect proof responses before parser and CSRF failures'
    )
  }
  await planArrayImports(changes, state, diagnostics, 'adonisrc.ts', 'providers: [', [
    ...(choices.managed.length ? ['@adonisjs/core/providers/vinejs_provider'] : []),
    '@adonisjs/lucid/database_provider',
    '@adonisjs/limiter/limiter_provider',
    'adonisjs-account-kit/providers/account_kit_provider',
    ...(choices.managed.length ? ['@adonisjs/auth/auth_provider'] : []),
    ...(choices.social.status === 'enabled' ? ['@adonisjs/ally/ally_provider'] : []),
    ...(choices.authentication?.strategy === 'session' && choices.managed.length
      ? ['@adonisjs/session/session_provider', '@adonisjs/shield/shield_provider']
      : []),
    ...(hasEmailFlow(choices) && choices.mail.integration === 'adonisjs-mail'
      ? ['@adonisjs/mail/mail_provider']
      : []),
  ])
  if (choices.managed.length) {
    await planRouterMiddleware(
      changes,
      state,
      diagnostics,
      choices.authentication?.strategy === 'session'
    )
    await planServerProofMiddleware(changes, state, diagnostics)
    if (choices.authentication?.strategy === 'session') {
      const shieldConfig = state.files['config/shield.ts']
      const csrf = shieldConfig ? await shieldCsrfState(shieldConfig) : 'missing'
      if (csrf === 'missing' || csrf === 'false')
        diagnostic(
          diagnostics,
          'config/shield.ts',
          'Session managed POSTs require configured Shield CSRF protection'
        )
      else if (csrf === 'dynamic')
        diagnostic(
          diagnostics,
          'config/shield.ts',
          'Verify that Shield csrf.enabled resolves true at runtime for the selected session guard; conventional environment-gated configuration requires ACCOUNT_KIT_AUTH_STRATEGY=session',
          'action'
        )
      if (!state.files['config/session.ts'])
        diagnostic(
          diagnostics,
          'config/session.ts',
          'Session guard requires configured cookie and session storage'
        )
      else {
        let inspected: NativeSessionConfiguration | null = null
        let diagnosticSelection: { name: string | null; kind: string | null } | null = null
        try {
          const current = state.files['config/session.ts']
          const baseline = current.includes('account-kit:session-import:start')
            ? await unwrapManagedSessionConfig(current, state.root)
            : current
          if (baseline) {
            inspected = await nativeSessionConfiguration(baseline, state.root)
            diagnosticSelection = inspected
              ? { name: inspected.selectedName, kind: inspected.selected?.kind ?? null }
              : await selectedSessionDiagnostic(baseline, state.root)
          }
        } catch {
          // The integration diagnostic above already blocks an uninspectable selection.
        }
        if (diagnosticSelection?.kind === 'cookie')
          diagnostic(
            diagnostics,
            'config/session.ts',
            'Cookie-only sessions cannot enforce logout replay protection; select a server-side session store'
          )
        else if (options.production && diagnosticSelection?.kind === 'memory')
          diagnostic(
            diagnostics,
            'config/session.ts',
            'Production requires a persistent shared session store; selected memory storage cannot satisfy persistentStore verification'
          )
        else if (
          diagnosticSelection?.kind === 'database' &&
          !state.migrationNames.some((name) => /session/i.test(name))
        )
          diagnostic(
            diagnostics,
            'config/session.ts',
            'Database session storage requires an application session-table migration and a verified applied table',
            'action'
          )
        else if (diagnosticSelection?.name && !diagnosticSelection.kind)
          diagnostic(
            diagnostics,
            'config/session.ts',
            'Selected session store is not configured in config/session.ts'
          )
        else if (options.production && !diagnosticSelection?.kind)
          diagnostic(
            diagnostics,
            'config/session.ts',
            'Production session storage must be a verified persistent server-side store'
          )
        else if (!inspected?.selected)
          diagnostic(
            diagnostics,
            'config/session.ts',
            'Verify the selected runtime session store resolves to a server-side implementation and preserves logout revocation across requests',
            'action'
          )
      }
    }
  }
  const migrationTimestamp = options.timestamp ?? Date.now()
  for (const [index, name] of migrationNames.entries()) {
    const suffix = `_account_kit_${name}.ts`
    const existing = state.migrationNames.find((filename) => filename.endsWith(suffix))
    const path = `database/migrations/${existing ?? `${migrationTimestamp + index}${suffix}`}`
    const content = await migrationContent(name, choices)
    addChange(
      changes,
      state,
      path,
      content,
      `Review schema change ${name}; run migrations separately`
    )
  }
  if (choices.managed.length && choices.authentication)
    await planRouteImport(changes, state, diagnostics)
  // Commit the selection only after every dependent file. This preserves the previous
  // generated-content baseline when an interrupted application is replayed.
  ownedChange(
    changes,
    state,
    'config/account_kit_setup.json',
    `${JSON.stringify(choices, null, 2)}\n`,
    state.files['config/account_kit_setup.json'] ?? null,
    'Persist six-pillar application choices without secrets'
  )
  for (const change of changes) {
    if (change.action === 'conflict')
      diagnostic(
        diagnostics,
        change.path,
        'Existing file differs. Resolve it manually; setup will not overwrite it'
      )
    if ((change.action === 'update' || change.action === 'create') && change.path.endsWith('.ts')) {
      try {
        await parseSetupSource(change.content)
      } catch {
        diagnostic(
          diagnostics,
          change.path,
          'Proposed TypeScript is invalid; reconcile this application layout before setup writes files'
        )
      }
    }
  }
  let plannedEndpointLocations: Array<{ name: string; method: string; path: string }> = []
  try {
    plannedEndpointLocations = selectedManagedRoutes(choices).map(({ name, method, path }) => ({
      name,
      method,
      path,
    }))
  } catch {
    // Invalid choices are reported above; preview remains inspectable.
  }
  const endpointLocations = choices.authentication?.applicationRouteRevocation
    ? plannedEndpointLocations
    : []
  const endpoints = endpointLocations.map(({ name }) => name)
  const selectedPackages = [
    'typescript',
    '@adonisjs/core',
    '@adonisjs/lucid',
    '@adonisjs/limiter',
    'adonisjs-account-kit',
    ...(choices.managed.length ? ['@adonisjs/auth', '@vinejs/vine'] : []),
    ...(choices.authentication?.strategy === 'session' && choices.managed.length
      ? ['@adonisjs/session', '@adonisjs/shield']
      : []),
    ...(hasEmailFlow(choices) && choices.mail.integration === 'adonisjs-mail'
      ? ['@adonisjs/mail']
      : []),
    ...(choices.social.status === 'enabled' ? ['@adonisjs/ally'] : []),
  ]
  const missingPackages = selectedPackages.filter((name) => !state.installedPackages.includes(name))
  for (const name of missingPackages)
    diagnostic(diagnostics, `dependencies.${name}`, `Install ${name} explicitly before applying`)
  const limiter = await limiterConfigurationState(
    state.files['config/limiter.ts'] ?? '',
    state.root
  )
  if (limiter === 'invalid')
    diagnostic(
      diagnostics,
      'config/limiter.ts',
      'Configure @adonisjs/limiter with pnpm exec node ace configure @adonisjs/limiter; config/limiter.ts needs an actual selected store in its exported defineConfig'
    )
  else if (limiter === 'unresolved')
    diagnostic(
      diagnostics,
      'config/limiter.ts',
      'Selected limiter store is unresolved; use a direct literal or a resolvable environment assignment before activation'
    )
  const minimumVersions: Record<string, readonly [number, number, number]> = {
    '@adonisjs/core': [7, 0, 0],
    '@adonisjs/lucid': [22, 4, 2],
    '@adonisjs/limiter': [3, 0, 0],
    '@adonisjs/auth': [10, 1, 0],
    '@adonisjs/session': [8, 1, 0],
    '@adonisjs/shield': [9, 0, 0],
    '@vinejs/vine': [4, 4, 0],
    '@adonisjs/mail': [10, 0, 0],
  }
  for (const name of selectedPackages) {
    if (name === 'typescript') {
      const version = state.installedVersions[name]
      const parts = version
        ?.match(/^(\d+)\.(\d+)\.(\d+)$/)
        ?.slice(1)
        .map(Number)
      const supported =
        parts &&
        ((parts[0] === 5 && (parts[1] > 9 || (parts[1] === 9 && parts[2] >= 3))) ||
          (parts[0] === 6 && (parts[1] > 0 || parts[2] >= 3)))
      if (!supported)
        diagnostic(
          diagnostics,
          'dependencies.typescript',
          `Installed TypeScript version ${version ?? 'unknown'} is outside supported ^5.9.3 || ^6.0.3 range`
        )
      continue
    }
    const minimum = minimumVersions[name]
    if (!minimum) continue
    const version = state.installedVersions[name]
    if (!version) continue
    const match = version.match(/^(\d+)\.(\d+)\.(\d+)(?:\+[^\s]+)?$/)
    const parts = match?.slice(1).map(Number)
    if (
      !parts ||
      parts[0] !== minimum[0] ||
      parts[1] < minimum[1] ||
      (parts[1] === minimum[1] && parts[2] < minimum[2])
    )
      diagnostic(
        diagnostics,
        `dependencies.${name}`,
        `Installed ${name}@${version} is outside supported ^${minimum.join('.')} range`
      )
  }
  if (choices.social.status === 'enabled') {
    const allyVersion = state.installedVersions['@adonisjs/ally']
    const patch = allyVersion?.match(/^6\.3\.(\d+)$/)?.[1]
    if (
      state.installedPackages.includes('@adonisjs/ally') &&
      (patch === undefined || Number(patch) < 2)
    )
      diagnostic(
        diagnostics,
        'dependencies.@adonisjs/ally',
        `Installed @adonisjs/ally@${allyVersion || 'unknown'} is outside the verified range >=6.3.2 <6.4.0`
      )
  }
  const socialChoices = choices.social.status === 'enabled' ? choices.social : null
  const csrfLocation = endpointLocations.find(({ name }) => name === 'auth.csrf')?.path
  const prerequisites = [
    ...missingPackages.map((name) => `Install ${name} explicitly with pnpm add ${name}`),
    'Review generated migrations, then run node ace migration:run explicitly',
    ...(choices.managed.length
      ? ['Verify the generated route mount and existing guard prerequisites']
      : []),
    ...(choices.managed.length && !choices.authentication?.applicationRouteRevocation
      ? [
          'Wire the generated account-access middleware to application-owned protected routes, verify revocation, then rerun setup with applicationRouteRevocation true to activate managed routes',
        ]
      : []),
    ...(choices.managed.length && choices.authentication?.strategy === 'session'
      ? [
          csrfLocation
            ? `Exercise GET ${csrfLocation} and a CSRF-protected POST with the deployed Shield configuration`
            : 'Provide and exercise an application-owned CSRF bootstrap endpoint and a CSRF-protected POST with the deployed Shield configuration',
        ]
      : []),
    ...(socialChoices
      ? socialChoices.providers.map((provider) => {
          const origin = process.env[socialChoices.callbackOriginEnv]
          const path = socialChoices.callbackPath.replace('{provider}', provider)
          let callback = '$' + '{' + socialChoices.callbackOriginEnv + '}' + path
          if (origin) {
            try {
              callback = new URL(path, origin).toString()
            } catch {
              // validateOrigin reports the invalid deployment value.
            }
          }
          return `Register ${provider} callback ${callback} in the provider console and verify its Ally settings`
        })
      : []),
    ...(socialChoices
      ? [
          'Verify D14 first-password reset, password login, and password re-entry for social-only sensitive actions; standard Google and GitHub Ally callbacks cannot establish fresh provider reauthentication proof',
        ]
      : []),
    'Verify model email uniqueness, normalization, hashing and transaction behavior',
  ]
  const hasError = diagnostics.some((item) => item.severity === 'error')
  const hasAction = diagnostics.some((item) => item.severity === 'action')
  return {
    choices,
    preview: options.apply !== true,
    changes,
    diagnostics,
    differences: state.existingChoices ? changedFields(state.existingChoices, choices) : [],
    retirementImpact: options.retirementImpact ?? null,
    prerequisites,
    endpoints: [...new Set(endpoints)],
    endpointLocations,
    migrationState: !state.migrationNames.some((file) => file.includes('_account_kit_'))
      ? 'not-generated'
      : migrationNames.every((name) =>
            state.migrationNames.some((file) => file.endsWith(`_account_kit_${name}.ts`))
          )
        ? 'generated-application-unknown'
        : 'partially-generated',
    readiness: {
      configurationGenerated: changes.every((change) => change.action === 'unchanged'),
      configurationValid: !hasError,
      migrationsApplied: false,
      externalConfigured: !hasError && !hasAction,
      workflowVerified: false,
      productionReady: false,
      delivery: !hasEmailFlow(choices)
        ? 'not applicable'
        : choices.mail.delivery === 'durable'
          ? 'durable'
          : 'best effort',
    },
    pillars: {
      features: `${choices.features.length} services; ${choices.managed.length} managed groups`,
      user: `${choices.user.model} / ${choices.user.table} / ${choices.user.idType}`,
      authentication: choices.authentication
        ? `${choices.authentication.strategy} guard ${choices.authentication.guard}`
        : 'not applicable: no authentication endpoints selected',
      mail: hasEmailFlow(choices)
        ? `${choices.mail.integration}; ${choices.mail.delivery}`
        : 'not applicable: no email capability selected',
      social:
        choices.social.status === 'enabled'
          ? `${choices.social.providers.map((provider) => (provider === 'google' ? 'Google' : 'GitHub')).join(', ')} selected; stable subject identities; matching email requires linking proof; missing or unverified email requires collection/verification; standard Ally has no fresh provider reauthentication proof; social-only sensitive actions require first-password reset, password login, then password re-entry; ${choices.authentication?.strategy === 'access_tokens' ? 'client POST callback and PKCE token exchange' : 'session callback and server-held PKCE verifier'}`
          : `not applicable: ${choices.social.reason}`,
      policy: `${choices.policy.registration} registration; verification ${choices.policy.verificationRequired ? 'required' : 'optional'}`,
    },
  }
}
