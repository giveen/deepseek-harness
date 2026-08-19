# Agent Note: Product-first root README

Status: implemented

English | [中文](2026-07-22-product-first-root-readme.zh.md)

## Problem

The root README is the repository's product and source-checkout entry point. It must help a new user reach a working Web session, explain the supported runtime surfaces, and direct contributors to the detailed contract owned by each subsystem. Product capabilities, provider setup, LAN serving, managed browser startup, workspace views, and SDK entry points are too important to leave discoverable only through package READMEs.

## Decision

The root README uses a product-first overview followed by executable setup paths, first-run Web steps, LAN deployment guidance, Camofox behavior, alternate entry modes, data and privacy boundaries, customization links, and contributor verification commands. The English and Simplified Chinese files use the same technical structure and preserve executable code blocks so the pairing gate can validate them.

The page names the Web workspace as the primary surface: model and credential setup, workspace selection, session creation, image rendering, workspace file browsing, and Git commit history. It also names the headless, ACP, JSON-RPC, and Python surfaces without duplicating their detailed references. The overview describes the shipped model-provider choices, image capability declaration, session event-log authority, SQLite maintenance options, permissions, sandboxing, and telemetry as deployment facts rather than implementation status.

The Web deployment instructions include `--host`, `--port`, and `--trusted-host`, explain same-process session sharing between loopback and LAN URLs, and state that the unauthenticated HTTP server must remain on a trusted network or behind an authenticated TLS proxy. The Camofox section documents the required browser download, cache refresh behavior, managed `127.0.0.1:9377` lifecycle, screenshot presentation, loopback restriction, and external-executable escape hatch.

The README links package, subsystem, cookbook, CLI, user, SDK, architecture, configuration-catalog, and module-graph references instead of copying their full API or implementation contracts. The root page remains responsible for product orientation, prerequisites, runnable commands, security warnings, and navigation.

## Alternatives considered

**Keep the short README and rely on package documentation.** This leaves the primary user path, browser integration, and deployment warnings hidden behind repository navigation.

**Turn the root README into an exhaustive package catalog.** This makes the page difficult to use as a product entry point and duplicates generated and package-owned references.

**Create separate English and Chinese structures.** This would make the two entry points communicate different product boundaries and would weaken the repository's bilingual pairing contract. Both sides therefore mirror the same technical outline.

## Consequences

Changes to the Web and headless commands, provider setup, public deployment defaults, managed Camofox lifecycle, primary user workflow, or top-level product surfaces require a root README update and its Chinese counterpart. Detailed service contracts remain in their owning documents. A README update must run the translation-pairing and documentation gates; a change to a command or security boundary must also update the owning reference.
