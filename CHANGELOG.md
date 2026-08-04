# Changelog

All notable changes to this project are documented here.

## 0.1.0 - 2026-08-04

- Added the Gemini OAuth-backed OpenAI-compatible local proxy and CLI daemon.
- Added strict request validation and a 10 MiB default request-body limit.
- Added safe OAuth callback state/error handling and token response validation.
- Added tool-call name/finish-reason conversion and stable streaming call IDs.
- Added SSE fragmentation, backpressure, cancellation, and malformed-event handling.
- Added daemon process identity checks, startup locking, and health-based readiness.
- Added Node test coverage, publish-safe npm metadata, and package documentation.
