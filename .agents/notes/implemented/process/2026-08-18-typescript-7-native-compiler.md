# Agent Note: TypeScript 7 compiler with a TypeScript 6 API compatibility lane

Status: implemented

English | [中文](2026-08-18-typescript-7-native-compiler.zh.md)

## Problem

The repository needs the TypeScript 7 native compiler for its project-reference builds while Typert, repository generators, and validation scripts still import the TypeScript compiler API. TypeScript 7.0 provides the `tsc` executable but does not provide the programmatic API required by those consumers.

## Decision

The root workspace invokes TypeScript 7.0.2 through the `@typescript/native` npm alias, while the `typescript` dependency is the `@typescript/typescript6` compatibility package at the existing 6.0 line. Imports from `typescript` therefore continue to use the TypeScript 6 API, and the `tsc` binary used by root build and typecheck scripts comes from TypeScript 7. Packages that only need a compiler use TypeScript 7 directly; `@deepseek-ai/dsh-typert-generator` keeps the TypeScript 6 compatibility dependency because it executes the compiler API at runtime. The TypeScript peer allowance covers both compiler lines.

TypeScript 7's changed defaults are made explicit where they affect the repository: the shared base sets `noUncheckedSideEffectImports` and `libReplacement`, package projects already set `rootDir`, and generator fixtures no longer use the removed `baseUrl` and `ignoreDeprecations` options.

## Alternatives considered

**Replace every TypeScript API consumer with TypeScript 7-compatible tooling.** Rejected because TypeScript 7.0 has no programmatic API and the repository's Typert and semantic gates depend on the existing API; replacing them would expand the migration beyond the compiler upgrade.

**Keep TypeScript 6 as the only compiler.** Rejected because it would not deliver the requested TypeScript 7 compiler or its native project-reference build.

**Use TypeScript 7 for the `typescript` package name and move API imports to a separate module.** Rejected because the compatibility package is specifically designed to preserve direct `typescript` peer and import resolution for tools that have not adopted the TypeScript 7 API.

## Consequences

Builds and typechecks use the TypeScript 7 native executable, while compiler-API consumers remain on the TypeScript 6 compatibility implementation until a TypeScript 7 API is available. The two versions are intentionally installed side by side, so dependency and peer updates must preserve both roles. TypeScript 7 compiler diagnostics and the repository's existing runtime tests remain required evidence for the migration.
